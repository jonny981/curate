import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  LABEL_KINDS, LABEL_LANE_BAR, LABEL_PARTS_TASK, LABEL_QUESTION_VERSION,
  fuseLabelLane, labelFileStore, labelKey, labelKindsKey, labelPartQuestion, labelQuestionTask,
  labelTaskQuestion, storedLabels, type LabelKind, type PartLabels,
} from './labels.js';
import {
  decisionKey, levelDistribution, storedDecision, type DecisionStore,
} from './decisions.js';
import { judgmentFacts, judgmentPopulation, modelScore, type JudgmentPopulation } from './judgments.js';
import {
  ANSWER_TYPES, classifyTask, ROUTE_QUESTIONS, routeOptions, type AnswerType, type RouteKey, type RouteOption,
} from './task.js';
import type { LeverStates } from './levers.js';
import type { StoredIndexReport } from './stored-index.js';
import { WRITTEN_QUESTION_KEYS, checkCascade, checkPickOptions, checkWriteQuestions, findTaskNames } from './options.js';
import { datedIn, taskMoment, taskPeriod, timeZoneOf, zonedIso, type TaskPeriod } from './time.js';

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
  /** Zero-based rank within this source for each search line; null means absent. */
  readonly searchRanks?: readonly (number | null)[];
  /** True when the source supplies this part from its uncut pool only:
   *  it is not a member of any keyword lane, so lane eligibility skips
   *  it and only the label lane or the rare-word round can admit it to
   *  the decide step. With the gate off and a decide-feed dial on —
   *  `everyRanked: { c }` or `rare` — it only counts toward the
   *  history size and stays out of the feed and the record, unless the
   *  rare-word round pulls it in; with no dial it records 'unassessed'
   *  like any part no lane held. pickFromSources sets it for parts the
   *  lanes or the read limit dropped; a direct pick caller may set it
   *  the same way. A part that also carries `dateWindow` is admitted to
   *  the decide step as a lane member is. */
  readonly poolOnly?: boolean;
  /** 'task-period' when the part is dated inside the period the task
   *  names and no lane kept it: pickFromSources adds it beside the lane
   *  members, with `poolOnly`, and the pick admits it to the decide step
   *  as it admits a lane member, unless `taskPeriod` is false. */
  readonly dateWindow?: 'task-period';
  /** Transcript metadata; separate from the candidate's reference role. */
  readonly chat?: {
    readonly provider: 'claude-code' | 'codex';
    readonly sessionId: string;
    readonly role: 'user' | 'assistant' | 'tool-call' | 'tool-result';
    /** Who wrote the part, where the transcript says; 'unmarked' where it does not. */
    readonly author?: 'person' | 'agent' | 'tool' | 'system' | 'unmarked';
    /** The agent's name or id, when the transcript gives one. */
    readonly authorName?: string;
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
  /** True when a read with `wholeLanes` on returned this part although
   *  the lane cut would have dropped it in every lane that holds it.
   *  Only a read with `wholeLanes` on sets it. */
  readonly pastLaneCut?: true;
  /** The part's best similarity over the read's meaning queries: the
   *  highest cosine score any meaning lane gave it, kept for the fused
   *  order the decide step reads. Set by `addMeaningRanks` for a
   *  part a meaning lane kept, by `readSearches` merging a reader's own
   *  meaning lanes, or by a caller that scores its candidates itself. */
  readonly meaningScore?: number;
  readonly applies?: 'always';
}

export interface PickQuestion {
  readonly key: string;
  /** The fitted question's name, when the part's source carries a question set. */
  readonly questionKey?: string;
  /** The tag set this question belongs to, for a tag question. */
  readonly tagSet?: string;
  readonly date?: MemoryCandidate['date'];
  readonly role: MemoryCandidateRole;
  readonly kind?: MemoryKind;
  readonly question: string;
  /** The yes side's criterion; a levelled question carries `levels` instead. */
  readonly trueCriterion?: string;
  readonly falseCriterion?: string;
  /** A levelled question's ordered levels, lowest first. */
  readonly levels?: readonly string[];
  /** Render the item as a date and its text only, keeping its id,
   *  title and other identifying fields out of the model request. */
  readonly anonymous?: boolean;
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
  | { readonly status: 'answered'; readonly probability: number;
      /** The sent item text had to be cut for the model to answer. */
      readonly truncated?: boolean }
  | { readonly status: 'answered';
      /** A levelled question's answers: one probability per level, in
       *  level order, adding to one. */
      readonly probabilities: readonly number[];
      readonly truncated?: boolean }
  | { readonly status: 'refused' | 'missing' | 'error'; readonly detail?: string;
      readonly truncated?: boolean }
  /** The question was never asked: a stopping dial ended the run first.
   *  Recorded for tag and route questions; a decide reply cannot produce it. */
  | { readonly status: 'unassessed'; readonly detail?: string; readonly truncated?: boolean };

export type PickDecide = ((
  batch: PickBatch,
  signal: AbortSignal,
) => Promise<Record<string, PickAnswer>>) & {
  /** Stable model and prompt identity for stored labels. */
  readonly deciderId?: string;
};

/** Label storage settings. Each source supplies its own kind questions;
 *  unchanged text and kind definitions reuse their saved answers. */
export interface PickLabels {
  /** The plain-file store: one JSON file per labelled item under this
   *  directory, each written to a temporary file and renamed into
   *  place. A missing, corrupt or wrong-shaped entry is a miss.
   *  Defaults to `$XDG_CACHE_HOME/curate/labels`, or
   *  `~/.cache/curate/labels` when XDG_CACHE_HOME is unset. */
  readonly directory?: string;
  /** The caller's name for its decide route: the model, prompt build
   *  or plan the labels were answered with. Mixed into every store
   *  key, so a different deciderId never reuses stored labels.
   *  Defaults to decide.deciderId, then 'custom'. Give different
   *  handwritten deciders different ids. */
  readonly deciderId?: string;
  /** The kind question-set's version, mixed into every key and
   *  recorded; defaults to the package's own. A different version
   *  never reuses stored labels. */
  readonly questionVersion?: string;
}

/** The decision cache's settings, off by default. It stores each
 *  answered decide response once per part question and reuses it on a
 *  later pick whose key matches: the key covers the task text, the
 *  question-set version, the rendered question's wording and criteria
 *  and its `questionKey` and `tagSet` when it carries them, the
 *  caller's `deciderId`, and every field of the part the decider
 *  receives: its source id, id, title, role, kind and date, the
 *  decision text cut and the part's text, a change past the cut
 *  included. Because the key names the part, not the batch it rode
 *  in, an unchanged part's answer is reused across batches — a pick
 *  with new or changed parts asks the decider only about the parts
 *  that missed. */
export interface PickCache {
  /** The answer store: `get(key)` returns the stored value or throws
   *  or returns anything else for a miss, `set(key, value)` writes it.
   *  `decisionFileStore(directory)` supplies the plain-file default. A
   *  failed read is a miss; a failed write keeps the decider's answer
   *  and the record warns once. */
  readonly store: DecisionStore;
  /** The caller's name for its decide route: the model, prompt build
   *  or plan the answers came from. Mixed into every key, so a
   *  different deciderId never reuses a stored answer. Required. */
  readonly deciderId: string;
  /** The question-set version mixed into every key; defaults to
   *  `PICK_QUESTION_VERSION`, the same for every part however the
   *  candidate list is made up, so an added part can never stale an
   *  unchanged part's key. A different version never reuses a stored
   *  answer. */
  readonly questionVersion?: string;
}

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
  /** The most decision requests of one round in flight at once: the
   *  independent batches of a round dispatch together up to this many
   *  and the rest go out in dispatch order as earlier replies land.
   *  Omitted means every batch of a round goes out at once. */
  readonly maxInFlight?: number;
}

export interface PickThresholds {
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
      /** True when every answer behind the verdict came from the
       *  decision cache. */
      readonly reused?: boolean;
      /** Present when the changed-path link, not the threshold, carried
       *  the candidate over: the selected candidate whose changedPaths
       *  named this candidate's path. An entry that passed on threshold
       *  alone carries none. */
      readonly link?: { readonly sourceId: string; readonly id: string };
      /** Present when a typed question's `keepAt`, not the bar, kept
       *  the part: that typed question's key. */
      readonly keptBy?: string;
    }
  | {
      readonly status: 'rejected';
      readonly probability: number;
      /** True when every answer behind the verdict came from the
       *  decision cache. */
      readonly reused?: boolean;
    }
  | {
      readonly status: 'unanswered';
      readonly answer: 'refused' | 'missing' | 'error';
      readonly detail?: string;
    }
  | { readonly status: 'unassessed';
      /** Why no decide question was asked: a stopping dial ('limits',
       *  'time', 'cancelled', 'error'), the scaled top-k cut ('pick'),
       *  the rating stop ('stopWhenCold': the part sat in the fused
       *  order below where the ratings went cold), the fused order's
       *  reach ('feed': the part sat past the caller's `feed.size`, or
       *  no search lane placed it in the order), or 'gate': with the
       *  label gate on, a reference part the
       *  keyword lanes never held whose stored or answered labels
       *  cleared no needed kind. A part a lane limit cut or a stop
       *  left unlabelled keeps that reason instead. */
      readonly reason: 'limits' | 'time' | 'cancelled' | 'document' | 'error' | 'gate' | 'pick' | 'stopWhenCold' | 'feed' };

export type PickRecordEntry = {
  readonly sourceId: string;
  readonly sourceRevision?: string;
  readonly id: string;
  readonly role: MemoryCandidateRole;
  readonly kind?: MemoryKind;
  readonly priority: number;
  readonly searchRanks?: readonly (number | null)[];
  /** Echoed from the input: the part came from the uncut pool and holds
   *  no lane membership, so only the label lane, the task's period or
   *  the rare-word round could admit it. */
  readonly poolOnly?: boolean;
  /** Echoed from the input: the part reached the pick through the
   *  task's period, not a lane. */
  readonly dateWindow?: 'task-period';
  /** Echoed from the input: a read with `wholeLanes` on returned the
   *  part although the lane cut would have dropped it. */
  readonly pastLaneCut?: true;
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
  /** Individual fitted answers, before combining them. `reused` marks
   *  an answer the decision cache supplied instead of a decide call. */
  readonly questions?: readonly ({ readonly key: string; readonly reused?: boolean } & PickAnswer)[];
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
    readonly answers: readonly ({ readonly key: string; readonly reused?: boolean } & PickAnswer)[];
  }>>;
} & PickEntryStatus;

export interface PickCriterion {
  readonly key: string;
  readonly instructions: string;
  readonly true: string;
  readonly false: string;
}

/** A narrow question answered on an ordered level scale instead of
 *  yes/no. Only a model-scored set may carry one. */
export interface PickScoreCriterion {
  readonly key: string;
  readonly instructions: string;
  /** The ordered levels, lowest first. */
  readonly levels: readonly string[];
}

/** The fitted constants a model-scored set combines through: the
 *  feature or question keys in order, each value's fitted centre and
 *  spread, the weights, the intercept, and the selection bar the fit
 *  kept. Order is positional: `keys[index]` names the value slot
 *  `index` reads. A missing or nonfinite value is imputed at its mu. */
export interface PickCascadeModel {
  readonly keys: readonly string[];
  readonly mu: readonly number[];
  readonly sd: readonly number[];
  readonly w: readonly number[];
  readonly b: number;
  readonly bar?: number;
  /** What the fit measured, as recorded beside its constants; the
   *  score never reads it. */
  readonly provenance?: unknown;
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
  /** The linear combine's intercept; a model-scored set needs none. */
  readonly bias?: number;
  readonly questions: readonly ((PickCriterion | PickScoreCriterion) & { readonly weight?: number })[];
  /** Questions asked of a part only when the task needs their answer type. */
  readonly typed?: readonly (PickCriterion & {
    readonly answerType: AnswerType;
    readonly weight: number;
    /** A part whose answer reaches this is kept, whatever its combined score. */
    readonly keepAt?: number;
  })[];
  readonly first?: string;
  readonly band?: readonly [number, number];
  readonly firstOnly?: { readonly bias: number; readonly weight: number };
  /** Weights for the questions `writeQuestions` writes for the task:
   *  `highest` × logit(best written answer) + `second` ×
   *  logit(second-best written answer) join the score. Each answer is
   *  clamped to 0.0001 to 0.9999 first. With a first question and a
   *  band, written questions are asked only of parts whose first answer
   *  is inside the band. */
  readonly written?: { readonly highest: number; readonly second: number };
  /** A question asked once per name the task names, of each reference
   *  part, in the same request as the set's other questions. Its key,
   *  followed by the name's place in the list from 1, keys each
   *  answer. With a first question and a band, it is asked only of
   *  parts whose first answer is inside the band. A task with no names
   *  asks it of no part and adds neither term. */
  readonly named?: {
    /** Asked once per name; {name} is replaced. */
    readonly question: PickCriterion;
    /** Weight on logit(the highest answer across the task's names). */
    readonly highest: number;
    /** Added when the task has at least one name. */
    readonly hasNames: number;
  };
  /** A fitted combining model: the answers and the code facts Curate
   *  computes per part score through its weights instead of the
   *  per-question weights. A set carrying one selects no first, band,
   *  firstOnly, typed, written or named machinery, and only its set
   *  may hold levelled questions. */
  readonly model?: PickCascadeModel;
  /** Render each item as a date and its text only: the model never
   *  sees the part's id, title or other identifying fields. */
  readonly anonymousItems?: boolean;
}

/** What one setting did in one pick, for one source. */
export interface PickSettingEffect {
  /** The setting's name as a caller writes it: 'labels', 'rare', 'bar', 'ruleBar', 'searchLines',
   *  'searchPhrases', 'meaning', 'names', 'wholeLanes', 'linkedPathBar', 'everyScored', 'everyRanked', 'typed',
   *  'taskPeriod', 'written', 'named', 'decay', 'feed' or 'stopWhenCold'.
   *  'alwaysOnSkipped' is no setting: it reports the always-on files a rule read skipped. */
  readonly setting: string;
  /** The source the counts are for. A setting given for the whole call gets one entry per source. */
  readonly source: string;
  /** Parts the setting looked at; for 'alwaysOnSkipped', the files skipped. */
  readonly actedOn: number;
  /** Kept parts that are kept only because of this setting. */
  readonly added: number;
  /** Parts kept out only because of this setting; null when one pick cannot tell. */
  readonly dropped: number | null;
  /** One plain sentence. */
  readonly summary: string;
}

/** Where a source's read found its parts: the read request option each
 *  `searchRanks` position came from, 'task' for the task's own keyword
 *  lane. */
export type SearchLaneOrigin = 'task' | 'searchLines' | 'searchPhrases' | 'kindLanes' | 'meaning' | 'names';

/** How one source was read, for the record's `effects`. */
export interface PickSourceRead {
  /** The option each `searchRanks` position came from, in position order. */
  readonly lanes: readonly SearchLaneOrigin[];
  /** The extra-lane options the read request gave with a non-blank
   *  entry, and 'names' when the source's `names` setting is on,
   *  whether or not each opened a lane: a search line that repeats the
   *  task opens none. Defaults to those `lanes` names. */
  readonly given?: readonly ('searchLines' | 'searchPhrases' | 'meaning' | 'names')[];
  /** The read kept whole lanes (`wholeLanes` on the read request). */
  readonly wholeLanes: boolean;
  /** Files the read skipped because the agent's harness loads them every session itself. */
  readonly alwaysOnSkipped?: readonly { readonly file: string; readonly reason: string }[];
}

export interface PickRecord {
  /** The moment the pick measured dates from, as an ISO date-time in
   *  `timeZone`: the task date, or now when none was given. Pass it back
   *  as `taskDate` with the same `timeZone` to replay the pick. `pick`
   *  writes it on every record. */
  readonly asOf?: string;
  /** The time zone the pick read dates in. `pick` writes it on every record. */
  readonly timeZone?: string;
  /** The period the task names, when `taskPeriod` was on and the task
   *  named one. */
  readonly taskPeriod?: TaskPeriod;
  /** Applied label definitions by source identity; [] means no label work. */
  readonly labelKindsBySource?: Readonly<Record<string, readonly LabelKind[]>>;
  readonly ranking?: PickOptions['ranking'];
  readonly questionVersion: string;
  readonly limits: PickLimits;
  /** The bars each source's parts were cut at live on
   *  `levers.sources`; these are the bars for the whole call. */
  readonly thresholds: {
    readonly linkedPathBar: number;
    /** The size curve `everyScored: { bySize }` supplied, sorted. */
    readonly referenceBySize?: readonly (readonly [number, number])[];
    /** The bar `referenceBySize` produced for this set's size. */
    readonly appliedReference?: number;
  };
  /** Every lever's state as resolved, with the settings each source ran
   *  with under `sources`. `wholeLanes` lives on the read request, so only a record
   *  pickFromSources produced carries it. `route` records the
   *  questions asked. */
  readonly levers: LeverStates;
  readonly candidates: readonly PickRecordEntry[];
  /** Present when pickFromSources only sized a history for the fused
   *  order: by source ID, how many of its parts no lane kept.
   *  They are counted here, not recorded one by one in `candidates`, and
   *  none of them could reach the decide step. */
  readonly unheld?: Readonly<Record<string, number>>;
  readonly rulesCoverage: 'complete' | 'incomplete';
  /** Present when a decide call rejected its batch and ended the pick:
   *  the batch's candidate ids and the error's message. The pick fails
   *  with a PickError carrying this record; a failed decision batch
   *  leaves its candidates unanswered and everything still unasked is
   *  unassessed. A failed tag batch leaves a decided selection standing
   *  and records the error on the tag's answers, since tags never
   *  change what is selected. */
  readonly decideError?: { readonly candidates: readonly string[]; readonly message: string };
  /** Source identities mapped to kinds, recorded when `tagsByKind` is given. */
  readonly sourceKinds?: Readonly<Record<string, CandidateSourceKind>>;
  readonly keepTop?: number;
  readonly rankProtection?: boolean;
  readonly bestPartFirst?: boolean;
  /** Present when the label gate ran: its question-set version, the
   *  caller's deciderId, how many items' labels the decide port was
   *  asked for this pick, how many were reused from the store, and the
   *  gate's admitted size — how many candidates its merged ranking
   *  holds before the scaled top-k cut, so a part the gate admitted
   *  can still record 'unassessed' with reason 'pick'.
   *  `failedWrites` counts label sets the store could not write; this
   *  pick still used them, and when it is above 0, `warning` says so
   *  once. A reference part the keyword lanes never held, left out on its
   *  stored or answered labels, records 'unassessed' with reason
   *  'gate'; a part a lane limit cut or a stop left unlabelled keeps
   *  that reason instead. */
  readonly labels?: {
    readonly questionVersion: string;
    readonly deciderId: string;
    readonly asked: number;
    readonly reused: number;
    /** Parts whose labels came from another pick in this process that
     *  was asking for them at the same time. Absent when 0. */
    readonly waited?: number;
    readonly gate: number;
    readonly failedWrites: number;
    readonly warning?: string;
  };
  /** Present when a decision cache ran: the question-set version and
   *  the caller's deciderId its keys carried, how many decision and
   *  tag questions the decide port was asked this pick, how many
   *  answers the store supplied instead, and how many answers the
   *  store could not write (`failedWrites`; when it is above 0,
   *  `warning` says so once — the pick still used those answers, and
   *  the next pick asks for them again). Label questions go through
   *  the same port but are not counted here: `labels.asked` counts
   *  each asked item once, and an item asked sends one question per
   *  label kind. */
  readonly cache?: {
    readonly questionVersion: string;
    readonly deciderId: string;
    readonly asked: number;
    readonly reused: number;
    readonly failedWrites: number;
    readonly warning?: string;
  };
  /** Present when `route: 'jev'` asked the four route questions of the
   *  task: the answers, and the curator options they switch on at the
   *  shared label bar — 'taste' switches on 'preferenceAdvice' and
   *  'preferenceChange', and 'count', 'date' and 'latest' switch on
   *  'working'. A route
   *  question a stop left unasked records 'unassessed' with the stop
   *  reason. */
  readonly route?: {
    readonly answers: readonly ({ readonly key: RouteKey } & PickAnswer)[];
    readonly on: readonly RouteOption[];
  };
  /** Present when `answerTypes` asked the ten questions in
   *  `ANSWER_TYPES` of the task: the bar, every answer, and the types
   *  that cleared it. An answer a stop left unasked records
   *  'unassessed' with the stop reason. */
  readonly answerTypes?: {
    readonly bar: number;
    readonly answers: readonly ({ readonly key: AnswerType } & PickAnswer)[];
    /** Types answered at or above the bar, in ANSWER_TYPES order. */
    readonly needed: readonly AnswerType[];
  };
  /** Present when `writeQuestions` ran: the questions it wrote for the
   *  task, keyed `task1` to `task4`. */
  readonly writtenQuestions?: { readonly questions: readonly PickCriterion[] };
  /** Present when the pick looked for the names the task names: when a
   *  source's `names` setting is on or a source's question set has
   *  `named`. `by` is 'caller' when `findNames` found them, 'code' when
   *  `taskNames` did. */
  readonly names?: { readonly found: readonly string[]; readonly by: 'code' | 'caller' };
  /** Present when pickFromSources read a source from its stored index:
   *  by source id, the parts in the file, the parts written and deleted
   *  this call, whether the file was built again and the milliseconds
   *  the update took. */
  readonly index?: Readonly<Record<string, StoredIndexReport>>;
  /** Present on every pick: the history's size N in reference parts
   *  (every reference part the pick received, including pool members
   *  the keyword lanes never held), how many of the feed's reference
   *  parts went on to the decide step, and which ranking the decide
   *  step read: 'fusion' when the label gate fused its lane into the
   *  keyword order or the fused order ran (`everyRanked` unset),
   *  'keyword' otherwise.
   *  `c` is the supplied top-k coefficient, present only when the cut
   *  ran; candidates the cut dropped record 'unassessed' with reason
   *  'pick'. Rules never count toward N or the keep count and are
   *  never cut.
   *  `rare` is present when the rare-word round ran: the share and bar
   *  it used, the rare words the parts that cleared the selection bar
   *  contributed, the parts those words pulled in, and how many of them
   *  the decide step was asked about and how many joined the
   *  selection. */
  readonly pick?: {
    readonly n: number;
    /** The parts the decide port was asked at least one task question
     *  about this pick, every round included. An answer the decision
     *  cache supplied does not count. */
    readonly sent: number;
    /** The task questions sent to the decide port this pick, every
     *  round included: the slots a priced decider bills for. Label
     *  questions keep their own count on `labels`. */
    readonly questions: number;
    readonly c?: number;
    readonly kept: number;
    /** Present when the `feed` option was given: the order the feed
     *  was cut in, the size given (absent when none was), and how many
     *  ranked reference parts the size left unjudged. */
    readonly feed?: { readonly order: 'combsum'; readonly size?: number; readonly unjudged: number };
    /** Present when the rating stop read the fused order: the floor
     *  and share it tested with, the waves of decision requests the
     *  read sent, the batches of the order it rated, the parts of the
     *  order it rated, the parts of the order it never rated, the rated
     *  parts at or above their keep bar, and what ended the read: 'order' when it reached the order's end, 'cold'
     *  when the ratings went cold, or the stopping dial that ended it
     *  first ('limits', 'time', 'cancelled', 'error'). `cold` is
     *  present when the ratings went cold: the batch, counted from 1
     *  down the order, whose best rating failed a test, that best
     *  rating, the best rating of every batch before it, and the test
     *  it failed. The rest of that batch's wave was already sent, so
     *  `batches` can pass `cold.batch` by the rest of one wave. */
    readonly stopWhenCold?: {
      readonly floor: number;
      readonly share: number;
      readonly waves: number;
      readonly batches: number;
      readonly rated: number;
      readonly unread: number;
      readonly kept: number;
      readonly ended: 'order' | 'cold' | 'limits' | 'time' | 'cancelled' | 'error';
      readonly cold?: {
        readonly batch: number;
        readonly best: number;
        readonly bestBefore: number;
        readonly under: 'floor' | 'share';
      };
    };
    readonly ranking: 'keyword' | 'fusion';
    readonly rare?: {
      readonly share: number;
      readonly bar: number;
      /** Each source the round ran on, by source id: its reference
       *  count N, which sets its bound, and the rare words its selected
       *  parts contributed. */
      readonly sources: Readonly<Record<string, { readonly n: number; readonly words: readonly string[] }>>;
      readonly pulled: readonly { readonly sourceId: string; readonly id: string }[];
      readonly asked: number;
      readonly added: number;
    };
  };
  /** The tag sets every kept reference answered, when supplied. */
  readonly tags?: readonly PickTagSet[];
  /** Extra tag sets asked only of references from that source kind. */
  readonly tagsByKind?: Readonly<Partial<Record<CandidateSourceKind, readonly PickTagSet[]>>>;
  /** What each setting that was on did, one entry per source it
   *  applied to, counted from this pick alone. A setting that was off
   *  has no entry. */
  readonly effects: readonly PickSettingEffect[];
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
  /** Label kinds by source identity. Missing identities have no label lane.
   *  pickFromSources fills this from each reader's labelKinds. */
  readonly labelKindsBySource?: Readonly<Record<string, readonly LabelKind[]>>;
  /** Each source's label bar, from 0 to 1, by source ID: the bar for
   *  which label kinds the task needs for that source and which of its
   *  parts join the label lane. Omitted sources use LABEL_LANE_BAR,
   *  0.5. pickFromSources fills this from each source's `labelBar`. */
  readonly labelBarBySource?: Readonly<Record<string, number>>;
  /** Signal weights by Markdown kind; omitted weights remain 1. */
  readonly ranking?: Partial<Record<MemoryKind, Readonly<Record<string, number>>>>;
  readonly task: string;
  readonly decide: PickDecide;
  /** The decision questions asked of each source's reference parts, by
   *  source ID. A source without a set asks the built-in question for
   *  the part's kind; rule parts keep their applicability question.
   *  pickFromSources fills these from each source's `questions`. */
  readonly questionsBySource?: Readonly<Record<string, PickCascade>>;
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
  /** Add reference parts to the decide step, off by default:
   *  the union of the keyword lanes and a label lane. The label lane
   *  holds the parts labelled at their source's label bar or more on a
   *  kind of statement the question needs at that bar, ordered by that
   *  probability, merged with the keyword lanes by rank through
   *  reciprocal-rank fusion; the bar is `labelBarBySource`, 0.5 by
   *  default. A source's kind questions are asked through the decide port
   *  of its reference parts and once of the task per kind set, batched as decision
   *  batches are — the task's own ask packs into one request instead
   *  when `route` is on — and each item's set is stored once in `directory`
   *  keyed by the kind definitions, question-set version, `deciderId` and the item's
   *  text. Through `pickFromSources` the gate labels the source's full
   *  uncut search pool, so a part the keyword lanes dropped can still
   *  reach the decide step; through `pick` directly `labelKindsBySource`
   *  supplies the kinds. A source without kinds gets no label questions.
   *  Label batches count against
   *  `maxBatches` and `maxElapsedMs`, and a stop while labelling leaves
   *  the decide step unasked. The label lane is not capped by
   *  `maxCandidates`: every part in it reaches the decide step unless
   *  the scaled top-k dial caps the merged ranking. The gate runs when a
   *  source carries label kinds; `labels` only sets where labels are
   *  stored and the decider identity they are keyed by, with defaults
   *  for both. */
  readonly labels?: PickLabels;
  /** The decision cache, off by default: each answered decide response
   *  is stored once under a key naming the exact part question it
   *  answers, and a later pick reuses it instead of asking the decider
   *  again — across batches, since the key names the part and not the
   *  batch around it. Decide and tag questions go through it; label
   *  questions keep their own store. Only an `answered` result with a
   *  finite probability is stored; a failed read is a miss and a failed
   *  write keeps the answer with one warning in `record.cache`. The
   *  reads stand under the same stopping dials as the decide batches:
   *  a cancelled signal or an elapsed limit ends them, and a stop
   *  leaves every question not yet resolved unassessed with the
   *  stop's reason. Pass `false` to bypass a configured cache for one
   *  call: no reads and no writes. With `cache` unset the output is
   *  identical to a pick without it. */
  readonly cache?: PickCache | false;
  /** Ask the four route questions in `ROUTE_QUESTIONS` of the task once
   *  per pick, through the decide port — in the same request as the
   *  task's kind labels when the label gate asks them, alone otherwise,
   *  and always as one request whatever the request-size dials allow.
   *  `record.route` carries the answers and the curator options each
   *  'yes' at the shared label bar switches on. Off by default. */
  readonly route?: 'jev';
  /** Ask the ten questions in `ANSWER_TYPES` of the task once per pick,
   *  through the decide port, in the same request as the task's kind
   *  labels or the route questions when either asks the task, alone
   *  otherwise. `true` uses a bar of 0.5; `{ bar }` sets it. A type
   *  answered at or above the bar is needed: `record.answerTypes`
   *  lists the needed types, each source's typed questions for them are
   *  asked of its reference parts. Off by default. */
  readonly answerTypes?: boolean | { readonly bar: number };
  /** Write two to four questions for the task, once per pick, before any
   *  decide request. Curate keys them `task1` to `task4` and asks them
   *  of the reference parts of each source whose question set has
   *  `written` weights. A writer that throws, or returns anything but 2
   *  to 4 questions each with nonempty `instructions`, `true` and
   *  `false`, stops the pick. `taskQuestionWriter(write)` builds one.
   *  Off by default. */
  readonly writeQuestions?: (task: string, signal?: AbortSignal) => Promise<readonly PickCriterion[]>;
  /** Find the names the task names, in place of `taskNames`, for this
   *  call: a small model can do it. Called once per pick, and only when
   *  a source's `names` setting is on or a source's question set has
   *  `named`. A function that throws, or returns anything but an array
   *  of strings, stops the pick. Curate ships no model for it. */
  readonly findNames?: (task: string) => Promise<readonly string[]>;
  /** Read every ranked part. Unset, the decide step reads the whole
   *  fused order instead, and passing `stopWhenCold` or `feed` with it
   *  throws a TypeError before any read. `{ c }` keeps only the top
   *  `round(c × N^0.8)` reference parts of the
   *  ranking the decide step reads — the label gate's fused order when
   *  the gate fused its lane into the keyword lanes', the keyword order
   *  otherwise — where N is the number of reference parts the pick
   *  received, the history. Through pickFromSources the read carries
   *  the source's full uncut pool, so lane cuts and read limits do not
   *  shrink it; a pool member counts toward N but reaches the feed only
   *  through the label gate or the rare-word round, and with the gate
   *  off it stays out of the record unless the rare-word round pulls it
   *  in. Rules pass through uncounted and uncut. Off caps how many
   *  parts are decided, so decision work grows sublinearly with the
   *  history's size instead of with the whole ranking. `c` must be a
   *  positive finite number, checked before any decide call. The
   *  record's `pick` field keeps N, c, the kept count and which ranking
   *  was cut; dropped candidates record 'unassessed' with reason
   *  'pick'. */
  readonly everyRanked?: true | { readonly c: number };
  /** The rating stop, off unless set: how far down the fused order
   *  the decide step reads. Unset or `false`, it rates every part of
   *  the order, so a call's cost grows with the parts the search lanes
   *  keep. The fused order spans the sources: a part's place is the
   *  better of its best keyword lane's share of that lane (a keyword
   *  lane is one `searchRanks` index across every source) and its
   *  position in the history's own best-similarity ranking; the task's
   *  period and the label lane are members of the order too. With the
   *  stop set (`{}` takes both defaults), the decide step reads the
   *  order in the request-sized batches the limits form, two batches a
   *  wave, and after each wave checks the wave's batches in order: the
   *  read stops at the first batch whose best decision score is under
   *  `floor` (default 0.1), or under `share` (default 0.2) times the
   *  best score of every batch before it. It never stops before the
   *  read has kept a reference part on the bar the selection keeps it
   *  at, whatever sets that bar, so a question the history
   *  holds nothing for reads the whole order even with the stop set.
   *  The rest of that wave is rated and kept as usual; a part below
   *  the stop is never asked by the read and records 'unassessed' with
   *  reason 'stopWhenCold'. A higher floor or share stops sooner and
   *  spends less; a lower one reads further and finds more. It applies
   *  only when `everyRanked`
   *  is not given (passing both throws a TypeError). On three
   *  benchmarks' saved ratings the defaults rated 64% (LoCoMo), 55%
   *  (DolphinBench) and 83% (BEAM) of the parts the runs rated and
   *  kept 98.5%, 95.2% and 100% of the evidence they found. On the
   *  published LoCoMo and LongMemEval runs they cost about 5 to 12 of
   *  LoCoMo's 1,540 right answers and stayed inside the noise on
   *  LongMemEval, for $0.0012 and $0.0067 saved a question. */
  readonly stopWhenCold?: false | {
    /** Stop when a batch's best decision score is under this. */
    readonly floor?: number;
    /** Or under this share of the best score of every batch before it. */
    readonly share?: number;
  };
  /** Off unless set. Which reference parts of the fused order the
   *  decide step is asked about, and how many.
   *  `order: 'combsum'` orders the fused order by the SUM of a part's lane
   *  places in place of its best place, which favours a part several
   *  search lanes agree on over a part one lane placed high. A keyword
   *  lane's place is the part's share of that lane across every
   *  source; a meaning lane's place is its share among its own
   *  source's members of that lane; a names lane adds nothing. Equal
   *  sums keep the queue's order, as equal places do by default.
   *  `size` is the most reference parts fed: a rating stop reads
   *  inside it and can end the read sooner; unset, the whole order is
   *  fed. A shorter feed costs fewer decision questions and judges
   *  fewer parts: a part the default order would have fed can go
   *  unjudged. A part the size leaves out records 'unassessed' with
   *  reason 'feed', and the record's `pick.feed` keeps the order, the
   *  size and the count left unjudged. Rules are never cut. Passing
   *  `feed` with `everyRanked` throws a TypeError before any read. */
  readonly feed?: { readonly order: 'combsum'; readonly size?: number };
  /** The decision-score bars for every source at once, in place of
   *  each source's own `bar` (`barBySource`). Unset, each source's bar
   *  applies. Keep every scored part with true. `{ bar }` cuts references
   *  the decision model scored below that flat decision bar;
   *  `{ bySize }` cuts below a bar that rises with the
   *  answered-reference count, as [count, bar] points in size order —
   *  below the first point the first bar applies, above the last the
   *  last bar applies, between two points the bar moves linearly, and
   *  the recorded `appliedReference` is the bar used. Point positions
   *  are a measurement question, not a guess: choose them against the
   *  history the funnel will read. Off sends fewer parts to the
   *  curator. */
  readonly everyScored?: true | {
    readonly bar?: number;
    readonly bySize?: readonly (readonly [number, number])[];
  };
  /** The rare-word round: a second, narrow pass after
   *  the selection pass, run within each enabled source on its own. The
   *  words of a source's parts that cleared the selection bar are kept
   *  to the rare ones, rare meaning a document frequency over that
   *  source's reference parts of at most `share` × N, N that source's
   *  reference count (default 5/850, the count of 5 fitted on an
   *  850-part history). On a source under 340 parts the default share
   *  can pull nothing: a word a part shares appears in at least 2
   *  parts, and 5/850 × N stays below 2. Every unselected part of that
   *  source sharing one of its rare words is
   *  pulled in, pool members included: one never asked goes through
   *  the decide step, one already decided reuses its score, and a part
   *  scoring at or above `bar` joins the selection. Under the rating
   *  stop the round reads the parts it asks in fused order, two batches
   *  at a time, with a best score of its own, and ends when they go
   *  cold. `bar` is a second,
   *  lower bar than the selection bar (default 0.0146); the seeds keep
   *  their source's own bar. `true` runs the defaults on every source,
   *  an object supplies them. Omit it to use rareBySource, or false to
   *  disable every source. The record's `pick.rare` lists each source's
   *  N and rare words, the parts pulled in, and how many were asked and
   *  added. */
  readonly rare?: boolean | { readonly share?: number; readonly bar?: number };
  /** Reader defaults keyed by source ID; omitted sources are off.
   *  pickFromSources supplies these. An explicit rare option overrides them. */
  readonly rareBySource?: Readonly<Record<string, boolean>>;
  /** Each source's decision-score bar for its reference parts, by
   *  source ID: a part scored at or above it is kept. Omitted sources
   *  use 0.0146. pickFromSources supplies these from each source's
   *  `bar`; `everyScored` overrides them. */
  readonly barBySource?: Readonly<Record<string, number>>;
  /** Each source's bar for its rule parts, by source ID; omitted
   *  sources keep every scored rule. pickFromSources supplies these
   *  from each source's `ruleBar`. */
  readonly ruleBarBySource?: Readonly<Record<string, number>>;
  /** False when a source that can supply rule candidates did not finish
   *  enumerating them; its read returned `complete: false`. The combined
   *  coverage can then never report a complete applicable-rule set, even
   *  when every rule supplied was answered. Defaults to true. */
  readonly rulesEnumerationComplete?: boolean;
  /** How each source was read, by source ID: the read request option
   *  each `searchRanks` position came from and whether the read kept
   *  whole lanes. Only the record's `effects` reads it; a source
   *  without an entry has no extra-lane or `wholeLanes` entries there.
   *  pickFromSources supplies these. */
  readonly readsBySource?: Readonly<Record<string, PickSourceRead>>;
  /** Internal to pickFromSources: each history it only sized for the
   *  fused order, by source ID: how many distinct parts it holds,
   *  the candidates given and the parts no lane kept, which are not
   *  given. The fused order places meaning against the whole history,
   *  and the record counts the parts not given in `unheld`. */
  readonly historySizeBySource?: Readonly<Record<string, number>>;
  readonly limits?: PickLimits;
  readonly thresholds?: PickThresholds;
  /** The task's date, as the read request's `taskDate` takes it: the
   *  moment the record's `asOf` names and the task's period counts
   *  from. Absent means now. pickFromSources fills it from the read
   *  request. */
  readonly taskDate?: string;
  /** The IANA time zone dates are read in; absent means the system's
   *  own. pickFromSources fills it from the read request. */
  readonly timeZone?: string;
  /** Let the parts dated inside the period the task names reach the
   *  decide step, on by default. It acts only when the task names a
   *  period (see `taskPeriod()`): pickFromSources then reads the parts
   *  from that period of every source but a rule source, and the pick
   *  admits the ones no lane kept (`dateWindow`). Nothing is removed for its date. `false`
   *  turns it off. */
  readonly taskPeriod?: boolean;
  readonly signal?: AbortSignal;
}

/** The rating stop's floor and share when a call sets it without
 *  them. On a free replay of saved ratings from three benchmarks, 0.2
 *  was the cheapest of 80 rules that kept at least 98% of the evidence
 *  the runs found on every tuning half; the 0.1 floor stops a read at
 *  its first batch when nothing in the history scores warm, at a cost
 *  of 0.8 points of LoCoMo evidence. */
const STOP_FLOOR = 0.1;
const STOP_SHARE = 0.2;
/** The batches the rating stop sends at once before it checks them.
 *  On the same saved ratings, two a wave read 3, 1 and 1 points more of
 *  LoCoMo's, DolphinBench's and BEAM's parts than one batch at a time,
 *  for an estimated 45%, 16% and 48% less decide time under the
 *  service's token allowance; three a wave read 14, 3 and 2 points
 *  more for little further gain. */
const WAVE_BATCHES = 2;

export const PICK_QUESTION_VERSION = 'memory-pick-questions-1';

/** The most label-store files a pick opens at once. Pools can hold
 *  tens of thousands of parts, and an open per part in one moment can
 *  pass the process's file limit; reads run in groups of this size. */
const LABEL_STORE_READ_GROUP = 64;
/** Part labels a pick in this process is asking for, by the label
 *  store's directory and the part's label key. A pick that needs a
 *  part another pick is asking for waits for that answer instead of
 *  asking again. An entry settles with nothing when the store already
 *  held the labels, its answer failed, a stop left it unasked or its
 *  pick was cancelled, and the waiter then reads the store or asks
 *  itself. It is removed once
 *  settled. */
const labelsInFlight = new Map<string, Promise<PartLabels | undefined>>();
const DEFAULT_MAX_PER_BATCH = 150;
/** The bar for a source that declares none cuts scored references below
 *  0.0146: the highest cut that lost no answer message in the
 *  measurement on the tuning questions. */
const DEFAULT_BAR = 0.0146;
/** Default reader part size, in characters. Readers preserve every part;
 *  pick itself shows full candidate text unless a caller supplies a cut. */
export const DEFAULT_MAX_QUESTION_TEXT = 700;
const DEFAULT_LINKED_PATH_BAR = 0.4;
/** The rare-word round's defaults, fitted on the saved tuning half of a
 *  LongMemEval history: a word is rare when at most `share` × N parts
 *  contain it — the count of 5 measured on an 850-part history — and a
 *  pulled part joins the selection at or above `bar`. */
const RARE_SHARE = 5 / 850;
const RARE_BAR = 0.0146;
/** The bar `answerTypes: true` asks the answer types at. */
const ANSWER_TYPE_BAR = 0.5;
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
  | { readonly status: 'answered'; readonly probability: number; readonly reused?: boolean; readonly truncated?: boolean }
  | { readonly status: 'answered'; readonly probabilities: readonly number[]; readonly reused?: boolean; readonly truncated?: boolean }
  | { readonly status: 'refused' | 'missing' | 'error'; readonly detail?: string; readonly truncated?: boolean };

interface ResolvedLimits {
  readonly maxPerBatch: number;
  readonly maxBatchChars: number;
  readonly maxBatches: number;
  readonly maxCandidates: number;
  readonly maxElapsedMs: number;
  readonly maxQuestionText: number;
  readonly maxInFlight: number;
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
 *  date and text; an anonymous item's id and title never reach the
 *  model, so they count nothing. */
function itemChars(question: PickQuestion): number {
  return (question.anonymous === true ? 0 : question.id.length + question.title.length)
    + question.text.length
    + (question.date === undefined ? 0 : question.date.value.length + question.date.meaning.length);
}

/** What one question adds to its batch's counted size: the question's
 *  wording and its true and false criteria or its levels. */
function questionChars(question: PickQuestion): number {
  return question.question.length
    + (question.levels ?? [question.trueCriterion ?? '', question.falseCriterion ?? '']).join('').length;
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

function checkAnswer(raw: unknown, levels?: number): CheckedAnswer {
  if (raw === undefined) return { status: 'missing' };
  if (!isRecord(raw)) return { status: 'error', detail: 'The answer is not an object.' };
  const { status, probability, probabilities, detail } = raw;
  const truncated = raw.truncated === true ? { truncated: true as const } : {};
  if (status === 'answered') {
    if (levels !== undefined) {
      return levelDistribution(probabilities, levels)
        ? { status: 'answered', probabilities: [...probabilities], ...truncated }
        : { status: 'error', detail: 'The answer probabilities are not a distribution over the levels.' };
    }
    return typeof probability === 'number' && Number.isFinite(probability)
      && probability >= 0 && probability <= 1
      ? { status: 'answered', probability, ...truncated }
      : { status: 'error', detail: 'The answer probability is not a number between 0 and 1.' };
  }
  if (status === 'refused' || status === 'missing' || status === 'error') {
    return typeof detail === 'string' ? { status, detail, ...truncated } : { status, ...truncated };
  }
  return { status: 'error', detail: 'The answer status is not recognised.' };
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
    throw new TypeError('everyScored.bySize needs unique nonnegative integer counts with bars between 0 and 1.');
  }
}

// Match the prototype: clamp each side separately, and missing answers add nothing.
function logit(p: number): number {
  return Math.log(Math.max(p, 1e-4) / Math.max(1 - p, 1e-4));
}

/** The logit of a written answer, clamped to 0.0001 to 0.9999 first. */
function writtenLogit(p: number): number {
  const value = Math.min(Math.max(p, 1e-4), 1 - 1e-4);
  return Math.log(value / (1 - value));
}

/** What `settingEffects` reads from one pick. */
interface EffectInput {
  /** The parts the record holds. */
  readonly candidates: readonly MemoryCandidate[];
  readonly queue: readonly MemoryCandidate[];
  /** The parts that reached the decide step, after any feed cut. */
  readonly feed: readonly MemoryCandidate[];
  readonly statuses: ReadonlyMap<MemoryCandidate, PickEntryStatus>;
  /** The parts a keyword lane held inside its candidate limit, with
   *  the `searchRanks` positions of the lanes that held each one there. */
  readonly laneHeld: ReadonlyMap<MemoryCandidate, ReadonlySet<number>>;
  readonly labelLane: ReadonlySet<MemoryCandidate>;
  /** The label kinds the task needed, by source. */
  readonly labelNeeds: ReadonlyMap<string, readonly string[]>;
  readonly labelBar: (id: string) => number;
  readonly labels: ReadonlyMap<MemoryCandidate, PartLabels>;
  readonly labelKindsBySource: Readonly<Record<string, readonly LabelKind[]>>;
  /** The rare words each source the round ran on contributed. */
  readonly rareSeeds: ReadonlyMap<string, ReadonlySet<string>>;
  readonly rareTaken: readonly MemoryCandidate[];
  readonly rareAdded: ReadonlySet<MemoryCandidate>;
  /** The pulled parts the round never asked, and why: past a feed
   *  size's room, or below the round's own stop. */
  readonly rareHeld: ReadonlyMap<MemoryCandidate, 'size' | 'cold'>;
  /** The parts the selection pass scored, and those it scored below their bar. */
  readonly scored: ReadonlySet<MemoryCandidate>;
  readonly belowBar: ReadonlySet<MemoryCandidate>;
  /** The parts the link pass looked at. */
  readonly linkActed: ReadonlySet<MemoryCandidate>;
  readonly rankedBySource: ReadonlyMap<string, number>;
  readonly cutBySource: ReadonlyMap<string, number>;
  /** The decide step read the fused order: `everyRanked` was not given. */
  readonly fused: boolean;
  /** The `feed` option, when given. */
  readonly feedOption: PickOptions['feed'];
  /** What the rating stop did, when it was on: its floor and share,
   *  the batch that went cold, what ended the read, and by source the
   *  parts of the order it could read and the parts it rated. */
  readonly stopWhenCold: {
    readonly floor: number;
    readonly share: number;
    readonly cold: NonNullable<NonNullable<PickRecord['pick']>['stopWhenCold']>['cold'];
    readonly ended: NonNullable<NonNullable<PickRecord['pick']>['stopWhenCold']>['ended'];
    readonly kept: number;
    readonly orderBySource: ReadonlyMap<string, number>;
    readonly ratedBySource: ReadonlyMap<string, number>;
  } | undefined;
  readonly reads: Readonly<Record<string, PickSourceRead>>;
  /** `taskPeriod` was on, the period the task named, and which parts it brought in. */
  readonly taskPeriod: boolean;
  readonly period: TaskPeriod | undefined;
  readonly windowed: (candidate: MemoryCandidate) => boolean;
  readonly bar: (id: string) => number;
  readonly ruleBar: (id: string) => number;
  readonly everyScored: boolean;
  readonly linkedPathBar: number;
  readonly rareBar: number;
  readonly topK: number | undefined;
  /** What ended the feed early: a feed cut, a stop, or both. */
  readonly ended: readonly string[];
  /** Each source whose set has typed questions, and whether the task
   *  needed any of their answer types. */
  readonly typedSources: ReadonlyMap<string, boolean>;
  /** The parts asked at least one typed question. */
  readonly typedAsked: ReadonlySet<MemoryCandidate>;
  /** Each part's score without its typed terms, for the parts that have them. */
  readonly untyped: ReadonlyMap<MemoryCandidate, number>;
  /** Each source whose set has written weights. */
  readonly writtenSources: ReadonlySet<string>;
  /** The parts asked at least one written question. */
  readonly writtenAsked: ReadonlySet<MemoryCandidate>;
  /** Each part's score without its written terms, for the parts that have them. */
  readonly unwritten: ReadonlyMap<MemoryCandidate, number>;
  /** The parts a typed answer at or above its keepAt keeps, whatever their score. */
  readonly keepReached: ReadonlySet<MemoryCandidate>;
  /** Each source whose set has a name question. */
  readonly namedSources: ReadonlySet<string>;
  /** Whether the task named anything. */
  readonly named: boolean;
  /** The parts asked at least one name question. */
  readonly namedAsked: ReadonlySet<MemoryCandidate>;
  /** Each part's score without its name terms, for the parts that have them. */
  readonly unnamed: ReadonlyMap<MemoryCandidate, number>;
  /** By source ID, the parts of a sized history no lane kept: not
   *  candidates, but part of the source's history. */
  readonly unheld: Readonly<Record<string, number>>;
}

const count = (n: number, noun = 'part') => `${n} ${noun}${n === 1 ? '' : 's'}`;
const keptOf = (n: number) => `${n} of them ${n === 1 ? 'was' : 'were'} kept`;

/** One entry per setting that was on, per source it applied to, counted
 *  from the pick that ran. A part reaches the decide step by one or
 *  more ways in: each lane that held it inside its candidate limit, the whole-lane
 *  read when every lane held it past the cut, the label lane, and the
 *  task's period. A
 *  setting that opens a way in is credited with a kept part only when
 *  that was the part's only way in and neither the link nor the
 *  rare-word round kept it. */
function settingEffects(input: EffectInput): PickSettingEffect[] {
  const { statuses, reads } = input;
  const feed = new Set(input.feed);
  const ended = input.ended.length === 0 ? undefined
    : `${input.ended.join(' and ').replace(/^a/, 'A')} ended the feed early`;
  const ways = (candidate: MemoryCandidate): Set<string> => {
    const found = new Set<string>();
    const held = input.laneHeld.get(candidate);
    if (held !== undefined) {
      if (candidate.pastLaneCut === true) found.add('wholeLanes');
      else if (candidate.searchRanks === undefined) found.add('task');
      else {
        const lanes = reads[candidate.sourceId]?.lanes ?? [];
        for (const index of held) found.add(lanes[index] ?? 'task');
      }
    }
    // Under the fused order a feed reference no lane held has the order
    // itself as its way in: the label lane and the period reorder the
    // order but admit none. A part a lane held keeps that lane as a way
    // in; its position in the fused order is what the lane placed.
    if (input.fused && candidate.role === 'reference'
      && feed.has(candidate) && held === undefined) {
      found.add('order');
    }
    if (input.labelLane.has(candidate)) found.add('labels');
    if (input.windowed(candidate)) found.add('taskPeriod');
    return found;
  };
  const credited = (candidate: MemoryCandidate) => {
    const status = statuses.get(candidate);
    return status?.status === 'selected' && status.link === undefined && !input.rareAdded.has(candidate);
  };
  // A setting's order changes the feed, so with the feed ended early it
  // may also have swapped which parts were decided.
  const reachedOrEnded = (head: string, through: string, reached: number, added: number, order: string) =>
    `${head}; ${reached === 0 ? `none ${through}` : `${reached} ${through}, and ${keptOf(added)}`}. `
      + `${ended}, and ${order}, so ${order.startsWith('the whole') ? 'it' : 'they'} may also have changed which parts were decided.`;
  // The parts on each side of the bar only because of the terms a
  // score `without` leaves out. That score is the same sum without
  // them, so both sides of the bar come from this one pick.
  const crossings = (own: readonly MemoryCandidate[], without: ReadonlyMap<MemoryCandidate, number>, bar: number) => ({
    added: own.filter((candidate) => input.scored.has(candidate) && !input.belowBar.has(candidate)
      && (without.get(candidate) ?? bar) < bar && statuses.get(candidate)?.status === 'selected').length,
    dropped: own.filter((candidate) => input.belowBar.has(candidate)
      && (without.get(candidate) ?? -1) >= bar && statuses.get(candidate)?.status !== 'selected').length,
  });
  // One entry per source whose set has typed questions, a source that
  // returned no part included.
  const typedEffect = (id: string, own: readonly MemoryCandidate[]): PickSettingEffect => {
    const needed = input.typedSources.get(id);
    const bar = input.bar(id);
    const acted = own.filter((candidate) => input.typedAsked.has(candidate)).length;
    const { added: crossed, dropped } = crossings(own, input.untyped, bar);
    const kept = own.filter((candidate) => {
      const status = statuses.get(candidate);
      return status?.status === 'selected' && status.keptBy !== undefined;
    }).length;
    const added = crossed + kept;
    return { setting: 'typed', source: id, actedOn: acted, added, dropped,
      summary: !needed
        ? `typed on ${id}: the task needed none of its answer types, so no typed question was asked. It added no part and kept out no part.`
        : added === 0 && dropped === 0
          ? `typed on ${id}: ${count(acted)} ${acted === 1 ? 'was' : 'were'} asked typed questions, but no part crossed the bar because of them. It added no part and kept out no part.`
          : `typed on ${id}: ${count(acted)} ${acted === 1 ? 'was' : 'were'} asked typed questions; ${count(crossed)} reached the bar ${bar} only with them, ${
            kept === 0 ? '' : `${count(kept)} ${kept === 1 ? 'was' : 'were'} kept by a typed answer at or above its keepAt, `
          }and ${count(dropped)} fell below it only because of them.` };
  };
  // One entry per source whose set has written weights, a source that
  // returned no part included.
  const writtenEffect = (id: string, own: readonly MemoryCandidate[]): PickSettingEffect => {
    const bar = input.bar(id);
    const acted = own.filter((candidate) => input.writtenAsked.has(candidate)).length;
    // A part a typed answer's keepAt keeps would be kept without the written terms too.
    const { added, dropped } = crossings(own.filter((candidate) => !input.keepReached.has(candidate)), input.unwritten, bar);
    const head = `written on ${id}: ${count(acted)} ${acted === 1 ? 'was' : 'were'} asked the task's written questions`;
    return { setting: 'written', source: id, actedOn: acted, added, dropped,
      summary: added === 0 && dropped === 0
        ? `${head}, but no part crossed the bar because of them. It added no part and kept out no part.`
        : `${head}; ${count(added)} reached the bar ${bar} only with them, and ${count(dropped)} fell below it only because of them.` };
  };
  // One entry per source whose set has a name question, a source that
  // returned no part included.
  const namedEffect = (id: string, own: readonly MemoryCandidate[]): PickSettingEffect => {
    const bar = input.bar(id);
    const acted = own.filter((candidate) => input.namedAsked.has(candidate)).length;
    // A part a typed answer's keepAt keeps would be kept without the name terms too.
    const { added, dropped } = crossings(own.filter((candidate) => !input.keepReached.has(candidate)), input.unnamed, bar);
    const head = `named on ${id}: ${count(acted)} ${acted === 1 ? 'was' : 'were'} asked whether they mention the task's names`;
    return { setting: 'named', source: id, actedOn: acted, added, dropped,
      summary: !input.named
        ? `named on ${id}: the task named nothing, so no name question was asked. It added no part and kept out no part.`
        : added === 0 && dropped === 0
          ? `${head}, but no part crossed the bar because of them. It added no part and kept out no part.`
          : `${head}; ${count(added)} reached the bar ${bar} only with the name terms, and ${count(dropped)} fell below it only because of them.` };
  };
  const effects: PickSettingEffect[] = [];
  // A history no lane kept a part of still has its effects.
  const looped = new Set([...input.candidates.map((candidate) => candidate.sourceId),
    ...Object.keys(input.unheld).filter((id) => input.unheld[id]! > 0)]);
  for (const id of looped) {
    const own = input.candidates.filter((candidate) => candidate.sourceId === id);
    const opened = (way: string) => {
      const reached = own.filter((candidate) => {
        const found = ways(candidate);
        return feed.has(candidate) && found.size === 1 && found.has(way);
      });
      return { reached: reached.length, added: reached.filter(credited).length };
    };
    const read = reads[id];

    if ((input.labelKindsBySource[id]?.length ?? 0) > 0) {
      const queued = input.queue.filter((candidate) => candidate.sourceId === id && candidate.role === 'reference');
      const labelled = queued.filter((candidate) => input.labels.has(candidate)).length;
      const { reached, added } = opened('labels');
      const head = `labels on ${id} at the label bar ${input.labelBar(id)}: labelled ${count(labelled)}`;
      const through = 'reached the decide step only through the label lane';
      const reason = input.fused
          || queued.every((candidate) => input.laneHeld.has(candidate))
        ? 'every part was already going to the decide step'
        : (input.labelNeeds.get(id) ?? []).length === 0 ? 'the task needed none of its label kinds'
          : !queued.some((candidate) => input.labelLane.has(candidate) && !input.laneHeld.has(candidate))
            ? 'no part outside the lanes cleared the label bar' : undefined;
      effects.push({ setting: 'labels', source: id, actedOn: labelled, added, dropped: ended ? null : 0,
        summary: ended ? reachedOrEnded(head, through, reached, added, 'labels change its order')
          : added > 0 ? `${head}; ${reached} ${through}, and ${keptOf(added)}.`
            : reason === undefined ? `${head}; ${reached} ${through}, but none of them were kept. It added no part.`
              : `${head}, but ${reason}, so labels added none. It added no part.` });
    }

    const seeds = input.rareSeeds.get(id);
    if (seeds !== undefined) {
      const pulled = input.rareTaken.filter((candidate) => candidate.sourceId === id);
      const added = pulled.filter((candidate) => input.rareAdded.has(candidate)).length;
      // A pulled part the round held out was never asked, however rare
      // its words: a feed size's room ran out, or the round's own
      // answers went cold first.
      const held = (why: 'size' | 'cold') => pulled.filter((candidate) => input.rareHeld.get(candidate) === why
        && input.statuses.get(candidate)?.status === 'unassessed').length;
      const depthNote = [
        ...(held('size') === 0 ? [] : [`; the feed size held ${count(held('size'))} of them out`]),
        ...(held('cold') === 0 ? [] : [`; its ratings went cold with ${held('cold')} of them unasked`]),
      ].join('');
      effects.push({ setting: 'rare', source: id, actedOn: pulled.length, added, dropped: 0,
        summary: added > 0
          ? `rare on ${id}: pulled in ${count(pulled.length)} that share a rare word with a kept part, and ${keptOf(added)}${depthNote}.`
          : `rare on ${id}: ${seeds.size === 0 ? 'no kept part had a word that is rare in this source'
            : pulled.length === 0 ? 'no other part shared a rare word with a kept part'
              : `pulled in ${count(pulled.length)}, but none answered at or above the rare bar ${input.rareBar}${depthNote}`
          }, so the round added none. It added no part.` });
    }

    const references = own.filter((candidate) => candidate.role === 'reference');
    if (references.length > 0 || (input.unheld[id] ?? 0) > 0) {
      const setting = input.everyScored ? 'everyScored' : 'bar';
      const bar = input.bar(id);
      const scored = references.filter((candidate) => input.scored.has(candidate));
      const below = scored.filter((candidate) => input.belowBar.has(candidate));
      const dropped = below.filter((candidate) => statuses.get(candidate)?.status !== 'selected').length;
      effects.push({ setting, source: id, actedOn: scored.length, added: 0, dropped,
        summary: dropped > 0
          ? `${setting} on ${id}: of ${count(scored.length, 'scored part')}, ${dropped} fell below the bar ${bar} and no later pass kept them.`
          : below.length === 0
            ? `${setting} on ${id}: no scored part of ${scored.length} fell below the bar ${bar}, so the bar kept out none. It kept out no part.`
            : `${setting} on ${id}: of ${count(scored.length, 'scored part')}, ${below.length} fell below the bar ${bar}, but ${
              below.some((candidate) => { const status = statuses.get(candidate); return status?.status === 'selected' && status.keptBy !== undefined; })
                ? 'a typed question\'s keepAt or a later pass' : 'a later pass'
            } kept each of them, so the bar kept out none. It kept out no part.` });
    }

    if (input.typedSources.has(id)) effects.push(typedEffect(id, own));
    if (input.writtenSources.has(id)) effects.push(writtenEffect(id, own));
    if (input.namedSources.has(id)) effects.push(namedEffect(id, own));

    const rules = own.filter((candidate) => candidate.role === 'rule');
    if (rules.length > 0 && input.ruleBar(id) > 0) {
      const bar = input.ruleBar(id);
      // A rule is asked unless it applies always or the feed never reached it.
      const asked = rules.filter((candidate) => {
        const status = statuses.get(candidate);
        return status !== undefined && status.status !== 'unassessed' && !(status.status === 'selected' && !status.asked);
      }).length;
      const scored = rules.filter((candidate) => input.scored.has(candidate));
      const picked = scored.filter((candidate) => statuses.get(candidate)?.status === 'selected').length;
      const dropped = scored.filter((candidate) => input.belowBar.has(candidate)).length;
      effects.push({ setting: 'ruleBar', source: id, actedOn: asked, added: 0, dropped,
        summary: `ruleBar on ${id}: asked ${count(asked, 'rule')}, picked ${picked}, dropped ${dropped} below the bar ${bar}.`
          + (dropped === 0 ? ' It kept out no part.' : '') });
    }

    for (const setting of ['searchLines', 'searchPhrases', 'meaning', 'names'] as const) {
      if (read === undefined || !(read.given ?? read.lanes).includes(setting)) continue;
      const held = own.filter((candidate) => candidate.searchRanks?.some((rank, index) =>
        rank !== null && read.lanes[index] === setting) === true).length;
      // The parts these lanes held inside their candidate limit, the only ones they could bring in.
      const inLimit = own.filter((candidate) => [...input.laneHeld.get(candidate) ?? []]
        .some((index) => read.lanes[index] === setting)).length;
      const { reached, added } = opened(setting);
      const head = `${setting} on ${id}: the lanes held ${count(held)}`;
      const through = 'reached the decide step only through them';
      effects.push({ setting, source: id, actedOn: held, added, dropped: ended ? null : 0,
        summary: ended ? reachedOrEnded(head, through, reached, added, 'these lanes change its order')
          : added > 0 ? `${head}; ${reached} ${through}, and ${keptOf(added)}.`
            : reached > 0 ? `${head}; ${reached} ${through}, but none of them were kept. It added no part.`
              : !read.lanes.includes(setting) ? `${setting} on ${id}: ${setting === 'searchLines'
                ? 'every line was blank or repeated the task or an earlier line'
                : setting === 'names' ? 'the task named nothing that another lane did not already search'
                  : 'there was no text to search'
              }, so no extra lane opened and they added none. It added no part.`
                : held === 0 ? `${setting} on ${id}: the lanes held no part, so they added none. It added no part.`
                : `${head}, but every part they held${inLimit < held ? ' inside the candidate limit' : ''} was also in another lane, so they added none. It added no part.` });
    }

    if (read?.wholeLanes === true) {
      const past = own.filter((candidate) => candidate.pastLaneCut === true).length;
      const pastInLimit = own.filter((candidate) => candidate.pastLaneCut === true && input.laneHeld.has(candidate)).length;
      const { reached, added } = opened('wholeLanes');
      const head = `wholeLanes on ${id}: read ${count(past)} past the lane cut`;
      const through = 'reached the decide step only through the whole-lane read';
      effects.push({ setting: 'wholeLanes', source: id, actedOn: past, added, dropped: ended ? null : 0,
        summary: ended ? reachedOrEnded(head, through, reached, added, 'the whole-lane read changes its order')
          : added > 0 ? `${head}; ${reached} ${through}, and ${keptOf(added)}.`
            : reached > 0 ? `${head}; ${reached} ${through}, but none of them were kept. It added no part.`
              : past === 0 ? `wholeLanes on ${id}: the read held no part past the lane cut, so it added none. It added no part.`
                : pastInLimit === 0 ? `${head}, but every one of them lay past the candidate limit, so it added none. It added no part.`
                  : `${head}, but each of them${pastInLimit < past ? ' inside the candidate limit' : ''} also had another way in, so it added none. It added no part.` });
    }

    if (input.taskPeriod) {
      const period = input.period;
      const dated = period === undefined ? 0 : own.filter((candidate) => candidate.role === 'reference'
        && candidate.date !== undefined && datedIn(candidate.date.value, period)).length;
      const { reached, added } = opened('taskPeriod');
      const head = period === undefined ? '' : `taskPeriod on ${id}: ${count(dated)} dated from ${period.from} to ${period.to}`;
      const through = 'reached the decide step only through the period';
      effects.push({ setting: 'taskPeriod', source: id, actedOn: dated, added,
        dropped: period !== undefined && ended ? null : 0,
        summary: period === undefined ? `taskPeriod on ${id}: the task names no period, so it added none. It added no part.`
          : ended ? reachedOrEnded(head, through, reached, added, "the period's parts change its order")
            : added > 0 ? `${head}; ${reached} ${through}, and ${keptOf(added)}.`
              : reached > 0 ? `${head}; ${reached} ${through}, but none of them were kept. It added no part.`
                : !own.some(input.windowed)
                  ? `${head}, but every part from the period was already in a search lane, so it added none. It added no part.`
                  : `${head}, but each of them also had another way in, so it added none. It added no part.` });
    }

    // The link checks a part's role, repository and path, never its source's kind.
    if (references.some((candidate) => candidate.path !== undefined && candidate.repository !== undefined)) {
      const acted = own.filter((candidate) => input.linkActed.has(candidate)).length;
      const added = own.filter((candidate) => {
        const status = statuses.get(candidate);
        return status?.status === 'selected' && status.link !== undefined;
      }).length;
      effects.push({ setting: 'linkedPathBar', source: id, actedOn: acted, added, dropped: 0,
        summary: added > 0
          ? `linkedPathBar on ${id}: ${count(acted)} fell below the bar but answered at or above the link bar ${input.linkedPathBar}, and ${keptOf(added)} through a selected part that changed its path.`
          : `linkedPathBar on ${id}: no selected part's changed paths include the path of a part rejected at or above the link bar ${input.linkedPathBar}, so the link added none. It added no part.` });
    }

    if (input.topK !== undefined) {
      const ranked = input.rankedBySource.get(id) ?? 0;
      const left = input.cutBySource.get(id) ?? 0;
      effects.push({ setting: 'everyRanked', source: id, actedOn: ranked, added: 0, dropped: null,
        summary: left > 0
          ? `everyRanked on ${id}: the cut (c ${input.topK}) kept ${ranked - left} of ${count(ranked, 'ranked part')} and left ${left} undecided.`
          : `everyRanked on ${id}: the cut (c ${input.topK}) kept every one of ${count(ranked, 'ranked part')}, so it left 0 undecided.` });
    }

    if (input.fused && input.feedOption?.size !== undefined) {
      const ranked = input.rankedBySource.get(id) ?? 0;
      const left = input.cutBySource.get(id) ?? 0;
      const cut = `the feed size of ${count(input.feedOption.size, 'part')}`;
      effects.push({ setting: 'feed', source: id, actedOn: ranked, added: 0, dropped: null,
        summary: left > 0
          ? `feed on ${id}: ${cut} kept ${ranked - left} of ${count(ranked, 'ranked part')} and left ${left} undecided.`
          : `feed on ${id}: ${cut} kept every one of ${count(ranked, 'ranked part')}, so it left 0 undecided.` });
    }

    if (input.stopWhenCold !== undefined) {
      const { floor, share, cold, ended, kept } = input.stopWhenCold;
      const order = input.stopWhenCold.orderBySource.get(id) ?? 0;
      const read = input.stopWhenCold.ratedBySource.get(id) ?? 0;
      const unread = order - read;
      const rating = (value: number) => Number(value.toFixed(3));
      const went = cold === undefined ? '' : `the ratings went cold at batch ${cold.batch}, whose best rating ${rating(cold.best)} was under ${
        cold.under === 'floor' ? `the floor ${floor}` : `${share} of the best before it, ${rating(cold.bestBefore)}`}`;
      const left = `${read} of ${count(order, 'part')} in the order and left ${unread} unread`;
      effects.push({ setting: 'stopWhenCold', source: id, actedOn: order, added: 0, dropped: null,
        summary: ended !== 'cold' && ended !== 'order'
          ? `stopWhenCold on ${id}: a stop (${ended}) ended the read before the ratings went cold or the order ran out, so it rated ${left}.`
          : ended === 'order'
            ? kept === 0 && unread === 0
              ? `stopWhenCold on ${id}: no part reached the keep bar, so the read rated every one of ${count(order, 'part')} in the order and kept none.`
            : unread === 0
              ? `stopWhenCold on ${id}: the ratings never went cold, so the read rated every one of ${count(order, 'part')} in the order and left 0 unread.`
              : `stopWhenCold on ${id}: the ratings never went cold and the read reached the end of the order, but ${unread} of its parts got no decision score: it rated ${left}.`
            : unread > 0
              ? `stopWhenCold on ${id}: ${went}, so the read rated ${left}.`
              : `stopWhenCold on ${id}: the read rated every one of ${count(order, 'part')} in the order before ${went}, so it left 0 unread.` });
    }
  }
  for (const id of input.typedSources.keys()) {
    if (!looped.has(id)) effects.push(typedEffect(id, []));
  }
  // One entry per read that skipped always-on files, a read that returned no part included.
  const listed = new Set<PickSourceRead>();
  for (const [id, read] of Object.entries(reads)) {
    if (read.alwaysOnSkipped === undefined || listed.has(read)) continue;
    listed.add(read);
    const skipped = read.alwaysOnSkipped;
    effects.push({ setting: 'alwaysOnSkipped', source: id, actedOn: skipped.length, added: 0, dropped: null,
      summary: `alwaysOnSkipped on ${id}: skipped ${count(skipped.length, 'always-on file')} the agent's harness loads itself: `
        + `${skipped.map((skip) => `${skip.file} (${skip.reason})`).join('; ')}.` });
  }
  for (const id of input.writtenSources) {
    if (!looped.has(id)) effects.push(writtenEffect(id, []));
  }
  for (const id of input.namedSources) {
    if (!looped.has(id)) effects.push(namedEffect(id, []));
  }
  // A source with name lanes on whose read returned no part still gets its entry.
  for (const [id, read] of Object.entries(reads)) {
    if (!(read.given ?? read.lanes).includes('names') || looped.has(id)) continue;
    effects.push({ setting: 'names', source: id, actedOn: 0, added: 0, dropped: 0,
      summary: read.lanes.includes('names')
        ? `names on ${id}: the lanes held no part, so they added none. It added no part.`
        : `names on ${id}: the task named nothing that another lane did not already search, so no extra lane opened and they added none. It added no part.` });
  }
  return effects;
}

export async function pick(
  candidates: readonly MemoryCandidate[],
  options: PickOptions,
): Promise<PickResult> {
  checkPickOptions(options);
  // The moment the record names, and the period the task names counted from it.
  const timeZone = timeZoneOf(options.timeZone);
  const taskMs = taskMoment(options.taskDate, timeZone);
  const asOf = zonedIso(taskMs, timeZone);
  const period = options.taskPeriod === false ? undefined : taskPeriod(options.task, { asOf, timeZone });
  const everyScored = options.everyScored;
  if (options.labels !== undefined
    && (typeof options.labels !== 'object' || options.labels === null || Array.isArray(options.labels))) {
    throw new TypeError('labels must be an options object.');
  }
  const labelOptions = {
    directory: options.labels?.directory
      ?? join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'curate', 'labels'),
    deciderId: options.labels?.deciderId ?? options.decide.deciderId ?? 'custom',
    questionVersion: options.labels?.questionVersion,
  };
  const labelKindsBySource: Record<string, readonly LabelKind[]> = Object.create(null);
  for (const id of new Set([...Object.keys(options.labelKindsBySource ?? {}), ...candidates.map((c) => c.sourceId)])) {
    labelKindsBySource[id] = options.labelKindsBySource?.[id] ?? [];
  }
  // The label gate runs when any source carries label kinds.
  const labelsOn = Object.values(labelKindsBySource).some((kinds) => kinds.length > 0);
  const kindsFor = (candidate: MemoryCandidate) => labelKindsBySource[candidate.sourceId] ?? [];
  const labelBarFor = (id: string) => options.labelBarBySource?.[id] ?? LABEL_LANE_BAR;
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
  for (const set of Object.values(options.questionsBySource ?? {})) checkCascade(set);
  checkWriteQuestions(options);
  if (options.route !== undefined && options.route !== 'jev') {
    throw new TypeError(`route must be 'jev'.`);
  }
  if (options.answerTypes !== undefined && typeof options.answerTypes !== 'boolean'
    && (!isRecord(options.answerTypes) || typeof options.answerTypes.bar !== 'number'
      || !Number.isFinite(options.answerTypes.bar) || options.answerTypes.bar < 0 || options.answerTypes.bar > 1)) {
    throw new TypeError('answerTypes must be a boolean or hold a bar between 0 and 1.');
  }
  const answerTypesBar = options.answerTypes === true ? ANSWER_TYPE_BAR
    : isRecord(options.answerTypes) ? options.answerTypes.bar : undefined;
  for (const set of options.tags ?? []) checkTagSet(set);
  for (const sets of Object.values(options.tagsByKind ?? {})) for (const set of sets ?? []) checkTagSet(set);
  const kindFor = (candidate: MemoryCandidate) => options.sourceKinds && Object.hasOwn(options.sourceKinds, candidate.sourceId)
    ? options.sourceKinds[candidate.sourceId] : undefined;
  const questionsFor = (sourceId: string) => options.questionsBySource && Object.hasOwn(options.questionsBySource, sourceId)
    ? options.questionsBySource[sourceId] : undefined;
  const cascadeFor = (candidate: MemoryCandidate) => questionsFor(candidate.sourceId);
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
  if (options.everyRanked !== undefined && options.everyRanked !== true
    && (!isRecord(options.everyRanked)
      || typeof options.everyRanked.c !== 'number' || !Number.isFinite(options.everyRanked.c)
      || options.everyRanked.c <= 0)) {
    throw new TypeError('everyRanked must be true or hold a positive finite c.');
  }
  if (options.everyScored !== undefined && options.everyScored !== true) {
    const scored: unknown = options.everyScored;
    if (!isRecord(scored) || (scored.bar === undefined && scored.bySize === undefined)) {
      throw new TypeError('everyScored must be true or hold a bar or a bySize curve.');
    }
    if (scored.bar !== undefined
      && (typeof scored.bar !== 'number' || !Number.isFinite(scored.bar) || scored.bar < 0 || scored.bar > 1)) {
      throw new TypeError('everyScored.bar must be a number between 0 and 1.');
    }
    checkSizeCurve(scored.bySize as readonly (readonly [number, number])[] | undefined);
  }
  if (options.rare !== undefined && options.rare !== false && options.rare !== true) {
    const rare: unknown = options.rare;
    if (!isRecord(rare)
      || (rare.share !== undefined
        && (typeof rare.share !== 'number' || !Number.isFinite(rare.share) || rare.share <= 0))
      || (rare.bar !== undefined
        && (typeof rare.bar !== 'number' || !Number.isFinite(rare.bar) || rare.bar < 0 || rare.bar > 1))) {
      throw new TypeError('rare needs a positive finite share and a bar between 0 and 1.');
    }
  }
  const input = options.limits ?? {};
  const limits: ResolvedLimits = {
    maxPerBatch: positiveLimit(input.maxPerBatch, 'maxPerBatch', DEFAULT_MAX_PER_BATCH),
    maxBatchChars: positiveLimit(input.maxBatchChars, 'maxBatchChars', Number.POSITIVE_INFINITY),
    maxBatches: positiveLimit(input.maxBatches, 'maxBatches', Number.POSITIVE_INFINITY),
    maxCandidates: positiveLimit(input.maxCandidates, 'maxCandidates', Number.POSITIVE_INFINITY),
    maxElapsedMs: positiveLimit(input.maxElapsedMs, 'maxElapsedMs', Number.POSITIVE_INFINITY),
    maxQuestionText: positiveLimit(input.maxQuestionText, 'maxQuestionText', Number.POSITIVE_INFINITY),
    maxInFlight: positiveLimit(input.maxInFlight, 'maxInFlight', Number.POSITIVE_INFINITY),
  };
  const recordedLimits: PickLimits = {
    maxPerBatch: limits.maxPerBatch,
    ...(input.maxBatchChars !== undefined ? { maxBatchChars: input.maxBatchChars } : {}),
    ...(input.maxQuestionText !== undefined ? { maxQuestionText: input.maxQuestionText } : {}),
    ...(input.maxBatches !== undefined ? { maxBatches: input.maxBatches } : {}),
    ...(input.maxCandidates !== undefined ? { maxCandidates: input.maxCandidates } : {}),
    ...(input.maxElapsedMs !== undefined ? { maxElapsedMs: input.maxElapsedMs } : {}),
    ...(input.maxInFlight !== undefined ? { maxInFlight: input.maxInFlight } : {}),
  };
  const scored = everyScored === undefined || everyScored === true ? {} : everyScored;
  // An explicit caller bar wins; without one a model-scored set's
  // fitted bar is the source's own bar; without either the default
  // stands.
  const barFor = (id: string) => everyScored === true ? 0
    : scored.bar ?? options.barBySource?.[id] ?? options.questionsBySource?.[id]?.model?.bar ?? DEFAULT_BAR;
  const ruleBarFor = (id: string) => options.ruleBarBySource?.[id] ?? 0;
  const thresholds: PickRecord['thresholds'] = {
    linkedPathBar: probabilityLimit(options.thresholds?.linkedPathBar, 'thresholds.linkedPathBar', DEFAULT_LINKED_PATH_BAR),
    ...(scored.bySize === undefined ? {}
      : { referenceBySize: [...scored.bySize].sort((left, right) => left[0] - right[0]) }),
  };
  const rareForSource = (id: string) => options.rare === undefined
    ? options.rareBySource?.[id] === true : options.rare !== false;
  const rareSourceIds = [...new Set([...Object.keys(options.rareBySource ?? {}), ...candidates.map((c) => c.sourceId)])];
  const rareSources = rareSourceIds.filter(rareForSource);
  const rareOn = options.rare === undefined ? rareSources.length > 0 : options.rare !== false;
  const rareShare = (isRecord(options.rare) ? options.rare.share : undefined) ?? RARE_SHARE;
  const rareBar = (isRecord(options.rare) ? options.rare.bar : undefined) ?? RARE_BAR;
  // The decide step reads the fused order whenever `everyRanked` is
  // not given: all of it, or under the rating stop when the call sets one.
  const fused = options.everyRanked === undefined;
  const stopRule = !fused || options.stopWhenCold === undefined || options.stopWhenCold === false ? undefined : {
    floor: options.stopWhenCold?.floor ?? STOP_FLOOR,
    share: options.stopWhenCold?.share ?? STOP_SHARE,
  };
  // The levers as resolved, for the record. `pick`
  // never sees `wholeLanes`: the read request carries it, and only a
  // pickFromSources record holds it.
  const levers: Omit<LeverStates, 'sources'> = {
    ...(fused
      ? { stopWhenCold: stopRule ?? false }
      : { everyRanked: options.everyRanked! }),
    ...(everyScored === undefined ? {} : { everyScored }),
    route: options.route === 'jev',
    rare: rareOn ? { share: rareShare, bar: rareBar } : false,
  };
  const topK = isRecord(options.everyRanked) ? options.everyRanked.c : undefined;
  // A `feed` size bounds the fused order; unset, the read can reach
  // every part of it.
  const depth = fused ? options.feed?.size : undefined;
  // A decide-feed dial is on when `everyRanked` supplies a c or the
  // rare-word round is on: pool-only parts then count toward the
  // history's size without joining the feed or the record, the
  // rare-word round aside.
  const dial = topK !== undefined || rareOn;
  const signal = options.signal ?? new AbortController().signal;
  const started = Date.now();
  // One signal for every decide call of the pick, with the pick's own
  // deadline riding it: the decider can tell this pick's batches, splits
  // and resends from another pick's, so one batch's terminal failure
  // stops this pick's queued sends and leaves another pick's alone. The
  // deadline fires once when the elapsed limit is spent.
  const decideDeadline = Number.isFinite(limits.maxElapsedMs)
    ? AbortSignal.timeout(Math.max(0, Math.ceil(limits.maxElapsedMs - (Date.now() - started))))
    : undefined;
  const decideSignal = AbortSignal.any(decideDeadline === undefined ? [signal] : [signal, decideDeadline]);

  const questionVersion = candidates.some((candidate) => candidate.kind !== undefined)
    ? 'memory-pick-questions-2' : PICK_QUESTION_VERSION;
  const cache = options.cache || undefined;
  if (cache !== undefined) {
    if (typeof cache !== 'object'
      || typeof cache.store?.get !== 'function' || typeof cache.store?.set !== 'function') {
      throw new TypeError('cache.store must supply get(key) and set(key, value).');
    }
    if (typeof cache.deciderId !== 'string' || !cache.deciderId.trim()) {
      throw new TypeError('cache.deciderId must be a nonempty string.');
    }
    if (cache.questionVersion !== undefined
      && (typeof cache.questionVersion !== 'string' || !cache.questionVersion.trim())) {
      throw new TypeError('cache.questionVersion must be a nonempty string.');
    }
  }
  // The store key's version never derives from the candidate list: an
  // added part cannot stale an unchanged part's stored answer. The pick
  // records its own question-set version separately on `questionVersion`.
  const cacheVersion = cache?.questionVersion ?? PICK_QUESTION_VERSION;
  // The task's written questions, once per pick and before any decide
  // request, so a writer that fails stops the pick before one is paid for.
  let writtenQuestions: readonly PickCriterion[] = [];
  if (options.writeQuestions !== undefined) {
    let returned: unknown;
    try {
      returned = await options.writeQuestions(options.task, signal);
    } catch (error) {
      throw new Error(`writeQuestions failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (!Array.isArray(returned) || returned.length < 2 || returned.length > 4
      || returned.some((q) => !isRecord(q)
        || [q.instructions, q.true, q.false].some((text) => typeof text !== 'string' || !text.trim()))) {
      throw new TypeError('writeQuestions must return 2 to 4 questions, each with nonempty instructions, true and false.');
    }
    writtenQuestions = (returned as PickCriterion[]).map((q, index) => ({
      key: WRITTEN_QUESTION_KEYS[index]!, instructions: q.instructions, true: q.true, false: q.false,
    }));
  }
  // The task's names, once per pick and before any decide request, when
  // a source opened name lanes or a source's set asks about names.
  const names = Object.values(options.questionsBySource ?? {}).some((set) => set.named !== undefined)
    || Object.values(options.readsBySource ?? {}).some((read) => read.given?.includes('names') === true)
    ? await findTaskNames(options) : undefined;
  let cacheAsked = 0;
  let cacheReused = 0;
  let cacheFailedWrites = 0;
  let cacheWriteError: unknown;
  // The parts the decide port was asked at least one task question
  // about, and the task questions sent, every round included; an
  // answer the decision cache or an identical text supplied was never
  // asked, so it does not count.
  const sentParts = new Set<MemoryCandidate>();
  let sentQuestions = 0;

  const priority = new Map<MemoryCandidate, number>();
  const rules = rankAndInterleave(candidates.filter((c) => c.role === 'rule'), priority, undefined, options.ranking);
  const references = rankAndInterleave(candidates.filter((c) => c.role === 'reference'), priority, undefined, options.ranking);
  // The history's size: the reference parts given, and the parts of a
  // sized history no lane kept, which are counted and never given.
  const givenBySource = new Map<string, number>();
  for (const candidate of references) givenBySource.set(candidate.sourceId, (givenBySource.get(candidate.sourceId) ?? 0) + 1);
  const unheld: Record<string, number> = Object.fromEntries(Object.entries(options.historySizeBySource ?? {})
    .map(([id, size]) => [id, Math.max(0, size - (givenBySource.get(id) ?? 0))]));
  const historySize = references.length + Object.values(unheld).reduce((total, count) => total + count, 0);

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
  // With a decide-feed dial on and the label gate off a pool-only part
  // can never be admitted to the feed: it still counts toward the
  // history size the dial reads from `references`, but it stays out of
  // the queue and the record rather than record a reason that is not
  // true — the rare-word round can still pull one in, and only then
  // does it join the record. With no dial it keeps the record it
  // always had: unasked, 'unassessed' with reason 'limits'.
  // A part the task's period brought in is admitted like a lane member.
  const windowed = (candidate: MemoryCandidate) => candidate.dateWindow !== undefined && options.taskPeriod !== false;
  // Under the fused order every reference part joins the queue, and a
  // part outside the order's reach records 'feed' rather than sit
  // outside the record.
  const admitted = (candidate: MemoryCandidate) =>
    fused
      || kindsFor(candidate).length > 0 || (topK === undefined && !rareForSource(candidate.sourceId))
      || candidate.poolOnly !== true || windowed(candidate);
  for (const candidate of references) {
    if (admitted(candidate)) queue.push(candidate);
  }

  const lanes = queue.reduce((count, candidate) => Math.max(count, candidate.searchRanks?.length ?? 1), 1);
  const eligible = new Set<MemoryCandidate>();
  // The lanes that held each eligible part inside their limit, for the record's `effects`.
  const laneHeld = new Map<MemoryCandidate, Set<number>>();
  // With the label gate on, lane members a lane's candidate limit cut
  // are tracked, so the reason they were never asked stays 'limits'.
  const laneCut = new Set<MemoryCandidate>();
  // Each source's ranked reference parts and how many the feed cut
  // left undecided, for the record's `effects`.
  const rankedBySource = new Map<string, number>();
  const cutBySource = new Map<string, number>();
  // The reference parts of the fused order inside any feed size, in
  // order: the decide feed follows it.
  const insideDepth = new Set<MemoryCandidate>();
  const insideOrder: MemoryCandidate[] = [];
  // Each fused-order member's place score, for the label lane's reorder.
  const fusedScore = new Map<MemoryCandidate, number>();
  if (fused) {
    // The fused order: one cross-source ranking in which a part's place
    // is the better of its best keyword lane's share of that lane (a
    // keyword lane is one `searchRanks` index across every source) and
    // its position in the history's own best-similarity ranking, so a
    // strong match in any lane places it. Equal places keep the
    // queue's order.
    const meaningLane = (candidate: MemoryCandidate, index: number) =>
      options.readsBySource?.[candidate.sourceId]?.lanes[index] === 'meaning';
    const laneLength = new Map<number, number>();
    for (const candidate of queue) {
      candidate.searchRanks?.forEach((rank, index) => {
        if (rank === null || meaningLane(candidate, index)) return;
        laneLength.set(index, (laneLength.get(index) ?? 0) + 1);
      });
    }
    // A lane's candidate limit bounds which of its members enter the
    // order: each lane's own slice, before any feed size, the same
    // limit the lane feeds below apply. Parts a lane's limit cut keep
    // 'limits', the reason the decide step never reached them, so a
    // memory run over them stays an incomplete collection.
    const present = (candidate: MemoryCandidate, lane: number) => candidate.poolOnly !== true
      && (candidate.searchRanks === undefined || candidate.searchRanks[lane] != null);
    const heldByLane: Set<MemoryCandidate>[] = [];
    for (let lane = 0; lane < lanes; lane += 1) {
      const laneQueue = lanes === 1 ? queue.filter((candidate) => present(candidate, lane)) : [
        ...rankAndInterleave(rules.filter((c) => c.applies !== 'always' && present(c, lane)), new Map(), lane, options.ranking),
        ...rankAndInterleave(references.filter((c) => present(c, lane)), new Map(), lane, options.ranking),
      ];
      const held = new Set(laneQueue.slice(0, limits.maxCandidates));
      heldByLane.push(held);
      for (const candidate of held) {
        laneHeld.set(candidate, (laneHeld.get(candidate) ?? new Set()).add(lane));
      }
      for (const candidate of laneQueue.slice(limits.maxCandidates)) laneCut.add(candidate);
    }
    // A part enters the fused order when any lane's slice permitted
    // it. The meaning position is the part's own place in the
    // history's best-similarity ranking, read for whatever the union
    // admitted: the limit acts on each meaning lane itself, like
    // every other lane, not on one combined similarity ranking.
    const byMeaning = [...references].sort((left, right) =>
      (right.meaningScore ?? Number.NEGATIVE_INFINITY) - (left.meaningScore ?? Number.NEGATIVE_INFINITY));
    const meaningPlace = new Map<MemoryCandidate, number>();
    byMeaning.forEach((candidate, index) => {
      if (candidate.meaningScore !== undefined) {
        meaningPlace.set(candidate, (historySize - index) / historySize);
      }
    });
    const permitted = (candidate: MemoryCandidate) =>
      heldByLane.some((held) => held.has(candidate)) || windowed(candidate);
    for (const candidate of queue) {
      if (candidate.role !== 'reference' || !permitted(candidate)) continue;
      let score = meaningPlace.get(candidate) ?? 0;
      candidate.searchRanks?.forEach((rank, index) => {
        if (rank === null || meaningLane(candidate, index) || !heldByLane[index]?.has(candidate)) return;
        score = Math.max(score, (laneLength.get(index)! - rank) / laneLength.get(index)!);
      });
      if (score > 0 || windowed(candidate)) fusedScore.set(candidate, score);
    }
    // A history no lane positioned at all decides in its queue order:
    // every equal zero place keeps it, but a pool member no lane held
    // is not decided for it, since 'count' pool parts exist to size
    // the history, not to reach the feed.
    if (fusedScore.size === 0) {
      for (const candidate of queue) {
        if (candidate.role === 'reference' && permitted(candidate)) fusedScore.set(candidate, 0);
      }
    }
    // `feed.order: 'combsum'`: the order reads the sum of a part's
    // lane places, so a part several lanes agree on outranks one a
    // single lane placed first. A meaning lane's place is the part's
    // place among its own source's members of that lane; a names lane
    // adds nothing. The label lane still reads `fusedScore`.
    const feedScore = options.feed === undefined ? fusedScore : new Map<MemoryCandidate, number>();
    if (options.feed !== undefined) {
      const meaningLength = new Map<string, number>();
      for (const candidate of queue) {
        candidate.searchRanks?.forEach((rank, index) => {
          if (rank === null || !meaningLane(candidate, index)) return;
          const key = `${candidate.sourceId}\0${index}`;
          meaningLength.set(key, (meaningLength.get(key) ?? 0) + 1);
        });
      }
      for (const candidate of fusedScore.keys()) {
        let sum = 0;
        candidate.searchRanks?.forEach((rank, index) => {
          if (rank === null || options.readsBySource?.[candidate.sourceId]?.lanes[index] === 'names') return;
          if (meaningLane(candidate, index)) sum += 1 - rank / meaningLength.get(`${candidate.sourceId}\0${index}`)!;
          else if (heldByLane[index]?.has(candidate)) sum += (laneLength.get(index)! - rank) / laneLength.get(index)!;
        });
        feedScore.set(candidate, sum);
      }
    }
    for (const candidate of [...fusedScore.keys()].sort((left, right) => feedScore.get(right)! - feedScore.get(left)!)) {
      if (insideOrder.length === depth) break;
      eligible.add(candidate);
      insideDepth.add(candidate);
      insideOrder.push(candidate);
    }
    // Each source's ranked parts, and how many the feed size left
    // undecided, for the record's `effects`.
    for (const candidate of fusedScore.keys()) {
      rankedBySource.set(candidate.sourceId, (rankedBySource.get(candidate.sourceId) ?? 0) + 1);
    }
    // 'feed' names only the order's reach: a part the feed size left
    // out of the order, or a part no lane positioned at all. A part a
    // lane's candidate limit cut keeps 'limits', the same reason it
    // carries under the everyRanked feed, so memory() still rejects the
    // collection.
    for (const candidate of queue) {
      if (candidate.role === 'reference' && !insideDepth.has(candidate)) {
        if (fusedScore.has(candidate)) {
          cutBySource.set(candidate.sourceId, (cutBySource.get(candidate.sourceId) ?? 0) + 1);
        }
        statuses.set(candidate, { status: 'unassessed',
          reason: fusedScore.has(candidate) || !laneCut.has(candidate) ? 'feed' : 'limits' });
      }
    }
  } else {
    for (let lane = 0; lane < lanes; lane += 1) {
      const present = (candidate: MemoryCandidate) => candidate.poolOnly !== true
        && (candidate.searchRanks === undefined || candidate.searchRanks[lane] != null);
      const laneQueue = lanes === 1 ? queue.filter(present) : [
        ...rankAndInterleave(rules.filter((c) => c.applies !== 'always' && present(c)), new Map(), lane, options.ranking),
        ...rankAndInterleave(references.filter(present), new Map(), lane, options.ranking),
      ];
      for (const candidate of laneQueue.slice(0, limits.maxCandidates)) {
        eligible.add(candidate);
        laneHeld.set(candidate, (laneHeld.get(candidate) ?? new Set()).add(lane));
      }
      if (labelsOn) {
        for (const candidate of laneQueue.slice(limits.maxCandidates)) laneCut.add(candidate);
      }
    }
    for (const candidate of queue) if (windowed(candidate)) eligible.add(candidate);
  }
  let feed = !fused
    ? queue.filter((candidate) => eligible.has(candidate))
    : queue.filter((candidate) => candidate.role !== 'reference').concat(insideOrder);
  // Set when the label gate fused its lane into the keyword order: the
  // ranking the record's pick field then names as 'fusion'.
  let feedFused = false;
  const answered = new Map<MemoryCandidate, Map<string, CheckedAnswer>>();
  // Label asks keep their own store: the decision cache never sees
  // them. Declared beside `answered` so `ask` can tell the two sinks
  // apart.
  const labelAnswers = new Map<MemoryCandidate, Map<string, CheckedAnswer>>();
  // The answer types the task needed, once the task's questions are
  // answered; a source's typed questions for them join its set.
  let neededTypes: ReadonlySet<AnswerType> = new Set();
  const typedFor = (candidate: MemoryCandidate) => candidate.role !== 'reference' ? []
    : (cascadeFor(candidate)?.typed ?? []).filter((q) => neededTypes.has(q.answerType));
  const writtenFor = (candidate: MemoryCandidate) =>
    candidate.role === 'reference' && cascadeFor(candidate)?.written !== undefined ? writtenQuestions : [];
  // The set's name question, once per name the task names.
  const namedFor = (candidate: MemoryCandidate): PickCriterion[] => {
    const named = candidate.role === 'reference' ? cascadeFor(candidate)?.named : undefined;
    const fill = (text: string, name: string) => text.replaceAll('{name}', () => name);
    return named === undefined ? [] : (names?.found ?? []).map((name, index) => ({
      key: `${named.question.key}${index + 1}`, instructions: fill(named.question.instructions, name),
      true: fill(named.question.true, name), false: fill(named.question.false, name),
    }));
  };
  interface QuestionSpec {
    readonly key: string;
    readonly question: string;
    readonly levels?: readonly string[];
    readonly trueCriterion?: string;
    readonly falseCriterion?: string;
  }
  const specsFor = (candidate: MemoryCandidate): QuestionSpec[] => {
    const cascade = cascadeFor(candidate);
    return candidate.role === 'reference' && cascade
      ? [...cascade.questions, ...typedFor(candidate), ...writtenFor(candidate), ...namedFor(candidate)].map((q) => ({ key: q.key, question: q.instructions,
        ...('levels' in q
          ? { levels: q.levels }
          : { trueCriterion: q.true, falseCriterion: q.false }) }))
      : [{ key: candidate.role, ...(candidate.kind === undefined || (candidate.role === 'rule' && candidate.kind !== 'instructions')
        ? PICK_QUESTIONS[candidate.role] : KIND_QUESTIONS[candidate.kind]) }];
  };
  type Pending = {
    candidate: MemoryCandidate;
    spec: ReturnType<typeof specsFor>[number];
    question: PickQuestion;
    cacheKey?: string;
  };
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
      role: candidate.role, question: spec.question,
      ...(spec.levels === undefined
        ? { trueCriterion: spec.trueCriterion, falseCriterion: spec.falseCriterion }
        : { levels: spec.levels }),
      // The set's anonymousItems renders every ask about its part
      // without identifying fields, whichever sink the ask feeds.
      ...(candidate.role === 'reference' && cascadeFor(candidate)?.anonymousItems === true
        ? { anonymous: true as const } : {}),
      sourceId: candidate.sourceId, id: candidate.id,
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
  const decisionsByText = new Map<string, Pending>();
  // A part with no text is judged by its title, as a title-only
  // commit's subject is, so the title stands in for the text in the
  // sharing key. With text present the title is a byline or locator,
  // and identical texts keep sharing one answer.
  const sharingKey = ({ candidate, question }: Pending) => JSON.stringify([candidate.text,
    candidate.text === '' ? candidate.title : null,
    question.role, question.kind, question.questionKey, question.question,
    question.trueCriterion ?? null, question.falseCriterion ?? null,
    question.levels ?? null, question.anonymous ?? null]);
  // Asks packed into request-sized batches, at most `most` of them.
  const pack = (fresh: readonly Pending[], task: string, whole: boolean, most: number): Pending[][] => {
    const slices: Pending[][] = [];
    for (let index = 0; index < fresh.length && slices.length < most;) {
      // A batch packs whole items until the character bound; the first
      // item always goes, so a single oversized item is sent alone. An
      // item counts once per batch however many of its questions it holds.
      // A `whole` call packs every ask into its one request instead: the
      // task's own label and route questions always ride together.
      const slice: Pending[] = [];
      const counted = new Set<MemoryCandidate>();
      let batchChars = task.length;
      for (let at = index; at < fresh.length && (whole || slice.length < limits.maxPerBatch);) {
        // A model-scored set's questions for one part stay in one
        // request: its score needs every answer, and a batch closed
        // between them would send the part's text twice.
        const item = fresh[at]!;
        let end = at + 1;
        if (cascadeFor(item.candidate)?.model !== undefined) {
          while (end < fresh.length && fresh[end]!.candidate === item.candidate) end += 1;
        }
        const group = fresh.slice(at, end);
        const size = group.reduce((sum, entry) => sum + questionChars(entry.question), 0)
          + (counted.has(item.candidate) ? 0 : itemChars(item.question));
        if (slice.length > 0 && !whole
          && (batchChars + size > limits.maxBatchChars
            || slice.length + group.length > limits.maxPerBatch)) break;
        batchChars += size;
        counted.add(item.candidate);
        slice.push(...group);
        at = end;
      }
      slices.push(slice);
      index += slice.length;
    }
    return slices;
  };
  const ask = async (asks: Pending[], sink = answered, task = options.task, whole = false) => {
    const copies: { item: Pending; first: Pending }[] = [];
    if (sink === answered) {
      asks = asks.filter((item) => {
        const key = sharingKey(item);
        const first = decisionsByText.get(key);
        if (first !== undefined) { copies.push({ item, first }); return false; }
        decisionsByText.set(key, item);
        return true;
      });
    }
    // The decision cache, off by default and never entered by label
    // asks: a stored answer serves its question, and the decider sees
    // only the misses. Answers are reused across batches — the key
    // names the part's question, not the batch around it. Reads run in
    // bounded groups, as the label store's reads do.
    const cacheable = cache !== undefined && sink !== labelAnswers;
    let fresh = asks;
    if (cacheable) {
      fresh = [];
      for (let index = 0; index < asks.length; index += LABEL_STORE_READ_GROUP) {
        // The stopping dials guard the reads the way they guard a
        // batch: before each read group and again before its hits
        // apply, since the signal or the clock can fire while the
        // reads run. A hit applied past a stop would select parts a
        // stopped run never resolved; questions left unread stay
        // unasked and record the stop like any missed batch.
        if (signal.aborted) { stop = 'cancelled'; break; }
        if (limits.maxElapsedMs - (Date.now() - started) <= 0) { stop = 'time'; break; }
        const group = await Promise.all(asks.slice(index, index + LABEL_STORE_READ_GROUP)
          .map(async (item) => {
            const key = decisionKey(task, cacheVersion, cache.deciderId,
              limits.maxQuestionText, item.question, item.candidate.text);
            let stored: ReturnType<typeof storedDecision>;
            try {
              stored = storedDecision(await cache.store.get(key));
            } catch {
              // A failed read is a miss, whatever raised it.
            }
            return { item, key, stored };
          }));
        if (signal.aborted) { stop = 'cancelled'; break; }
        if (limits.maxElapsedMs - (Date.now() - started) <= 0) { stop = 'time'; break; }
        for (const { item, key, stored } of group) {
          if (stored === undefined) {
            fresh.push({ ...item, cacheKey: key });
            continue;
          }
          let got = sink.get(item.candidate);
          if (!got) { got = new Map(); sink.set(item.candidate, got); }
          got.set(item.spec.key, { ...stored, reused: true });
          cacheReused += 1;
          if (sink === answered) {
            truncated.set(item.candidate, Number.isFinite(limits.maxQuestionText)
              && takeCharacters(item.candidate.text, limits.maxQuestionText).truncated);
          }
        }
      }
    }
    // Independent batches of one round go out at once: the round ends
    // only when every sent batch settles, and a later cascade round
    // still waits for this round's answers. Results apply in dispatch
    // order whatever order the replies land in, so answer order never
    // depends on completion order.
    const slices = pack(fresh, task, whole, limits.maxBatches - batches);
    interface BatchOutcome {
      readonly slice: Pending[];
      readonly sent: boolean;
      readonly stop?: 'time' | 'cancelled';
      readonly timedOut: boolean;
      readonly answers?: Record<string, PickAnswer>;
      readonly decideError?: unknown;
    }
    const dispatch = async (slice: Pending[]): Promise<BatchOutcome> => {
      if (signal.aborted) return { slice, sent: false, stop: 'cancelled', timedOut: false };
      const remaining = limits.maxElapsedMs - (Date.now() - started);
      if (remaining <= 0) return { slice, sent: false, stop: 'time', timedOut: false };
      const questions = slice.map((item) => item.question);
      if (cacheable) cacheAsked += slice.length;
      // The decide port was asked these task questions about these
      // parts; copies and cache hits never reached it, so they do not
      // count toward the pick's sent and slot counts.
      if (sink === answered) {
        sentQuestions += slice.length;
        for (const item of slice) sentParts.add(item.candidate);
      }
      try {
        const sent: Promise<Record<string, PickAnswer>> = options.decide({ task, questions }, decideSignal);
        const returned: unknown = await Promise.race([
          sent,
          new Promise<typeof TIMED_OUT>((resolve) => {
            decideDeadline?.addEventListener('abort', () => resolve(TIMED_OUT), { once: true });
          }),
        ]);
        if (returned === TIMED_OUT) {
          // The deadline fired: the decider's own cancellation is still
          // awaited to its end, so every request it sent settles and
          // reports — its record writes included — before this outcome
          // is read and the run returns.
          await sent.then(() => {}, () => {});
          return { slice, sent: true, timedOut: true };
        }
        return { slice, sent: true, timedOut: false,
          ...(isRecord(returned) ? { answers: returned as Record<string, PickAnswer> } : {}) };
      } catch (decideError) {
        return { slice, sent: true, timedOut: decideDeadline?.aborted === true, decideError };
      }
    };
    // At most `maxInFlight` requests of the round are open at once;
    // unbounded, every slice goes out together. A queued slice starts
    // only when an earlier one settles, in dispatch order — and only
    // while no settled outcome would have stopped a sequential round:
    // a rejection, a deadline or a cancellation keeps later queued
    // batches from starting, while batches already running still
    // settle and apply.
    const outcomes: (BatchOutcome | undefined)[] = new Array(slices.length);
    let next = 0;
    let halted = false;
    await Promise.all(Array.from({ length: Math.min(slices.length, limits.maxInFlight) },
      async () => {
        while (!halted && next < slices.length) {
          const at = next;
          next += 1;
          const outcome = await dispatch(slices[at]!);
          outcomes[at] = outcome;
          if (!outcome.sent || outcome.timedOut || outcome.decideError !== undefined) halted = true;
        }
      }));
    for (const outcome of outcomes) {
      // A batch the halt left queued stays unasked like the tail of a
      // stopped sequential run.
      if (outcome === undefined) continue;
      const { slice, sent, stop: unsent, timedOut, answers, decideError } = outcome;
      if (!sent) { stop ??= unsent; continue; }
      batches += 1;
      // A rejected batch is reported, not swallowed: the record names
      // the batch's candidate ids and the error's message, and the pick
      // fails on it; no retry and no fallback. A call the elapsed limit
      // or the caller's signal already stopped ends the run, not the pick.
      const failed = decideError !== undefined && !timedOut && !signal.aborted;
      if (failed) {
        decideFailure ??= {
          ids: [...new Set(slice.map(({ question }) => question.id))],
          message: decideError instanceof Error ? decideError.message : String(decideError),
          error: decideError,
        };
        if (sink === answered) for (const item of slice) decideFailed.add(item.candidate);
      }
      for (const { candidate, spec, question, cacheKey } of slice) {
        const answer: CheckedAnswer = timedOut
          ? { status: 'error', detail: 'The decide call did not finish before the elapsed limit.' }
          : answers === undefined
            ? { status: 'error', detail: decideError instanceof Error ? decideError.message
                : decideError === undefined ? 'The decide call failed.' : String(decideError) }
            : checkAnswer(answers[question.key], question.levels?.length);
        let got = sink.get(candidate);
        if (!got) { got = new Map(); sink.set(candidate, got); }
        got.set(spec.key, answer);
        // Only a fully answered result is stored: a refusal, a missing
        // answer, an error or a cancelled call is never written, so the
        // store can never hold one. A failed write keeps the answer and
        // the record warns once.
        if (cacheKey !== undefined && answer.status === 'answered') {
          try {
            await cache!.store.set(cacheKey,
              { answer: { status: 'answered',
                ...('probability' in answer ? { probability: answer.probability }
                  : { probabilities: answer.probabilities }),
                ...(answer.truncated === true ? { truncated: true } : {}) } });
          } catch (error) {
            cacheFailedWrites += 1;
            cacheWriteError ??= error;
          }
        }
        // `truncated` marks a decision item the text cut shortened; a
        // label ask never sends one, so the flag belongs to the decide
        // sink only.
        if (sink === answered) {
          truncated.set(candidate, Number.isFinite(limits.maxQuestionText)
            && takeCharacters(candidate.text, limits.maxQuestionText).truncated);
        }
      }
      // The first batch in dispatch order that would have ended a
      // sequential run sets the stop; later outcomes still apply.
      stop ??= timedOut ? 'time' : failed ? 'error' : undefined;
    }
    // The packing stopped at the batch cap with asks unasked, or the
    // signal or clock fired while the sent batches were in flight.
    if (stop === undefined) {
      if (signal.aborted) stop = 'cancelled';
      else if (slices.reduce((sum, slice) => sum + slice.length, 0) < fresh.length) stop = 'limits';
    }
    // Copies keep their source identity and score with their own question set.
    // Only the answer to the identical text and question is shared.
    for (const { item, first } of copies) {
      const answer = sink.get(first.candidate)?.get(first.spec.key);
      if (answer === undefined) continue;
      let got = sink.get(item.candidate);
      if (got === undefined) { got = new Map(); sink.set(item.candidate, got); }
      got.set(item.spec.key, answer);
      if (truncated.has(first.candidate)) truncated.set(item.candidate, truncated.get(first.candidate)!);
      if (decideFailed.has(first.candidate)) decideFailed.add(item.candidate);
    }
  };

  // Each source's kinds label its reference parts and the task through
  // the same decide port, once per kind set and item's text. The label
  // lane — parts at the bar on a kind the question needs — joins the
  // keyword lanes' set, and reciprocal-rank fusion of the two orders
  // decides what the decide step sees first.
  let labelRecord: PickRecord['labels'];
  let routeRecord: PickRecord['route'];
  // The label lane and the kinds the task needed, by source, for the
  // record's `effects`.
  let labelLane: ReadonlySet<MemoryCandidate> = new Set();
  const labelNeeds = new Map<string, readonly string[]>();
  // Label sets the store held or the decide port answered this pick.
  // The lane check below reads them; so does the unassessed reason at
  // the end, where a part with no entry was never resolved by the gate.
  const labels = new Map<MemoryCandidate, PartLabels>();
  const labelTasks = new Map<MemoryCandidate, MemoryCandidate>();
  // The task item the kind questions — and, with `route: 'jev'`, the
  // four route questions — describe. Route questions ride the task's
  // own ask: the kind-label batch when that runs, a standalone one
  // otherwise, so the route costs one request per pick either way.
  const taskItem: MemoryCandidate = {
    sourceId: 'labels', id: 'question', role: 'reference',
    title: 'The question asked', text: options.task, signals: {},
  };
  const routePending = (route: (typeof ROUTE_QUESTIONS)[number]): Pending => ({
    candidate: taskItem,
    spec: {
      key: route.key, question: route.question,
      trueCriterion: route.trueCriterion, falseCriterion: route.falseCriterion,
    },
    question: {
      key: JSON.stringify([taskItem.sourceId, taskItem.id, route.key]),
      questionKey: route.key,
      role: 'reference' as const,
      question: route.question,
      trueCriterion: route.trueCriterion, falseCriterion: route.falseCriterion,
      sourceId: taskItem.sourceId, id: taskItem.id,
      title: taskItem.title, text: taskItem.text,
    },
  });
  // The answer types have their own answer item: a route or kind key
  // can match a type's key.
  const answerItem: MemoryCandidate = { ...taskItem };
  const answerPending = (type: (typeof ANSWER_TYPES)[number]): Pending => ({
    candidate: answerItem,
    spec: {
      key: type.key, question: type.question,
      trueCriterion: type.trueCriterion, falseCriterion: type.falseCriterion,
    },
    question: {
      key: JSON.stringify([taskItem.sourceId, taskItem.id, 'answerType', type.key]),
      questionKey: type.key,
      role: 'reference' as const,
      question: type.question,
      trueCriterion: type.trueCriterion, falseCriterion: type.falseCriterion,
      sourceId: taskItem.sourceId, id: taskItem.id,
      title: taskItem.title, text: taskItem.text,
    },
  });
  let routeAskedWithLabels = false;
  let typesAskedWithLabels = false;
  if (labelsOn) {
    if (typeof labelOptions.directory !== 'string' || !labelOptions.directory.trim()) {
      throw new TypeError('labels.directory must be a nonempty path.');
    }
    if (typeof labelOptions.deciderId !== 'string' || !labelOptions.deciderId.trim()) {
      throw new TypeError('labels.deciderId must be a nonempty string.');
    }
    const questionVersion = labelOptions.questionVersion ?? LABEL_QUESTION_VERSION;
    if (!questionVersion.trim()) {
      throw new TypeError('labels.questionVersion must be a nonempty string.');
    }
    const store = labelFileStore(labelOptions.directory);
    const chatKindsKey = labelKindsKey(LABEL_KINDS);
    type KindSet = { key: string; kinds: readonly LabelKind[]; task: MemoryCandidate;
      parts: MemoryCandidate[] };
    const sets = new Map<string, KindSet>();
    const sourceSets = new Map<string, KindSet>();
    for (const [id, kinds] of Object.entries(labelKindsBySource)) {
      if (!kinds.length) continue;
      const key = labelKindsKey(kinds);
      let set = sets.get(key);
      if (set === undefined) {
        set = { key, kinds, task: { ...taskItem, id: sets.size === 0 ? 'question' : `question:${key}` },
          parts: [] };
        sets.set(key, set);
      }
      sourceSets.set(id, set);
    }
    // Labels follow the fused order: under it a label question is asked
    // only of the order's parts inside any feed size, never of a part
    // no search lane placed. The label lane reorders the order before
    // the read, so its labels are asked before any rating stop runs.
    for (const candidate of !fused ? queue : feed) {
      const set = sourceSets.get(candidate.sourceId);
      if (candidate.role !== 'reference' || set === undefined) continue;
      set.parts.push(candidate);
      labelTasks.set(candidate, set.task);
    }
    let asked = 0;
    let reused = 0;
    let waited = 0;
    let failedWrites = 0;
    let writeError: unknown;
    for (const set of sets.values()) {
      if (!set.parts.length) continue;
      const chat = set.key === chatKindsKey;
      // Identical text shares labels only inside the same kind set.
      const byKey = new Map<string, MemoryCandidate[]>();
      for (const item of [...set.parts, set.task]) {
        const key = labelKey(questionVersion, labelOptions.deciderId, item.text,
          item === set.task ? 'question' : 'part', set.key);
        const group = byKey.get(key);
        if (group === undefined) byKey.set(key, [item]);
        else group.push(item);
      }
      const misses: { key: string; items: MemoryCandidate[] }[] = [];
      const flight = (key: string) => `${resolve(labelOptions.directory)}\n${key}`;
      const settles = new Map<string, (value: PartLabels | undefined) => void>();
      const askParts = (partMisses: typeof misses) => ask(partMisses.flatMap(({ items }) => set.kinds.map((kind) => {
        const candidate = items[0]!;
        const item = pending(candidate, { key: kind.key, ...labelPartQuestion(kind) });
        return { ...item, question: { ...item.question,
          key: JSON.stringify([candidate.sourceId, candidate.id, kind.key]),
          questionKey: kind.key, text: candidate.text } };
      })), labelAnswers, chat ? LABEL_PARTS_TASK
        : 'Label short excerpts from source material. Each question names one item.');
      const keep = async (answeredMisses: typeof misses) => {
        for (const { key, items } of answeredMisses) {
          const answers = set.kinds.map((kind) => labelAnswers.get(items[0]!)?.get(kind.key));
          // Incomplete sets are retried, never stored as complete labels.
          if (!answers.every((answer) => answer?.status === 'answered')) continue;
          const value = Object.fromEntries(set.kinds.map((kind, index) =>
            [kind.key, (answers[index] as { readonly probability: number }).probability]));
          for (const item of items) labels.set(item, value);
          try {
            await store.set(key, { labels: value });
          } catch (error) {
            failedWrites += 1;
            writeError ??= error;
          }
        }
      };
      const keyed = [...byKey].map(([key, items]) => ({ key, items }));
      let round = keyed;
      while (round.length > 0) {
        // Before any wait, a part another pick is asking for is joined and
        // every other part is entered as this pick's, so no pick that
        // finishes meanwhile is asked again. A part whose entry settled
        // with nothing goes round again and is joined or entered afresh.
        const waits: { key: string; items: MemoryCandidate[]; labels: Promise<PartLabels | undefined> }[] = [];
        const own = round.filter(({ key, items }) => {
          if (items[0] === set.task) return true;
          const asking = labelsInFlight.get(flight(key));
          if (asking !== undefined) {
            waits.push({ key, items, labels: asking });
            return false;
          }
          labelsInFlight.set(flight(key), new Promise((settle) => settles.set(key, (value) => {
            settles.delete(key);
            labelsInFlight.delete(flight(key));
            settle(value);
          })));
          return true;
        });
        const roundMisses: typeof misses = [];
        // A cancelled pick releases its entries at once, even while a
        // decide call that ignores the signal is still running.
        const release = () => { for (const settle of [...settles.values()]) settle(undefined); };
        signal.addEventListener('abort', release, { once: true });
        try {
          for (let index = 0; index < own.length; index += LABEL_STORE_READ_GROUP) {
            const entries = await Promise.all(own.slice(index, index + LABEL_STORE_READ_GROUP)
              .map(async ({ key, items }) => ({ key, items, stored: storedLabels(await store.get(key), set.kinds) })));
            for (const { key, items, stored } of entries) {
              if (stored === undefined) roundMisses.push({ key, items });
              else {
                reused += 1;
                for (const item of items) labels.set(item, stored);
                // A waiter reads the stored labels itself and counts them as reused.
                settles.get(key)?.(undefined);
              }
            }
          }
          misses.push(...roundMisses);
          if (!stop && roundMisses.some(({ items }) => items[0] === set.task)) {
            const withRoute: boolean = options.route === 'jev' && !routeAskedWithLabels;
            const withTypes: boolean = answerTypesBar !== undefined && !typesAskedWithLabels;
            await ask([
              ...set.kinds.map((kind) => ({
                candidate: set.task,
                spec: { key: kind.key, ...labelTaskQuestion(kind, chat) },
                question: {
                  key: JSON.stringify(chat ? [set.task.sourceId, set.task.id, kind.key]
                    : [set.task.sourceId, set.task.id, 'label', set.key, kind.key]),
                  questionKey: kind.key, role: 'reference' as const,
                  ...labelTaskQuestion(kind, chat),
                  sourceId: set.task.sourceId, id: set.task.id,
                  title: set.task.title, text: set.task.text,
                },
              })),
              // Routes have their own answer item, even when a kind has the same key.
              ...(withRoute ? ROUTE_QUESTIONS.map(routePending) : []),
              ...(withTypes ? ANSWER_TYPES.map(answerPending) : []),
            ], labelAnswers, labelQuestionTask(options.task), withRoute || withTypes);
            routeAskedWithLabels ||= withRoute;
            typesAskedWithLabels ||= withTypes;
          }
          const partMisses = roundMisses.filter(({ items }) => items[0] !== set.task);
          if (!stop && partMisses.length > 0) await askParts(partMisses);
          await keep(roundMisses);
        } finally {
          signal.removeEventListener('abort', release);
          for (const { key, items } of own) settles.get(key)?.(labels.get(items[0]!));
        }
        // The waits honour this pick's own stopping dials.
        if (stop || waits.length === 0) break;
        const remaining = limits.maxElapsedMs - (Date.now() - started);
        const until = Number.isFinite(remaining)
          ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(0, Math.ceil(remaining)))]) : signal;
        const got = until.aborted ? undefined : await Promise.race([
          Promise.all(waits.map((wait) => wait.labels)),
          new Promise<undefined>((settle) => until.addEventListener('abort', () => settle(undefined), { once: true })),
        ]);
        if (got === undefined) {
          stop = signal.aborted ? 'cancelled' : 'time';
          break;
        }
        round = waits.filter((wait, index) => {
          const value = got[index];
          if (value === undefined) return true;
          waited += 1;
          for (const item of wait.items) labels.set(item, value);
          return false;
        });
      }
      asked += misses.filter(({ items }) => labelAnswers.has(items[0]!)).length;
    }
    // The task's needs come from its kind set's labels, at each source's
    // own bar, so two sources sharing a set can need different kinds.
    for (const [id, set] of sourceSets) {
      labelNeeds.set(id, set.kinds.filter((kind) => (labels.get(set.task)?.[kind.key] ?? 0) >= labelBarFor(id))
        .map((kind) => kind.key));
    }
    const strength = (candidate: MemoryCandidate) => {
      const own = labels.get(candidate);
      const needs = labelNeeds.get(candidate.sourceId) ?? [];
      return own === undefined || !needs.length ? 0 : Math.max(0, ...needs.map((kind) => own[kind] ?? 0));
    };
    const inLane = new Set(queue.filter((candidate) =>
      candidate.role === 'reference' && strength(candidate) >= labelBarFor(candidate.sourceId)));
    labelLane = inLane;
    if (!fused) {
      for (const candidate of inLane) eligible.add(candidate);
      feed = queue.filter((candidate) => eligible.has(candidate));
      if ([...labelNeeds.values()].some((needs) => needs.length > 0)) {
        feed = fuseLabelLane(feed, queue, inLane, strength);
        feedFused = true;
      }
    } else {
      // The label lane is one more list in the fused order, but it is
      // resolved only inside any feed size: it reorders the order the
      // read follows and can never admit a part to it.
      const byStrength = [...inLane].sort((left, right) =>
        strength(right) - strength(left) || left.id.localeCompare(right.id));
      const share = new Map(byStrength.map((candidate, index) =>
        [candidate, (byStrength.length - index) / byStrength.length] as const));
      insideOrder.sort((left, right) =>
        Math.max(fusedScore.get(right)!, share.get(right) ?? 0)
          - Math.max(fusedScore.get(left)!, share.get(left) ?? 0));
      feed = feed.filter((candidate) => candidate.role !== 'reference').concat(insideOrder);
      feedFused = true;
    }
    labelRecord = {
      questionVersion, deciderId: labelOptions.deciderId, asked, reused,
      ...(waited === 0 ? {} : { waited }),
      gate: feed.length, failedWrites,
      ...(failedWrites === 0 ? {} : {
        warning: `${failedWrites} label set(s) could not be stored `
          + `(${writeError instanceof Error ? writeError.message : String(writeError)}); this pick used them, `
          + 'and the next pick asks for them again.',
      }),
    };
  }

  // The route and answer-type questions, together in one request when
  // the task's label ask did not carry them — labels unset, or the
  // task's set reused from the store.
  const routeAlone = options.route === 'jev' && !routeAskedWithLabels;
  const typesAlone = answerTypesBar !== undefined && !typesAskedWithLabels;
  if (!stop && (routeAlone || typesAlone)) {
    await ask([
      ...(routeAlone ? ROUTE_QUESTIONS.map(routePending) : []),
      ...(typesAlone ? ANSWER_TYPES.map(answerPending) : []),
    ], labelAnswers, labelQuestionTask(options.task), true);
  }
  if (options.route === 'jev') {
    const got = labelAnswers.get(taskItem);
    const answers: ({ readonly key: RouteKey } & PickAnswer)[] = ROUTE_QUESTIONS.map((route) => ({
      key: route.key,
      ...(got?.get(route.key)
        ?? { status: 'unassessed' as const, ...(stop === undefined ? {} : { detail: stop }) }),
    }));
    routeRecord = {
      answers,
      on: routeOptions(Object.fromEntries(answers.flatMap((answer) =>
        answer.status === 'answered' && 'probability' in answer
          ? [[answer.key, answer.probability] as const] : []))),
    };
  }
  let answerTypesRecord: PickRecord['answerTypes'];
  if (answerTypesBar !== undefined) {
    const got = labelAnswers.get(answerItem);
    const answers: ({ readonly key: AnswerType } & PickAnswer)[] = ANSWER_TYPES.map((type) => ({
      key: type.key,
      ...(got?.get(type.key)
        ?? { status: 'unassessed' as const, ...(stop === undefined ? {} : { detail: stop }) }),
    }));
    const needed = answers.filter((answer) => answer.status === 'answered'
      && 'probability' in answer && answer.probability >= answerTypesBar)
      .map((answer) => answer.key);
    neededTypes = new Set(needed);
    answerTypesRecord = { bar: answerTypesBar, answers, needed };
  }

  // With `everyRanked` off the decide step reads only the top
  // round(c × N^0.8) reference parts of the ranking the lanes and the
  // label gate left, where N is every reference part the pick received
  // — the history, which pickFromSources keeps whole by reading the
  // source's full pool. Rules pass through uncounted and uncut: the
  // cut caps ranked parts, not the rules a task must answer. A part
  // below the keep count is never asked and records 'unassessed' with
  // reason 'pick'.
  let pickRecord: PickRecord['pick'];
  if (dial && topK !== undefined) {
    const bound = Math.min(references.length, Math.round(topK * Math.pow(references.length, 0.8)));
    let rank = 0;
    feed = feed.filter((candidate) => {
      if (candidate.role !== 'reference') return true;
      rank += 1;
      rankedBySource.set(candidate.sourceId, (rankedBySource.get(candidate.sourceId) ?? 0) + 1);
      if (rank <= bound) return true;
      cutBySource.set(candidate.sourceId, (cutBySource.get(candidate.sourceId) ?? 0) + 1);
      statuses.set(candidate, { status: 'unassessed', reason: 'pick' });
      return false;
    });
  }

  const combined = new Map<MemoryCandidate, CheckedAnswer>();
  // Each part's score without its typed terms, and without its written
  // terms, for the record's `effects`.
  const untyped = new Map<MemoryCandidate, number>();
  const unwritten = new Map<MemoryCandidate, number>();
  const unnamed = new Map<MemoryCandidate, number>();
  // The typed question whose answer reached its keepAt, by part.
  const keptBy = new Map<MemoryCandidate, string>();
  // Each source's code-fact population, measured once over its whole
  // candidate list when a model-scored set needs it.
  const judgmentPools = new Map<string, JudgmentPopulation>();
  const populationFor = (sourceId: string) => {
    let pool = judgmentPools.get(sourceId);
    if (pool === undefined) {
      pool = judgmentPopulation(candidates.filter((candidate) => candidate.sourceId === sourceId));
      judgmentPools.set(sourceId, pool);
    }
    return pool;
  };
  // Candidates a stop left half-assessed inside a cascade.
  const curtailed = new Map<MemoryCandidate, 'limits' | 'time' | 'cancelled' | 'error'>();
  // A part's first-round asks: every question, or a cascade's first.
  const firstAsks = (candidate: MemoryCandidate) => specsFor(candidate)
    .filter((spec) => candidate.role === 'rule' || !cascadeFor(candidate)?.first || spec.key === cascadeFor(candidate)!.first)
    .map((spec) => pending(candidate, spec));
  const evaluate = async (phase: readonly MemoryCandidate[]) => {
    await ask(phase.flatMap(firstAsks));
    if (!stop) {
      await ask(phase.flatMap((candidate) => {
        const cascade = cascadeFor(candidate);
        if (candidate.role === 'rule' || !cascade?.first) return [];
        const first = answered.get(candidate)?.get(cascade.first);
        if (first?.status !== 'answered' || !('probability' in first)
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
        if (first?.status === 'answered' && 'probability' in first
          && (first.probability < cascade.band![0] || first.probability > cascade.band![1])) {
          answer = { status: 'answered', probability: 1 / (1 + Math.exp(-(cascade.firstOnly!.bias + cascade.firstOnly!.weight * logit(first.probability)))),
            ...(first.reused === true ? { reused: true } : {}) };
        } else {
          // A returned missing answer contributes nothing, as in the prototype.
          // A question never attempted because a limit stopped us is unassessed.
          const typed = typedFor(candidate);
          const written = writtenFor(candidate);
          const named = namedFor(candidate);
          const asked = [...cascade.questions, ...typed, ...written, ...named];
          if (stop && asked.some((q) => !got.has(q.key))
            && (!cascade.first || first?.status === 'answered')) {
            curtailed.set(candidate, stop);
            continue;
          }
          const probabilities = asked.map((q) => got.get(q.key));
          if (probabilities.some((a) => a?.status === 'answered')) {
            if (cascade.model !== undefined) {
              // A noul answer joins as logit(p); a levelled answer as
              // its expected level; a missing one is imputed at mu.
              // The raw facts hold the part's index and rank; the score
              // consumes them as shares of the pool, as the fit did.
              const facts = judgmentFacts(candidate, populationFor(candidate.sourceId), options.task, taskMs);
              const features: Record<string, number | undefined> = {
                ...facts,
                position: facts.position / (facts.poolSize || 1),
                kwRank: facts.kwRank === undefined ? undefined : facts.kwRank / (facts.poolSize || 1),
              };
              for (const q of cascade.questions) {
                const a = got.get(q.key);
                features[q.key] = a?.status === 'answered'
                  ? 'levels' in q && q.levels !== undefined
                    ? ('probabilities' in a
                      ? a.probabilities.reduce<number>((sum, p, index) => sum + index * p, 0) : undefined)
                    : ('probability' in a ? logit(a.probability) : undefined)
                  : undefined;
              }
              answer = { status: 'answered', probability: modelScore(cascade.model, features),
                ...(probabilities.every((a) => a === undefined || (a.status === 'answered' && a.reused === true))
                  ? { reused: true } : {}) };
            } else {
            const term = (q: { readonly weight?: number }, a: CheckedAnswer | undefined) =>
              a?.status === 'answered' && 'probability' in a ? (q.weight ?? 0) * logit(a.probability) : 0;
            const z = (cascade.bias ?? 0) + cascade.questions.reduce((sum, q, i) => sum + term(q, probabilities[i]), 0);
            const typedZ = typed.reduce((sum, q, i) => sum + term(q, probabilities[cascade.questions.length + i]), 0);
            // The best and second-best written answers; a missing one adds nothing.
            const [highest, second] = written.flatMap((q) => {
              const reply = got.get(q.key);
              return reply?.status === 'answered' && 'probability' in reply ? [reply.probability] : [];
            }).sort((left, right) => right - left);
            const writtenZ = cascade.written === undefined ? 0
              : (highest === undefined ? 0 : cascade.written.highest * writtenLogit(highest))
                + (second === undefined ? 0 : cascade.written.second * writtenLogit(second));
            // The highest name answer; with none answered only hasNames is added.
            const best = named.flatMap((q) => {
              const reply = got.get(q.key);
              return reply?.status === 'answered' && 'probability' in reply ? [reply.probability] : [];
            }).reduce<number | undefined>((top, p) => top === undefined || p > top ? p : top, undefined);
            const namedZ = named.length === 0 ? 0
              : cascade.named!.hasNames + (best === undefined ? 0 : cascade.named!.highest * writtenLogit(best));
            if (typed.length > 0) untyped.set(candidate, 1 / (1 + Math.exp(-(z + writtenZ + namedZ))));
            if (written.length > 0) unwritten.set(candidate, 1 / (1 + Math.exp(-(z + typedZ + namedZ))));
            if (named.length > 0) unnamed.set(candidate, 1 / (1 + Math.exp(-(z + typedZ + writtenZ))));
            const keeper = typed.find((q) => {
              const reply = got.get(q.key);
              return q.keepAt !== undefined && reply?.status === 'answered'
                && 'probability' in reply && reply.probability >= q.keepAt;
            });
            if (keeper !== undefined) keptBy.set(candidate, keeper.key);
            answer = { status: 'answered', probability: 1 / (1 + Math.exp(-(z + typedZ + writtenZ + namedZ))),
              // The verdict reused the store only when every answer
              // behind it did: a question this pick asked — even one
              // that came back unanswered — keeps it fresh.
              ...(probabilities.every((a) => a === undefined || (a.status === 'answered' && a.reused === true))
                ? { reused: true } : {}) };
            }
          } else answer = first ?? got.values().next().value ?? { status: 'missing' };
        }
      } else answer = got.values().next().value!;
      combined.set(candidate, answer);
    }
  };

  // The reference parts of `parts` the decide step answered: the count
  // a size-based bar reads.
  const answeredReferences = (parts: readonly MemoryCandidate[]) => parts.reduce((total, candidate) =>
    total + Number(candidate.role === 'reference' && combined.get(candidate)?.status === 'answered'), 0);
  // The bar the selection pass keeps a part at: a rule's own bar, or
  // the reference bar, read off the size curve at `decided` answered
  // references when `everyScored.bySize` sets one. The selection pass
  // and the rating stop's wait for a kept part both read it.
  const keepBar = (candidate: MemoryCandidate, decided: number) => candidate.role === 'rule'
    ? ruleBarFor(candidate.sourceId)
    : thresholds.referenceBySize === undefined ? barFor(candidate.sourceId) : sizeBar(thresholds.referenceBySize, decided);
  // Whether the selection pass keeps a scored part: at or above its bar,
  // or, for a reference, through a typed question's keepAt.
  const keepsAt = (decided: number) => (candidate: MemoryCandidate) => {
    const answer = combined.get(candidate);
    return answer?.status === 'answered' && 'probability' in answer
      && (answer.probability >= keepBar(candidate, decided) || (candidate.role !== 'rule' && keptBy.has(candidate)));
  };
  // The rating stop's reads, when it is on: the main read of the fused
  // order, and the rare-word round's own read of the parts it pulls.
  // Each counts the waves it sent, the batches it rated, the reference
  // parts it rated, the best decision score so far, where it went cold,
  // and the parts below its stop.
  interface Reading {
    waves: number;
    batches: number;
    readonly rated: Set<MemoryCandidate>;
    /** The main read holds the stop until it has kept a part, so a
     *  history whose evidence sits below a cold stretch never comes back
     *  empty. The rare-word round runs only once the main read kept
     *  parts, so its own read does not wait. */
    readonly waitForKept: boolean;
    best: number;
    cold?: NonNullable<NonNullable<PickRecord['pick']>['stopWhenCold']>['cold'];
    readonly unread: Set<MemoryCandidate>;
  }
  const reading = (waitForKept: boolean): Reading => ({ waves: 0, batches: 0, rated: new Set(),
    waitForKept, best: 0, unread: new Set() });
  // A part is rated once it holds a decision score.
  const scoreOf = (candidate: MemoryCandidate) => {
    const answer = combined.get(candidate);
    return answer?.status === 'answered' && 'probability' in answer ? answer.probability : undefined;
  };
  const main = reading(true);
  // Parts an identical earlier text answers: they ride free and do not
  // count toward a batch's best score, so a copy of a warm part cannot
  // keep a cold stretch reading.
  const copied = new Set<MemoryCandidate>();
  // The next wave of the read from `from`: the parts whose first-round
  // asks fill the next WAVE_BATCHES batches as `ask` packs them, listed
  // by batch. An ask an identical earlier text answers rides free in
  // the batch it falls in, as in `ask`. A part whose asks would run
  // past the wave's last batch waits for the next wave, unless it is
  // the wave's first part.
  const nextWave = (order: readonly MemoryCandidate[], from: number): MemoryCandidate[][] => {
    const shared = new Set<string>();
    const items: Pending[] = [];
    const owners: { readonly candidate: MemoryCandidate; readonly start: number; readonly end: number }[] = [];
    for (let at = from; at < order.length && items.length < WAVE_BATCHES * limits.maxPerBatch; at += 1) {
      const start = items.length;
      for (const item of firstAsks(order[at]!)) {
        const key = sharingKey(item);
        if (decisionsByText.has(key) || shared.has(key)) continue;
        shared.add(key);
        items.push(item);
      }
      owners.push({ candidate: order[at]!, start, end: items.length });
    }
    const ends: number[] = [];
    for (const slice of pack(items, options.task, false, WAVE_BATCHES)) ends.push((ends.at(-1) ?? 0) + slice.length);
    const batches: MemoryCandidate[][] = ends.map(() => []);
    if (!batches.length) batches.push([]);
    for (const [index, { candidate, start, end }] of owners.entries()) {
      if (index > 0 && end > (ends.at(-1) ?? 0)) break;
      if (start === end) copied.add(candidate);
      const place = ends.findIndex((last) => Math.max(start, end - 1) < last);
      batches[place < 0 ? batches.length - 1 : place]!.push(candidate);
    }
    return batches.filter((batch) => batch.length > 0);
  };
  // Read the order in waves. After each wave its batches are checked
  // in order, as a read of one batch at a time would check them: the
  // read stops at the first batch whose best decision score is under
  // the floor, or under the share of the best score before it, once the
  // read has kept a part. The rest of that wave is already rated. A batch holding no reference
  // part it asked about is not checked. A stopping dial that ends a
  // wave early leaves its batches unchecked: the dial, not the ratings,
  // ended the read. Without the stop the order goes out at once.
  const read = async (order: readonly MemoryCandidate[], state = main) => {
    if (stopRule === undefined) { await evaluate(order); return; }
    let at = 0;
    while (at < order.length && !stop && state.cold === undefined) {
      const wave = nextWave(order, at);
      const parts = wave.flat();
      await evaluate(parts);
      state.waves += 1;
      at += parts.length;
      for (const candidate of parts) {
        if (candidate.role === 'reference' && scoreOf(candidate) !== undefined) state.rated.add(candidate);
      }
      // Whether the read has kept a reference part yet, on the bar the
      // selection pass will apply: with the feed's answered count so
      // far, which is its final count should the stop fire here.
      let kept: boolean | undefined;
      const keptAny = () => kept ??= [...state.rated].some(keepsAt(answeredReferences(feed)));
      for (const batch of wave) {
        const own = batch.filter((candidate) => candidate.role === 'reference' && !copied.has(candidate));
        if (!own.some((candidate) => scoreOf(candidate) !== undefined)) continue;
        state.batches += 1;
        if (stop || state.cold !== undefined) continue;
        const best = Math.max(0, ...own.map((candidate) => scoreOf(candidate) ?? 0));
        // Until the read has kept a part, a cold batch does not stop it.
        if ((best < stopRule.floor || best < stopRule.share * state.best)
          && (!state.waitForKept || keptAny())) {
          state.cold = { batch: state.batches, best, bestBefore: state.best,
            under: best < stopRule.floor ? 'floor' : 'share' };
        } else state.best = Math.max(state.best, best);
      }
    }
    if (state.cold !== undefined) for (const candidate of order.slice(at)) state.unread.add(candidate);
  };

  const representatives = new Map<MemoryCandidate, MemoryCandidate>();
  if (!stop && options.bestPartFirst) {
    const terms = [...new Set(options.task.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2))];
    const matches = (candidate: MemoryCandidate) => {
      const words = new Set(`${candidate.title} ${candidate.text}`.toLowerCase().split(/[^a-z0-9]+/));
      return terms.filter((term) => words.has(term)).length;
    };
    const groups = new Map<string, MemoryCandidate[]>();
    for (const candidate of feed) {
      if (candidate.role === 'rule') continue;
      const document = candidate.documentId !== undefined ? ['document', candidate.documentId]
        : candidate.chat ? ['chat', candidate.chat.provider, candidate.chat.sessionId]
          : candidate.contentRef?.includes('#L') ? ['note', candidate.contentRef.split('#L')[0]]
            : candidate.path ? ['note', candidate.path] : ['item', candidate.id];
      const key = JSON.stringify([candidate.sourceId, candidate.sourceRevision, document]);
      const group = groups.get(key);
      if (group) group.push(candidate);
      else groups.set(key, [candidate]);
    }
    for (const group of groups.values()) {
      const first = group.reduce((best, candidate) => matches(candidate) > matches(best) ? candidate : best);
      for (const candidate of group) representatives.set(candidate, first);
    }
    await read(feed.filter((c) => c.role === 'rule' || representatives.get(c) === c));
    if (signal.aborted) stop = 'cancelled';
    else if (Date.now() - started >= limits.maxElapsedMs) stop = 'time';
    if (!stop) {
      await read(feed.filter((candidate) => {
        const representative = representatives.get(candidate);
        return representative !== undefined && representative !== candidate;
      }));
    }
  } else if (!stop) await read(feed);
  // The parts below the stop leave the feed: the decide step never
  // reached them.
  if (main.unread.size > 0) {
    feed = feed.filter((candidate) => !main.unread.has(candidate));
    for (const candidate of main.unread) statuses.set(candidate, { status: 'unassessed', reason: 'stopWhenCold' });
  }

  // The reference bar may rise with the decided set's size, so the
  // selection pass runs once the whole feed has answered. Without that
  // curve each reference is cut at its own source's bar.
  const decided = answeredReferences(feed);
  const appliedReference = thresholds.referenceBySize === undefined
    ? undefined : sizeBar(thresholds.referenceBySize, decided);
  const referenceBar = (id: string) => appliedReference ?? barFor(id);
  // The parts the selection pass scored, and those it scored below
  // their bar, for the record's `effects`.
  const scoredParts = new Set<MemoryCandidate>();
  const belowBar = new Set<MemoryCandidate>();
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
    if (answer.status === 'answered' && 'probability' in answer) {
      const threshold = keepBar(candidate, decided);
      const reused = answer.reused === true ? { reused: true } : {};
      scoredParts.add(candidate);
      if (answer.probability < threshold) belowBar.add(candidate);
      // A typed answer at or above its keepAt keeps a reference below the bar.
      const kept = candidate.role === 'rule' || answer.probability >= threshold ? undefined : keptBy.get(candidate);
      if (keepsAt(decided)(candidate)) {
        selected.push(candidate);
        statuses.set(candidate, { status: 'selected', asked: true, probability: answer.probability, ...reused,
          ...(kept === undefined ? {} : { keptBy: kept }) });
      } else statuses.set(candidate, { status: 'rejected', probability: answer.probability, ...reused });
    } else statuses.set(candidate, { status: 'unanswered',
      // A level distribution is a question answer, never a verdict; one
      // here means the combine failed, so it records an error.
      answer: answer.status === 'answered' ? 'error' : answer.status,
      detail: answer.status === 'answered' ? 'The verdict is a level distribution, not a probability.' : answer.detail });
  }
  // A stop before this point left some of the feed undecided.
  const feedStop = stop;
  // What ended the main read: its ratings went cold, a stopping dial
  // ended it, or it reached the end of the order.
  const readEnded = stopRule === undefined ? undefined
    : main.cold !== undefined ? 'cold' as const : feedStop ?? 'order' as const;
  // The reference parts the read rated that the selection pass kept on
  // its own bar.
  const readKept = [...main.rated].filter(keepsAt(decided)).length;
  // A queued part the feed never held was never asked a question. The
  // 'gate' reason names only the gate's own call: a reference part the
  // keyword lanes never held — not one a lane's candidate limit cut —
  // whose part and task labels were resolved and cleared no needed kind. A rule, a
  // lane-limit cut and a part a stop left unlabelled keep their reason.
  for (const candidate of queue) {
    if (!statuses.has(candidate)) {
      const gated = candidate.role === 'reference'
        && !laneCut.has(candidate) && labels.has(candidate)
        && labels.has(labelTasks.get(candidate)!);
      statuses.set(candidate, { status: 'unassessed',
        reason: gated ? 'gate' : (stop ?? 'limits') });
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
  // Parts the link pass looked at, for the record's `effects`.
  const linkActed = new Set<MemoryCandidate>();
  for (const candidate of candidates.filter(admitted)) {
    const status = statuses.get(candidate)!;
    if (status.status !== 'rejected'
      || status.probability < thresholds.linkedPathBar
      || candidate.role !== 'reference'
      || candidate.path === undefined
      || candidate.repository === undefined) continue;
    linkActed.add(candidate);
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
      ...(status.reused === true ? { reused: true } : {}),
      link: { sourceId: carrier.sourceId, id: carrier.id },
    });
  }

  // The rare-word round: the parts that cleared the
  // selection bar can share rare words with parts the first pass
  // missed, so those words reach for more. It runs within each enabled
  // source on its own, so a setting on one source never moves another's
  // pick. A word is rare in a source when at most share × N of its
  // reference parts contain it, N that source's reference count. Every
  // unselected part of that source sharing one of its rare words is
  // pulled in, pool members included: one never asked is sent through the decide
  // step, one already decided reuses its score, and a part scoring at
  // or above a second, lower bar joins the selection. It runs after
  // the link pass so a link-carried part stays out of the seeds — it
  // cleared the link bar, not the selection bar — and a pulled-in part
  // can never carry a link.
  const rarePulled = new Set<MemoryCandidate>();
  // The round's rare words and pulled parts by source, and the parts it
  // added, for the record's `effects`.
  const rareSeeds = new Map<string, ReadonlySet<string>>();
  let rareTaken: readonly MemoryCandidate[] = [];
  const rareAdded = new Set<MemoryCandidate>();
  // The pulled parts the round never asked: past a feed size's room,
  // or below the round's own stop.
  const rareHeld = new Map<MemoryCandidate, 'size' | 'cold'>();
  let rareResult: NonNullable<PickRecord['pick']>['rare'];
  if (rareOn && !stop) {
    const wordSets = new Map<MemoryCandidate, ReadonlySet<string>>();
    const wordSet = (candidate: MemoryCandidate): ReadonlySet<string> => {
      let set = wordSets.get(candidate);
      if (set === undefined) {
        set = new Set(candidate.text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []);
        wordSets.set(candidate, set);
      }
      return set;
    };
    const seedsBySource = new Map<string, Set<string>>();
    const rareRecord: Record<string, { n: number; words: string[] }> = {};
    for (const id of rareSources) {
      const own = references.filter((candidate) => candidate.sourceId === id);
      if (!own.length) continue;
      const frequency = new Map<string, number>();
      for (const candidate of own) {
        for (const word of wordSet(candidate)) frequency.set(word, (frequency.get(word) ?? 0) + 1);
      }
      const bound = rareShare * own.length;
      const seeds = new Set<string>();
      for (const candidate of selected) {
        const status = statuses.get(candidate)!;
        if (candidate.role !== 'reference' || candidate.sourceId !== id
          || status.status !== 'selected' || status.link !== undefined) {
          continue;
        }
        for (const word of wordSet(candidate)) {
          if ((frequency.get(word) ?? 0) <= bound) seeds.add(word);
        }
      }
      seedsBySource.set(id, seeds);
      rareSeeds.set(id, seeds);
      rareRecord[id] = { n: own.length, words: [...seeds].sort() };
    }
    const pulled = references.filter((candidate) => {
      const seeds = seedsBySource.get(candidate.sourceId);
      return seeds !== undefined && statuses.get(candidate)?.status !== 'selected'
        && [...wordSet(candidate)].some((word) => seeds.has(word));
    });
    rareTaken = pulled;
    // A pool member the queue never held carries no status; pulling one
    // in gives it the never-asked state a queued part starts from, and
    // `rarePulled` keeps it for the record the queue's members keep.
    for (const candidate of pulled) {
      if (!statuses.has(candidate)) {
        statuses.set(candidate, { status: 'unassessed', reason: 'pick' });
        rarePulled.add(candidate);
      }
    }
    // The round reaches past the rating stop: the pulled parts never
    // asked, in fused order and then the parts outside it, are read as
    // the order is, in waves under the same stop with a best score of
    // their own, so a round whose answers go cold ends. With a feed size
    // it asks pulled parts only while the size still has room: the size
    // bounds how many reference parts the decide step is asked about
    // across the whole pick, so a pulled part is asked only into a free
    // slot, never past it. Each part the read reached fills a slot
    // whether the decide port, the decision cache or an identical text
    // answered it, so the free room is the size less the parts read,
    // not what the port was sent. On a pick whose read filled the size,
    // the round asks nothing.
    const room = depth === undefined
      ? pulled.length : Math.max(0, depth - (insideOrder.length - main.unread.size));
    const place = new Map(insideOrder.map((candidate, index) => [candidate, index]));
    const unasked = pulled.filter((candidate) => statuses.get(candidate)!.status === 'unassessed')
      .sort((left, right) => (place.get(left) ?? Infinity) - (place.get(right) ?? Infinity));
    const round = reading(false);
    await read(unasked.slice(0, room), round);
    for (const candidate of unasked.slice(room)) rareHeld.set(candidate, 'size');
    for (const candidate of round.unread) rareHeld.set(candidate, 'cold');
    let asked = 0;
    let added = 0;
    for (const candidate of pulled) {
      const status = statuses.get(candidate)!;
      if (status.status === 'unassessed' && answered.has(candidate)) asked += 1;
      if (decideFailed.has(candidate)) {
        statuses.set(candidate, {
          status: 'unanswered', answer: 'error', detail: decideFailure!.message,
        });
        continue;
      }
      const answer = combined.get(candidate);
      if (answer === undefined) {
        const held = curtailed.get(candidate) ?? stop;
        if (held !== undefined) statuses.set(candidate, { status: 'unassessed', reason: held });
        continue;
      }
      if (answer.status !== 'answered' || !('probability' in answer)) {
        if (status.status === 'unassessed') {
          statuses.set(candidate, { status: 'unanswered',
            answer: answer.status === 'answered' ? 'error' : answer.status,
            detail: answer.status === 'answered' ? 'The verdict is a level distribution, not a probability.' : answer.detail });
        }
        continue;
      }
      const reused = answer.reused === true ? { reused: true } : {};
      const kept = answer.probability >= rareBar ? undefined : keptBy.get(candidate);
      if (answer.probability >= rareBar || kept !== undefined) {
        selected.push(candidate);
        statuses.set(candidate, { status: 'selected', asked: true, probability: answer.probability, ...reused,
          ...(kept === undefined ? {} : { keptBy: kept }) });
        rareAdded.add(candidate);
        added += 1;
      } else if (status.status === 'unassessed') {
        statuses.set(candidate, { status: 'rejected', probability: answer.probability, ...reused });
      }
    }
    rareResult = {
      share: rareShare, bar: rareBar, sources: rareRecord,
      pulled: pulled.map((candidate) => ({ sourceId: candidate.sourceId, id: candidate.id })),
      asked, added,
    };
  }

  // The pick numbers on every pick: the history's size, the ranked
  // parts that went on to the decide step, the parts and task
  // questions the decide port was actually asked, the dial or level
  // applied, and which ranking the feed followed.
  pickRecord = {
    n: historySize,
    sent: sentParts.size,
    questions: sentQuestions,
    ...(topK === undefined ? {} : { c: topK }),
    kept: feed.reduce((count, candidate) => count + Number(candidate.role === 'reference'), 0),
    ...(options.feed === undefined ? {} : { feed: {
      order: options.feed.order,
      ...(options.feed.size === undefined ? {} : { size: options.feed.size }),
      unjudged: [...cutBySource.values()].reduce((total, left) => total + left, 0),
    } }),
    ...(stopRule === undefined ? {} : { stopWhenCold: {
      ...stopRule, waves: main.waves, batches: main.batches, rated: main.rated.size,
      unread: insideOrder.length - main.rated.size, kept: readKept, ended: readEnded!,
      ...(main.cold === undefined ? {} : { cold: main.cold }),
    } }),
    ranking: feedFused || fused ? 'fusion' : 'keyword',
    ...(rareResult === undefined ? {} : { rare: rareResult }),
  };

  const bySource = (parts: Iterable<MemoryCandidate>) => {
    const counts = new Map<string, number>();
    for (const candidate of parts) counts.set(candidate.sourceId, (counts.get(candidate.sourceId) ?? 0) + 1);
    return counts;
  };
  const effects = settingEffects({
    candidates: candidates.filter((candidate) => admitted(candidate) || rarePulled.has(candidate)),
    queue, feed, statuses, laneHeld, labelLane, labelNeeds, labelBar: labelBarFor, labels, labelKindsBySource,
    rareSeeds, rareTaken, rareAdded, scored: scoredParts, belowBar, linkActed, rankedBySource, cutBySource,
    reads: options.readsBySource ?? {},
    taskPeriod: options.taskPeriod !== false, period, windowed,
    bar: referenceBar, ruleBar: ruleBarFor, everyScored: options.everyScored !== undefined,
    linkedPathBar: thresholds.linkedPathBar, rareBar, topK,
    ended: [
      ...(cutBySource.size > 0
        ? [!fused ? `a feed cut (everyRanked c ${topK})` : `a feed cut (feed size ${options.feed?.size})`]
        : []),
      ...(main.unread.size > 0 ? ['a stop when the ratings went cold (stopWhenCold)'] : []),
      ...(feedStop === undefined ? [] : [`a stop (${feedStop})`]),
    ],
    fused,
    feedOption: options.feed,
    stopWhenCold: stopRule === undefined ? undefined : {
      ...stopRule, cold: main.cold, ended: readEnded!, kept: readKept, orderBySource: bySource(insideOrder),
      ratedBySource: bySource(main.rated) },
    rareHeld,
    typedSources: new Map(Object.entries(options.questionsBySource ?? {}).flatMap(([id, set]) =>
      (set.typed?.length ?? 0) > 0 ? [[id, set.typed!.some((q) => neededTypes.has(q.answerType))] as const] : [])),
    typedAsked: new Set(candidates.filter((candidate) =>
      typedFor(candidate).some((q) => answered.get(candidate)?.has(q.key) === true))),
    untyped,
    writtenSources: new Set(Object.entries(options.questionsBySource ?? {})
      .flatMap(([id, set]) => set.written === undefined ? [] : [id])),
    writtenAsked: new Set(candidates.filter((candidate) =>
      writtenFor(candidate).some((q) => answered.get(candidate)?.has(q.key) === true))),
    unwritten,
    keepReached: new Set(keptBy.keys()),
    namedSources: new Set(Object.entries(options.questionsBySource ?? {})
      .flatMap(([id, set]) => set.named === undefined ? [] : [id])),
    named: (names?.found.length ?? 0) > 0,
    unheld,
    namedAsked: new Set(candidates.filter((candidate) =>
      namedFor(candidate).some((q) => answered.get(candidate)?.has(q.key) === true))),
    unnamed,
  });

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
    const tags: Record<string, { value?: string; answers: ({ key: string; reused?: boolean } & PickAnswer)[] }> = {};
    for (const set of sets) {
      const answers: ({ key: string; reused?: boolean } & PickAnswer)[] = set.questions.map((question) => ({ key: question.key,
        ...(got?.get(`${set.key}.${question.key}`)
          ?? { status: 'unassessed' as const, ...(stop === undefined ? {} : { detail: stop }) }) }));
      // A set's value needs a clear answer: a lone-question set values
      // to yes/no at 0.5, and a larger set values to the first of its
      // questions answered at 0.5 or more — for a levelled set like
      // importance that is the highest recorded level. When every
      // answer is below 0.5 or missing, the value stays unset rather
      // than naming the least-bad key.
      const value = set.questions.length === 1
        ? (answers[0]!.status === 'answered' && 'probability' in answers[0]!
          ? (answers[0]!.probability >= 0.5 ? 'yes' : 'no') : undefined)
        : answers.find((answer) => answer.status === 'answered'
          && 'probability' in answer && answer.probability >= 0.5)?.key;
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
    || (feedOrder.get(a) ?? feedOrder.size) - (feedOrder.get(b) ?? feedOrder.size));

  const entries: PickRecordEntry[] = candidates
    .filter((candidate) => admitted(candidate) || rarePulled.has(candidate)).map((candidate) => {
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
      ...(candidate.poolOnly === true ? { poolOnly: true } : {}),
      ...(candidate.dateWindow === undefined ? {} : { dateWindow: candidate.dateWindow }),
      ...(candidate.pastLaneCut === true ? { pastLaneCut: true as const } : {}),
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
        questions: [...cascade.questions, ...typedFor(candidate),
          ...writtenFor(candidate).filter((q) => answered.get(candidate)!.has(q.key)),
          ...namedFor(candidate).filter((q) => answered.get(candidate)!.has(q.key))]
          .map((q) => ({ key: q.key, ...(answered.get(candidate)!.get(q.key) ?? { status: 'missing' as const }) })),
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
    asOf, timeZone,
    ...(period === undefined ? {} : { taskPeriod: period }),
    labelKindsBySource,
    questionVersion,
    limits: recordedLimits,
    thresholds: { ...thresholds,
      ...(appliedReference === undefined ? {} : { appliedReference }) },
    ...(options.ranking === undefined ? {} : { ranking: options.ranking }),
    candidates: entries,
    ...(options.historySizeBySource === undefined ? {} : { unheld }),
    rulesCoverage,
    ...(decideFailure === undefined ? {} : {
      decideError: { candidates: decideFailure.ids, message: decideFailure.message },
    }),
    ...(options.tags === undefined ? {} : { tags: options.tags }),
    ...(options.tagsByKind === undefined ? {} : { tagsByKind: options.tagsByKind }),
    ...(options.tagsByKind === undefined || options.sourceKinds === undefined ? {} : { sourceKinds: options.sourceKinds }),
    ...(options.keepTop === undefined ? {} : { keepTop }),
    ...(options.rankProtection ? { rankProtection: true } : {}),
    ...(options.bestPartFirst ? { bestPartFirst: true } : {}),
    ...(labelRecord === undefined ? {} : { labels: labelRecord }),
    ...(cache === undefined ? {} : {
      cache: {
        questionVersion: cacheVersion,
        deciderId: cache.deciderId,
        asked: cacheAsked,
        reused: cacheReused,
        failedWrites: cacheFailedWrites,
        ...(cacheFailedWrites === 0 ? {} : {
          warning: `${cacheFailedWrites} decision(s) could not be stored `
            + `(${cacheWriteError instanceof Error ? cacheWriteError.message : String(cacheWriteError)}); `
            + 'this pick used them, and the next pick asks for them again.',
        }),
      },
    }),
    ...(routeRecord === undefined ? {} : { route: routeRecord }),
    ...(answerTypesRecord === undefined ? {} : { answerTypes: answerTypesRecord }),
    ...(options.writeQuestions === undefined ? {} : { writtenQuestions: { questions: writtenQuestions } }),
    ...(names === undefined ? {} : { names }),
    ...(pickRecord === undefined ? {} : { pick: pickRecord }),
    levers: { ...levers, sources: Object.fromEntries([...new Set([
      ...Object.keys(labelKindsBySource), ...rareSourceIds,
      ...Object.keys(options.barBySource ?? {}), ...Object.keys(options.ruleBarBySource ?? {}),
      ...Object.keys(options.questionsBySource ?? {}),
    ])].map((id) => [id, {
      ...(options.sourceKinds?.[id] === undefined ? {} : { kind: options.sourceKinds[id] }),
      labels: (labelKindsBySource[id]?.length ?? 0) > 0,
      ...((labelKindsBySource[id]?.length ?? 0) > 0 ? { labelBar: labelBarFor(id) } : {}),
      rare: rareForSource(id), bar: referenceBar(id),
      ...(candidates.some((c) => c.sourceId === id && c.role === 'rule') ? { ruleBar: ruleBarFor(id) } : {}),
      ...(questionsFor(id) === undefined ? {} : { questions: questionsFor(id) }),
    }])) },
    effects,
  };
  if (decideFailure !== undefined) {
    throw new PickError(
      `The decide call failed for candidates ${decideFailure.ids.join(', ')}: ${decideFailure.message}`,
      record, { cause: decideFailure.error });
  }
  return { selected, record };
}
