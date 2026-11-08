import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { MemoryCandidate } from './pick.js';
import { cutScoreCurve } from './lanes.js';
import { markUnit, normalized, normalize, similarity } from './vectors.js';
import { labelFileStore } from './labels.js';
import { openIndexFile, type IndexDatabase, type IndexStatement } from './stored-index.js';

/** One local vector per complete input text, in input order. */
export type EmbeddingFunction = (
  texts: readonly string[],
  signal?: AbortSignal,
) => Promise<readonly ArrayLike<number>[]>;

/** Reuse vectors across runs, keyed by the model identity and complete
 * input text. Only hashes and vectors are written to disk. Each model's
 * vectors live in one indexed file beside the per-model JSON folder:
 * a text the file lacks is filled from the JSON folder (and written
 * into the file), or embedded as before and written to the file only.
 * The file's vectors are normalized once, when written; the lanes they
 * feed never normalize them again. */
export function cachedEmbeddings(
  embed: EmbeddingFunction,
  options: { readonly directory: string; readonly modelId: string },
): EmbeddingFunction {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const store = labelFileStore(join(options.directory, hash(options.modelId)));
  // One file per model id, beside the per-model JSON folder.
  const file = join(options.directory, `${hash(options.modelId)}.vectors.sqlite`);
  let statements: Promise<{ database: IndexDatabase; get: IndexStatement; put: IndexStatement }> | undefined;
  const vectorFile = () => statements ??= openIndexFile(file, options.directory).then((database) => {
    database.exec('CREATE TABLE IF NOT EXISTS vectors (key TEXT PRIMARY KEY, vector BLOB NOT NULL) WITHOUT ROWID');
    return {
      database,
      get: database.prepare('SELECT vector FROM vectors WHERE key = ?'),
      put: database.prepare('INSERT OR REPLACE INTO vectors (key, vector) VALUES (?, ?)'),
    };
  });
  const bytesOf = (vector: Float64Array) => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
  // The local context evaluates one input at a time; serialize cache
  // misses too, so concurrent source reads never embed a text twice.
  let pending: Promise<unknown> = Promise.resolve();
  return (texts, signal) => {
    const result = pending.then(async () => {
      signal?.throwIfAborted();
      const { get, put } = await vectorFile();
      const unique = new Map(texts.map((text) => [hash(text), text]));
      const vectors = new Map<string, Float64Array>();
      const missing: [string, string][] = [];
      const entries = [...unique];
      const fills = await Promise.all(entries.map(async ([key, text]) => {
        const row = get.get(key) as { vector: Uint8Array } | undefined;
        const bytes = row?.vector;
        if (bytes !== undefined && bytes.byteLength > 0
          && bytes.byteLength % Float64Array.BYTES_PER_ELEMENT === 0) {
          const vector = new Float64Array(bytes.byteLength / Float64Array.BYTES_PER_ELEMENT);
          new Uint8Array(vector.buffer).set(bytes);
          // The file only ever holds normalized vectors.
          return markUnit(vector);
        }
        const stored = await store.get(key);
        if (Array.isArray(stored) && stored.length > 0
          && stored.every((value) => typeof value === 'number' && Number.isFinite(value))
          && stored.some((value) => value !== 0)) {
          // Filled from the JSON store once, then the file serves it.
          const vector = markUnit(normalize(stored));
          put.run(key, bytesOf(vector));
          return vector;
        }
        return undefined;
      }));
      entries.forEach(([key, text], index) => {
        if (fills[index] !== undefined) vectors.set(key, fills[index]!);
        else missing.push([key, text]);
      });
      if (missing.length > 0) {
        const embedded = await embed(missing.map(([, text]) => text), signal);
        if (embedded.length !== missing.length) throw new TypeError('embed must return one vector per input text.');
        signal?.throwIfAborted();
        missing.forEach(([key], index) => {
          // The lane that scored the text normalized the stored vector
          // again, so the file holds normalize of what the JSON store
          // would have held: bit for bit what the lanes saw before.
          const vector = markUnit(normalize(normalize(embedded[index]!)));
          put.run(key, bytesOf(vector));
          vectors.set(key, vector);
        });
      }
      signal?.throwIfAborted();
      return texts.map((text) => vectors.get(hash(text))!);
    });
    pending = result.catch(() => {});
    return result;
  };
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
    // queries, for the fused order a thoroughness level reads.
    const meaningKept = ranks[index]!.slice(keywordLanes).some((rank) => rank !== null);
    return [{ ...rest, searchRanks: ranks[index]!,
      ...(meaningKept ? { meaningScore: Math.max(...scores.map((lane) => lane[index]!)) } : {}),
      ...(past ? { pastLaneCut: true as const } : {}) }];
  });
}
