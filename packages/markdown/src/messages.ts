import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import {
  DEFAULT_MAX_QUESTION_TEXT, SourceReadError,
  type CandidateReadContext, type CandidateReadRequest, type CandidateReadResult, type CandidateSource, type MemoryCandidate, type Mode,
} from '@curatejs/core';
import { knowledgeBase, splitParts } from './markdown.js';
import { directMessages } from './mode.js';

/** One message of a chat export between people. */
export interface ChatMessage {
  /** The day it was sent, as the export writes the date: `YYYY-MM-DD`. */
  readonly day: string;
  /** When it was sent, as the export writes it, in milliseconds read as UTC. */
  readonly time: number;
  readonly sender: string;
  /** Its text; a message the export runs over several lines keeps them. */
  readonly text: string;
}

/** How a date's first two numbers read: day then month, or month then day. */
export type DateOrder = 'day-first' | 'month-first';

// A message's first line, as WhatsApp's "Export chat" writes it on iOS,
// `[13/05/2023, 14:02:51] Sender: text`, or on Android,
// `13/05/2023, 14:02 - Sender: text`: the date with `/`, `.` or `-`, the
// time with or without seconds and with an optional AM or PM. A line
// that does not open this way continues the message before it.
const FIRST_LINE = /^‎?(?:\[(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[\s ]*([AaPp])\.?\s?[Mm]\.?)?\]\s|(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[\s ]*([AaPp])\.?\s?[Mm]\.?)?\s+-\s)/;

interface Line {
  readonly numbers: readonly [number, number, number];
  /** The year comes first: `2023-05-13`. */
  readonly yearFirst: boolean;
  /** The year is written with two digits: `13/05/23`. */
  readonly shortYear: boolean;
  readonly clock: readonly [number, number, number];
  readonly half?: string;
  readonly rest: string;
}

function firstLine(line: string): Line | undefined {
  const match = FIRST_LINE.exec(line);
  if (match === null) return undefined;
  const at = match[1] === undefined ? 8 : 1;
  const field = (index: number) => match[at + index];
  const yearFirst = field(0)!.length === 4;
  return { numbers: [Number(field(0)), Number(field(1)), Number(field(2))], yearFirst,
    shortYear: !yearFirst && field(2)!.length <= 2,
    clock: [Number(field(3)), Number(field(4)), Number(field(5) ?? 0)], ...(field(6) === undefined ? {} : { half: field(6)!.toLowerCase() }),
    rest: line.slice(match[0].length).replace(/^\u200e/, '') };
}

/** A line's moment read in one order of day and month, or NaN when that
 *  order makes it no date. */
function timeOf(line: Line, order: DateOrder): number {
  const [a, b, c] = line.numbers;
  const [year, month, day] = line.yearFirst ? [a, b, c] : order === 'day-first' ? [c, b, a] : [c, a, b];
  if (month < 1 || month > 12 || day < 1 || day > 31) return Number.NaN;
  let [hour] = line.clock;
  if (line.half === 'p' && hour < 12) hour += 12;
  if (line.half === 'a' && hour === 12) hour = 0;
  return Date.UTC(year < 100 ? 2000 + year : year, month - 1, day, hour, line.clock[1], line.clock[2]);
}

/** The order of day and month: a number over 12 settles it, and so do the
 *  dates themselves, since an export is in the order the messages were
 *  sent: the order under which they go back fewer times. When neither
 *  settles it, a 12-hour clock with a two-digit year, as a month-first
 *  phone writes its export, reads month first; anything else day first. */
function dateOrder(lines: readonly Line[]): { readonly dates: DateOrder; readonly settled: boolean } {
  const orders = (['day-first', 'month-first'] as const).filter((order) =>
    lines.every((line) => line.yearFirst || !Number.isNaN(timeOf(line, order))));
  if (orders.length === 1) return { dates: orders[0]!, settled: true };
  const back = (order: DateOrder) => lines.reduce((count, line, index) =>
    index > 0 && timeOf(line, order) < timeOf(lines[index - 1]!, order) ? count + 1 : count, 0);
  const [day, month] = [back('day-first'), back('month-first')];
  if (day !== month) return { dates: day < month ? 'day-first' : 'month-first', settled: true };
  const usPhone = lines.length > 0 && lines.every((line) => line.half !== undefined && line.shortYear);
  return { dates: usPhone ? 'month-first' : 'day-first', settled: false };
}

/** A name that may open a line once: a few words, no quotes. */
const nameLike = (name: string) => name.length <= 40 && name.split(/\s+/).length <= 4 && !/["“”«»]/.test(name);

/** The senders the export names. Senders are a small set within a file:
 *  a line's text before its first colon names one when it recurs on other
 *  lines, or when it looks like a name. A name always followed by the same
 *  colon and words, as `Dr: Jones` is, takes those words in. A notice of
 *  the app's own, such as `Alice changed the subject to "meet: at noon"`,
 *  names none. */
function sendersOf(lines: readonly Line[]): string[] {
  const count = new Map<string, number>();
  for (const line of lines) {
    let at = line.rest.indexOf(': ');
    while (at > 0) {
      const prefix = line.rest.slice(0, at);
      count.set(prefix, (count.get(prefix) ?? 0) + 1);
      at = line.rest.indexOf(': ', at + 2);
    }
  }
  const senders = new Set<string>();
  for (const line of lines) {
    const at = line.rest.indexOf(': ');
    if (at <= 0) continue;
    let name = line.rest.slice(0, at);
    const seen = count.get(name)!;
    if (seen < 2 && !nameLike(name)) continue;
    // Take in the next words while every line of this name has them.
    for (let next = line.rest.indexOf(': ', name.length + 2); next > 0 && seen > 1 && count.get(line.rest.slice(0, next)) === seen;
      next = line.rest.indexOf(': ', next + 2)) name = line.rest.slice(0, next);
    senders.add(name);
  }
  return [...senders].sort((left, right) => right.length - left.length);
}

/** The messages of a WhatsApp "Export chat" text (`_chat.txt`), in order,
 *  with the order of day and month the dates were read in and whether the
 *  export settled it. `order` sets the order and settles it.
 *
 *  A line that opens with a date and a sender the export names starts a
 *  message. A line that opens with a date and no such sender, or with a
 *  date earlier than the message before it, is kept as part of that
 *  message, as a line someone pasted into it would be; with no message
 *  before it, or no earlier date, it is the app's own notice, such as the
 *  notice that messages are end-to-end encrypted, and is left out. Any
 *  other line continues the message before it. */
export function parseWhatsapp(text: string, order?: DateOrder): { readonly messages: ChatMessage[]; readonly dates: DateOrder; readonly settled: boolean } {
  // The line break that ends the file is not part of the last message.
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  const starts = lines.map(firstLine);
  const dated = starts.filter((line): line is Line => line !== undefined);
  const { dates, settled } = order === undefined ? dateOrder(dated) : { dates: order, settled: true };
  const senders = sendersOf(dated);
  const messages: { day: string; time: number; sender: string; lines: string[] }[] = [];
  let current: { day: string; time: number; sender: string; lines: string[] } | undefined;
  lines.forEach((raw, index) => {
    const line = starts[index];
    const time = line === undefined ? Number.NaN : timeOf(line, dates);
    const sender = line === undefined ? undefined : senders.find((name) => line.rest.startsWith(`${name}: `));
    if (line === undefined || Number.isNaN(time) || sender === undefined || (current !== undefined && time < current.time)) {
      // A line with a date but no sender, at or after the message before
      // it, is the app's own notice; any other line continues the message.
      const notice = line !== undefined && sender === undefined && (current === undefined || !(time < current.time));
      if (!notice) current?.lines.push(raw);
      return;
    }
    current = { day: new Date(time).toISOString().slice(0, 10), time, sender, lines: [line.rest.slice(sender.length + 2)] };
    messages.push(current);
  });
  return { messages: messages.map(({ lines: said, ...message }) => ({ ...message, text: said.join('\n') })), dates, settled };
}

/** The day's session as one Markdown note, laid out as the LoCoMo runs
 *  read their sessions: the date as front matter, `# session <name>`, a
 *  `Date:` line, then each message as `<sender>: <text>` with the heading
 *  marks taken off its lines, the messages apart by a blank line. */
function sessionNote(name: string, day: string, messages: readonly ChatMessage[]): string {
  const body = messages.filter((message) => message.text !== '')
    .map((message) => `${message.sender}: ${message.text.replace(/^#+/gm, '')}`).join('\n\n');
  return `---\ndate: ${day}\n---\n# session ${name}\n\nDate: ${day}\n\n${body}\n`;
}

export interface WhatsappOptions {
  /** Read only days on or after this ISO date or this long before the task, such as '30 days'. */
  readonly since?: string;
  /** Whether the export writes the day or the month first. Left out, the
   *  export's own dates settle it when they can; when they cannot, the read
   *  says so in `partial` until this is set. */
  readonly dates?: DateOrder;
  /** Where the export's sessions are kept as notes. Defaults to
   *  `$XDG_CACHE_HOME/curate/messages`, or `~/.cache/curate/messages`. */
  readonly directory?: string;
  /** How the parts are judged and read. Defaults to `directMessages`. */
  readonly mode?: Mode;
}

/** A WhatsApp chat export (`_chat.txt`) as a source. Its messages are
 *  cut into one session a day, by the date each was sent: the runs that
 *  measured this kind of history read sessions that each held one day,
 *  and a day needs no gap length that nothing has measured. Each session
 *  is kept as a Markdown note in a folder of its own and read through
 *  `knowledgeBase()`, so the parts, the search lanes and the stored index
 *  are the Markdown reader's. The note is written again only when its
 *  text changes. Both senders are people; each part names the export's
 *  senders, so the layout keeps a speaker's name on what they said. */
export function whatsapp(path: string, options: WhatsappOptions = {}): CandidateSource {
  if (typeof path !== 'string' || !path.trim()) throw new TypeError('path must be a WhatsApp chat export file.');
  const folder = join(options.directory ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'curate', 'messages'),
    createHash('sha256').update(path).digest('hex').slice(0, 24));
  const id = `whatsapp:${path}`;
  const inner = knowledgeBase(folder, options.since === undefined ? {} : { since: options.since });
  let speakers: readonly string[] = [];
  let order: { readonly dates: DateOrder; readonly settled: boolean } = { dates: 'day-first', settled: true };
  // Each session note's text by its file name, to find what a part was cut from.
  const notes = new Map<string, string>();
  // The sessions are written once a call; every lane reads the notes.
  const written = new WeakMap<object, Promise<boolean>>();
  const write = async (): Promise<boolean> => {
    const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'EISDIR') return undefined;
      throw new SourceReadError('failed', `Could not read the WhatsApp export: ${error.message}`);
    });
    if (text === undefined) return false;
    const parsed = parseWhatsapp(text, options.dates);
    order = { dates: parsed.dates, settled: parsed.settled };
    const days = new Map<string, ChatMessage[]>();
    for (const message of parsed.messages) {
      const day = days.get(message.day);
      if (day === undefined) days.set(message.day, [message]); else day.push(message);
    }
    speakers = [...new Set(parsed.messages.map((message) => message.sender))].sort((left, right) => right.length - left.length);
    notes.clear();
    await mkdir(folder, { recursive: true });
    const names = new Set<string>();
    for (const [index, [day, messages]] of [...days].sort(([a], [b]) => a.localeCompare(b)).entries()) {
      const name = `session-${String(index + 1).padStart(3, '0')}`;
      const file = join(folder, `${name}.md`);
      names.add(basename(file));
      const note = sessionNote(name, day, messages);
      notes.set(basename(file), note);
      // Written whole under a name of this write's own and then moved into
      // place, so a call reading at the same time never sees half a note,
      // and calls writing at the same time never move each other's file.
      if (await readFile(file, 'utf8').catch(() => undefined) !== note) {
        const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporary, note, { mode: 0o600 });
        await rename(temporary, file);
      }
    }
    // A day the export no longer holds leaves no note behind.
    for (const entry of await readdir(folder)) if (entry.endsWith('.md') && !names.has(entry)) await rm(join(folder, entry), { force: true });
    return true;
  };
  // A part the notes reader cut from inside a message opens with the
  // sender of the line it starts in, so the decision model and the layout
  // see who said it. The part is found where the notes reader cut it: its
  // section of the note, cut again at the same size, and its number there.
  const spoken = (candidate: MemoryCandidate, budget: number): string => {
    const lead = /^(\s*)(.*)/.exec(candidate.text)!;
    const opener = new RegExp(`^(?:${speakers.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}): `);
    if (speakers.length === 0 || lead[2] === '' || opener.test(lead[2]!)) return candidate.text;
    const [file, lines] = (candidate.contentRef ?? '').split('#L');
    const note = notes.get(file ?? '');
    if (note === undefined || lines === undefined) return candidate.text;
    const [first, last] = lines.split('-L').map(Number) as [number, number];
    const lineStart = (line: number) => {
      let offset = 0;
      for (let at = 1; at < line && offset >= 0; at += 1) offset = note.indexOf('\n', offset) + 1;
      return offset;
    };
    const sectionStart = lineStart(first);
    const sectionEnd = note.indexOf('\n', lineStart(last)) + 1 || note.length;
    const pieces = splitParts(note.slice(sectionStart, sectionEnd), budget);
    const number = Number(/#\d+\.(\d+)$/.exec(candidate.id)?.[1] ?? 1);
    if (pieces[number - 1] !== candidate.text) return candidate.text;
    const at = sectionStart + pieces.slice(0, number - 1).reduce((length, piece) => length + piece.length, 0);
    // The lines before the part's first one, nearest first: the first that opens with a sender names it.
    const before = note.slice(0, at + lead[1]!.length).split('\n').reverse();
    for (const line of before) {
      const named = opener.exec(line);
      if (named !== null) return `${lead[1]}${named[0]}${candidate.text.slice(lead[1]!.length)}`;
      if (line.startsWith('# session')) break;
    }
    return candidate.text;
  };
  // The Markdown reader's settings stay: its name lanes, part size and look-back.
  return {
    ...inner, id, paths: [path], mode: options.mode ?? directMessages,
    async read(request: CandidateReadRequest, context?: CandidateReadContext): Promise<CandidateReadResult> {
      const shared = context?.shared;
      let done = shared === undefined ? undefined : written.get(shared);
      if (done === undefined) {
        done = (await stat(path).catch(() => undefined))?.isFile() === false ? Promise.resolve(false) : write();
        if (shared !== undefined) written.set(shared, done);
      }
      if (!await done) return { status: 'absent', reason: 'no-whatsapp-export' };
      const result = await inner.read(request, context);
      if (result.status !== 'read') return result;
      // The notes reader's part size: its own, or the request's when smaller.
      const budget = Math.min(DEFAULT_MAX_QUESTION_TEXT, request.maxQuestionText ?? DEFAULT_MAX_QUESTION_TEXT);
      const open = order.settled ? undefined : `The export's dates were read ${order.dates === 'day-first' ? 'day first' : 'month first'}: `
        + "no day in them is over 12 and their order fits both readings. Set dates to 'day-first' or 'month-first' to say which.";
      return { ...result,
        candidates: result.candidates.map((candidate) => ({ ...candidate, sourceId: id, speakers, text: spoken(candidate, budget) })),
        ...(open === undefined ? {} : { complete: false, partial: result.partial === undefined ? open : `${result.partial} ${open}` }),
        ...(result.historySize === undefined ? {} : { historySize: Object.fromEntries(Object.entries(result.historySize)
          .map(([source, count]) => [source === inner.id ? id : source, count])) }) };
    },
  };
}
