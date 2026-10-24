import type { MemoryCandidate } from './pick.js';
import { cutScoreCurve } from './lanes.js';
import { normalize, similarity } from './vectors.js';

/** One local vector per complete input text, in input order. */
export type EmbeddingFunction = (
  texts: readonly string[],
  signal?: AbortSignal,
) => Promise<readonly ArrayLike<number>[]>;

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
        scores[lane]![start + offset] = similarity(query, normalized);
      });
    });
  }
  options.signal?.throwIfAborted();
  const keywordLanes = unique.reduce((count, candidate) => Math.max(count, candidate.searchRanks?.length ?? 1), 1);
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
    return [{ ...rest, searchRanks: ranks[index]!, ...(past ? { pastLaneCut: true as const } : {}) }];
  });
}
