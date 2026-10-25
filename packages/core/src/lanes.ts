import type { MemoryCandidate } from './pick.js';

/** One retrieval lane's contribution to the union, for reporting. */
export interface SearchLaneReport {
  /** The lane's search text: the task, a search line, a phrase, a
   *  kind-lane phrase or a name the task names; meaning lanes report
   *  their query text. */
  readonly task: string;
  readonly lane: 'search' | 'phrase' | 'kind' | 'meaning' | 'name';
  /** Candidates the lane matched before any cut: the reader's own
   *  `matched` count when it cut inside the read, the count it
   *  returned otherwise. */
  readonly read: number;
  /** Candidates the lane admitted to the union after any cut. */
  readonly kept: number;
}

/** How far down a lane's ranked scores to keep, worked out from the
 *  scores themselves rather than a fixed count. Only positive scores
 *  count as matches. Fewer than three positive scores cannot show a
 *  curve, so they are all kept. Among the rest, the cut sits where the
 *  descending curve flattens: the point furthest below the straight
 *  line between the best and the worst positive score, like the bend of
 *  an elbow. Equal scores fall together, so the returned count can be
 *  smaller than the knee index; when no point sits below that line the
 *  whole positive run is kept. A count, never a score floor: callers
 *  slice their own ranked list. */
export function cutScoreCurve(scores: readonly number[]): number {
  const positive = scores.filter((score) => score > 0).sort((left, right) => right - left);
  const count = positive.length;
  if (count <= 2) return count;
  const best = positive[0]!;
  const worst = positive[count - 1]!;
  if (best === worst) return count;
  let knee = -1;
  let deepest = 0;
  for (let index = 1; index < count - 1; index += 1) {
    const chord = best + (worst - best) * (index / (count - 1));
    const below = chord - positive[index]!;
    if (below > deepest) {
      deepest = below;
      knee = index;
    }
  }
  return knee < 0 ? count : positive.findIndex((score) => score <= positive[knee]!);
}

/** A candidate's own score in its lane: `laneScore` where the source
 *  carries one — a source whose signals hold an ordering or rank-merge
 *  score supplies the lane's own match score there — and the sum of
 *  its signals otherwise. The curve cut measures this score. */
export function laneScoreOf(candidate: MemoryCandidate): number {
  return candidate.laneScore
    ?? Object.values(candidate.signals).reduce((sum, value) => sum + value, 0);
}

/** The score where a lane's own curve flattens: the score of the first
 *  dropped rank, worked out by `cutScoreCurve`. Keeping every score
 *  above the bend is the cut; when the curve keeps the whole lane —
 *  too few positive scores, or no point below the chord — the bend is
 *  undefined. A streaming reader calls this on the lane's per-part
 *  scores so the parts it keeps match what `cutLane` would keep. */
export function laneBend(scores: readonly number[]): number | undefined {
  const keep = cutScoreCurve(scores);
  if (keep === 0 || keep >= scores.length) return undefined;
  return [...scores].sort((left, right) => right - left)[keep]!;
}

/** A lane's candidates in ranked order, cut at the score curve's
 *  flattening point. The sum of each candidate's signals is its rank;
 *  ties order by id so a lane ranks the same way on every run. The
 *  curve is measured on `laneScore` where a candidate carries one — a
 *  source whose signals are an ordering or rank-merge score supplies
 *  the lane's own match score there — and on the signal sum otherwise.
 *  The cut keeps every candidate scoring above the bend's score, in
 *  rank order. A lane with no positive score gives the curve nothing
 *  to cut on, so the whole lane is kept rather than emptied. When
 *  `cut` is false the whole group is kept and the lane is
 *  unrestricted. */
export function cutLane(
  group: readonly MemoryCandidate[],
  cut: boolean,
): { readonly kept: readonly MemoryCandidate[]; readonly read: number } {
  const signal = (candidate: MemoryCandidate) =>
    Object.values(candidate.signals).reduce((sum, value) => sum + value, 0);
  const ranked = [...group].sort((left, right) => signal(right) - signal(left) || left.id.localeCompare(right.id));
  const bend = cut ? laneBend(ranked.map(laneScoreOf)) : undefined;
  const kept = bend === undefined ? ranked : ranked.filter((candidate) => laneScoreOf(candidate) > bend);
  return { kept, read: group.length };
}
