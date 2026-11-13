import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryCandidate } from './pick.js';
import { cutScoreCurve } from './lanes.js';
import { markUnit, normalized, normalize, similarity, textKey } from './vectors.js';
import { labelFileStore } from './labels.js';
import { openIndexFile, type IndexDatabase, type IndexStatement } from './stored-index.js';
import { appendRecords, eachVectorRecord, readRecords, recordCount } from './vector-file.js';

/** One local vector per complete input text, in input order. */
export type EmbeddingFunction = (
  texts: readonly string[],
  signal?: AbortSignal,
) => Promise<readonly ArrayLike<number>[]>;

/** An embedding function that also hands out stored vectors by key. */
export interface StoredEmbeddingFunction extends EmbeddingFunction {
  /** Hands `visit` the stored unit vector of each of `keys`, by its index
   *  in `keys`, in no set order. A key the store lacks has its vector
   *  made from `text(index)` and stored; `text` is asked for nothing
   *  else. Positions that share a key share its vector. A vector can be
   *  read in place from memory the next vectors reuse: read it during the
   *  visit, never keep it and never write to it. */
  eachVector(
    keys: readonly string[], text: (index: number) => string,
    visit: (index: number, vector: Float64Array) => void, signal?: AbortSignal,
  ): Promise<void>;
  /** Removes the files earlier code kept for the model, the whole-file
   *  vector file and its waiting store, once every vector in them is
   *  found again in the store, byte for byte, and returns the paths it
   *  removed. When one cannot be checked so, both stay and a line on
   *  standard error says so. An older process can still have them open,
   *  so only a run between calls, such as the skill's `--prepare`, asks. */
  removeEarlierFiles(): Promise<readonly string[]>;
}

/** Reuse vectors across runs, keyed by the model identity and complete
 * input text. Only hashes and vectors are written to disk, in two files
 * per model: `<model>.vectors.data`, where each vector is a record
 * appended after the last, and `<model>.vectors.keys.sqlite`, which finds
 * a text's record by the text's SHA-256. A read looks up the records it
 * wants, and a read that wants most of them passes over the data file
 * once, a chunk at a time; neither file is ever read whole into memory.
 * Nothing rewrites a record, and no vector expires: a vector stays as
 * long as the files do. A vector of another length than the model's is
 * kept in the key file itself. A text neither file holds is filled from
 * the older per-model JSON folder, or embedded. Stored vectors are
 * normalized once, when written; the lanes they feed never normalize
 * them again. A returned vector can be shared by other callers: read it,
 * never write to it.
 *
 * When the key file is first made, the store takes in every vector
 * earlier code kept for the model: the whole-file vector file
 * (`<model>.vectors.flat`), the vectors waiting to join it
 * (`<model>.vectors.waiting.sqlite`), and, where there is no vector file,
 * the SQLite store before it (`<model>.vectors.sqlite`). Each is only
 * read here; `removeEarlierFiles` removes the first two between calls.
 * The store before the vector file is only ever read. */
export function cachedEmbeddings(
  embed: EmbeddingFunction,
  options: { readonly directory: string; readonly modelId: string },
): StoredEmbeddingFunction {
  const model = textKey(options.modelId);
  const legacy = labelFileStore(join(options.directory, model));
  const file = (name: string) => join(options.directory, `${model}.vectors.${name}`);
  const data = file('data');
  type Row = { key: string; vector: Uint8Array };
  const vectorOf = (bytes: Uint8Array | undefined) => {
    if (bytes === undefined || bytes.byteLength === 0 || bytes.byteLength % Float64Array.BYTES_PER_ELEMENT !== 0) return undefined;
    const vector = new Float64Array(bytes.byteLength / Float64Array.BYTES_PER_ELEMENT);
    new Uint8Array(vector.buffer).set(bytes);
    // The store only ever holds normalized vectors.
    return markUnit(vector);
  };
  const sameBytes = (left: Uint8Array, right: Uint8Array) =>
    Buffer.from(left.buffer, left.byteOffset, left.byteLength).equals(right);
  // The vector file and its waiting store are removed once every vector
  // they hold is found again under its key, byte for byte. A file that
  // cannot be checked so stays, and a line on standard error says so.
  // The store before the vector file is only ever read.
  const retire = (database: IndexDatabase, length: number | undefined): string[] => {
    const record = database.prepare('SELECT record FROM keys WHERE key = ?');
    const odd = database.prepare('SELECT vector FROM odd WHERE key = ?');
    const fromFlat = new Set<string>();
    let held = true;
    // A batch of rows, each of which must be in the store as it is here.
    const check = (rows: readonly Row[]) => {
      const located: { record: number; key: string }[] = [];
      const expected = new Map(rows.map((row) => [row.key, row.vector]));
      const found = new Set<string>();
      for (const row of rows) {
        const at = (record.get(row.key) as { record: number } | undefined)?.record;
        if (at !== undefined) located.push({ record: at, key: row.key });
        else {
          const kept = (odd.get(row.key) as { vector: Uint8Array } | undefined)?.vector;
          if (kept !== undefined && sameBytes(kept, row.vector)) found.add(row.key);
        }
      }
      located.sort((left, right) => left.record - right.record);
      if (length !== undefined) {
        readRecords(data, length, located, (key, vector) => {
          if (sameBytes(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), expected.get(key)!)) found.add(key);
        });
      }
      if (found.size !== expected.size) held = false;
    };
    let rows: Row[] = [];
    const flat = file('flat');
    if (existsSync(flat)) {
      const whole = eachVectorRecord(flat, (key, vector) => {
        fromFlat.add(key);
        rows.push({ key, vector: vector.slice() });
        if (rows.length === 1024) { check(rows); rows = []; }
      });
      check(rows);
      rows = [];
      if (!whole) held = false;
    }
    const waiting = file('waiting.sqlite');
    if (existsSync(waiting)) {
      const from = new (process.getBuiltinModule('node:sqlite') as unknown as {
        DatabaseSync: new (path: string, options: { readOnly: true }) => IndexDatabase;
      }).DatabaseSync(waiting, { readOnly: true });
      try {
        // A row no lookup ever used, or one the vector file's copy won over, needs no check.
        for (const row of from.prepare('SELECT key, vector FROM vectors').iterate() as Iterable<Row>) {
          if (vectorOf(row.vector) === undefined || fromFlat.has(row.key)) continue;
          rows.push(row);
          if (rows.length === 1024) { check(rows); rows = []; }
        }
        check(rows);
      } finally {
        from.close();
      }
    }
    const earlier = [flat, waiting].filter((path) => existsSync(path));
    if (earlier.length === 0) return [];
    if (!held) {
      process.stderr.write(`Curate left ${earlier.join(' and ')} in place: not every vector in them was found again in the vector store.\n`);
      return [];
    }
    const removed = [flat, waiting, `${waiting}-wal`, `${waiting}-shm`].filter((path) => existsSync(path));
    for (const path of removed) rmSync(path, { force: true });
    return removed;
  };
  let opened: Promise<{ database: IndexDatabase; dimensions: () => number | undefined;
    record: IndexStatement; every: IndexStatement; odd: IndexStatement; put: (rows: readonly Row[]) => void }> | undefined;
  // ponytail: the data file only grows: the vector of a changed or deleted
  // part stays, about 6 KB each at 768 numbers. The way up is a compaction
  // that gathers every source's stored vector keys and copies only their
  // records into a new data file.
  const store = () => opened ??= openIndexFile(file('keys.sqlite'), options.directory).then((database) => {
    database.exec(`CREATE TABLE IF NOT EXISTS keys (key TEXT PRIMARY KEY, record INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS odd (key TEXT PRIMARY KEY, vector BLOB NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS facts (name TEXT PRIMARY KEY, value INTEGER NOT NULL) WITHOUT ROWID`);
    const fact = database.prepare('SELECT value FROM facts WHERE name = ?');
    const setFact = database.prepare('INSERT OR REPLACE INTO facts (name, value) VALUES (?, ?)');
    const putKey = database.prepare('INSERT OR REPLACE INTO keys (key, record) VALUES (?, ?)');
    const putOdd = database.prepare('INSERT OR REPLACE INTO odd (key, vector) VALUES (?, ?)');
    const dimensions = () => (fact.get('dimensions') as { value: number } | undefined)?.value;
    // Called inside a write transaction, which keeps other writers off the
    // data file's end. The first vector stored sets the model's length.
    const putLocked = (rows: readonly Row[]) => {
      if (rows.length === 0) return;
      let length = dimensions();
      if (length === undefined) {
        length = rows[0]!.vector.byteLength / Float64Array.BYTES_PER_ELEMENT;
        setFact.run('dimensions', length);
      }
      const fitting = rows.filter((row) => row.vector.byteLength === length * Float64Array.BYTES_PER_ELEMENT);
      for (const row of rows) if (!fitting.includes(row)) putOdd.run(row.key, row.vector);
      if (fitting.length === 0) return;
      const first = appendRecords(data, length, fitting);
      fitting.forEach((row, at) => putKey.run(row.key, first + at));
    };
    const locked = (work: () => void) => {
      database.exec('BEGIN IMMEDIATE');
      try {
        work();
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    };
    // Every vector earlier code kept, moved in once. The write transaction
    // is the lock: a second process waits, then finds the move done. The
    // first copy of a key wins, as the vector file did over the vectors
    // waiting to join it.
    locked(() => {
      if (fact.get('moved') !== undefined) return;
      const seen = new Set<string>();
      let rows: Row[] = [];
      const take = (key: string, vector: Uint8Array) => {
        if (seen.has(key)) return;
        seen.add(key);
        rows.push({ key, vector: vector.slice() });
        if (rows.length === 1024) { putLocked(rows); rows = []; }
      };
      const whole = eachVectorRecord(file('flat'), take);
      // The store before the vector file only ever built one where there was none.
      for (const earlier of whole ? [file('waiting.sqlite')] : [file('waiting.sqlite'), file('sqlite')]) {
        if (!existsSync(earlier)) continue;
        // Opened read-only, so not one byte of it changes.
        const from = new (process.getBuiltinModule('node:sqlite') as unknown as {
          DatabaseSync: new (path: string, options: { readOnly: true }) => IndexDatabase;
        }).DatabaseSync(earlier, { readOnly: true });
        try {
          for (const row of from.prepare('SELECT key, vector FROM vectors').iterate() as Iterable<Row>) {
            if (vectorOf(row.vector) !== undefined) take(row.key, row.vector);
          }
        } finally {
          from.close();
        }
      }
      putLocked(rows);
      setFact.run('moved', 1);
    });
    return {
      // Held so the statements outlive this call: a collected database closes them.
      database, dimensions,
      record: database.prepare('SELECT record FROM keys WHERE key = ?'),
      every: database.prepare('SELECT key, record FROM keys'),
      odd: database.prepare('SELECT vector FROM odd WHERE key = ?'),
      put: (rows: readonly Row[]) => locked(() => putLocked(rows)),
    };
  });
  const bytesOf = (vector: Float64Array) => new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
  // The local context evaluates one input at a time; serialize cache
  // misses too, so concurrent source reads never embed a text twice.
  let pending: Promise<unknown> = Promise.resolve();
  const eachVector: StoredEmbeddingFunction['eachVector'] = (keys, text, visit, signal) => {
    const result = pending.then(async () => {
      signal?.throwIfAborted();
      const { dimensions, record, every, odd, put } = await store();
      const wanted = new Map<string, number[]>();
      keys.forEach((key, index) => {
        const at = wanted.get(key);
        if (at === undefined) wanted.set(key, [index]);
        else at.push(index);
      });
      const hand = (key: string, vector: Float64Array) => {
        for (const index of wanted.get(key)!) visit(index, vector);
        wanted.delete(key);
      };
      const length = dimensions();
      if (length !== undefined) {
        // A read that wants most of the records passes over the key file
        // once; any other looks up each key. The records are then read in
        // file order.
        const found: { record: number; key: string }[] = [];
        if (wanted.size * 2 >= recordCount(data, length)) {
          for (const row of every.iterate() as Iterable<{ key: string; record: number }>) if (wanted.has(row.key)) found.push(row);
        } else {
          for (const key of wanted.keys()) {
            const row = record.get(key) as { record: number } | undefined;
            if (row !== undefined) found.push({ record: row.record, key });
          }
        }
        found.sort((left, right) => left.record - right.record);
        readRecords(data, length, found, (key, vector) => hand(key, markUnit(vector)));
      }
      // What the data file lacks: a vector of another length, kept in the
      // key file; from the JSON folder; else embedded, a bounded batch at a time.
      let batch: [string, number][] = [];
      const embedBatch = async () => {
        if (batch.length === 0) return;
        const embedded = await embed(batch.map(([, index]) => text(index)), signal);
        if (embedded.length !== batch.length) throw new TypeError('embed must return one vector per input text.');
        signal?.throwIfAborted();
        // The lane that scored the text normalized the stored vector
        // again, so the store holds normalize of what the JSON store
        // would have held: bit for bit what the lanes saw before.
        const vectors = embedded.map((vector) => markUnit(normalize(normalize(vector))));
        put(batch.map(([key], at) => ({ key, vector: bytesOf(vectors[at]!) })));
        batch.forEach(([key], at) => hand(key, vectors[at]!));
        batch = [];
      };
      for (const [key, [index]] of [...wanted]) {
        const kept = vectorOf((odd.get(key) as { vector: Uint8Array } | undefined)?.vector);
        if (kept !== undefined) {
          hand(key, kept);
          continue;
        }
        const stored = await legacy.get(key);
        if (Array.isArray(stored) && stored.length > 0
          && stored.every((value) => typeof value === 'number' && Number.isFinite(value))
          && stored.some((value) => value !== 0)) {
          // Filled from the JSON folder once, then kept with the rest.
          const vector = markUnit(normalize(stored));
          put([{ key, vector: bytesOf(vector) }]);
          hand(key, vector);
          continue;
        }
        batch.push([key, index!]);
        if (batch.length === 32) await embedBatch();
      }
      await embedBatch();
      signal?.throwIfAborted();
    });
    pending = result.catch(() => {});
    return result;
  };
  // Each vector copied out: a vector read in place is only good during its visit.
  const cached: EmbeddingFunction = async (texts, signal) => {
    const vectors: Float64Array[] = Array.from({ length: texts.length });
    await eachVector(texts.map(textKey), (index) => texts[index]!,
      (index, vector) => { vectors[index] = markUnit(Float64Array.from(vector)); }, signal);
    return vectors;
  };
  const removeEarlierFiles = () => {
    const result = pending.then(async () => {
      const { database, dimensions } = await store();
      return retire(database, dimensions());
    });
    pending = result.catch(() => {});
    return result;
  };
  return Object.assign(cached, { eachVector, removeEarlierFiles });
}

export interface MeaningSearchOptions {
  readonly embed: EmbeddingFunction;
  /** Optional user dial per query and source. Omit to keep every rank. */
  readonly nearest?: number;
  /** Keep each query's whole ranked similarity list. Off by default:
   *  the ranks are cut where the query's own score curve flattens,
   *  from the scores themselves, and a query with no positive
   *  similarity admits nothing; pass true to keep every rank (still
   *  subject to `nearest`). */
  readonly wholeLanes?: boolean;
}

/** Add local meaning ranks without changing keyword ranks or signals.
 * Candidate vectors are discarded after each batch; no index is kept. */
export async function addMeaningRanks(
  candidates: readonly MemoryCandidate[],
  task: string,
  options: MeaningSearchOptions & {
    readonly searchLines?: readonly string[];
    readonly signal?: AbortSignal;
    /** Internal to pickFromSources: the read's keyword lane count, the
     *  index its meaning lanes start at. Inferred from the
     *  candidates' `searchRanks` when unset, which reads 1 when no
     *  candidate carries ranks at all. */
    readonly keywordLanes?: number;
  },
): Promise<MemoryCandidate[]> {
  if (options.nearest !== undefined && (!Number.isSafeInteger(options.nearest) || options.nearest < 1)) {
    throw new TypeError('nearest must be a positive safe integer.');
  }
  options.signal?.throwIfAborted();
  const unique = [...new Map(candidates.map((candidate) => [
    JSON.stringify([candidate.sourceId, candidate.id]), candidate,
  ])).values()];
  if (!unique.length) return [];
  const queries = [...new Set([task, ...(options.searchLines ?? [])].map((text) => text.trim()).filter(Boolean))];
  if (!queries.length) throw new TypeError('Meaning search needs a nonblank task or search line.');
  const vectors = await options.embed(queries, options.signal);
  if (vectors.length !== queries.length) throw new TypeError('embed must return one vector per input text.');
  const queryVectors = vectors.map((vector) => normalized(vector, vectors[0]!.length));
  const scores = queries.map(() => new Float64Array(unique.length));
  // Batching bounds temporary vector memory, without dropping any text.
  for (let start = 0; start < unique.length; start += 32) {
    options.signal?.throwIfAborted();
    const batch = unique.slice(start, start + 32);
    const embedded = await options.embed(batch.map((candidate) =>
      /[^\s\p{Cf}]/u.test(candidate.text) ? candidate.text : candidate.title), options.signal);
    if (embedded.length !== batch.length) throw new TypeError('embed must return one vector per input text.');
    embedded.forEach((vector, offset) => {
      const part = normalized(vector, queryVectors[0]!.length);
      queryVectors.forEach((query, lane) => {
        scores[lane]![start + offset] = similarity(query, part);
      });
    });
  }
  options.signal?.throwIfAborted();
  const keywordLanes = options.keywordLanes
    ?? unique.reduce((count, candidate) => Math.max(count, candidate.searchRanks?.length ?? 1), 1);
  const ranks = unique.map((candidate) => Array.from({ length: keywordLanes + queries.length }, (_, lane) =>
    lane < keywordLanes ? candidate.searchRanks?.[lane] ?? null : null));
  // With `wholeLanes` on, whether every meaning lane that holds a part
  // holds it past the cut; undefined while no meaning lane holds it.
  const pastMeaning: (boolean | undefined)[] = unique.map(() => undefined);
  const groups = new Map<string, number[]>();
  unique.forEach((candidate, index) => {
    const group = groups.get(candidate.sourceId);
    if (group) group.push(index);
    else groups.set(candidate.sourceId, [index]);
  });
  const signalScore = (index: number) => Object.values(unique[index]!.signals).reduce((sum, value) => sum + value, 0);
  for (const group of groups.values()) {
    const keywordOrder = [...group].sort((left, right) => signalScore(right) - signalScore(left)
      || unique[left]!.id.localeCompare(unique[right]!.id));
    keywordOrder.forEach((index, rank) => {
      // A pool member is no keyword result: no fallback lane-0 rank.
      if (unique[index]!.searchRanks === undefined && unique[index]!.poolOnly !== true) ranks[index]![0] = rank;
    });
    scores.forEach((laneScores, lane) => {
      const order = [...group].sort((left, right) => laneScores[right]! - laneScores[left]!
        || unique[left]!.id.localeCompare(unique[right]!.id));
      const curve = cutScoreCurve(order.map((index) => laneScores[index]!));
      // A query with no positive similarity matched nothing, so the
      // cut admits nothing rather than the whole group.
      const kept = options.wholeLanes === true ? order.length : curve;
      order.slice(0, Math.min(options.nearest ?? kept, kept)).forEach((index, rank) => {
        ranks[index]![keywordLanes + lane] = rank;
        if (options.wholeLanes === true) pastMeaning[index] = (pastMeaning[index] ?? true) && rank >= curve;
      });
    });
  }
  return unique.flatMap((candidate, index) => {
    if (!ranks[index]!.some((rank) => rank !== null)) {
      // A pool member no lane ranked stays pool-only for the label lane.
      return candidate.poolOnly === true ? [candidate] : [];
    }
    // A lane rank ends pool-only membership. A part is past the cut
    // while every lane holding it, keyword or meaning, holds it past.
    const { poolOnly: _poolOnly, pastLaneCut: keywordPast, ...rest } = candidate;
    const keywordHeld = ranks[index]!.slice(0, keywordLanes).some((rank) => rank !== null);
    const past = keywordHeld ? keywordPast === true && pastMeaning[index] !== false : pastMeaning[index] === true;
    // A part a meaning lane kept holds its best similarity over the
    // queries, for the fused order the decide step reads.
    const meaningKept = ranks[index]!.slice(keywordLanes).some((rank) => rank !== null);
    return [{ ...rest, searchRanks: ranks[index]!,
      ...(meaningKept ? { meaningScore: Math.max(...scores.map((lane) => lane[index]!)) } : {}),
      ...(past ? { pastLaneCut: true as const } : {}) }];
  });
}
