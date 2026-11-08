import { classifyTask } from './task.js';
import type { MemoryCandidate, PickCascadeModel } from './pick.js';

/** The code facts a model-scored question set combines beside its
 *  question answers, computed by Curate from the source's candidate
 *  list: the part's role flags, its age at the task date, its place in
 *  the list's order, its keyword score and rank, and the task's kinds.
 *  A fact that cannot be measured is absent, and the score imputes it
 *  at the fitted mean. */
export interface JudgmentFacts {
  readonly hasUser: number;
  readonly hasAssistant: number;
  readonly userShare: number;
  readonly daysBefore: number;
  readonly position: number;
  readonly poolSize: number;
  readonly kwScore?: number;
  readonly kwRank?: number;
  readonly kind_count: number;
  readonly kind_date: number;
  readonly kind_advice: number;
  readonly kind_named: number;
  readonly kind_other: number;
}

/** What one source's whole candidate list gives each part's facts:
 *  the list's size, each part's place in its date, session and part
 *  order, and each scored part's rank on the keyword score. */
export interface JudgmentPopulation {
  readonly poolSize: number;
  readonly position: ReadonlyMap<MemoryCandidate, number>;
  readonly kwRank: ReadonlyMap<MemoryCandidate, number>;
}

/** The numbers a part id ends in: the id's last three colon fields
 *  when each is a number — a part id's file, block and piece — else
 *  the digits and dots at its end, else nothing. */
function partNumbers(id: string): readonly number[] {
  const tail = id.split(':').slice(-3);
  if (tail.length === 3 && tail.every((field) => /^\d+$/.test(field))) {
    return tail.map((field) => Number(field));
  }
  const match = /(\d[\d.]*)$/.exec(id);
  return match === null ? [] : match[1]!.split('.').map((field) => Number(field));
}

const compareNumbers = (left: readonly number[], right: readonly number[]): number => {
  for (const [index, a] of left.entries()) {
    if (index >= right.length) return 1;
    if (a !== right[index]!) return a - right[index]!;
  }
  return left.length - right.length;
};

const dateMs = (candidate: MemoryCandidate) => {
  const ms = Date.parse(candidate.date?.value ?? '');
  return Number.isFinite(ms) ? ms : 0;
};

/** Measure the list once: position is the chronological order the
 *  experiment used — by date (undated parts first), then session id,
 *  then the part id's numbers — and the keyword rank is the score's
 *  descending order, stable for equal scores. Unscored parts hold no
 *  rank. */
export function judgmentPopulation(population: readonly MemoryCandidate[]): JudgmentPopulation {
  const position = new Map<MemoryCandidate, number>([...population]
    .sort((a, b) => (dateMs(a) - dateMs(b))
      || (a.chat?.sessionId ?? '').localeCompare(b.chat?.sessionId ?? '')
      || compareNumbers(partNumbers(a.id), partNumbers(b.id)))
    .map((candidate, index) => [candidate, index]));
  const kwRank = new Map<MemoryCandidate, number>();
  const keyword = (candidate: MemoryCandidate) => {
    const score = candidate.signals.keyword;
    return typeof score === 'number' && Number.isFinite(score) ? score : Number.NEGATIVE_INFINITY;
  };
  [...population].sort((a, b) => keyword(b) - keyword(a))
    .forEach((candidate, index) => {
      if (keyword(candidate) !== Number.NEGATIVE_INFINITY) kwRank.set(candidate, index);
    });
  return { poolSize: population.length, position, kwRank };
}

const DAY_MS = 86_400_000;

/** The part's row of the feature table. Role flags come from the part's
 *  transcript role; an undated part's age falls back to 180 days; a
 *  part missing from the population's ranks simply carries no kwRank. */
export function judgmentFacts(
  candidate: MemoryCandidate,
  population: JudgmentPopulation,
  task: string,
  taskMs: number,
): JudgmentFacts {
  const kinds = new Set(classifyTask(task));
  const ms = Date.parse(candidate.date?.value ?? '');
  const role = candidate.chat?.role;
  const kwScore = candidate.signals.keyword;
  const scored = typeof kwScore === 'number' && Number.isFinite(kwScore);
  return {
    hasUser: role === 'user' ? 1 : 0,
    hasAssistant: role === 'assistant' ? 1 : 0,
    userShare: role === 'user' ? 1 : 0,
    daysBefore: Number.isFinite(ms) && Number.isFinite(taskMs)
      ? Math.floor(taskMs / DAY_MS) - Math.floor(ms / DAY_MS) : 180,
    position: population.position.get(candidate)!,
    poolSize: population.poolSize,
    ...(scored ? { kwScore } : {}),
    ...(population.kwRank.has(candidate) ? { kwRank: population.kwRank.get(candidate)! } : {}),
    kind_count: kinds.has('count') ? 1 : 0,
    kind_date: kinds.has('date') ? 1 : 0,
    kind_advice: kinds.has('advice') ? 1 : 0,
    kind_named: kinds.has('named') ? 1 : 0,
    kind_other: kinds.has('other') ? 1 : 0,
  };
}

/** Score one part through a model set's fitted weights: each `keys`
 *  slot reads its feature or question answer, centres it on `mu` and
 *  scales by `sd`, and the weighted sum plus `b` passes through the
 *  logistic. An absent or nonfinite value is imputed at its `mu`, so a
 *  missing answer or fact contributes nothing either way. */
export function modelScore(
  model: PickCascadeModel,
  features: Readonly<Partial<Record<string, number>>>,
): number {
  let z = model.b;
  for (const [index, key] of model.keys.entries()) {
    const value = features[key];
    const imputed = Number.isFinite(value) ? value! : model.mu[index]!;
    z += model.w[index]! * ((imputed - model.mu[index]!) / model.sd[index]!);
  }
  return 1 / (1 + Math.exp(-z));
}
