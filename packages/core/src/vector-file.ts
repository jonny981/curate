import { randomBytes } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, openSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// One model's vectors in one file, read whole in one go:
//   header (32 bytes) | records | one last-used day per record
// A record is the text's SHA-256 (32 bytes) then the vector as 64-bit
// numbers, so a record starts on an 8-byte boundary and a vector is read
// in place. The file is only ever written whole, beside itself, and
// renamed over the old one: a reader sees the old file or the new one,
// never part of one.
const MAGIC = Buffer.from('CURVEC1\n');
const HEADER = 32;
const KEY = 32;
const NATIVE = 0x01020304;

/** New vectors wait in the model's SQLite file. Once this many wait they
 *  are folded into the vector file, which is rewritten whole, so a fold
 *  is rare and the waiting set stays small enough to read at every start. */
export const FOLD_AT = 4096;
/** A fold leaves out a vector no call has used for this many days: the
 *  text it was made from has gone or changed. Using it again embeds it
 *  again. */
export const KEEP_DAYS = 30;
/** Today as days since 1970, the unit of a record's last-used day. */
export const today = () => Math.floor(Date.now() / 86_400_000);

export interface VectorFile {
  readonly dimensions: number;
  readonly count: number;
  /** The record of each text hash (64 hex characters). */
  readonly index: ReadonlyMap<string, number>;
  /** The day each record was last used, as days since 1970. */
  readonly days: Uint32Array;
  /** Names this write of the file, so a later change to its days can
   *  tell the file was replaced meanwhile. */
  readonly generation: string;
  /** The stored vector itself, not a copy: do not write to it. */
  vector(record: number): Float64Array;
  /** The record's hash and vector bytes, for writing the next file. */
  record(record: number): { readonly key: string; readonly vector: Uint8Array };
}

export interface VectorRow {
  /** The text's SHA-256 as 64 hex characters. */
  readonly key: string;
  /** `dimensions` 64-bit numbers, in this machine's byte order. */
  readonly vector: Uint8Array;
  readonly day: number;
}

const recordSize = (dimensions: number) => KEY + dimensions * Float64Array.BYTES_PER_ELEMENT;

function readWhole(path: string): Buffer | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    // ponytail: one buffer holds the whole file, which Node caps near
    // 4 GB: about 690,000 vectors of 768 numbers. Past that, split the
    // file by source or store 32-bit numbers.
    const buffer = Buffer.allocUnsafe(fstatSync(descriptor).size);
    let at = 0;
    while (at < buffer.length) {
      const read = readSync(descriptor, buffer, at, Math.min(buffer.length - at, 1 << 30), at);
      if (read === 0) return undefined;
      at += read;
    }
    return buffer;
  } finally {
    closeSync(descriptor);
  }
}

function header(buffer: Buffer): { dimensions: number; count: number; generation: string } | undefined {
  if (buffer.length < HEADER || !buffer.subarray(0, MAGIC.length).equals(MAGIC)) return undefined;
  const words = new Uint32Array(buffer.buffer.slice(buffer.byteOffset + 8, buffer.byteOffset + 20));
  // Written by a machine of the other byte order: its numbers would read wrong.
  if (words[0] !== NATIVE) return undefined;
  return { dimensions: words[1]!, count: words[2]!, generation: buffer.toString('hex', 24, 32) };
}

/** The file's vectors, or undefined when there is no file or it is not a
 *  whole one this code wrote: its length must be exactly what its header
 *  says, so a cut file is never read. */
export function readVectorFile(path: string): VectorFile | undefined {
  const buffer = readWhole(path);
  const head = buffer === undefined ? undefined : header(buffer);
  if (buffer === undefined || head === undefined) return undefined;
  const { dimensions, count, generation } = head;
  const size = recordSize(dimensions);
  const daysAt = HEADER + count * size;
  if (dimensions === 0 || buffer.length !== daysAt + count * Uint32Array.BYTES_PER_ELEMENT) return undefined;
  // A small buffer can sit anywhere in a shared pool; a vector read in
  // place needs its numbers on an 8-byte boundary.
  const bytes = buffer.byteOffset % Float64Array.BYTES_PER_ELEMENT === 0 ? buffer : Buffer.from(Uint8Array.from(buffer).buffer);
  const index = new Map<string, number>();
  for (let record = 0; record < count; record += 1) {
    const at = HEADER + record * size;
    index.set(bytes.toString('hex', at, at + KEY), record);
  }
  return {
    dimensions, count, index, generation,
    days: new Uint32Array(bytes.buffer.slice(bytes.byteOffset + daysAt, bytes.byteOffset + daysAt + count * Uint32Array.BYTES_PER_ELEMENT)),
    vector: (record) => new Float64Array(bytes.buffer, bytes.byteOffset + HEADER + record * size + KEY, dimensions),
    record: (record) => {
      const at = HEADER + record * size;
      return { key: bytes.toString('hex', at, at + KEY), vector: bytes.subarray(at + KEY, at + size) };
    },
  };
}

/** Write the file whole: to a temporary file beside it, flushed to disk,
 *  then renamed over it. A stop part-way leaves the old file as it was. */
export function writeVectorFile(path: string, dimensions: number, rows: Iterable<VectorRow>): void {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    const head = Buffer.alloc(HEADER);
    writeSync(descriptor, head);
    const days: number[] = [];
    let pending: Uint8Array[] = [];
    let held = 0;
    const flush = () => {
      if (pending.length > 0) writeSync(descriptor, Buffer.concat(pending));
      pending = [];
      held = 0;
    };
    for (const row of rows) {
      if (!/^[0-9a-f]{64}$/.test(row.key) || row.vector.byteLength !== dimensions * Float64Array.BYTES_PER_ELEMENT) {
        throw new TypeError('A vector file row needs a SHA-256 key and one vector of the file\'s dimensions.');
      }
      pending.push(Buffer.from(row.key, 'hex'), row.vector);
      days.push(row.day);
      held += recordSize(dimensions);
      if (held >= 8 << 20) flush();
    }
    flush();
    writeSync(descriptor, Buffer.from(Uint32Array.from(days).buffer));
    MAGIC.copy(head);
    Buffer.from(Uint32Array.of(NATIVE, dimensions, days.length).buffer).copy(head, 8);
    randomBytes(8).copy(head, 24);
    writeSync(descriptor, head, 0, HEADER, 0);
    fsyncSync(descriptor);
  } catch (error) {
    closeSync(descriptor);
    try { unlinkSync(temporary); } catch { /* the write's own failure is the one to report */ }
    throw error;
  }
  closeSync(descriptor);
  renameSync(temporary, path);
  // The rename itself must reach the disk before a caller drops what the file now holds.
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

/** Move the last-used day of every record marked in `used` to `day`, in
 *  the file as it is on disk now. A stored day only ever moves later, so
 *  two readers of one file never undo each other. When a fold replaced
 *  the file since `file` was read, its records are in another order:
 *  each used text is then found by its hash, and one the fold left out is
 *  skipped. Call it under the lock a fold holds. */
export function markVectorsUsed(path: string, file: VectorFile, used: Uint8Array, day: number): void {
  let descriptor: number;
  try {
    descriptor = openSync(path, 'r+');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    const head = Buffer.alloc(HEADER);
    if (readSync(descriptor, head, 0, HEADER, 0) !== HEADER) return;
    const now = header(head);
    if (now === undefined) return;
    const size = recordSize(now.dimensions);
    const daysAt = HEADER + now.count * size;
    const stored = Buffer.alloc(now.count * Uint32Array.BYTES_PER_ELEMENT);
    if (readSync(descriptor, stored, 0, stored.length, daysAt) !== stored.length) return;
    const days = new Uint32Array(stored.buffer, stored.byteOffset, now.count);
    let moved = false;
    const mark = (record: number) => {
      if (days[record]! >= day) return;
      days[record] = day;
      moved = true;
    };
    if (now.generation === file.generation && now.count === file.count) {
      used.forEach((flag, record) => { if (flag === 1) mark(record); });
    } else {
      const wanted = new Set<string>();
      used.forEach((flag, record) => { if (flag === 1) wanted.add(file.record(record).key); });
      const key = Buffer.alloc(KEY);
      for (let record = 0; wanted.size > 0 && record < now.count; record += 1) {
        if (readSync(descriptor, key, 0, KEY, HEADER + record * size) !== KEY) return;
        if (wanted.delete(key.toString('hex'))) mark(record);
      }
    }
    if (moved) writeSync(descriptor, stored, 0, stored.length, daysAt);
  } finally {
    closeSync(descriptor);
  }
}
