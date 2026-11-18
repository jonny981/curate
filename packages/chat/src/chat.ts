import { createHash } from 'node:crypto';
import { lstat, open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';

import {
  canonicalPath, phraseCount, phraseQuery, phraseWords, PHRASE_INDEX, laneBend, normalized, similarity, sinceCutoff, taskMoment, timeZoneOf,
  zonedIso, bagEntries, checkIndexOption, eachPartVector, indexDirectory, indexFilePath, indexVersion, openIndexFile,
  openIndexFileNow, removeEarlierFormats, textKey, updateIndex, type IndexDatabase, type StoredIndexOptions,
  type StoredIndexReport,
} from '@curatejs/core/internal';
import {
  startChatRank, storedChatWords, CHAT_KEYWORD_SETTINGS, type ChatKeywordSettings, type ChatRankSession,
  type ChatTitleIndex, type StoredChatWords,
} from './chat-rank.js';
import { scrubChat } from './chat-scrub.js';
import { porterStem } from './porter.js';
import { DEFAULT_MAX_QUESTION_TEXT, type MemoryCandidate } from '@curatejs/core';
import {
  historySource, SourceReadError, type CandidateReadContext, type CandidateReadRequest, type CandidateSource,
  type Mode, type ModeParts, type PoolPart,
} from '@curatejs/core';
import { chatSettings } from './defaults.js';
import { agentTranscripts } from './mode.js';

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
  /** How the decision step judges and reads this source's parts: its
   *  question set, its bar and its read. Defaults to `agentTranscripts`.
   *  A mode whose questions are a model-scored set such as
   *  JUDGMENT_CHAT_CASCADE throws while its weights file is unfitted. */
  readonly mode?: Mode;
}

type Json = Record<string, unknown>;
type MessageRole = NonNullable<MemoryCandidate['chat']>['role'];
type Author = NonNullable<MemoryCandidate['author']>;
type Unit = NonNullable<NonNullable<MemoryCandidate['chat']>['unit']>;
interface Written { author: Author; authorName?: string }
interface Part extends Written { role: MessageRole; text: string; unit?: 'summary' }
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
  /** What part of an agent's work it is, when it is one: see `withUnit`. */
  readonly unit?: Unit;
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

/** The key under which a part the parts lookup made keeps its place in
 *  the call's walk. */
const PART = Symbol('part');

/** A part that reads its text on demand answers these, as core's
 *  `pickFromSources` asks once a pick ends: `SETTLE` gives the part as a
 *  plain part holding its text, checked against the text it was made
 *  from (undefined when its row no longer holds it), and `CLOSE` lets go
 *  of the index connection the call's parts read from. */
const SETTLE = Symbol.for('curate.settle');
const CLOSE = Symbol.for('curate.close');

/** The parts of one call that read their text on demand, made from the
 *  call's walk. */
interface LazyParts {
  /** A part from the walk, with the text it is made from and the fields
   *  a lane adds; it holds neither its text nor its title. */
  make(index: number, text: string, extra: Partial<MemoryCandidate>): MemoryCandidate;
  /** A part whose row is gone: made with no text and counted as changed. */
  gone(index: number, extra: Partial<MemoryCandidate>): MemoryCandidate;
  close(): void;
}

/** A 32-bit FNV-1a hash of a text: whether a stored row still holds the
 *  text a part was made from. */
function textHash(text: string): number {
  let hash = 2166136261;
  for (let at = 0; at < text.length; at += 1) hash = Math.imul(hash ^ text.charCodeAt(at), 16777619);
  return hash >>> 0;
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
        const said = (text: string) => parts.push({ role, text,
          ...(role === 'user' ? claudeAuthor(record, origin, text) : { author: 'agent' as const }),
          ...(role === 'user' && record.isCompactSummary === true ? { unit: 'summary' as const } : {}) });
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
// reaches the id's line, block and piece. Two names masked alike, such as
// two files named by 32 hex characters, would give two transcripts one id
// and one place, so a masked path carries a short hash of the real one:
// the transcripts stay apart, and the real name is never shown.
const partId = (part: RawPart) => {
  const path = relative(part.root, part.file);
  const root = scrubChat(part.root), shown = scrubChat(path);
  const apart = root === part.root && shown === path ? ''
    : `#${createHash('sha256').update(`${part.root}\0${path}`).digest('hex').slice(0, 16)}`;
  return `${part.provider}:${root}:${shown}${apart}:${part.line}:${part.block}:${part.piece}`;
};
const partTitle = (part: RawPart, zone: string) =>
  `${part.provider} ${part.sessionId} ${part.role} ${zonedIso(part.date, zone)}`;
const AUTHOR_TITLES: Record<Author, string> = { person: ' (the person)', agent: ' (agent)', tool: ' (tool)', system: ' (system)', unmarked: '' };
/** The title a candidate carries: the author follows the role. Ranks and
 *  phrase matches read `partTitle`, so the mark never changes them. */
const shownTitle = (part: RawPart, zone: string) =>
  `${part.provider} ${part.sessionId} ${part.role}${part.authorName === undefined ? AUTHOR_TITLES[part.author]
    : ` (${part.author} ${part.authorName})`} ${zonedIso(part.date, zone)}`;
/** A part's transcript fields: its chat metadata, its author, and its
 *  place: the transcript its id names (the id less its line, block and
 *  piece) and its line, block and piece there. */
const chatOf = (part: RawPart, id: string): Pick<MemoryCandidate, 'chat' | 'author' | 'place'> => ({
  chat: { provider: part.provider, sessionId: part.sessionId, role: part.role,
    ...(part.authorName === undefined ? {} : { authorName: part.authorName }),
    ...(part.unit === undefined ? {} : { unit: part.unit }) },
  author: part.author,
  place: { container: id.split(':').slice(0, -3).join(':'), at: [part.line, part.block, part.piece] },
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
          ...(part.unit === undefined ? {} : { unit: part.unit }),
          date, text: textPart,
        };
      }
    }
  }
}

/** A Claude Code subagent's id, from its transcript's path
 *  (`<session>/subagents/agent-<id>.jsonl`); undefined for any other
 *  transcript. */
const subagentOf = (provider: ChatProvider, file: string) => provider === 'claude-code'
  ? /[\\/]subagents[\\/]agent-([^\\/]+)\.jsonl$/.exec(file)?.[1] : undefined;

/** A part of a Claude Code subagent's transcript marked as what part of
 *  the agent's work it is: the transcript's first line, the brief the
 *  agent was given, is its `prompt`; the last line holding assistant text
 *  (`report`, the transcript's highest such line) is its `report`, named
 *  by the agent's id. Any other part keeps the mark it decoded with: a
 *  compaction summary's `summary`, or none. */
const withUnit = <P extends LinePart>(part: P, agent: string | undefined, report: number | undefined): P =>
  agent === undefined ? part
    : part.line === 1 && part.role === 'user' ? { ...part, unit: 'prompt' }
      : part.line === report && part.role === 'assistant' ? { ...part, unit: 'report', authorName: scrubChat(agent) }
        : part;

/** The highest line holding an assistant part. */
const lastAssistantLine = (parts: readonly LinePart[]) =>
  parts.reduce<number | undefined>((last, part) => part.role === 'assistant' && (last === undefined || part.line > last) ? part.line : last, undefined);

/** The parts of one transcript, decoded and split but never kept. Each
 *  pass over the history reads the file again rather than holding the
 *  parts of every file at once. */
async function* fileParts(
  provider: ChatProvider, root: string, file: string, walk: WalkContext,
): AsyncGenerator<RawPart> {
  const raw = await readFile(file, { encoding: 'utf8', signal: walk.signal });
  const state: DecodeState = { sessionId: fileSessionId(file), session: {} };
  const undated = () => { if (walk.countSkips) walk.countSkips.n += 1; };
  const parts = [...decodeLines(provider, raw.split(/\r?\n/), 0, state, walk.includeTools, walk.size, walk.signal, undated)];
  const agent = subagentOf(provider, file);
  const report = agent === undefined ? undefined : lastAssistantLine(parts);
  for (const part of parts) {
    if (part.date < walk.since || part.date > walk.until) continue;
    yield { provider, root, file, ...withUnit(part, agent, report) };
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
  /** Each part's similarity to each query, the part's queries side by
   *  side: part `i`'s to query `q` is at `i * queries.length + q`. */
  similarities: Float64Array;
  ids: string[];
  /** Each part's row in the stored index; none on a direct read. */
  refOf: (index: number) => string;
  partFile: ArrayLike<number>;
  fileRanges: { provider: ChatProvider; root: string; file: string; start: number }[];
}

/** The keyword lanes' once-per-call enumeration: every in-window part's
 *  scrubbed id, index row, title and word total, in enumeration order,
 *  and the skips the first pass counted. */
interface ChatKeywordEnum {
  ids: string[];
  refOf: (index: number) => string;
  partFile: ArrayLike<number>;
  fileRanges: { provider: ChatProvider; root: string; file: string; start: number }[];
  titleOf: (index: number) => string;
  longs: ArrayLike<number>;
  skips: number;
}

/** Internal to this package and not part of its public surface: the
 *  one-pass read's switch, a count of the reads it served and of the
 *  walks it made. A test turns it off to get the per-lane path as its
 *  oracle. */
export const onePass = { on: true, served: 0, walks: 0 };

/** What one call knows about the whole stored history, read once and
 *  shared by every lane of the call: each in-window part's stored fields,
 *  as columns, and what every lane would otherwise work out from them
 *  again. It holds no part's text, words or vector key, and no title: a
 *  lane reads those by key, or makes them, for the parts it needs. It
 *  holds nothing a request's task sets. */
interface ChatCorpus {
  /** What decides which parts are in it. */
  readonly key: string;
  /** How many parts it holds. */
  readonly count: number;
  readonly ids: string[];
  readonly partFile: Int32Array;
  readonly fileRanges: { provider: ChatProvider; root: string; file: string; start: number }[];
  /** Each part's provider, as a place in `strings`, and its transcript
   *  row in the stored index. */
  readonly providers: Int32Array;
  readonly transcripts: Int32Array;
  /** Each transcript's parts, from the first to past the last, by its row. */
  readonly spans: ReadonlyMap<number, readonly [number, number]>;
  readonly ordinals: Int32Array;
  readonly lines: Int32Array;
  readonly blocks: Int32Array;
  readonly pieces: Int32Array;
  readonly dates: Float64Array;
  /** Each part's session id, role, author, author name and unit, as a
   *  place in `strings`; -1 where it has none. */
  readonly sessions: Int32Array;
  readonly roles: Int32Array;
  readonly authors: Int32Array;
  readonly names: Int32Array;
  readonly marks: Int32Array;
  readonly strings: readonly string[];
  readonly longs: Uint32Array;
  /** Each part's place in id order; equal ids share a place. */
  readonly places: Uint32Array;
  /** The parts in id order, equal ids in walk order. */
  readonly byPlace: Uint32Array;
  /** The index's `indexVersion` the parts were read at; unset when an
   *  update landed while they were read. */
  readonly version: number | undefined;
  readonly skips: number;
}

/** What one call works out from a walk for itself; the walk, which
 *  calls share, holds none of it. */
interface WalkCache {
  /** Each word's postings as part indexes, read from the index once. */
  readonly postings: Map<string, { readonly index: number[]; readonly count: number[] }>;
  /** The parts whose title holds a word `phraseCount` compares, found
   *  once per word, when a phrase lane first asks. */
  readonly titlePhraseWords: Map<string, number[]>;
  /** Each part's title words of three characters or more and long text
   *  words, as a title index counts them; made when a keyword lane
   *  first asks. */
  titleLengths?: { readonly lengths: Uint32Array; readonly length: number };
  /** Each part's unit vector, once a meaning lane has embedded them with
   *  an embedder that keeps no store. */
  units?: Float64Array[];
}

/** The latest walk of each stored index in this process, by the index
 *  file's path. A call whose walk would read the same parts (the same
 *  window, zone and exclusions) of the index at the same version takes
 *  it as it is; it is never changed after it is made. A newer walk takes
 *  its place, and an older one goes when the last call holding it ends. */
const sharedWalks = new Map<string, ChatCorpus>();

/** A source's entry in a read context's shared space: the meaning
 *  lanes' held scores, the part ids scrubbed once for every lane that
 *  asks for them, and the keyword lanes' once-per-call enumeration. */
interface Shared {
  meaning?: Lite;
  ids?: Map<string, string>;
  keyword?: ChatKeywordEnum;
  corpus?: ChatCorpus;
  /** What this call works out from the walk for itself. */
  walkCache?: WalkCache;
  /** The call's parts that read their text on demand. */
  lazy?: LazyParts;
  /** The parts of the call's one walk its reads have left out because
   *  their stored row no longer held them, by place in the walk. */
  changed?: Set<number>;
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
    author_name TEXT, unit TEXT, date INTEGER NOT NULL, text TEXT NOT NULL, long INTEGER NOT NULL, stems TEXT NOT NULL,
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
        author, author_name, unit, date, text, long, stems, short, vec, pid)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
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
              part.authorName ?? null, part.unit ?? null, part.date, part.text, words.long, words.stems, words.short,
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
 *  transcript are read at once, as the direct read holds one file. A
 *  `light` read leaves out the author and unit; one without `withWords`
 *  leaves out the stored words and vector key. */
function* storedParts(
  database: IndexDatabase, provider: ChatProvider, root: string, transcript: StoredTranscript, withText: boolean,
  light = false, withWords = !light,
): Generator<StoredPart> {
  const rows = database.prepare(`SELECT ordinal, line, block, piece, session, role,
    ${light ? "'unmarked' AS author, NULL AS author_name, NULL AS unit" : 'author, author_name, unit'}, date,
    ${withText ? 'text' : "'' AS text"}, long,
    ${withWords ? 'stems, short, vec' : "'' AS stems, '' AS short, NULL AS vec"}, pid FROM parts WHERE transcript = ? ORDER BY ordinal`)
    .all(transcript.id) as Record<string, unknown>[];
  const agent = light ? undefined : subagentOf(provider, transcript.file);
  const report = agent === undefined ? undefined : rows.reduce<number | undefined>((last, row) =>
    row.role === 'assistant' && (last === undefined || (row.line as number) > last) ? row.line as number : last, undefined);
  for (const row of rows) yield withUnit(storedPart(provider, root, transcript, row), agent, report);
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
    ...(row.unit === null || row.unit === undefined ? {} : { unit: row.unit as Unit }),
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
  const rows = database.prepare(`SELECT ordinal, line, block, piece, session, role, author, author_name, unit, date, text,
    long, stems, short, vec, pid FROM parts WHERE transcript = ? AND ordinal IN (SELECT value FROM json_each(?)) ORDER BY ordinal`)
    .all(transcript.id, JSON.stringify(ordinals)) as Record<string, unknown>[];
  const agent = subagentOf(provider, transcript.file);
  const report = agent === undefined ? undefined : (database.prepare(
    "SELECT MAX(line) AS line FROM parts WHERE transcript = ? AND role = 'assistant'").get(transcript.id) as { line: number | null }).line ?? undefined;
  return rows.map((row) => withUnit(storedPart(provider, root, transcript, row), agent, report));
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
        const eachStored = function* (counting: boolean, withText: boolean, light: boolean, withWords = !light): Generator<StoredPart> {
          for (const { provider, root, transcripts, symlinks } of storedRoots!) {
            if (counting) skips.n += symlinks;
            for (const transcript of transcripts) {
              cancelled(request.signal);
              if (counting) skips.n += transcript.undated;
              for (const part of storedParts(database!, provider, root, transcript, withText, light, withWords)) {
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
          refOf: (index: number) => string,
        ): AsyncGenerator<readonly [number, RawPart]> {
          for (const [fileIndex, indexes] of wanted) {
            const range = fileRanges[fileIndex]!;
            const transcript = storedRoots === undefined ? undefined : byFile.get(`${range.provider}\0${range.file}`);
            if (storedRoots !== undefined) {
              if (transcript === undefined) continue;
              cancelled(request.signal);
              const indexOf = new Map([...indexes].map((index) => [refOf(index), index] as const));
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
          const held = shared.corpus === undefined ? sharedWalks.get(stored!.path) : undefined;
          if (held !== undefined && held.key === key && held.version !== undefined && held.version === indexVersion(database!)) {
            shared.corpus = held;
          }
          if (shared.corpus === undefined) {
            onePass.walks += 1;
            const before = skips.n;
            const version = indexVersion(database!);
            // A session id, role, author, author name or unit is held once
            // however many parts carry it.
            const strings: string[] = [];
            const interned = new Map<string, number>();
            const intern = (value: string | undefined) => {
              if (value === undefined) return -1;
              let at = interned.get(value);
              if (at === undefined) {
                interned.set(value, at = strings.length);
                strings.push(value);
              }
              return at;
            };
            const ids: string[] = [];
            const fileRanges: ChatCorpus['fileRanges'] = [];
            const spans = new Map<number, readonly [number, number]>();
            const column = {
              providers: [] as number[], transcripts: [] as number[], partFile: [] as number[], ordinals: [] as number[],
              lines: [] as number[], blocks: [] as number[], pieces: [] as number[], dates: [] as number[],
              sessions: [] as number[], roles: [] as number[], authors: [] as number[], names: [] as number[],
              marks: [] as number[], longs: [] as number[],
            };
            let spanStart = 0;
            for (const part of eachStored(true, false, false, false)) {
              const last = fileRanges.at(-1);
              if (last === undefined || last.file !== part.file) {
                fileRanges.push({ provider: part.provider, root: part.root, file: part.file, start: ids.length });
              }
              const previous = column.transcripts.at(-1);
              if (previous !== part.transcript) {
                if (previous !== undefined) spans.set(previous, [spanStart, ids.length]);
                spanStart = ids.length;
              }
              column.providers.push(intern(part.provider));
              column.transcripts.push(part.transcript);
              column.partFile.push(fileRanges.length - 1);
              column.ordinals.push(part.ordinal);
              column.lines.push(part.line);
              column.blocks.push(part.block);
              column.pieces.push(part.piece);
              column.dates.push(part.date);
              column.sessions.push(intern(part.sessionId));
              column.roles.push(intern(part.role));
              column.authors.push(intern(part.author));
              column.names.push(intern(part.authorName));
              column.marks.push(intern(part.unit));
              column.longs.push(part.words.long);
              ids.push(idOf(part));
            }
            if (column.transcripts.length > 0) spans.set(column.transcripts.at(-1)!, [spanStart, ids.length]);
            // Ties in a lane order by id; each part's place in id order
            // stands in for the comparison.
            const byId = ids.map((_, index) => index).sort((a, b) => ids[a]!.localeCompare(ids[b]!));
            const places = new Uint32Array(ids.length);
            for (let place = 1; place < byId.length; place += 1) {
              places[byId[place]!] = ids[byId[place]!]!.localeCompare(ids[byId[place - 1]!]!) === 0
                ? places[byId[place - 1]!]! : place;
            }
            shared.corpus = {
              key, count: ids.length, ids, fileRanges, spans, strings,
              providers: Int32Array.from(column.providers), transcripts: Int32Array.from(column.transcripts),
              partFile: Int32Array.from(column.partFile), ordinals: Int32Array.from(column.ordinals),
              lines: Int32Array.from(column.lines), blocks: Int32Array.from(column.blocks), pieces: Int32Array.from(column.pieces),
              dates: Float64Array.from(column.dates), sessions: Int32Array.from(column.sessions), roles: Int32Array.from(column.roles),
              authors: Int32Array.from(column.authors), names: Int32Array.from(column.names), marks: Int32Array.from(column.marks),
              longs: Uint32Array.from(column.longs),
              places, byPlace: Uint32Array.from(byId),
              version: indexVersion(database!) === version ? version : undefined,
              skips: skips.n - before,
            };
            Object.freeze(ids);
            Object.freeze(strings);
            for (const range of fileRanges) Object.freeze(range);
            Object.freeze(fileRanges);
            Object.freeze(shared.corpus);
            if (shared.corpus.version !== undefined) sharedWalks.set(stored!.path, shared.corpus);
            // Each lane counts the skips where its own walk would have.
            skips.n = before;
          }
          if (shared.corpus.key === key) {
            corpus = shared.corpus;
            onePass.served += 1;
          }
        }
        // What this call works out from the walk, kept by the call.
        const walkCache = (): WalkCache => (shared!.walkCache ??= { postings: new Map(), titlePhraseWords: new Map() });
        /** A part of the call's one walk at its stored row, or undefined. */
        const indexAt = (transcript: number, ordinal: number): number | undefined => {
          const span = corpus!.spans.get(transcript);
          if (span === undefined) return undefined;
          let [low, high] = span;
          while (low < high) {
            const middle = (low + high) >>> 1;
            const at = corpus!.ordinals[middle]!;
            if (at === ordinal) return middle;
            if (at < ordinal) low = middle + 1;
            else high = middle;
          }
          return undefined;
        };
        /** A part of the call's one walk, from its stored fields; its text
         *  is not read. */
        const fieldsOf = (index: number): RawPart => {
          const c = corpus!;
          const range = c.fileRanges[c.partFile[index]!]!;
          const name = c.names[index]!;
          const mark = c.marks[index]!;
          return {
            provider: c.strings[c.providers[index]!]! as ChatProvider, root: range.root, file: range.file,
            line: c.lines[index]!, block: c.blocks[index]!, piece: c.pieces[index]!,
            sessionId: c.strings[c.sessions[index]!]!, role: c.strings[c.roles[index]!]! as MessageRole,
            author: c.strings[c.authors[index]!]! as Author,
            ...(name < 0 ? {} : { authorName: c.strings[name]! }),
            ...(mark < 0 ? {} : { unit: c.strings[mark]! as Unit }),
            date: c.dates[index]!, text: '',
          };
        };
        /** A part's title as ranks and phrase matches read it (`partTitle`). */
        const titleIn = (c: ChatCorpus, index: number) =>
          `${c.strings[c.providers[index]!]!} ${c.strings[c.sessions[index]!]!} ${c.strings[c.roles[index]!]!} ${zonedIso(c.dates[index]!, zone)}`;
        const titleOf = (index: number) => titleIn(corpus!, index);
        // A part whose stored row no longer holds it is left out of every
        // read of the call, and the record counts it.
        const leftOut = (index: number) => { (shared!.changed ??= new Set()).add(index); };
        const changed = () => (shared?.changed?.size ?? 0) === 0 ? {} : { changed: shared!.changed!.size };
        /** Parts of the walk's stored rows, read by key a transcript at a
         *  time, with the columns `select` names. A part whose row no
         *  longer holds it, because another call re-indexed its transcript
         *  since the walk, has none. */
        const rowsOf = (indexes: Iterable<number>, select: string): Map<number, Record<string, unknown>> => {
          const c = corpus!;
          const byTranscript = new Map<number, Map<number, number>>();
          for (const index of indexes) {
            const transcript = c.transcripts[index]!;
            let wanted = byTranscript.get(transcript);
            if (wanted === undefined) byTranscript.set(transcript, wanted = new Map());
            wanted.set(c.ordinals[index]!, index);
          }
          const found = new Map<number, Record<string, unknown>>();
          if (byTranscript.size === 0) return found;
          const statement = database!.prepare(`SELECT ordinal, line, block, piece, ${select} FROM parts
            WHERE transcript = ? AND ordinal IN (SELECT value FROM json_each(?))`);
          for (const [transcript, wanted] of byTranscript) {
            cancelled(request.signal);
            for (const row of statement.iterate(transcript, JSON.stringify([...wanted.keys()])) as Iterable<Record<string, unknown>>) {
              const index = wanted.get(row.ordinal as number);
              if (index === undefined || row.line !== c.lines[index] || row.block !== c.blocks[index]
                || row.piece !== c.pieces[index]) continue;
              found.set(index, row);
            }
            for (const index of wanted.values()) if (!found.has(index)) leftOut(index);
          }
          return found;
        };
        const textsOf = (indexes: Iterable<number>): Map<number, string> => {
          const texts = new Map<number, string>();
          for (const [index, row] of rowsOf(indexes, 'text')) texts.set(index, row.text as string);
          return texts;
        };
        const wordsOf = (indexes: Iterable<number>): Map<number, StoredChatWords> => {
          const words = new Map<number, StoredChatWords>();
          for (const [index, row] of rowsOf(indexes, 'long, stems, short')) {
            words.set(index, { long: row.long as number, stems: row.stems as string, short: row.short as string });
          }
          return words;
        };
        /** Every part of the walk's stored row, a transcript at a time in
         *  walk order, with the columns `select` names; a part whose row no
         *  longer holds it is visited with none. */
        const eachRow = (select: string, visit: (index: number, row: Record<string, unknown> | undefined) => void) => {
          const c = corpus!;
          const statement = database!.prepare(`SELECT ordinal, line, block, piece, ${select} FROM parts WHERE transcript = ?`);
          for (const [transcript, [start, end]] of c.spans) {
            cancelled(request.signal);
            const rows = new Map<number, Record<string, unknown>>();
            for (const row of statement.iterate(transcript) as Iterable<Record<string, unknown>>) rows.set(row.ordinal as number, row);
            for (let index = start; index < end; index += 1) {
              const row = rows.get(c.ordinals[index]!);
              const same = row !== undefined && row.line === c.lines[index] && row.block === c.blocks[index]
                && row.piece === c.pieces[index];
              if (!same) leftOut(index);
              visit(index, same ? row : undefined);
            }
          }
        };
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
            const index = indexAt(Math.floor(row.id / PHRASE_ROW), row.id % PHRASE_ROW);
            if (index !== undefined) found.add(index);
          }
          // The rows of an index another update changed since the walk do
          // not describe the texts it holds.
          if (indexVersion(database!) !== corpus!.version) return Array.from({ length: corpus!.count }, (_, index) => index);
          const first = phraseWords(phrase).split(' ')[0]!;
          let holders = walkCache().titlePhraseWords.get(first);
          if (holders === undefined) {
            // A title's words are its provider's, session id's and role's,
            // found once a string, and its date's, which are digits, or a
            // day and hour joined by a `t`: read only for a word like them.
            const c = corpus!;
            const holds = new Map<number, boolean>();
            const has = (at: number) => {
              let found = holds.get(at);
              if (found === undefined) holds.set(at, found = phraseWords(c.strings[at]!).split(' ').includes(first));
              return found;
            };
            const dated = /^(?:\d+|\d\dt\d\d)$/.test(first);
            holders = [];
            for (let index = 0; index < c.count; index += 1) {
              if (has(c.providers[index]!) || has(c.sessions[index]!) || has(c.roles[index]!)
                || (dated && phraseWords(zonedIso(c.dates[index]!, zone)).split(' ').includes(first))) holders.push(index);
            }
            walkCache().titlePhraseWords.set(first, holders);
          }
          for (const index of holders) found.add(index);
          return [...found].sort((left, right) => left - right);
        };
        /** A part of the call's one walk as a lane hands it on, with its
         *  stored text. */
        // The call's parts made from the walk hold neither their text nor
        // their title: both are made from the walk and the part's row when
        // asked for. Every read of the call makes them with one class, so
        // the pick settles and closes them together.
        const lazyParts = (): LazyParts => {
          if (shared!.lazy !== undefined) return shared!.lazy;
          const c = corpus!;
          const path = stored!.path;
          let reader: IndexDatabase | undefined;
          let textRow: ReturnType<IndexDatabase['prepare']> | undefined;
          // A part's text, from its row; the hash of the text it was made
          // from tells whether the row still holds that text.
          const madeHash = new Map<number, number>();
          const changedParts = new Set<number>();
          const textAt = (index: number): string => {
            textRow ??= (reader ??= openIndexFileNow(path)).prepare('SELECT line, block, piece, text FROM parts WHERE transcript = ? AND ordinal = ?');
            const row = textRow.get(c.transcripts[index]!, c.ordinals[index]!) as
              { line: number; block: number; piece: number; text: string } | undefined;
            const same = row !== undefined && row.line === c.lines[index] && row.block === c.blocks[index]
              && row.piece === c.pieces[index];
            const text = same ? row.text : '';
            if (!same || textHash(text) !== madeHash.get(index)) changedParts.add(index);
            return text;
          };
          const titleAt = (index: number): string => {
            const part = fieldsOf(index);
            return `${part.provider} ${part.sessionId} ${part.role}${part.authorName === undefined ? AUTHOR_TITLES[part.author]
              : ` (${part.author} ${part.authorName})`} ${zonedIso(part.date, zone)}`;
          };
          // A plain part with the same fields in the same order as one made
          // with its text: the title and the text follow the id.
          const plain = (part: LanePart, text: string): MemoryCandidate => {
            const out: Record<string, unknown> = {};
            for (const key of Object.keys(part)) {
              out[key] = (part as unknown as Record<string, unknown>)[key];
              if (key === 'id') {
                out.title = titleAt(part[PART]);
                out.text = text;
              }
            }
            return out as unknown as MemoryCandidate;
          };
          const close = () => {
            reader?.close();
            reader = undefined;
            textRow = undefined;
          };
          // A part: its fields and its place in the walk. A copy that keeps
          // the prototype and the fields reads the same text and title.
          class LanePart {
            readonly [PART]: number;
            constructor(fields: Partial<MemoryCandidate>, index: number) {
              Object.assign(this, fields);
              this[PART] = index;
            }
            get text(): string {
              return textAt(this[PART]);
            }
            get title(): string {
              return titleAt(this[PART]);
            }
            toJSON(): MemoryCandidate {
              return plain(this, textAt(this[PART]));
            }
            [SETTLE](): MemoryCandidate | undefined {
              const text = textAt(this[PART]);
              return changedParts.has(this[PART]) ? undefined : plain(this, text);
            }
            [CLOSE](): void {
              close();
            }
          }
          const fieldsAt = (index: number, extra: Partial<MemoryCandidate>): Partial<MemoryCandidate> => {
            const part = fieldsOf(index);
            return {
              sourceId: id, role: 'reference', id: c.ids[index]!,
              contentRef: `${part.provider}:${part.sessionId}:${part.line}:${part.block}:${part.piece}`,
              ...chatOf(part, c.ids[index]!),
              date: { value: zonedIso(part.date, zone), meaning: 'recorded' as const },
              ...extra,
            };
          };
          return shared!.lazy = {
            make(index, text, extra) {
              madeHash.set(index, textHash(text));
              return new LanePart(fieldsAt(index, extra), index) as unknown as MemoryCandidate;
            },
            gone(index, extra) {
              madeHash.set(index, textHash(''));
              changedParts.add(index);
              return new LanePart(fieldsAt(index, extra), index) as unknown as MemoryCandidate;
            },
            close,
          };
        };
        const held = (index: number, text: string, extra: Pick<MemoryCandidate, 'signals' | 'laneScore' | 'pastLaneCut'>): MemoryCandidate =>
          lazyParts().make(index, text, extra);
        /** The title index of every title of the walk, holding only these
         *  stems and short words (see `ChatTitleIndex`). A title is
         *  `${provider} ${sessionId} ${role} ${date}` (`partTitle`): the
         *  first three are a few strings many parts share, so their words
         *  are found once a string, and a date's words are made from each
         *  part's date only when one of the terms could be one of them. */
        const titleTerms = (stems: readonly string[], shorts: readonly string[]): ChatTitleIndex => {
          const c = corpus!;
          const stemOn = ({ ...CHAT_KEYWORD_SETTINGS, ...options.keyword }).stem;
          const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/);
          const known = new Map<number, { long: number; stems: Map<string, number>; shorts: Map<string, number> }>();
          const wordsOfString = (at: number) => {
            let found = known.get(at);
            if (found === undefined) {
              found = { long: 0, stems: new Map(), shorts: new Map() };
              for (const word of words(c.strings[at]!)) {
                if (word.length > 2) {
                  found.long += 1;
                  const stem = stemOn ? porterStem(word) : word;
                  found.stems.set(stem, (found.stems.get(stem) ?? 0) + 1);
                } else if (word !== '') {
                  found.shorts.set(word, (found.shorts.get(word) ?? 0) + 1);
                }
              }
              known.set(at, found);
            }
            return found;
          };
          // Every date's words, as `zonedIso` writes it, are a four-digit
          // year, the day and hour joined by a `t`, three digits of
          // milliseconds, and two-digit month, minutes, seconds and offset:
          // three long words a date, which stem to themselves.
          const dateLong = /^(?:\d{4}|\d\dt\d\d|\d{3})$/;
          const dateShort = /^\d\d$/;
          const datedStems = stems.filter((term) => dateLong.test(term));
          const datedShorts = shorts.filter((word) => dateShort.test(word));
          const cache = walkCache();
          if (cache.titleLengths === undefined) {
            const lengths = new Uint32Array(c.count);
            let length = 0;
            for (let index = 0; index < c.count; index += 1) {
              const date = c.dates[index]!;
              const year = new Date(date).getUTCFullYear();
              const dateWords = year > 0 && year < 9999 ? 3
                : words(zonedIso(date, zone)).filter((word) => word.length > 2).length;
              const kept = dateWords + wordsOfString(c.providers[index]!).long + wordsOfString(c.sessions[index]!).long
                + wordsOfString(c.roles[index]!).long;
              lengths[index] = kept + c.longs[index]!;
              length += kept + c.longs[index]!;
            }
            cache.titleLengths = { lengths, length };
          }
          const stemLists = new Map<string, number[]>(stems.map((term) => [term, []]));
          const shortLists = new Map<string, number[]>(shorts.map((word) => [word, []]));
          // Each string's occurrences of the terms, found once a string.
          const hitsOf = new Map<number, (readonly [number[], number])[]>();
          const hits = (at: number) => {
            let found = hitsOf.get(at);
            if (found === undefined) {
              const own = wordsOfString(at);
              found = [];
              for (const [term, list] of stemLists) {
                const count = own.stems.get(term);
                if (count !== undefined) found.push([list, count]);
              }
              for (const [word, list] of shortLists) {
                const count = own.shorts.get(word);
                if (count !== undefined) found.push([list, count]);
              }
              hitsOf.set(at, found);
            }
            return found;
          };
          const dated = datedStems.length > 0 || datedShorts.length > 0;
          for (let index = 0; index < c.count; index += 1) {
            for (const at of [c.providers[index]!, c.sessions[index]!, c.roles[index]!]) {
              for (const [list, count] of hits(at)) for (let n = 0; n < count; n += 1) list.push(index);
            }
            if (!dated) continue;
            for (const word of words(zonedIso(c.dates[index]!, zone))) {
              const list = word.length > 2 ? datedStems.includes(word) ? stemLists.get(word) : undefined
                : datedShorts.includes(word) ? shortLists.get(word) : undefined;
              list?.push(index);
            }
          }
          return { parts: c.count, length: cache.titleLengths.length, lengths: cache.titleLengths.lengths, stems: stemLists, shorts: shortLists };
        };
        /** These parts of the walk as a lane hands them on, their texts read
         *  by key; a part whose row no longer holds it is left out. */
        const heldAll = (
          indexes: readonly number[], extra: (index: number) => Pick<MemoryCandidate, 'signals' | 'laneScore' | 'pastLaneCut'>,
        ): MemoryCandidate[] => {
          const texts = textsOf(indexes);
          const candidates: MemoryCandidate[] = [];
          for (const index of indexes) {
            const text = texts.get(index);
            if (text !== undefined) candidates.push(held(index, text, extra(index)));
          }
          return candidates;
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
            const refs: string[] = [];
            const partFile: number[] = [];
            const walked = corpus;
            const lite: Lite = walked === undefined
              ? { queries: list, similarities: new Float64Array(0), ids: [], refOf: (index) => refs[index]!, partFile, fileRanges: [] }
              : { queries: list, similarities: new Float64Array(0), ids: walked.ids, partFile: walked.partFile,
                fileRanges: walked.fileRanges, refOf: (index) => `${walked.transcripts[index]!}:${walked.ordinals[index]!}` };
            // A walk without the corpus does not know its length: its
            // similarities gather here and are packed at its end.
            const gathered: number[] = [];
            let pending: string[] = [];
            let previous: { file: string; text: string } | undefined;
            const flush = async () => {
              if (pending.length === 0) return;
              const vectors = await embed(pending, request.signal);
              if (vectors.length !== pending.length) throw new TypeError('embed must return one vector per input text.');
              for (const vector of vectors) {
                const unit = normalized(vector, queryVectors[0]!.length);
                for (const query of queryVectors) gathered.push(similarity(unit, query));
              }
              pending = [];
            };
            if (corpus !== undefined) {
              skips.n += corpus.skips;
              const { count, transcripts, ordinals } = corpus;
              // A store hands its vectors out again by key, so only an
              // embedder with no store has each part's unit vector kept
              // for the call, for a later query list to score.
              const stored = 'eachVector' in embed;
              const units_ = walkCache().units;
              if (!stored && units_ !== undefined
                && (units_[0]?.length ?? queryVectors[0]!.length) === queryVectors[0]!.length) {
                lite.similarities = new Float64Array(units_.length * queryVectors.length);
                units_.forEach((unit, index) => queryVectors.forEach((query, at) => {
                  lite.similarities[index * queryVectors.length + at] = similarity(unit, query);
                }));
                return lite;
              }
              const units: Float64Array[] | undefined = stored ? undefined : [];
              // Each part's stored vector key, read a transcript at a time
              // for this pass only.
              const vecs: (string | null)[] = new Array<string | null>(count).fill(null);
              eachRow('vec', (index, row) => { if (row !== undefined) vecs[index] = (row.vec as string | null) ?? null; });
              // A text is read by key only for a part whose vector must be
              // made: the store holds the rest.
              const textAt = database!.prepare('SELECT line, block, piece, text FROM parts WHERE transcript = ? AND ordinal = ?');
              const storedText = (index: number) => {
                const row = textAt.get(transcripts[index]!, ordinals[index]!) as Record<string, unknown> | undefined;
                return row !== undefined && row.line === corpus!.lines[index] && row.block === corpus!.blocks[index]
                  && row.piece === corpus!.pieces[index] ? row.text as string : '';
              };
              // A part embeds with the part before it in the walk when
              // both are in one file.
              const own = (index: number) => {
                const stored = storedText(index);
                return embeddable(stored) ? stored : titleOf(index);
              };
              const follows = (index: number) => index > 0 && corpus!.partFile[index - 1] === corpus!.partFile[index];
              const text = (index: number) => follows(index) ? `${own(index - 1)}\n${own(index)}` : own(index);
              // The stored key holds when the part before it in the walk
              // is the one before it in its transcript.
              const key = (index: number) => {
                const before = follows(index) ? index - 1 : undefined;
                const holds = before === undefined ? ordinals[index] === 0
                  : transcripts[before] === transcripts[index] && ordinals[before] === ordinals[index]! - 1;
                const vec = vecs[index]!;
                return holds && vec !== null ? vec : textKey(text(index));
              };
              lite.similarities = new Float64Array(count * queryVectors.length);
              await eachPartVector(embed, count, key, text, (index, vector) => {
                const unit = normalized(vector, queryVectors[0]!.length);
                if (units !== undefined) units[index] = unit;
                queryVectors.forEach((query, at) => { lite.similarities[index * queryVectors.length + at] = similarity(unit, query); });
              }, request.signal);
              walkCache().units = units;
              return lite;
            }
            for await (const part of each(true, true)) {
              const last = lite.fileRanges.at(-1);
              if (last === undefined || last.file !== part.file) {
                lite.fileRanges.push({ provider: part.provider, root: part.root, file: part.file, start: lite.ids.length });
              }
              partFile.push(lite.fileRanges.length - 1);
              lite.ids.push(idOf(part));
              if ('at' in part) refs.push((part as StoredPart).at);
              const text = /[^\s\p{Cf}]/u.test(part.text) ? part.text : partTitle(part, zone);
              pending.push(previous?.file === part.file ? `${previous.text}\n${text}` : text);
              previous = { file: part.file, text };
              if (pending.length === 32) await flush();
            }
            await flush();
            lite.similarities = Float64Array.from(gathered);
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
          const stride = lite.queries.length;
          const similarities = Array.from({ length: lite.ids.length }, (_, index) => lite!.similarities[index * stride + at]!);
          const { ids, refOf, partFile, fileRanges } = lite;
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
          for await (const [index, part] of corpus === undefined ? keptParts(wanted, fileRanges, refOf) : []) {
            byIndex.set(index, {
              sourceId: id, role: 'reference',
              id: ids[index]!, title: shownTitle(part, zone), text: part.text,
              contentRef: `${part.provider}:${part.sessionId}:${part.line}:${part.block}:${part.piece}`,
              ...chatOf(part, ids[index]!),
              date: dated(part),
              signals: { similarity: similarities[index]! }, laneScore: similarities[index]!,
              ...(mark && !passes(index) ? { pastLaneCut: true as const } : {}),
            });
          }
          const candidates = corpus !== undefined
            ? heldAll(bodies, (index) => ({
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
            status: 'read' as const, candidates, meaningLane: true, ...indexed, ...changed(),
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
          const refs: string[] = [];
          const walkedFiles: number[] = [];
          const partFile: ArrayLike<number> = corpus?.partFile ?? walkedFiles;
          const fileRanges: { provider: ChatProvider; root: string; file: string; start: number }[] = corpus?.fileRanges ?? [];
          if (corpus !== undefined) {
            skips.n += corpus.skips;
            // Every part's stored words count toward the topic's
            // statistics, read a transcript at a time.
            eachRow('long, stems, short', (index, row) => rank.observeStored(titleOf(index), row === undefined
              ? { long: corpus!.longs[index]!, stems: '', short: '' }
              : { long: row.long as number, stems: row.stems as string, short: row.short as string }));
            const indexes = phraseCandidates(request.task);
            const texts = textsOf(indexes);
            for (const index of indexes) {
              const text = texts.get(index);
              if (text === undefined) continue;
              const count = phraseCount(text, request.task) + phraseCount(titleOf(index), request.task);
              if (count > 0 && (request.speakerOnly !== true || corpus.strings[corpus.roles[index]!] === 'user')) matchOf.set(index, count);
            }
          }
          for await (const part of corpus === undefined ? each(true, true) : []) {
            const last = fileRanges.at(-1);
            if (last === undefined || last.file !== part.file) {
              fileRanges.push({ provider: part.provider, root: part.root, file: part.file, start: ids.length });
            }
            walkedFiles.push(fileRanges.length - 1);
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
            const words = wordsOf(matchOf.keys());
            for (const index of matchOf.keys()) {
              rank.scoreStored(titleOf(index), words.get(index) ?? { long: corpus.longs[index]!, stems: '', short: '' },
                { heading: '', name: '', front: '' });
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
          for await (const [index, part] of corpus === undefined ? keptParts(wanted, fileRanges, (index) => refs[index]!) : []) {
            const position = at.get(index)!;
            byIndex.set(index, {
              sourceId: id, role: 'reference',
              id: ids[index]!, title: shownTitle(part, zone), text: part.text,
              contentRef: `${part.provider}:${part.sessionId}:${part.line}:${part.block}:${part.piece}`,
              ...chatOf(part, ids[index]!),
              date: dated(part),
              signals: { keyword: scores[position]!, phrase: matchOf.get(index)! },
              laneScore: base[position]!,
              ...(mark && !passes(index) ? { pastLaneCut: true as const } : {}),
            });
          }
          const candidates = corpus !== undefined
            ? heldAll(kept, (index) => ({
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
            status: 'read' as const, candidates, ...indexed, ...changed(),
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
            const indexes = phraseCandidates(request.task);
            const texts = textsOf(indexes);
            for (const index of indexes) {
              const text = texts.get(index);
              if (text === undefined) continue;
              const count = phraseCount(text, request.task) + phraseCount(titleOf(index), request.task);
              if (count > 0) matched.push(held(index, text, { signals: { phrase: count }, laneScore: count }));
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
                ...chatOf(part, idOf(part)),
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
            status: 'read', candidates: kept, ...indexed, ...changed(),
            complete: reasons.length === 0,
            ...(reasons.length ? { partial: reasons.join('; ') } : {}),
          };
        }

        /** The walk's parts a conversation read finds by key (`ModeParts`):
         *  each made into a candidate once per call, from the walk's
         *  columns and its text read by key when first reached. A part
         *  carries no signals: it was never read by a lane. The pool order
         *  is the order this read would list the parts in: the task's
         *  keyword score, then the id. */
        const walkParts = (): ModeParts => {
          const c = corpus!;
          const path = stored!.path;
          const made = new Map<number, MemoryCandidate>();
          const madeAt = new WeakMap<MemoryCandidate, number>();
          const lazy = lazyParts();
          // The parts whose row still holds them. Apart from the transcript
          // it serves, so the rows it reads are not kept by that
          // transcript's functions.
          const presentIn = (indexes: readonly number[]): Uint32Array => {
            const previous = database;
            database = own();
            try {
              const present = rowsOf(indexes, 'NULL AS none');
              return Uint32Array.from(indexes.filter((index) => present.has(index)));
            } finally {
              database = previous;
            }
          };
          // The lookup's own connection to the index, for its reads by key,
          // open until `close`.
          let lookupDatabase: IndexDatabase | undefined;
          const own = () => lookupDatabase ??= openIndexFileNow(path);
          // The parts made, a few at a time, their texts read on a
          // connection of the lookup's own.
          const pooled = { signals: {}, searchRanks: undefined, poolOnly: true as const };
          const make = (indexes: readonly number[]): (MemoryCandidate | undefined)[] => {
            const wanted = indexes.filter((index) => !made.has(index));
            if (wanted.length > 0) {
              const previous = database;
              database = own();
              try {
                for (const [index, text] of textsOf(wanted)) {
                  const candidate = lazy.make(index, text, pooled);
                  made.set(index, candidate);
                  madeAt.set(candidate, index);
                }
              } finally {
                database = previous;
              }
            }
            return indexes.map((index) => made.get(index));
          };
          // A part whose row another call re-indexed away after the read
          // first found it: made from the walk with no text, and counted
          // as changed, so the call never keeps it.
          const gone = (index: number): MemoryCandidate => {
            const candidate = lazy.gone(index, pooled);
            made.set(index, candidate);
            madeAt.set(candidate, index);
            return candidate;
          };
          // The task's keyword score of every part, as the pool read scores it.
          let scored: Float64Array | undefined;
          const scores = () => {
            if (scored !== undefined) return scored;
            const previous = database;
            database = openIndexFileNow(path);
            try {
              const rank = startChatRank([request.task, ...(request.paths ?? [])].join(' '), options.keyword);
              const { stems, shorts } = rank.postingTerms();
              const postingOf = database.prepare('SELECT transcript, ordinal, count FROM postings WHERE term = ?');
              const fold = (term: string, word: string, short: boolean) => {
                let posting = walkCache().postings.get(term);
                if (posting === undefined) {
                  posting = { index: [], count: [] };
                  for (const row of postingOf.all(term) as { transcript: number; ordinal: number; count: number }[]) {
                    const index = indexAt(row.transcript, row.ordinal);
                    if (index === undefined) continue;
                    posting.index.push(index);
                    posting.count.push(row.count);
                  }
                  walkCache().postings.set(term, posting);
                }
                for (let at = 0; at < posting.index.length; at += 1) rank.posting(posting.index[at]!, word, posting.count[at]!, short);
              };
              for (const term of stems) fold(term, term, false);
              for (const word of shorts) fold(`!${word}`, word, true);
              rank.observeTitles(titleTerms(stems, shorts));
              rank.scoreIndexed({ heading: '', name: '', front: '' });
              scored = Float64Array.from(rank.finish(c.ids, c.places).scores);
            } finally {
              database.close();
              database = previous;
            }
            return scored;
          };
          // A part's transcript as its candidate names it (its id less the
          // line, block and piece). Two transcripts can share the name when
          // a path part was masked as a secret; the read treats them as one.
          let containers: Map<string, number[]> | undefined;
          const spansOf = (container: string) => {
            if (containers === undefined) {
              containers = new Map();
              for (const [start, end] of c.spans.values()) {
                const name = c.ids[start]!.split(':').slice(0, -3).join(':');
                const list = containers.get(name);
                if (list === undefined) containers.set(name, [start, end]);
                else list.push(start, end);
              }
            }
            return containers.get(container) ?? [];
          };
          // The part a candidate is, by its transcript and place in it.
          const indexOf = (part: MemoryCandidate): number | undefined => {
            const own = madeAt.get(part);
            if (own !== undefined) return own;
            const spans = spansOf(part.place?.container ?? '');
            const at = part.place?.at;
            if (at === undefined) return undefined;
            for (let span = 0; span < spans.length; span += 2) {
              for (let index = spans[span]!; index < spans[span + 1]!; index += 1) {
                if (c.lines[index] === at[0] && c.blocks[index] === at[1] && c.pieces[index] === at[2]) return index;
              }
            }
            return undefined;
          };
          const withOrder = (sort: () => Uint32Array): ModeParts => {
            // The pool order, made once: one part number a place.
            let sorted: Uint32Array | undefined;
            const order = () => sorted ??= sort();
            // Each part's place in the pool order, and of parts that share
            // an id (`places` equal) only the first there is a part.
            let placed: Uint32Array | undefined;
            const placeOf = () => {
              if (placed !== undefined) return placed;
              placed = new Uint32Array(c.count);
              order().forEach((index, place) => { placed![index] = place; });
              return placed;
            };
            let firsts: Map<number, number> | undefined;
            const first = (index: number) => {
              if (firsts === undefined) {
                firsts = new Map();
                const places = placeOf();
                for (let at = 1; at < c.byPlace.length; at += 1) {
                  const index = c.byPlace[at]!;
                  const before = c.byPlace[at - 1]!;
                  if (c.places[index] !== c.places[before]) continue;
                  const group = c.places[index]!;
                  const held = firsts.get(group) ?? before;
                  firsts.set(group, places[index]! < places[held]! ? index : held);
                }
              }
              const winner = firsts.get(c.places[index]!);
              return winner === undefined || winner === index;
            };
            const listed = (indexes: readonly number[]) =>
              make(indexes.filter(first)).filter((candidate): candidate is MemoryCandidate => candidate !== undefined);
            // The place of the first part of an id.
            const groupPlace = (index: number) => {
              const winner = (firsts ?? (first(index), firsts))!.get(c.places[index]!);
              return placeOf()[winner ?? index]!;
            };
            return {
              transcript(part) {
                const spans = spansOf(part.place?.container ?? '');
                const indexes: number[] = [];
                for (let span = 0; span < spans.length; span += 2) {
                  for (let index = spans[span]!; index < spans[span + 1]!; index += 1) if (first(index)) indexes.push(index);
                }
                // The parts whose row still holds them, in place order; a
                // part another call re-indexed away is left out and counted.
                const rows = presentIn(indexes).sort((left, right) =>
                  c.lines[left]! - c.lines[right]! || c.blocks[left]! - c.blocks[right]! || c.pieces[left]! - c.pieces[right]!);
                let ties = false;
                for (let at = 1; at < rows.length && !ties; at += 1) {
                  const [left, right] = [rows[at - 1]!, rows[at]!];
                  ties = c.lines[left] === c.lines[right] && c.blocks[left] === c.blocks[right] && c.pieces[left] === c.pieces[right];
                }
                return {
                  length: rows.length,
                  ties,
                  id: (position) => c.ids[rows[position]!]!,
                  part: (position) => listed([rows[position]!])[0] ?? gone(rows[position]!),
                  texts: () => {
                    const before = database;
                    database = own();
                    try {
                      const texts = textsOf(rows);
                      return Array.from(rows, (index) => texts.get(index) ?? '');
                    } finally {
                      database = before;
                    }
                  },
                };
              },
              *person() {
                const places = placeOf();
                const person = c.strings.indexOf('person');
                const indexes: number[] = [];
                for (let index = 0; index < c.count; index += 1) if (c.authors[index] === person) indexes.push(index);
                indexes.sort((left, right) => c.dates[right]! - c.dates[left]! || places[left]! - places[right]!);
                for (let at = 0; at < indexes.length; at += 64) yield* listed(indexes.slice(at, at + 64));
              },
              units() {
                const places = placeOf();
                const agent = c.strings.indexOf('agent');
                const user = c.strings.indexOf('user');
                const indexes: number[] = [];
                for (let index = 0; index < c.count; index += 1) {
                  if (c.marks[index]! >= 0 || (c.authors[index] === agent && c.roles[index] === user)) indexes.push(index);
                }
                return listed(indexes.sort((left, right) => places[left]! - places[right]!));
              },
              place(part) {
                const at = indexOf(part);
                return at === undefined ? Number.POSITIVE_INFINITY : groupPlace(at);
              },
              dealt(laneIds) {
                // The pool order less the parts whose id a lane holds and
                // all but the first part of each id.
                const position = new Int32Array(c.count).fill(-1);
                const seen = new Set<number>();
                let next = 0;
                for (const index of order()) {
                  const group = c.places[index]!;
                  if (seen.has(group)) continue;
                  seen.add(group);
                  if (laneIds.has(c.ids[index]!)) continue;
                  position[index] = next;
                  next += 1;
                }
                return (part) => {
                  const at = indexOf(part);
                  if (at === undefined) return Number.POSITIVE_INFINITY;
                  const own = position[at]!;
                  return own >= 0 ? own : position[(firsts ?? (first(at), firsts))!.get(c.places[at]!) ?? at]!;
                };
              },
              close() {
                lookupDatabase?.close();
                lookupDatabase = undefined;
                lazy.close();
              },
              ordered(compare) {
                return withOrder(() => {
                  const latest = new Map<number, number>();
                  for (let index = 0; index < c.count; index += 1) {
                    const session = c.sessions[index]!;
                    latest.set(session, Math.max(latest.get(session) ?? 0, c.dates[index]!));
                  }
                  const scoreOf = scores();
                  const left = { id: '', score: 0, date: 0, sessionLatest: 0 };
                  const right = { ...left };
                  const fill = (part: { -readonly [key in keyof PoolPart]: PoolPart[key] }, index: number) => {
                    part.id = c.ids[index]!;
                    part.score = scoreOf[index]!;
                    part.date = c.dates[index]!;
                    part.sessionLatest = latest.get(c.sessions[index]!)!;
                    return part;
                  };
                  // Ties `compare` leaves keep the reader's own order: score,
                  // then place, then part number.
                  return Uint32Array.from({ length: c.count }, (_, index) => index).sort((one, other) =>
                    compare(fill(left, one), fill(right, other))
                    || scoreOf[other]! - scoreOf[one]! || c.places[one]! - c.places[other]! || one - other);
                });
              },
            };
          };
          // The reader's own order: scored parts by score, the rest and ties
          // in id order, as the keyword read lists the parts.
          return withOrder(() => {
            const scoreOf = scores();
            return Uint32Array.from({ length: c.count }, (_, index) => index)
              .sort((left, right) => scoreOf[right]! - scoreOf[left]! || c.places[left]! - c.places[right]! || left - right);
          });
        };

        // Pass one enumerates the corpus, pass two scores it, and a
        // third pass reads back only the files that kept a part.
        const rank = startChatRank([request.task, ...(request.paths ?? [])].join(' '), options.keyword);
        let ids: string[];
        let refOf: (index: number) => string = () => '';
        let partFile: ArrayLike<number>;
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
            status: 'read', candidates: [], poolIds: corpus.ids, parts: walkParts(), ...indexed, ...changed(),
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
          const walked = corpus;
          refOf = (index) => `${walked.transcripts[index]!}:${walked.ordinals[index]!}`;
          shared!.keyword ??= { ids: corpus.ids, refOf, partFile: corpus.partFile, fileRanges: corpus.fileRanges,
            titleOf: (index) => titleIn(walked, index), longs: corpus.longs, skips: corpus.skips };
          ({ ids, partFile, fileRanges } = corpus);
          const { stems, shorts } = rank.postingTerms();
          let postingOf: ReturnType<IndexDatabase['prepare']> | undefined;
          const fold = (term: string, word: string, short: boolean) => {
            let posting = walkCache().postings.get(term);
            if (posting === undefined) {
              postingOf ??= database!.prepare('SELECT transcript, ordinal, count FROM postings WHERE term = ?');
              posting = { index: [], count: [] };
              for (const row of postingOf.all(term) as { transcript: number; ordinal: number; count: number }[]) {
                const index = indexAt(row.transcript, row.ordinal);
                if (index === undefined) continue;
                posting.index.push(index);
                posting.count.push(row.count);
              }
              walkCache().postings.set(term, posting);
            }
            for (let at = 0; at < posting.index.length; at += 1) rank.posting(posting.index[at]!, word, posting.count[at]!, short);
          };
          for (const term of stems) fold(term, term, false);
          for (const word of shorts) fold(`!${word}`, word, true);
          rank.observeTitles(titleTerms(stems, shorts));
          rank.scoreIndexed({ heading: '', name: '', front: '' });
        } else if (storedRoots === undefined) {
          ids = [];
          const walkedFiles: number[] = [];
          partFile = walkedFiles;
          fileRanges = [];
          for await (const part of each(true, false)) {
            const last = fileRanges.at(-1);
            if (last === undefined || last.file !== part.file) {
              fileRanges.push({ provider: part.provider, root: part.root, file: part.file, start: ids.length });
            }
            walkedFiles.push(fileRanges.length - 1);
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
            const walkedIds: string[] = [];
            const walkedRefs: string[] = [];
            const walkedFiles: number[] = [];
            const walkedRanges: { provider: ChatProvider; root: string; file: string; start: number }[] = [];
            const titles: string[] = [];
            const longs: number[] = [];
            const before = skips.n;
            for await (const part of each(true, false, true)) {
              const last = walkedRanges.at(-1);
              if (last === undefined || last.file !== part.file) {
                walkedRanges.push({ provider: part.provider, root: part.root, file: part.file, start: walkedIds.length });
              }
              walkedFiles.push(walkedRanges.length - 1);
              walkedRefs.push((part as StoredPart).at);
              titles.push(partTitle(part, zone));
              longs.push((part as StoredPart).words.long);
              walkedIds.push(idOf(part));
            }
            held = { ids: walkedIds, refOf: (index) => walkedRefs[index]!, partFile: walkedFiles, fileRanges: walkedRanges,
              titleOf: (index) => titles[index]!, longs, skips: skips.n - before };
            if (shared !== undefined) shared.keyword = held;
          } else {
            skips.n += held.skips;
          }
          ({ ids, refOf, partFile, fileRanges } = held);
          const { stems, shorts } = rank.postingTerms();
          const indexOf = new Map(ids.map((_, index) => [held!.refOf(index), index] as const));
          const postingOf = database!.prepare('SELECT transcript, ordinal, count FROM postings WHERE term = ?');
          const fold = (term: string, word: string, short: boolean) => {
            for (const row of postingOf.all(term) as { transcript: number; ordinal: number; count: number }[]) {
              const index = indexOf.get(`${row.transcript}:${row.ordinal}`);
              if (index !== undefined) rank.posting(index, word, row.count, short);
            }
          };
          for (const term of stems) fold(term, term, false);
          for (const word of shorts) fold(`!${word}`, word, true);
          for (let index = 0; index < ids.length; index += 1) rank.observeIndexed(index, held.titleOf(index), held.longs[index]!);
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
        for await (const [index, part] of corpus === undefined ? keptParts(wanted, fileRanges, refOf) : []) {
          byIndex.set(index, {
            sourceId: id, role: 'reference',
            id: ids[index]!, title: shownTitle(part, zone), text: part.text,
            contentRef: `${part.provider}:${part.sessionId}:${part.line}:${part.block}:${part.piece}`,
            ...chatOf(part, ids[index]!),
            date: dated(part),
            signals: { keyword: scores[index]! }, laneScore: base[index]!,
            ...(mark && !passes(index) ? { pastLaneCut: true as const } : {}),
          });
        }
        // A transcript that shrank mid-read leaves a kept index with no
        // part to materialize; it simply emits fewer.
        const candidates = corpus !== undefined
          ? heldAll(kept, (index) => ({
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
          status: 'read', candidates, ...indexed, ...changed(),
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
  return historySource({ reader, ...chatSettings, mode: options.mode ?? agentTranscripts });
}
