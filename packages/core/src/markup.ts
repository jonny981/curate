import type { MemoryCandidate, PickBatch, PickDecide } from './pick.js';
import type { CuratePrompt, CurateWrite } from './curate.js';
import type { CurateLeverStates } from './levers.js';

/** The extraction prompt: rows from the kept parts, for code to filter,
 *  count and add up. It reads the same task and evidence body as the
 *  log writer. */
export const EXTRACT = `You read evidence items from a person's past conversations and list the events that could bear on a question, one row per distinct event, for a program to filter, count and add up. Take every value from the items; never guess.

- One row per distinct event: one thing that happened, was done, bought, made, attended, planned or wished for. When two items tell the same event, write one row and give both ids.
- List every event on the question's topic, including doubtful ones, plans, wishes and other people's events: a later step decides which rows count. At most 60 rows.
- Fields of each row:
  - who: "you" for the user; otherwise the person's name or role as the item gives it.
  - what: the event in a few words, with its exact names.
  - status: "done", "planned", "wished" or "other".
  - date: YYYY-MM-DD, the day the event happened, worked out from the item's date ("last Friday" said on 2024-02-16 is 2024-02-09); "" when the item gives no time.
  - said: YYYY-MM-DD, the item's date.
  - amount: money with its currency sign, for example "$38"; "" when none.
  - quantity: a number and its unit as the item gives it, for example "4 laps", "35 minutes", "140 slides"; "" when none.
  - source: the item ids, for example ["E3"].
  - quote: the item's words that state the event, copied exactly, at most 30 words.
- Reply with JSON only, in this shape:
{
  "rows": [
    {
      "who": "",
      "what": "",
      "status": "",
      "date": "",
      "said": "",
      "amount": "",
      "quantity": "",
      "source": [],
      "quote": ""
    }
  ]
}`;

/** The markup prompt. It never sees the task. */
export const MARKUP = `You mark up a person's past conversations so that a program can read them. You get evidence items, each with an id (E1, E2, ...) and the date it was said. You do not get a question: mark up the items the same way for any later question.

For each item, in the order given, write its heading line exactly as shown, then the kept words:
## E<n> (said YYYY-MM-DD)

What to keep, copied word for word from the item. You may cut a long sentence with "…", but never change, reorder or add a word inside the kept text:
- Every sentence or clause in which the user tells something about themselves or people they know: what happened, what they did, bought, made, own, plan or wish to do, what they like or dislike, how they feel, with every name, number, amount, place and date.
- From the assistant, only the specific names, places, numbers or dates it gave as an answer or a recommendation, for example a restaurant or a book it recommended. Leave out its general advice.
- Leave out greetings, thanks, questions that state no fact, and text repeated from an earlier item.
- Start each kept line with "user:" or "assistant:".
- If an item holds nothing to keep, write its heading and nothing under it.

Tags. Wrap the source's own words in these tags. A tag never holds words that are not in the source; put the meaning in the attributes.
- <event who="..." status="..." date="YYYY-MM-DD">...</event> around the words that tell one thing that happened or will happen.
  - who: "you" when it is the user; otherwise the person's name or role as the item gives it, for example "brother", "Odalys", "assistant".
  - status: "done" (it happened), "planned" (intended or scheduled), "wished" (wanted, considered or hoped for), or "other".
  - date: the day the event happened, worked out from the said date: "last Friday" said on 2024-02-16 is 2024-02-09. Leave the attribute out when the item gives no time for the event.
- <amount>...</amount> around money or a measured quantity with its unit, for example "$38", "35 minutes", "7 km", "140 slides".
- <count>...</count> around a number of things, for example "three", "14", "a dozen".
- <pref feeling="..." strength="...">...</pref> around words that state a liking or a dislike. feeling: one word such as loves, likes, dislikes, hates, prefers, avoids, wants. strength: "strong" or "mild".
- <said tone="...">...</said> around words whose tone changes their meaning, for example joking, wishful, unsure.
- Put <amount>, <count> and <pref> inside the <event> they belong to when there is one. Tags may nest. Close every tag you open.

Write only the marked-up log: no notes, no summary and no answer.`;

/** The yes or no question the decision model answers for each row. */
export const ROW_QUESTION = 'Does this row count toward the answer to the task?';
export const ROW_TRUE = 'The row is one of the things the task asks about and counts toward its answer as the task words it: the right person, the right kind of event, done or planned as the task asks, inside any period the task names, and not a repeat of another row.';
export const ROW_FALSE = 'The row is about another person or another kind of thing, is a plan or wish when the task asks what happened, falls outside the period the task names, or repeats another row.';

/** A row counts when the decision model says yes with this probability or more. */
export const ROW_COUNT_BAR = 0.5;
/** Each markup call holds whole items up to this many characters of item
 *  text. An item longer than this goes alone, so it is not a cap on a
 *  request's size. */
export const MARKUP_CHUNK_CHARS = 40_000;
/** At most this many markup calls, and this many extraction calls,
 *  run at once. */
export const MARKUP_CALLS_AT_ONCE = 4;
/** Extraction is asked again while its reply is not JSON rows, and
 *  markup while its reply is empty, up to this many calls in all. */
const TRIES = 3;

// Runs jobs 0 to count - 1, at most `bound` at once, and returns their
// results in index order whatever order they finish in. The first
// failure cancels the jobs still running, through the signal each job
// gets, and is thrown once every job has stopped.
async function inOrder<T>(count: number, bound: number, signal: AbortSignal,
  job: (index: number, signal: AbortSignal) => Promise<T>): Promise<T[]> {
  const results: T[] = new Array(count);
  const stop = new AbortController();
  const onAbort = () => stop.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  let next = 0;
  let failure: { readonly error: unknown } | undefined;
  const worker = async () => {
    while (next < count && failure === undefined) {
      const index = next++;
      try {
        results[index] = await job(index, stop.signal);
      } catch (error) {
        failure ??= { error };
        stop.abort(error);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(bound, count) }, worker));
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (failure !== undefined) throw failure.error;
  return results;
}

/** One row the extraction wrote, as it wrote it. */
export type CurateRow = Readonly<Record<string, unknown>>;

/** One model call the low compression made. */
export interface CurateCall {
  readonly step: 'extract' | 'decide' | 'markup';
  /** The markup call's chunk, from 1, in chunk order. */
  readonly chunk?: number;
  /** 1 for the first call of this step or chunk, 2 for its retry. */
  readonly attempt: number;
  readonly ms: number;
  readonly status: 'done' | 'failed' | 'cancelled';
  readonly error?: string;
}

/** One line a section starts with when a turn's speaker names it. */
export type RestoreSpeaker = 'user' | 'assistant' | 'system';

/** A quote code put back under a cited part's section: the row it came
 *  from (from 1), the section's markup id, the speaker when the part
 *  shows one, and the span as the part's own text wrote it. */
export interface RestoredQuote {
  readonly row: number;
  readonly e: string;
  readonly speaker?: RestoreSpeaker;
  readonly span: string;
}

/** A quote a row carried that was not put back, unless the section
 *  already held its words: the row (from 1), the cited part's id when
 *  the citation resolved to a part, and the reason. */
export interface RestoreSkip {
  readonly row: number;
  readonly part?: string;
  readonly reason: 'invalid citation' | 'quote not in part' | 'speaker unclear';
}

export interface CurateMarkupRecord {
  readonly compression: 'low';
  /** The lever set as applied, carried from the pick's record, as on a
   *  log's record. */
  readonly levers: CurateLeverStates;
  readonly taskDate?: string;
  /** The hint line `answerHint` added to the task the extraction reads. */
  readonly answerHint?: string;
  /** The reference items in selected order. The extraction prompt shows
   *  each as `E` plus its 1-based position here. */
  readonly items: readonly { readonly id: string; readonly candidate: MemoryCandidate; readonly weight: number }[];
  /** The rows the extraction returned, in its order. */
  readonly rows: readonly CurateRow[];
  /** The decision model's probability for each row, in row order. */
  readonly probabilities: readonly number[];
  /** How many rows scored ROW_COUNT_BAR or more. */
  readonly counted: number;
  /** How many uncounted rows carrying an amount or quantity the head
   *  lists under the figures. */
  readonly uncountedListed: number;
  /** The parts some row cites, in markup order, each with its markup
   *  heading id. These ids number the whole selection sorted by said
   *  date, so they differ from the extraction's. */
  readonly marked: readonly { readonly e: string; readonly id: string; readonly said: string }[];
  /** The quotes code restored under the cited sections, in memory-text
   *  order. */
  readonly restored: readonly RestoredQuote[];
  /** The quotes code did not restore, in the order the rows cite them. */
  readonly restoreSkipped: readonly RestoreSkip[];
  readonly chunks: number;
  /** Every model call, in the order each finished. */
  readonly calls: readonly CurateCall[];
  /** Each step's wall-clock time, and the whole call's. */
  readonly ms: { readonly extract: number; readonly decide: number; readonly markup: number; readonly total: number };
}

/** A low compression call that failed: which step, why, and the calls
 *  made up to then. No memory text is returned. */
export class CurateError extends Error {
  readonly step: 'extract' | 'decide' | 'markup';
  readonly calls: readonly CurateCall[];
  constructor(message: string, step: CurateError['step'], calls: readonly CurateCall[], options?: ErrorOptions) {
    super(message, options);
    this.name = 'CurateError';
    this.step = step;
    this.calls = calls;
  }
}

// ---- dates

/** The calendar date a date value or label writes first, as YYYY-MM-DD:
 *  `2023/05/28 (Sun) 12:05`, `2023-05-28` and `2023-05-28T12:05:00Z`
 *  all give `2023-05-28`. '' when it writes none. */
export function dayOf(value: unknown): string {
  const match = /(\d{4})[/-](\d{2})[/-](\d{2})/.exec(String(value ?? ''));
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}
const isIso = (value: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''));
const dayNumber = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 864e5;
const daysBetween = (from: string, to: string) => dayNumber(to) - dayNumber(from);

// ---- markup input

export interface MarkupItem {
  /** The markup heading id. */
  readonly e: string;
  readonly candidate: MemoryCandidate;
  readonly said: string;
  readonly block: string;
}

/** Every item numbered for markup: sorted by said date, then id, with
 *  ties kept in selected order. An undated item sorts first and its
 *  heading says the date is unknown. */
export function markupItems(candidates: readonly MemoryCandidate[]): MarkupItem[] {
  return candidates.map((candidate) => ({ candidate, said: dayOf(candidate.date?.value) }))
    .sort((left, right) => left.said.localeCompare(right.said) || left.candidate.id.localeCompare(right.candidate.id))
    .map(({ candidate, said }, index) => ({ e: `E${index + 1}`, candidate, said,
      block: `### E${index + 1} (said ${said || 'unknown'}): ${candidate.title}\n\n${candidate.text}` }));
}

/** Whole items in order, each chunk at most `max` characters of item
 *  text, except that an item longer than `max` goes alone. */
export function markupChunks(items: readonly MarkupItem[], max = MARKUP_CHUNK_CHARS): MarkupItem[][] {
  const out: MarkupItem[][] = [];
  let current: MarkupItem[] = [];
  let size = 0;
  for (const item of items) {
    if (current.length && size + item.block.length > max) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += item.block.length;
  }
  if (current.length) out.push(current);
  return out;
}

// ---- extraction

/** The rows in an extraction reply: code fences dropped, the text from
 *  the first `{` to the last `}` read as JSON, and its `rows` array.
 *  Throws when there is no such array or an entry is not an object. */
export function parseRows(text: string): CurateRow[] {
  const plain = text.replace(/```[a-z]*\n?/gi, '');
  const parsed: unknown = JSON.parse(plain.slice(plain.indexOf('{'), plain.lastIndexOf('}') + 1));
  const rows = (parsed as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) throw new Error('no rows array');
  const bad = rows.findIndex((row) => row === null || typeof row !== 'object' || Array.isArray(row));
  if (bad >= 0) throw new Error(`row ${bad + 1} is not an object`);
  return rows as CurateRow[];
}

/** The selected positions a row cites: every `E<n>` in its source, as n - 1. */
export function citedPositions(row: CurateRow): number[] {
  return [...JSON.stringify(row.source ?? '').matchAll(/E(\d+)/g)].map((match) => Number(match[1]) - 1);
}

// ---- figures

const WORDS: Readonly<Record<string, number>> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, dozen: 12, couple: 2, half: 0.5 };
const NUMBER = /(\$|£|€)?\s*(\d[\d,]*(?:\.\d+)?|\.\d+)|\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)-(one|two|three|four|five|six|seven|eight|nine)\b|\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|dozen|couple|half)\b/i;
const MONEY_WORDS = new Set(['dollar', 'dollars', 'usd', 'buck', 'bucks']);
const CURRENCIES = ['$', '£', '€'];

interface Term { readonly value: number; readonly unit: string }

/** The first number in a text with its unit: the currency before it, or
 *  the word after it. Hours become minutes. null when there is none. */
function firstNumber(text: string): Term | null {
  const match = NUMBER.exec(text);
  if (!match) return null;
  let value: number;
  const currency = match[1] ?? '';
  if (match[2] !== undefined) value = Number(match[2].replace(/,/g, ''));
  else if (match[3]) value = WORDS[match[3].toLowerCase()]! + WORDS[match[4]!.toLowerCase()]!;
  else value = WORDS[match[5]!.toLowerCase()]!;
  if (!Number.isFinite(value)) return null;
  const after = text.slice(match.index + match[0].length).match(/^\s*(?:of\s+)?([A-Za-z]+)/)?.[1]?.toLowerCase() ?? '';
  let unit = currency ? currency : MONEY_WORDS.has(after) ? '$' : after;
  if (/^(minute|minutes|min|mins)$/.test(unit)) unit = 'minutes';
  else if (/^(hour|hours|hr|hrs)$/.test(unit)) {
    unit = 'minutes';
    value *= 60;
  } else if (unit && !CURRENCIES.includes(unit)) unit = unit.replace(/(?<=[a-z]{3})s$/, '');
  return { value, unit };
}

const format = (n: number) => Number.isInteger(n) ? n.toLocaleString('en-US') : String(Math.round(n * 100) / 100);

/** The sum of the terms per unit, each with its addends. */
function sumText(terms: readonly Term[]): string {
  const byUnit = new Map<string, number[]>();
  for (const term of terms) byUnit.set(term.unit, [...(byUnit.get(term.unit) ?? []), term.value]);
  const parts = [...byUnit].map(([unit, values]) => {
    const sum = values.reduce((a, b) => a + b, 0);
    const money = CURRENCIES.includes(unit);
    const tail = unit === 'minutes' ? ` minutes (${format(sum / 60)} hours)` : money ? '' : unit ? ` ${unit}` : '';
    return `${money ? unit : ''}${format(sum)}${tail} (${values.map(format).join(' + ')})`;
  });
  const all = terms.reduce((a, term) => a + term.value, 0);
  return byUnit.size > 1 ? `${parts.join('; ')}; all numbers together, ignoring units: ${format(all)}` : parts[0] ?? 'no numbers found';
}

/** One row as the decision model and the reader see it. */
export function rowText(row: CurateRow): string {
  const field = (key: string) => String(row[key] ?? '').trim();
  const source = (Array.isArray(row.source) ? row.source : [row.source]).filter(Boolean).join(', ');
  return `who: ${field('who')} | what: ${field('what')} | status: ${field('status')} | date: ${field('date') || 'not stated'}${field('when') ? ` ("${field('when')}")` : ''} (said ${field('said')}) | amount: ${field('amount') || '-'} | quantity: ${field('quantity') || '-'} | source: ${source} "${field('quote')}"`;
}

/** Code's figures over the counted rows (how many, the sums of their
 *  amounts and quantities, the day span), and the rows listed by date.
 *  With a task date, each dated row also says how many days before it. */
export function figures(rows: readonly CurateRow[], taskDate: string | undefined): { figures: string[]; list: string[] } {
  const asked = dayOf(taskDate);
  const dated = rows.map((row) => ({ row,
    day: isIso(row.date) ? String(row.date) : isIso(row.said) ? String(row.said) : '',
    from: isIso(row.date) ? 'event' : 'said' }));
  const lines = [`Rows counted: ${rows.length}`];
  const amounts = rows.map((row) => row.amount ? firstNumber(String(row.amount)) : null)
    .filter((term): term is Term => term !== null)
    .map((term) => ({ ...term, unit: CURRENCIES.includes(term.unit) ? term.unit : term.unit || '$' }));
  if (amounts.length) lines.push(`Sum of amounts: ${sumText(amounts)}`);
  const quantities = rows.map((row) => row.quantity ? firstNumber(String(row.quantity)) : null)
    .filter((term): term is Term => term !== null);
  if (quantities.length) lines.push(`Sum of quantities: ${sumText(quantities)}`);
  const days = [...new Set(dated.map((entry) => entry.day).filter(Boolean))].sort();
  if (days.length > 1) {
    const span = daysBetween(days[0]!, days.at(-1)!);
    lines.push(`Days from the earliest to the latest counted row: ${span} (${format(span / 7)} weeks), ${days[0]} to ${days.at(-1)}`);
  }
  const list = dated.sort((left, right) => (left.day || '9').localeCompare(right.day || '9'))
    .map(({ row, day, from }, index) => `${index + 1}. [${day || 'no date'}${from === 'said' && day ? ', said' : ''}${day && asked ? `, ${daysBetween(day, asked)} days before the question date` : ''}] ${rowText(row)}`);
  return { figures: lines, list };
}

/** The extracted rows under `ROW_COUNT_BAR` that still carry an amount
 *  or quantity, as the lines the head lists under the figures, in
 *  extraction order and keeping duplicates:
 *  `<row index + 1>. [probability <p>] <row text>`. The row's citations
 *  resolve to the markup ids of the marked-up parts and are labelled
 *  `log sections`; a citation that resolves to no marked-up part is
 *  left out, and a row left with none shows `log sections: -`. */
export function uncountedLines(input: {
  readonly rows: readonly CurateRow[];
  readonly probabilities: readonly number[];
  /** The reference items in selected order: a row's `E<n>` cites position n - 1. */
  readonly parts: readonly { readonly id: string }[];
  /** The parts the markup wrote a section for, with their markup ids. */
  readonly marked: readonly { readonly e: string; readonly id: string }[];
}): string[] {
  const lines: string[] = [];
  input.rows.forEach((row, index) => {
    const probability = input.probabilities[index]!;
    if (probability >= ROW_COUNT_BAR) return;
    if (![row.amount, row.quantity].some((value) => String(value ?? '').trim())) return;
    const sections = citedPositions(row)
      .map((position) => input.marked.find((item) => item.id === input.parts[position]?.id)?.e)
      .filter((e): e is string => e !== undefined);
    const rendered = rowText({ ...row, source: sections.length ? sections : ['-'] });
    lines.push(`${index + 1}. [probability ${probability}] ${rendered.replace(' | source: ', ' | log sections: ')}`);
  });
  return lines;
}

/** The memory text: the figures, any uncounted rows carrying an amount
 *  or quantity, and the counted rows, then the cited parts' marked-up
 *  sections. */
export function assemble(input: {
  readonly figures: readonly string[];
  readonly list: readonly string[];
  readonly extracted: number;
  /** The `uncountedLines` for the call, listed between the figures and
   *  the counted rows when it holds a line. */
  readonly uncounted: readonly string[];
  readonly sections: readonly string[];
}): string {
  const head = ['### computed by code from extracted rows the decision model counted', '',
    `Figures over the ${input.list.length} rows counted (of ${input.extracted} rows extracted):`,
    ...input.figures.map((line) => `- ${line}`), '',
    ...(input.uncounted.length
      ? ['Uncounted rows with an amount or quantity:',
        'The figures above omit every row listed here: they are not included in the row count, sums or date calculations.',
        ...input.uncounted, '']
      : []),
    'Counted rows, by date:', ...(input.list.length ? input.list : ['(none)'])].join('\n');
  const below = input.sections.length
    ? `### marked-up log, the parts the rows cite\n\n${input.sections.join('\n\n')}\n\n\n` : '';
  return `${head}\n\n${below}`;
}

/** The section under a markup heading `## <e> (said ...)`, up to the
 *  next such heading; '' when the markup has no such heading. */
export function markupSection(markup: string, e: string): string {
  const at = markup.search(new RegExp(`^##\\s*${e}\\s*\\(said`, 'm'));
  if (at < 0) return '';
  const rest = markup.slice(at);
  const next = rest.slice(1).search(/^##\s*E\d+\s*\(said/m);
  return (next < 0 ? rest : rest.slice(0, next + 1)).trim();
}

// ---- restore

/** Whitespace as Python reads it: the JavaScript set without U+FEFF,
 *  plus \x1c-\x1f and \x85. */
const SPACE = '[\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const SPACE_RUN = new RegExp(`${SPACE}+`);
/** A line that opens a turn in a part's text: `user:`, `assistant:` or
 *  `system:` at the text's start or right after a newline (a \u2028 or
 *  \u2029 break does not start a line). */
const TURN = new RegExp(`(?:^|(?<=\\n))(user|assistant|system):${SPACE}*`, 'g');
const TURN_IN = new RegExp(`(?:^|(?<=\\n))(user|assistant|system):${SPACE}*`);
/** The markup tags the words check strips, opening and closing, with any
 *  attributes; a name ends only where a word character does not follow. */
const TAGS = /<\/?(?:event|amount|count|pref|said)(?![\p{L}\p{N}_])[^>]*>/giu;
/** Runs of Unicode word characters: letters, digits and underscore. */
const WORD_RUN = /[\p{L}\p{N}_]+/gu;

/** A text's words for the already-there check: lower-case, markup tags
 *  dropped, word runs joined by single spaces. */
function words(text: string): string {
  return (text.replace(TAGS, '').toLowerCase().match(WORD_RUN) ?? []).join(' ');
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ALNUM_START = /^[\p{L}\p{N}]/u;
const ALNUM_END = /[\p{L}\p{N}]$/u;

/** Every exact match of the quote in the part's text. Only whitespace
 *  may differ between the quote's pieces; a match that would extend a
 *  word on either side is not one. */
function exactMatches(quote: string, text: string): RegExpExecArray[] {
  const pieces = quote.split(SPACE_RUN).filter(Boolean);
  if (!pieces.length) return [];
  let pattern = pieces.map(escapeRe).join(`${SPACE}+`);
  if (ALNUM_START.test(pieces[0]!)) pattern = `(?<![\\p{L}\\p{N}_])${pattern}`;
  if (ALNUM_END.test(pieces.at(-1)!)) pattern += `(?![\\p{L}\\p{N}_])`;
  return [...text.matchAll(new RegExp(pattern, 'gu'))];
}

/** The first usable exact match of the quote in the part's own text:
 *  the span as written, its offset and the speaker the part shows. A
 *  match whose span holds a turn line is never used; what is left must
 *  agree on one speaker (or none), else the quote is unclear. */
function sourceSpan(quote: string, candidate: MemoryCandidate):
    { offset: number; span: string; speaker?: RestoreSpeaker } | 'quote not in part' | 'speaker unclear' {
  const matches = exactMatches(quote, candidate.text);
  if (!matches.length) return 'quote not in part';
  const usable: { offset: number; span: string; speaker?: RestoreSpeaker }[] = [];
  for (const match of matches) {
    const span = candidate.text.slice(match.index, match.index + match[0].length);
    if (TURN_IN.test(span)) continue;
    const priors = [...candidate.text.slice(0, match.index).matchAll(TURN)];
    const speaker = priors.length ? priors.at(-1)![1] as RestoreSpeaker
      : candidate.chat?.role === 'user' || candidate.chat?.role === 'assistant' ? candidate.chat.role : undefined;
    usable.push({ offset: match.index, span, speaker });
  }
  return usable.length && new Set(usable.map((found) => found.speaker)).size === 1 ? usable[0]! : 'speaker unclear';
}

/** Put every extracted row's exact quote at the end of the section of
 *  each part it cites when the section's words do not already hold it:
 *  `parts` are the references in selected order (a row's `E<n>` cites
 *  position `n - 1`), `items` the parts the markup wrote a section for
 *  in memory-text order, and `sections` each item's cut section. A
 *  restored line is `speaker: span`, or the span alone when the part
 *  shows no speaker; lines go after the section's last non-blank
 *  character, one per line, in their order in the part text. Every
 *  existing byte of every section stays as it was. */
export function restoreQuotes(input: {
  readonly rows: readonly CurateRow[];
  readonly parts: readonly { readonly id: string; readonly candidate: MemoryCandidate }[];
  readonly items: readonly { readonly e: string; readonly id: string; readonly candidate: MemoryCandidate }[];
  readonly sections: readonly string[];
}): { sections: string[]; restored: RestoredQuote[]; restoreSkipped: RestoreSkip[] } {
  const itemOf = new Map(input.items.map((item, index) => [item.candidate, { item, index }]));
  const added: { row: number; offset: number; speaker?: RestoreSpeaker; span: string; line: string }[][] =
    input.items.map(() => []);
  const restoreSkipped: RestoreSkip[] = [];
  input.rows.forEach((row, index) => {
    const quote = String(row.quote ?? '').trim();
    if (!quote) return;
    for (const position of new Set(citedPositions(row))) {
      const candidate = input.parts[position]?.candidate;
      const entry = candidate === undefined ? undefined : itemOf.get(candidate);
      if (entry === undefined) {
        restoreSkipped.push({ row: index + 1, ...(candidate === undefined ? {} : { part: input.parts[position]!.id }),
          reason: 'invalid citation' });
        continue;
      }
      const { item, index: section } = entry;
      const held = words(`${input.sections[section]!}\n${added[section]!.map((line) => line.line).join('\n')}`);
      const key = words(quote);
      if (key && held.includes(key)) continue;
      const found = sourceSpan(quote, item.candidate);
      if (typeof found === 'string') {
        restoreSkipped.push({ row: index + 1, part: item.id, reason: found });
        continue;
      }
      added[section]!.push({ row: index + 1, offset: found.offset, speaker: found.speaker, span: found.span,
        line: found.speaker === undefined ? found.span : `${found.speaker}: ${found.span}` });
    }
  });
  const restored: RestoredQuote[] = [];
  const sections = input.sections.map((section, index) => {
    const lines = added[index]!.sort((a, b) => a.offset - b.offset);
    restored.push(...lines.map((line) => ({ row: line.row, e: input.items[index]!.e,
      ...(line.speaker === undefined ? {} : { speaker: line.speaker }), span: line.span })));
    return lines.length ? `${section}\n${lines.map((line) => line.line).join('\n')}` : section;
  });
  return { sections, restored, restoreSkipped };
}

// ---- the pipeline

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Extract rows, decide which count, compute the figures, mark up the
 *  cited parts and assemble the memory text. Any failure throws a
 *  CurateError; no failure returns an empty text. */
export async function writeMarkup(input: {
  readonly write: CurateWrite;
  readonly decide: PickDecide;
  readonly signal: AbortSignal;
  /** The task with its date and hint, as the extraction body begins. */
  readonly head: string;
  /** The evidence blocks the log writer reads, in selected order. */
  readonly blocks: readonly string[];
  /** Evidence over this many estimated tokens (characters divided by
   *  four) is extracted in batches of about this size. */
  readonly batchTokens: number;
  /** The task the decision model reads: the task with its date. */
  readonly decisionTask: string;
  readonly taskDate: string | undefined;
  /** The reference items in selected order, with their full ids. */
  readonly items: readonly { readonly id: string; readonly candidate: MemoryCandidate }[];
}): Promise<{ text: string; record: Omit<CurateMarkupRecord, 'compression' | 'levers' | 'taskDate' | 'answerHint' | 'items'> }> {
  const { write, decide, signal } = input;
  const references = input.items.map((item) => item.candidate);
  const fullId = new Map(input.items.map((item) => [item.candidate, item.id]));
  const calls: CurateCall[] = [];
  const started = Date.now();
  const fail = (step: CurateCall['step'], text: string, cause?: unknown): never => {
    throw new CurateError(`curate: ${step} failed; ${text}`, step, [...calls], cause === undefined ? undefined : { cause });
  };
  // One model call, recorded whether it returns, fails or is cancelled.
  const timed = async <T>(call: Omit<CurateCall, 'ms' | 'status' | 'error'>, run: () => Promise<T>, own = signal): Promise<T> => {
    const then = Date.now();
    try {
      const value = await run();
      own.throwIfAborted();
      calls.push({ ...call, ms: Date.now() - then, status: 'done' });
      return value;
    } catch (error) {
      calls.push({ ...call, ms: Date.now() - then, status: own.aborted ? 'cancelled' : 'failed', error: message(error) });
      throw error;
    }
  };

  // Extract: evidence that fits one batch goes in one call. Larger
  // evidence goes in consecutive batches of whole blocks in selected
  // order, as the log writer cuts its batches. This bounds the evidence
  // in an ordinary batch; a block larger than a batch goes alone. Rows from
  // separate batches are not merged. Each reply is asked for again while
  // it is not JSON rows.
  const batches: string[][] = [[]];
  let size = 0;
  for (const block of input.blocks) {
    const cost = Math.ceil(block.length / 4);
    if (batches.at(-1)!.length && size + cost > input.batchTokens) {
      batches.push([]);
      size = 0;
    }
    batches.at(-1)!.push(block);
    size += cost;
  }
  const extractBatch = async (index: number, own: AbortSignal): Promise<CurateRow[]> => {
    const body = `${input.head}\n\nEVIDENCE:\n\n${batches[index]!.join('\n\n')}`;
    let reason = '';
    for (let attempt = 1; attempt <= TRIES; attempt++) {
      const reply = await timed({ step: 'extract', ...(batches.length > 1 ? { chunk: index + 1 } : {}), attempt }, () =>
        write({ instructions: EXTRACT, body, step: 'extract' }, own), own);
      try {
        if (typeof reply !== 'string') throw new TypeError('write must return text');
        return parseRows(reply);
      } catch (error) {
        reason = message(error);
      }
    }
    throw new Error(`${batches.length > 1 ? `batch ${index + 1} of ${batches.length}: ` : ''}no reply held JSON rows after ${TRIES} calls: ${reason}`);
  };
  let extracted: CurateRow[] = [];
  try {
    extracted = (await inOrder(batches.length, MARKUP_CALLS_AT_ONCE, signal, extractBatch)).flat();
  } catch (error) {
    fail('extract', message(error), error);
  }
  const extractMs = Date.now() - started;

  // Decide: one yes or no question per row; every row needs an answer.
  const decideStarted = Date.now();
  let probabilities: number[] = [];
  if (extracted.length) {
    const batch: PickBatch = { task: input.decisionTask, questions: extracted.map((row, index) => ({
      key: `row-${index + 1}`, sourceId: 'curate:rows', id: `row-${index + 1}`, role: 'reference', title: `Row ${index + 1}`,
      text: rowText(row), question: ROW_QUESTION, trueCriterion: ROW_TRUE, falseCriterion: ROW_FALSE,
    })) };
    let answers: Awaited<ReturnType<PickDecide>>;
    try {
      answers = await timed({ step: 'decide', attempt: 1 }, () => decide(batch, signal));
    } catch (error) {
      return fail('decide', message(error), error);
    }
    probabilities = batch.questions.map((question) => {
      const answer = answers?.[question.key];
      return answer?.status === 'answered' && 'probability' in answer
        && Number.isFinite(answer.probability) ? answer.probability : NaN;
    });
    const unanswered = batch.questions.filter((_, index) => Number.isNaN(probabilities[index]));
    if (unanswered.length) {
      fail('decide', `the decision model left ${unanswered.length} of ${batch.questions.length} rows unanswered (${unanswered.map((question) => `${question.id}: ${answers?.[question.key]?.status ?? 'missing'}`).join(', ')}).`);
    }
  }
  const counted = extracted.filter((_, index) => probabilities[index]! >= ROW_COUNT_BAR);
  const decideMs = Date.now() - decideStarted;
  const { figures: lines, list } = figures(counted, input.taskDate);

  // Mark up: only the parts some extracted row cites. An extraction id
  // is a position in the selected order; it is resolved to its part
  // before any markup id, which numbers parts by said date, is read.
  // A part is the candidate object itself, so equal local ids from two
  // sources stay two parts.
  const markupStarted = Date.now();
  const cited = new Set(extracted.flatMap(citedPositions).map((position) => references[position]).filter(Boolean));
  const items = markupItems(references).filter((item) => cited.has(item.candidate));
  const groups = markupChunks(items);
  // A failed chunk cancels the others.
  const markupChunk = async (index: number, own: AbortSignal): Promise<string> => {
    const prompt: CuratePrompt = { instructions: MARKUP,
      body: `EVIDENCE:\n\n${groups[index]!.map((item) => item.block).join('\n\n')}`, step: 'markup' };
    let text = '';
    // A reply counts only when it holds the heading of every part it
    // was sent; a part left out would drop its evidence silently.
    let lost = groups[index]!;
    for (let attempt = 1; attempt <= TRIES && lost.length; attempt++) {
      const reply = await timed({ step: 'markup', chunk: index + 1, attempt }, () => write(prompt, own), own);
      if (typeof reply !== 'string') throw new TypeError('write must return text');
      text = reply.trim();
      lost = groups[index]!.filter((item) => !markupSection(text, item.e));
    }
    if (lost.length) {
      throw new Error(`chunk ${index + 1} of ${groups.length} ${text
        ? `left out ${lost.map((item) => `${item.e} (${fullId.get(item.candidate)})`).join(', ')}`
        : 'came back empty'} after ${TRIES} calls`);
    }
    return text;
  };
  let pieces: string[] = [];
  try {
    pieces = await inOrder(groups.length, MARKUP_CALLS_AT_ONCE, signal, markupChunk);
  } catch (error) {
    fail('markup', message(error), error);
  }
  const markup = pieces.join('\n\n');
  const sections = items.map((item) => markupSection(markup, item.e));
  const markupMs = Date.now() - markupStarted;

  // Put each row's exact quote back under every part it cites when the
  // markup left those words out, with the speaker the part shows.
  const { sections: restoredSections, restored, restoreSkipped } = restoreQuotes({
    rows: extracted, parts: input.items,
    items: items.map((item) => ({ e: item.e, id: fullId.get(item.candidate)!, candidate: item.candidate })),
    sections });

  // Rows under the count bar that still carry an amount or quantity go
  // under the figures; their citations resolve to markup ids.
  const marked = items.map((item) => ({ e: item.e, id: fullId.get(item.candidate)!, said: item.said }));
  const uncounted = uncountedLines({ rows: extracted, probabilities, parts: input.items, marked });
  const text = assemble({ figures: lines, list, extracted: extracted.length, uncounted, sections: restoredSections });
  return { text, record: {
    rows: extracted, probabilities, counted: counted.length, uncountedListed: uncounted.length,
    marked,
    restored, restoreSkipped,
    chunks: groups.length, calls,
    ms: { extract: extractMs, decide: decideMs, markup: markupMs, total: Date.now() - started },
  } };
}
