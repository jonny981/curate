import type { MemoryCandidate, PickRecordEntry, PickResult } from './pick.js';
import { classifyTask, type TaskKind } from './task.js';

export interface CuratePrompt {
  readonly instructions: string;
  readonly body: string;
}

export type CurateWrite = (prompt: CuratePrompt, signal: AbortSignal) => Promise<string>;

export type CurateBandDetail = 'whole' | 'light' | 'compressed' | 'heavy';

/** One score band in a chained write: a reference at or above `above`
 *  belongs to this band unless a band above already claimed it. */
export interface CurateBand {
  readonly above: number;
  /** How fully this band's facts are written into the log. */
  readonly detail: CurateBandDetail;
}

/** One write pass over the log, recorded in order. */
export interface CurateLayer {
  /** Index into the recorded `bands` array; the band this pass
   *  layered. A band spans several layers when `batchSize` cut its
   *  items into separate passes. */
  readonly band: number;
  readonly above: number;
  readonly detail: CurateBandDetail;
  /** Reference items shown to the writer in this pass. */
  readonly items: number;
  /** Observation lines this pass added to the log, with their new ids. */
  readonly added: readonly { readonly id: string; readonly line: string }[];
  /** Earlier lines this pass replaced under the displacement rule:
   *  the replaced line's id, the displacing line's id, and the rule. */
  readonly displaced: readonly {
    readonly id: string;
    readonly line: string;
    readonly byId: string;
    readonly byLine: string;
    readonly reason: string;
  }[];
  /** Drops, rewordings and named displacements the rules refused. Every
   *  refused line is back in the log; `byId` and `byLine` name the
   *  claiming or reworded line when there was one. */
  readonly refused: readonly {
    readonly id: string;
    readonly line: string;
    readonly byId?: string;
    readonly byLine?: string;
    readonly reason: string;
  }[];
}

export interface CurateOptions {
  readonly write: CurateWrite;
  /** Add numbered instances, computed gaps, or latest values under the log. */
  readonly working?: boolean;
  /** Keep who, where and which item on the same observation. Off by default. */
  readonly context?: boolean;
  /** Choose working and advice guidance from task words. Explicit options win. */
  readonly routeByTask?: boolean;
  /** Gather stated tastes, experiences and constraints for advice tasks. */
  readonly preferenceAdvice?: boolean;
  /** Gather stated changes of taste and exclusions. */
  readonly preferenceChange?: boolean;
  /** The question’s own date label, retained exactly in the task. */
  readonly taskDate?: string;
  /** Condense once if the log exceeds this positive character budget.
   *  Cannot combine with `bands` or `batchSize`: a condensing pass
   *  cannot preserve a chained log's line ids and displacement
   *  protections. */
  readonly contextLimit?: number;
  /** Write the log in chained passes by decision-score band, strongest
   *  first: each band's references go to the writer over the log the
   *  bands above produced, at that band's compression detail. Every
   *  observation line carries a stable `Ln` id; a later band may
   *  displace an existing line only by naming that id under the
   *  recorded displacement rule, and every add, displacement and
   *  refused change is in `record.layers`. Omit to write the log in
   *  one call. Floors in any order; a starting shape is 0.5 whole,
   *  0.3 light, 0.1 compressed, 0 heavy. A weight below every floor
   *  joins the lowest band. Cannot combine with `contextLimit`. */
  readonly bands?: readonly CurateBand[];
  /** The most reference items one writer call receives in a chained
   *  write. Each band's items go to the writer in weight order,
   *  strongest first, cut into batches of this size; every batch is
   *  its own pass over the log under the same line-id and
   *  displacement rules. On its own, without `bands`, it chains a
   *  single `whole` band. Omit to hand each band's whole lane to the
   *  writer in one call. Cannot combine with `contextLimit`. */
  readonly batchSize?: number;
  readonly signal?: AbortSignal;
}

export interface CurateRecord {
  readonly promptVersion: 'v4';
  readonly weights: 'tiers';
  readonly working: boolean;
  readonly context?: boolean;
  readonly taskKinds?: readonly TaskKind[];
  readonly preferenceAdvice?: boolean;
  readonly preferenceChange?: boolean;
  readonly taskDate?: string;
  /** First validated log's length, after trimming; in a chained write,
   *  the layered log's length. */
  readonly logLength: number;
  readonly condensed: boolean;
  readonly condensedLength?: number;
  readonly contextLimit?: number;
  /** The returned log still exceeds the caller's budget. */
  readonly overContextLimit: boolean;
  /** The band spec a chained write used, in the order it ran. */
  readonly bands?: readonly CurateBand[];
  /** The batch size a chained write cut each band's items to. */
  readonly batchSize?: number;
  /** Each pass over the log, strongest first: a band's whole lane, or
   *  one batch of it when `batchSize` cut it. */
  readonly layers?: readonly CurateLayer[];
  /** The reference items given to the writer, in selected order, with exact weights; `layers` records what each chained pass was shown. */
  readonly items: readonly {
    /** Full item id in the prompt; includes the source when ids would clash. */
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
const NO_WORKING = '- Do not answer the task, do not count, and do not decide whether an observation falls inside a period the task names: give its dates and leave that to the reader.';
const CONTEXT = '\nKeep every fact with the context that gives it meaning: each observation names who, where and which item, activity or event it concerns. Carry these links from the same session, including its other evidence items, into that line instead of leaving them on another line. Resolve pronouns only when that session states the link. Do not invent a person, place, item or connection. Preserve these links when merging or condensing logs.';
const COUNT = '\nThis task needs a count or a list. Write every instance across the supplied sessions as its own line, including small ones and ones mentioned in passing. When two items tell the same instance, write it once with both ids; when you are not sure, write both and end the later observation text with "(may be the same as [the earlier date])".';

// Keep the prototype's v4 + tiers wording, except its fixed character cap.
const FRAME = 'You get the task and evidence items, each with an id and a date.\nRewrite the evidence that could bear on the task as a log of observations, oldest first, one line each:';
const REPLACES = '- When a later observation replaces an earlier one (a new job, a changed plan, an updated number, a new habit), keep both and always end the later line with "(replaces [the earlier date])".';
// A chained write replaces lines by their stable ids, never by date,
// and its first pass has no earlier lines at all: that pass asks for
// neither kind of marker.
const FIRST_REPLACES = '- When a later observation replaces an earlier one (a new job, a changed plan, an updated number, a new habit), keep both with their own dates and write no replacement marker.';
const INSTRUCTIONS = [
  `You curate memory for a person or an agent about to do a task. ${FRAME}`,
  '[YYYY-MM-DD the event happened] the observation, with its exact names, numbers and amounts (said YYYY-MM-DD; the full item id from its header)',
  '- The "said" date is the date in the item header. Work out when the event happened from it: "last Saturday" said on 2023-05-20 happened on 2023-05-13. When the item gives no time for the event, use the said date and write "(when not stated)". Never shift a date that is already absolute.',
  '- One line per distinct event or fact. When two items tell the same event, write it once and give both ids.',
  REPLACES,
  '- Include preferences, habits, opinions, interests and limits the person states, dated.',
  '- Include what the assistant said only when the task asks about it.',
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
  return {
    observation: new RegExp(`^(?<lineId>L\\d+ )?\\[(?<event>${date})\\] (?<text>.+?) \\((?<citations>said ${date}; ${sourceGroup}(?:;\\s*said ${date}; ${sourceGroup})*)\\)(?: \\(when not stated\\))?(?: \\(replaces (?:\\[(?<replacesDate>${date})\\]|(?<replacesId>L\\d+)(?::\\s*(?<replacesReason>[^()]+?))?)\\))?$`),
    preference: new RegExp(`(?:\\((?:${sources})(?:${separator}(?:${sources}))*\\)|\\[(?:${sources})(?:${separator}(?:${sources}))*\\])`),
    saidGroup: new RegExp(`;\\s*said ${date}; `),
    saidHead: new RegExp(`^said ${date}; `),
    /** One complete known item id; a source-qualified ["s","id"] id
     *  contains the separator characters, so ids come out whole. */
    cited: new RegExp(sources, 'g'),
  };
}

function checkLog(raw: unknown, working: boolean, ids: readonly string[], preferenceAdvice: boolean, preferenceChange: boolean): string {
  if (typeof raw !== 'string') throw new TypeError('curate: malformed log; write must return text.');
  const log = raw.trim();
  if (!log) throw new Error('curate: empty log.');

  const lines = log.split('\n').map((line) => line.trim()).filter(Boolean);
  const heading = lines.findIndex((line) => line.replace(/^#{1,6}\s+/, '') === WORKING_HEADING);
  if (heading !== -1 && (!working || heading === 0 || heading === lines.length - 1)) {
    throw new Error('curate: malformed log; unexpected or empty working section.');
  }
  const { observation, preference } = logPatterns(ids);
  let observations = 0;
  for (const [index, line] of lines.entries()) {
    if (line.startsWith('Advice preferences:') || line.startsWith('Changed preference:')) {
      if ((line.startsWith('Advice preferences:') && !preferenceAdvice)
        || (line.startsWith('Changed preference:') && !preferenceChange)) {
        throw new Error('curate: malformed log; unexpected preference line.');
      }
      const text = line.slice(line.indexOf(':') + 1).trim();
      if (!preference.test(text) || !text.replace(preference, '').replace(/[.!]/g, '').trim()) {
        throw new Error('curate: malformed log; preference lines need text and full source item ids in parentheses or brackets.');
      }
      continue;
    }
    if (heading !== -1 && index >= heading) continue;
    observations += 1;
    const match = observation.exec(line)?.groups;
    const saidDates = match?.citations?.matchAll(/(?:^|;\s*)said (\d{4}-\d{2}-\d{2});/g) ?? [];
    if (!match || !isDate(match.event!) || !match.text!.trim()
      || [...saidDates].some((entry) => !isDate(entry[1]!))
      || (match.replacesDate !== undefined && !isDate(match.replacesDate))) {
      throw new Error('curate: malformed log; each observation needs an event date, a said date, and a full item id.');
    }
  }
  if (!observations) throw new Error('curate: malformed log; at least one dated observation is required.');
  return log;
}

const BAND_DETAIL: Readonly<Record<CurateBandDetail, string>> = {
  whole: '- Write each relevant fact from this band in full.',
  light: "- Compress this band's facts lightly: keep each fact's exact names, numbers and amounts; shorten only the surrounding wording.",
  compressed: "- Compress this band's facts: keep each needed fact to one short line with its exact names, numbers and amounts.",
  heavy: '- Keep only the facts in this band the task plainly needs; write each as a short line.',
};

// A lower band's pass gets the same base rules as the first — event
// dates, (when not stated), preferences, assistant mentions, working
// and counting — with only the framing and the displacement rule
// swapped for the layered form: keep existing lines untouched and
// name a line's own id to replace it.
const LAYER_FRAME = 'A dated log has already been written from the strongest evidence; you are layering the next batch of evidence into it for the same task. You get the task, the current log and this batch\'s evidence items, each with an id, a date, a weight and any recorded tags.\nEvery line of the current log starts with its own id, like L3. Keep each existing line exactly as it stands, id included; a line you keep carries its id unchanged and its wording untouched. Layer in only the facts the log does not already state, oldest first, in the same dated format with no id of your own:';
const LAYER_REPLACES = '- A line you add may replace an existing line only when it is a newer correction or decision about the same subject and its recorded importance is \'relevant\' or higher and at least the replaced line\'s: end your new line with "(replaces L3: the subject it corrects)", naming the replaced line\'s own id and the subject in words both lines use. Ideas, questions and low-importance asides only add lines; they never replace. When it is unclear whether an item corrects the same subject, keep both lines with their own dates.';
const layerInstructions = (base: string, band: CurateBand) => [
  base.replace(FRAME, LAYER_FRAME).replace(REPLACES, LAYER_REPLACES),
  BAND_DETAIL[band.detail],
  'Keep or update any working section and any preference lines. Return only the complete log.',
].join('\n');

function resolveBands(bands: readonly CurateBand[] | undefined): CurateBand[] | undefined {
  if (bands === undefined) return undefined;
  if (!Array.isArray(bands) || !bands.length
    || bands.some((band) => band === null || typeof band !== 'object'
      || typeof band.above !== 'number' || !Number.isFinite(band.above) || band.above < 0 || band.above > 1
      || !Object.hasOwn(BAND_DETAIL, band.detail))) {
    throw new TypeError("bands need floors between 0 and 1 with detail 'whole', 'light', 'compressed' or 'heavy'.");
  }
  const sorted = [...bands].sort((left, right) => right.above - left.above);
  if (sorted.some((band, index) => index > 0 && band.above === sorted[index - 1]!.above)) {
    throw new TypeError('band floors must be distinct.');
  }
  return sorted;
}

interface ParsedLine {
  readonly line: string;
  /** Line index inside the log's nonblank lines; kept for restores. */
  readonly index: number;
  readonly event: string;
  /** The observation's own text, without dates, citations or markers. */
  readonly text: string;
  readonly ids: ReadonlySet<string>;
  /** The line's own stable id (`L7`); set once when the line is written. */
  readonly lineId?: string;
  /** The line id a "(replaces L7)" marker names, when present. */
  readonly replacesId?: string;
  /** The writer's stated reason in a "(replaces L7: ...)" marker. */
  readonly replacesReason?: string;
  /** The date a "(replaces [date])" marker names, when present. A
   *  chained write never honours it: only a line's own id replaces. */
  readonly replacesDate?: string;
}

function parseObservations(log: string, patterns: ReturnType<typeof logPatterns>): ParsedLine[] {
  const lines = log.split('\n').map((line) => line.trim()).filter(Boolean);
  const parsed: ParsedLine[] = [];
  for (const [index, line] of lines.entries()) {
    const match = patterns.observation.exec(line)?.groups;
    if (!match) continue;
    // The citations group already passed the strict pattern, so every
    // id inside it is complete: pull out whole known ids rather than
    // split on separators, which also occur inside a source-qualified
    // ["source","id"] id.
    const ids = new Set<string>();
    for (const segment of match.citations!.split(patterns.saidGroup)) {
      for (const found of segment.matchAll(patterns.cited)) {
        ids.add(found[0]);
      }
    }
    parsed.push({ line, index, event: match.event!, text: match.text!, ids,
      ...(match.lineId === undefined ? {} : { lineId: match.lineId.trim() }),
      ...(match.replacesId === undefined ? {} : { replacesId: match.replacesId }),
      ...(match.replacesReason === undefined ? {} : { replacesReason: match.replacesReason.trim() }),
      ...(match.replacesDate === undefined ? {} : { replacesDate: match.replacesDate }) });
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
): { readonly log: string; readonly next: number } {
  let next = start;
  const seen = new Set<string>();
  const out = log.split('\n').map((line) => {
    const match = patterns.observation.exec(line.trim())?.groups;
    if (!match) return line;
    const body = line.trim().slice(match.lineId?.length ?? 0);
    const claimed = match.lineId?.trim();
    const id = claimed !== undefined && valid.has(claimed) && !seen.has(claimed)
      ? claimed : `L${next++}`;
    seen.add(id);
    return `${id} ${body}`;
  });
  return { log: out.join('\n'), next };
}

/** Drop a "(replaces ...)" tail from every observation line that carries
 *  one — a first pass has no earlier lines to replace — and report the
 *  stripped lines by their order among the log's observation lines, so
 *  the layer can record each attempt. */
function stripReplaces(log: string, observation: RegExp): { log: string; dropped: readonly number[] } {
  let ordinal = 0;
  const dropped: number[] = [];
  const out = log.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!observation.test(trimmed)) return line;
    const cleaned = trimmed.replace(/ \(replaces (?:\[\d{4}-\d{2}-\d{2}\]|L\d+(?::\s*[^()]+)?)\)$/, '');
    if (cleaned !== trimmed) dropped.push(ordinal);
    ordinal += 1;
    return cleaned;
  });
  return { log: out.join('\n'), dropped };
}

const IMPORTANCE: Readonly<Record<string, number>> = { passing: 0, relevant: 1, important: 2, critical: 3 };
/** The rank of a recorded importance value. An unrecorded or
 *  unrecognised value is not comparable; it is never read as
 *  'passing'. */
const importanceRank = (value: string | undefined) => (value === undefined ? undefined : IMPORTANCE[value]);
/** Tag values that can displace an earlier line about the same subject. */
const DISPLACING = new Set(['correction', 'decision', 'revert']);

/** A cited item supports a displacement when a recorded answer marks
 *  it a correction, decision or revert at 0.5 or more — a set's value
 *  is only the first of its questions to clear that bar, so a
 *  corrective instruction recorded as 'instruction' still counts
 *  through its answers — or its 'corrects something earlier' tag
 *  valued yes. */
const correctionTagged = (tags: NonNullable<PickRecordEntry['tags']>) =>
  tags.corrects?.value === 'yes'
  || Object.values(tags).some((tag) =>
    (tag.value !== undefined && DISPLACING.has(tag.value))
    || tag.answers.some((answer) => answer.status === 'answered'
      && (answer.probability ?? 0) >= 0.5 && DISPLACING.has(answer.key)));

/** Function words and correction boilerplate that cannot be a subject. */
const NOT_A_SUBJECT = new Set((
  'the a an and or but nor so if of to in on for with that this it its is was were are be been being as at by from into over under after before not no'
  + ' then than they them their we our us you your i me my he she his her do does did have has had will would shall should can could may might must'
  + ' let lets say says said tell tells told get gets got make makes made take takes took keep keeps kept put puts give gives gave go goes went come comes came'
  + ' same own also just only even still yet again back out up down off about above more most less least much many some any all both each every other another'
  + ' such very when while where which who whom whose what why how there here now new old'
  + ' change changes changed update updates updated move moves moved switch switches switched replace replaces replaced correct corrects correction'
  + ' decision decide decides decided revert reverts reverted because reason line item note facts fact actually instead rather confirm confirms confirmed'
  + ' latest current currently previous previously earlier later original originally'
).split(' '));

/** The words a line or a stated reason is about, minus function words,
 *  correction boilerplate and bare numbers. */
const wordsOf = (text: string) => new Set(
  (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => !NOT_A_SUBJECT.has(word) && !/^\d+$/.test(word)));

const subjectWords = (line: ParsedLine) => wordsOf(`${line.text} ${line.replacesReason ?? ''}`);

/** A changed value is the correction's point, not a different fact:
 *  numbers, ordinals and routine frequencies ('once', 'weekly', 'a
 *  third time') never mark a different subject. */
const VALUE_WORD = /^(?:\d+[a-z]*|once|twice|thrice|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|daily|weekly|monthly|yearly)$/;

/** The content words a raw line states in lowercase form. A capitalized
 *  token — a name, a place — can only identify the entity or carry a
 *  value, so it never marks a different fact; a lowercase content word
 *  can be either the rest of the subject or the changed value. */
const lowercaseFacts = (raw: string) => new Set(
  (raw.match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => word === word.toLowerCase())
    .map((word) => word.toLowerCase())
    .filter((word) => !NOT_A_SUBJECT.has(word) && !VALUE_WORD.test(word)));

/** The claim's stated reason names the subject it corrects; the lines
 *  prove it. The subject is the words the claim's text and the replaced
 *  line both state: every reason word must be one of them, and one
 *  shared word is never enough on its own: 'billing' occurs in a
 *  billing-cycle correction and an unrelated billing-address line.
 *  Even then the shared words can name only the entity while each
 *  line states a different fact about it. A lowercase content word
 *  only one line states is the changed value — the correction's
 *  whole point — when other words stand between it and the shared
 *  subject: 'Atlas deployment mode is automatic' correcting 'Atlas
 *  deployment mode is manual'. Sitting next to a shared subject word
 *  it is part of the subject itself, and the lines state different
 *  facts: 'Atlas deployment region is Europe' against 'Atlas
 *  deployment schedule is weekly' leaves 'region' and 'schedule'
 *  glued to 'deployment'. */
const sameSubject = (claim: ParsedLine, line: ParsedLine) => {
  const subject = subjectWords(line);
  const text = wordsOf(claim.text);
  const reason = wordsOf(claim.replacesReason ?? '');
  const shared = new Set([...text].filter((word) => subject.has(word)));
  if (!(reason.size > 0 && shared.size >= 2
    && [...reason].every((word) => subject.has(word) && text.has(word)))) return false;
  const claimFacts = lowercaseFacts(claim.text);
  const lineFacts = lowercaseFacts(line.text);
  // A word only this line states is a different subject when it sits
  // next to a shared subject word; separated from them it is the
  // changed value the correction is about.
  const subjectWord = (raw: string, facts: ReadonlySet<string>, other: ReadonlySet<string>) => {
    const tokens = (raw.match(/[\p{L}\p{N}]+/gu) ?? []).map((word) => word.toLowerCase());
    return tokens.some((word, index) => facts.has(word) && !other.has(word)
      && (shared.has(tokens[index - 1] ?? '') || shared.has(tokens[index + 1] ?? '')));
  };
  return !subjectWord(claim.text, claimFacts, lineFacts)
    && !subjectWord(line.text, lineFacts, claimFacts);
};

/** Merge a band pass's log with the log it layered. Lines are matched
 *  by their own ids, never by date, citation or wording. A kept id on
 *  changed wording is a reworded line: the original goes back. A line
 *  the pass dropped is allowed out only when a newly added line names
 *  its id in "(replaces Ln: reason)", every word of the stated reason
 *  is one the new line's text and the dropped line both state, the two
 *  lines share a second word with it (one shared word is no subject),
 *  the new line is newer by event date, and it cites an item answered a
 *  correction, decision or revert — or 'corrects something earlier'
 *  yes — whose recorded importance is 'relevant' or higher and at
 *  least the dropped line's. Both sides need recorded, recognised
 *  importance values to compare: a failed or unasked tag is not
 *  evidence of 'passing', so the drop is refused. A claim naming a
 *  line this pass kept is checked the same way, and only the rule
 *  removes the line. Everything else dropped is restored, because
 *  unclear drops keep both. */
function reconcile(
  prev: string,
  next: string,
  patterns: ReturnType<typeof logPatterns>,
  entries: ReadonlyMap<string, PickRecordEntry>,
): { log: string } & Pick<CurateLayer, 'added' | 'displaced' | 'refused'> {
  const before = parseObservations(prev, patterns);
  const after = parseObservations(next, patterns);
  const beforeById = new Map(before.map((line) => [line.lineId!, line]));
  const keptIds = new Set(after.map((line) => line.lineId!).filter((id) => beforeById.has(id)));
  const displaced: CurateLayer['displaced'][number][] = [];
  const refused: (CurateLayer['refused'][number] & { index: number })[] = [];
  const reworded = new Map<string, string>();
  // A line's importance for displacement is the highest recorded value
  // among its cited items, and exists only when every cited item
  // recorded a recognised one: an item whose importance was never
  // asked or whose answer failed could be critical, so an
  // unestablished importance refuses the drop and keeps both lines.
  const importanceOf = (ids: ReadonlySet<string>) => {
    let highest = 0;
    for (const id of ids) {
      const rank = importanceRank(entries.get(id)?.tags?.importance?.value);
      if (rank === undefined) return undefined;
      highest = Math.max(highest, rank);
    }
    return highest;
  };
  const displaces = (claim: ParsedLine, line: ParsedLine) => {
    if (claim.replacesReason === undefined || claim.replacesReason === ''
      || claim.event <= line.event || !sameSubject(claim, line)) return false;
    const bar = importanceOf(line.ids);
    return bar !== undefined && [...claim.ids].some((id) => {
      const tags = entries.get(id)?.tags;
      if (tags === undefined) return false;
      const rank = importanceRank(tags.importance?.value);
      // A 'passing' item is a low-importance aside: it only adds.
      return rank !== undefined && rank > 0 && rank >= bar && correctionTagged(tags);
    });
  };
  for (const line of after) {
    const original = beforeById.get(line.lineId!);
    if (original === undefined || original.line === line.line) continue;
    reworded.set(line.lineId!, original.line);
    refused.push({ id: line.lineId!, line: original.line, index: -1,
      byId: line.lineId, byLine: line.line,
      reason: 'an existing line may not be reworded; the original is restored' });
  }
  for (const line of before) {
    // A claim is checked whether this pass kept or dropped the line it
    // names: the writer is told to keep every line, so a kept line can
    // still be a valid target. Only a line this pass added may
    // displace: a claim on an existing line is a rewording, which is
    // restored untouched above and can carry no correction of its own.
    const claims = after.filter((candidate) => candidate.replacesId === line.lineId
      && !beforeById.has(candidate.lineId!));
    const by = claims.find((claim) => displaces(claim, line));
    if (by !== undefined) {
      displaced.push({ id: line.lineId!, line: line.line, byId: by.lineId!, byLine: by.line,
        reason: `a newer correction or decision about the same subject; the writer stated: ${by.replacesReason}` });
      continue;
    }
    if (keptIds.has(line.lineId!)) continue;
    const claim = claims[0];
    refused.push({ id: line.lineId!, line: line.line, index: line.index,
      ...(claim === undefined ? {} : { byId: claim.lineId!, byLine: claim.line }),
      reason: `${claim === undefined ? 'no line names its id'
        : claims.every((entry) => !entry.replacesReason) ? 'no claiming line states a reason'
        : claims.every((entry) => entry.event <= line.event) ? 'the claiming line is not newer'
          : claims.every((entry) => !sameSubject(entry, line)) ? 'no claiming line names a subject both lines state'
            : 'no claiming item is a tagged correction or decision with recorded importance above \'passing\' and at least the line\'s'}; both lines kept` });
  }
  // A "(replaces Ln)" marker is true only when it names a line this pass
  // displaced. On a new line a false marker is dropped: one naming a
  // kept line or an id the log never had is recorded, while one on a
  // refused claim is covered by that claim's entry. Markers on retained
  // lines are part of their wording and stay untouched.
  const displacedIds = new Set(displaced.map((entry) => entry.id));
  const stripped = new Map<string, string>();
  for (const line of after) {
    if (beforeById.has(line.lineId!)) continue;
    if (line.replacesId !== undefined) {
      if (displacedIds.has(line.replacesId)) continue;
      stripped.set(line.lineId!, line.line.replace(/ \(replaces L\d+(?::\s*[^()]+)?\)$/, ''));
      // A marker naming a line this pass dropped is already covered by
      // that line's refused entry; surviving or invented ids add one.
      if (keptIds.has(line.replacesId) || !beforeById.has(line.replacesId)) {
        const target = beforeById.get(line.replacesId);
        refused.push({ id: line.replacesId, index: -1,
          line: target?.line ?? line.line, byId: line.lineId!, byLine: line.line,
          reason: target === undefined
            ? 'the named id is not a line of this log; the marker is dropped'
            : 'the named line stays; the marker is dropped' });
      }
      continue;
    }
    // A "(replaces [date])" marker is never honoured in a chained
    // write: a replacement names a line by its own id. The marker is
    // dropped from the line it was written on and the attempt recorded.
    if (line.replacesDate !== undefined) {
      stripped.set(line.lineId!, line.line.replace(/ \(replaces \[\d{4}-\d{2}-\d{2}\]\)$/, ''));
      refused.push({ id: line.lineId!, index: -1,
        line: stripped.get(line.lineId!)!, byId: line.lineId!, byLine: line.line,
        reason: 'a replacement marker names a line by its own id, never by a date; the marker is dropped' });
    }
  }
  const added = after.filter((line) => !beforeById.has(line.lineId!))
    .map((line) => ({ id: line.lineId!, line: stripped.get(line.lineId!) ?? line.line }));
  const lines = next.split('\n').map((line) => line.trim()).filter(Boolean);
  const swapped = lines.flatMap((text) => {
    const groups = patterns.observation.exec(text)?.groups;
    const id = groups?.lineId?.trim();
    if (id === undefined) return [text];
    // A validated claim removes the line it names even when the writer
    // kept it; only code applies the drop.
    if (displacedIds.has(id)) return [];
    return [reworded.get(id) ?? stripped.get(id) ?? text];
  });
  const heading = swapped.findIndex((line) => line.replace(/^#{1,6}\s+/, '') === WORKING_HEADING);
  const limit = heading === -1 ? swapped.length : heading;
  const inserts = new Map<number, string[]>();
  for (const entry of refused) {
    if (entry.index < 0) continue;
    const at = Math.min(entry.index, limit);
    inserts.set(at, [...(inserts.get(at) ?? []), entry.line]);
  }
  const out: string[] = [];
  for (const [index, text] of swapped.entries()) {
    for (const insert of inserts.get(index) ?? []) out.push(insert);
    out.push(text);
  }
  for (const insert of inserts.get(swapped.length) ?? []) out.push(insert);
  return { log: out.join('\n'), added, displaced,
    refused: refused.map(({ id, line, byId, byLine, reason }) => ({
      id, line,
      ...(byId === undefined ? {} : { byId, byLine }),
      reason,
    })) };
}

/** Write only the dated log. Selected rules remain the caller's instructions. */
export async function curate(
  task: string,
  picked: PickResult,
  options: CurateOptions,
): Promise<CurateResult> {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const contextLimit = options.contextLimit;
  if (contextLimit !== undefined && (!Number.isInteger(contextLimit) || contextLimit <= 0)) {
    throw new TypeError('curate: contextLimit must be a positive integer of characters.');
  }
  const batchSize = options.batchSize;
  if (batchSize !== undefined && (!Number.isInteger(batchSize) || batchSize <= 0)) {
    throw new TypeError('curate: batchSize must be a positive integer of items.');
  }
  const taskKinds = options.routeByTask ? classifyTask(task) : undefined;
  const working = options.working ?? (taskKinds?.some((kind) => kind === 'count' || kind === 'date') ?? false);
  const context = options.context ?? false;
  const preferenceAdvice = options.preferenceAdvice ?? (taskKinds?.includes('advice') ?? false);
  const preferenceChange = options.preferenceChange ?? false;
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
  const blocks = items.map(({ id, candidate, weight }) =>
    `### ${id} (${candidate.date ? `${candidate.date.value}, ` : ''}${weight}${tagText(id)}): ${candidate.title}\n\n${candidate.text}`.trim());
  const instructionsWorking = !working ? INSTRUCTIONS : INSTRUCTIONS.replace(NO_WORKING,
    '- In the log itself, do not judge: give every observation its dates, including ones near the edge of a period the task names.')
    + '\nAfter the log, add a short section headed "Working (the curator\'s; check it against the log):". For a count or a list: number each distinct instance that falls inside the period the task names, with its date and id, then name any instance you left out and why (outside the period, or the same as another). For a question about time or order: the dates involved and the computed difference or order. For something that changed: the latest value and its date. Leave out any part the task does not need.';
  const instructions = instructionsWorking + (taskKinds?.includes('count') ? COUNT : '');
  const additions = preferences + (context ? CONTEXT : '');
  const ids = items.map((item) => item.id);
  // `batchSize` on its own chains a single whole-detail band.
  const bands = resolveBands(options.bands)
    ?? (batchSize === undefined ? undefined : [{ above: 0, detail: 'whole' as const }]);
  if (bands !== undefined && contextLimit !== undefined) {
    throw new TypeError('curate: a chained write (bands or batchSize) and contextLimit do not combine; a condensing pass cannot preserve a chained log\'s line ids and protections.');
  }
  let layers: CurateLayer[] | undefined;
  let log: string;
  if (bands === undefined) {
    const raw = await options.write({
      instructions: instructions + additions,
      body: `TASK:\n${datedTask}\n\nEVIDENCE:\n\n${blocks.join('\n\n')}`,
    }, signal);
    signal.throwIfAborted();
    log = checkLog(raw, working, ids, preferenceAdvice, preferenceChange);
  } else {
    // Chained write: the strongest band writes the log alone; each
    // lower band then layers over it at its own compression detail.
    // Every observation line carries a stable id (L1, L2, ...) from the
    // pass that wrote it, and reconcile matches lines by id alone.
    layers = [];
    const perBand = bands.map(() => [] as number[]);
    items.forEach((item, index) => {
      const band = bands.findIndex((candidate) => item.weight >= candidate.above);
      perBand[band === -1 ? bands.length - 1 : band]!.push(index);
    });
    // Within a band the writer sees items strongest first; `batchSize`
    // cuts a band's items into separate passes, each one layering over
    // the log under the same line-id and displacement rules, so the
    // writer never reads a whole band at once.
    const passes = perBand.flatMap((indexes, band) => {
      indexes.sort((left, right) => items[right]!.weight - items[left]!.weight || left - right);
      if (batchSize === undefined) return indexes.length === 0 ? [] : [{ band, indexes }];
      const batches: { band: number; indexes: number[] }[] = [];
      for (let start = 0; start < indexes.length; start += batchSize) {
        batches.push({ band, indexes: indexes.slice(start, start + batchSize) });
      }
      return batches;
    });
    const patterns = logPatterns(ids);
    log = '';
    let nextLineId = 1;
    for (const { band: bandIndex, indexes } of passes) {
      const band = bands[bandIndex]!;
      if (layers.length === 0) {
        const raw = await options.write({
          instructions: `${instructions.replace(REPLACES, FIRST_REPLACES)}\n${BAND_DETAIL[band.detail]}${additions}`,
          body: `TASK:\n${datedTask}\n\nEVIDENCE:\n\n${indexes.map((index) => blocks[index]).join('\n\n')}`,
        }, signal);
        signal.throwIfAborted();
        // The first pass was asked for no replacement markers; a writer
        // that left one anyway keeps the line's text and loses the
        // marker, and the attempt is recorded as refused.
        const unmarked = stripReplaces(
          checkLog(raw, working, ids, preferenceAdvice, preferenceChange), patterns.observation);
        const numbered = numberLines(unmarked.log, patterns, new Set(), nextLineId);
        log = numbered.log;
        nextLineId = numbered.next;
        const written = parseObservations(log, patterns);
        layers.push({ band: bandIndex, above: band.above, detail: band.detail, items: indexes.length,
          added: written.map((line) => ({ id: line.lineId!, line: line.line })),
          displaced: [],
          refused: unmarked.dropped.map((index) => ({
            id: written[index]!.lineId!, line: written[index]!.line,
            reason: 'a first pass has no earlier lines to replace; the marker is dropped',
          })),
        });
      } else {
        const raw = await options.write({
          instructions: layerInstructions(instructions, band) + additions,
          body: `TASK:\n${datedTask}\n\nLOG SO FAR:\n${log}\n\nEVIDENCE:\n\n${indexes.map((index) => blocks[index]).join('\n\n')}`,
        }, signal);
        signal.throwIfAborted();
        const checked = checkLog(raw, working, ids, preferenceAdvice, preferenceChange);
        const live = new Set(parseObservations(log, patterns).map((line) => line.lineId!));
        const numbered = numberLines(checked, patterns, live, nextLineId);
        nextLineId = numbered.next;
        const merged = reconcile(log, numbered.log, patterns, entries);
        log = checkLog(merged.log, working, ids, preferenceAdvice, preferenceChange);
        layers.push({ band: bandIndex, above: band.above, detail: band.detail, items: indexes.length,
          added: merged.added, displaced: merged.displaced, refused: merged.refused });
      }
    }
  }
  const logLength = log.length;
  const condensed = contextLimit !== undefined && logLength > contextLimit;
  if (condensed) {
    const rawCondensed = await options.write({
      instructions: [
        instructions,
        `Condense the log for the task to at most ${contextLimit} characters, including any working section, if possible.`,
        'Reduce the tiers in this order:',
        'First: merge or drop observations from items weighted below 0.1.',
        'Next: merge or drop observations from items weighted from 0.1 to below 0.6.',
        'Keep observations from items weighted 0.6 or more whole; do not shorten or drop them, even if the log must exceed the budget.',
        'Keep each retained observation\'s event date, said date, full source item ids, and replacement dates. Merge only observations with matching dates and keep all their source ids.',
        'Never truncate text. Return only the dated log and, when requested, working notes checked against the retained observations.',
      ].join('\n') + additions,
      body: `TASK:\n${datedTask}\n\nITEM WEIGHTS:\n${items.map((item) => `${item.id}: ${item.weight}`).join('\n')}\n\nLOG:\n${log}`,
    }, signal);
    signal.throwIfAborted();
    log = checkLog(rawCondensed, working, ids, preferenceAdvice, preferenceChange);
  }
  return {
    log,
    record: {
      promptVersion: 'v4', weights: 'tiers', working, preferenceAdvice, preferenceChange,
      ...(options.context === undefined ? {} : { context }),
      ...(taskKinds === undefined ? {} : { taskKinds }),
      ...(taskDate === undefined ? {} : { taskDate }), items, logLength, condensed,
      ...(bands === undefined ? {} : { bands }),
      ...(batchSize === undefined ? {} : { batchSize }),
      ...(layers === undefined ? {} : { layers }),
      ...(condensed ? { condensedLength: log.length } : {}),
      ...(contextLimit === undefined ? {} : { contextLimit }),
      overContextLimit: contextLimit !== undefined && log.length > contextLimit,
    },
  };
}
