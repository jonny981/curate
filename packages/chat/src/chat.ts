import { createHash } from 'node:crypto';
import { lstat, open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';

import {
  canonicalPath, phraseCount, phraseQuery, phraseWords, PHRASE_INDEX, laneBend, normalized, similarity, sinceCutoff, taskMoment, timeZoneOf,
  zonedIso, bagEntries, checkIndexOption, eachPartVector, indexDirectory, indexFilePath, indexVersion, openIndexFile,
  removeEarlierFormats, textKey, updateIndex, type IndexDatabase, type StoredIndexOptions, type StoredIndexReport,
} from '@curatejs/core/internal';
import {
  chatTitleIndex, startChatRank, storedChatWords, CHAT_KEYWORD_SETTINGS, type ChatKeywordSettings, type ChatRankSession,
  type ChatTitleIndex, type StoredChatWords,
} from './chat-rank.js';
import { scrubChat } from './chat-scrub.js';
import { DEFAULT_MAX_QUESTION_TEXT, type MemoryCandidate } from '@curatejs/core';
import {
  historySource, SourceReadError, type CandidateReadContext, type CandidateReadRequest, type CandidateSource,
  type PickCascade,
} from '@curatejs/core';
import { chatSettings } from './defaults.js';
import { AGENT_CHAT_CASCADE } from './questions.js';

export type ChatProvider = 'claude-code' | 'codex';

export interface ChatOptions {
  /** Override the exported CHAT_KEYWORD_SETTINGS. */
  readonly keyword?: Partial<ChatKeywordSettings>;
  readonly id?: string;
  /** Defaults to both providers. */
  readonly providers?: readonly ChatProvider[];
  /** Folders to scan instead of each provider's default folder. */
  readonly paths?: readonly string[];
  /** Include messages at or after an ISO date or a duration before the
   * task date (for example, '14 days'); the task date is the read
   * request's `taskDate`, else its `asOf`, else now. Omitted means all
   * messages. */
  readonly since?: string;
  /** Paths this source alone refuses, joined onto the read request's
   *  `exclude` for its reads only: an excluded file or folder is never
   *  opened. */
  readonly exclude?: readonly string[];
  readonly includeTools?: boolean;
  /** Tightens the 700-character part size, as does the read request. */
  readonly maxQuestionText?: number;
  /** The stored index: one local file for this source, made on its
   *  first read and brought up to date at the start of each call. Every
   *  lane then reads the file instead of the transcripts. `false` reads
   *  the transcripts directly on every read. */
  readonly index?: StoredIndexOptions | false;
  /** The question set the decision step asks of this source's parts.
   *  Defaults to AGENT_CHAT_CASCADE. A model-scored set such as
   *  JUDGMENT_CHAT_CASCADE throws while its weights file is unfitted. */
  readonly questions?: PickCascade;
  /** The decision-score bar for this source's parts: a part keeps when
   *  its combined score reaches it. Defaults to the selected set's
   *  fitted bar when it carries one, else 0.0146. */
  readonly bar?: number;
}

type Json = Record<string, unknown>;
type MessageRole = NonNullable<MemoryCandidate['chat']>['role'];
type Author = NonNullable<NonNullable<MemoryCandidate['chat']>['author']>;
interface Written { author: Author; authorName?: string }
interface Part extends Written { role: MessageRole; text: string }
interface Decoded { sessionId?: string; date?: string; parts: Part[] }
interface ProviderReader {
  readonly folder: string;
  /** `session` carries what one record says about the whole file to
   *  the records after it. */
  decode(record: Json, includeTools: boolean, session: Json): Decoded;
}

/** One message part as it streams out of a transcript: enough to build
 *  the candidate's identity and title, but nothing from other files. */
interface RawPart {
  readonly provider: ChatProvider;
  readonly root: string;
  readonly file: string;
  readonly line: number;
  readonly block: number;
  readonly piece: number;
  readonly sessionId: string;
  readonly role: MessageRole;
  readonly author: Author;
  readonly authorName?: string;
  readonly date: number;
  readonly text: string;
}

interface WalkContext {
  readonly size: number;
  readonly since: number;
  /** The latest date read: the task date when the request gives one,
   *  narrowed to the task's period on a period read. */
  readonly until: number;
  readonly includeTools: boolean;
  readonly signal?: AbortSignal;
  /** Counts skipped symlinks and undated messages on the pass that
   *  carries it — the read's first pass, so repeats do not recount. */
  readonly countSkips?: { n: number };
}

function object(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : {};
}
function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function resultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((block) => string(object(block).text) ?? '').join('\n');
}
function toolText(value: unknown): string {
  if (typeof value === 'string') {
    // Scrub JSON argument values before serialization escapes line breaks
    // and quotes; escaped text can hide the boundaries of a credential.
    const text = value;
    try { value = JSON.parse(text); } catch { return scrubChat(text); }
  }
  return JSON.stringify(value, (_key, item: unknown) => typeof item === 'string' ? scrubChat(item) : item) ?? '';
}

const named = (author: Author, name: string | undefined): Written =>
  name === undefined ? { author } : { author, authorName: name };

/** Who wrote a Claude Code user text, read only from what the record
 *  marks; a record that marks nothing is 'unmarked'. */
function claudeAuthor(record: Json, origin: Json, text: string): Written {
  const crossSession = record.origin === undefined && text.startsWith('Another Claude session sent a message');
  const sender = origin.kind === 'peer' ? string(origin.name)
    : crossSession ? /<agent-message from="([^"]+)"/.exec(text)?.[1] : undefined;
  // An agent's own transcript has no human turns: every user text is an
  // agent's, named where the record names its sender.
  if (record.isSidechain === true) return named('agent', sender ?? /<teammate-message teammate_id="([^"]+)"/.exec(text)?.[1]);
  if (record.isCompactSummary === true) return { author: 'agent' };
  if (origin.kind === 'task-notification') return { author: 'tool' };
  if (record.isMeta === true) return { author: 'system' };
  if (origin.kind === 'human') return { author: 'person' };
  if (origin.kind === 'peer' || crossSession) return named('agent', sender);
  if (origin.kind === 'auto-continuation') return { author: 'system' };
  return { author: 'unmarked' };
}

/** Who wrote a Codex user text: instruction blocks are the system's;
 *  otherwise what started the session decides. */
function codexAuthor(source: unknown, text: string): Written {
  if (/^\s*(?:# AGENTS\.md instructions|<environment_context>|<user_instructions>)/.test(text)) return { author: 'system' };
  if (source === 'exec') return { author: 'agent' };
  const spawned = object(source).subagent;
  if (spawned !== undefined) return named('agent', string(object(object(spawned).thread_spawn).parent_thread_id));
  return { author: 'unmarked' };
}

const READERS: Record<ChatProvider, ProviderReader> = {
  'claude-code': {
    folder: join(homedir(), '.claude', 'projects'),
    decode(record, includeTools) {
      // A message typed while an agent works is saved as a queued
      // attachment; every other attachment stays unread.
      const attachment = object(record.attachment);
      const queued = record.type === 'attachment' && attachment.type === 'queued_command';
      const role = queued ? 'user' : record.type;
      const parts: Part[] = [];
      if (role === 'user' || role === 'assistant') {
        const origin = object(queued ? attachment.origin : record.origin);
        const said = (text: string) =>
          parts.push({ role, text, ...(role === 'user' ? claudeAuthor(record, origin, text) : { author: 'agent' as const }) });
        const content = !queued ? object(record.message).content : Array.isArray(attachment.prompt)
          ? attachment.prompt.map(object).filter((block) => block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text).join('\n')
          : attachment.prompt;
        if (typeof content === 'string') said(content);
        else if (Array.isArray(content)) for (const value of content) {
          const block = object(value);
          if (block.type === 'text' && typeof block.text === 'string') said(block.text);
          if (includeTools && block.type === 'tool_use') {
            parts.push({ role: 'tool-call', author: 'tool', text: `${string(block.name) ?? 'tool'}\n${toolText(block.input ?? {})}` });
          }
          if (includeTools && block.type === 'tool_result') {
            parts.push({ role: 'tool-result', author: 'tool', text: resultText(block.content) });
          }
        }
      }
      return { sessionId: string(record.sessionId), date: string(record.timestamp), parts };
    },
  },
  codex: {
    folder: join(homedir(), '.codex', 'sessions'),
    decode(record, includeTools, session) {
      const payload = object(record.payload);
      const parts: Part[] = [];
      if (record.type === 'session_meta') session.source = payload.source;
      if (record.type === 'response_item') {
        const role = payload.role;
        if (payload.type === 'message' && (role === 'user' || role === 'assistant') && Array.isArray(payload.content)) {
          for (const value of payload.content) {
            const block = object(value);
            if ((block.type === 'input_text' || block.type === 'output_text' || block.type === 'text')
              && typeof block.text === 'string') {
              parts.push({ role, text: block.text, ...(role === 'user' ? codexAuthor(session.source, block.text) : { author: 'agent' as const }) });
            }
          }
        }
        if (includeTools && (payload.type === 'function_call' || payload.type === 'custom_tool_call')) {
          parts.push({ role: 'tool-call', author: 'tool', text: `${string(payload.name) ?? 'tool'}\n${toolText(payload.arguments ?? payload.input ?? '')}` });
        }
        if (includeTools && (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output')) {
          parts.push({ role: 'tool-result', author: 'tool', text: resultText(payload.output) });
        }
      }
      // event_msg duplicates response_item text; never emit it twice.
      return {
        sessionId: record.type === 'session_meta' ? string(payload.id) : undefined,
        date: string(record.timestamp), parts,
      };
    },
  },
};

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer.`);
  return value;
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SourceReadError('cancelled', 'The read was cancelled.');
}
function excluded(path: string, root: string, entries: readonly string[]): boolean {
  const names = [path, relative(root, path).split(sep).join('/'), relative(process.cwd(), path).split(sep).join('/')];
  return entries.some((entry) => entry === '.' || names.some((name) => name === entry || name.startsWith(`${entry}/`)));
}

/** Cut at line ends; hard-cut a line that exceeds the budget. Joining
 * the parts reproduces the scrubbed message text exactly. */
function split(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let start = 0; start < text.length;) {
    const end = Math.min(start + size, text.length);
    const newline = text.lastIndexOf('\n', end - 1);
    const cut = end < text.length && newline > start ? newline + 1 : end;
    parts.push(text.slice(start, cut));
    start = cut;
  }
  return parts;
}

const partIdOf = (part: RawPart) =>
  `${part.provider}:${part.root}:${relative(part.root, part.file)}:${part.line}:${part.block}:${part.piece}`;
// The folder read and the file's path in it are each scrubbed whole, then
// joined: a value that looks like a secret is masked, and masking it never
// reaches the id's other fields or the part's place, which keep it its own.
const partId = (part: RawPart) =>
  `${part.provider}:${scrubChat(part.root)}:${scrubChat(relative(part.root, part.file))}:${part.line}:${part.block}:${part.piece}`;
const partTitle = (part: RawPart, zone: string) =>
  `${part.provider} ${part.sessionId} ${part.role} ${zonedIso(part.date, zone)}`;
const AUTHOR_TITLES: Record<Author, string> = { person: ' (the person)', agent: ' (agent)', tool: ' (tool)', system: ' (system)', unmarked: '' };
/** The title a candidate carries: the author follows the role. Ranks and
 *  phrase matches read `partTitle`, so the mark never changes them. */
const shownTitle = (part: RawPart, zone: string) =>
  `${part.provider} ${part.sessionId} ${part.role}${part.authorName === undefined ? AUTHOR_TITLES[part.author]
    : ` (${part.author} ${part.authorName})`} ${zonedIso(part.date, zone)}`;
const chatOf = (part: RawPart): NonNullable<MemoryCandidate['chat']> => ({
  provider: part.provider, sessionId: part.sessionId, role: part.role, author: part.author,
  ...(part.authorName === undefined ? {} : { authorName: part.authorName }),
});

/** What decoding carries from one transcript line to the next: the
 *  session id the latest record named, and what one record says about
 *  the whole file (a Codex session's source). */
interface DecodeState {
  sessionId: string;
  readonly session: Json;
}

/** A part as decoding yields it, before it knows its file. */
type LinePart = Omit<RawPart, 'provider' | 'root' | 'file'>;

/** The session id a transcript starts with, from its file name. */
const fileSessionId = (file: string) => basename(file, '.jsonl').replace(/^rollout-.*T\d{2}-\d{2}-\d{2}-/, '');

/** Decode transcript lines into scrubbed, split parts. `firstLine` is
 *  the zero-based line number of `lines[0]` in its file. Every dated
 *  part is yielded; `undated` is called for each record with text but
 *  no date. */
function* decodeLines(
  provider: ChatProvider, lines: readonly string[], firstLine: number, state: DecodeState,
  includeTools: boolean, size: number, signal: AbortSignal | undefined, undated: () => void,
): Generator<LinePart> {
  for (const [offset, line] of lines.entries()) {
    cancelled(signal);
    if (!line.trim()) continue;
    let record: Json;
    try { record = object(JSON.parse(line)); } catch {
      // JSON errors can contain the transcript text. Never copy them.
      throw new SourceReadError('failed', 'Invalid JSON in a chat transcript.');
    }
    const decoded = READERS[provider].decode(record, includeTools, state.session);
    state.sessionId = scrubChat(decoded.sessionId ?? state.sessionId);
    const date = Date.parse(decoded.date ?? '');
    if (!decoded.parts.length) continue;
    if (!Number.isFinite(date)) { undated(); continue; }
    for (const [block, part] of decoded.parts.entries()) {
      const text = scrubChat(part.text);
      if (!text.trim()) continue;
      for (const [piece, textPart] of split(text, size).entries()) {
        yield {
          line: firstLine + offset + 1, block: block + 1, piece: piece + 1,
          sessionId: state.sessionId, role: part.role, author: part.author,
          ...(part.authorName === undefined ? {} : { authorName: scrubChat(part.authorName) }),
          date, text: textPart,
        };
      }
    }
  }
}

/** The parts of one transcript, decoded and split but never kept. Each
 *  pass over the history reads the file again rather than holding the
 *  parts of every file at once. */
async function* fileParts(
  provider: ChatProvider, root: string, file: string, walk: WalkContext,
): AsyncGenerator<RawPart> {
  const raw = await readFile(file, { encoding: 'utf8', signal: walk.signal });
  const state: DecodeState = { sessionId: fileSessionId(file), session: {} };
  const undated = () => { if (walk.countSkips) walk.countSkips.n += 1; };
  for (const part of decodeLines(provider, raw.split(/\r?\n/), 0, state, walk.includeTools, walk.size, walk.signal, undated)) {
    if (part.date < walk.since || part.date > walk.until) continue;
    yield { provider, root, file, ...part };
  }
}

/** Every part under the resolved roots, one file at a time. The walk
 *  order — sorted directory entries, transcript line order — is the
 *  same on every pass, so a part's ordinal is stable across passes. */
async function* eachPart(
  walkable: readonly { provider: ChatProvider; root: string }[],
  exclusions: readonly string[], walk: WalkContext,
): AsyncGenerator<RawPart> {
  const visit = async function* (provider: ChatProvider, root: string, path: string): AsyncGenerator<RawPart> {
    cancelled(walk.signal);
    if (excluded(path, root, exclusions)) return;
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const file = join(path, entry.name);
      if (excluded(file, root, exclusions)) continue;
      if (entry.isSymbolicLink()) { if (walk.countSkips) walk.countSkips.n += 1; continue; }
      if (entry.isDirectory()) { yield* visit(provider, root, file); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      yield* fileParts(provider, root, file, walk);
    }
  };
  for (const { provider, root } of walkable) yield* visit(provider, root, root);
}

/** A part read from the stored index: a transcript part, its text's
 *  stored words, its row, and its vector key as stored (see `vectorKey`).
 *  Its text is empty on a pass that never reads text. */
type StoredPart = RawPart & {
  readonly words: StoredChatWords; readonly at: string; readonly transcript: number; readonly ordinal: number;
  readonly vec: string | null;
  /** Its scrubbed id as stored, when the stored id was made under the
   *  root this read walks; otherwise the read makes it. */
  readonly storedId?: string;
};

/** Whether a text has anything to embed; a part without uses its title. */
const embeddable = (text: string) => /[^\s\p{Cf}]/u.test(text);

/** The vector key a part's row stores: the key of the text a meaning
 *  lane embeds for it when the part before it in the walk is the one
 *  before it in its transcript, as it is unless a date window cuts in.
 *  That text is the part before's text, a line end and its own, or its
 *  own alone for a transcript's first part. Null when either text is
 *  empty: the lane then embeds a title, which depends on the time zone. */
function vectorKey(text: string, before: string | undefined, ordinal: number): string | null {
  if (!embeddable(text)) return null;
  if (ordinal === 0) return textKey(text);
  return before !== undefined && embeddable(before) ? textKey(`${before}\n${text}`) : null;
}

/** What one call's meaning lanes share through the read context: each
 *  part's similarity over the call's query list, and the enumeration
 *  the scores align to. */
interface Lite {
  queries: readonly string[];
  similarities: number[][];
  ids: string[];
  /** Each part's row in the stored index, empty on a direct read. */
  refs: string[];
  partFile: number[];
  fileRanges: { provider: ChatProvider; root: string; file: string; start: number }[];
}

/** The keyword lanes' once-per-call enumeration: every in-window part's
 *  scrubbed id, index row, title and word total, in enumeration order,
 *  and the skips the first pass counted. */
interface ChatKeywordEnum {
  ids: string[];
  refs: string[];
  partFile: number[];
  fileRanges: { provider: ChatProvider; root: string; file: string; start: number }[];
  titles: string[];
  longs: number[];
  skips: number;
}

/** Internal to this package and not part of its public surface: the
 *  one-pass read's switch and a count of the reads it served. A test
 *  turns it off to get the per-lane path as its oracle. */
export const onePass = { on: true, served: 0 };

/** What one call knows about the whole stored history, read once and
 *  shared by every lane of the call: each in-window part as stored, and
 *  what every lane would otherwise work out from it again. It holds
 *  nothing a request's task sets. */
interface ChatCorpus {
  /** What decides which parts are in it. */
  readonly key: string;
  readonly parts: readonly StoredPart[];
  readonly ids: string[];
  readonly refs: string[];
  readonly partFile: number[];
  readonly fileRanges: { provider: ChatProvider; root: string; file: string; start: number }[];
  /** Each part's date as its titles and its candidate show it. */
  readonly iso: string[];
  readonly titles: string[];
  /** The titles' words indexed once, when a keyword lane first asks. */
  titleIndex?: ChatTitleIndex;
  /** The parts whose title holds each word `phraseCount` compares,
   *  indexed once, when a phrase lane first asks. */
  titlePhraseWords?: Map<string, number[]>;
  readonly longs: number[];
  /** Each part's place in id order; equal ids share a place. */
  readonly places: Uint32Array;
  /** The parts in id order, equal ids in walk order. */
  readonly byPlace: Uint32Array;
  /** Each part's index by its row in the stored index. */
  readonly indexOf: ReadonlyMap<string, number>;
  /** The index's `indexVersion` the parts were read at; unset when an
   *  update landed while they were read. */
  readonly version: number | undefined;
  /** Each word's postings as part indexes, read from the index once. */
  readonly postings: Map<string, { readonly index: number[]; readonly count: number[] }>;
  readonly skips: number;
  /** Each part's unit vector, once a meaning lane has embedded them with
   *  an embedder that keeps no store. */
  units?: Float64Array[];
}

/** A source's entry in a read context's shared space: the meaning
 *  lanes' held scores, the part ids scrubbed once for every lane that
 *  asks for them, and the keyword lanes' once-per-call enumeration. */
interface Shared {
  meaning?: Lite;
  ids?: Map<string, string>;
  keyword?: ChatKeywordEnum;
  corpus?: ChatCorpus;
}

/** One transcript the stored index holds. */
interface StoredTranscript {
  readonly file: string;
  /** Its row in the file. */
  readonly id: number;
  /** Records with text but no date, which the reader skips. */
  readonly undated: number;
  /** The root its parts' stored ids were made under: '' when an append
   *  under another root left ids of two roots in it. */
  readonly root: string;
}

/** A source's stored index after this call's update: per provider and
 *  root, the transcripts and symbolic links in the order the direct
 *  read walks them. Parts stay in the file until a lane reads them. */
interface ChatIndex {
  readonly path: string;
  readonly directory: string;
  readonly roots: ReadonlyMap<string, {
    readonly transcripts: readonly StoredTranscript[];
    readonly symlinks: readonly string[];
  }>;
  readonly report: StoredIndexReport;
}

const rootKey = (provider: ChatProvider, root: string) => `${provider}\0${root}`;

/** A transcript that grew is read from its indexed end only when its
 *  first and last indexed bytes, up to this many each, still hash the
 *  same. Any other change reads it again whole. */
const EDGE_CHECK = 1024;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Exclusion entries as the reader matches them: an absolute path
 *  through its real path, a relative one cleaned of `./` and trailing
 *  slashes. */
const resolveExclusions = (entries: readonly string[]) => Promise.all(entries.map(async (entry) =>
  entry.startsWith('/') ? await canonicalPath(entry) : entry.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') || '.'));

/** Every transcript file and symbolic link under a root, in the order
 *  the direct read walks them. */
async function walkTranscripts(
  root: string, exclusions: readonly string[], signal: AbortSignal | undefined,
): Promise<{ files: string[]; symlinks: string[] }> {
  const files: string[] = [];
  const symlinks: string[] = [];
  const visit = async (path: string): Promise<void> => {
    cancelled(signal);
    if (excluded(path, root, exclusions)) return;
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const file = join(path, entry.name);
      if (excluded(file, root, exclusions)) continue;
      if (entry.isSymbolicLink()) { symlinks.push(file); continue; }
      if (entry.isDirectory()) { await visit(file); continue; }
      if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(file);
    }
  };
  await visit(root);
  return { files, symlinks };
}

/** A stored transcript's row: where it sits inside its root, the bytes
 *  indexed and their line count, the hashes of their first and last
 *  bytes, whether they end a line, and the decoding state after them. */
interface TranscriptRow {
  readonly id: number;
  readonly provider: string;
  readonly root: number;
  /** The root's real path when the row was written, which its parts' ids name. */
  readonly root_path: string;
  readonly path: string;
  readonly size: number;
  readonly mtime: string;
  readonly lines: number;
  readonly head: string;
  readonly tail: string;
  readonly newline: number;
  readonly state: string;
  readonly undated: number;
  readonly parts: number;
}

/** Reads `length` bytes from `position`, or fewer at the file's end. */
async function readRange(file: string, position: number, length: number): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}

const CHAT_TABLES = `CREATE TABLE IF NOT EXISTS transcripts (id INTEGER PRIMARY KEY, provider TEXT NOT NULL,
    root INTEGER NOT NULL, root_path TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, mtime TEXT NOT NULL,
    lines INTEGER NOT NULL, head TEXT NOT NULL, tail TEXT NOT NULL, newline INTEGER NOT NULL, state TEXT NOT NULL, undated INTEGER NOT NULL,
    parts INTEGER NOT NULL, UNIQUE (provider, root, path));
  CREATE TABLE IF NOT EXISTS parts (transcript INTEGER NOT NULL, ordinal INTEGER NOT NULL, line INTEGER NOT NULL,
    block INTEGER NOT NULL, piece INTEGER NOT NULL, session TEXT NOT NULL, role TEXT NOT NULL, author TEXT NOT NULL,
    author_name TEXT, date INTEGER NOT NULL, text TEXT NOT NULL, long INTEGER NOT NULL, stems TEXT NOT NULL,
    short TEXT NOT NULL, vec TEXT, pid TEXT NOT NULL, PRIMARY KEY (transcript, ordinal)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS postings (term TEXT NOT NULL, transcript INTEGER NOT NULL,
    ordinal INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (term, transcript, ordinal)) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS postingsTranscript ON postings (transcript);
  CREATE VIRTUAL TABLE IF NOT EXISTS phrases USING fts5(words, ${PHRASE_INDEX});`;

/** A part's row in the phrase index: its transcript's row in the high
 *  bits and its place in the transcript in the low 32. */
const PHRASE_ROW = 2 ** 32;

/** Bring a source's stored index up to date, in one write transaction.
 *  A transcript with its stored size and modification time is kept. One
 *  that grew, whose indexed bytes end a line and still start and end with
 *  the stored bytes, has only its new bytes read. Any other change reads
 *  it again whole; a new transcript is read; a removed one's parts are
 *  deleted. A transcript the request excludes is never opened, and its
 *  stored parts stay for the calls that do read it. Each transcript's
 *  parts are written as they decode, so the update holds one file at a
 *  time. */
async function syncChatIndex(
  path: string, directory: string,
  roots: readonly { readonly provider: ChatProvider; readonly slot: number; readonly root: string }[],
  own: readonly string[], requested: readonly string[], includeTools: boolean, size: number,
  keyword: Partial<ChatKeywordSettings> | undefined, signal: AbortSignal | undefined,
  walk: (root: string, exclusions: readonly string[]) => Promise<{ files: string[]; symlinks: string[] }>,
): Promise<ChatIndex> {
  const database = await openIndexFile(path, directory);
  try {
    return await updateIndex(path, database, async () => {
      const started = performance.now();
      database.exec(CHAT_TABLES);
      const rows = new Map<string, TranscriptRow>((database.prepare('SELECT * FROM transcripts').all() as unknown as TranscriptRow[])
        .map((row) => [`${row.provider}\0${row.root}\0${row.path}`, row]));
      const deletePartRows = database.prepare('DELETE FROM parts WHERE transcript = ?');
      const deletePhrases = database.prepare('DELETE FROM phrases WHERE rowid >= ? AND rowid < ?');
      const deleteParts = { run(transcript: number) {
        deletePartRows.run(transcript);
        deletePhrases.run(transcript * PHRASE_ROW, (transcript + 1) * PHRASE_ROW);
      } };
      const insertPhrase = database.prepare('INSERT INTO phrases (rowid, words) VALUES (?, ?)');
      const deletePostings = database.prepare('DELETE FROM postings WHERE transcript = ?');
      const insertPart = database.prepare(`INSERT INTO parts (transcript, ordinal, line, block, piece, session, role,
        author, author_name, date, text, long, stems, short, vec, pid)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const textAt = database.prepare('SELECT text FROM parts WHERE transcript = ? AND ordinal = ?');
      const insertPosting = database.prepare('INSERT OR IGNORE INTO postings (term, transcript, ordinal, count) VALUES (?, ?, ?, ?)');
      // A part's posting list is its stored words with their counts:
      // each stem under its own term, each short word under a term no
      // stem can take.
      const insertPostings = (transcript: number, ordinal: number, stems: string, short: string) => {
        for (const [term, count] of bagEntries(stems)) insertPosting.run(term, transcript, ordinal, count);
        for (const [word, count] of bagEntries(short)) insertPosting.run(`!${word}`, transcript, ordinal, count);
      };
      const insertRow = database.prepare(`INSERT INTO transcripts (provider, root, root_path, path, size, mtime, lines,
        head, tail, newline, state, undated, parts) VALUES (?, ?, ?, ?, ?, ?, ?, '', '', 0, '', 0, 0)`);
      const updateRow = database.prepare(`UPDATE transcripts SET root_path = ?, size = ?, mtime = ?, lines = ?, head = ?,
        tail = ?, newline = ?, state = ?, undated = ?, parts = ? WHERE id = ?`);
      let added = 0;
      let removed = 0;
      const seen = new Set<string>();
      const loaded = new Map<string, { transcripts: StoredTranscript[]; symlinks: string[] }>();
      for (const { provider, slot, root } of roots) {
        const { files, symlinks } = await walk(root, [...own, ...requested]);
        const transcripts: StoredTranscript[] = [];
        for (const file of files) {
          const rel = relative(root, file).split(sep).join('/');
          const key = `${provider}\0${slot}\0${rel}`;
          seen.add(key);
          let row = rows.get(key);
          const info = await stat(file, { bigint: true });
          const mtime = String(info.mtimeNs);
          const length = Number(info.size);
          if (row !== undefined && row.size === length && row.mtime === mtime) {
            transcripts.push({ file, id: row.id, undated: row.undated, root: row.root_path });
            continue;
          }
          // `bytes` are the bytes to decode; `window` holds them and, on
          // an append, the indexed bytes just before them.
          let bytes: Buffer | undefined;
          let window: Buffer | undefined;
          let firstLine = 0;
          let start = 0;
          let state: DecodeState = { sessionId: fileSessionId(file), session: {} };
          let undated = 0;
          let appending = false;
          if (row !== undefined && row.newline === 1 && length > row.size) {
            const edge = Math.min(EDGE_CHECK, row.size);
            const [head, grown] = await Promise.all([
              readRange(file, 0, edge), readRange(file, row.size - edge, length - row.size + edge)]);
            if (grown.length > edge && digest(head) === row.head && digest(grown.subarray(0, edge)) === row.tail) {
              bytes = grown.subarray(edge);
              window = grown;
              firstLine = row.lines;
              start = row.parts;
              state = JSON.parse(row.state) as DecodeState;
              undated = row.undated;
              appending = true;
            }
          }
          if (bytes === undefined) {
            bytes = window = await readFile(file, { signal });
            if (row !== undefined) {
              deleteParts.run(row.id);
              deletePostings.run(row.id);
              removed += row.parts;
            }
          }
          const id = row?.id ?? Number(insertRow.run(provider, slot, root, rel, 0, '', 0).lastInsertRowid);
          const text = bytes.toString('utf8');
          const lines = text.split(/\r?\n/);
          let ordinal = start;
          // An append continues from the last part the file already holds.
          let before = start === 0 ? undefined : (textAt.get(id, start - 1) as { text: string } | undefined)?.text;
          for (const part of decodeLines(provider, lines, firstLine, state, includeTools, size, signal, () => { undated += 1; })) {
            const words = storedChatWords(part.text, keyword);
            insertPart.run(id, ordinal, part.line, part.block, part.piece, part.sessionId, part.role, part.author,
              part.authorName ?? null, part.date, part.text, words.long, words.stems, words.short,
              vectorKey(part.text, before, ordinal), partId({ provider, root, file, ...part }));
            insertPostings(id, ordinal, words.stems, words.short);
            insertPhrase.run(id * PHRASE_ROW + ordinal, phraseWords(part.text));
            before = part.text;
            ordinal += 1;
          }
          added += ordinal - start;
          // The stored size counts only the bytes read: a file that grew
          // while it was read is read on from there next call.
          // Parts appended under another root leave ids of two roots.
          const idsRoot = !appending || row!.root_path === root ? root : '';
          updateRow.run(idsRoot, appending ? row!.size + bytes.length : bytes.length, mtime, firstLine + lines.length - 1,
            appending ? row!.head : digest(bytes.subarray(0, Math.min(EDGE_CHECK, bytes.length))),
            digest(window!.subarray(Math.max(0, window!.length - EDGE_CHECK))), text.endsWith('\n') ? 1 : 0,
            JSON.stringify(state), undated, ordinal, id);
          transcripts.push({ file, id, undated, root: idsRoot });
        }
        loaded.set(rootKey(provider, root), { transcripts, symlinks });
      }
      // A transcript no walk met is gone, unless this request's own
      // exclusions hid it or its root was not walked this call.
      const walked = new Map(roots.map(({ provider, slot, root }) => [`${provider}\0${slot}`, root]));
      for (const [key, row] of rows) {
        if (seen.has(key)) continue;
        const root = walked.get(`${row.provider}\0${row.root}`);
        if (root === undefined || excluded(join(root, row.path), root, requested)) continue;
        deleteParts.run(row.id);
        deletePostings.run(row.id);
        database.prepare('DELETE FROM transcripts WHERE id = ?').run(row.id);
        removed += row.parts;
      }
      // Each transcript row counts its own parts, so the file's total is a
      // sum over transcripts, never a walk over every part.
      const total = (database.prepare('SELECT COALESCE(SUM(parts), 0) AS n FROM transcripts').get() as { n: number }).n;
      return {
        path, directory, roots: loaded,
        report: { parts: total, added, removed, rebuilt: false, ms: Math.round(performance.now() - started) },
      };
    });
  } finally {
    database.close();
  }
}

/** One stored transcript's parts, in file order. The rows of one
 *  transcript are read at once, as the direct read holds one file. */
function* storedParts(
  database: IndexDatabase, provider: ChatProvider, root: string, transcript: StoredTranscript, withText: boolean,
  light = false,
): Generator<StoredPart> {
  const rows = database.prepare(`SELECT ordinal, line, block, piece, session, role,
    ${light ? "'unmarked' AS author, NULL AS author_name" : 'author, author_name'}, date,
    ${withText ? 'text' : "'' AS text"}, long,
    ${light ? "'' AS stems, '' AS short, NULL AS vec" : 'stems, short, vec'}, pid FROM parts WHERE transcript = ? ORDER BY ordinal`)
    .all(transcript.id) as Record<string, unknown>[];
  for (const row of rows) yield storedPart(provider, root, transcript, row);
}

function storedPart(provider: ChatProvider, root: string, transcript: StoredTranscript, row: Record<string, unknown>): StoredPart {
  return {
    provider, root, file: transcript.file,
    at: `${transcript.id}:${row.ordinal as number}`, transcript: transcript.id, ordinal: row.ordinal as number,
    vec: (row.vec as string | null | undefined) ?? null,
    ...(transcript.root === root ? { storedId: row.pid as string } : {}),
    line: row.line as number, block: row.block as number, piece: row.piece as number,
    sessionId: row.session as string, role: row.role as MessageRole, author: row.author as Author,
    ...(row.author_name === null ? {} : { authorName: row.author_name as string }),
    date: row.date as number, text: row.text as string,
    words: { long: row.long as number, stems: row.stems as string, short: row.short as string },
  };
}

/** The named rows of one stored transcript, with their text, found by
 *  the table's own key: a lane that keeps a few parts of a long
 *  transcript reads those rows and no others. */
function storedRows(
  database: IndexDatabase, provider: ChatProvider, root: string, transcript: StoredTranscript, ordinals: readonly number[],
): StoredPart[] {
  const rows = database.prepare(`SELECT ordinal, line, block, piece, session, role, author, author_name, date, text,
    long, stems, short, vec, pid FROM parts WHERE transcript = ? AND ordinal IN (SELECT value FROM json_each(?)) ORDER BY ordinal`)
    .all(transcript.id, JSON.stringify(ordinals)) as Record<string, unknown>[];
  return rows.map((row) => storedPart(provider, root, transcript, row));
}

/** Local JSONL transcripts. Each provider decodes its own message format;
 * text is scrubbed before it is split, scored or returned. A keyword
 * read streams the history: one pass for the corpus statistics, one to
 * score, and one that reads back only the parts the read keeps — the
 * lane's score-curve cut when `wholeLanes` is off, every scored part
 * when it is on. A cut read where nothing scores above zero matched
 * nothing: it keeps no parts at all, so it never holds a large
 * history's bodies. Every other cut read holds only the parts it
 * keeps, so memory stays flat as the history grows. */
export function chat(options: ChatOptions = {}): CandidateSource {
  const providers = [...new Set(options.providers ?? ['claude-code', 'codex'] as const)];
  if (!providers.length || providers.some((provider) => !Object.hasOwn(READERS, provider))) {
    throw new TypeError('providers must contain claude-code or codex.');
  }
  const roots = new Map(providers.map((provider) => [provider, [...new Set((options.paths ?? [READERS[provider].folder]).map((path) => resolve(path)))]]));
  if (options.paths?.length === 0 || options.paths?.some((path) => !path.trim())) throw new TypeError('paths must contain directory paths.');
  const budget = positive(options.maxQuestionText ?? DEFAULT_MAX_QUESTION_TEXT, 'maxQuestionText');
  sinceCutoff(options.since, Date.now());
  const exclude = options.exclude?.map((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '') throw new TypeError('exclude must contain non-empty strings.');
    return entry;
  });
  const id = scrubChat(options.id ?? `chat:${providers.map((provider) => `${provider}:${roots.get(provider)!.join(',')}`).join(';')}`);
  checkIndexOption(options.index);
  const includeTools = options.includeTools === true;
  // One update per call: every read of one pick shares its read
  // context, so the index is brought up to date on the first read and
  // reused by every later lane. A read with no context updates alone.
  const calls = new WeakMap<object, Map<string, Promise<ChatIndex>>>();
  // One walk of each root per call: the updates at every part size of
  // one read context share it. A read with no context walks alone.
  const walks = new WeakMap<object, Map<string, Promise<{ files: string[]; symlinks: string[] }>>>();
  const loadIndex = async (
    directory: string, size: number, requested: readonly string[], context: CandidateReadContext | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ChatIndex> => {
    const own = await resolveExclusions(exclude ?? []);
    const found: { provider: ChatProvider; slot: number; root: string }[] = [];
    for (const provider of providers) for (const [slot, folder] of roots.get(provider)!.entries()) {
      if (excluded(folder, folder, own)) continue;
      let info;
      try { info = await lstat(folder); } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
        throw error;
      }
      if (info.isSymbolicLink() || !info.isDirectory()) continue;
      found.push({ provider, slot, root: await realpath(folder) });
    }
    // The settings that decide which parts exist, or how their words are
    // stored, name the file.
    const key = { includeTools, size, exclude: exclude ?? [], stem: { ...CHAT_KEYWORD_SETTINGS, ...options.keyword }.stem };
    const path = indexFilePath(directory, id, key);
    const walk = (root: string, exclusions: readonly string[]) => {
      if (context === undefined) return walkTranscripts(root, exclusions, signal);
      let byRoot = walks.get(context);
      if (byRoot === undefined) walks.set(context, byRoot = new Map());
      const key = JSON.stringify([root, exclusions]);
      let walking = byRoot.get(key);
      if (walking === undefined) byRoot.set(key, walking = walkTranscripts(root, exclusions, signal));
      return walking;
    };
    const index = await syncChatIndex(path, directory, found, own, requested, includeTools, size, options.keyword, signal, walk);
    if (context?.removed !== undefined) context.removed.push(...await removeEarlierFormats(directory, id, key));
    return index;
  };
  const storedIndex = async (
    size: number, requestExclude: readonly string[], context: CandidateReadContext | undefined, signal: AbortSignal | undefined,
  ) => {
    const directory = indexDirectory(options.index);
    if (directory === undefined) return undefined;
    const requested = await resolveExclusions(requestExclude);
    if (context === undefined) return loadIndex(directory, size, requested, undefined, signal);
    let byRead = calls.get(context);
    if (byRead === undefined) calls.set(context, byRead = new Map());
    const key = JSON.stringify([size, requested]);
    let loading = byRead.get(key);
    if (loading === undefined) byRead.set(key, loading = loadIndex(directory, size, requested, context, signal));
    return loading;
  };
  const reader: CandidateSource = {
    id, kind: 'chat', role: 'reference',
    ...(options.since === undefined ? {} : { since: options.since }),
    ...(exclude === undefined ? {} : { exclude }),
    async read(request: CandidateReadRequest, context?: CandidateReadContext) {
      cancelled(request.signal);
      const size = Math.min(DEFAULT_MAX_QUESTION_TEXT, budget, positive(request.maxQuestionText ?? DEFAULT_MAX_QUESTION_TEXT, 'maxQuestionText'));
      if (request.limit !== undefined) positive(request.limit, 'limit');
      if (request.revision !== undefined) return { status: 'absent', reason: 'chat-does-not-support-revisions' };
      const zone = timeZoneOf(request.timeZone);
      const moment = taskMoment(request.taskDate ?? request.asOf, zone);
      // A period read keeps only the parts dated inside the task's period.
      const period = request.taskPeriod;
      const since = Math.max(sinceCutoff(options.since, moment),
        period === undefined ? Number.NEGATIVE_INFINITY : Date.parse(period.from));
      const until = Math.min(request.taskDate === undefined ? Number.POSITIVE_INFINITY : moment,
        period === undefined ? Number.POSITIVE_INFINITY : Date.parse(period.to));
      const dated = (part: RawPart) => ({ value: zonedIso(part.date, zone), meaning: 'recorded' as const });
      const reasons: string[] = [];
      let folders = 0;
      const skips = { n: 0 };
      const walkable: { provider: ChatProvider; root: string }[] = [];
      // This read's own connection to the stored index, closed when it ends.
      let database: IndexDatabase | undefined;
      try {
        const exclusions = await Promise.all([...(exclude ?? []), ...(request.exclude ?? [])].map(async (entry) =>
          entry.startsWith('/') ? await canonicalPath(entry) : entry.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') || '.'));
        for (const provider of providers) for (const directory of roots.get(provider)!) {
          if (excluded(directory, directory, exclusions)) continue;
          let info;
          try { info = await lstat(directory); } catch (error) {
            if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
              reasons.push(`missing ${provider} folder`); continue;
            }
            throw error;
          }
          if (info.isSymbolicLink()) { skips.n += 1; continue; }
          if (!info.isDirectory()) { reasons.push(`missing ${provider} folder`); continue; }
          folders += 1;
          walkable.push({ provider, root: await realpath(directory) });
        }
        if (!folders && reasons.length) return { status: 'absent', reason: 'no-chat-folders' };
        const ctx: WalkContext = {
          size, since, until, includeTools,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        };
        let stored: ChatIndex | undefined;
        try {
          stored = await storedIndex(size, request.exclude ?? [], context, request.signal);
          if (stored !== undefined) database = await openIndexFile(stored.path, stored.directory);
        } catch (error) {
          if (error instanceof SourceReadError || request.signal?.aborted) throw error;
          throw new SourceReadError('failed', `Could not bring the stored index up to date: ${(error as Error).message}`);
        }
        const indexed = stored === undefined ? {} : { index: stored.report };
        // With the index, the walk and the transcripts come from the
        // file: the same parts in the same order, filtered by this read's
        // exclusions and dates exactly as the direct read filters them.
        const storedRoots = stored === undefined ? undefined : walkable.map(({ provider, root }) => {
          const group = stored.roots.get(rootKey(provider, root));
          return {
            provider, root,
            transcripts: (group?.transcripts ?? []).filter((transcript) => !excluded(transcript.file, root, exclusions)),
            symlinks: (group?.symlinks ?? []).filter((path) => !excluded(path, root, exclusions)).length,
          };
        });
        const inDates = (part: RawPart) => part.date >= since && part.date <= until;
        // Two providers can read one file, so a transcript is found by both.
        const byFile = new Map(storedRoots?.flatMap(({ provider, transcripts }) =>
          transcripts.map((transcript) => [`${provider}\0${transcript.file}`, transcript] as const)));
        /** Every part, counting skips on the read's first pass. A stored
         *  part's text is read only when `withText` asks for it. */
        const eachStored = function* (counting: boolean, withText: boolean, light: boolean): Generator<StoredPart> {
          for (const { provider, root, transcripts, symlinks } of storedRoots!) {
            if (counting) skips.n += symlinks;
            for (const transcript of transcripts) {
              cancelled(request.signal);
              if (counting) skips.n += transcript.undated;
              for (const part of storedParts(database!, provider, root, transcript, withText, light)) {
                if (inDates(part)) yield part;
              }
            }
          }
        };
        const each = (counting: boolean, withText: boolean, light = false): AsyncIterable<RawPart> | Iterable<RawPart> =>
          storedRoots === undefined
            ? eachPart(walkable, exclusions, counting ? { ...ctx, countSkips: skips } : ctx)
            : eachStored(counting, withText, light);
        /** One transcript's parts again, as the first pass met them. */
        const partsOf = (
          range: { provider: ChatProvider; root: string; file: string }, withText: boolean,
        ): AsyncIterable<RawPart> | Iterable<RawPart> => {
          if (storedRoots === undefined) return fileParts(range.provider, range.root, range.file, ctx);
          const transcript = byFile.get(`${range.provider}\0${range.file}`);
          if (transcript === undefined) return [];
          return (function* () {
            for (const part of storedParts(database!, range.provider, range.root, transcript, withText)) {
              if (inDates(part)) yield part;
            }
          })();
        };
        /** The parts a lane keeps, each with its place in the lane's
         *  enumeration. With the index, each is read by its own row;
         *  a direct read walks the transcript again, as before. */
        const keptParts = async function* (
          wanted: ReadonlyMap<number, ReadonlySet<number>>,
          fileRanges: readonly { provider: ChatProvider; root: string; file: string; start: number }[],
          refs: readonly string[],
        ): AsyncGenerator<readonly [number, RawPart]> {
          for (const [fileIndex, indexes] of wanted) {
            const range = fileRanges[fileIndex]!;
            const transcript = storedRoots === undefined ? undefined : byFile.get(`${range.provider}\0${range.file}`);
            if (storedRoots !== undefined) {
              if (transcript === undefined) continue;
              cancelled(request.signal);
              const indexOf = new Map([...indexes].map((index) => [refs[index]!, index] as const));
              const ordinals = [...indexOf.keys()].map((ref) => Number(ref.slice(ref.indexOf(':') + 1)));
              for (const part of storedRows(database!, range.provider, range.root, transcript, ordinals)) {
                // A transcript another call re-indexed mid-read can hold a
                // different part under this row, so the date is checked again.
                if (inDates(part)) yield [indexOf.get(part.at)!, part];
              }
              continue;
            }
            let local = range.start;
            for await (const part of partsOf(range, true)) {
              const index = local++;
              if (indexes.has(index)) yield [index, part];
            }
          }
        };
        const observe = (rank: ChatRankSession, part: RawPart) => 'words' in part
          ? rank.observeStored(partTitle(part, zone), (part as StoredPart).words)
          : rank.observe(`${partTitle(part, zone)} ${part.text}`);
        const score = (rank: ChatRankSession, part: RawPart) => 'words' in part
          ? rank.scoreStored(partTitle(part, zone), (part as StoredPart).words, { heading: '', name: '', front: '' })
          : rank.score(`${partTitle(part, zone)} ${part.text}`, { heading: '', name: '', front: '' });
        // The lanes of one call share the first meaning lane's scores
        // and the part ids each lane would otherwise scrub afresh.
        const box = context?.shared;
        let shared = box?.get(reader) as Shared | undefined;
        if (box !== undefined && shared === undefined) box.set(reader, shared = {});
        const idCache = shared === undefined ? undefined : (shared.ids ??= new Map());
        const idOf = (part: RawPart) => {
          const stored = (part as Partial<StoredPart>).storedId;
          if (stored !== undefined) return stored;
          if (idCache === undefined) return partId(part);
          const key = partIdOf(part);
          let value = idCache.get(key);
          if (value === undefined) idCache.set(key, value = partId(part));
          return value;
        };
        // One pass for the whole call: with the stored index and a shared
        // read context, every in-window part is read once, text and all,
        // and each lane of the call works from that. The walk does not
        // wait, so lanes started together still share one. A read with no
        // index or no shared context takes the per-lane path below, and
        // so does a read whose window, time zone or exclusions are not
        // the walk's own (a period read, for one).
        let corpus: ChatCorpus | undefined;
        if (onePass.on && shared !== undefined && storedRoots !== undefined) {
          const key = JSON.stringify([stored!.path, since, until, zone, exclusions]);
          if (shared.corpus === undefined) {
            const before = skips.n;
            const version = indexVersion(database!);
            const parts: StoredPart[] = [];
            const ids: string[] = [];
            const refs: string[] = [];
            const partFile: number[] = [];
            const fileRanges: ChatCorpus['fileRanges'] = [];
            const iso: string[] = [];
            const titles: string[] = [];
            const longs: number[] = [];
            for (const part of eachStored(true, true, false)) {
              const last = fileRanges.at(-1);
              if (last === undefined || last.file !== part.file) {
                fileRanges.push({ provider: part.provider, root: part.root, file: part.file, start: ids.length });
              }
              partFile.push(fileRanges.length - 1);
              parts.push(part);
              ids.push(idOf(part));
              refs.push(part.at);
              const date = zonedIso(part.date, zone);
              const title = `${part.provider} ${part.sessionId} ${part.role} ${date}`;
              iso.push(date);
              titles.push(title);
              longs.push(part.words.long);
            }
            // Ties in a lane order by id; each part's place in id order
            // stands in for the comparison.
            const byId = ids.map((_, index) => index).sort((a, b) => ids[a]!.localeCompare(ids[b]!));
            const places = new Uint32Array(ids.length);
            for (let place = 1; place < byId.length; place += 1) {
              places[byId[place]!] = ids[byId[place]!]!.localeCompare(ids[byId[place - 1]!]!) === 0
                ? places[byId[place - 1]!]! : place;
            }
            shared.corpus = {
              key, parts, ids, refs, partFile, fileRanges, iso, titles, longs, places, byPlace: Uint32Array.from(byId),
              indexOf: new Map(refs.map((ref, index) => [ref, index] as const)), postings: new Map(),
              version: indexVersion(database!) === version ? version : undefined,
              skips: skips.n - before,
            };
            // Each lane counts the skips where its own walk would have.
            skips.n = before;
          }
          if (shared.corpus.key === key) {
            corpus = shared.corpus;
            onePass.served += 1;
          }
        }
        /** The parts of the call's one walk whose text or title can hold
         *  `phrase`, in walk order: the phrase index names the texts that
         *  hold it, and the titles holding its first word are added. Each
         *  is counted again with `phraseCount`, so the counts are exact.
         *  Once another update has changed the index, it no longer holds
         *  the texts the walk holds, and every part of the walk is named. */
        const phraseCandidates = (phrase: string): number[] => {
          const query = phraseQuery(phrase);
          if (query === undefined) return [];
          const found = new Set<number>();
          for (const row of database!.prepare('SELECT rowid AS id FROM phrases WHERE phrases MATCH ?').iterate(query) as Iterable<{ id: number }>) {
            const index = corpus!.indexOf.get(`${Math.floor(row.id / PHRASE_ROW)}:${row.id % PHRASE_ROW}`);
            if (index !== undefined) found.add(index);
          }
          // The rows of an index another update changed since the walk do
          // not describe the texts it holds.
          if (indexVersion(database!) !== corpus!.version) return corpus!.parts.map((_, index) => index);
          if (corpus!.titlePhraseWords === undefined) {
            const titles = new Map<string, number[]>();
            corpus!.titles.forEach((title, index) => {
              for (const word of new Set(phraseWords(title).split(' '))) {
                const list = titles.get(word);
                if (list === undefined) titles.set(word, [index]);
                else list.push(index);
              }
            });
            corpus!.titlePhraseWords = titles;
          }
          for (const index of corpus!.titlePhraseWords.get(phraseWords(phrase).split(' ')[0]!) ?? []) found.add(index);
          return [...found].sort((left, right) => left - right);
        };
        /** A part of the call's one walk as a lane hands it on. */
        const held = (index: number, extra: Pick<MemoryCandidate, 'signals' | 'laneScore' | 'pastLaneCut'>): MemoryCandidate => {
          const part = corpus!.parts[index]!;
          return {
            sourceId: id, role: 'reference',
            id: corpus!.ids[index]!,
            title: `${part.provider} ${part.sessionId} ${part.role}${part.authorName === undefined ? AUTHOR_TITLES[part.author]
              : ` (${part.author} ${part.authorName})`} ${corpus!.iso[index]!}`,
            text: part.text,
            contentRef: `${part.provider}:${part.sessionId}:${part.line}:${part.block}:${part.piece}`,
            chat: chatOf(part),
            date: { value: corpus!.iso[index]!, meaning: 'recorded' as const },
            ...extra,
          };
        };

        // A meaning lane embeds each part in bounded batches and keeps
        // the parts the similarity curve keeps: the corpus's text is
        // never held, and no keyword statistics pass is needed. The
        // first meaning lane of a call scores every part against the
        // call's whole query list at once, and the lanes after it read
        // the held scores; a read outside a shared context scores its
        // own query alone, as before.
        if (request.meaningLane !== undefined) {
          const embed = request.meaningLane.embed;
          const queries = request.meaningQueries ?? [request.task];
          // Scores a per-lane read of this call left behind are not the
          // walk's: this lane then reads them as the per-lane path does.
          if (corpus !== undefined && shared!.meaning !== undefined && shared!.meaning.ids !== corpus.ids) {
            corpus = undefined;
            onePass.served -= 1;
          }
          const compute = async (list: readonly string[]): Promise<Lite> => {
            const queryVectors = (await embed(list, request.signal)).map((vector) => normalized(vector));
            const lite: Lite = corpus === undefined
              ? { queries: list, similarities: [], ids: [], refs: [], partFile: [], fileRanges: [] }
              : { queries: list, similarities: [], ids: corpus.ids, refs: corpus.refs, partFile: corpus.partFile, fileRanges: corpus.fileRanges };
            let pending: string[] = [];
            let previous: { file: string; text: string } | undefined;
            const flush = async () => {
              if (pending.length === 0) return;
              const vectors = await embed(pending, request.signal);
              if (vectors.length !== pending.length) throw new TypeError('embed must return one vector per input text.');
              for (const vector of vectors) {
                const unit = normalized(vector, queryVectors[0]!.length);
                lite.similarities.push(queryVectors.map((query) => similarity(unit, query)));
              }
              pending = [];
            };
            if (corpus !== undefined) {
              skips.n += corpus.skips;
              const { parts } = corpus;
              // A store hands its vectors out again by key, so only an
              // embedder with no store has each part's unit vector kept
              // for the call, for a later query list to score.
              const stored = 'eachVector' in embed;
              if (!stored && corpus.units !== undefined
                && (corpus.units[0]?.length ?? queryVectors[0]!.length) === queryVectors[0]!.length) {
                for (const unit of corpus.units) lite.similarities.push(queryVectors.map((query) => similarity(unit, query)));
                return lite;
              }
              const units: Float64Array[] | undefined = stored ? undefined : [];
              // A part embeds with the part before it in the walk when
              // both are in one file.
              const own = (index: number) => embeddable(parts[index]!.text) ? parts[index]!.text : corpus!.titles[index]!;
              const follows = (index: number) => index > 0 && parts[index - 1]!.file === parts[index]!.file;
              const text = (index: number) => follows(index) ? `${own(index - 1)}\n${own(index)}` : own(index);
              // The stored key holds when the part before it in the walk
              // is the one before it in its transcript.
              const key = (index: number) => {
                const part = parts[index]!;
                const before = follows(index) ? parts[index - 1]! : undefined;
                const holds = before === undefined ? part.ordinal === 0
                  : before.transcript === part.transcript && before.ordinal === part.ordinal - 1;
                return holds && part.vec !== null ? part.vec : textKey(text(index));
              };
              lite.similarities = Array.from({ length: parts.length });
              await eachPartVector(embed, parts.length, key, text, (index, vector) => {
                const unit = normalized(vector, queryVectors[0]!.length);
                if (units !== undefined) units[index] = unit;
                lite.similarities[index] = queryVectors.map((query) => similarity(unit, query));
              }, request.signal);
              corpus.units = units;
              return lite;
            }
            for await (const part of each(true, true)) {
              const last = lite.fileRanges.at(-1);
              if (last === undefined || last.file !== part.file) {
                lite.fileRanges.push({ provider: part.provider, root: part.root, file: part.file, start: lite.ids.length });
              }
              lite.partFile.push(lite.fileRanges.length - 1);
              lite.ids.push(idOf(part));
              if ('at' in part) lite.refs.push((part as StoredPart).at);
              const text = /[^\s\p{Cf}]/u.test(part.text) ? part.text : partTitle(part, zone);
              pending.push(previous?.file === part.file ? `${previous.text}\n${text}` : text);
              previous = { file: part.file, text };
              if (pending.length === 32) await flush();
            }
            await flush();
            return lite;
          };
          let lite = shared?.meaning;
          if (lite === undefined || lite.queries.length !== queries.length
            || lite.queries.some((query, index) => query !== queries[index])) {
            lite = await compute(queries);
            if (shared !== undefined) shared.meaning = lite;
          }
          let at = lite.queries.indexOf(request.task);
          if (at === -1) { lite = await compute([request.task]); at = 0; }
          const similarities = lite.similarities.map((row) => row[at]!);
          const { ids, refs, partFile, fileRanges } = lite;
          const places = corpus?.places;
          const order = ids.map((_, index) => index)
            .sort(places === undefined
              ? (a, b) => (similarities[b] ?? 0) - (similarities[a] ?? 0) || ids[a]!.localeCompare(ids[b]!)
              : (a, b) => (similarities[b] ?? 0) - (similarities[a] ?? 0) || places[a]! - places[b]!);
          const cut = request.wholeLanes === false;
          // With `wholeLanes` on the read keeps every part and marks each
          // one the cut would have dropped.
          const mark = request.wholeLanes === true;
          const bend = cut || mark ? laneBend(order.map((index) => similarities[index]!)) : undefined;
          // A cut lane where nothing scored above zero matched nothing:
          // it keeps no parts rather than read back every body.
          const matched = order.some((index) => similarities[index]! > 0);
          const passes = (index: number) => bend === undefined ? matched : similarities[index]! > bend;
          const kept = cut ? order.filter(passes) : order;
          // `limit` carries the caller's `nearest` cap: it slices the
          // kept set after the curve, not the enumeration before it.
          const limited = request.limit === undefined ? kept : kept.slice(0, request.limit);
          // The lane reports its whole scored list as ids and scores in
          // `meaningScores`; `candidates` still holds every kept part —
          // under `wholeLanes` that is the whole list, with the parts a
          // cut would drop marked. A caller that uses whole candidates
          // only inside the bend gets those alone, so the marked parts'
          // text is never read back.
          const bodies = mark && request.keptBodiesOnly === true ? limited.filter(passes) : limited;
          const wanted = new Map<number, Set<number>>();
          for (const index of bodies) {
            const file = partFile[index]!;
            const bucket = wanted.get(file);
            if (bucket === undefined) wanted.set(file, new Set([index]));
            else bucket.add(index);
          }
          const byIndex = new Map<number, MemoryCandidate>();
          for await (const [index, part] of corpus === undefined ? keptParts(wanted, fileRanges, refs) : []) {
            byIndex.set(index, {
              sourceId: id, role: 'reference',
              id: ids[index]!, title: shownTitle(part, zone), text: part.text,
              contentRef: `${part.provider}:${part.sessionId}:${part.line}:${part.block}:${part.piece}`,
              chat: chatOf(part),
              date: dated(part),
              signals: { similarity: similarities[index]! }, laneScore: similarities[index]!,
              ...(mark && !passes(index) ? { pastLaneCut: true as const } : {}),
            });
          }
          const candidates = corpus !== undefined
            ? bodies.map((index) => held(index, {
              signals: { similarity: similarities[index]! }, laneScore: similarities[index]!,
              ...(mark && !passes(index) ? { pastLaneCut: true as const } : {}),
            }))
            : bodies.map((index) => byIndex.get(index))
              .filter((candidate): candidate is MemoryCandidate => candidate !== undefined);
          if (skips.n) reasons.push(`skipped ${skips.n} symbolic links or undated messages`);
          if (limited.length < order.length) {
            reasons.push(`the limit kept ${limited.length} of ${order.length} candidates`);
          }
          return {
            status: 'read' as const, candidates, meaningLane: true, ...indexed,
            meaningScores: (mark ? order : limited).map((index) => ({
              id: ids[index]!, similarity: similarities[index]!,
              ...(mark && !passes(index) ? { pastLaneCut: true as const } : {}),
            })),
            complete: reasons.length === 0,
            ...(reasons.length ? { partial: reasons.join('; ') } : {}),
            matched: ids.length,
            ...(cut ? { laneCutApplied: true } : {}),
          };
        }

        // A kind lane matches its exact phrase like a phrase lane, then
        // ranks the matches by the task's own keyword score — never by
        // how often the phrase occurs, so a direction said once survives
        // a phrase everyone says. The corpus is still observed so the
        // topic's statistics cover it all; only the matches are scored.
        if (request.phraseLane === true && request.topic !== undefined) {
          const rank = startChatRank([request.topic, ...(request.paths ?? [])].join(' '), options.keyword);
          const matchOf = new Map<number, number>();
          const ids: string[] = corpus?.ids ?? [];
          const refs: string[] = corpus?.refs ?? [];
          const partFile: number[] = corpus?.partFile ?? [];
          const fileRanges: { provider: ChatProvider; root: string; file: string; start: number }[] = corpus?.fileRanges ?? [];
          if (corpus !== undefined) {
            skips.n += corpus.skips;
            for (const [index, part] of corpus.parts.entries()) rank.observeStored(corpus.titles[index]!, part.words);
            for (const index of phraseCandidates(request.task)) {
              const part = corpus.parts[index]!;
              const count = phraseCount(part.text, request.task) + phraseCount(corpus.titles[index]!, request.task);
              if (count > 0 && (request.speakerOnly !== true || part.role === 'user')) matchOf.set(index, count);
            }
          }
          for await (const part of corpus === undefined ? each(true, true) : []) {
            const last = fileRanges.at(-1);
            if (last === undefined || last.file !== part.file) {
              fileRanges.push({ provider: part.provider, root: part.root, file: part.file, start: ids.length });
            }
            partFile.push(fileRanges.length - 1);
            ids.push(idOf(part));
            if ('at' in part) refs.push((part as StoredPart).at);
            observe(rank, part);
            const count = phraseCount(part.text, request.task) + phraseCount(partTitle(part, zone), request.task);
            if (count > 0 && (request.speakerOnly !== true || part.role === 'user')) {
              matchOf.set(ids.length - 1, count);
            }
          }
          // Second pass: score the matched parts against the topic. Only
          // files holding a match are read again; the parts it keeps
          // align with the order `matchOf` recorded them.
          const matchedIndexes: number[] = [];
          const matchedIds: string[] = [];
          const filesWithMatches = new Set([...matchOf.keys()].map((index) => partFile[index]!));
          if (corpus !== undefined) {
            // The matches score in the order the walk met them.
            for (const index of matchOf.keys()) {
              rank.scoreStored(corpus.titles[index]!, corpus.parts[index]!.words, { heading: '', name: '', front: '' });
              matchedIndexes.push(index);
              matchedIds.push(ids[index]!);
            }
          }
          for (const fileIndex of corpus === undefined ? fileRanges.keys() : []) {
            if (!filesWithMatches.has(fileIndex)) continue;
            const range = fileRanges[fileIndex]!;
            const end = fileRanges[fileIndex + 1]?.start ?? ids.length;
            let index = range.start;
            for await (const part of partsOf(range, false)) {
              if (index >= end) break;
              if (matchOf.has(index)) {
                score(rank, part);
                matchedIndexes.push(index);
                matchedIds.push(ids[index]!);
              }
              index += 1;
            }
          }
          const { scores, base } = rank.finish(matchedIds);
          const at = new Map(matchedIndexes.map((index, position) => [index, position]));
          const order = matchedIndexes
            .sort((a, b) => base[at.get(b)!]! - base[at.get(a)!]! || ids[a]!.localeCompare(ids[b]!));
          const cut = request.wholeLanes === false;
          // With `wholeLanes` on the read keeps every match and marks each
          // one the cut would have dropped.
          const mark = request.wholeLanes === true;
          // The curve sees every match; `limit` slices what it keeps.
          const bend = cut || mark ? laneBend(order.map((index) => base[at.get(index)!]!)) : undefined;
          const passes = (index: number) => bend === undefined || base[at.get(index)!]! > bend;
          const curveKept = cut ? order.filter(passes) : order;
          const kept = request.limit === undefined ? curveKept : curveKept.slice(0, request.limit);
          const wanted = new Map<number, Set<number>>();
          for (const index of kept) {
            const file = partFile[index]!;
            const bucket = wanted.get(file);
            if (bucket === undefined) wanted.set(file, new Set([index]));
            else bucket.add(index);
          }
          const byIndex = new Map<number, MemoryCandidate>();
          for await (const [index, part] of corpus === undefined ? keptParts(wanted, fileRanges, refs) : []) {
            const position = at.get(index)!;
            byIndex.set(index, {
              sourceId: id, role: 'reference',
              id: ids[index]!, title: shownTitle(part, zone), text: part.text,
              contentRef: `${part.provider}:${part.sessionId}:${part.line}:${part.block}:${part.piece}`,
              chat: chatOf(part),
              date: dated(part),
              signals: { keyword: scores[position]!, phrase: matchOf.get(index)! },
              laneScore: base[position]!,
              ...(mark && !passes(index) ? { pastLaneCut: true as const } : {}),
            });
          }
          const candidates = corpus !== undefined
            ? kept.map((index) => held(index, {
              signals: { keyword: scores[at.get(index)!]!, phrase: matchOf.get(index)! },
              laneScore: base[at.get(index)!]!,
              ...(mark && !passes(index) ? { pastLaneCut: true as const } : {}),
            }))
            : kept.map((index) => byIndex.get(index))
              .filter((candidate): candidate is MemoryCandidate => candidate !== undefined);
          if (skips.n) reasons.push(`skipped ${skips.n} symbolic links or undated messages`);
          if (request.limit !== undefined && curveKept.length > request.limit) {
            reasons.push(`the limit kept ${request.limit} of ${curveKept.length} candidates`);
          }
          return {
            status: 'read' as const, candidates, ...indexed,
            complete: reasons.length === 0,
            ...(reasons.length ? { partial: reasons.join('; ') } : {}),
            ...(cut ? { laneCutApplied: true as const, matched: order.length } : {}),
          };
        }

        // A phrase lane matches its exact phrase and keeps the
        // matching parts; the corpus is never scored.
        if (request.phraseLane === true) {
          const matched: MemoryCandidate[] = [];
          if (corpus !== undefined) {
            skips.n += corpus.skips;
            for (const index of phraseCandidates(request.task)) {
              const count = phraseCount(corpus.parts[index]!.text, request.task) + phraseCount(corpus.titles[index]!, request.task);
              if (count > 0) matched.push(held(index, { signals: { phrase: count }, laneScore: count }));
            }
          }
          for await (const part of corpus === undefined ? each(true, true) : []) {
            const title = partTitle(part, zone);
            const count = phraseCount(part.text, request.task) + phraseCount(title, request.task);
            if (count > 0) {
              matched.push({
                sourceId: id, role: 'reference',
                id: idOf(part), title: shownTitle(part, zone), text: part.text,
                contentRef: `${part.provider}:${part.sessionId}:${part.line}:${part.block}:${part.piece}`,
                chat: chatOf(part),
                date: dated(part),
                signals: { phrase: count }, laneScore: count,
              });
            }
          }
          matched.sort((a, b) => (b.laneScore ?? 0) - (a.laneScore ?? 0) || a.id.localeCompare(b.id));
          const kept = request.limit === undefined ? matched : matched.slice(0, request.limit);
          if (skips.n) reasons.push(`skipped ${skips.n} symbolic links or undated messages`);
          if (kept.length < matched.length) reasons.push(`the phrase limit kept ${kept.length} of ${matched.length} candidates`);
          return {
            status: 'read', candidates: kept, ...indexed,
            complete: reasons.length === 0,
            ...(reasons.length ? { partial: reasons.join('; ') } : {}),
          };
        }

        // Pass one enumerates the corpus, pass two scores it, and a
        // third pass reads back only the files that kept a part.
        const rank = startChatRank([request.task, ...(request.paths ?? [])].join(' '), options.keyword);
        let ids: string[];
        let refs: string[] = [];
        let partFile: number[];
        let fileRanges: { provider: ChatProvider; root: string; file: string; start: number }[];
        // An enumeration a per-lane read of this call left behind is not
        // the walk's: this lane then shares it as the per-lane path does.
        if (corpus !== undefined && shared!.keyword !== undefined && shared!.keyword.ids !== corpus.ids) {
          corpus = undefined;
          onePass.served -= 1;
        }
        // A whole read that only sizes the history answers with the ids of
        // every part it would return: the call's whole walk.
        if (request.poolIds === true && request.wholeLanes === true && request.limit === undefined && corpus !== undefined) {
          skips.n += corpus.skips;
          if (skips.n) reasons.push(`skipped ${skips.n} symbolic links or undated messages`);
          return {
            status: 'read', candidates: [], poolIds: corpus.ids, ...indexed,
            complete: reasons.length === 0,
            ...(reasons.length ? { partial: reasons.join('; ') } : {}),
          };
        }
        if (corpus !== undefined) {
          // The call's one walk carries the corpus: each word's postings
          // are read from the index once for every lane, each title was
          // split once, and ties order by each id's held place.
          skips.n += corpus.skips;
          // A later keyword lane on the per-lane path shares the call's
          // first enumeration, whatever its own window: it finds this one.
          shared!.keyword ??= { ids: corpus.ids, refs: corpus.refs, partFile: corpus.partFile, fileRanges: corpus.fileRanges,
            titles: corpus.titles, longs: corpus.longs, skips: corpus.skips };
          ({ ids, refs, partFile, fileRanges } = corpus);
          const { stems, shorts } = rank.postingTerms();
          let postingOf: ReturnType<IndexDatabase['prepare']> | undefined;
          const fold = (term: string, word: string, short: boolean) => {
            let posting = corpus.postings.get(term);
            if (posting === undefined) {
              postingOf ??= database!.prepare('SELECT transcript, ordinal, count FROM postings WHERE term = ?');
              posting = { index: [], count: [] };
              for (const row of postingOf.all(term) as { transcript: number; ordinal: number; count: number }[]) {
                const index = corpus.indexOf.get(`${row.transcript}:${row.ordinal}`);
                if (index === undefined) continue;
                posting.index.push(index);
                posting.count.push(row.count);
              }
              corpus.postings.set(term, posting);
            }
            for (let at = 0; at < posting.index.length; at += 1) rank.posting(posting.index[at]!, word, posting.count[at]!, short);
          };
          for (const term of stems) fold(term, term, false);
          for (const word of shorts) fold(`!${word}`, word, true);
          rank.observeTitles(corpus.titleIndex ??= chatTitleIndex(corpus.titles, corpus.longs, options.keyword));
          rank.scoreIndexed({ heading: '', name: '', front: '' });
        } else if (storedRoots === undefined) {
          ids = [];
          partFile = [];
          fileRanges = [];
          for await (const part of each(true, false)) {
            const last = fileRanges.at(-1);
            if (last === undefined || last.file !== part.file) {
              fileRanges.push({ provider: part.provider, root: part.root, file: part.file, start: ids.length });
            }
            partFile.push(fileRanges.length - 1);
            ids.push(idOf(part));
            observe(rank, part);
          }
          // Without the index files are walked per transcript so a file
          // grown mid-read can only append: parts past the first pass's
          // count are skipped and a shrunk file simply scores fewer.
          for (const [rangeIndex, range] of fileRanges.entries()) {
            const end = fileRanges[rangeIndex + 1]?.start ?? ids.length;
            let index = range.start;
            for await (const part of partsOf(range, false)) {
              if (index >= end) break;
              score(rank, part);
              index += 1;
            }
          }
        } else {
          // With the index the postings alone carry the corpus: the
          // first keyword lane enumerates every in-window part once and
          // the lanes of the call share that list; each lane folds the
          // term postings, title terms and short-word counts into the
          // same numbers a stored word bag rescan would read.
          let held = shared?.keyword;
          if (held === undefined) {
            held = { ids: [], refs: [], partFile: [], fileRanges: [], titles: [], longs: [], skips: 0 };
            const before = skips.n;
            for await (const part of each(true, false, true)) {
              const last = held.fileRanges.at(-1);
              if (last === undefined || last.file !== part.file) {
                held.fileRanges.push({ provider: part.provider, root: part.root, file: part.file, start: held.ids.length });
              }
              held.partFile.push(held.fileRanges.length - 1);
              held.refs.push((part as StoredPart).at);
              held.titles.push(partTitle(part, zone));
              held.longs.push((part as StoredPart).words.long);
              held.ids.push(idOf(part));
            }
            held.skips = skips.n - before;
            if (shared !== undefined) shared.keyword = held;
          } else {
            skips.n += held.skips;
          }
          ({ ids, refs, partFile, fileRanges } = held);
          const { stems, shorts } = rank.postingTerms();
          const indexOf = new Map(held.refs.map((ref, index) => [ref, index] as const));
          const postingOf = database!.prepare('SELECT transcript, ordinal, count FROM postings WHERE term = ?');
          const fold = (term: string, word: string, short: boolean) => {
            for (const row of postingOf.all(term) as { transcript: number; ordinal: number; count: number }[]) {
              const index = indexOf.get(`${row.transcript}:${row.ordinal}`);
              if (index !== undefined) rank.posting(index, word, row.count, short);
            }
          };
          for (const term of stems) fold(term, term, false);
          for (const word of shorts) fold(`!${word}`, word, true);
          held.titles.forEach((title, index) => rank.observeIndexed(index, title, held.longs[index]!));
          rank.scoreIndexed({ heading: '', name: '', front: '' });
        }
        const places = corpus?.places;
        const { scores, base } = rank.finish(ids, places);
        // With the call's one walk, only the parts a posting or title named
        // can score; every other part scores zero and follows them in id
        // order, so only the scored parts are sorted.
        let order: number[];
        let scoredCount = 0;
        if (corpus !== undefined) {
          order = [];
          for (let index = 0; index < scores.length; index += 1) if (scores[index]! > 0) order.push(index);
          order.sort((a, b) => scores[b]! - scores[a]! || places![a]! - places![b]! || a - b);
          scoredCount = order.length;
          for (const index of corpus.byPlace) if (!(scores[index]! > 0)) order.push(index);
        } else {
          order = ids.map((_, index) => index)
            .filter((index) => index < scores.length)
            .sort(places === undefined
              ? (a, b) => scores[b]! - scores[a]! || ids[a]!.localeCompare(ids[b]!)
              : (a, b) => scores[b]! - scores[a]! || places[a]! - places[b]!);
        }
        const limited = request.limit === undefined ? order : order.slice(0, request.limit);
        // A bare read keeps every scored part; only a lane the pick
        // resolved with `wholeLanes: false` narrows inside the read. A
        // cut lane where nothing scored above zero matched nothing: it
        // keeps no parts rather than read back every body.
        const cut = request.wholeLanes === false;
        // With `wholeLanes` on the read keeps every part and marks each
        // one the cut would have dropped.
        const mark = request.wholeLanes === true;
        // The parts that score zero all hold a lane score of zero: to the
        // bend they are one run, which one zero stands for.
        const curve = corpus === undefined ? limited.map((index) => base[index]!)
          : [...limited.slice(0, scoredCount).map((index) => base[index]!), ...(limited.length > scoredCount ? [0] : [])];
        const bend = cut || mark ? laneBend(curve) : undefined;
        const matched = limited.some((index) => base[index]! > 0);
        const passes = (index: number) => bend === undefined ? matched : base[index]! > bend;
        const kept = cut ? limited.filter(passes) : limited;
        const wanted = new Map<number, Set<number>>();
        for (const index of kept) {
          const file = partFile[index]!;
          const bucket = wanted.get(file);
          if (bucket === undefined) wanted.set(file, new Set([index]));
          else bucket.add(index);
        }
        const byIndex = new Map<number, MemoryCandidate>();
        for await (const [index, part] of corpus === undefined ? keptParts(wanted, fileRanges, refs) : []) {
          byIndex.set(index, {
            sourceId: id, role: 'reference',
            id: ids[index]!, title: shownTitle(part, zone), text: part.text,
            contentRef: `${part.provider}:${part.sessionId}:${part.line}:${part.block}:${part.piece}`,
            chat: chatOf(part),
            date: dated(part),
            signals: { keyword: scores[index]! }, laneScore: base[index]!,
            ...(mark && !passes(index) ? { pastLaneCut: true as const } : {}),
          });
        }
        // A transcript that shrank mid-read leaves a kept index with no
        // part to materialize; it simply emits fewer.
        const candidates = corpus !== undefined
          ? kept.map((index) => held(index, {
            signals: { keyword: scores[index]! }, laneScore: base[index]!,
            ...(mark && !passes(index) ? { pastLaneCut: true as const } : {}),
          }))
          : kept.map((index) => byIndex.get(index))
            .filter((candidate): candidate is MemoryCandidate => candidate !== undefined);
        if (skips.n) reasons.push(`skipped ${skips.n} symbolic links or undated messages`);
        if (request.limit !== undefined && order.length > request.limit) {
          reasons.push(`the limit kept ${request.limit} of ${order.length} candidates`);
        }
        return {
          status: 'read', candidates, ...indexed,
          complete: reasons.length === 0,
          ...(reasons.length ? { partial: reasons.join('; ') } : {}),
          ...(cut ? { laneCutApplied: true, matched: limited.length } : {}),
        };
      } catch (error) {
        if (error instanceof SourceReadError) throw error;
        if (request.signal?.aborted) throw new SourceReadError('cancelled', 'The read was cancelled.');
        throw new SourceReadError('failed', 'Could not read a chat transcript folder or file.');
      } finally {
        database?.close();
      }
    },
  };
  if (options.bar !== undefined
    && (typeof options.bar !== 'number' || !Number.isFinite(options.bar) || options.bar < 0 || options.bar > 1)) {
    throw new TypeError('bar must be a number between 0 and 1.');
  }
  const questions = options.questions ?? AGENT_CHAT_CASCADE;
  const bar = options.bar ?? questions.model?.bar ?? chatSettings.bar;
  return historySource({ reader, ...chatSettings, questions, bar });
}
