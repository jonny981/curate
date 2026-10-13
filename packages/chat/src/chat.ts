import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';

import { canonicalPath } from '@curatejs/core/internal';
import { rankChat, type ChatKeywordSettings } from './chat-rank.js';
import { scrubChat } from './chat-scrub.js';
import { DEFAULT_MAX_QUESTION_TEXT, type MemoryCandidate } from '@curatejs/core';
import { SourceReadError, type CandidateReadRequest, type CandidateSource } from '@curatejs/core';

export type ChatProvider = 'claude-code' | 'codex';

export interface ChatOptions {
  /** Override the exported CHAT_KEYWORD_SETTINGS. */
  readonly keyword?: Partial<ChatKeywordSettings>;
  readonly id?: string;
  /** Defaults to both providers. */
  readonly providers?: readonly ChatProvider[];
  /** Folders to scan instead of each provider's default folder. */
  readonly paths?: readonly string[];
  /** Include messages at or after an ISO date or a duration before read
   * start (for example, '14 days'). Omitted means all messages. */
  readonly since?: string;
  readonly includeTools?: boolean;
  /** Tightens the 700-character part size, as does the read request. */
  readonly maxQuestionText?: number;
}

type Json = Record<string, unknown>;
type MessageRole = NonNullable<MemoryCandidate['chat']>['role'];
interface Part { role: MessageRole; text: string }
interface Decoded { sessionId?: string; date?: string; parts: Part[] }
interface ProviderReader {
  readonly folder: string;
  decode(record: Json, includeTools: boolean): Decoded;
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

const READERS: Record<ChatProvider, ProviderReader> = {
  'claude-code': {
    folder: join(homedir(), '.claude', 'projects'),
    decode(record, includeTools) {
      const role = record.type;
      const parts: Part[] = [];
      if (role === 'user' || role === 'assistant') {
        const content = object(record.message).content;
        if (typeof content === 'string') parts.push({ role, text: content });
        else if (Array.isArray(content)) for (const value of content) {
          const block = object(value);
          if (block.type === 'text' && typeof block.text === 'string') parts.push({ role, text: block.text });
          if (includeTools && block.type === 'tool_use') {
            parts.push({ role: 'tool-call', text: `${string(block.name) ?? 'tool'}\n${toolText(block.input ?? {})}` });
          }
          if (includeTools && block.type === 'tool_result') {
            parts.push({ role: 'tool-result', text: resultText(block.content) });
          }
        }
      }
      return { sessionId: string(record.sessionId), date: string(record.timestamp), parts };
    },
  },
  codex: {
    folder: join(homedir(), '.codex', 'sessions'),
    decode(record, includeTools) {
      const payload = object(record.payload);
      const parts: Part[] = [];
      if (record.type === 'response_item') {
        const role = payload.role;
        if (payload.type === 'message' && (role === 'user' || role === 'assistant') && Array.isArray(payload.content)) {
          for (const value of payload.content) {
            const block = object(value);
            if ((block.type === 'input_text' || block.type === 'output_text' || block.type === 'text')
              && typeof block.text === 'string') parts.push({ role, text: block.text });
          }
        }
        if (includeTools && (payload.type === 'function_call' || payload.type === 'custom_tool_call')) {
          parts.push({ role: 'tool-call', text: `${string(payload.name) ?? 'tool'}\n${toolText(payload.arguments ?? payload.input ?? '')}` });
        }
        if (includeTools && (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output')) {
          parts.push({ role: 'tool-result', text: resultText(payload.output) });
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

function cutoff(since: string | undefined, now: number): number {
  if (since === undefined) return Number.NEGATIVE_INFINITY;
  const duration = /^(\d+(?:\.\d+)?)\s+(seconds?|minutes?|hours?|days?|weeks?)$/i.exec(since.trim());
  if (duration) {
    const units: Record<string, number> = { second: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 };
    const value = now - Number(duration[1]) * units[duration[2]!.toLowerCase().replace(/s$/, '')]!;
    if (Number.isFinite(value)) return value;
  }
  const value = /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(since) ? Date.parse(since) : NaN;
  if (!Number.isFinite(value)) throw new TypeError('since must be an ISO date or a duration such as "14 days".');
  return value;
}

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

/** Local JSONL transcripts. Each provider decodes its own message format;
 * text is scrubbed before it is split, scored or returned. */
export function chat(options: ChatOptions = {}): CandidateSource {
  const providers = [...new Set(options.providers ?? ['claude-code', 'codex'] as const)];
  if (!providers.length || providers.some((provider) => !Object.hasOwn(READERS, provider))) {
    throw new TypeError('providers must contain claude-code or codex.');
  }
  const roots = new Map(providers.map((provider) => [provider, [...new Set((options.paths ?? [READERS[provider].folder]).map((path) => resolve(path)))]]));
  if (options.paths?.length === 0 || options.paths?.some((path) => !path.trim())) throw new TypeError('paths must contain directory paths.');
  const budget = positive(options.maxQuestionText ?? DEFAULT_MAX_QUESTION_TEXT, 'maxQuestionText');
  cutoff(options.since, Date.now());
  const id = scrubChat(options.id ?? `chat:${providers.map((provider) => `${provider}:${roots.get(provider)!.join(',')}`).join(';')}`);
  return {
    id, kind: 'chat', role: 'reference',
    async read(request: CandidateReadRequest) {
      cancelled(request.signal);
      const size = Math.min(DEFAULT_MAX_QUESTION_TEXT, budget, positive(request.maxQuestionText ?? DEFAULT_MAX_QUESTION_TEXT, 'maxQuestionText'));
      if (request.limit !== undefined) positive(request.limit, 'limit');
      if (request.revision !== undefined) return { status: 'absent', reason: 'chat-does-not-support-revisions' };
      const since = cutoff(options.since, Date.now());
      const candidates: MemoryCandidate[] = [];
      const reasons: string[] = [];
      let folders = 0;
      let skipped = 0;
      try {
        const exclusions = await Promise.all((request.exclude ?? []).map(async (entry) =>
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
          if (info.isSymbolicLink()) { skipped++; continue; }
          if (!info.isDirectory()) { reasons.push(`missing ${provider} folder`); continue; }
          folders++;
          const root = await realpath(directory);
          const walk = async (path: string): Promise<void> => {
            cancelled(request.signal);
            if (excluded(path, root, exclusions)) return;
            const entries = await readdir(path, { withFileTypes: true });
            entries.sort((a, b) => a.name.localeCompare(b.name));
            for (const entry of entries) {
              const file = join(path, entry.name);
              if (excluded(file, root, exclusions)) continue;
              if (entry.isSymbolicLink()) { skipped++; continue; }
              if (entry.isDirectory()) { await walk(file); continue; }
              if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
              cancelled(request.signal);
              const raw = await readFile(file, { encoding: 'utf8', signal: request.signal });
              let sessionId = basename(file, '.jsonl').replace(/^rollout-.*T\d{2}-\d{2}-\d{2}-/, '');
              const lines = raw.split(/\r?\n/);
              for (const [lineIndex, line] of lines.entries()) {
                cancelled(request.signal);
                if (!line.trim()) continue;
                let record: Json;
                try { record = object(JSON.parse(line)); } catch {
                  // JSON errors can contain the transcript text. Never copy them.
                  throw new SourceReadError('failed', 'Invalid JSON in a chat transcript.');
                }
                const decoded = READERS[provider].decode(record, options.includeTools === true);
                sessionId = scrubChat(decoded.sessionId ?? sessionId);
                const date = Date.parse(decoded.date ?? '');
                if (!decoded.parts.length) continue;
                if (!Number.isFinite(date)) { skipped++; continue; }
                if (date < since) continue;
                for (const [block, part] of decoded.parts.entries()) {
                  const text = scrubChat(part.text);
                  if (!text.trim()) continue;
                  for (const [piece, textPart] of split(text, size).entries()) {
                    candidates.push({
                      sourceId: id, role: 'reference',
                      id: scrubChat(`${provider}:${root}:${relative(root, file)}:${lineIndex + 1}:${block + 1}:${piece + 1}`),
                      title: `${provider} ${sessionId} ${part.role} ${new Date(date).toISOString()}`,
                      text: textPart,
                      contentRef: `${provider}:${sessionId}:${lineIndex + 1}:${block + 1}:${piece + 1}`,
                      chat: { provider, sessionId, role: part.role },
                      date: { value: new Date(date).toISOString(), meaning: 'recorded' },
                      signals: {},
                    });
                  }
                }
              }
            }
          };
          await walk(root);
        }
      } catch (error) {
        if (error instanceof SourceReadError) throw error;
        if (request.signal?.aborted) throw new SourceReadError('cancelled', 'The read was cancelled.');
        throw new SourceReadError('failed', 'Could not read a chat transcript folder or file.');
      }
      if (!folders && reasons.length) return { status: 'absent', reason: 'no-chat-folders' };
      const ranked = candidates.map((candidate) => ({ id: candidate.id, title: candidate.title, text: candidate.text, heading: '', name: '', front: '', score: 0 }));
      rankChat(ranked, [request.task, ...(request.paths ?? [])].join(' '), options.keyword);
      const scores = new Map(ranked.map((part) => [part.id, part.score]));
      const scored = candidates.map((candidate) => ({ ...candidate, signals: { keyword: scores.get(candidate.id)! } }))
        .sort((a, b) => b.signals.keyword - a.signals.keyword || a.id.localeCompare(b.id));
      if (skipped) reasons.push(`skipped ${skipped} symbolic links or undated messages`);
      if (request.limit !== undefined && scored.length > request.limit) reasons.push(`the limit kept ${request.limit} of ${scored.length} candidates`);
      return {
        status: 'read', candidates: request.limit === undefined ? scored : scored.slice(0, request.limit),
        complete: reasons.length === 0,
        ...(reasons.length ? { partial: reasons.join('; ') } : {}),
      };
    },
  };
}
