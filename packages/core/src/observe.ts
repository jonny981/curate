import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CuratePrompt, CurateWrite } from './curate.js';
import { candidateDocument } from './document.js';
import { checkLog, logPatterns } from './log-format.js';
import type { MemoryCandidate } from './pick.js';

/** The instruction version mixed into every store key and record; it
 *  changes when the observation ask changes. */
export const OBSERVE_INSTRUCTION_VERSION = 'observe-1';

/** A caller's store for written observations: asynchronous get and set
 *  with JSON-serialisable values. A failed or missing read is a miss,
 *  never a crash; a failed write keeps the lines and records a warning. */
export interface ObserveStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export interface ObserveOptions {
  readonly write: CurateWrite;
  /** The caller's name for its writer route: the model, prompt build
   *  or plan the lines were written with. Mixed into every store key:
   *  a different writerId never reuses stored lines. */
  readonly writerId: string;
  /** Reuse written lines across calls. Omit `store` and `directory`
   *  together and every session is written on each call. */
  readonly store?: ObserveStore;
  /** The plain-file store: one JSON file per session under this
   *  directory, each written to a temporary file and renamed into
   *  place. A missing, corrupt or wrong-shaped entry is a miss.
   *  Cannot combine with `store`. */
  readonly directory?: string;
  /** The instruction version keyed and recorded; defaults to the
   *  package's own version. A different version never reuses lines. */
  readonly instructionVersion?: string;
  /** Pack whole sessions into one writer call within about this many
   *  estimated tokens of evidence. Evidence is estimated at four
   *  characters a token. Request size only: a session larger than the
   *  budget goes alone and no session is split or dropped. Omit for
   *  one call per session. */
  readonly batchTokens?: number;
  readonly signal?: AbortSignal;
}

export interface ObserveSessionRecord {
  /** The session's name: its documentId, chat sessionId, note path or
   *  item id. */
  readonly session: string;
  /** Parts the session held. */
  readonly parts: number;
  /** 'written': the writer supplied the lines this call. 'reused': the
   *  store held checked lines. 'failed': the writer's lines failed the
   *  format check twice, so the session's raw parts stand in as
   *  candidates instead. */
  readonly outcome: 'written' | 'reused' | 'failed';
  /** Checked observation lines the session produced; 0 when failed or
   *  when the writer answered that the session holds no facts. */
  readonly lines: number;
  /** Why the session fell back to raw parts, or why its lines were not
   *  stored. */
  readonly warning?: string;
}

export interface ObserveRecord {
  readonly instructionVersion: string;
  readonly writerId: string;
  /** Every call to the writer: first tries plus repairs. */
  readonly calls: number;
  /** Writer replies sent back once for format. */
  readonly repairs?: number;
  /** The estimated token budget sessions were packed into, when supplied. */
  readonly batchTokens?: number;
  readonly sessions: readonly ObserveSessionRecord[];
}

export interface ObserveSessionResult {
  /** The session's name, as in the record. */
  readonly session: string;
  /** The session's parts, in input order. */
  readonly parts: readonly MemoryCandidate[];
  /** The checked observation lines, in reply order; empty when the
   *  session failed or holds no facts. */
  readonly lines: readonly string[];
  readonly outcome: 'written' | 'reused' | 'failed';
}

export interface ObserveResult {
  readonly sessions: readonly ObserveSessionResult[];
  readonly record: ObserveRecord;
}

const OBSERVE_INSTRUCTIONS = [
  'You write a dated observation log for a person or an agent: a session is read once and later tasks select lines from the log. You get evidence items, each with an id and a date. No question is given, so keep every fact a later question could need.',
  'Rewrite the session as a log of observations, oldest first, one line each:',
  '[YYYY-MM-DD the event happened] the observation, with its exact names, numbers and amounts (said YYYY-MM-DD; the full item id from its header)',
  '- The "said" date is the date in the item header. Work out when the event happened from it: "last Saturday" said on 2023-05-20 happened on 2023-05-13. When the item gives no time for the event, use the said date and write "(when not stated)". Never shift a date that is already absolute.',
  '- One line per fact: never merge two facts into one line and never drop a fact. When two items tell the same fact, write it once and give both ids.',
  '- Include every statement the person makes about themselves: what they own, buy, do, plan, like, do regularly and decide.',
  '- Include every specific the assistant gives: names, numbers, lists and recommendations.',
  '- Write only what the evidence states; invent nothing.',
].join('\n');
const OBSERVE_REPLY = 'Answer each session in the order given. Begin each session\'s answer with a line reading "SESSION <name>" carrying the session\'s exact name, then that session\'s observation lines. A line may cite only item ids from its own session. A session that states no fact at all, such as small talk only, gets the single line "NO FACTS" instead of observation lines.';
const OBSERVE_REPAIR = 'A reply you wrote was rejected for its format; the rejected reply and the reason follow the evidence. Return the same observations corrected and nothing else: each session begins with its "SESSION <name>" line and holds one observation line per fact in the form [YYYY-MM-DD] fact (said YYYY-MM-DD; the full item id from its header), citing only that session\'s item ids, or the single line "NO FACTS" when it states no fact at all. Change only the format; keep every fact, date and id.';
const MARKER = 'SESSION ';
/** The writer's explicit answer for a session that states no fact. */
const NO_FACTS = 'NO FACTS';

interface Session {
  name: string;
  parts: MemoryCandidate[];
  ids: string[];
  /** The rendered evidence block sent to the writer. */
  block: string;
  /** SHA-256 over the observation namespace, the instruction version,
   *  the writerId and the parts in order (id, date, text). */
  key: string;
  /** Estimated tokens the block adds to a writer call, at four
   *  characters a token. */
  size: number;
}

/** The plain-file store: `<key>.json` under the directory, written to a
 *  temporary file and renamed into place so a reader never sees a
 *  half-written entry. Every read failure is a miss. */
function fileStore(directory: string): ObserveStore {
  return {
    get: async (key) => {
      try {
        return JSON.parse(await readFile(join(directory, `${key}.json`), 'utf8')) as unknown;
      } catch {
        return undefined;
      }
    },
    set: async (key, value) => {
      await mkdir(directory, { recursive: true });
      const file = join(directory, `${key}.json`);
      const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(value));
        await rename(temporary, file);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
    },
  };
}

/** A stored entry is `{ lines: string[] }`, where no lines records a
 *  session the writer found no facts in; anything else, and any lines
 *  that fail the dated-log check against the session's own ids, is a
 *  miss. */
function storedLines(value: unknown, session: Session): string[] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const lines = (value as { readonly lines?: unknown }).lines;
  if (!Array.isArray(lines)
    || lines.some((line) => typeof line !== 'string' || !line.trim())) {
    return undefined;
  }
  if (!lines.length) return [];
  const trimmed = lines.map((line) => line.trim());
  try {
    checkLog(trimmed.join('\n'), false, session.ids, false, false);
  } catch {
    return undefined;
  }
  return trimmed;
}

/** Split a reply on its "SESSION <name>" markers and check each named
 *  session's lines against the observation format and that session's
 *  own ids. A section holding only "NO FACTS" passes with no lines. A
 *  line citing another session's part fails its session.
 *  Sections for names the call did not send are ignored; a session
 *  named twice, missing from the reply, or holding a malformed line is
 *  a failure for that session alone. */
function checkReply(raw: unknown, sessions: readonly Session[]): Map<Session, string[] | string> {
  const out = new Map<Session, string[] | string>();
  if (typeof raw !== 'string') {
    for (const session of sessions) out.set(session, 'the reply was not text');
    return out;
  }
  const names = new Set(sessions.map((session) => session.name));
  const sections = new Map<string, { lines: string[]; seen: number }>();
  let current: { lines: string[]; seen: number } | undefined;
  for (const text of raw.split('\n')) {
    const line = text.trim();
    if (line.startsWith(MARKER)) {
      const name = line.slice(MARKER.length).trim();
      if (names.has(name)) {
        const section = sections.get(name) ?? { lines: [], seen: 0 };
        section.seen += 1;
        sections.set(name, section);
        current = section;
      } else current = undefined;
      continue;
    }
    if (current !== undefined && line) current.lines.push(line);
  }
  for (const session of sessions) {
    const section = sections.get(session.name);
    if (section === undefined) {
      out.set(session, 'the session is missing from the reply');
      continue;
    }
    if (section.seen > 1) {
      out.set(session, `the session was written ${section.seen} times`);
      continue;
    }
    if (section.lines.length === 1 && section.lines[0] === NO_FACTS) {
      out.set(session, []);
      continue;
    }
    try {
      checkLog(section.lines.join('\n'), false, session.ids, false, false);
      out.set(session, section.lines);
    } catch (error) {
      out.set(session, error instanceof Error
        ? error.message.replace(/^curate: (malformed log; )?/, '')
        : String(error));
    }
  }
  return out;
}

/** Pack whole sessions into calls of about `batchTokens` estimated
 *  tokens each, in order. A session larger than the budget sits alone;
 *  nothing is split. Omitting the budget gives one call per session. */
function packSessions(sessions: readonly Session[], batchTokens: number | undefined): Session[][] {
  if (batchTokens === undefined || sessions.length === 0) {
    return sessions.map((session) => [session]);
  }
  const calls: Session[][] = [[]];
  let size = 0;
  for (const session of sessions) {
    if (calls.at(-1)!.length > 0 && size + session.size > batchTokens) {
      calls.push([]);
      size = 0;
    }
    calls.at(-1)!.push(session);
    size += session.size;
  }
  return calls;
}

/** Write one dated observation log per session, once per the store: a
 *  chat part's session is `chat.sessionId`, a host-supplied part's is
 *  `documentId`, and other parts group as `pick`'s bestPartFirst does.
 *  Sessions the store already holds are reused; the rest go to the
 *  caller's `write` function with no question asked. The instructions
 *  ask for one line per fact, never merged and never dropped, covering
 *  the person's own statements and every specific the assistant gave.
 *  A session that states no fact comes back as "NO FACTS" and is
 *  stored with no lines, so it is not asked again. A reply whose lines
 *  fail the check goes back once with the reason; a second failure
 *  stores nothing, and that session's raw parts stand in as candidates
 *  instead. */
export async function observe(
  parts: readonly MemoryCandidate[],
  options: ObserveOptions,
): Promise<ObserveResult> {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  if (typeof options.writerId !== 'string' || !options.writerId.trim()) {
    throw new TypeError('observe: writerId must be a nonempty string.');
  }
  const instructionVersion = options.instructionVersion ?? OBSERVE_INSTRUCTION_VERSION;
  if (!instructionVersion.trim()) {
    throw new TypeError('observe: instructionVersion must be a nonempty string.');
  }
  if (options.batchTokens !== undefined
    && (!Number.isInteger(options.batchTokens) || options.batchTokens <= 0)) {
    throw new TypeError('observe: batchTokens must be a positive integer of estimated tokens.');
  }
  if (options.store !== undefined && options.directory !== undefined) {
    throw new TypeError('observe: pass either store or directory, not both.');
  }
  const store = options.store
    ?? (options.directory === undefined ? undefined : fileStore(options.directory));

  const sessions: Session[] = [];
  const byKey = new Map<string, Session>();
  for (const part of parts) {
    const { document, name } = candidateDocument(part);
    const key = JSON.stringify([part.sourceId, part.sourceRevision, document]);
    let session = byKey.get(key);
    if (session === undefined) {
      session = { name, parts: [], ids: [], block: '', key: '', size: 0 };
      byKey.set(key, session);
      sessions.push(session);
    }
    session.parts.push(part);
  }
  // A session's name heads its reply section, so two sessions that
  // share a name are told apart by a counter suffix.
  const named = new Map<string, number>();
  for (const session of sessions) {
    const seen = named.get(session.name) ?? 0;
    named.set(session.name, seen + 1);
    if (seen > 0) session.name = `${session.name} [${seen + 1}]`;
    session.ids = [...new Set(session.parts.map((part) => part.id))];
    session.block = session.parts.map((part) =>
      `### ${part.id}${part.date === undefined ? '' : ` (${part.date.value})`}: ${part.title}\n\n${part.text}`
    ).join('\n\n');
    session.key = createHash('sha256').update(JSON.stringify([
      'observation', instructionVersion, options.writerId,
      session.parts.map((part) => [part.id, part.date?.value ?? null, part.text]),
    ])).digest('hex');
    session.size = Math.ceil(`SESSION ${session.name}\n\n${session.block}`.length / 4);
  }

  const stored = await Promise.all(sessions.map(async (session) => {
    if (store === undefined) return undefined;
    let value: unknown;
    try {
      value = await store.get(session.key);
    } catch {
      return undefined;
    }
    return storedLines(value, session);
  }));

  const outcome = new Map<Session, { lines: string[]; outcome: ObserveSessionRecord['outcome']; warning?: string }>();
  const misses: Session[] = [];
  for (const [index, session] of sessions.entries()) {
    const lines = stored[index];
    if (lines === undefined) misses.push(session);
    else outcome.set(session, { lines, outcome: 'reused' });
  }

  let calls = 0;
  let repairs = 0;
  for (const callSessions of packSessions(misses, options.batchTokens)) {
    const prompt: CuratePrompt = {
      instructions: `${OBSERVE_INSTRUCTIONS}\n${OBSERVE_REPLY}`,
      body: callSessions.map((session) => `SESSION ${session.name}\n\n${session.block}`).join('\n\n'),
    };
    calls += 1;
    let reply = await options.write(prompt, signal);
    signal.throwIfAborted();
    let checked = checkReply(reply, callSessions);
    // A failing reply goes back once with the reason and the rejected
    // text. Sessions that already passed keep their lines; only the
    // failed sessions are kept or failed on the second reply.
    const failed = [...checked].filter((entry): entry is [Session, string] => typeof entry[1] === 'string');
    if (failed.length > 0) {
      repairs += 1;
      const reason = failed.map(([session, why]) => `${session.name}: ${why}`).join('; ');
      calls += 1;
      reply = await options.write({
        instructions: `${prompt.instructions}\n${OBSERVE_REPAIR}`,
        body: `${prompt.body}\n\nREJECTED REPLY (${reason}):\n${reply}`,
      }, signal);
      signal.throwIfAborted();
      for (const [session, lines] of checkReply(reply, failed.map(([session]) => session))) {
        checked.set(session, lines);
      }
    }
    for (const [session, lines] of checked) {
      if (typeof lines === 'string') {
        outcome.set(session, { lines: [], outcome: 'failed',
          warning: `the writer's reply failed the observation check: ${lines}` });
        continue;
      }
      const entry: { lines: string[]; outcome: 'written'; warning?: string } = { lines, outcome: 'written' };
      outcome.set(session, entry);
      if (store !== undefined) {
        try {
          await store.set(session.key, { lines });
        } catch (error) {
          entry.warning = `the store did not keep the lines: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }
  }

  return {
    sessions: sessions.map((session) => ({
      session: session.name,
      parts: session.parts,
      lines: outcome.get(session)!.lines,
      outcome: outcome.get(session)!.outcome,
    })),
    record: {
      instructionVersion,
      writerId: options.writerId,
      calls,
      ...(repairs > 0 ? { repairs } : {}),
      ...(options.batchTokens === undefined ? {} : { batchTokens: options.batchTokens }),
      sessions: sessions.map((session) => {
        const result = outcome.get(session)!;
        return {
          session: session.name,
          parts: session.parts.length,
          outcome: result.outcome,
          lines: result.lines.length,
          ...(result.warning === undefined ? {} : { warning: result.warning }),
        };
      }),
    },
  };
}

/** One candidate per observation line, ready for `pick` and `curate`
 *  unchanged: the id is `<session>#L<n>`, the text is the line, the
 *  date is the event date, `documentId` is the session, and `cites`
 *  keeps the part ids the line cites so a selected line traces back to
 *  its source. A session whose writer reply failed twice contributes
 *  its raw parts instead; a session with no facts contributes nothing. */
export function observationCandidates(result: ObserveResult): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];
  for (const session of result.sessions) {
    if (session.outcome === 'failed') {
      candidates.push(...session.parts);
      continue;
    }
    const patterns = logPatterns([...new Set(session.parts.map((part) => part.id))]);
    for (const [index, line] of session.lines.entries()) {
      const groups = patterns.observation.exec(line)?.groups;
      // Only the source lists after each "said <date>;" hold cited ids;
      // the dates themselves are stripped first so their digits can
      // never match a numeric id.
      const cited = groups?.citations?.replace(/said \d{4}-\d{2}-\d{2};/g, ' ') ?? '';
      const cites = groups === undefined ? []
        : [...new Set([...cited.matchAll(patterns.source)].map((match) => match[0]))];
      candidates.push({
        sourceId: session.parts[0]!.sourceId,
        role: 'reference',
        id: `${session.session}#L${index + 1}`,
        title: session.session,
        text: line,
        documentId: session.session,
        signals: {},
        cites,
        ...(groups?.event === undefined ? {} : { date: { value: groups.event, meaning: 'effective' as const } }),
      });
    }
  }
  return candidates;
}
