import type {
  CandidateSourceKind, MemoryCandidate, PickCascade, PickOptions, PickResult, PickSourceRead, SearchLaneOrigin,
} from './pick.js';
import { DEFAULT_MAX_QUESTION_TEXT, pick } from './pick.js';
import { phraseCount, stripSearchInstructions } from './search.js';
import { addMeaningRanks, type MeaningSearchOptions } from './meaning.js';
import { cutLane, laneBend, laneScoreOf, type SearchLaneReport } from './lanes.js';
import {
  checkCascade, checkCascadeKeys, checkPickOptions, checkReadRequest, checkWriteQuestions, findTaskNames,
} from './options.js';
import { LABEL_KINDS, type LabelKind } from './labels.js';
import { datedIn, durationMs, taskMoment, taskPeriod, timeZoneOf, zonedIso, type TaskPeriod } from './time.js';

/** What a source is asked for, once per search. */
export interface CandidateReadRequest {
  /** The task used for keyword search. Pick keeps options.task intact. */
  readonly task: string;
  /** Additional host-written keyword searches. Each unique, nonblank
   *  line contributes its own results alongside the original task.
   *  Omit or supply [] for a single search; no model writes these lines. */
  readonly searchLines?: readonly string[];
  /** Exact contiguous word phrases, retaining short words. Matched
   *  against candidate text and titles; each phrase adds a separate search feed. */
  readonly searchPhrases?: readonly string[];
  /** Add local meaning searches. Off when omitted; no model is loaded by core. */
  readonly meaning?: MeaningSearchOptions;
  /** Kind lanes: phrase searches in the language of the kind of message
   *  the task asks for, one list per source kind (`chat`, `git-history`,
   *  `markdown`). A task asking for directions, decisions or corrections
   *  can search for the words those messages are written in, in each
   *  source's register: "we need to", "don't", "never", "always" in chat;
   *  "revert" in commit subjects; "decision:" in notes. Each phrase
   *  matches exactly like a `searchPhrases` entry, but a kind lane is
   *  never cut on phrase occurrences: a phrase nearly everyone uses
   *  would keep only its most repeated mentions and drop a one-off
   *  direction said once. Instead each matching part is scored against
   *  the task itself (the read request carries `topic`), and with
   *  `wholeLanes` off a streaming reader keeps the matches that curve
   *  keeps; a reader that cannot score the task returns every match and
   *  the pick keeps them all. */
  readonly kindLanes?: Readonly<Partial<Record<CandidateSourceKind, readonly string[]>>>;
  /** Read each lane's whole ranked list. Off by default inside
   *  pickFromSources: every lane is narrowed where its own score curve
   *  flattens, from the scores themselves rather than a fixed count;
   *  pass true to keep every returned part. The curve measures each
   *  candidate's `laneScore` when it carries one — a source whose
   *  signals hold an ordering or rank-merge score puts the lane's own
   *  match score there; a phrase lane's match score is the phrase's
   *  occurrence count. A search lane with no positive score matched
   *  nothing, so it admits nothing and holds no bodies while it waits
   *  on its siblings; a read that keeps nothing records
   *  `noSearchMatch`, so the caller sees the miss and can ask more
   *  broadly rather than be handed the whole history. `searchPhrases`
   *  lanes keep every exact match either way, and a source whose role
   *  is not 'reference' is never cut. Kind lanes are never cut on phrase occurrences
   *  either: a streaming reader ranks each kind-lane match by the
   *  task's own score (the request's `topic`) and cuts that curve
   *  inside the read; a reader that does not returns every match and
   *  the pick keeps them all. A bare `source.read` call leaves the
   *  option unset: the read returns its full ranked result, and only a
   *  read that received `wholeLanes: false` narrows inside the read. */
  readonly wholeLanes?: boolean;
  /** In kind lanes on a chat-kind source, keep only the person's own
   *  messages (chat role 'user'); use it when the task asks what a named
   *  person said. Candidates with no chat metadata pass unaffected.
   *  Off by default. */
  readonly speakerOnly?: boolean;
  /** Internal to pickFromSources: the read serves a phrase or kind
   *  lane, so `task` is an exact phrase to match, not a keyword query
   *  to score. A streaming reader can then keep only the parts that
   *  contain the phrase instead of scoring the corpus to discard the
   *  scores. Leave unset for a keyword search lane. */
  readonly phraseLane?: boolean;
  /** Internal to pickFromSources: set on a kind lane (`phraseLane`
   *  already says `task` is the phrase) — `topic` is the search task
   *  the lane serves. A streaming reader scores each phrase match
   *  against it and, when `wholeLanes` is off, keeps the matches the
   *  topic's own score curve keeps. Leave unset for a plain
   *  `searchPhrases` lookup, which is never cut. */
  readonly topic?: string;
  /** Internal to pickFromSources: the read serves one meaning lane, so
   *  `task` is the query to embed and `embed` supplies the vectors. A
   *  streaming reader scores each part's similarity inside the read —
   *  keeping what the similarity curve keeps when `wholeLanes` is off,
   *  and `limit` carries the caller's `nearest` cap — and returns only
   *  the kept parts flagged `meaningLane`, never the corpus. A reader
   *  that ignores it answers a plain keyword read, and the pick then
   *  scores the pool itself. */
  readonly meaningLane?: MeaningSearchOptions;
  /** Internal to pickFromSources: 'gate' when the pick's label gate is
   *  on, 'count' when only a decide-feed dial is (`everyRanked: { c }`
   *  or `rare`). The read result also carries the reference source's
   *  full uncut primary-search pool — every part a lane cut or the
   *  read `limit` dropped, marked absent from every lane — beside the
   *  kept members. 'gate' means the gate labels that pool, so a part
   *  sharing no words with the task can still reach the decide step
   *  and the merged list carries the miss flag; 'count' means the dial
   *  only counts the pool toward the history's size, its members reach
   *  decide only when the rare-word round pulls one in, and a keyword
   *  miss keeps `noSearchMatch`. Leave unset when neither is on. */
  readonly labelPool?: 'gate' | 'count';
  /** Remove explicit answer-format and citation clauses from search
   *  text only. Off by default; subject, counting and date needs remain. */
  readonly stripSearchInstructions?: boolean;
  /** Repository/workspace paths the task names, if the host supplied
   *  them. Ranking-signal hints only; never a filter, and never the
   *  exclusion mechanism. */
  readonly paths?: readonly string[];
  /** Paths excluded by resolved policy. The reader refuses them before
   *  opening contents and before their text reaches signals or a model.
   *  Distinct from `paths` hints. */
  readonly exclude?: readonly string[];
  /** Pin the read to one revision (a SHA, or 'HEAD'). Resolved once by
   *  the reader and used for every operation; history, contents,
   *  dates. Absent means "read the working state". */
  readonly revision?: string;
  /** Most candidates each source read should emit. Markdown and chat
   *  keep their best matches; git history enumerates latest commits
   *  before ranking. Truncated enumeration makes `complete` false. */
  readonly limit?: number;
  /** Reader part size. Readers preserve every character across parts.
   *  `pickFromSources` uses a caller's text cut or the default reader size;
   *  pick shows each part whole when its text cut is omitted. */
  readonly maxQuestionText?: number;
  /** The task's date: the moment every read measures from. An ISO 8601
   *  date or date-time, such as `2025-06-02` or
   *  `2025-06-02T09:15:00+01:00`; a date without a time means the end of
   *  that day in `timeZone`. Git recency and chat's `since` count back
   *  from it, and a chat message or git commit dated after it is not
   *  read. Absent means now, and nothing is left out for its date. */
  readonly taskDate?: string;
  /** The IANA time zone of the person asking, such as `Europe/London`:
   *  chat dates carry its offset, and a task date without an offset is
   *  read in it. Absent means the system's own zone. */
  readonly timeZone?: string;
  /** Internal to pickFromSources: the moment it read once when no
   *  `taskDate` is given, as an ISO date-time. Readers measure from it in
   *  place of now, so every read of one pick shares it, and still read
   *  records dated after it. Leave unset otherwise. */
  readonly asOf?: string;
  /** Internal to pickFromSources: the read serves the task's period.
   *  Return the parts dated from `from` to `to`, whatever their match;
   *  pickFromSources keeps only those dated inside the period, so a
   *  reader that ignores it still works. Leave unset otherwise. */
  readonly taskPeriod?: TaskPeriod;
  /** Internal to pickFromSources: the source's `decay` half-life in
   *  milliseconds. A Markdown reader then ranks each dated part lower
   *  by its age at the task date. Leave unset otherwise. */
  readonly decayHalfLife?: number;
  /** Internal to pickFromSources: the limit a kind lane's matches are
   *  cut to after the read, by score and then id. A reader that reports
   *  `decay` for that lane counts its added and dropped parts after this
   *  limit. Leave unset otherwise. */
  readonly decayLimit?: number;
  /** Cancellation reaches file reads and child processes. */
  readonly signal?: AbortSignal;
}

export type CandidateReadResult =
  | {
      readonly status: 'read';
      /** Source revision at read time; HEAD SHA or the pinned
       *  revision; recorded on the source and copied onto each
       *  candidate's sourceRevision. */
      readonly revision?: string;
      readonly candidates: readonly MemoryCandidate[];
      /** False when enumeration stopped early (limit) or skipped
       *  items; propagates into the combined coverage so a truncated
       *  rule source can never yield a falsely "complete" rule set. */
      readonly complete: boolean;
      /** Why it is partial, plus a count when items were skipped. */
      readonly partial?: string;
      /** Per-lane counts: how many candidates each search lane returned
       *  (`read`) and how many it admitted to the union (`kept`). The
       *  union size is the result's candidate count; these counts
       *  explain which lanes brought it. */
      readonly lanes?: readonly SearchLaneReport[];
      /** True when the reader already narrowed this lane at its own
       *  score curve inside the read: the candidates are the kept set,
       *  so pickFromSources does not cut them again. A streaming reader
       *  sets it when `wholeLanes` is off; a reader that returns every
       *  matched candidate leaves it unset and the pick cuts as
       *  before. */
      readonly laneCutApplied?: boolean;
      /** Candidates this lane matched and scored before the reader's
       *  own cuts: for a keyword read after its `limit`, for a kind or
       *  meaning lane the whole scored set. Reported as the lane's
       *  `read` count; unset means "as many as returned". */
      readonly matched?: number;
      /** True when the read served a `meaningLane` request: the reader
       *  scored similarity inside the read and its candidates are the
       *  kept set in lane order. A reader that ignores the flag returns
       *  an ordinary read and the pick scores its candidates itself. */
      readonly meaningLane?: boolean;
      /** No lane of this reference read kept anything: nothing in it
       *  matched the searches. The caller can see the miss and ask
       *  more broadly rather than be handed the whole history. */
      readonly noSearchMatch?: boolean;
      /** Files a rule read skipped because the agent's harness loads
       *  them every session itself, each with the reason. */
      readonly alwaysOnSkipped?: readonly { readonly file: string; readonly reason: string }[];
      /** Set by a reader that ranked with `decayHalfLife`: how many dated
       *  parts it ranked, and the ids of the parts its limit and lane cut
       *  kept (`added`) or left out (`dropped`) only because of decay. A
       *  read of several lanes compares their kept parts together. */
      readonly decay?: { readonly actedOn: number; readonly added: readonly string[]; readonly dropped: readonly string[] };
    }
  | {
      /** Expected absence: no repository, no git binary, no record
       *  file, no directory. Non-fatal; the step does not fail, the
       *  reason is recorded. Distinct from a real read failure. */
      readonly status: 'absent';
      readonly reason: string;
    };

export interface CandidateReadContext {
  /** File bytes shared within one pick, never across tasks. */
  readonly files: Map<string, Promise<string>>;
  /** Bytes cached in `files` so far. Streaming readers stop adding
   *  once the shared cap is passed, so a large corpus is never held
   *  whole; the same file within the cap is still read once. */
  fileBytes?: number;
}

export interface CandidateSource {
  /** Stable identity, recorded on every candidate and in PickRecord. */
  readonly id: string;
  /** Optional content kind, recorded per source and used by tag sets keyed by kind. */
  readonly kind?: CandidateSourceKind;
  /** The decision questions asked of this source's reference parts; set by `historySource()`. */
  readonly questions?: PickCascade;
  /** Kinds this source can add through the label lane. Omitted means none. */
  readonly labelKinds?: readonly LabelKind[];
  /** The label bar for this source's parts; set by `historySource()`.
   *  Omitted means LABEL_LANE_BAR, 0.5. */
  readonly labelBar?: number;
  /** Run the rare-word round on this source's reference evidence by default. */
  readonly rare?: boolean;
  /** Open one exact-phrase lane per name the task names; set by `historySource()`. */
  readonly names?: boolean;
  /** The decision-score bar for this source's reference parts: a part
   *  scored at or above it is kept. Omitted means 0.0146. */
  readonly bar?: number;
  /** The bar for this source's rule parts. Omitted means 0. */
  readonly ruleBar?: number;
  /** The decay half-life this source's Markdown parts rank with; set by `historySource()`. */
  readonly decay?: { readonly halfLife: string };
  /** 'reference' | 'rule' | 'mixed'; declared so the caller knows
   *  whether this source can feed the applicable-rule set. */
  readonly role: 'reference' | 'rule' | 'mixed';
  /** Reader part size; Infinity requests whole items by default. */
  readonly maxQuestionText?: number;
  read(request: CandidateReadRequest, context?: CandidateReadContext): Promise<CandidateReadResult>;
}

/** The settings a history source carries: they act on its own parts
 *  only. */
export interface HistorySettings {
  /** Run the rare-word round on this source's parts. */
  readonly rare: boolean;
  /** The label kinds asked of each part, so parts the keyword search
   *  missed can reach the decision step: true for LABEL_KINDS, a list
   *  for those kinds, false for none. */
  readonly labels: boolean | readonly LabelKind[];
  /** The label bar, from 0 to 1: a label kind the task needs at this
   *  bar or more puts each of this source's parts labelled at this bar
   *  or more on that kind in the label lane. Absent means
   *  LABEL_LANE_BAR, 0.5. */
  readonly labelBar?: number;
  /** The decision-score bar for this source's reference parts. */
  readonly bar: number;
  /** The bar for this source's rule parts; absent means 0. */
  readonly ruleBar?: number;
  /** The decision questions asked of this source's reference parts.
   *  Absent: the built-in question for the part's kind. */
  readonly questions?: PickCascade;
  /** Rank older notes lower, by their age at the task date. A duration
   *  such as '365 days': the age at which a note has lost half of the
   *  full decay. Absent or false: off. Markdown sources only. */
  readonly decay?: { readonly halfLife: string } | false;
  /** Search this source once more for each name the task names, as an
   *  exact phrase that ignores case, so a part that mentions a name
   *  reaches the decision step even when the keyword search ranked it
   *  low. The reason is recall: a part the search loses never reaches
   *  the decision step. Like a `searchPhrases` lane, a name lane is
   *  never cut on its score curve; it holds at most the read's `limit`
   *  matches, and `maxCandidates` and an `everyRanked: { c }` cut apply
   *  to it as to every lane. A task with no names opens no lane. */
  readonly names: boolean;
}

/** A source that reads with these settings. `reader` is any source:
 *  what `chat()`, `git()` or `markdown()` return, or your own. Spread a
 *  reader package's settings object to start from its tuned values. */
export function historySource(config: { readonly reader: CandidateSource } & HistorySettings): CandidateSource {
  const { reader, rare, labels, labelBar, bar, ruleBar, questions, names, decay } = config;
  checkCascadeKeys(questions, 'questions');
  checkCascade(questions);
  if (labelBar !== undefined && (typeof labelBar !== 'number' || !Number.isFinite(labelBar) || labelBar < 0 || labelBar > 1)) {
    throw new TypeError('labelBar must be a number from 0 to 1.');
  }
  if (decay !== undefined && decay !== false) {
    if (reader.kind !== 'markdown') throw new TypeError('decay applies to Markdown sources only.');
    durationMs(decay?.halfLife, 'decay.halfLife');
  }
  const { labelKinds: _labelKinds, labelBar: _labelBar, ruleBar: _ruleBar, questions: _questions, names: _names, decay: _decay,
    ...rest } = reader;
  const labelKinds = labels === true ? LABEL_KINDS : labels === false ? [] : labels;
  return { ...rest, rare, bar, names,
    ...(labelKinds.length ? { labelKinds } : {}), ...(labelBar === undefined ? {} : { labelBar }),
    ...(ruleBar === undefined ? {} : { ruleBar }),
    ...(questions === undefined ? {} : { questions }),
    ...(decay === undefined || decay === false ? {} : { decay: { halfLife: decay.halfLife } }) };
}

/** A real read failure: permission denied, corrupt store, killed
 *  mid-read. Cancellation throws the same class with code 'cancelled',
 *  kept apart from 'failed' so a caller can tell them apart. Expected
 *  absence is the 'absent' result, not a throw. */
export class SourceReadError extends Error {
  readonly code: 'failed' | 'cancelled';

  constructor(code: 'failed' | 'cancelled', message: string) {
    super(message);
    this.name = 'SourceReadError';
    this.code = code;
  }
}

export interface PickSourcesResult extends PickResult {
  /** Each source's combined search result, in source order. Absent
   *  reasons and partial notes remain available beside the pick record. */
  readonly reads: readonly CandidateReadResult[];
}

interface SearchTask {
  readonly task: string;
  readonly lane: 'search' | 'phrase' | 'kind' | 'name';
}

/** The read's lanes: the task, each search line, then each phrase, kind
 *  phrase and name that no earlier phrase lane already searches. */
function searchTasks(request: CandidateReadRequest, kind: CandidateSource['kind'], names: readonly string[]): SearchTask[] {
  const searchTask = (task: string) => request.stripSearchInstructions ? stripSearchInstructions(task) : task;
  const tasks: SearchTask[] = [{ task: searchTask(request.task), lane: 'search' }];
  const seen = new Set([tasks[0]!.task.trim()]);
  for (const line of request.searchLines ?? []) {
    const task = searchTask(line.trim());
    if (!task || seen.has(task.trim())) continue;
    seen.add(task.trim());
    tasks.push({ task, lane: 'search' });
  }
  const phrases = new Set<string>();
  const phrase = (line: string, lane: 'phrase' | 'kind' | 'name') => {
    const task = line.trim();
    if (!task || phrases.has(task)) return;
    phrases.add(task);
    tasks.push({ task, lane });
  };
  for (const line of request.searchPhrases ?? []) phrase(line, 'phrase');
  for (const line of (kind === undefined ? [] : request.kindLanes?.[kind] ?? [])) phrase(line, 'kind');
  for (const name of names) phrase(name, 'name');
  return tasks;
}

/** What a read with `wholeLanes` on returns for one source's lane: every
 *  candidate, in its own order, with each one the lane cut would drop
 *  marked `pastLaneCut`. The cut is `cutLane`'s, and a lane with no
 *  positive score keeps nothing under the cut, so all of it is marked.
 *  A mark the reader already set stays. */
function markLaneCut(group: readonly MemoryCandidate[]): MemoryCandidate[] {
  const matched = group.some((candidate) => laneScoreOf(candidate) > 0);
  const bend = matched ? laneBend(group.map(laneScoreOf)) : undefined;
  return group.map((candidate) => !matched || (bend !== undefined && laneScoreOf(candidate) <= bend)
    ? { ...candidate, pastLaneCut: true } : candidate);
}

/** The candidate without a `pastLaneCut` mark. */
function unmarked(candidate: MemoryCandidate): MemoryCandidate {
  const { pastLaneCut: _pastLaneCut, ...rest } = candidate;
  return rest;
}

/** The read request option each `searchRanks` position of a source's
 *  read comes from: its search tasks, then one meaning lane per distinct
 *  search text that is not a kind phrase or a name. */
function laneOrigins(
  request: CandidateReadRequest, kind: CandidateSource['kind'], names: readonly string[],
): SearchLaneOrigin[] {
  const tasks = searchTasks(request, kind, names);
  const origins = tasks.map(({ lane }, index): SearchLaneOrigin => lane === 'search'
    ? (index === 0 ? 'task' : 'searchLines')
    : lane === 'phrase' ? 'searchPhrases' : lane === 'name' ? 'names' : 'kindLanes');
  const queries = new Set(tasks.filter(({ lane }) => lane !== 'kind' && lane !== 'name')
    .map(({ task }) => task.trim()).filter(Boolean));
  return request.meaning ? [...origins, ...[...queries].map((): SearchLaneOrigin => 'meaning')] : origins;
}

/** One lane's candidates with their `pastLaneCut` marks settled. Only a
 *  reference source read with `wholeLanes` on keeps marks (`marking`).
 *  A search lane the reader did not cut itself is marked here, keeping
 *  any mark the reader set; a phrase or name lane is never cut, so it
 *  holds no mark; a kind lane keeps the reader's marks. */
function laneMarks(
  candidates: readonly MemoryCandidate[],
  marking: boolean,
  lane: SearchTask['lane'],
  readerCut: boolean,
): MemoryCandidate[] {
  if (!marking || lane === 'phrase' || lane === 'name') return candidates.map(unmarked);
  if (lane === 'kind' || readerCut) return [...candidates];
  const groups = new Map<string, MemoryCandidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.sourceId);
    if (group === undefined) groups.set(candidate.sourceId, [candidate]);
    else group.push(candidate);
  }
  const marked = new Map([...groups.values()].flatMap((group) =>
    markLaneCut(group).map((candidate, index) => [group[index]!, candidate] as const)));
  return candidates.map((candidate) => marked.get(candidate)!);
}

/** Exact-match filter shared by phrase and kind lanes: candidates
 *  whose text or title contains the lane's phrase at least once. In a
 *  kind lane with `speakerOnly`, chat candidates also need the 'user'
 *  role; candidates without chat metadata pass. Returns a fresh read
 *  with phrase-count signals. */
function phraseFilter(
  request: CandidateReadRequest,
  task: string,
  speaker: boolean,
  read: Extract<CandidateReadResult, { status: 'read' }>,
): Extract<CandidateReadResult, { status: 'read' }> {
  const matches = read.candidates
    .map((candidate) => ({ candidate, count: phraseCount(candidate.text, task) + phraseCount(candidate.title, task) }))
    .filter(({ count, candidate }) => count > 0
      && (!speaker || candidate.chat === undefined || candidate.chat.role === 'user'))
    // A reader that scored the lane (a kind lane's topic score) keeps
    // its own order; otherwise the phrase's occurrence count orders.
    .sort((left, right) =>
      (right.candidate.laneScore ?? right.count) - (left.candidate.laneScore ?? left.count)
      || left.candidate.id.localeCompare(right.candidate.id));
  const limited = request.limit !== undefined && matches.length > request.limit;
  return { ...read,
    candidates: (limited ? matches.slice(0, request.limit) : matches)
      // The lane's match score is the reader's `laneScore` when it
      // carried one, else the phrase's occurrence count.
      .map(({ candidate, count }) => ({
        ...candidate,
        signals: { ...candidate.signals, phrase: count },
        laneScore: candidate.laneScore ?? count,
      })),
    complete: read.complete && !limited,
    ...(limited ? { partial: [read.partial, `the phrase limit kept ${request.limit} of ${matches.length} candidates`].filter(Boolean).join('; ') } : {}),
  };
}

async function readKeywordSearches(
  source: CandidateSource,
  request: CandidateReadRequest,
  context: CandidateReadContext,
  names: readonly string[],
): Promise<CandidateReadResult> {
  const tasks = searchTasks(request, source.kind, names);
  // The cut applies to keyword lanes on reference sources only.
  const laneCut = request.wholeLanes !== true && source.role === 'reference';
  const marking = request.wholeLanes === true && source.role === 'reference';
  if (tasks.length === 1) {
    const read = await source.read({ ...request, task: tasks[0]!.task, wholeLanes: !laneCut }, context);
    const report = {
      task: tasks[0]!.task, lane: 'search' as const,
      read: read.status === 'read' ? read.matched ?? read.candidates.length : 0,
    };
    if (read.status !== 'read') return read;
    if (!laneCut || read.laneCutApplied === true) {
      return { ...read, lanes: [{ ...report, kept: read.candidates.length }],
        candidates: laneMarks(read.candidates, marking, 'search', read.laneCutApplied === true),
        ...(laneCut && read.candidates.length === 0 ? { noSearchMatch: true } : {}) };
    }
    const groups = new Map<string, MemoryCandidate[]>();
    for (const candidate of read.candidates) {
      const group = groups.get(candidate.sourceId);
      if (group === undefined) groups.set(candidate.sourceId, [candidate]);
      else group.push(candidate);
    }
    // A lane where nothing scored above zero matched nothing and keeps
    // nothing; only a positive score gives the curve something to cut.
    const kept: MemoryCandidate[] = [];
    for (const group of groups.values()) {
      if (!group.some((candidate) => laneScoreOf(candidate) > 0)) continue;
      kept.push(...cutLane(group, true).kept);
    }
    return { ...read, candidates: kept, lanes: [{ ...report, kept: kept.length }],
      ...(kept.length === 0 ? { noSearchMatch: true } : {}) };
  }

  // `past` holds while every lane that holds the candidate holds it past the lane cut.
  const union = new Map<string, { candidate: MemoryCandidate; ranks: (number | null)[]; best: number; past: boolean }>();
  const reasons = new Set<string>();
  const absent = new Set<string>();
  const reports: SearchLaneReport[] = [];
  let revision = request.revision;
  let resolvedRevision: string | undefined;
  let complete = true;
  let readAny = false;
  let alwaysOnSkipped: Extract<CandidateReadResult, { status: 'read' }>['alwaysOnSkipped'];
  // Decay's ranked count is the task's own lane's; `plainKept` holds the
  // parts the lanes keep without decay, so the source's added and
  // dropped parts compare what all its lanes keep together.
  let decayRanked: number | undefined;
  const plainKept = new Set<string>();
  for (const [lane, { task, lane: kind }] of tasks.entries()) {
    // Phrase and kind filtering must precede the per-read limit. The
    // `phraseLane` flag tells a streaming reader its `task` is an exact
    // phrase to match, so it can keep matches without scoring the rest.
    // A kind lane also carries `topic` (the search task) so the reader
    // can rank the matches by it and cut that curve inside the read.
    let read = await source.read({ ...request, task,
      ...(kind === 'search'
        ? { wholeLanes: !laneCut }
        : kind === 'kind'
          ? { limit: undefined, phraseLane: true, topic: tasks[0]!.task, wholeLanes: !laneCut,
            ...(request.decayHalfLife === undefined || request.limit === undefined ? {} : { decayLimit: request.limit }) }
          : { limit: undefined, phraseLane: true }),
      ...(revision === undefined ? {} : { revision }) }, context);
    // `read` on the report counts what the source matched for this
    // lane — its `matched` count when it cut inside the read — before a
    // phrase or speaker filter removed non-matches.
    const returned = read.status === 'read' ? read.matched ?? read.candidates.length : 0;
    if (kind !== 'search' && read.status === 'read') {
      read = phraseFilter(request, task, kind === 'kind' && request.speakerOnly === true, read);
    }
    if (read.status === 'absent') {
      absent.add(read.reason);
      reasons.add(`search ${lane + 1} absent: ${read.reason}`);
      complete = false;
      continue;
    }
    readAny = true;
    alwaysOnSkipped ??= read.alwaysOnSkipped;
    if (lane === 0) decayRanked = read.decay?.actedOn;
    if (resolvedRevision === undefined && read.revision !== undefined) resolvedRevision = read.revision;
    if (resolvedRevision !== undefined && (request.revision !== undefined
      || !(source.kind === 'markdown' && source.role === 'rule'))) revision = resolvedRevision;
    if (!read.complete) {
      complete = false;
      reasons.add(read.partial ?? `search ${lane + 1} did not enumerate completely`);
    }
    const groups = new Map<string, MemoryCandidate[]>();
    for (const candidate of laneMarks(read.candidates, marking, kind, read.laneCutApplied === true)) {
      const group = groups.get(candidate.sourceId);
      if (group === undefined) groups.set(candidate.sourceId, [candidate]);
      else group.push(candidate);
    }
    let laneKept = 0;
    for (const group of groups.values()) {
      const positive = kind !== 'search' || !laneCut
        || group.some((candidate) => laneScoreOf(candidate) > 0);
      // A search lane where nothing scores above zero matched nothing:
      // it admits nothing and holds no bodies while it waits on its
      // siblings. A reader that already cut this lane returns the kept
      // set, and a kind lane is never cut here: the phrase's occurrence
      // count is no relevance measure, and a reader that did not score
      // the task keeps every match rather than lose a one-off direction.
      if (!positive) continue;
      const cut = read.laneCutApplied === true && kind !== 'phrase' && kind !== 'name'
        ? { kept: group, read: group.length }
        : cutLane(group, positive && kind === 'search' && laneCut);
      laneKept += cut.kept.length;
      for (const candidate of cut.kept) if (!read.decay?.added.includes(candidate.id)) plainKept.add(candidate.id);
      const ranked = new Set<string>();
      for (const candidate of cut.kept) {
        const key = JSON.stringify([candidate.sourceId, candidate.id]);
        if (ranked.has(key)) continue;
        const rank = ranked.size;
        ranked.add(key);
        const value = read.revision === undefined || candidate.sourceRevision !== undefined
          ? candidate : { ...candidate, sourceRevision: read.revision };
        const existing = union.get(key);
        const past = candidate.pastLaneCut === true;
        if (existing === undefined) {
          const ranks = Array<number | null>(tasks.length).fill(null);
          ranks[lane] = rank;
          union.set(key, { candidate: value, ranks, best: rank, past });
        } else {
          existing.ranks[lane] = rank;
          existing.past &&= past;
          if (rank < existing.best) {
            existing.best = rank;
            existing.candidate = value;
          }
        }
      }
    }
    for (const id of read.decay?.dropped ?? []) plainKept.add(id);
    reports.push({ task, lane: kind, read: returned, kept: laneKept });
  }
  const keptIds = new Set([...union.values()].map(({ candidate }) => candidate.id));
  const decay = decayRanked === undefined ? undefined : { actedOn: decayRanked,
    added: [...keptIds].filter((id) => !plainKept.has(id)), dropped: [...plainKept].filter((id) => !keptIds.has(id)) };
  if (!readAny) return { status: 'absent', reason: [...absent].join('; ') };
  // No lane of this read kept anything into the union: nothing
  // matched, and the caller sees the miss rather than the whole
  // history.
  const noSearchMatch = laneCut && union.size === 0;
  return {
    status: 'read', complete,
    ...(resolvedRevision === undefined ? {} : { revision: resolvedRevision }),
    candidates: [...union.values()].map(({ candidate, ranks, past }) =>
      ({ ...unmarked(candidate), searchRanks: ranks, ...(past ? { pastLaneCut: true as const } : {}) })),
    lanes: reports,
    ...(alwaysOnSkipped === undefined ? {} : { alwaysOnSkipped }),
    ...(decay === undefined ? {} : { decay }),
    ...(noSearchMatch ? { noSearchMatch: true } : {}),
    ...(reasons.size === 0 ? {} : { partial: [...reasons].join('; ') }),
  };
}

async function readSearches(
  source: CandidateSource,
  request: CandidateReadRequest,
  context: CandidateReadContext,
  names: readonly string[],
): Promise<CandidateReadResult> {
  const found = await readKeywordSearches(source, request, context, names);
  if (found.status !== 'read' || (!request.meaning && request.labelPool === undefined)) return found;
  const tasks = searchTasks(request, source.kind, names);
  const laneCut = request.wholeLanes !== true && source.role === 'reference';
  const marking = request.wholeLanes === true && source.role === 'reference';
  // The uncut, unlimited primary-search pool, fetched at most once and
  // shared by the label pool merge and the scored meaning path: a lane
  // cut or a read limit must not hide candidates from either.
  let poolRead: CandidateReadResult | undefined;
  const fullPool = async (): Promise<CandidateReadResult> => {
    if (poolRead === undefined) {
      poolRead = await source.read({
        ...request, task: tasks[0]!.task, searchLines: undefined, searchPhrases: undefined,
        kindLanes: undefined, meaning: undefined, limit: undefined, wholeLanes: true,
        meaningLane: undefined, labelPool: undefined,
        ...(found.revision === undefined ? {} : { revision: found.revision }),
      }, context);
    }
    return poolRead;
  };
  let read = found;
  if (request.labelPool !== undefined && source.role === 'reference'
    && (laneCut || request.limit !== undefined)) {
    const full = await fullPool();
    if (full.status !== 'read') {
      throw new SourceReadError('failed', `The uncut search pool could not be read: ${full.reason}`);
    }
    // Kept members hold their lane ranks; a part the lanes dropped joins
    // as a pool member, absent from every lane, for the label gate to see.
    const union = new Map(read.candidates.map((candidate) =>
      [JSON.stringify([candidate.sourceId, candidate.id]), candidate] as const));
    for (const candidate of full.candidates) {
      const key = JSON.stringify([candidate.sourceId, candidate.id]);
      if (!union.has(key) && candidate.role === 'reference') {
        union.set(key, { ...unmarked(candidate), searchRanks: undefined, poolOnly: true });
      }
    }
    const partial = [read.partial, full.partial].filter(Boolean).join('; ');
    // When the gate can label the pool a member can still reach the
    // decide step, so the miss flag reads the merged list. When the
    // pool only counts toward the dial's N its members reach decide
    // only through the rare-word round, so a keyword miss keeps
    // noSearchMatch.
    const missed = request.labelPool === 'count' && read.noSearchMatch === true;
    const { noSearchMatch: _miss, ...mergedRead } = read;
    read = { ...mergedRead, candidates: [...union.values()],
      complete: read.complete && full.complete,
      ...(missed || (laneCut && union.size === 0) ? { noSearchMatch: true } : {}),
      ...(partial === '' ? {} : { partial }) };
  }
  if (!request.meaning) return read;
  // One meaning lane per distinct search text that is not a kind phrase
  // or a name: the task and each search line or phrase.
  const queries = [...new Set(
    tasks.filter(({ lane }) => lane !== 'kind' && lane !== 'name').map(({ task }) => task.trim()).filter(Boolean),
  )];
  const lanes = [...(read.lanes ?? [])];

  // The miss reads actual lane membership when the pool only counts
  // toward the dial's N: a pool member no lane ranked stays poolOnly
  // and reaches decide only when the rare-word round pulls it in, so a
  // read that kept only pool members is still a miss. Otherwise any
  // kept candidate is a match.
  const matched = (list: readonly MemoryCandidate[]) =>
    request.labelPool === 'count'
      ? list.some((candidate) => candidate.searchRanks?.some((rank) => rank !== null) === true)
      : list.length > 0;

  // A streaming reader scores similarity inside the read and returns
  // its kept set flagged `meaningLane`, so the corpus is never held
  // here at all. A reader that ignores the flag answers an ordinary
  // keyword read, and the pool is scored below as before.
  const meaningReads: { offset: number; query: string; read: Extract<CandidateReadResult, { status: 'read' }> }[] = [];
  const meaningReports: (SearchLaneReport | undefined)[] = Array.from({ length: queries.length });
  const reasons: string[] = [];
  let native = queries.length > 0;
  for (const [offset, query] of queries.entries()) {
    const laneRead = await source.read({ ...request, task: query,
      searchLines: undefined, searchPhrases: undefined, kindLanes: undefined,
      meaning: undefined, phraseLane: undefined, speakerOnly: undefined,
      limit: request.meaning.nearest,
      wholeLanes: request.meaning.wholeLanes ?? !laneCut,
      meaningLane: request.meaning,
      ...(read.revision === undefined ? {} : { revision: read.revision }) }, context);
    if (laneRead.status === 'absent') {
      reasons.push(`meaning lane absent: ${laneRead.reason}`);
      meaningReports[offset] = { task: query, lane: 'meaning', read: 0, kept: 0 };
      continue;
    }
    if (laneRead.meaningLane !== true) { native = false; break; }
    meaningReads.push({ offset, query, read: laneRead });
    if (!laneRead.complete) reasons.push(laneRead.partial ?? `the meaning lane did not enumerate completely`);
  }
  if (native) {
    const union = new Map(read.candidates.map((candidate) =>
      [JSON.stringify([candidate.sourceId, candidate.id]), candidate] as const));
    // A single-search read leaves its candidates without lane-0 ranks;
    // order them by signal sum per source, the same rank the scored
    // path below assigns. A pool member is no keyword result.
    const unraked = [...union.values()].filter((candidate) =>
      candidate.searchRanks === undefined && candidate.poolOnly !== true);
    if (unraked.length > 0) {
      const groups = new Map<string, MemoryCandidate[]>();
      for (const candidate of unraked) {
        const group = groups.get(candidate.sourceId);
        if (group === undefined) groups.set(candidate.sourceId, [candidate]);
        else group.push(candidate);
      }
      for (const group of groups.values()) {
        [...group].sort((left, right) =>
          Object.values(right.signals).reduce((sum, value) => sum + value, 0)
          - Object.values(left.signals).reduce((sum, value) => sum + value, 0)
          || left.id.localeCompare(right.id)
        ).forEach((candidate, rank) => {
          union.set(JSON.stringify([candidate.sourceId, candidate.id]),
            { ...candidate, searchRanks: [rank] });
        });
      }
    }
    const laneCount = tasks.length + queries.length;
    const bestRank = (ranks: readonly (number | null)[] | undefined) =>
      (ranks ?? []).reduce<number>((best, rank) => (rank === null ? best : Math.min(best, rank)), Number.POSITIVE_INFINITY);
    for (const { offset, query, read: laneRead } of meaningReads) {
      const lane = tasks.length + offset;
      const groups = new Map<string, MemoryCandidate[]>();
      for (const candidate of laneRead.candidates) {
        const group = groups.get(candidate.sourceId);
        if (group === undefined) groups.set(candidate.sourceId, [candidate]);
        else group.push(candidate);
      }
      let kept = 0;
      for (const group of groups.values()) {
        group.forEach((candidate, rank) => {
          const key = JSON.stringify([candidate.sourceId, candidate.id]);
          const existing = union.get(key);
          const ranks = Array<number | null>(laneCount).fill(null);
          existing?.searchRanks?.forEach((value, at) => { ranks[at] = value; });
          ranks[lane] = rank;
          const value = laneRead.revision === undefined || candidate.sourceRevision !== undefined
            ? candidate : { ...candidate, sourceRevision: laneRead.revision };
          // Past the cut only while every lane holding it holds it past the cut; a pool member holds no lane.
          const past = marking && candidate.pastLaneCut === true
            && (existing === undefined || existing.poolOnly === true || existing.pastLaneCut === true);
          union.set(key, { ...unmarked(existing !== undefined && bestRank(existing.searchRanks) <= rank ? existing : value),
            searchRanks: ranks, ...(past ? { pastLaneCut: true as const } : {}) });
          kept += 1;
        });
      }
      meaningReports[offset] = { task: query, lane: 'meaning', read: laneRead.matched ?? laneRead.candidates.length, kept };
    }
    lanes.push(...meaningReports.filter((report) => report !== undefined));
    const combined = [...union.values()];
    const partial = [read.partial, ...reasons].filter(Boolean).join('; ');
    // The flag reads the combined read: a meaning lane that matched
    // rescues a keyword miss, and only a read that kept nothing is one.
    const { noSearchMatch: _keywordMiss, ...rest } = read;
    // A part a meaning lane keeps is kept with or without decay.
    const meaningKept = new Set(meaningReads.flatMap(({ read: laneRead }) => laneRead.candidates.map((candidate) => candidate.id)));
    return { ...rest, complete: read.complete && reasons.length === 0,
      candidates: combined, lanes,
      ...(rest.decay === undefined ? {} : { decay: { actedOn: rest.decay.actedOn,
        added: rest.decay.added.filter((id) => !meaningKept.has(id)),
        dropped: rest.decay.dropped.filter((id) => !meaningKept.has(id)) } }),
      ...(laneCut && !matched(combined) ? { noSearchMatch: true } : {}),
      ...(partial === '' ? {} : { partial }) };
  }

  // The source answered the meaning lane like a keyword read, so the
  // candidates it returned are scored here. A keyword read limit or the
  // lane cut must not hide candidates from meaning search: the meaning
  // lanes score the whole pool the source returned.
  let candidates = read.candidates;
  let complete = read.complete;
  let partial = read.partial;
  if (request.limit !== undefined || laneCut) {
    const full = await fullPool();
    if (full.status !== 'read') throw new SourceReadError('failed', `Meaning search could not read all candidates: ${full.reason}`);
    const keyword = new Map<string, MemoryCandidate>();
    const ranked = [...candidates].sort((left, right) =>
      Object.values(right.signals).reduce((sum, value) => sum + value, 0)
      - Object.values(left.signals).reduce((sum, value) => sum + value, 0) || left.id.localeCompare(right.id));
    const counts = new Map<string, number>();
    for (const candidate of ranked) {
      const rank = counts.get(candidate.sourceId) ?? 0;
      counts.set(candidate.sourceId, rank + 1);
      // A pool member is no keyword result: it keeps poolOnly and no
      // lane rank, and stays here only so the pool read below is not
      // repeated for it.
      keyword.set(JSON.stringify([candidate.sourceId, candidate.id]),
        candidate.poolOnly === true ? candidate : { ...candidate, searchRanks: candidate.searchRanks ?? [rank] });
    }
    for (const candidate of full.candidates) {
      const key = JSON.stringify([candidate.sourceId, candidate.id]);
      if (!keyword.has(key)) keyword.set(key, { ...unmarked(candidate), searchRanks: Array(tasks.length).fill(null) });
    }
    candidates = [...keyword.values()];
    complete = read.complete && full.complete;
    if (full.partial) partial = [partial, full.partial].filter(Boolean).join('; ');
  }
  const scoredMeaning = await addMeaningRanks(candidates, tasks[0]!.task, {
    ...request.meaning, wholeLanes: request.meaning.wholeLanes ?? !laneCut,
    searchLines: queries.filter((query) => query !== tasks[0]!.task.trim()),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  // Only a reference source read with `wholeLanes` on keeps the meaning lanes' marks.
  const meaningful = marking ? scoredMeaning : scoredMeaning.map(unmarked);
  const pool = new Set(candidates.map((candidate) => JSON.stringify([candidate.sourceId, candidate.id]))).size;
  for (const [offset, query] of queries.entries()) {
    lanes.push({ task: query, lane: 'meaning', read: pool,
      kept: meaningful.filter((candidate) => (candidate.searchRanks?.[tasks.length + offset] ?? null) !== null).length });
  }
  const { noSearchMatch: _keywordMiss, ...rest } = read;
  return { ...rest, complete, candidates: meaningful, lanes,
    ...(laneCut && !matched(meaningful) ? { noSearchMatch: true } : {}),
    ...(partial === undefined ? {} : { partial }) };
}

/** The parts dated inside the task's period that no lane kept, added to
 *  a read beside its own, marked `dateWindow` and absent from every
 *  lane, so the pick admits them to the decide step. A pool member dated
 *  inside the period gains the mark; a lane member is left as it is.
 *  Nothing is removed. A rule source is never cut, so it is not read
 *  again. */
async function addTaskPeriod(
  source: CandidateSource,
  request: CandidateReadRequest,
  period: TaskPeriod,
  found: CandidateReadResult,
  context: CandidateReadContext,
): Promise<CandidateReadResult> {
  if (found.status !== 'read' || source.role === 'rule') return found;
  const read = await source.read({
    ...request, task: searchTasks(request, source.kind, [])[0]!.task, taskPeriod: period,
    searchLines: undefined, searchPhrases: undefined, kindLanes: undefined, meaning: undefined, limit: undefined,
    wholeLanes: true, phraseLane: undefined, topic: undefined, meaningLane: undefined, labelPool: undefined,
    ...(found.revision === undefined ? {} : { revision: found.revision }),
  }, context);
  if (read.status !== 'read') throw new SourceReadError('failed', `The task's period could not be read: ${read.reason}`);
  const union = new Map(found.candidates.map((candidate) =>
    [JSON.stringify([candidate.sourceId, candidate.id]), candidate] as const));
  for (const candidate of read.candidates) {
    if (candidate.role !== 'reference' || candidate.date === undefined || !datedIn(candidate.date.value, period)) continue;
    const key = JSON.stringify([candidate.sourceId, candidate.id]);
    const existing = union.get(key);
    if (existing !== undefined && existing.poolOnly !== true) continue;
    union.set(key, { ...unmarked(existing ?? candidate), searchRanks: undefined, poolOnly: true,
      dateWindow: 'task-period' });
  }
  const partial = [found.partial, read.partial].filter(Boolean).join('; ');
  return { ...found, candidates: [...union.values()], complete: found.complete && read.complete,
    ...(partial === '' ? {} : { partial }) };
}

/**
 * Read every source, then pick over the combined candidates. The read
 * revision is copied onto candidates that do not carry their own
 * sourceRevision, and a rule source that did not enumerate completely
 * (`complete: false`, or absent when rules were expected) makes the
 * record's rulesCoverage 'incomplete' even when every supplied rule was
 * answered. A caller-supplied `rulesEnumerationComplete: false` in the
 * options is honoured the same way.
 */
export async function pickFromSources(
  sources: readonly CandidateSource[],
  request: CandidateReadRequest,
  options: PickOptions,
): Promise<PickSourcesResult> {
  checkReadRequest(request);
  checkPickOptions(options);
  if (request.kindLanes !== undefined) {
    if (typeof request.kindLanes !== 'object' || request.kindLanes === null || Array.isArray(request.kindLanes)) {
      throw new TypeError('kindLanes maps source kinds to phrase lists.');
    }
    for (const [kind, lanes] of Object.entries(request.kindLanes)) {
      if (lanes === undefined) continue;
      if (!['chat', 'git-history', 'markdown'].includes(kind)
        || !Array.isArray(lanes) || lanes.some((line) => typeof line !== 'string' || !line.trim())) {
        throw new TypeError('kindLanes maps chat, git-history and markdown to nonblank phrase strings.');
      }
    }
  }
  if (request.wholeLanes !== undefined && typeof request.wholeLanes !== 'boolean') {
    throw new TypeError('wholeLanes must be a boolean.');
  }
  if (request.speakerOnly !== undefined && typeof request.speakerOnly !== 'boolean') {
    throw new TypeError('speakerOnly must be a boolean.');
  }
  // One moment for every read: the task date, or now when none is given.
  const timeZone = timeZoneOf(request.timeZone ?? options.timeZone);
  const taskDate = request.taskDate ?? options.taskDate;
  const asOf = zonedIso(taskMoment(taskDate, timeZone), timeZone);
  const period = options.taskPeriod === false ? undefined : taskPeriod(options.task, { asOf, timeZone });
  const context: CandidateReadContext = { files: new Map() };
  const labelKindsBySource: Record<string, readonly LabelKind[]> = Object.fromEntries(
    sources.map((source) => [source.id, source.labelKinds ?? []]),
  );
  const rareBySource: Record<string, boolean> = Object.fromEntries(
    sources.map((source) => [source.id, source.rare ?? false]),
  );
  const labelBarBySource: Record<string, number> = Object.fromEntries(
    sources.flatMap((source) => source.labelBar === undefined ? [] : [[source.id, source.labelBar]]),
  );
  const barBySource: Record<string, number> = Object.fromEntries(
    sources.flatMap((source) => source.bar === undefined ? [] : [[source.id, source.bar]]),
  );
  const ruleBarBySource: Record<string, number> = Object.fromEntries(
    sources.flatMap((source) => source.ruleBar === undefined ? [] : [[source.id, source.ruleBar]]),
  );
  // No prototype, so a candidate's source id such as `__proto__` is stored as its own key.
  const questionsBySource: Record<string, PickCascade> = Object.assign(Object.create(null), Object.fromEntries(
    sources.flatMap((source) => source.questions === undefined ? [] : [[source.id, source.questions]]),
  ));
  checkPickOptions({ ...options, labelKindsBySource, labelBarBySource, rareBySource, barBySource, ruleBarBySource,
    questionsBySource });
  checkWriteQuestions({ ...options, questionsBySource });
  // The task's names, found once for every source with name lanes on.
  const found = sources.some((source) => source.names === true) ? await findTaskNames(options) : undefined;
  const namesFor = (source: CandidateSource) => source.names === true ? found!.found : [];
  const reads = await Promise.all(sources.map(async (source) => {
    const sourceRequest: CandidateReadRequest = {
      ...request, ...(taskDate === undefined ? { asOf } : { taskDate }), timeZone, taskPeriod: undefined,
      ...(source.decay === undefined ? {} : { decayHalfLife: durationMs(source.decay.halfLife, 'decay.halfLife') }),
      maxQuestionText: options.limits?.maxQuestionText ?? request.maxQuestionText
        ?? (source.maxQuestionText === Number.POSITIVE_INFINITY ? undefined : source.maxQuestionText ?? DEFAULT_MAX_QUESTION_TEXT),
      labelPool: (source.labelKinds?.length ?? 0) > 0 ? 'gate'
        : (options.everyRanked !== undefined && options.everyRanked !== true)
          || (options.rare ?? source.rare ?? false) !== false
          ? 'count' : undefined,
    };
    const read = await readSearches(source, sourceRequest, context, namesFor(source));
    return period === undefined ? read : addTaskPeriod(source, sourceRequest, period, read, context);
  }));
  const candidates: MemoryCandidate[] = [];
  const sourceKinds: Record<string, CandidateSourceKind> = Object.assign(Object.create(null), options.sourceKinds);
  let rulesEnumerationComplete = options.rulesEnumerationComplete !== false;
  for (const [index, read] of reads.entries()) {
    // A source that returns no parts still names its kind in the record.
    const declared = sources[index]!.kind;
    if (declared !== undefined && (read.status !== 'read' || read.candidates.length === 0)) {
      sourceKinds[sources[index]!.id] = declared;
    }
    if (read.status !== 'read') {
      if (sources[index]!.role !== 'reference') rulesEnumerationComplete = false;
      continue;
    }
    if (sources[index]!.role !== 'reference' && !read.complete) rulesEnumerationComplete = false;
    for (const candidate of read.candidates) {
      labelKindsBySource[candidate.sourceId] = sources[index]!.labelKinds ?? [];
      rareBySource[candidate.sourceId] = sources[index]!.rare ?? false;
      const { labelBar, bar, ruleBar, questions } = sources[index]!;
      if (labelBar !== undefined) labelBarBySource[candidate.sourceId] = labelBar;
      if (bar !== undefined) barBySource[candidate.sourceId] = bar;
      if (ruleBar !== undefined) ruleBarBySource[candidate.sourceId] = ruleBar;
      if (questions !== undefined) questionsBySource[candidate.sourceId] = questions;
      const kind = sources[index]!.kind;
      if (kind !== undefined) sourceKinds[candidate.sourceId] = kind;
      candidates.push(
        read.revision === undefined || candidate.sourceRevision !== undefined
          ? candidate
          : { ...candidate, sourceRevision: read.revision },
      );
    }
  }
  let combined = candidates;
  if (sources.some((source) => searchTasks(request, source.kind, namesFor(source)).length > 1)
    || request.meaning !== undefined) {
    const unique = new Map<string, MemoryCandidate>();
    // Kind lanes differ between source kinds, so a single-lane read can
    // meet the merge without ranks: absent positions count as null.
    const bestRank = (candidate: MemoryCandidate) => (candidate.searchRanks ?? []).reduce<number>(
      (best, rank) => rank === null ? best : Math.min(best, rank), Number.POSITIVE_INFINITY,
    );
    for (const candidate of candidates) {
      const key = JSON.stringify([candidate.sourceId, candidate.id]);
      const existing = unique.get(key);
      if (existing === undefined) {
        unique.set(key, candidate);
        continue;
      }
      const length = Math.max(existing.searchRanks?.length ?? 0, candidate.searchRanks?.length ?? 0);
      const ranks = Array.from({ length }, (_, lane) => {
        const left = existing.searchRanks?.[lane] ?? null;
        const right = candidate.searchRanks?.[lane] ?? null;
        return left === null ? right : right === null ? left : Math.min(left, right);
      });
      const chosen = bestRank(candidate) < bestRank(existing) ? candidate : existing;
      const past = existing.pastLaneCut === true && candidate.pastLaneCut === true ? { pastLaneCut: true as const } : {};
      // A merged candidate still needs at least one lane rank.
      unique.set(key, ranks.some((rank) => rank !== null)
        ? { ...unmarked(chosen), searchRanks: ranks, ...past }
        : { ...unmarked(chosen), searchRanks: undefined, ...past });
    }
    combined = [...unique.values()];
  }
  const readsBySource: Record<string, PickSourceRead> = Object.create(null);
  for (const [index, read] of reads.entries()) {
    if (read.status !== 'read') continue;
    // A source whose role is not 'reference' is never cut, so whole lanes do not apply to it.
    const sourceRead: PickSourceRead = { lanes: laneOrigins(request, sources[index]!.kind, namesFor(sources[index]!)),
      given: [...(['searchLines', 'searchPhrases', 'meaning'] as const).filter((option) =>
        option === 'meaning' ? Boolean(request.meaning) : (request[option] ?? []).some((line) => line.trim() !== '')),
      ...(sources[index]!.names === true ? ['names' as const] : [])],
      wholeLanes: request.wholeLanes === true && sources[index]!.role === 'reference',
      ...(read.alwaysOnSkipped === undefined ? {} : { alwaysOnSkipped: read.alwaysOnSkipped }) };
    readsBySource[sources[index]!.id] = sourceRead;
    for (const candidate of read.candidates) readsBySource[candidate.sourceId] = sourceRead;
  }
  // A caller's findNames answers the pick from the names found above, so it is called once.
  const result = await pick(combined, {
    ...options, taskDate: asOf, timeZone,
    ...(options.findNames === undefined || found === undefined ? {} : { findNames: async () => found.found }),
    rulesEnumerationComplete, sourceKinds, labelKindsBySource, labelBarBySource, rareBySource, barBySource,
    ruleBarBySource, questionsBySource, readsBySource,
  });
  // The read request's lever joins the pick's resolved set.
  // `meaning.wholeLanes` resolves the
  // meaning lanes' own state — the keyword lanes' when unset — so an
  // override that splits the two is recorded as a split.
  const keywordWhole = request.wholeLanes === true;
  const meaningWhole = request.meaning?.wholeLanes ?? keywordWhole;
  // Decay acts inside the read, so its half-life and its effects entry join here.
  const sourceLevers = { ...result.record.levers.sources };
  const effects = [...result.record.effects];
  for (const [index, source] of sources.entries()) {
    if (source.decay === undefined) continue;
    const { halfLife } = source.decay;
    if (sourceLevers[source.id] !== undefined) sourceLevers[source.id] = { ...sourceLevers[source.id]!, decay: { halfLife } };
    const read = reads[index]!;
    const counted = read.status === 'read' ? read.decay : undefined;
    const actedOn = counted?.actedOn ?? 0;
    const added = counted?.added.length ?? 0;
    const dropped = counted?.dropped.length ?? 0;
    const head = `decay on ${source.id} at the half-life ${halfLife}: ranked ${actedOn} dated part${actedOn === 1 ? '' : 's'} lower by age`;
    effects.push({ setting: 'decay', source: source.id, actedOn, added, dropped,
      summary: added === 0 && dropped === 0
        ? `${head}, but the read kept the same parts with and without it. It added no part and kept out no part.`
        : `${head}; ${added} ${added === 1 ? 'was' : 'were'} kept in the read only because decay ranked others lower, and ${
          dropped} ${dropped === 1 ? 'was' : 'were'} left out of the read only because decay ranked it lower by its age.` });
  }
  const levers = { ...result.record.levers, sources: sourceLevers,
    wholeLanes: keywordWhole === meaningWhole ? keywordWhole
      : { keyword: keywordWhole, meaning: meaningWhole } };
  // The names found above, also when every source with name lanes on was absent.
  return { ...result, reads, record: { ...result.record, ...(found === undefined ? {} : { names: found }), levers, effects } };
}
