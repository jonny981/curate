import { createHash } from 'node:crypto';
import { lstat, open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';

import {
  canonicalPath, phraseCount, laneBend, embedQuery, embedSimilarities, sinceCutoff, taskMoment, timeZoneOf,
  zonedIso, checkIndexOption, indexDirectory, indexFilePath, openIndexFile, updateIndex,
  type IndexDatabase, type StoredIndexOptions, type StoredIndexReport,
} from '@curatejs/core/internal';
import {
  startChatRank, storedChatWords, CHAT_KEYWORD_SETTINGS, type ChatKeywordSettings, type ChatRankSession,
  type StoredChatWords,
} from './chat-rank.js';
import { scrubChat } from './chat-scrub.js';
import { DEFAULT_MAX_QUESTION_TEXT, type MemoryCandidate } from '@curatejs/core';
import {
  historySource, SourceReadError, type CandidateReadContext, type CandidateReadRequest, type CandidateSource,
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

const partId = (part: RawPart) =>
  scrubChat(`${part.provider}:${part.root}:${relative(part.root, part.file)}:${part.line}:${part.block}:${part.piece}`);
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

/** A part read from the stored index: a transcript part and its text's
 *  stored words. Its text is empty on a pass that never reads text. */
type StoredPart = RawPart & { readonly words: StoredChatWords };

/** One transcript the stored index holds. */
interface StoredTranscript {
  readonly file: string;
  /** Its row in the file. */
  readonly id: number;
  /** Records with text but no date, which the reader skips. */
  readonly undated: number;
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
    root INTEGER NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, mtime TEXT NOT NULL, lines INTEGER NOT NULL,
    head TEXT NOT NULL, tail TEXT NOT NULL, newline INTEGER NOT NULL, state TEXT NOT NULL, undated INTEGER NOT NULL,
    parts INTEGER NOT NULL, UNIQUE (provider, root, path));
  CREATE TABLE IF NOT EXISTS parts (transcript INTEGER NOT NULL, ordinal INTEGER NOT NULL, line INTEGER NOT NULL,
    block INTEGER NOT NULL, piece INTEGER NOT NULL, session TEXT NOT NULL, role TEXT NOT NULL, author TEXT NOT NULL,
    author_name TEXT, date INTEGER NOT NULL, text TEXT NOT NULL, long INTEGER NOT NULL, stems TEXT NOT NULL,
    short TEXT NOT NULL, PRIMARY KEY (transcript, ordinal)) WITHOUT ROWID;`;

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
      const deleteParts = database.prepare('DELETE FROM parts WHERE transcript = ?');
      const insertPart = database.prepare(`INSERT INTO parts (transcript, ordinal, line, block, piece, session, role,
        author, author_name, date, text, long, stems, short) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertRow = database.prepare(`INSERT INTO transcripts (provider, root, path, size, mtime, lines, head, tail,
        newline, state, undated, parts) VALUES (?, ?, ?, ?, ?, ?, '', '', 0, '', 0, 0)`);
      const updateRow = database.prepare(`UPDATE transcripts SET size = ?, mtime = ?, lines = ?, head = ?, tail = ?,
        newline = ?, state = ?, undated = ?, parts = ? WHERE id = ?`);
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
            transcripts.push({ file, id: row.id, undated: row.undated });
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
              removed += row.parts;
            }
          }
          const id = row?.id ?? Number(insertRow.run(provider, slot, rel, 0, '', 0).lastInsertRowid);
          const text = bytes.toString('utf8');
          const lines = text.split(/\r?\n/);
          let ordinal = start;
          for (const part of decodeLines(provider, lines, firstLine, state, includeTools, size, signal, () => { undated += 1; })) {
            const words = storedChatWords(part.text, keyword);
            insertPart.run(id, ordinal++, part.line, part.block, part.piece, part.sessionId, part.role, part.author,
              part.authorName ?? null, part.date, part.text, words.long, words.stems, words.short);
          }
          added += ordinal - start;
          // The stored size counts only the bytes read: a file that grew
          // while it was read is read on from there next call.
          updateRow.run(appending ? row!.size + bytes.length : bytes.length, mtime, firstLine + lines.length - 1,
            appending ? row!.head : digest(bytes.subarray(0, Math.min(EDGE_CHECK, bytes.length))),
            digest(window!.subarray(Math.max(0, window!.length - EDGE_CHECK))), text.endsWith('\n') ? 1 : 0,
            JSON.stringify(state), undated, ordinal, id);
          transcripts.push({ file, id, undated });
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
        database.prepare('DELETE FROM transcripts WHERE id = ?').run(row.id);
        removed += row.parts;
      }
      const total = (database.prepare('SELECT COUNT(*) AS n FROM parts').get() as { n: number }).n;
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
): Generator<StoredPart> {
  const rows = database.prepare(`SELECT line, block, piece, session, role, author, author_name, date,
    ${withText ? 'text' : "'' AS text"}, long, stems, short FROM parts WHERE transcript = ? ORDER BY ordinal`)
    .all(transcript.id) as Record<string, unknown>[];
  for (const row of rows) {
    yield {
      provider, root, file: transcript.file,
      line: row.line as number, block: row.block as number, piece: row.piece as number,
      sessionId: row.session as string, role: row.role as MessageRole, author: row.author as Author,
      ...(row.author_name === null ? {} : { authorName: row.author_name as string }),
      date: row.date as number, text: row.text as string,
      words: { long: row.long as number, stems: row.stems as string, short: row.short as string },
    };
  }
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
    directory: string, size: number, requested: readonly string[], context: object | undefined,
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
    const path = indexFilePath(directory, id, {
      includeTools, size, exclude: exclude ?? [], stem: { ...CHAT_KEYWORD_SETTINGS, ...options.keyword }.stem,
    });
    const walk = (root: string, exclusions: readonly string[]) => {
      if (context === undefined) return walkTranscripts(root, exclusions, signal);
      let byRoot = walks.get(context);
      if (byRoot === undefined) walks.set(context, byRoot = new Map());
      const key = JSON.stringify([root, exclusions]);
      let walking = byRoot.get(key);
      if (walking === undefined) byRoot.set(key, walking = walkTranscripts(root, exclusions, signal));
      return walking;
    };
    return syncChatIndex(path, directory, found, own, requested, includeTools, size, options.keyword, signal, walk);
  };
  const storedIndex = async (
    size: number, requestExclude: readonly string[], context: object | undefined, signal: AbortSignal | undefined,
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
        const each = (counting: boolean, withText: boolean): AsyncIterable<RawPart> | Iterable<RawPart> =>
          storedRoots === undefined
            ? eachPart(walkable, exclusions, counting ? { ...ctx, countSkips: skips } : ctx)
            : (function* () {
                for (const { provider, root, transcripts, symlinks } of storedRoots) {
                  if (counting) skips.n += symlinks;
                  for (const transcript of transcripts) {
                    cancelled(request.signal);
                    if (counting) skips.n += transcript.undated;
                    for (const part of storedParts(database!, provider, root, transcript, withText)) {
                      if (inDates(part)) yield part;
                    }
                  }
                }
              })();
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
        const observe = (rank: ChatRankSession, part: RawPart) => 'words' in part
          ? rank.observeStored(partTitle(part, zone), (part as StoredPart).words)
          : rank.observe(`${partTitle(part, zone)} ${part.text}`);
        const score = (rank: ChatRankSession, part: RawPart) => 'words' in part
          ? rank.scoreStored(partTitle(part, zone), (part as StoredPart).words, { heading: '', name: '', front: '' })
          : rank.score(`${partTitle(part, zone)} ${part.text}`, { heading: '', name: '', front: '' });

        // A meaning lane embeds each part in bounded batches and keeps
        // the parts the similarity curve keeps: the corpus's text is
        // never held, and no keyword statistics pass is needed.
        if (request.meaningLane !== undefined) {
          const embed = request.meaningLane.embed;
          const query = await embedQuery(embed, request.task, request.signal);
          const similarities: number[] = [];
          const ids: string[] = [];
          const partFile: number[] = [];
          const fileRanges: { provider: ChatProvider; root: string; file: string; start: number }[] = [];
          let pending: string[] = [];
          let previous: { file: string; text: string } | undefined;
          const flush = async () => {
            if (pending.length === 0) return;
            const scores = await embedSimilarities(embed, query, pending, request.signal);
            similarities.push(...scores);
            pending = [];
          };
          for await (const part of each(true, true)) {
            const last = fileRanges.at(-1);
            if (last === undefined || last.file !== part.file) {
              fileRanges.push({ provider: part.provider, root: part.root, file: part.file, start: ids.length });
            }
            partFile.push(fileRanges.length - 1);
            ids.push(partId(part));
            const text = /[^\s\p{Cf}]/u.test(part.text) ? part.text : partTitle(part, zone);
            pending.push(previous?.file === part.file ? `${previous.text}\n${text}` : text);
            previous = { file: part.file, text };
            if (pending.length === 32) await flush();
          }
          await flush();
          const order = ids.map((_, index) => index)
            .sort((a, b) => (similarities[b] ?? 0) - (similarities[a] ?? 0) || ids[a]!.localeCompare(ids[b]!));
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
          const wanted = new Map<number, Set<number>>();
          for (const index of limited) {
            const file = partFile[index]!;
            const bucket = wanted.get(file);
            if (bucket === undefined) wanted.set(file, new Set([index]));
            else bucket.add(index);
          }
          const byIndex = new Map<number, MemoryCandidate>();
          for (const [fileIndex, indexes] of wanted) {
            const range = fileRanges[fileIndex]!;
            let local = range.start;
            for await (const part of partsOf(range, true)) {
              const index = local++;
              if (!indexes.has(index)) continue;
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
          }
          const candidates = limited.map((index) => byIndex.get(index))
            .filter((candidate): candidate is MemoryCandidate => candidate !== undefined);
          if (skips.n) reasons.push(`skipped ${skips.n} symbolic links or undated messages`);
          if (limited.length < order.length) {
            reasons.push(`the limit kept ${limited.length} of ${order.length} candidates`);
          }
          return {
            status: 'read' as const, candidates, meaningLane: true, ...indexed,
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
          const ids: string[] = [];
          const partFile: number[] = [];
          const fileRanges: { provider: ChatProvider; root: string; file: string; start: number }[] = [];
          for await (const part of each(true, true)) {
            const last = fileRanges.at(-1);
            if (last === undefined || last.file !== part.file) {
              fileRanges.push({ provider: part.provider, root: part.root, file: part.file, start: ids.length });
            }
            partFile.push(fileRanges.length - 1);
            ids.push(partId(part));
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
          for (const fileIndex of fileRanges.keys()) {
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
          for (const [fileIndex, indexes] of wanted) {
            const range = fileRanges[fileIndex]!;
            let local = range.start;
            for await (const part of partsOf(range, true)) {
              const index = local++;
              if (!indexes.has(index)) continue;
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
          }
          const candidates = kept.map((index) => byIndex.get(index))
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
          for await (const part of each(true, true)) {
            const title = partTitle(part, zone);
            const count = phraseCount(part.text, request.task) + phraseCount(title, request.task);
            if (count > 0) {
              matched.push({
                sourceId: id, role: 'reference',
                id: partId(part), title: shownTitle(part, zone), text: part.text,
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

        // Pass one: corpus statistics. Pass two: per-part scores. Pass
        // three reads back only the files that kept a part.
        const rank = startChatRank([request.task, ...(request.paths ?? [])].join(' '), options.keyword);
        const ids: string[] = [];
        const partFile: number[] = [];
        const fileRanges: { provider: ChatProvider; root: string; file: string; start: number }[] = [];
        for await (const part of each(true, false)) {
          const last = fileRanges.at(-1);
          if (last === undefined || last.file !== part.file) {
            fileRanges.push({ provider: part.provider, root: part.root, file: part.file, start: ids.length });
          }
          partFile.push(fileRanges.length - 1);
          ids.push(partId(part));
          observe(rank, part);
        }
        // Pass two scores each part against the first pass's statistics.
        // Files are walked per transcript so a file grown mid-read can
        // only append: parts past the first pass's count are skipped
        // and a shrunk file simply scores fewer.
        for (const [rangeIndex, range] of fileRanges.entries()) {
          const end = fileRanges[rangeIndex + 1]?.start ?? ids.length;
          let index = range.start;
          for await (const part of partsOf(range, false)) {
            if (index >= end) break;
            score(rank, part);
            index += 1;
          }
        }
        const { scores, base } = rank.finish(ids);
        const order = ids.map((_, index) => index)
          .filter((index) => index < scores.length)
          .sort((a, b) => scores[b]! - scores[a]! || ids[a]!.localeCompare(ids[b]!));
        const limited = request.limit === undefined ? order : order.slice(0, request.limit);
        // A bare read keeps every scored part; only a lane the pick
        // resolved with `wholeLanes: false` narrows inside the read. A
        // cut lane where nothing scored above zero matched nothing: it
        // keeps no parts rather than read back every body.
        const cut = request.wholeLanes === false;
        // With `wholeLanes` on the read keeps every part and marks each
        // one the cut would have dropped.
        const mark = request.wholeLanes === true;
        const bend = cut || mark ? laneBend(limited.map((index) => base[index]!)) : undefined;
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
        for (const [fileIndex, indexes] of wanted) {
          const range = fileRanges[fileIndex]!;
          let local = range.start;
          for await (const part of partsOf(range, true)) {
            const index = local++;
            if (!indexes.has(index)) continue;
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
        }
        // A transcript that shrank mid-read leaves a kept index with no
        // part to materialize; it simply emits fewer.
        const candidates = kept.map((index) => byIndex.get(index))
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
  return historySource({ reader, ...chatSettings, questions: AGENT_CHAT_CASCADE });
}
