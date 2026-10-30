import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';

import {
  canonicalPath, phraseCount, laneBend, embedQuery, embedSimilarities, sinceCutoff, taskMoment, timeZoneOf,
  zonedIso,
} from '@curatejs/core/internal';
import { startChatRank, type ChatKeywordSettings } from './chat-rank.js';
import { scrubChat } from './chat-scrub.js';
import { DEFAULT_MAX_QUESTION_TEXT, type MemoryCandidate } from '@curatejs/core';
import { historySource, SourceReadError, type CandidateReadRequest, type CandidateSource } from '@curatejs/core';
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

/** The parts of one transcript, decoded and split but never kept. Each
 *  pass over the history reads the file again rather than holding the
 *  parts of every file at once. */
async function* fileParts(
  provider: ChatProvider, root: string, file: string, walk: WalkContext,
): AsyncGenerator<RawPart> {
  const raw = await readFile(file, { encoding: 'utf8', signal: walk.signal });
  let sessionId = basename(file, '.jsonl').replace(/^rollout-.*T\d{2}-\d{2}-\d{2}-/, '');
  const lines = raw.split(/\r?\n/);
  const session: Json = {};
  for (const [lineIndex, line] of lines.entries()) {
    cancelled(walk.signal);
    if (!line.trim()) continue;
    let record: Json;
    try { record = object(JSON.parse(line)); } catch {
      // JSON errors can contain the transcript text. Never copy them.
      throw new SourceReadError('failed', 'Invalid JSON in a chat transcript.');
    }
    const decoded = READERS[provider].decode(record, walk.includeTools, session);
    sessionId = scrubChat(decoded.sessionId ?? sessionId);
    const date = Date.parse(decoded.date ?? '');
    if (!decoded.parts.length) continue;
    if (!Number.isFinite(date)) { if (walk.countSkips) walk.countSkips.n += 1; continue; }
    if (date < walk.since || date > walk.until) continue;
    for (const [block, part] of decoded.parts.entries()) {
      const text = scrubChat(part.text);
      if (!text.trim()) continue;
      for (const [piece, textPart] of split(text, walk.size).entries()) {
        yield {
          provider, root, file,
          line: lineIndex + 1, block: block + 1, piece: piece + 1,
          sessionId, role: part.role, author: part.author,
          ...(part.authorName === undefined ? {} : { authorName: scrubChat(part.authorName) }),
          date, text: textPart,
        };
      }
    }
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
  const reader: CandidateSource = {
    id, kind: 'chat', role: 'reference',
    ...(options.since === undefined ? {} : { since: options.since }),
    ...(exclude === undefined ? {} : { exclude }),
    async read(request: CandidateReadRequest) {
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
          size, since, until, includeTools: options.includeTools === true,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        };

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
          for await (const part of eachPart(walkable, exclusions, { ...ctx, countSkips: skips })) {
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
            for await (const part of fileParts(range.provider, range.root, range.file, ctx)) {
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
            status: 'read' as const, candidates, meaningLane: true,
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
          for await (const part of eachPart(walkable, exclusions, { ...ctx, countSkips: skips })) {
            const last = fileRanges.at(-1);
            if (last === undefined || last.file !== part.file) {
              fileRanges.push({ provider: part.provider, root: part.root, file: part.file, start: ids.length });
            }
            partFile.push(fileRanges.length - 1);
            ids.push(partId(part));
            rank.observe(`${partTitle(part, zone)} ${part.text}`);
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
            for await (const part of fileParts(range.provider, range.root, range.file, ctx)) {
              if (index >= end) break;
              if (matchOf.has(index)) {
                rank.score(`${partTitle(part, zone)} ${part.text}`, { heading: '', name: '', front: '' });
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
            for await (const part of fileParts(range.provider, range.root, range.file, ctx)) {
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
            status: 'read' as const, candidates,
            complete: reasons.length === 0,
            ...(reasons.length ? { partial: reasons.join('; ') } : {}),
            ...(cut ? { laneCutApplied: true as const, matched: order.length } : {}),
          };
        }

        // A phrase lane matches its exact phrase and keeps the
        // matching parts; the corpus is never scored.
        if (request.phraseLane === true) {
          const matched: MemoryCandidate[] = [];
          for await (const part of eachPart(walkable, exclusions, { ...ctx, countSkips: skips })) {
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
            status: 'read', candidates: kept,
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
        for await (const part of eachPart(walkable, exclusions, { ...ctx, countSkips: skips })) {
          const last = fileRanges.at(-1);
          if (last === undefined || last.file !== part.file) {
            fileRanges.push({ provider: part.provider, root: part.root, file: part.file, start: ids.length });
          }
          partFile.push(fileRanges.length - 1);
          ids.push(partId(part));
          rank.observe(`${partTitle(part, zone)} ${part.text}`);
        }
        // Pass two scores each part against the first pass's statistics.
        // Files are walked per transcript so a file grown mid-read can
        // only append: parts past the first pass's count are skipped
        // and a shrunk file simply scores fewer.
        for (const [rangeIndex, range] of fileRanges.entries()) {
          const end = fileRanges[rangeIndex + 1]?.start ?? ids.length;
          let index = range.start;
          for await (const part of fileParts(range.provider, range.root, range.file, ctx)) {
            if (index >= end) break;
            rank.score(`${partTitle(part, zone)} ${part.text}`, { heading: '', name: '', front: '' });
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
          for await (const part of fileParts(range.provider, range.root, range.file, ctx)) {
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
          status: 'read', candidates,
          complete: reasons.length === 0,
          ...(reasons.length ? { partial: reasons.join('; ') } : {}),
          ...(cut ? { laneCutApplied: true, matched: limited.length } : {}),
        };
      } catch (error) {
        if (error instanceof SourceReadError) throw error;
        if (request.signal?.aborted) throw new SourceReadError('cancelled', 'The read was cancelled.');
        throw new SourceReadError('failed', 'Could not read a chat transcript folder or file.');
      }
    },
  };
  return historySource({ reader, ...chatSettings, questions: AGENT_CHAT_CASCADE });
}
