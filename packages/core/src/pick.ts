import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  LABEL_KINDS, LABEL_LANE_BAR, LABEL_PARTS_TASK, LABEL_QUESTION_VERSION,
  fuseLabelLane, labelFileStore, labelKey, labelKindsKey, labelPartQuestion, labelQuestionTask,
  labelTaskQuestion, storedLabels, type LabelKind, type PartLabels,
} from './labels.js';
import {
  decisionKey, storedDecision, type DecisionStore,
} from './decisions.js';
import { ROUTE_QUESTIONS, routeOptions, type RouteKey, type RouteOption } from './task.js';
import type { LeverStates } from './levers.js';
import { checkCascade, checkPickOptions } from './options.js';

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
   *  the same way. */
  readonly poolOnly?: boolean;
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
  /** True when a read with `wholeLanes` on returned this part although
   *  the lane cut would have dropped it in every lane that holds it.
   *  Only a read with `wholeLanes` on sets it. */
  readonly pastLaneCut?: true;
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
   *  Recorded for tag and route questions; a decide reply cannot produce it. */
  | { readonly status: 'unassessed'; readonly detail?: string };

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
       *  or 'gate' — with the label gate on, a reference part the
       *  keyword lanes never held whose stored or answered labels
       *  cleared no needed kind. A part a lane limit cut or a stop
       *  left unlabelled keeps that reason instead. */
      readonly reason: 'limits' | 'time' | 'cancelled' | 'document' | 'error' | 'gate' | 'pick' };

export type PickRecordEntry = {
  readonly sourceId: string;
  readonly sourceRevision?: string;
  readonly id: string;
  readonly role: MemoryCandidateRole;
  readonly kind?: MemoryKind;
  readonly priority: number;
  readonly searchRanks?: readonly (number | null)[];
  /** Echoed from the input: the part came from the uncut pool and holds
   *  no lane membership, so only the label lane or the rare-word round
   *  could admit it. */
  readonly poolOnly?: boolean;
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

/** What one setting did in one pick, for one source. */
export interface PickSettingEffect {
  /** The setting's name as a caller writes it: 'labels', 'rare', 'bar', 'ruleBar', 'searchLines',
   *  'searchPhrases', 'meaning', 'wholeLanes', 'linkedPathBar', 'everyScored' or 'everyRanked'. */
  readonly setting: string;
  /** The source the counts are for. A setting given for the whole call gets one entry per source. */
  readonly source: string;
  /** Parts the setting looked at. */
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
export type SearchLaneOrigin = 'task' | 'searchLines' | 'searchPhrases' | 'kindLanes' | 'meaning';

/** How one source was read, for the record's `effects`. */
export interface PickSourceRead {
  /** The option each `searchRanks` position came from, in position order. */
  readonly lanes: readonly SearchLaneOrigin[];
  /** The extra-lane options the read request gave with a non-blank
   *  entry, whether or not each opened a lane: a search line that
   *  repeats the task opens none. Defaults to those `lanes` names. */
  readonly given?: readonly ('searchLines' | 'searchPhrases' | 'meaning')[];
  /** The read kept whole lanes (`wholeLanes` on the read request). */
  readonly wholeLanes: boolean;
}

export interface PickRecord {
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
   *  questions asked; the curate record's own `levers.route` keeps
   *  that state as `asked` beside the curator's `applied`. */
  readonly levers: LeverStates;
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
   *  'working'. curate's own `route: 'jev'` applies them; a route
   *  question a stop left unasked records 'unassessed' with the stop
   *  reason. */
  readonly route?: {
    readonly answers: readonly ({ readonly key: RouteKey } & PickAnswer)[];
    readonly on: readonly RouteOption[];
  };
  /** Present when a decide-feed dial ran — `everyRanked: { c }` or the
   *  rare-word round: the history's size N in reference parts (every
   *  reference part the pick received, including pool members the
   *  keyword lanes never held), how many of the ranking's reference
   *  parts went on to the decide step, and which ranking the decide
   *  step read — 'fusion' when the label gate fused its lane into the
   *  keyword order, 'keyword' otherwise. `c` is the supplied top-k
   *  coefficient, present only when the cut ran; candidates the cut
   *  dropped record 'unassessed' with reason 'pick'. Rules never count
   *  toward N or the keep count and are never cut.
   *  `rare` is present when the rare-word round ran: the share and bar
   *  it used, the rare words the parts that cleared the selection bar
   *  contributed, the parts those words pulled in, and how many of them
   *  the decide step was asked about and how many joined the
   *  selection. */
  readonly pick?: {
    readonly n: number;
    readonly c?: number;
    readonly kept: number;
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
   *  holds the parts labelled at the shared bar (0.5) or more on a kind
   *  of statement the question needs at that bar, ordered by that
   *  probability, merged with the keyword lanes by rank through
   *  reciprocal-rank fusion; the bar is a dial to fit, not a measured
   *  best. A source's kind questions are asked through the decide port
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
   *  'yes' at the shared label bar switches on; `curate`'s own
   *  `route: 'jev'` applies them. Off by default. */
  readonly route?: 'jev';
  /** Read every ranked part, the default. `{ c }` turns the lever off
   *  and keeps only the top `round(c × N^0.8)` reference parts of the
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
   *  scoring at or above `bar` joins the selection. `bar` is a second,
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
  readonly limits?: PickLimits;
  readonly thresholds?: PickThresholds;
  readonly signal?: AbortSignal;
}

export const PICK_QUESTION_VERSION = 'memory-pick-questions-1';

/** The most label-store files a pick opens at once. Pools can hold
 *  tens of thousands of parts, and an open per part in one moment can
 *  pass the process's file limit; reads run in groups of this size. */
const LABEL_STORE_READ_GROUP = 64;
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
  | { readonly status: 'answered'; readonly probability: number; readonly reused?: boolean }
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
  readonly labels: ReadonlyMap<MemoryCandidate, PartLabels>;
  readonly labelKindsBySource: Readonly<Record<string, readonly LabelKind[]>>;
  /** The rare words each source the round ran on contributed. */
  readonly rareSeeds: ReadonlyMap<string, ReadonlySet<string>>;
  readonly rareTaken: readonly MemoryCandidate[];
  readonly rareAdded: ReadonlySet<MemoryCandidate>;
  /** The parts the selection pass scored, and those it scored below their bar. */
  readonly scored: ReadonlySet<MemoryCandidate>;
  readonly belowBar: ReadonlySet<MemoryCandidate>;
  /** The parts the link pass looked at. */
  readonly linkActed: ReadonlySet<MemoryCandidate>;
  readonly rankedBySource: ReadonlyMap<string, number>;
  readonly cutBySource: ReadonlyMap<string, number>;
  readonly reads: Readonly<Record<string, PickSourceRead>>;
  readonly bar: (id: string) => number;
  readonly ruleBar: (id: string) => number;
  readonly everyScored: boolean;
  readonly linkedPathBar: number;
  readonly rareBar: number;
  readonly topK: number | undefined;
  /** What ended the feed early: a feed cut, a stop, or both. */
  readonly ended: readonly string[];
}

const count = (n: number, noun = 'part') => `${n} ${noun}${n === 1 ? '' : 's'}`;
const keptOf = (n: number) => `${n} of them ${n === 1 ? 'was' : 'were'} kept`;

/** One entry per setting that was on, per source it applied to, counted
 *  from the pick that ran. A part reaches the decide step by one or
 *  more ways in: each lane that held it inside its candidate limit, the whole-lane
 *  read when every lane held it past the cut, and the label lane. A
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
    if (input.labelLane.has(candidate)) found.add('labels');
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
  const effects: PickSettingEffect[] = [];
  for (const id of new Set(input.candidates.map((candidate) => candidate.sourceId))) {
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
      const head = `labels on ${id}: labelled ${count(labelled)}`;
      const through = 'reached the decide step only through the label lane';
      const reason = queued.every((candidate) => input.laneHeld.has(candidate))
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
      effects.push({ setting: 'rare', source: id, actedOn: pulled.length, added, dropped: 0,
        summary: added > 0
          ? `rare on ${id}: pulled in ${count(pulled.length)} that share a rare word with a kept part, and ${keptOf(added)}.`
          : `rare on ${id}: ${seeds.size === 0 ? 'no kept part had a word that is rare in this source'
            : pulled.length === 0 ? 'no other part shared a rare word with a kept part'
              : `pulled in ${count(pulled.length)}, but none answered at or above the rare bar ${input.rareBar}`
          }, so the round added none. It added no part.` });
    }

    const references = own.filter((candidate) => candidate.role === 'reference');
    if (references.length > 0) {
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
            : `${setting} on ${id}: of ${count(scored.length, 'scored part')}, ${below.length} fell below the bar ${bar}, but a later pass kept each of them, so the bar kept out none. It kept out no part.` });
    }

    const rules = own.filter((candidate) => candidate.role === 'rule');
    if (rules.length > 0 && input.ruleBar(id) > 0) {
      const bar = input.ruleBar(id);
      const scored = rules.filter((candidate) => input.scored.has(candidate));
      const dropped = scored.filter((candidate) => input.belowBar.has(candidate)).length;
      effects.push({ setting: 'ruleBar', source: id, actedOn: scored.length, added: 0, dropped,
        summary: dropped > 0
          ? `ruleBar on ${id}: of ${count(scored.length, 'scored rule')}, ${dropped} fell below the bar ${bar}.`
          : `ruleBar on ${id}: no scored rule of ${scored.length} fell below the bar ${bar}, so the bar kept out none. It kept out no part.` });
    }

    for (const setting of ['searchLines', 'searchPhrases', 'meaning'] as const) {
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
                ? 'every line was blank or repeated the task or an earlier line' : 'there was no text to search'
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
  }
  return effects;
}

export async function pick(
  candidates: readonly MemoryCandidate[],
  options: PickOptions,
): Promise<PickResult> {
  checkPickOptions(options);
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
  if (options.route !== undefined && options.route !== 'jev') {
    throw new TypeError(`route must be 'jev'.`);
  }
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
  };
  const recordedLimits: PickLimits = {
    maxPerBatch: limits.maxPerBatch,
    ...(input.maxBatchChars !== undefined ? { maxBatchChars: input.maxBatchChars } : {}),
    ...(input.maxQuestionText !== undefined ? { maxQuestionText: input.maxQuestionText } : {}),
    ...(input.maxBatches !== undefined ? { maxBatches: input.maxBatches } : {}),
    ...(input.maxCandidates !== undefined ? { maxCandidates: input.maxCandidates } : {}),
    ...(input.maxElapsedMs !== undefined ? { maxElapsedMs: input.maxElapsedMs } : {}),
  };
  const scored = everyScored === undefined || everyScored === true ? {} : everyScored;
  const barFor = (id: string) => everyScored === true ? 0 : scored.bar ?? options.barBySource?.[id] ?? DEFAULT_BAR;
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
  // The levers as resolved, for the record. `pick`
  // never sees `wholeLanes`: the read request carries it, and only a
  // pickFromSources record holds it.
  const levers: Omit<LeverStates, 'sources'> = {
    everyRanked: options.everyRanked ?? true,
    ...(everyScored === undefined ? {} : { everyScored }),
    route: options.route === 'jev',
    rare: rareOn ? { share: rareShare, bar: rareBar } : false,
  };
  const topK = isRecord(options.everyRanked) ? options.everyRanked.c : undefined;
  // A decide-feed dial is on when `everyRanked` supplies a c or the
  // rare-word round is on: pool-only parts then count toward the
  // history's size without joining the feed or the record, the
  // rare-word round aside.
  const dial = topK !== undefined || rareOn;
  const signal = options.signal ?? new AbortController().signal;
  const started = Date.now();

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
  let cacheAsked = 0;
  let cacheReused = 0;
  let cacheFailedWrites = 0;
  let cacheWriteError: unknown;

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
  // With a decide-feed dial on and the label gate off a pool-only part
  // can never be admitted to the feed: it still counts toward the
  // history size the dial reads from `references`, but it stays out of
  // the queue and the record rather than record a reason that is not
  // true — the rare-word round can still pull one in, and only then
  // does it join the record. With no dial it keeps the record it
  // always had: unasked, 'unassessed' with reason 'limits'.
  const admitted = (candidate: MemoryCandidate) =>
    kindsFor(candidate).length > 0 || (topK === undefined && !rareForSource(candidate.sourceId))
      || candidate.poolOnly !== true;
  queue.push(...references.filter(admitted));

  const lanes = queue.reduce((count, candidate) => Math.max(count, candidate.searchRanks?.length ?? 1), 1);
  const eligible = new Set<MemoryCandidate>();
  // The lanes that held each eligible part inside their limit, for the record's `effects`.
  const laneHeld = new Map<MemoryCandidate, Set<number>>();
  // With the label gate on, lane members a lane's candidate limit cut
  // are tracked, so the reason they were never asked stays 'limits'.
  const laneCut = new Set<MemoryCandidate>();
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
  let feed = queue.filter((candidate) => eligible.has(candidate));
  // Set when the label gate fused its lane into the keyword order: the
  // ranking the record's pick field then names as 'fusion'.
  let feedFused = false;
  const answered = new Map<MemoryCandidate, Map<string, CheckedAnswer>>();
  // Label asks keep their own store: the decision cache never sees
  // them. Declared beside `answered` so `ask` can tell the two sinks
  // apart.
  const labelAnswers = new Map<MemoryCandidate, Map<string, CheckedAnswer>>();
  const specsFor = (candidate: MemoryCandidate) => {
    const cascade = cascadeFor(candidate);
    return candidate.role === 'reference' && cascade
      ? cascade.questions.map((q) => ({ key: q.key, question: q.instructions, trueCriterion: q.true, falseCriterion: q.false }))
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
  const ask = async (asks: Pending[], sink = answered, task = options.task, whole = false) => {
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
    for (let index = 0; index < fresh.length;) {
      if (signal.aborted) { stop = 'cancelled'; break; }
      if (batches >= limits.maxBatches) { stop = 'limits'; break; }
      const remaining = limits.maxElapsedMs - (Date.now() - started);
      if (remaining <= 0) { stop = 'time'; break; }
      // A batch packs whole items until the character bound; the first
      // item always goes, so a single oversized item is sent alone. An
      // item counts once per batch however many of its questions it holds.
      // A `whole` call packs every ask into its one request instead: the
      // task's own label and route questions always ride together.
      const slice: Pending[] = [];
      const counted = new Set<MemoryCandidate>();
      let batchChars = task.length;
      for (const item of fresh.slice(index, index + (whole ? fresh.length : limits.maxPerBatch))) {
        const size = questionChars(item.question)
          + (counted.has(item.candidate) ? 0 : itemChars(item.question));
        if (slice.length > 0 && !whole && batchChars + size > limits.maxBatchChars) break;
        batchChars += size;
        counted.add(item.candidate);
        slice.push(item);
      }
      index += slice.length;
      const questions = slice.map((item) => item.question);
      if (cacheable) cacheAsked += slice.length;
      const deadline = Number.isFinite(remaining) ? AbortSignal.timeout(Math.ceil(remaining)) : undefined;
      let answers: Record<string, PickAnswer> | undefined;
      let decideError: unknown;
      let timedOut = false;
      try {
        const returned: unknown = await Promise.race([
          options.decide({ task, questions },
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
      for (const { candidate, spec, question, cacheKey } of slice) {
        const answer: CheckedAnswer = timedOut
          ? { status: 'error', detail: 'The decide call did not finish before the elapsed limit.' }
          : answers === undefined
            ? { status: 'error', detail: decideError instanceof Error ? decideError.message
                : decideError === undefined ? 'The decide call failed.' : String(decideError) }
            : checkAnswer(answers[question.key]);
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
              { answer: { status: 'answered', probability: answer.probability } });
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
      batches += 1;
      if (timedOut) { stop = 'time'; break; }
      if (decideFailure !== undefined) break;
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
  let routeAskedWithLabels = false;
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
      parts: MemoryCandidate[]; needs: string[] };
    const sets = new Map<string, KindSet>();
    const sourceSets = new Map<string, KindSet>();
    for (const [id, kinds] of Object.entries(labelKindsBySource)) {
      if (!kinds.length) continue;
      const key = labelKindsKey(kinds);
      let set = sets.get(key);
      if (set === undefined) {
        set = { key, kinds, task: { ...taskItem, id: sets.size === 0 ? 'question' : `question:${key}` },
          parts: [], needs: [] };
        sets.set(key, set);
      }
      sourceSets.set(id, set);
    }
    for (const candidate of queue) {
      const set = sourceSets.get(candidate.sourceId);
      if (candidate.role !== 'reference' || set === undefined) continue;
      set.parts.push(candidate);
      labelTasks.set(candidate, set.task);
    }
    let asked = 0;
    let reused = 0;
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
      const keyed = [...byKey];
      for (let index = 0; index < keyed.length; index += LABEL_STORE_READ_GROUP) {
        const entries = await Promise.all(keyed.slice(index, index + LABEL_STORE_READ_GROUP)
          .map(async ([key, items]) => ({ key, items, stored: storedLabels(await store.get(key), set.kinds) })));
        for (const { key, items, stored } of entries) {
          if (stored === undefined) misses.push({ key, items });
          else {
            reused += 1;
            for (const item of items) labels.set(item, stored);
          }
        }
      }
      if (!stop && misses.some(({ items }) => items[0] === set.task)) {
        const withRoute: boolean = options.route === 'jev' && !routeAskedWithLabels;
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
        ], labelAnswers, labelQuestionTask(options.task), withRoute);
        routeAskedWithLabels ||= withRoute;
      }
      const partMisses = misses.filter(({ items }) => items[0] !== set.task);
      if (!stop && partMisses.length > 0) {
        await ask(partMisses.flatMap(({ items }) => set.kinds.map((kind) => {
          const candidate = items[0]!;
          const item = pending(candidate, { key: kind.key, ...labelPartQuestion(kind) });
          return { ...item, question: { ...item.question,
            key: JSON.stringify([candidate.sourceId, candidate.id, kind.key]),
            questionKey: kind.key, text: candidate.text } };
        })), labelAnswers, chat ? LABEL_PARTS_TASK
          : 'Label short excerpts from source material. Each question names one item.');
      }
      asked += misses.filter(({ items }) => labelAnswers.has(items[0]!)).length;
      for (const { key, items } of misses) {
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
      set.needs = set.kinds.filter((kind) => (labels.get(set.task)?.[kind.key] ?? 0) >= LABEL_LANE_BAR)
        .map((kind) => kind.key);
    }
    const strength = (candidate: MemoryCandidate) => {
      const own = labels.get(candidate);
      const needs = sourceSets.get(candidate.sourceId)?.needs ?? [];
      return own === undefined || !needs.length ? 0 : Math.max(0, ...needs.map((kind) => own[kind] ?? 0));
    };
    const inLane = new Set(queue.filter((candidate) =>
      candidate.role === 'reference' && strength(candidate) >= LABEL_LANE_BAR));
    labelLane = inLane;
    for (const [id, set] of sourceSets) labelNeeds.set(id, set.needs);
    for (const candidate of inLane) eligible.add(candidate);
    feed = queue.filter((candidate) => eligible.has(candidate));
    if ([...sets.values()].some((set) => set.needs.length > 0)) {
      feed = fuseLabelLane(feed, queue, inLane, strength);
      feedFused = true;
    }
    labelRecord = {
      questionVersion, deciderId: labelOptions.deciderId, asked, reused,
      gate: feed.length, failedWrites,
      ...(failedWrites === 0 ? {} : {
        warning: `${failedWrites} label set(s) could not be stored `
          + `(${writeError instanceof Error ? writeError.message : String(writeError)}); this pick used them, `
          + 'and the next pick asks for them again.',
      }),
    };
  }

  // The route questions, alone when the task's label ask did not run —
  // labels unset, or the task's set reused from the store.
  if (options.route === 'jev') {
    if (!stop && !routeAskedWithLabels) {
      await ask(ROUTE_QUESTIONS.map(routePending), labelAnswers, labelQuestionTask(options.task), true);
    }
    const got = labelAnswers.get(taskItem);
    const answers: ({ readonly key: RouteKey } & PickAnswer)[] = ROUTE_QUESTIONS.map((route) => ({
      key: route.key,
      ...(got?.get(route.key)
        ?? { status: 'unassessed' as const, ...(stop === undefined ? {} : { detail: stop }) }),
    }));
    routeRecord = {
      answers,
      on: routeOptions(Object.fromEntries(answers.flatMap((answer) =>
        answer.status === 'answered' ? [[answer.key, answer.probability] as const] : []))),
    };
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
  // Each source's ranked reference parts and how many the cut left
  // undecided, for the record's `effects`.
  const rankedBySource = new Map<string, number>();
  const cutBySource = new Map<string, number>();
  if (dial) {
    const n = references.length;
    let kept: number;
    if (topK !== undefined) {
      const bound = Math.min(n, Math.round(topK * Math.pow(n, 0.8)));
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
      kept = Math.min(rank, bound);
    } else {
      kept = feed.reduce((count, candidate) => count + Number(candidate.role === 'reference'), 0);
    }
    pickRecord = {
      n, kept,
      ...(topK === undefined ? {} : { c: topK }),
      ranking: feedFused ? 'fusion' : 'keyword',
    };
  }

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
          answer = { status: 'answered', probability: 1 / (1 + Math.exp(-(cascade.firstOnly!.bias + cascade.firstOnly!.weight * logit(first.probability)))),
            ...(first.reused === true ? { reused: true } : {}) };
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
            answer = { status: 'answered', probability: 1 / (1 + Math.exp(-z)),
              // The verdict reused the store only when every answer
              // behind it did: a question this pick asked — even one
              // that came back unanswered — keeps it fresh.
              ...(probabilities.every((a) => a === undefined || (a.status === 'answered' && a.reused === true))
                ? { reused: true } : {}) };
          } else answer = first ?? got.values().next().value ?? { status: 'missing' };
        }
      } else answer = got.values().next().value!;
      combined.set(candidate, answer);
    }
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
    await evaluate(feed.filter((c) => c.role === 'rule' || representatives.get(c) === c));
    if (signal.aborted) stop = 'cancelled';
    else if (Date.now() - started >= limits.maxElapsedMs) stop = 'time';
    if (!stop) {
      await evaluate(feed.filter((candidate) => {
        const representative = representatives.get(candidate);
        return representative !== undefined && representative !== candidate;
      }));
    }
  } else if (!stop) await evaluate(feed);

  // The reference bar may rise with the decided set's size, so the
  // selection pass runs once the whole feed has answered. Without that
  // curve each reference is cut at its own source's bar.
  const decided = feed.reduce((count, candidate) =>
    count + Number(candidate.role === 'reference' && combined.get(candidate)?.status === 'answered'), 0);
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
    if (answer.status === 'answered') {
      const threshold = candidate.role === 'rule' ? ruleBarFor(candidate.sourceId) : referenceBar(candidate.sourceId);
      const reused = answer.reused === true ? { reused: true } : {};
      scoredParts.add(candidate);
      if (answer.probability < threshold) belowBar.add(candidate);
      if (answer.probability >= threshold) {
        selected.push(candidate);
        statuses.set(candidate, { status: 'selected', asked: true, probability: answer.probability, ...reused });
      } else statuses.set(candidate, { status: 'rejected', probability: answer.probability, ...reused });
    } else statuses.set(candidate, { status: 'unanswered', answer: answer.status, detail: answer.detail });
  }
  // A stop before this point left some of the feed undecided.
  const feedStop = stop;
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
    await evaluate(pulled.filter((candidate) =>
      statuses.get(candidate)!.status === 'unassessed'));
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
      if (answer.status !== 'answered') {
        if (status.status === 'unassessed') {
          statuses.set(candidate, { status: 'unanswered', answer: answer.status, detail: answer.detail });
        }
        continue;
      }
      const reused = answer.reused === true ? { reused: true } : {};
      if (answer.probability >= rareBar) {
        selected.push(candidate);
        statuses.set(candidate, { status: 'selected', asked: true, probability: answer.probability, ...reused });
        rareAdded.add(candidate);
        added += 1;
      } else if (status.status === 'unassessed') {
        statuses.set(candidate, { status: 'rejected', probability: answer.probability, ...reused });
      }
    }
    pickRecord = { ...pickRecord!, rare: {
      share: rareShare, bar: rareBar, sources: rareRecord,
      pulled: pulled.map((candidate) => ({ sourceId: candidate.sourceId, id: candidate.id })),
      asked, added,
    } };
  }

  const effects = settingEffects({
    candidates: candidates.filter((candidate) => admitted(candidate) || rarePulled.has(candidate)),
    queue, feed, statuses, laneHeld, labelLane, labelNeeds, labels, labelKindsBySource,
    rareSeeds, rareTaken, rareAdded, scored: scoredParts, belowBar, linkActed, rankedBySource, cutBySource,
    reads: options.readsBySource ?? {},
    bar: referenceBar, ruleBar: ruleBarFor, everyScored: options.everyScored !== undefined,
    linkedPathBar: thresholds.linkedPathBar, rareBar, topK,
    ended: [
      ...(cutBySource.size > 0 ? [`a feed cut (everyRanked c ${topK})`] : []),
      ...(feedStop === undefined ? [] : [`a stop (${feedStop})`]),
    ],
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
    labelKindsBySource,
    questionVersion,
    limits: recordedLimits,
    thresholds: { ...thresholds,
      ...(appliedReference === undefined ? {} : { appliedReference }) },
    ...(options.ranking === undefined ? {} : { ranking: options.ranking }),
    candidates: entries,
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
    ...(pickRecord === undefined ? {} : { pick: pickRecord }),
    levers: { ...levers, sources: Object.fromEntries([...new Set([
      ...Object.keys(labelKindsBySource), ...rareSourceIds,
      ...Object.keys(options.barBySource ?? {}), ...Object.keys(options.ruleBarBySource ?? {}),
      ...Object.keys(options.questionsBySource ?? {}),
    ])].map((id) => [id, {
      ...(options.sourceKinds?.[id] === undefined ? {} : { kind: options.sourceKinds[id] }),
      labels: (labelKindsBySource[id]?.length ?? 0) > 0, rare: rareForSource(id), bar: referenceBar(id),
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
