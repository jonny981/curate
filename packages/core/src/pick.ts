import { candidateDocument } from './document.js';

export type MemoryCandidateRole = 'reference' | 'rule';
export type MemoryKind = 'knowledge' | 'docs' | 'rules' | 'instructions';
export type CandidateSourceKind = 'chat' | 'git-history' | 'markdown';

export interface MemoryCandidate {
  readonly sourceId: string;
  readonly sourceRevision?: string;
  readonly role: MemoryCandidateRole;
  readonly kind?: MemoryKind;
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly contentRef?: string;
  /** Optional document identity for hosts that supply parts themselves. */
  readonly documentId?: string;
  /** Item ids this candidate cites, set by `observationCandidates` so a
   *  selected observation line can be traced back to its source parts. */
  readonly cites?: readonly string[];
  /** Zero-based rank within this source for each search line; null means absent. */
  readonly searchRanks?: readonly (number | null)[];
  /** Transcript metadata; separate from the candidate's reference role. */
  readonly chat?: {
    readonly provider: 'claude-code' | 'codex';
    readonly sessionId: string;
    readonly role: 'user' | 'assistant' | 'tool-call' | 'tool-result';
  };
  /** Repository paths this candidate changed. For a commit: the files in
   *  its diff, not paths the text mentions. */
  readonly changedPaths?: readonly string[];
  /** The repository-relative file path a note candidate lives at: the
   *  note's side of the commit-to-note link. */
  readonly path?: string;
  /** Opaque identifier both sides of a link share when their sources
   *  point into the same work tree; the source declares it (the repo
   *  toplevel, or a caller-supplied key). Candidates with different
   *  values, or where either side declares none, never link. */
  readonly repository?: string;
  /** Absolute directory of an instruction file. */
  readonly directory?: string;
  readonly date?: {
    readonly value: string;
    readonly meaning: 'changed' | 'effective' | 'recorded' | 'modified';
  };
  readonly signals: Readonly<Record<string, number>>;
  /** The lane's own match score for the keyword lane's curve cut, when
   *  `signals` carry an ordering or rank-merge score instead of the
   *  lane's match strength. `cutLane` measures the score curve on it;
   *  a source that ranks by merging ranked lists (the chat package)
   *  carries its pre-merge keyword score here. Unused when `signals`
   *  already carry match scores. */
  readonly laneScore?: number;
  readonly applies?: 'always';
}

export interface PickQuestion {
  readonly key: string;
  /** The fitted question's name, when a cascade is supplied. */
  readonly questionKey?: string;
  /** The tag set this question belongs to, for a tag question. */
  readonly tagSet?: string;
  readonly date?: MemoryCandidate['date'];
  readonly role: MemoryCandidateRole;
  readonly kind?: MemoryKind;
  readonly question: string;
  readonly trueCriterion: string;
  readonly falseCriterion: string;
  readonly sourceId: string;
  readonly id: string;
  readonly title: string;
  readonly text: string;
}

export interface PickBatch {
  readonly task: string;
  readonly questions: readonly PickQuestion[];
}

export type PickAnswer =
  | { readonly status: 'answered'; readonly probability: number }
  | { readonly status: 'refused' | 'missing' | 'error'; readonly detail?: string }
  /** The question was never asked: a stopping dial ended the run first.
   *  Only recorded for tag questions; a decide reply cannot produce it. */
  | { readonly status: 'unassessed'; readonly detail?: string };

export type PickDecide = (
  batch: PickBatch,
  signal: AbortSignal,
) => Promise<Record<string, PickAnswer>>;

export interface PickLimits {
  /** Request size only; every batch is processed unless an explicit stop is set. */
  readonly maxPerBatch?: number;
  /** Request size only: a batch holds as many whole items as fit within
   *  this many characters, counting the task's text, each item's id,
   *  title, date and text once per item in the batch, and each
   *  question's wording and true and false criteria per question. A
   *  single item larger than the bound goes alone; nothing is dropped
   *  or truncated. With `maxPerBatch` set too, a batch closes at
   *  whichever bound it reaches first. Omitted means no character
   *  bound. */
  readonly maxBatchChars?: number;
  /** Optional stopping dials. Omitted means no limit; skipped items are recorded. */
  readonly maxBatches?: number;
  readonly maxCandidates?: number;
  readonly maxElapsedMs?: number;
  readonly maxQuestionText?: number;
}

export interface PickThresholds {
  /** Keep every scored reference by default; set a bar to filter. */
  readonly reference?: number;
  /** A bar that rises with the answered-reference count, as [count,
   *  bar] points in size order: below the first point the first bar
   *  applies, above the last the last bar applies, and between two
   *  points the bar moves linearly. Use it to keep everything on a
   *  small decided set and cut more of the weakest as the set grows.
   *  Point positions are a measurement question, not a guess: choose
   *  them against the history the funnel will read. Supplied instead
   *  of `reference`; the recorded `appliedReference` is the bar used. */
  readonly referenceBySize?: readonly (readonly [number, number])[];
  /** Keep every scored rule by default; set a bar to filter applicability. */
  readonly rule?: number;
  /** The bar a 'reference' candidate at or above it still clears when a
   *  threshold-selected commit from the same `repository` names its
   *  `path` in `changedPaths`. Applies only to references rejected by a cut.
   *  0.4 is a chosen default, not a measured best; it is not shown to
   *  beat the reference threshold everywhere. */
  readonly linkedPathBar?: number;
}

export type PickEntryStatus =
  | {
      readonly status: 'selected';
      readonly asked: boolean;
      readonly probability?: number;
      /** Present when the changed-path link, not the threshold, carried
       *  the candidate over: the selected candidate whose changedPaths
       *  named this candidate's path. An entry that passed on threshold
       *  alone carries none. */
      readonly link?: { readonly sourceId: string; readonly id: string };
    }
  | { readonly status: 'rejected'; readonly probability: number }
  | {
      readonly status: 'unanswered';
      readonly answer: 'refused' | 'missing' | 'error';
      readonly detail?: string;
    }
  | { readonly status: 'unassessed'; readonly reason: 'limits' | 'time' | 'cancelled' | 'document' | 'error' };

export type PickRecordEntry = {
  readonly sourceId: string;
  readonly sourceRevision?: string;
  readonly id: string;
  readonly role: MemoryCandidateRole;
  readonly kind?: MemoryKind;
  readonly priority: number;
  readonly searchRanks?: readonly (number | null)[];
  /** Final ordering score; the decision probability remains separate. */
  readonly orderScore?: number;
  /** The first part judged for this document, within this entry's source. */
  readonly representative?: string;
  readonly signals: Readonly<Record<string, number>>;
  /** The candidate's own content handle (a commit's full SHA); kept so
   *  a saved record names the exact bytes, not a short display form. */
  readonly contentRef?: string;
  readonly changedPaths?: readonly string[];
  readonly path?: string;
  readonly repository?: string;
  readonly truncated?: boolean;
  /** The candidate's source kind, recorded whenever `sourceKinds` names
   *  one for its source: 'chat', 'git-history' or 'markdown'. */
  readonly sourceKind?: CandidateSourceKind;
  /** Individual fitted answers, before combining them. */
  readonly questions?: readonly ({ readonly key: string } & PickAnswer)[];
  /** Decision tags recorded on a kept reference: each named set's
   *  chosen value plus the answers behind it. A single-question set
   *  values to 'yes' at probability 0.5 or more, otherwise 'no'; a
   *  multi-question set values to the first of its questions answered
   *  at 0.5 or more, so a levelled set such as importance records the
   *  highest level that cleared, and stays unset when no answer
   *  reaches 0.5. Absent when the candidate was not a selected
   *  reference or no tag sets applied to it. Tag questions a stop
   *  left unasked record 'unassessed' with the stop reason. */
  readonly tags?: Readonly<Record<string, {
    readonly value?: string;
    readonly answers: readonly ({ readonly key: string } & PickAnswer)[];
  }>>;
} & PickEntryStatus;

export interface PickCriterion {
  readonly key: string;
  readonly instructions: string;
  readonly true: string;
  readonly false: string;
}

/** A named set of narrow yes/no questions whose answers label a kept
 *  reference: intent, importance, emphasis and the like. Unlike a
 *  cascade the questions do not combine into a selection probability;
 *  every answer is recorded and the set's value is the first of its
 *  questions answered at probability 0.5 or more — list questions so
 *  earlier keys take precedence, highest level first for levelled
 *  sets such as importance. No answer at 0.5 leaves the value unset.
 *  Tag questions run only on references that pass relevance, so they
 *  never change what is selected. */
export interface PickTagSet {
  readonly key: string;
  readonly questions: readonly PickCriterion[];
}

/** Fitted narrow questions. Negative weights invert a question's contribution. */
export interface PickCascade {
  readonly bias: number;
  readonly questions: readonly (PickCriterion & { readonly weight: number })[];
  readonly first?: string;
  readonly band?: readonly [number, number];
  readonly firstOnly?: { readonly bias: number; readonly weight: number };
}

export interface PickRecord {
  readonly ranking?: PickOptions['ranking'];
  readonly questionVersion: string;
  readonly limits: PickLimits;
  readonly thresholds: Required<Omit<PickThresholds, 'referenceBySize'>>
    & Pick<PickThresholds, 'referenceBySize'>
    & { /** The bar `referenceBySize` produced for this set's size. */
        readonly appliedReference?: number };
  readonly candidates: readonly PickRecordEntry[];
  readonly rulesCoverage: 'complete' | 'incomplete';
  /** Present when a decide call rejected its batch and ended the pick:
   *  the batch's candidate ids and the error's message. The pick fails
   *  with a PickError carrying this record; a failed decision batch
   *  leaves its candidates unanswered and everything still unasked is
   *  unassessed. A failed tag batch leaves a decided selection standing
   *  and records the error on the tag's answers, since tags never
   *  change what is selected. */
  readonly decideError?: { readonly candidates: readonly string[]; readonly message: string };
  readonly cascade?: PickCascade;
  /** A source-specific set overrides cascade; undeclared kinds use cascade. */
  readonly cascadesByKind?: Readonly<Partial<Record<CandidateSourceKind, PickCascade>>>;
  /** Source identities mapped to kinds; pickFromSources fills these from source.kind. */
  readonly sourceKinds?: Readonly<Record<string, CandidateSourceKind>>;
  readonly keepTop?: number;
  readonly rankProtection?: boolean;
  readonly bestPartFirst?: boolean;
  /** The tag sets every kept reference answered, when supplied. */
  readonly tags?: readonly PickTagSet[];
  /** Extra tag sets asked only of references from that source kind. */
  readonly tagsByKind?: Readonly<Partial<Record<CandidateSourceKind, readonly PickTagSet[]>>>;
}

export interface PickResult {
  readonly selected: readonly MemoryCandidate[];
  readonly record: PickRecord;
}

/** Thrown when a decide call rejects its batch; the run's record is
 *  carried on `record` with the failure named in `record.decideError`. */
export class PickError extends Error {
  readonly record: PickRecord;
  constructor(message: string, record: PickRecord, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PickError';
    this.record = record;
  }
}

export interface PickOptions {
  /** Signal weights by Markdown kind; omitted weights remain 1. */
  readonly ranking?: Partial<Record<MemoryKind, Readonly<Record<string, number>>>>;
  readonly task: string;
  readonly decide: PickDecide;
  readonly cascade?: PickCascade;
  /** A source-specific set overrides cascade; undeclared kinds use cascade. */
  readonly cascadesByKind?: Readonly<Partial<Record<CandidateSourceKind, PickCascade>>>;
  /** Source identities mapped to kinds; pickFromSources fills these from source.kind. */
  readonly sourceKinds?: Readonly<Record<string, CandidateSourceKind>>;
  /** Put these top ranked hits first if they pass the threshold. */
  readonly keepTop?: number;
  /** Blend search rank and decision probability for selected references. Off by default. */
  readonly rankProtection?: boolean;
  /** Judge each document's best keyword part before its other fed parts. Off by default. */
  readonly bestPartFirst?: boolean;
  /** Decision tag sets asked of every kept reference, after relevance
   *  decides. Off by default; tags are recorded on the entry and never
   *  change what is selected. */
  readonly tags?: readonly PickTagSet[];
  /** Extra tag sets asked only of kept references from that source
   *  kind: commit-kind questions for 'git-history', note-kind ones for
   *  'markdown'. Source kinds come from `sourceKinds`, which
   *  pickFromSources fills from each source's `kind`. */
  readonly tagsByKind?: Readonly<Partial<Record<CandidateSourceKind, readonly PickTagSet[]>>>;
  /** False when a source that can supply rule candidates did not finish
   *  enumerating them; its read returned `complete: false`. The combined
   *  coverage can then never report a complete applicable-rule set, even
   *  when every rule supplied was answered. Defaults to true. */
  readonly rulesEnumerationComplete?: boolean;
  readonly limits?: PickLimits;
  readonly thresholds?: PickThresholds;
  readonly signal?: AbortSignal;
}

export const PICK_QUESTION_VERSION = 'memory-pick-questions-1';

const DEFAULT_MAX_PER_BATCH = 150;
/** Default reader part size, in characters. Readers preserve every part;
 *  pick itself shows full candidate text unless a caller supplies a cut. */
export const DEFAULT_MAX_QUESTION_TEXT = 700;
const DEFAULT_LINKED_PATH_BAR = 0.4;
const TIMED_OUT = Symbol('timed out');

const PICK_QUESTIONS: Record<
  MemoryCandidateRole,
  { readonly question: string; readonly trueCriterion: string; readonly falseCriterion: string }
> = {
  reference: {
    question: 'Does this item supply useful evidence, a constraint or a decision for this task?',
    trueCriterion: 'The item gives evidence, a constraint or a decision that helps with this task.',
    falseCriterion: 'The item gives no evidence, constraint or decision that helps with this task.',
  },
  rule: {
    question: 'Does this rule apply to this task?',
    trueCriterion: 'The rule governs this task, so the work must follow it.',
    falseCriterion: 'The rule does not govern this task.',
  },
};

const KIND_QUESTIONS: Record<MemoryKind, typeof PICK_QUESTIONS.reference> = {
  knowledge: {
    question: 'Does this knowledge supply useful facts or decisions for this task?',
    trueCriterion: 'The knowledge gives facts or decisions that help with this task.',
    falseCriterion: 'The knowledge does not help with this task.',
  },
  docs: {
    question: 'Does this documentation explain how to complete this task?',
    trueCriterion: 'The documentation gives steps or details needed for this task.',
    falseCriterion: 'The documentation does not help complete this task.',
  },
  rules: PICK_QUESTIONS.rule,
  instructions: {
    question: 'Do these instructions govern work on the files named by this task?',
    trueCriterion: 'The instructions govern this work and must be followed.',
    falseCriterion: 'The instructions do not govern this work.',
  },
};

type CheckedAnswer =
  | { readonly status: 'answered'; readonly probability: number }
  | { readonly status: 'refused' | 'missing' | 'error'; readonly detail?: string };

interface ResolvedLimits {
  readonly maxPerBatch: number;
  readonly maxBatchChars: number;
  readonly maxBatches: number;
  readonly maxCandidates: number;
  readonly maxElapsedMs: number;
  readonly maxQuestionText: number;
}

function positiveLimit(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function probabilityLimit(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${name} must be a number between 0 and 1.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What one item adds to its batch's counted size once per batch,
 *  however many of its questions the batch holds: the item's id, title,
 *  date and text. */
function itemChars(question: PickQuestion): number {
  return question.id.length + question.title.length + question.text.length
    + (question.date === undefined ? 0 : question.date.value.length + question.date.meaning.length);
}

/** What one question adds to its batch's counted size: the question's
 *  wording and its true and false criteria. */
function questionChars(question: PickQuestion): number {
  return question.question.length + question.trueCriterion.length + question.falseCriterion.length;
}

function takeCharacters(
  value: string,
  limit: number,
): { readonly text: string; readonly truncated: boolean } {
  let count = 0;
  let end = 0;
  for (const character of value) {
    if (count === limit) break;
    end += character.length;
    count += 1;
  }
  return { text: value.slice(0, end), truncated: end < value.length };
}

function questionKey(candidate: MemoryCandidate): string {
  return JSON.stringify([candidate.sourceId, candidate.id]);
}

function signalScore(candidate: MemoryCandidate, ranking: PickOptions['ranking']): number {
  let sum = 0;
  const weights = candidate.kind === undefined ? undefined : ranking?.[candidate.kind];
  for (const [name, value] of Object.entries(candidate.signals)) sum += value * (weights?.[name] ?? 1);
  return sum;
}

function rankAndInterleave(
  pool: readonly MemoryCandidate[],
  priority: Map<MemoryCandidate, number>,
  lane?: number,
  ranking?: PickOptions['ranking'],
): MemoryCandidate[] {
  const groups = new Map<string, MemoryCandidate[]>();
  for (const candidate of pool) {
    const group = groups.get(candidate.sourceId);
    if (group === undefined) groups.set(candidate.sourceId, [candidate]);
    else group.push(candidate);
  }
  const ordered: MemoryCandidate[] = [];
  for (const group of groups.values()) {
    const rankOf = (candidate: MemoryCandidate) => candidate.searchRanks === undefined
      ? undefined
      : lane === undefined
        ? Math.min(...candidate.searchRanks.filter((rank): rank is number => rank !== null))
        : candidate.searchRanks[lane] ?? Number.POSITIVE_INFINITY;
    group.sort((left, right) => {
      const a = rankOf(left), b = rankOf(right);
      return (a === undefined && b === undefined ? signalScore(right, ranking) - signalScore(left, ranking)
        : (a ?? Number.POSITIVE_INFINITY) - (b ?? Number.POSITIVE_INFINITY))
        || left.id.localeCompare(right.id);
    });
    group.forEach((candidate, rank) => priority.set(candidate, rankOf(candidate) ?? rank));
  }
  let added = true;
  for (let round = 0; added; round += 1) {
    added = false;
    for (const group of groups.values()) {
      const candidate = group[round];
      if (candidate !== undefined) {
        ordered.push(candidate);
        added = true;
      }
    }
  }
  return ordered;
}

function checkAnswer(raw: unknown): CheckedAnswer {
  if (raw === undefined) return { status: 'missing' };
  if (!isRecord(raw)) return { status: 'error', detail: 'The answer is not an object.' };
  const { status, probability, detail } = raw;
  if (status === 'answered') {
    return typeof probability === 'number' && Number.isFinite(probability)
      && probability >= 0 && probability <= 1
      ? { status: 'answered', probability }
      : { status: 'error', detail: 'The answer probability is not a number between 0 and 1.' };
  }
  if (status === 'refused' || status === 'missing' || status === 'error') {
    return typeof detail === 'string' ? { status, detail } : { status };
  }
  return { status: 'error', detail: 'The answer status is not recognised.' };
}

function checkCascade(cascade: PickCascade | undefined): void {
  if (cascade === undefined) return;
  const keys = cascade.questions.map((q) => q.key);
  if (!Number.isFinite(cascade.bias) || !keys.length || new Set(keys).size !== keys.length
    || cascade.questions.some((q) => !q.key || !q.instructions || !q.true || !q.false || !Number.isFinite(q.weight))) {
    throw new TypeError('cascade needs unique questions and finite fitted weights.');
  }
  if (cascade.first !== undefined || cascade.band !== undefined || cascade.firstOnly !== undefined) {
    if (!keys.includes(cascade.first!) || !cascade.band || cascade.band.length !== 2
      || cascade.band.some((p) => !Number.isFinite(p) || p < 0 || p > 1)
      || cascade.band[0] > cascade.band[1] || !cascade.firstOnly
      || !Number.isFinite(cascade.firstOnly.bias) || !Number.isFinite(cascade.firstOnly.weight)) {
      throw new TypeError('cascade first, band and firstOnly must be supplied together with valid weights.');
    }
  }
}

function checkTagSet(set: PickTagSet | undefined): void {
  if (set === undefined) return;
  const keys = set.questions.map((question) => question.key);
  if (typeof set.key !== 'string' || !set.key.trim() || !keys.length || new Set(keys).size !== keys.length
    || set.questions.some((question) => !question.instructions || !question.true || !question.false)) {
    throw new TypeError('a tag set needs a key and unique, nonempty questions.');
  }
}

/** The bar a size curve applies at `count`: flat below the first
 *  point, flat above the last, linear between two points. */
function sizeBar(points: readonly (readonly [number, number])[], count: number): number {
  if (count <= points[0]![0]) return points[0]![1];
  if (count >= points[points.length - 1]![0]) return points[points.length - 1]![1];
  for (let index = 1; index < points.length; index += 1) {
    const [size, bar] = points[index]!;
    if (count <= size) {
      const [lowerSize, lowerBar] = points[index - 1]!;
      return lowerBar + (bar - lowerBar) * ((count - lowerSize) / (size - lowerSize));
    }
  }
  return points[points.length - 1]![1];
}

function checkSizeCurve(points: readonly (readonly [number, number])[] | undefined): void {
  if (points === undefined) return;
  if (!Array.isArray(points) || !points.length
    || points.some((point) => !Array.isArray(point) || point.length !== 2
      || !Number.isSafeInteger(point[0]) || point[0]! < 0
      || typeof point[1] !== 'number' || !Number.isFinite(point[1]) || point[1]! < 0 || point[1]! > 1)
    || new Set(points.map((point) => point[0])).size !== points.length) {
    throw new TypeError('thresholds.referenceBySize needs unique nonnegative integer counts with bars between 0 and 1.');
  }
}

// Match the prototype: clamp each side separately, and missing answers add nothing.
function logit(p: number): number {
  return Math.log(Math.max(p, 1e-4) / Math.max(1 - p, 1e-4));
}

export async function pick(
  candidates: readonly MemoryCandidate[],
  options: PickOptions,
): Promise<PickResult> {
  for (const weights of Object.values(options.ranking ?? {})) {
    if (Object.values(weights).some((weight) => !Number.isFinite(weight))) {
      throw new TypeError('ranking weights must be finite numbers.');
    }
  }
  for (const candidate of candidates) {
    const ranks = candidate.searchRanks;
    if (ranks !== undefined && (!ranks.some((rank) => rank !== null)
      || ranks.some((rank) => rank !== null && (!Number.isSafeInteger(rank) || rank < 0)))) {
      throw new TypeError('searchRanks needs nonnegative safe integers or null and at least one rank.');
    }
  }
  checkCascade(options.cascade);
  for (const set of Object.values(options.cascadesByKind ?? {})) checkCascade(set);
  checkSizeCurve(options.thresholds?.referenceBySize);
  for (const set of options.tags ?? []) checkTagSet(set);
  for (const sets of Object.values(options.tagsByKind ?? {})) for (const set of sets ?? []) checkTagSet(set);
  const kindFor = (candidate: MemoryCandidate) => options.sourceKinds && Object.hasOwn(options.sourceKinds, candidate.sourceId)
    ? options.sourceKinds[candidate.sourceId] : undefined;
  const cascadeFor = (candidate: MemoryCandidate) => {
    const kind = kindFor(candidate);
    return (kind === undefined ? undefined : options.cascadesByKind?.[kind]) ?? options.cascade;
  };
  const tagSetsFor = (candidate: MemoryCandidate) => {
    const kind = kindFor(candidate);
    const sets = [...options.tags ?? [], ...(kind === undefined ? [] : options.tagsByKind?.[kind] ?? [])];
    if (new Set(sets.map((set) => set.key)).size !== sets.length) {
      throw new TypeError('tag set keys must be unique per candidate, across tags and tagsByKind.');
    }
    return sets;
  };
  for (const candidate of candidates) tagSetsFor(candidate);
  const keepTop = options.keepTop ?? 0;
  if (!Number.isSafeInteger(keepTop) || keepTop < 0) {
    throw new TypeError('keepTop must be a nonnegative safe integer.');
  }
  const input = options.limits ?? {};
  const limits: ResolvedLimits = {
    maxPerBatch: positiveLimit(input.maxPerBatch, 'maxPerBatch', DEFAULT_MAX_PER_BATCH),
    maxBatchChars: positiveLimit(input.maxBatchChars, 'maxBatchChars', Number.POSITIVE_INFINITY),
    maxBatches: positiveLimit(input.maxBatches, 'maxBatches', Number.POSITIVE_INFINITY),
    maxCandidates: positiveLimit(input.maxCandidates, 'maxCandidates', Number.POSITIVE_INFINITY),
    maxElapsedMs: positiveLimit(input.maxElapsedMs, 'maxElapsedMs', Number.POSITIVE_INFINITY),
    maxQuestionText: positiveLimit(input.maxQuestionText, 'maxQuestionText', Number.POSITIVE_INFINITY),
  };
  const recordedLimits: PickLimits = {
    maxPerBatch: limits.maxPerBatch,
    ...(input.maxBatchChars !== undefined ? { maxBatchChars: input.maxBatchChars } : {}),
    ...(input.maxQuestionText !== undefined ? { maxQuestionText: input.maxQuestionText } : {}),
    ...(input.maxBatches !== undefined ? { maxBatches: input.maxBatches } : {}),
    ...(input.maxCandidates !== undefined ? { maxCandidates: input.maxCandidates } : {}),
    ...(input.maxElapsedMs !== undefined ? { maxElapsedMs: input.maxElapsedMs } : {}),
  };
  const thresholds: PickRecord['thresholds'] = {
    reference: probabilityLimit(options.thresholds?.reference, 'thresholds.reference', 0),
    rule: probabilityLimit(options.thresholds?.rule, 'thresholds.rule', 0),
    linkedPathBar: probabilityLimit(options.thresholds?.linkedPathBar, 'thresholds.linkedPathBar', DEFAULT_LINKED_PATH_BAR),
    ...(options.thresholds?.referenceBySize === undefined ? {}
      : { referenceBySize: [...options.thresholds.referenceBySize].sort((left, right) => left[0] - right[0]) }),
  };
  const signal = options.signal ?? new AbortController().signal;
  const started = Date.now();

  const priority = new Map<MemoryCandidate, number>();
  const rules = rankAndInterleave(candidates.filter((c) => c.role === 'rule'), priority, undefined, options.ranking);
  const references = rankAndInterleave(candidates.filter((c) => c.role === 'reference'), priority, undefined, options.ranking);

  const selected: MemoryCandidate[] = [];
  const statuses = new Map<MemoryCandidate, PickEntryStatus>();
  const truncated = new Map<MemoryCandidate, boolean>();
  const queue: MemoryCandidate[] = [];
  for (const rule of rules) {
    if (rule.applies === 'always') {
      selected.push(rule);
      statuses.set(rule, { status: 'selected', asked: false });
    } else {
      queue.push(rule);
    }
  }
  queue.push(...references);

  const lanes = queue.reduce((count, candidate) => Math.max(count, candidate.searchRanks?.length ?? 1), 1);
  const eligible = new Set<MemoryCandidate>();
  for (let lane = 0; lane < lanes; lane += 1) {
    const present = (candidate: MemoryCandidate) => candidate.searchRanks === undefined
      || candidate.searchRanks[lane] != null;
    const laneQueue = lanes === 1 ? queue : [
      ...rankAndInterleave(rules.filter((c) => c.applies !== 'always' && present(c)), new Map(), lane, options.ranking),
      ...rankAndInterleave(references.filter(present), new Map(), lane, options.ranking),
    ];
    for (const candidate of laneQueue.slice(0, limits.maxCandidates)) eligible.add(candidate);
  }
  const feed = queue.filter((candidate) => eligible.has(candidate));
  const answered = new Map<MemoryCandidate, Map<string, CheckedAnswer>>();
  const specsFor = (candidate: MemoryCandidate) => {
    const cascade = cascadeFor(candidate);
    return candidate.role === 'reference' && cascade
      ? cascade.questions.map((q) => ({ key: q.key, question: q.instructions, trueCriterion: q.true, falseCriterion: q.false }))
      : [{ key: candidate.role, ...(candidate.kind === undefined || (candidate.role === 'rule' && candidate.kind !== 'instructions')
        ? PICK_QUESTIONS[candidate.role] : KIND_QUESTIONS[candidate.kind]) }];
  };
  type Pending = { candidate: MemoryCandidate; spec: ReturnType<typeof specsFor>[number]; question: PickQuestion };
  const pending = (candidate: MemoryCandidate, spec: ReturnType<typeof specsFor>[number], tagSet?: string): Pending => {
    const shown = Number.isFinite(limits.maxQuestionText)
      ? takeCharacters(candidate.text, limits.maxQuestionText)
      : { text: candidate.text, truncated: false };
    const fitted = tagSet !== undefined
      || (candidate.role === 'reference' && (cascadeFor(candidate) !== undefined || spec.key !== 'reference'));
    return { candidate, spec, question: {
      key: fitted ? JSON.stringify([candidate.sourceId, candidate.id, spec.key]) : questionKey(candidate),
      ...(fitted ? { questionKey: spec.key } : {}),
      ...(tagSet === undefined ? {} : { tagSet }),
      ...(candidate.date === undefined ? {} : { date: candidate.date }),
      ...(candidate.kind === undefined ? {} : { kind: candidate.kind }),
      role: candidate.role, question: spec.question, trueCriterion: spec.trueCriterion,
      falseCriterion: spec.falseCriterion, sourceId: candidate.sourceId, id: candidate.id,
      title: candidate.title, text: shown.text,
    } };
  };
  let batches = 0;
  let stop: 'limits' | 'time' | 'cancelled' | 'error' | undefined;
  let decideFailure:
    { readonly ids: readonly string[]; readonly message: string; readonly error: unknown } | undefined;
  /** Candidates in a rejected decision batch: their verdicts are not
   *  trusted even when an earlier batch answered some questions. */
  const decideFailed = new Set<MemoryCandidate>();
  const ask = async (asks: Pending[], sink = answered) => {
    for (let index = 0; index < asks.length;) {
      if (signal.aborted) { stop = 'cancelled'; break; }
      if (batches >= limits.maxBatches) { stop = 'limits'; break; }
      const remaining = limits.maxElapsedMs - (Date.now() - started);
      if (remaining <= 0) { stop = 'time'; break; }
      // A batch packs whole items until the character bound; the first
      // item always goes, so a single oversized item is sent alone. An
      // item counts once per batch however many of its questions it holds.
      const slice: Pending[] = [];
      const counted = new Set<MemoryCandidate>();
      let batchChars = options.task.length;
      for (const item of asks.slice(index, index + limits.maxPerBatch)) {
        const size = questionChars(item.question)
          + (counted.has(item.candidate) ? 0 : itemChars(item.question));
        if (slice.length > 0 && batchChars + size > limits.maxBatchChars) break;
        batchChars += size;
        counted.add(item.candidate);
        slice.push(item);
      }
      index += slice.length;
      const questions = slice.map((item) => item.question);
      const deadline = Number.isFinite(remaining) ? AbortSignal.timeout(Math.ceil(remaining)) : undefined;
      let answers: Record<string, PickAnswer> | undefined;
      let decideError: unknown;
      let timedOut = false;
      try {
        const returned: unknown = await Promise.race([
          options.decide({ task: options.task, questions },
            deadline === undefined ? signal : AbortSignal.any([signal, deadline])),
          new Promise<typeof TIMED_OUT>((resolve) => {
            deadline?.addEventListener('abort', () => resolve(TIMED_OUT), { once: true });
          }),
        ]);
        if (returned === TIMED_OUT) timedOut = true;
        else answers = isRecord(returned) ? returned as Record<string, PickAnswer> : undefined;
      } catch (error) {
        timedOut = deadline?.aborted === true;
        decideError = error;
      }
      // A rejected batch is reported, not swallowed: the record names
      // the batch's candidate ids and the error's message, and the pick
      // fails on it; no retry and no fallback. A call the elapsed limit
      // or the caller's signal already stopped ends the run, not the pick.
      if (decideError !== undefined && !timedOut && !signal.aborted) {
        decideFailure = {
          ids: [...new Set(slice.map(({ question }) => question.id))],
          message: decideError instanceof Error ? decideError.message : String(decideError),
          error: decideError,
        };
        if (sink === answered) for (const item of slice) decideFailed.add(item.candidate);
        stop = 'error';
      }
      for (const { candidate, spec, question } of slice) {
        const answer: CheckedAnswer = timedOut
          ? { status: 'error', detail: 'The decide call did not finish before the elapsed limit.' }
          : answers === undefined
            ? { status: 'error', detail: decideError instanceof Error ? decideError.message
                : decideError === undefined ? 'The decide call failed.' : String(decideError) }
            : checkAnswer(answers[question.key]);
        let got = sink.get(candidate);
        if (!got) { got = new Map(); sink.set(candidate, got); }
        got.set(spec.key, answer);
        truncated.set(candidate, Number.isFinite(limits.maxQuestionText)
          && takeCharacters(candidate.text, limits.maxQuestionText).truncated);
      }
      batches += 1;
      if (timedOut) { stop = 'time'; break; }
      if (decideFailure !== undefined) break;
    }
  };
  const combined = new Map<MemoryCandidate, CheckedAnswer>();
  // Candidates a stop left half-assessed inside a cascade.
  const curtailed = new Map<MemoryCandidate, 'limits' | 'time' | 'cancelled' | 'error'>();
  const evaluate = async (phase: readonly MemoryCandidate[]) => {
    await ask(phase.flatMap((candidate) => specsFor(candidate)
      .filter((spec) => candidate.role === 'rule' || !cascadeFor(candidate)?.first || spec.key === cascadeFor(candidate)!.first)
      .map((spec) => pending(candidate, spec))));
    if (!stop) {
      await ask(phase.flatMap((candidate) => {
        const cascade = cascadeFor(candidate);
        if (candidate.role === 'rule' || !cascade?.first) return [];
        const first = answered.get(candidate)?.get(cascade.first);
        if (first?.status !== 'answered'
          || first.probability < cascade.band![0] || first.probability > cascade.band![1]) return [];
        return specsFor(candidate).filter((spec) => spec.key !== cascade.first).map((spec) => pending(candidate, spec));
      }));
    }
    for (const candidate of phase) {
      const cascade = cascadeFor(candidate);
      const got = answered.get(candidate);
      if (!got) continue;
      let answer: CheckedAnswer;
      if (candidate.role === 'reference' && cascade) {
        const first = cascade.first === undefined ? undefined : got.get(cascade.first);
        if (first?.status === 'answered'
          && (first.probability < cascade.band![0] || first.probability > cascade.band![1])) {
          answer = { status: 'answered', probability: 1 / (1 + Math.exp(-(cascade.firstOnly!.bias + cascade.firstOnly!.weight * logit(first.probability)))) };
        } else {
          // A returned missing answer contributes nothing, as in the prototype.
          // A question never attempted because a limit stopped us is unassessed.
          if (stop && cascade.questions.some((q) => !got.has(q.key))
            && (!cascade.first || first?.status === 'answered')) {
            curtailed.set(candidate, stop);
            continue;
          }
          const probabilities = cascade.questions.map((q) => got.get(q.key));
          if (probabilities.some((a) => a?.status === 'answered')) {
            const z = cascade.bias + cascade.questions.reduce((sum, q, i) => {
              const a = probabilities[i];
              return sum + (a?.status === 'answered' ? q.weight * logit(a.probability) : 0);
            }, 0);
            answer = { status: 'answered', probability: 1 / (1 + Math.exp(-z)) };
          } else answer = first ?? got.values().next().value ?? { status: 'missing' };
        }
      } else answer = got.values().next().value!;
      combined.set(candidate, answer);
    }
  };

  const representatives = new Map<MemoryCandidate, MemoryCandidate>();
  if (options.bestPartFirst) {
    const terms = [...new Set(options.task.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2))];
    const matches = (candidate: MemoryCandidate) => {
      const words = new Set(`${candidate.title} ${candidate.text}`.toLowerCase().split(/[^a-z0-9]+/));
      return terms.filter((term) => words.has(term)).length;
    };
    const groups = new Map<string, MemoryCandidate[]>();
    for (const candidate of feed) {
      if (candidate.role === 'rule') continue;
      const document = candidateDocument(candidate).document;
      const key = JSON.stringify([candidate.sourceId, candidate.sourceRevision, document]);
      const group = groups.get(key);
      if (group) group.push(candidate);
      else groups.set(key, [candidate]);
    }
    for (const group of groups.values()) {
      const first = group.reduce((best, candidate) => matches(candidate) > matches(best) ? candidate : best);
      for (const candidate of group) representatives.set(candidate, first);
    }
    await evaluate(feed.filter((c) => c.role === 'rule' || representatives.get(c) === c));
    if (signal.aborted) stop = 'cancelled';
    else if (Date.now() - started >= limits.maxElapsedMs) stop = 'time';
    if (!stop) {
      await evaluate(feed.filter((candidate) => {
        const representative = representatives.get(candidate);
        return representative !== undefined && representative !== candidate;
      }));
    }
  } else await evaluate(feed);

  // The reference bar may rise with the decided set's size, so the
  // selection pass runs once the whole feed has answered.
  const decided = feed.reduce((count, candidate) =>
    count + Number(candidate.role === 'reference' && combined.get(candidate)?.status === 'answered'), 0);
  const referenceBar = thresholds.referenceBySize === undefined
    ? thresholds.reference
    : sizeBar(thresholds.referenceBySize, decided);
  const appliedReference = thresholds.referenceBySize === undefined ? undefined : referenceBar;
  for (const candidate of feed) {
    // A failed decision batch leaves its candidates unanswered even
    // when an earlier batch answered some of their questions: a
    // verdict combined from a half-failed cascade is not a verdict.
    if (decideFailed.has(candidate)) {
      statuses.set(candidate, {
        status: 'unanswered', answer: 'error', detail: decideFailure!.message,
      });
      continue;
    }
    const held = curtailed.get(candidate);
    const answer = held === undefined ? combined.get(candidate) : undefined;
    if (held !== undefined || !answer) {
      statuses.set(candidate, { status: 'unassessed', reason: held ?? stop ?? 'limits' });
      continue;
    }
    if (answer.status === 'answered') {
      const threshold = candidate.role === 'rule' ? thresholds.rule : referenceBar;
      if (answer.probability >= threshold) {
        selected.push(candidate);
        statuses.set(candidate, { status: 'selected', asked: true, probability: answer.probability });
      } else statuses.set(candidate, { status: 'rejected', probability: answer.probability });
    } else statuses.set(candidate, { status: 'unanswered', answer: answer.status, detail: answer.detail });
  }
  for (const candidate of queue) {
    if (!statuses.has(candidate)) {
      statuses.set(candidate, { status: 'unassessed',
        reason: stop ?? 'limits' });
    }
  }

  // The changed-path link, one pass after the threshold pass: a
  // reference candidate that answered at or above the link bar (but below
  // the threshold) still passes when a selected commit from the same
  // repository changed the path it lives at. Only candidates the
  // threshold pass selected can carry a link, so a linked candidate can
  // never carry another; there is no recursion. The pass only adds: it never
  // demotes an ordinary selection and never lowers a threshold.
  const chosen = new Set(selected);
  for (const candidate of candidates) {
    const status = statuses.get(candidate)!;
    if (status.status !== 'rejected'
      || status.probability < thresholds.linkedPathBar
      || candidate.role !== 'reference'
      || candidate.path === undefined
      || candidate.repository === undefined) continue;
    const carrier = candidates.find((other) =>
      other !== candidate
      && other.role === 'reference'
      && chosen.has(other)
      && other.repository === candidate.repository
      && other.changedPaths?.includes(candidate.path!) === true);
    if (carrier === undefined) continue;
    selected.push(candidate);
    statuses.set(candidate, {
      status: 'selected',
      asked: true,
      probability: status.probability,
      link: { sourceId: carrier.sourceId, id: carrier.id },
    });
  }

  // Decision tags run on the kept references once relevance has
  // decided: they label the kept pieces for curation and never change
  // what is selected. They run under the same stopping dials, so a
  // stop can leave tag questions unasked; the record marks every
  // unasked tag question unassessed with the stop reason rather than
  // 'missing', which a returned-but-empty answer already means.
  const tagAnswers = new Map<MemoryCandidate, Map<string, CheckedAnswer>>();
  if (!stop && (options.tags?.length || options.tagsByKind !== undefined)) {
    const asks = selected.flatMap((candidate) => {
      if (candidate.role !== 'reference') return [];
      return tagSetsFor(candidate).flatMap((set) => set.questions.map((question) =>
        pending(candidate, { key: `${set.key}.${question.key}`, question: question.instructions,
          trueCriterion: question.true, falseCriterion: question.false }, set.key)));
    });
    await ask(asks, tagAnswers);
  }
  const recordedTags = (candidate: MemoryCandidate): PickRecordEntry['tags'] => {
    if (candidate.role !== 'reference' || statuses.get(candidate)?.status !== 'selected') return undefined;
    const sets = tagSetsFor(candidate);
    if (!sets.length) return undefined;
    const got = tagAnswers.get(candidate);
    const tags: Record<string, { value?: string; answers: ({ key: string } & PickAnswer)[] }> = {};
    for (const set of sets) {
      const answers: ({ key: string } & PickAnswer)[] = set.questions.map((question) => ({ key: question.key,
        ...(got?.get(`${set.key}.${question.key}`)
          ?? { status: 'unassessed' as const, ...(stop === undefined ? {} : { detail: stop }) }) }));
      // A set's value needs a clear answer: a lone-question set values
      // to yes/no at 0.5, and a larger set values to the first of its
      // questions answered at 0.5 or more — for a levelled set like
      // importance that is the highest recorded level. When every
      // answer is below 0.5 or missing, the value stays unset rather
      // than naming the least-bad key.
      const value = set.questions.length === 1
        ? (answers[0]!.status === 'answered' ? (answers[0]!.probability >= 0.5 ? 'yes' : 'no') : undefined)
        : answers.find((answer) => answer.status === 'answered' && answer.probability >= 0.5)?.key;
      tags[set.key] = { ...(value === undefined ? {} : { value }), answers };
    }
    return tags;
  };

  const top = new Set(feed.filter((candidate) => candidate.role === 'reference').slice(0, keepTop));
  const feedOrder = new Map(queue.map((candidate, index) => [candidate, index]));
  const weight = (candidate: MemoryCandidate) => {
    const status = statuses.get(candidate)!;
    const probability = status.status === 'selected' ? status.probability ?? 1 : 0;
    if (!options.rankProtection || candidate.role === 'rule') return probability;
    const rank = priority.get(candidate)! + 1;
    const w = rank <= 3 ? 0.75 : rank <= 10 ? 0.60 : 0.40;
    return w / rank + (1 - w) * probability;
  };
  selected.sort((a, b) => Number(b.role === 'rule') - Number(a.role === 'rule')
    || Number(top.has(b)) - Number(top.has(a)) || weight(b) - weight(a)
    || (feedOrder.get(a) ?? -1) - (feedOrder.get(b) ?? -1));

  const entries: PickRecordEntry[] = candidates.map((candidate) => {
    const cascade = cascadeFor(candidate);
    const status = statuses.get(candidate)!;
    const wasTruncated = truncated.get(candidate);
    const tags = recordedTags(candidate);
    const base = {
      sourceId: candidate.sourceId,
      sourceRevision: candidate.sourceRevision,
      id: candidate.id,
      role: candidate.role,
      ...(candidate.kind === undefined ? {} : { kind: candidate.kind }),
      priority: priority.get(candidate)!,
      signals: candidate.signals,
      ...(candidate.searchRanks === undefined ? {} : { searchRanks: candidate.searchRanks }),
      ...(options.rankProtection && candidate.role === 'reference' && status.status === 'selected'
        ? { orderScore: weight(candidate) } : {}),
      ...(representatives.has(candidate) ? { representative: representatives.get(candidate)!.id } : {}),
      ...(kindFor(candidate) === undefined ? {} : { sourceKind: kindFor(candidate) }),
      ...(candidate.contentRef === undefined ? {} : { contentRef: candidate.contentRef }),
      ...(candidate.changedPaths === undefined ? {} : { changedPaths: candidate.changedPaths }),
      ...(candidate.path === undefined ? {} : { path: candidate.path }),
      ...(candidate.repository === undefined ? {} : { repository: candidate.repository }),
      ...(wasTruncated === undefined ? {} : { truncated: wasTruncated }),
      ...(cascade && candidate.role === 'reference' && answered.has(candidate) ? {
        questions: cascade.questions.map((q) => ({ key: q.key, ...(answered.get(candidate)!.get(q.key) ?? { status: 'missing' as const }) })),
      } : {}),
      ...(tags === undefined ? {} : { tags }),
    };
    return status.status === 'unanswered'
      ? { ...base, status: 'unanswered', answer: status.answer, detail: status.detail }
      : { ...base, ...status };
  });
  const rulesCoverage = options.rulesEnumerationComplete === false
    || entries.some((entry) =>
      entry.role === 'rule' && (entry.status === 'unanswered' || entry.status === 'unassessed'))
    ? 'incomplete' as const
    : 'complete' as const;

  const record: PickRecord = {
    questionVersion: candidates.some((candidate) => candidate.kind !== undefined)
      ? 'memory-pick-questions-2' : PICK_QUESTION_VERSION,
    limits: recordedLimits,
    thresholds: { ...thresholds,
      ...(appliedReference === undefined ? {} : { appliedReference }) },
    ...(options.ranking === undefined ? {} : { ranking: options.ranking }),
    candidates: entries,
    rulesCoverage,
    ...(decideFailure === undefined ? {} : {
      decideError: { candidates: decideFailure.ids, message: decideFailure.message },
    }),
    ...(options.cascade === undefined ? {} : { cascade: options.cascade }),
    ...(options.cascadesByKind === undefined ? {} : { cascadesByKind: options.cascadesByKind }),
    ...(options.tags === undefined ? {} : { tags: options.tags }),
    ...(options.tagsByKind === undefined ? {} : { tagsByKind: options.tagsByKind }),
    ...((options.cascadesByKind === undefined && options.tagsByKind === undefined)
      || options.sourceKinds === undefined ? {} : { sourceKinds: options.sourceKinds }),
    ...(options.keepTop === undefined ? {} : { keepTop }),
    ...(options.rankProtection ? { rankProtection: true } : {}),
    ...(options.bestPartFirst ? { bestPartFirst: true } : {}),
  };
  if (decideFailure !== undefined) {
    throw new PickError(
      `The decide call failed for candidates ${decideFailure.ids.join(', ')}: ${decideFailure.message}`,
      record, { cause: decideFailure.error });
  }
  return { selected, record };
}
