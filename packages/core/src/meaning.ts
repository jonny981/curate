import type { MemoryCandidate } from './pick.js';

/** One local vector per complete input text, in input order. */
export type EmbeddingFunction = (
  texts: readonly string[],
  signal?: AbortSignal,
) => Promise<readonly ArrayLike<number>[]>;

export interface MeaningSearchOptions {
  readonly embed: EmbeddingFunction;
  /** Optional user dial per query and source. Omit to keep every rank. */
  readonly nearest?: number;
}

function normalize(vector: ArrayLike<number>, dimensions?: number): Float64Array {
  if (!vector.length || (dimensions !== undefined && vector.length !== dimensions)) {
    throw new TypeError('Embeddings must have the same nonzero dimension.');
  }
  const values = Float64Array.from(vector);
  let squared = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) throw new TypeError('Embeddings must contain finite numbers.');
    squared += value * value;
  }
  if (!squared || !Number.isFinite(squared)) throw new TypeError('Embeddings must have a finite nonzero length.');
  const length = Math.sqrt(squared);
  return values.map((value) => value / length);
}

/** Add local meaning ranks without changing keyword ranks or signals.
 * Candidate vectors are discarded after each batch; no index is kept. */
export async function addMeaningRanks(
  candidates: readonly MemoryCandidate[],
  task: string,
  options: MeaningSearchOptions & { readonly searchLines?: readonly string[]; readonly signal?: AbortSignal },
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
  const queryVectors = vectors.map((vector) => normalize(vector, vectors[0]!.length));
  const scores = queries.map(() => new Float64Array(unique.length));
  // Batching bounds temporary vector memory, without dropping any text.
  for (let start = 0; start < unique.length; start += 32) {
    options.signal?.throwIfAborted();
    const batch = unique.slice(start, start + 32);
    const embedded = await options.embed(batch.map((candidate) =>
      /[^\s\p{Cf}]/u.test(candidate.text) ? candidate.text : candidate.title), options.signal);
    if (embedded.length !== batch.length) throw new TypeError('embed must return one vector per input text.');
    embedded.forEach((vector, offset) => {
      const normalized = normalize(vector, queryVectors[0]!.length);
      queryVectors.forEach((query, lane) => {
        let similarity = 0;
        for (let dimension = 0; dimension < query.length; dimension += 1) {
          similarity += query[dimension]! * normalized[dimension]!;
        }
        scores[lane]![start + offset] = similarity;
      });
    });
  }
  options.signal?.throwIfAborted();
  const keywordLanes = unique.reduce((count, candidate) => Math.max(count, candidate.searchRanks?.length ?? 1), 1);
  const ranks = unique.map((candidate) => Array.from({ length: keywordLanes + queries.length }, (_, lane) =>
    lane < keywordLanes ? candidate.searchRanks?.[lane] ?? null : null));
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
      if (unique[index]!.searchRanks === undefined) ranks[index]![0] = rank;
    });
    scores.forEach((laneScores, lane) => {
      const order = [...group].sort((left, right) => laneScores[right]! - laneScores[left]!
        || unique[left]!.id.localeCompare(unique[right]!.id));
      order.slice(0, options.nearest).forEach((index, rank) => { ranks[index]![keywordLanes + lane] = rank; });
    });
  }
  return unique.flatMap((candidate, index) => ranks[index]!.some((rank) => rank !== null)
    ? [{ ...candidate, searchRanks: ranks[index]! }] : []);
}
