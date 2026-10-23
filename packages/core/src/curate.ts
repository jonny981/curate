import type { MemoryCandidate, PickRecordEntry, PickResult } from './pick.js';
import { presetName, type CurateLeverStates, type PresetName } from './levers.js';
import { classifyTask, type TaskKind } from './task.js';
import { checkCurateOptions } from './options.js';

export interface CuratePrompt {
  readonly instructions: string;
  readonly body: string;
}

export type CurateWrite = (prompt: CuratePrompt, signal: AbortSignal) => Promise<string>;

/** One write pass over the log, recorded in order. */
export interface CurateBatch {
  /** Reference items shown to the writer in this pass. */
  readonly items: number;
  /** Observation lines this pass added to the log, with their new ids. */
  readonly added: readonly { readonly id: string; readonly line: string }[];
  /** Replacement marks this pass wrote: the new line's id and the
   *  earlier line its "(replaces Ln: ...)" names. A mark tells the
   *  reader the new line is newer; the marked line stays in the log. */
  readonly marks: readonly { readonly id: string; readonly target: string }[];
}

export interface CurateOptions {
  readonly write: CurateWrite;
  /** Add numbered instances, computed gaps, or latest values under the log. */
  readonly working?: boolean;
  /** Keep who, where and which item on the same observation. Off by default. */
  readonly context?: boolean;
  /** Choose working and advice guidance from task words. Explicit options win. */
  readonly routeByTask?: boolean;
  /** Route the curator options from the route answers the pick recorded
   *  (`route: 'jev'` on pick): a 'taste' switches on both preference
   *  lines and a 'count', 'date' or 'latest' switches on worked notes.
   *  Cannot combine with `routeByTask`; needs `record.route` on the
   *  pick's record. Explicit `working`, `preferenceAdvice` and
   *  `preferenceChange` values override the route's choices. Off by
   *  default. */
  readonly route?: 'jev';
  /** Gather stated tastes, experiences and constraints for advice tasks. */
  readonly preferenceAdvice?: boolean;
  /** Gather stated changes of taste and exclusions. */
  readonly preferenceChange?: boolean;
  /** The question’s own date label, retained exactly in the task. */
  readonly taskDate?: string;
  /** Condense once if the log exceeds this positive character budget.
   *  Cannot combine with `batchTokens`: a condensing pass cannot
   *  preserve a chained log's line ids. */
  readonly contextLimit?: number;
  /** Write the log in chained passes of about this many estimated
   *  tokens of evidence each — estimated at four characters per
   *  token — strongest items first (equal weights: newer date first).
   *  Each batch holds as many whole items as fit; an item larger than
   *  the budget sits alone in its own batch and is never cut. Every
   *  observation line carries a stable `Ln` id; a later batch layers
   *  over the existing lines, which are never reworded or dropped —
   *  it only adds lines, and a new line may end with "(replaces Ln:
   *  the subject it corrects)" when it is a newer correction or
   *  decision about the same subject and at least as important. Each
   *  batch's added lines and marks are in `record.batches`. Omit to
   *  write the log in one call. Cannot combine with `contextLimit`. */
  readonly batchTokens?: number;
  readonly signal?: AbortSignal;
}

export interface CurateRecord {
  readonly promptVersion: 'v4';
  readonly weights: 'tiers';
  readonly working: boolean;
  readonly context?: boolean;
  readonly taskKinds?: readonly TaskKind[];
  /** Present when `route: 'jev'` routed the curator options from the
   *  pick's recorded route answers. */
  readonly route?: 'jev';
  /** The whole mode's lever set as applied, carried from the pick's
   *  record: the read, pick and curator states in one place, and
   *  `levers.preset` the mode they match — 'agent-tasks', 'conversation-recall' or
   *  'custom'. `route` holds the lever's two stages apart: `asked`,
   *  whether the pick ran the route questions, and `applied`, whether
   *  `route: 'jev'` ran here. Asked alone already spent the questions,
   *  so a pick that asked and a curator that never applied names no
   *  preset. */
  readonly levers: { readonly preset: PresetName } & CurateLeverStates;
  readonly preferenceAdvice?: boolean;
  readonly preferenceChange?: boolean;
  readonly taskDate?: string;
  /** First checked or recovered log's length; in a chained write,
   *  the layered log's length. */
  readonly logLength: number;
  readonly condensed: boolean;
  readonly condensedLength?: number;
  readonly contextLimit?: number;
  /** The returned log still exceeds the caller's budget. */
  readonly overContextLimit: boolean;
  /** Present when the log is empty: the writer found no evidence that
   *  bore on the task, also when asked once more. */
  readonly empty?: true;
  /** How many writer replies failed the format check and were sent back once with the reason. */
  readonly repairs?: number;
  /** How many empty replies to a whole write were asked once more; a
   *  chained write's later passes are never asked again. */
  readonly emptyRetries?: number;
  /** Lines retained without a format correction or dropped for having no
   *  supplied item id. Text is as written, with short ids mapped by `items`. */
  readonly formatRecovery?: {
    readonly keptAsWritten: readonly string[];
    readonly dropped: readonly string[];
  };
  /** The estimated token budget a chained write cut the evidence into. */
  readonly batchTokens?: number;
  /** Each pass over the log, strongest first: one token-sized batch. */
  readonly batches?: readonly CurateBatch[];
  /** The reference items given to the writer, in selected order, with exact weights; `batches` records what each chained pass was shown. */
  readonly items: readonly {
    /** Full item id; includes the source when ids would clash. The prompt shows the item as `En`, one plus its index here. */
    readonly id: string;
    readonly candidate: MemoryCandidate;
    readonly weight: number;
  }[];
}

export interface CurateResult {
  readonly log: string;
  readonly record: CurateRecord;
}

const WORKING_HEADING = "Working (the curator's; check it against the log):";
const REPAIR = 'A log you wrote for this task was rejected for its format; the rejected log and the reason follow the evidence. Return the same log corrected and nothing else: each observation line starts with exactly one event date in square brackets, [YYYY-MM-DD], and ends with (said YYYY-MM-DD; the item id from its header). For an event known only to a month or a span, put its first date in the brackets and say the span in the text. Change only the format; keep every fact, date and id. If no evidence bears on the task, return an empty reply instead.';
const EMPTY_RETRY = 'Your previous reply to this task held no observation lines. Check the evidence items again and rewrite any evidence that bears on the task as observation lines. If none does, return an empty reply again.';
const NO_WORKING = '- Do not answer the task, do not count, and do not decide whether an observation falls inside a period the task names: give its dates and leave that to the reader.';
const CONTEXT = '\nKeep every fact with the context that gives it meaning: each observation names who, where and which item, activity or event it concerns. Carry these links from the same session, including its other evidence items, into that line instead of leaving them on another line. Resolve pronouns only when that session states the link. Do not invent a person, place, item or connection. Preserve these links when merging or condensing logs.';
const COUNT = '\nThis task needs a count or a list. Write every instance across the supplied sessions as its own line, including small ones and ones mentioned in passing. When two items tell the same instance, write it once with both ids; when you are not sure, write both and end the later observation text with "(may be the same as [the earlier date])".';

// Keep the prototype's v4 + tiers wording, except its fixed character cap.
const FRAME = 'You get the task and evidence items, each with an id and a date.\nRewrite the evidence that could bear on the task as a log of observations, oldest first, one line each:';
const REPLACES = '- When a later observation replaces an earlier one (a new job, a changed plan, an updated number, a new habit), keep both and always end the later line with "(replaces [the earlier date])".';
// A chained write's first pass has no earlier lines at all, so it asks
// for no replacement marker; later passes mark corrections by stable id.
const FIRST_REPLACES = '- When a later observation replaces an earlier one (a new job, a changed plan, an updated number, a new habit), keep both with their own dates and write no replacement marker.';
const INSTRUCTIONS = [
  `You curate memory for a person or an agent about to do a task. ${FRAME}`,
  '[YYYY-MM-DD the event happened] the observation, with its exact names, numbers and amounts (said YYYY-MM-DD; the item id from its header)',
  '- The "said" date is the date in the item header. Work out when the event happened from it: "last Saturday" said on 2023-05-20 happened on 2023-05-13. When the item gives no time for the event, use the said date and write "(when not stated)". Never shift a date that is already absolute.',
  '- One line per distinct event or fact. When two items tell the same event, write it once and give both ids.',
  REPLACES,
  '- Include preferences, habits, opinions, interests and limits the person states, dated.',
  '- Include what the assistant said only when the task asks about it.',
  '- If no evidence bears on the task, return an empty reply: no lines, and no note that nothing was found.',
  NO_WORKING,
  'Each item header shows, in brackets after its date, a weight from 0 to 1: how strongly a decision model judged the item relevant to this task. The weight is graded, not a yes or no, and every item already passed a search for this task. Make sure every observation from items weighted 0.6 or more is in the log. Items weighted from 0.1 to 0.6 are less direct but often hold part of what the task needs, such as one instance of several or an earlier value: include their facts when they bear on the task. Items weighted below 0.1 rarely matter: use one only when it clearly states a fact the task needs.',
].join('\n');

function isDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function logPatterns(ids: readonly string[]) {
  // Longest ids first, so an id that prefixes another never matches
  // part-way through the longer one.
  const sources = [...ids].sort((left, right) => right.length - left.length)
    .map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const date = '\\d{4}-\\d{2}-\\d{2}';
  const separator = '(?:,\\s*(?:and\\s+)?|;\\s*|\\s+(?:and|&)\\s+)';
  const sourceGroup = `(?:${sources})(?:${separator}(?:${sources}))*`;
  // One event told by several items may give each item's said date in
  // one group: "said 2023-05-26 and 2023-05-29; E3, E4".
  const said = `said ${date}(?:(?:,\\s*(?:and\\s+)?|\\s+and\\s+)${date})*`;
  return {
    observation: new RegExp(`^(?<lineId>L\\d+ )?\\[(?<event>${date})\\] (?<text>.+?) \\((?<citations>${said}; ${sourceGroup}(?:;\\s*${said}; ${sourceGroup})*)\\)(?: \\(when not stated\\))?(?: \\(replaces (?:\\[(?<replacesDate>${date})\\]|(?<replacesId>L\\d+)(?::\\s*(?<replacesReason>[^()]+?))?)\\))?\\.?$`, 'd'),
    preference: new RegExp(`(?:\\((?:${sources})(?:${separator}(?:${sources}))*\\)|\\[(?:${sources})(?:${separator}(?:${sources}))*\\])`),
  };
}

function checkLog(raw: unknown, working: boolean, ids: readonly string[], preferenceAdvice: boolean, preferenceChange: boolean, layered = false): string {
  if (typeof raw !== 'string') throw new TypeError('curate: malformed log; write must return text.');
  const log = raw.trim();
  if (!log) {
    // A layered pass may add nothing: an empty reply is no failure.
    if (layered) return log;
    throw new Error('curate: empty log.');
  }

  const lines = log.split('\n').map((line) => line.trim()).filter(Boolean);
  const heading = lines.findIndex((line) => line.replace(/^#{1,6}\s+/, '') === WORKING_HEADING);
  if (heading !== -1 && (!working || (!layered && heading === 0) || heading === lines.length - 1)) {
    throw new Error('curate: malformed log; unexpected or empty working section.');
  }
  const { observation, preference } = logPatterns(ids);
  // A citation on a preference or working line is an `En` inside a
  // bracket group, and every one must be a given item's id: one the
  // map does not hold would be returned unresolved. A bare `En`, such
  // as the E14 in an address, is ordinary text, not a citation.
  const known = new Set(ids);
  const unknownId = (text: string) =>
    [...text.matchAll(/\([^()]*\)|\[[^\[\]]*\]/g)].some(([group]) =>
      [...group.matchAll(/\bE\d+\b/g)].some(([id]) => !known.has(id)));
  let observations = 0;
  for (const [index, line] of lines.entries()) {
    if (line.startsWith('Advice preferences:') || line.startsWith('Changed preference:')) {
      if ((line.startsWith('Advice preferences:') && !preferenceAdvice)
        || (line.startsWith('Changed preference:') && !preferenceChange)) {
        throw new Error('curate: malformed log; unexpected preference line.');
      }
      const text = line.slice(line.indexOf(':') + 1).trim();
      if (!preference.test(text) || !text.replace(preference, '').replace(/[.!]/g, '').trim()
        || unknownId(text)) {
        throw new Error('curate: malformed log; preference lines need text and source item ids in parentheses or brackets.');
      }
      continue;
    }
    if (heading !== -1 && index >= heading) {
      if (unknownId(line)) {
        throw new Error('curate: malformed log; a working note cites an unknown item id.');
      }
      continue;
    }
    observations += 1;
    const match = observation.exec(line)?.groups;
    const saidDates = match?.citations?.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
    if (!match || !isDate(match.event!) || !match.text!.trim()
      || saidDates.some((value) => !isDate(value))
      || (match.replacesDate !== undefined && !isDate(match.replacesDate))) {
      throw new Error(`curate: malformed log; each observation needs an event date, a said date, and an item id; line: ${line}`);
    }
  }
  if (!observations && !layered) throw new Error('curate: malformed log; at least one dated observation is required.');
  return log;
}

/** Swap the short `En` ids a checked log cites for the items' full
 *  ids, so the returned log and record read as they did when the
 *  writer cited full ids. On an observation line only the citation
 *  group is rewritten, spliced by index so `$`-sequences in the text
 *  stay literal. On a preference line every `En` inside a bracket
 *  group is rewritten, whatever else the group holds; one outside
 *  the brackets stays. Below the working heading every known `En`
 *  inside a bracket group is rewritten; a bare one stays. An `En`
 *  left anywhere else, such as one written as ordinary text,
 *  stays. A malformed line retained as written also restores any known
 *  standalone `En` token, even when its citation brackets are broken. */
function restoreIds(log: string, ids: ReadonlyMap<string, string>, keptAsWritten: ReadonlySet<string>): string {
  const swap = (text: string) => text.replace(/\bE\d+\b/g, (id) => ids.get(id) ?? id);
  const { observation } = logPatterns([...ids.keys()]);
  const brackets = /\([^()]*\)|\[[^\[\]]*\]/g;
  let inWorking = false;
  return log.split('\n').map((line) => {
    const trimmed = line.trim();
    const span = observation.exec(trimmed)?.indices?.groups?.citations;
    if (span !== undefined) {
      const fixed = trimmed.slice(0, span[0]) + swap(trimmed.slice(span[0], span[1])) + trimmed.slice(span[1]);
      const at = line.indexOf(trimmed);
      return line.slice(0, at) + fixed + line.slice(at + trimmed.length);
    }
    if (keptAsWritten.has(trimmed.replace(/^L\d+ /, ''))) return swap(line);
    if (trimmed.startsWith('Advice preferences:') || trimmed.startsWith('Changed preference:')) {
      return line.replace(brackets, swap);
    }
    if (trimmed.replace(/^#{1,6}\s+/, '') === WORKING_HEADING) inWorking = true;
    return inWorking ? line.replace(brackets, swap) : line;
  }).join('\n');
}

// A later batch's pass gets the same base rules as the first — event
// dates, (when not stated), preferences, assistant mentions, working
// and counting — with only the framing and the replacement rule
// swapped for the layered form: the log so far is shown for reference
// and the pass returns only the lines it adds; a new line may mark an
// earlier one it corrects.
const LAYER_FRAME = 'A dated log has already been written from the strongest evidence; you are layering the next batch of evidence into it for the same task. You get the task, the current log and this batch\'s evidence items, each with an id, a date, a weight and any recorded tags.\nThe current log is shown for reference only; every line of it starts with its own id, like L3, and stays exactly as it stands without you repeating it. Return only new observation lines for the facts the log does not already state, oldest first, in the same dated format with no id of your own:';
const LAYER_REPLACES = '- A line you add may end with "(replaces L3: the subject it corrects)" only when it is a newer correction or decision about the same subject as that earlier line and at least as important — each item header shows the date, weight and tags to judge that by. The mark only tells the reader your line is newer; the earlier line stays in the log either way. Ideas, questions and asides only add lines; they never mark one. When it is unclear whether an item corrects the same subject, write no mark and let both lines stand.';
const layerInstructions = (base: string) => [
  base.replace(FRAME, LAYER_FRAME).replace(REPLACES, LAYER_REPLACES),
  'Return any working section and any preference lines in full, kept or updated, after the new observation lines. If this batch adds nothing, return no observation lines. Do not repeat the log\'s observation lines.',
].join('\n');

interface ParsedLine {
  readonly line: string;
  /** The event date in the line's square brackets. */
  readonly event?: string;
  /** The line's own stable id (`L7`); set once when the line is written. */
  readonly lineId?: string;
  /** The line id a "(replaces L7)" marker names, when present. */
  readonly replacesId?: string;
}

function parseObservations(log: string, patterns: ReturnType<typeof logPatterns>, keptAsWritten: ReadonlySet<string>): ParsedLine[] {
  const lines = log.split('\n').map((line) => line.trim()).filter(Boolean);
  const parsed: ParsedLine[] = [];
  for (const line of lines) {
    const match = patterns.observation.exec(line)?.groups;
    const kept = keptAsWritten.has(line.replace(/^L\d+ /, ''));
    if (!match && !kept) continue;
    const lineId = /^(L\d+) /.exec(line)?.[1];
    parsed.push({ line,
      ...(match?.event === undefined ? {} : { event: match.event }),
      ...(lineId === undefined ? {} : { lineId }),
      ...(kept || match?.replacesId === undefined ? {} : { replacesId: match.replacesId }) });
  }
  return parsed;
}

/** Give every observation line a stable id. A line keeps the `Ln` id it
 *  already carries only when that id belongs to the previous log and
 *  appears once; any other prefix, including one the writer invented or
 *  reused, is renumbered so line ids are never ambiguous. Numbering is
 *  monotonic across passes: a fresh id is never an earlier line's id. */
function numberLines(
  log: string,
  patterns: ReturnType<typeof logPatterns>,
  valid: ReadonlySet<string>,
  start: number,
  keptAsWritten: ReadonlySet<string>,
): { readonly log: string; readonly next: number } {
  let next = start;
  const seen = new Set<string>();
  const parsed = new Map(parseObservations(log, patterns, keptAsWritten).map((line) => [line.line, line]));
  const out = log.split('\n').map((line) => {
    const match = parsed.get(line.trim());
    if (!match) return line;
    const body = line.trim().replace(/^L\d+ /, '');
    const claimed = match.lineId;
    const id = claimed !== undefined && valid.has(claimed) && !seen.has(claimed)
      ? claimed : `L${next++}`;
    seen.add(id);
    return `${id} ${body}`;
  });
  return { log: out.join('\n'), next };
}

/** Drop a "(replaces ...)" tail from checked observations: a first
 *  pass has no earlier lines to replace. Kept malformed text stays. */
function stripReplaces(log: string, observation: RegExp, keptAsWritten: ReadonlySet<string>): string {
  return log.split('\n').map((line) => {
    const trimmed = line.trim();
    if (keptAsWritten.has(trimmed.replace(/^L\d+ /, '')) || !observation.test(trimmed)) return line;
    return trimmed.replace(/ \(replaces (?:\[\d{4}-\d{2}-\d{2}\]|L\d+(?::\s*[^()]+)?)\)(?=\.?$)/, '');
  }).join('\n');
}

/** Merge a batch pass's reply with the log it layered. The pass is
 *  asked for only its additions. Every earlier line keeps its order
 *  and id; each new observation goes in front of the first earlier
 *  line with a later event date, so the log still reads oldest first,
 *  and on the same date the earlier line comes first. The reply's
 *  other lines — preference lines, working notes — follow the
 *  observations. Lines are matched by their own ids: a reply that
 *  repeats an earlier line, reworded or not, loses that copy and the
 *  original stands. A line this pass added keeps a "(replaces Ln:
 *  ...)" mark only when it names an earlier line's own id — the mark
 *  tells the reader the new line is newer, and code never removes the
 *  line it names. A mark naming an id the log does not hold, and any
 *  "(replaces [date])" tail, is stripped from the added line. */
function reconcile(
  prev: string,
  next: string,
  patterns: ReturnType<typeof logPatterns>,
  keptAsWritten: ReadonlySet<string>,
): { log: string } & Pick<CurateBatch, 'added' | 'marks'> {
  const before = parseObservations(prev, patterns, keptAsWritten);
  const after = parseObservations(next, patterns, keptAsWritten);
  const beforeById = new Map(before.map((line) => [line.lineId!, line]));
  const fresh = after.filter((line) => !beforeById.has(line.lineId!));
  // A mark on a new line is honoured only when it names an earlier
  // line: a mark naming an id the log does not hold, and any
  // "(replaces [date])" tail, is stripped from the line it was written
  // on and never recorded.
  const stripped = new Map<string, string>();
  for (const line of fresh) {
    if (keptAsWritten.has(line.line.replace(/^L\d+ /, ''))) continue;
    if (line.replacesId !== undefined && beforeById.has(line.replacesId)) continue;
    const cleaned = line.line.replace(/ \(replaces (?:\[\d{4}-\d{2}-\d{2}\]|L\d+(?::\s*[^()]+)?)\)(?=\.?$)/, '');
    if (cleaned !== line.line) stripped.set(line.lineId!, cleaned);
  }
  const added = fresh.map((line) => ({ id: line.lineId!, line: stripped.get(line.lineId!) ?? line.line }));
  const marks = fresh.filter((line) => line.replacesId !== undefined && beforeById.has(line.replacesId))
    .map((line) => ({ id: line.lineId!, target: line.replacesId! }));
  // A reply line carrying an earlier line's id is that line repeated;
  // drop it — the original is already going back in its own place.
  // slots[i] holds the new lines that go in front of earlier line i;
  // the last slot holds those dated after every earlier line.
  const slots = Array.from({ length: before.length + 1 }, (): string[] => []);
  const rest: string[] = [];
  const afterByLine = new Map(after.map((line) => [line.line, line]));
  for (const line of next.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    const match = afterByLine.get(text);
    const id = match?.lineId;
    if (id !== undefined && beforeById.has(id)) continue;
    if (match === undefined) {
      rest.push(text);
      continue;
    }
    const later = match.event === undefined ? -1
      : before.findIndex((earlier) => earlier.event !== undefined && earlier.event > match.event!);
    slots[later === -1 ? before.length : later]!.push(stripped.get(id!) ?? text);
  }
  const observations = before.flatMap((line, index) => [...slots[index]!, line.line]);
  return { log: [...observations, ...slots[before.length]!, ...rest].join('\n'), added, marks };
}

/** Write the reference log. Selected rules remain the caller's instructions. */
export async function curate(
  task: string,
  picked: PickResult,
  options: CurateOptions,
): Promise<CurateResult> {
  checkCurateOptions(options);
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const contextLimit = options.contextLimit;
  if (contextLimit !== undefined && (!Number.isInteger(contextLimit) || contextLimit <= 0)) {
    throw new TypeError('curate: contextLimit must be a positive integer of characters.');
  }
  const batchTokens = options.batchTokens;
  if (batchTokens !== undefined && (!Number.isInteger(batchTokens) || batchTokens <= 0)) {
    throw new TypeError('curate: batchTokens must be a positive integer of estimated tokens.');
  }
  if (options.route !== undefined && options.route !== 'jev') {
    throw new TypeError("curate: route must be 'jev'.");
  }
  if (options.route === 'jev' && options.routeByTask) {
    throw new TypeError("curate: route: 'jev' and routeByTask cannot both be on.");
  }
  const routed = options.route === 'jev' ? picked.record.route : undefined;
  if (options.route === 'jev' && routed === undefined) {
    throw new TypeError("curate: route: 'jev' needs the route answers a pick records when it runs with route: 'jev'.");
  }
  const taskKinds = options.routeByTask ? classifyTask(task) : undefined;
  const working = options.working
    ?? (routed?.on.includes('working') ?? (taskKinds?.some((kind) => kind === 'count' || kind === 'date') ?? false));
  const context = options.context ?? false;
  const preferenceAdvice = options.preferenceAdvice
    ?? (routed?.on.includes('preferenceAdvice') ?? (taskKinds?.includes('advice') ?? false));
  const preferenceChange = options.preferenceChange ?? (routed?.on.includes('preferenceChange') ?? false);
  const taskDate = options.taskDate;
  if (taskDate !== undefined && !taskDate.trim()) {
    throw new TypeError('curate: taskDate must be a nonempty date label.');
  }
  const datedTask = taskDate === undefined ? task : `${task} (asked ${taskDate})`;
  const preferences = (preferenceAdvice
    ? '\nIf the task asks for advice, suggestions or recommendations (including whether something is a good idea): end the log with one or two short lines starting "Advice preferences:" naming the user\'s stated tastes, relevant experiences and constraints, with source ids. Tell the reader these apply to related requests even when this exact activity was never discussed. Do not invent preferences or confirmed event dates; absent schedules do not prevent suggesting suitable event types and ways to find them. Otherwise add no advice line.'
    : '') + (preferenceChange
    ? '\nAdd one or two short lines starting "Changed preference:" only when the user states a change of taste or an exclusion relevant to the task. Name what they moved away from, what the user wants instead and any stated exclusions, with source ids. Tell the reader: Do not suggest the old taste for this request to move beyond it. Do not infer a permanent dislike or a change from an assistant suggestion. If no such change or exclusion is stated, add no change line.'
    : '') + (preferenceAdvice || preferenceChange
    ? '\nKeep each added kind to one or two short lines. When merging or shortening, combine repeated preference lines and put them at the end.'
    : '');
  const references = picked.selected.filter((candidate) => candidate.role === 'reference');
  const entries = new Map<string, PickRecordEntry>();
  const items = references.map((candidate) => {
    const entry = picked.record.candidates.find((item) =>
      item.sourceId === candidate.sourceId && item.id === candidate.id);
    if (entry?.status !== 'selected' || entry.probability === undefined
      || !Number.isFinite(entry.probability) || entry.probability < 0 || entry.probability > 1) {
      throw new TypeError('curate: each reference needs a selected record entry with a weight between 0 and 1.');
    }
    const id = references.some((other) => other !== candidate && other.id === candidate.id)
      ? JSON.stringify([candidate.sourceId, candidate.id]) : candidate.id;
    entries.set(id, entry);
    return { id, candidate, weight: entry.probability };
  });
  if (!items.length) throw new Error('curate: no selected reference items to curate.');

  const tagText = (id: string) => {
    const tags = entries.get(id)?.tags;
    if (tags === undefined) return '';
    return Object.entries(tags)
      .map(([key, tag]) => tag.value === undefined ? '' : `, ${key}: ${tag.value}`)
      .join('');
  };
  const blocks = items.map(({ id, candidate, weight }, index) => {
    const kind = entries.get(id)?.sourceKind;
    return `### E${index + 1} (${candidate.date ? `${candidate.date.value}, ` : ''}${kind === undefined ? '' : `${kind}, `}${weight}${tagText(id)}): ${candidate.title}\n\n${candidate.text}`.trim();
  });
  const instructionsWorking = !working ? INSTRUCTIONS : INSTRUCTIONS.replace(NO_WORKING,
    '- In the log itself, do not judge: give every observation its dates, including ones near the edge of a period the task names.')
    + '\nAfter the log, add a short section headed "Working (the curator\'s; check it against the log):". For a count or a list: number each distinct instance that falls inside the period the task names, with its date and the item ids in brackets, then name any instance you left out and why (outside the period, or the same as another). For a question about time or order: the dates involved and the computed difference or order. For something that changed: the latest value and its date. Leave out any part the task does not need.';
  const instructions = instructionsWorking + (taskKinds?.includes('count') ? COUNT : '');
  const additions = preferences + (context ? CONTEXT : '');
  // Each item's header shows a short `En` id in selected order, fixed
  // for the curation so a rerun sees the same ids. The writer cites
  // them, the format check knows only them, and `fullIds` swaps the
  // cited ids back for the returned log and record.
  const shortIds = items.map((_, index) => `E${index + 1}`);
  const fullIds = new Map(shortIds.map((short, index) => [short, items[index]!.id]));
  // `batchTokens` chains the write: the evidence goes to the writer in
  // decision-score order, strongest first and equal weights newest
  // first, cut into consecutive batches that each hold as many whole
  // items as the token estimate allows. An item costing more than the
  // whole budget sits alone in its own batch and is never cut. The
  // estimate is characters divided by four, as the option's doc says.
  let batches: number[][] | undefined;
  if (batchTokens !== undefined) {
    if (contextLimit !== undefined) {
      throw new TypeError('curate: a chained write (batchTokens) and contextLimit do not combine; a condensing pass cannot preserve a chained log\'s line ids.');
    }
    const cost = (index: number) => Math.ceil(blocks[index]!.length / 4);
    const ordered = items.map((_, index) => index)
      .sort((left, right) => items[right]!.weight - items[left]!.weight
        || (items[right]!.candidate.date?.value ?? '').localeCompare(items[left]!.candidate.date?.value ?? '')
        || left - right);
    batches = [[]];
    let size = 0;
    for (const index of ordered) {
      const needed = cost(index);
      if (batches.at(-1)!.length > 0 && size + needed > batchTokens) {
        batches.push([]);
        size = 0;
      }
      batches.at(-1)!.push(index);
      size += needed;
    }
  }
  // Keep the original reply if its format repair also fails, so a repair
  // cannot lose usable evidence. Only lines without a supplied id drop.
  let repairs = 0;
  let emptyRetries = 0;
  let formatFailure: Error | undefined;
  let recovered = false;
  const keptAsWritten = new Set<string>();
  const dropped = new Set<string>();
  const keptLines = new Set<string>();
  const hasItemId = (text: string, available: readonly string[]) =>
    (text.match(/\bE\d+\b/g) ?? []).some((id) => available.includes(id));
  const recover = (raw: unknown, available: readonly string[]): string => {
    recovered = true;
    if (typeof raw !== 'string') return '';
    const lines = raw.trim().split('\n').filter((line) => line.trim());
    const kept: string[] = [];
    let inWorking = false;
    for (const [index, line] of lines.entries()) {
      const text = line.trim();
      if (working && text.replace(/^#{1,6}\s+/, '') === WORKING_HEADING && index < lines.length - 1) {
        inWorking = true;
        kept.push(line);
        continue;
      }
      try {
        // A working note is checked in its section; other lines can be
        // checked alone as additions, without requiring an observation.
        checkLog(inWorking ? `${WORKING_HEADING}\n${line}` : line,
          working, available, preferenceAdvice, preferenceChange, true);
      } catch {
        if (!hasItemId(text, available)) {
          dropped.add(line);
          continue;
        }
        keptAsWritten.add(line);
        keptLines.add(text.replace(/^L\d+ /, ''));
      }
      kept.push(line);
    }
    if (!kept.some((line) => hasItemId(line, available))) {
      for (const line of kept) dropped.add(line);
      return '';
    }
    if (kept.at(-1)?.trim().replace(/^#{1,6}\s+/, '') === WORKING_HEADING) dropped.add(kept.pop()!);
    return kept.join('\n');
  };
  const check = (raw: unknown, layered: boolean) => typeof raw === 'string' && !raw.trim()
    ? '' : checkLog(raw, working, shortIds, preferenceAdvice, preferenceChange, layered);
  const writeChecked = async (prompt: CuratePrompt, layered = false, available = shortIds): Promise<string> => {
    const raw = await options.write(prompt, signal);
    signal.throwIfAborted();
    try {
      const checked = check(raw, layered);
      if (checked || layered) return checked;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('curate: malformed log')) throw error;
      repairs += 1;
      const reason = error.message.replace(/^curate: malformed log; /, '');
      const fixed = await options.write({
        instructions: `${prompt.instructions}\n${REPAIR}`,
        body: `${prompt.body}\n\nREJECTED LOG (${reason}):\n${String(raw)}`,
      }, signal);
      signal.throwIfAborted();
      try {
        const checked = check(fixed, layered);
        // An empty correction must not erase a reply that cited evidence.
        return checked || (typeof raw === 'string' && hasItemId(raw, available) ? recover(raw, available) : '');
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('curate: malformed log')) throw error;
        const usable = recover(raw, available) || recover(fixed, available);
        if (!usable) formatFailure = error;
        return usable;
      }
    }
    // A whole write that came back empty is asked once more. An empty
    // reply stays a valid answer, so a second reply with nothing usable
    // leaves the log empty, and a malformed one gets no repair call.
    emptyRetries += 1;
    const again = await options.write({ instructions: `${prompt.instructions}\n${EMPTY_RETRY}`, body: prompt.body }, signal);
    signal.throwIfAborted();
    try {
      return check(again, false);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('curate: malformed log')) throw error;
      return recover(again, available);
    }
  };
  let recordBatches: CurateBatch[] | undefined;
  let log: string;
  if (batches === undefined) {
    log = await writeChecked({
      instructions: instructions + additions,
      body: `TASK:\n${datedTask}\n\nEVIDENCE:\n\n${blocks.join('\n\n')}`,
    });
  } else {
    // Chained write: the strongest batch writes the log alone; each
    // later batch returns only the lines it adds over the existing
    // `Ln` line ids. Every observation line carries a stable id from
    // the pass that wrote it, and reconcile matches lines by id alone.
    recordBatches = [];
    const patterns = logPatterns(shortIds);
    log = '';
    let nextLineId = 1;
    const available: string[] = [];
    for (const indexes of batches) {
      available.push(...indexes.map((index) => shortIds[index]!));
      if (recordBatches.length === 0) {
        const checkedFirst = await writeChecked({
          instructions: `${instructions.replace(REPLACES, FIRST_REPLACES)}${additions}`,
          body: `TASK:\n${datedTask}\n\nEVIDENCE:\n\n${indexes.map((index) => blocks[index]).join('\n\n')}`,
        }, false, available);
        // The first pass was asked for no replacement markers; a writer
        // that left one anyway keeps the line's text and loses the
        // marker.
        const unmarked = stripReplaces(checkedFirst, patterns.observation, keptLines);
        const numbered = numberLines(unmarked, patterns, new Set(), nextLineId, keptLines);
        log = numbered.log;
        nextLineId = numbered.next;
        const written = parseObservations(log, patterns, keptLines);
        recordBatches.push({ items: indexes.length,
          added: written.map((line) => ({ id: line.lineId!, line: restoreIds(line.line, fullIds, keptLines) })),
          marks: [] });
      } else {
        const checked = await writeChecked({
          instructions: layerInstructions(instructions) + additions,
          body: `TASK:\n${datedTask}\n\nLOG SO FAR:\n${log}\n\nEVIDENCE:\n\n${indexes.map((index) => blocks[index]).join('\n\n')}`,
        }, true, available);
        // The pass returns only its additions; an empty reply means the
        // batch held nothing new and the log stands as it is.
        if (checked === '') {
          recordBatches.push({ items: indexes.length, added: [], marks: [] });
          continue;
        }
        const live = new Set(parseObservations(log, patterns, keptLines).map((line) => line.lineId!));
        const numbered = numberLines(checked, patterns, live, nextLineId, keptLines);
        nextLineId = numbered.next;
        const merged = reconcile(log, numbered.log, patterns, keptLines);
        log = merged.log;
        recordBatches.push({ items: indexes.length, marks: merged.marks,
          added: merged.added.map((line) => ({ ...line, line: restoreIds(line.line, fullIds, keptLines) })) });
      }
    }
  }
  if (!log && formatFailure) throw formatFailure;
  const restoredLog = restoreIds(log, fullIds, keptLines);
  const logLength = restoredLog.length;
  const condensed = contextLimit !== undefined && logLength > contextLimit;
  if (condensed) {
    // The condense writer sees and writes the short-id log, so its
    // stated budget estimates the caller's character budget in that
    // form: the limit scaled by the whole log's length ratio between
    // the two id forms. The reply's own mix of ids and text can
    // differ, so a reply inside the stated budget can still restore
    // over `contextLimit`; `overContextLimit` records that.
    const budget = Math.max(1, Math.floor(contextLimit * log.length / logLength));
    const rawCondensed = await options.write({
      instructions: [
        instructions,
        `Condense the log for the task to at most ${budget} characters, including any working section, if possible.`,
        'Reduce the tiers in this order:',
        'First: merge or drop observations from items weighted below 0.1.',
        'Next: merge or drop observations from items weighted from 0.1 to below 0.6.',
        'Keep observations from items weighted 0.6 or more whole; do not shorten or drop them, even if the log must exceed the budget.',
        'Keep each retained observation\'s event date, said date, source item ids, and replacement dates. Merge only observations with matching dates and keep all their source ids.',
        'Never truncate text. Return only the dated log and, when requested, working notes checked against the retained observations.',
      ].join('\n') + additions,
      body: `TASK:\n${datedTask}\n\nITEM WEIGHTS:\n${items.map((item, index) => `E${index + 1}: ${item.weight}`).join('\n')}\n\nLOG:\n${log}`,
    }, signal);
    signal.throwIfAborted();
    try {
      log = restoreIds(checkLog(rawCondensed, working, shortIds, preferenceAdvice, preferenceChange), fullIds, keptLines);
    } catch (error) {
      if (!(error instanceof Error) || !/^curate: (?:malformed|empty) log/.test(error.message)) throw error;
      log = restoreIds(recover(rawCondensed, shortIds), fullIds, keptLines) || restoredLog;
    }
  } else {
    log = restoredLog;
  }
  // The pick's record keeps `route` as the questions asked; the curate
  // record keeps both stages apart — the pick's asked beside this
  // curator's applied — and the preset names the mode they make: asked
  // alone already spent the route questions, so it names no preset.
  const levers: CurateLeverStates = { ...picked.record.levers, route: {
    asked: picked.record.levers?.route === true, applied: options.route === 'jev' } };
  return {
    log,
    record: {
      promptVersion: 'v4', weights: 'tiers', working, preferenceAdvice, preferenceChange,
      ...(options.context === undefined ? {} : { context }),
      ...(taskKinds === undefined ? {} : { taskKinds }),
      ...(options.route === undefined ? {} : { route: options.route }),
      levers: { ...levers,
        preset: presetName({ ...levers, route: levers.route.asked || levers.route.applied },
          picked.record.levers?.preset !== 'custom') },
      ...(taskDate === undefined ? {} : { taskDate }), items, logLength, condensed,
      ...(batchTokens === undefined ? {} : { batchTokens }),
      ...(recordBatches === undefined ? {} : { batches: recordBatches }),
      ...(condensed ? { condensedLength: log.length } : {}),
      ...(contextLimit === undefined ? {} : { contextLimit }),
      overContextLimit: contextLimit !== undefined && log.length > contextLimit,
      ...(log === '' ? { empty: true as const } : {}),
      ...(repairs ? { repairs } : {}),
      ...(emptyRetries ? { emptyRetries } : {}),
      ...(recovered ? { formatRecovery: { keptAsWritten: [...keptAsWritten], dropped: [...dropped] } } : {}),
    },
  };
}
