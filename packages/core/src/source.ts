import type { CandidateSourceKind, MemoryCandidate, PickOptions, PickResult } from './pick.js';
import { DEFAULT_MAX_QUESTION_TEXT, pick } from './pick.js';
import { phraseCount, stripSearchInstructions } from './search.js';

/** What a source is asked for, once per search. */
export interface CandidateReadRequest {
  /** The task used for keyword search. Pick keeps options.task intact. */
  readonly task: string;
  /** Additional host-written keyword searches. Each unique, nonblank
   *  line contributes its own results alongside the original task.
   *  Omit or supply [] for a single search; no model writes these lines. */
  readonly searchLines?: readonly string[];
  /** Exact contiguous word phrases, retaining short words. Matched
   *  against candidate text and titles; each phrase adds a separate search feed. */
  readonly searchPhrases?: readonly string[];
  /** Remove explicit answer-format and citation clauses from search
   *  text only. Off by default; subject, counting and date needs remain. */
  readonly stripSearchInstructions?: boolean;
  /** Repository/workspace paths the task names, if the host supplied
   *  them. Ranking-signal hints only; never a filter, and never the
   *  exclusion mechanism. */
  readonly paths?: readonly string[];
  /** Paths excluded by resolved policy. The reader refuses them before
   *  opening contents and before their text reaches signals or a model.
   *  Distinct from `paths` hints. */
  readonly exclude?: readonly string[];
  /** Pin the read to one revision (a SHA, or 'HEAD'). Resolved once by
   *  the reader and used for every operation; history, contents,
   *  dates. Absent means "read the working state". */
  readonly revision?: string;
  /** Most candidates each source read should emit. Markdown and chat
   *  keep their best matches; git history enumerates latest commits
   *  before ranking. Truncated enumeration makes `complete` false. */
  readonly limit?: number;
  /** Reader part size. Readers preserve every character across parts.
   *  `pickFromSources` uses a caller's text cut or the default reader size;
   *  pick shows each part whole when its text cut is omitted. */
  readonly maxQuestionText?: number;
  /** Cancellation reaches file reads and child processes. */
  readonly signal?: AbortSignal;
}

export type CandidateReadResult =
  | {
      readonly status: 'read';
      /** Source revision at read time; HEAD SHA or the pinned
       *  revision; recorded on the source and copied onto each
       *  candidate's sourceRevision. */
      readonly revision?: string;
      readonly candidates: readonly MemoryCandidate[];
      /** False when enumeration stopped early (limit) or skipped
       *  items; propagates into the combined coverage so a truncated
       *  rule source can never yield a falsely "complete" rule set. */
      readonly complete: boolean;
      /** Why it is partial, plus a count when items were skipped. */
      readonly partial?: string;
    }
  | {
      /** Expected absence: no repository, no git binary, no record
       *  file, no directory. Non-fatal; the step does not fail, the
       *  reason is recorded. Distinct from a real read failure. */
      readonly status: 'absent';
      readonly reason: string;
    };

export interface CandidateSource {
  /** Stable identity, recorded on every candidate and in PickRecord. */
  readonly id: string;
  /** Optional content kind for per-kind question sets. */
  readonly kind?: CandidateSourceKind;
  /** 'reference' | 'rule' | 'mixed'; declared so the caller knows
   *  whether this source can feed the applicable-rule set. */
  readonly role: 'reference' | 'rule' | 'mixed';
  read(request: CandidateReadRequest): Promise<CandidateReadResult>;
}

/** A real read failure: permission denied, corrupt store, killed
 *  mid-read. Cancellation throws the same class with code 'cancelled',
 *  kept apart from 'failed' so a caller can tell them apart. Expected
 *  absence is the 'absent' result, not a throw. */
export class SourceReadError extends Error {
  readonly code: 'failed' | 'cancelled';

  constructor(code: 'failed' | 'cancelled', message: string) {
    super(message);
    this.name = 'SourceReadError';
    this.code = code;
  }
}

export interface PickSourcesResult extends PickResult {
  /** Each source's combined search result, in source order. Absent
   *  reasons and partial notes remain available beside the pick record. */
  readonly reads: readonly CandidateReadResult[];
}

function searchTasks(request: CandidateReadRequest): { task: string; phrase: boolean }[] {
  const searchTask = (task: string) => request.stripSearchInstructions ? stripSearchInstructions(task) : task;
  const tasks = [{ task: searchTask(request.task), phrase: false }];
  const seen = new Set([tasks[0]!.task.trim()]);
  for (const line of request.searchLines ?? []) {
    const task = searchTask(line.trim());
    if (!task || seen.has(task.trim())) continue;
    seen.add(task.trim());
    tasks.push({ task, phrase: false });
  }
  const phrases = new Set<string>();
  for (const line of request.searchPhrases ?? []) {
    const task = line.trim();
    if (!task || phrases.has(task)) continue;
    phrases.add(task);
    tasks.push({ task, phrase: true });
  }
  return tasks;
}

async function readSearches(
  source: CandidateSource,
  request: CandidateReadRequest,
): Promise<CandidateReadResult> {
  const tasks = searchTasks(request);
  if (tasks.length === 1) return source.read({ ...request, task: tasks[0]!.task });

  const union = new Map<string, { candidate: MemoryCandidate; ranks: (number | null)[]; best: number }>();
  const reasons = new Set<string>();
  const absent = new Set<string>();
  let revision = request.revision;
  let resolvedRevision: string | undefined;
  let complete = true;
  let readAny = false;
  for (const [lane, { task, phrase }] of tasks.entries()) {
    // Phrase filtering must precede the per-read limit.
    let read = await source.read({ ...request, task,
      ...(phrase ? { limit: undefined } : {}),
      ...(revision === undefined ? {} : { revision }) });
    if (phrase && read.status === 'read') {
      const matches = read.candidates.map((candidate) => ({ candidate, count: phraseCount(candidate.text, task) + phraseCount(candidate.title, task) }))
        .filter(({ count }) => count > 0)
        .sort((left, right) => right.count - left.count || left.candidate.id.localeCompare(right.candidate.id));
      const limited = request.limit !== undefined && matches.length > request.limit;
      read = { ...read,
        candidates: (limited ? matches.slice(0, request.limit) : matches)
          .map(({ candidate, count }) => ({ ...candidate, signals: { phrase: count } })),
        complete: read.complete && !limited,
        ...(limited ? { partial: [read.partial, `the phrase limit kept ${request.limit} of ${matches.length} candidates`].filter(Boolean).join('; ') } : {}),
      };
    }
    if (read.status === 'absent') {
      absent.add(read.reason);
      reasons.add(`search ${lane + 1} absent: ${read.reason}`);
      complete = false;
      continue;
    }
    readAny = true;
    if (resolvedRevision === undefined && read.revision !== undefined) resolvedRevision = read.revision;
    if (resolvedRevision !== undefined && (request.revision !== undefined
      || !(source.kind === 'markdown' && source.role === 'rule'))) revision = resolvedRevision;
    if (!read.complete) {
      complete = false;
      reasons.add(read.partial ?? `search ${lane + 1} did not enumerate completely`);
    }
    const groups = new Map<string, MemoryCandidate[]>();
    for (const candidate of read.candidates) {
      const group = groups.get(candidate.sourceId);
      if (group === undefined) groups.set(candidate.sourceId, [candidate]);
      else group.push(candidate);
    }
    for (const group of groups.values()) {
      const score = (candidate: MemoryCandidate) => Object.values(candidate.signals).reduce((sum, value) => sum + value, 0);
      group.sort((left, right) => score(right) - score(left) || left.id.localeCompare(right.id));
      const ranked = new Set<string>();
      for (const candidate of group) {
        const key = JSON.stringify([candidate.sourceId, candidate.id]);
        if (ranked.has(key)) continue;
        const rank = ranked.size;
        ranked.add(key);
        const value = read.revision === undefined || candidate.sourceRevision !== undefined
          ? candidate : { ...candidate, sourceRevision: read.revision };
        const existing = union.get(key);
        if (existing === undefined) {
          const ranks = Array<number | null>(tasks.length).fill(null);
          ranks[lane] = rank;
          union.set(key, { candidate: value, ranks, best: rank });
        } else {
          existing.ranks[lane] = rank;
          if (rank < existing.best) {
            existing.best = rank;
            existing.candidate = value;
          }
        }
      }
    }
  }
  if (!readAny) return { status: 'absent', reason: [...absent].join('; ') };
  return {
    status: 'read', complete,
    ...(resolvedRevision === undefined ? {} : { revision: resolvedRevision }),
    candidates: [...union.values()].map(({ candidate, ranks }) => ({ ...candidate, searchRanks: ranks })),
    ...(reasons.size === 0 ? {} : { partial: [...reasons].join('; ') }),
  };
}

/**
 * Read every source, then pick over the combined candidates. The read
 * revision is copied onto candidates that do not carry their own
 * sourceRevision, and a rule source that did not enumerate completely
 * (`complete: false`, or absent when rules were expected) makes the
 * record's rulesCoverage 'incomplete' even when every supplied rule was
 * answered. A caller-supplied `rulesEnumerationComplete: false` in the
 * options is honoured the same way.
 */
export async function pickFromSources(
  sources: readonly CandidateSource[],
  request: CandidateReadRequest,
  options: PickOptions,
): Promise<PickSourcesResult> {
  const reads = await Promise.all(sources.map((source) => readSearches(source, {
    ...request,
    maxQuestionText: options.limits?.maxQuestionText ?? DEFAULT_MAX_QUESTION_TEXT,
  })));
  const candidates: MemoryCandidate[] = [];
  const sourceKinds: Record<string, CandidateSourceKind> = Object.assign(Object.create(null), options.sourceKinds);
  let rulesEnumerationComplete = options.rulesEnumerationComplete !== false;
  for (const [index, read] of reads.entries()) {
    if (read.status !== 'read') {
      if (sources[index]!.role !== 'reference') rulesEnumerationComplete = false;
      continue;
    }
    if (sources[index]!.role !== 'reference' && !read.complete) rulesEnumerationComplete = false;
    for (const candidate of read.candidates) {
      const kind = sources[index]!.kind;
      if (kind !== undefined) sourceKinds[candidate.sourceId] = kind;
      candidates.push(
        read.revision === undefined || candidate.sourceRevision !== undefined
          ? candidate
          : { ...candidate, sourceRevision: read.revision },
      );
    }
  }
  let combined = candidates;
  if (searchTasks(request).length > 1) {
    const unique = new Map<string, MemoryCandidate>();
    const bestRank = (candidate: MemoryCandidate) => candidate.searchRanks!.reduce<number>(
      (best, rank) => rank === null ? best : Math.min(best, rank), Number.POSITIVE_INFINITY,
    );
    for (const candidate of candidates) {
      const key = JSON.stringify([candidate.sourceId, candidate.id]);
      const existing = unique.get(key);
      if (existing === undefined) {
        unique.set(key, candidate);
        continue;
      }
      const ranks = Array.from({ length: Math.max(existing.searchRanks!.length, candidate.searchRanks!.length) }, (_, lane) => {
        const left = existing.searchRanks![lane] ?? null;
        const right = candidate.searchRanks![lane] ?? null;
        return left === null ? right : right === null ? left : Math.min(left, right);
      });
      const chosen = bestRank(candidate) < bestRank(existing) ? candidate : existing;
      unique.set(key, { ...chosen, searchRanks: ranks });
    }
    combined = [...unique.values()];
  }
  const result = await pick(combined, {
    ...options, rulesEnumerationComplete,
    ...(options.cascadesByKind === undefined ? {} : { sourceKinds }),
  });
  return { ...result, reads };
}
