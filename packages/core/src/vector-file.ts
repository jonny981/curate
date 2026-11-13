import { closeSync, fstatSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs';

// The vector store's data file holds one model's vectors as records of
// the text's SHA-256 (32 bytes) and the vector as 64-bit numbers, in this
// machine's byte order. Records are only ever appended: a record keeps its
// number, which the store's key table holds, and its key, so a record a
// stopped write left cut, or one that is not the key's, is never used.

/** Records read at a time, so a read never holds a whole file. */
const CHUNK = 1024;

/** Bytes per record of a data file holding vectors of `dimensions`. */
const recordBytes = (dimensions: number) => 32 + dimensions * Float64Array.BYTES_PER_ELEMENT;

/** Appends one record per row at the end of the data file at `path`, made
 *  with mode 0600 when absent, past any record a stopped write left cut,
 *  and flushes them to disk. Returns the first new record's number. Call
 *  it while holding the store's write lock, so no other write moves the
 *  end meanwhile. */
export function appendRecords(path: string, dimensions: number, rows: readonly { key: string; vector: Uint8Array }[]): number {
  closeSync(openSync(path, 'a', 0o600));
  const descriptor = openSync(path, 'r+');
  try {
    const size = recordBytes(dimensions);
    const first = Math.floor(fstatSync(descriptor).size / size);
    const bytes = Buffer.alloc(rows.length * size);
    rows.forEach(({ key, vector }, at) => {
      bytes.write(key, at * size, 32, 'hex');
      bytes.set(vector, at * size + 32);
    });
    writeSync(descriptor, bytes, 0, bytes.length, first * size);
    fsyncSync(descriptor);
    return first;
  } finally {
    closeSync(descriptor);
  }
}

/** The number of whole records in the data file at `path`. */
export function recordCount(path: string, dimensions: number): number {
  try {
    const descriptor = openSync(path, 'r');
    try { return Math.floor(fstatSync(descriptor).size / recordBytes(dimensions)); } finally { closeSync(descriptor); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

/** Hands `visit` the vector of each wanted record that holds its key.
 *  `wanted` must be in record order. Most of the file wanted is read a
 *  chunk of records at a time; fewer, a record at a time. The vector is
 *  read in place from a buffer the next records reuse: read it during the
 *  visit and never keep it. */
export function readRecords(
  path: string, dimensions: number, wanted: readonly { readonly record: number; readonly key: string }[],
  visit: (key: string, vector: Float64Array) => void,
): void {
  if (wanted.length === 0) return;
  let descriptor: number;
  try {
    descriptor = openSync(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    const size = recordBytes(dimensions);
    const count = Math.floor(fstatSync(descriptor).size / size);
    const span = wanted.length * 2 >= count ? CHUNK : 1;
    // Its own memory, so every record's numbers sit on an 8-byte boundary.
    const buffer = Buffer.from(new ArrayBuffer(span * size));
    let start = 0;
    let end = 0;
    for (const { record, key } of wanted) {
      if (record >= count) continue;
      if (record >= end) {
        start = record;
        end = Math.min(record + span, count);
        if (readSync(descriptor, buffer, 0, (end - start) * size, start * size) !== (end - start) * size) return;
      }
      const at = (record - start) * size;
      if (buffer.toString('hex', at, at + 32) !== key) continue;
      visit(key, new Float64Array(buffer.buffer, buffer.byteOffset + at + 32, dimensions));
    }
  } finally {
    closeSync(descriptor);
  }
}

// The vector file earlier code kept, one model's vectors in one file:
//   header (32 bytes) | records | one last-used day per record
// A record is the text's SHA-256 (32 bytes) then the vector as 64-bit
// numbers in the writing machine's byte order. It is only read now, a
// chunk of records at a time, to move its vectors into the vector store.
const MAGIC = Buffer.from('CURVEC1\n');
const HEADER = 32;
const KEY = 32;
const NATIVE = 0x01020304;

/** Hands `visit` each record of the vector file at `path`: its text's
 *  SHA-256 as 64 hex characters and its vector's bytes, which `visit`
 *  must copy to keep. Returns whether the file was a whole one this code
 *  can read: its length must be exactly what its header says, so a cut
 *  file is never read. No file, or no whole one, visits nothing. */
export function eachVectorRecord(path: string, visit: (key: string, vector: Uint8Array) => void): boolean {
  let descriptor: number;
  try {
    descriptor = openSync(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  try {
    const head = Buffer.alloc(HEADER);
    if (readSync(descriptor, head, 0, HEADER, 0) !== HEADER || !head.subarray(0, MAGIC.length).equals(MAGIC)) return false;
    const [order, dimensions, count] = new Uint32Array(head.buffer.slice(head.byteOffset + 8, head.byteOffset + 20));
    // Written by a machine of the other byte order: its numbers would read wrong.
    if (order !== NATIVE || dimensions === 0) return false;
    const size = KEY + dimensions! * Float64Array.BYTES_PER_ELEMENT;
    if (fstatSync(descriptor).size !== HEADER + count! * (size + Uint32Array.BYTES_PER_ELEMENT)) return false;
    const chunk = Buffer.alloc(CHUNK * size);
    for (let first = 0; first < count!; first += CHUNK) {
      const records = Math.min(CHUNK, count! - first);
      if (readSync(descriptor, chunk, 0, records * size, HEADER + first * size) !== records * size) return false;
      for (let record = 0; record < records; record += 1) {
        const at = record * size;
        visit(chunk.toString('hex', at, at + KEY), chunk.subarray(at + KEY, at + size));
      }
    }
    return true;
  } finally {
    closeSync(descriptor);
  }
}
