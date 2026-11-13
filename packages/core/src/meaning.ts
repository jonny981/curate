import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryCandidate } from './pick.js';
import { cutScoreCurve } from './lanes.js';
import { markUnit, normalized, normalize, similarity } from './vectors.js';
import { labelFileStore } from './labels.js';
import { openIndexFile, type IndexDatabase, type IndexStatement } from './stored-index.js';
import { FOLD_AT, KEEP_DAYS, markVectorsUsed, readVectorFile, today, writeVectorFile, type VectorFile } from './vector-file.js';

/** One local vector per complete input text, in input order. */
export type EmbeddingFunction = (
  texts: readonly string[],
  signal?: AbortSignal,
) => Promise<readonly ArrayLike<number>[]>;

/** Reuse vectors across runs, keyed by the model identity and complete
 * input text. Only hashes and vectors are written to disk. A model's
 * vectors live in one vector file, read whole into memory once per
 * process, so a text the file holds costs no lookup on disk. A text it
 * lacks is filled from the model's waiting file, where new vectors are
 * put, or from the older per-model JSON folder, or embedded and left
 * waiting. Once enough vectors wait they are folded into the vector
 * file, which leaves out any vector unused for KEEP_DAYS. Stored vectors
 * are normalized once, when written; the lanes they feed never
 * normalize them again. A returned vector can be the stored one itself:
 * read it, never write to it. `flush` records which vectors this
 * process used.
 *
 * The SQLite store the code before the vector file kept
 * (`<model>.vectors.sqlite`) is read once, to build the vector file
 * when there is none, and is never written: code from before still
 * finds its vectors there. Nothing deletes it. */
export function cachedEmbeddings(
  embed: EmbeddingFunction,
  options: { readonly directory: string; readonly modelId: string },
): EmbeddingFunction & { flush(): void } {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const store = labelFileStore(join(options.directory, hash(options.modelId)));
  // Per model id, beside the per-model JSON folder: the vector file, the
  // SQLite file new vectors wait in, and the earlier store, read only.
  const flat = join(options.directory, `${hash(options.modelId)}.vectors.flat`);
  const waitingFile = join(options.directory, `${hash(options.modelId)}.vectors.waiting.sqlite`);
  const earlier = join(options.directory, `${hash(options.modelId)}.vectors.sqlite`);
  type Row = { key: string; vector: Uint8Array };
  const vectorOf = (bytes: Uint8Array | undefined) => {
    if (bytes === undefined || bytes.byteLength === 0 || bytes.byteLength % Float64Array.BYTES_PER_ELEMENT !== 0) return undefined;
    const vector = new Float64Array(bytes.byteLength / Float64Array.BYTES_PER_ELEMENT);
    new Uint8Array(vector.buffer).set(bytes);
    // The stores only ever hold normalized vectors.
    return markUnit(vector);
  };
  const everyRow = function* everyRow(database: IndexDatabase) {
    const page = database.prepare('SELECT key, vector FROM vectors WHERE key > ? ORDER BY key LIMIT 1024');
    for (let after = ''; ;) {
      const rows = page.all(after) as Row[];
      if (rows.length === 0) return;
      after = rows.at(-1)!.key;
      yield* rows;
    }
  };
  // Opened read-only, so not one byte of the earlier store changes.
  const openEarlier = () => existsSync(earlier)
    ? new (process.getBuiltinModule('node:sqlite') as unknown as {
      DatabaseSync: new (path: string, options: { readOnly: true }) => IndexDatabase;
    }).DatabaseSync(earlier, { readOnly: true })
    : undefined;
  // Write the vector file again with every waiting vector in it, and with
  // the earlier store's vectors when there is no vector file yet. One
  // process does this at a time: the write transaction on the waiting
  // file is the lock, and it holds off new waiting vectors until the
  // file that holds the old ones is in place.
  const fold = (database: IndexDatabase) => {
    database.exec('BEGIN IMMEDIATE');
    let from: IndexDatabase | undefined;
    try {
      const old = readVectorFile(flat);
      from = old === undefined ? openEarlier() : undefined;
      const first = (source: IndexDatabase | undefined) =>
        (source?.prepare('SELECT vector FROM vectors ORDER BY key LIMIT 1').get() as Row | undefined)?.vector;
      const sample = first(from) ?? first(database);
      // Another process may have done it while this one waited its turn.
      const waits = (database.prepare('SELECT COUNT(*) AS n FROM vectors').get() as { n: number }).n;
      if (sample === undefined || (waits < FOLD_AT && first(from) === undefined)) return database.exec('COMMIT');
      const day = today();
      const dimensions = old?.dimensions ?? sample.byteLength / Float64Array.BYTES_PER_ELEMENT;
      const fits = (row: Row) => /^[0-9a-f]{64}$/.test(row.key) && row.vector.byteLength === dimensions * Float64Array.BYTES_PER_ELEMENT;
      // A waiting row the file cannot hold stays waiting: a key that is
      // no text hash, or a vector of another length.
      const unfit: Row[] = [];
      const rows = function* rows() {
        const kept = new Set<string>();
        for (let record = 0; old !== undefined && record < old.count; record += 1) {
          if (day - old.days[record]! > KEEP_DAYS) continue;
          const row = old.record(record);
          kept.add(row.key);
          yield { ...row, day: old.days[record]! };
        }
        for (const row of from === undefined ? [] : everyRow(from)) {
          if (!fits(row) || kept.has(row.key)) continue;
          kept.add(row.key);
          yield { key: row.key, vector: row.vector, day };
        }
        for (const row of everyRow(database)) {
          if (!fits(row)) unfit.push(row);
          else if (!kept.has(row.key)) yield { key: row.key, vector: row.vector, day };
        }
      };
      writeVectorFile(flat, dimensions, rows());
      database.exec('DELETE FROM vectors');
      const put = database.prepare('INSERT OR REPLACE INTO vectors (key, vector) VALUES (?, ?)');
      for (const row of unfit) put.run(row.key, row.vector);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    } finally {
      from?.close();
    }
    // Hand the emptied pages back; the vectors are safe in the file either way.
    try { database.exec('VACUUM'); database.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* another process is using the file */ }
  };
  let opened: Promise<{ database: IndexDatabase; get: IndexStatement; put: IndexStatement;
    held: VectorFile | undefined; used: Uint8Array; waiting: Map<string, Float64Array> }> | undefined;
  const vectorFile = () => opened ??= openIndexFile(waitingFile, options.directory).then((database) => {
    database.exec('CREATE TABLE IF NOT EXISTS vectors (key TEXT PRIMARY KEY, vector BLOB NOT NULL) WITHOUT ROWID');
    if ((database.prepare('SELECT COUNT(*) AS n FROM (SELECT 1 FROM vectors LIMIT ?)').get(FOLD_AT) as { n: number }).n >= FOLD_AT
      || (!existsSync(flat) && existsSync(earlier))) fold(database);
    // The waiting vectors are read before the file: a fold by another
    // process in between then shows a vector twice, never not at all.
    const waiting = new Map<string, Float64Array>();
    for (const row of database.prepare('SELECT key, vector FROM vectors').all() as Row[]) {
      const vector = vectorOf(row.vector);
      if (vector !== undefined) waiting.set(row.key, vector);
    }
    const held = readVectorFile(flat);
    return {
      // Held so the statements outlive this call: a collected database closes them.
      database,
      get: database.prepare('SELECT vector FROM vectors WHERE key = ?'),
      put: database.prepare('INSERT OR REPLACE INTO vectors (key, vector) VALUES (?, ?)'),
      held, used: new Uint8Array(held?.count ?? 0), waiting,
    };
  });
  const bytesOf = (vector: Float64Array) => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
  // The local context evaluates one input at a time; serialize cache
  // misses too, so concurrent source reads never embed a text twice.
  let pending: Promise<unknown> = Promise.resolve();
  let current: Awaited<ReturnType<typeof vectorFile>> | undefined;
  const cached: EmbeddingFunction = (texts, signal) => {
    const result = pending.then(async () => {
      signal?.throwIfAborted();
      const { get, put, held, used, waiting } = current = await vectorFile();
      const keys = texts.map(hash);
      const unique = new Map(keys.map((key, index) => [key, texts[index]!]));
      const vectors = new Map<string, Float64Array>();
      const missing: [string, string][] = [];
      for (const [key, text] of unique) {
        const record = held?.index.get(key);
        if (record !== undefined) {
          used[record] = 1;
          vectors.set(key, markUnit(held!.vector(record)));
          continue;
        }
        // Waiting when this process started, or put there since. A vector
        // made during this process is not held in memory a second time.
        let vector = waiting.get(key) ?? vectorOf((get.get(key) as { vector: Uint8Array } | undefined)?.vector);
        if (vector === undefined) {
          const stored = await store.get(key);
          if (Array.isArray(stored) && stored.length > 0
            && stored.every((value) => typeof value === 'number' && Number.isFinite(value))
            && stored.some((value) => value !== 0)) {
            // Filled from the JSON store once, then it waits with the rest.
            vector = markUnit(normalize(stored));
            put.run(key, bytesOf(vector));
          }
        }
        if (vector === undefined) missing.push([key, text]);
        else vectors.set(key, vector);
      }
      if (missing.length > 0) {
        const embedded = await embed(missing.map(([, text]) => text), signal);
        if (embedded.length !== missing.length) throw new TypeError('embed must return one vector per input text.');
        signal?.throwIfAborted();
        missing.forEach(([key], index) => {
          // The lane that scored the text normalized the stored vector
          // again, so the store holds normalize of what the JSON store
          // would have held: bit for bit what the lanes saw before.
          const vector = markUnit(normalize(normalize(embedded[index]!)));
          put.run(key, bytesOf(vector));
          vectors.set(key, vector);
        });
      }
      signal?.throwIfAborted();
      return keys.map((key) => vectors.get(key)!);
    });
    pending = result.catch(() => {});
    return result;
  };
  return Object.assign(cached, { flush() {
    const held = current?.held;
    if (held === undefined) return;
    const { database, used } = current!;
    const day = today();
    // At most one small write a day for a history that does not change.
    if (!used.some((flag, record) => flag === 1 && held.days[record]! < day)) return;
    // Under the lock a fold holds, so the file cannot be replaced part-way.
    database.exec('BEGIN IMMEDIATE');
    try {
      markVectorsUsed(flat, held, used, day);
    } finally {
      database.exec('COMMIT');
    }
    used.forEach((flag, record) => { if (flag === 1) held.days[record] = day; });
  } });
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
