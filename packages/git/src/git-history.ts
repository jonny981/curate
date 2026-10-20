import { GIT_KEYWORD_SETTINGS, type GitKeywordSettings } from './defaults.js';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  asSourceReadError,
  canonicalPath,
  commitDate,
  GitFailure,
  pathNames,
  probeWorkTree,
  resolveCommit,
  runGit,
} from '@curatejs/core/internal';
import { hits, taskTerms, phraseCount, laneBend, embedQuery, embedSimilarities } from '@curatejs/core/internal';
import type { MemoryCandidate } from '@curatejs/core';
import {
  SourceReadError,
  type CandidateReadRequest,
  type CandidateReadResult,
  type CandidateSource,
} from '@curatejs/core';

export interface GitHistoryOptions {
  /** Override the exported GIT_KEYWORD_SETTINGS. */
  readonly keyword?: Partial<GitKeywordSettings>;
  /** The source's stable id; defaults to `gitHistory:<resolved repo>`. */
  readonly id?: string;
  /** The repository key candidates declare. A link needs an equal value
   *  on both sides; defaults to the work-tree toplevel, and a
   *  caller-supplied key wins when it is set. */
  readonly repository?: string;
  /** Adds a `live_lines` signal to commits that wrote lines still live
   *  in the task's named paths. Costs one blame call per named file, so
   *  it runs only when asked. */
  readonly blame?: boolean;
  /** Adds a `co_change` signal to commits that touched files which
   *  historically change with the task's named paths. Costs extra log
   *  passes, so it runs only when asked. */
  readonly coChange?: boolean;
}

interface LogCommit {
  readonly sha: string;
  readonly short: string;
  readonly date: string;
  readonly subject: string;
  readonly body: string;
  readonly changedPaths: readonly string[];
}

/** What a read keeps per commit once its page or body batch is released:
 *  the candidate's fields and its measured shared-word count, never the
 *  body unless the result emits it. */
interface ScoredCommit {
  readonly sha: string;
  readonly short: string;
  readonly date: string;
  readonly subject: string;
  readonly changedPaths: readonly string[];
  /** Shared task-term hits, set when a body was measured for this commit. */
  shared?: number;
  /** The body, held only while the result still needs it. */
  body?: string;
}

/** Split or trimmed strings are slices of the page they came from, so
 *  a retained field would pin that whole page of log output. Fields a
 *  result keeps are copied flat before they are stored. */
const flat = (text: string): string => Buffer.from(text).toString('utf8');

const scored = (commit: Omit<LogCommit, 'body'>, extra: { shared?: number; body?: string } = {}): ScoredCommit => ({
  sha: flat(commit.sha), short: flat(commit.short), date: flat(commit.date),
  subject: flat(commit.subject), changedPaths: commit.changedPaths.map(flat),
  ...(extra.shared === undefined ? {} : { shared: extra.shared }),
  ...(extra.body === undefined ? {} : { body: flat(extra.body) }),
});

/** Records are separated by \x1e and fields by \x1f; `-z` leaves paths
 *  literal and NUL-separated, so a name with spaces or non-ASCII bytes is
 *  never quoted. */
const FULL_FORMAT = '%x1e%H%x1f%h%x1f%cI%x1f%s%x1f%b%x1f';
const META_FORMAT = '%x1e%H%x1f%h%x1f%cI%x1f%s';
/** Commits per `git log` call. A long history is enumerated in pages so
 *  one call's output stays far under the process output cap and the
 *  parsed page's memory is released before the next. */
const LOG_PAGE = 4096;
/** Commits per batched body fetch, bounding one `--stdin` call's output. */
const BODY_PAGE = 2048;

function parseLog(output: string, withBody: boolean): LogCommit[] {
  const commits: LogCommit[] = [];
  for (const record of output.split('\x1e')) {
    if (record.trim() === '') continue;
    const fields = record.split('\x1f');
    const [sha = '', short = '', date = ''] = fields;
    let subject = '';
    let body = '';
    let pathBlock = '';
    if (withBody) {
      subject = fields[3] ?? '';
      body = fields[4] ?? '';
      pathBlock = fields[5] ?? '';
    } else {
      const last = fields[3] ?? '';
      const boundary = last.indexOf('\0');
      subject = boundary < 0 ? last : last.slice(0, boundary);
      pathBlock = boundary < 0 ? '' : last.slice(boundary);
    }
    commits.push({
      sha,
      short,
      date: commitDate(date),
      subject,
      body: body.trim(),
      changedPaths: pathNames(pathBlock),
    });
  }
  return commits;
}

/** The body of each named commit, in one call. The SHAs ride on stdin
 *  rather than the command line: a kept list in the tens of thousands
 *  would overflow the argument cap before git ran. `--no-walk=unsorted`
 *  prints each commit in input order, so the records zip back to the
 *  SHAs that asked for them. */
async function readBodies(
  toplevel: string,
  shas: readonly string[],
  signal: AbortSignal | undefined,
): Promise<readonly string[]> {
  if (shas.length === 0) return [];
  const output = await runGit(
    toplevel,
    ['log', '--no-walk=unsorted', '--stdin', '--format=%x1e%b'],
    { input: `${shas.join('\n')}\n`, signal },
  );
  return output.split('\x1e').slice(1).map((body) => flat(body.trim()));
}

/** A path a caller wrote, as a repository-relative path. Absolute paths
 *  are relativised against the toplevel: outside it they can match
 *  nothing. The root itself, or an ancestor of it (a relative form of
 *  only `..` segments), comes back as '', which names every repository
 *  path beneath it. Relative ones are cleaned of `./` and trailing
 *  slashes; '.', './' and '' name the root the same way. */
function repoPath(entry: string, toplevel: string): string | undefined {
  if (isAbsolute(entry)) {
    const within = relative(toplevel, entry).split(sep).join('/');
    const segments = within.split('/');
    if (within === '' || segments.every((segment) => segment === '..')) {
      return '';
    }
    return segments[0] === '..' ? undefined : within;
  }
  const cleaned = entry.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return cleaned === '' || cleaned === '.' ? '' : cleaned;
}

function touches(changedPaths: readonly string[], named: readonly string[]): boolean {
  // '' is the repository root: every changed path sits beneath it.
  return named.some((path) => path === ''
    || changedPaths.some((changed) => changed === path || changed.startsWith(`${path}/`)));
}

const NO_COMMIT = /Needed a single revision|does not have any commits|unknown revision|ambiguous argument/i;

/**
 * A repository's commit history: one candidate per non-merge commit,
 * newest first, carrying its subject, body, commit date and the files it
 * changed. Git runs through core's shared helper: `execFile` with no
 * shell, a scrubbed environment, a time limit, an output limit, and the
 * request's abort signal reaching the process.
 *
 * With no exclusions, `git log` pages enumerate commits and paths, and
 * each page is scored as it arrives. With exclusions, a metadata pass
 * lists paths first and a commit that touched any excluded path is
 * dropped before its body is ever fetched. A lane-cut read keeps compact
 * per-commit scores and fetches bodies only for the commits the curve
 * kept. `blame` and `coChange` are opt-in extras on top.
 */
export function gitHistory(
  repo: string | URL,
  options: GitHistoryOptions = {},
): CandidateSource {
  const keyword = { ...GIT_KEYWORD_SETTINGS, ...options.keyword };
  const directory = repo instanceof URL ? fileURLToPath(repo) : repo;
  if (typeof directory !== 'string' || directory.trim() === '') {
    throw new TypeError('repo must be a directory path or a file: URL.');
  }
  const resolved = resolve(directory);
  const id = options.id ?? `gitHistory:${resolved}`;
  return {
    id,
    kind: 'git-history',
    role: 'reference',
    async read(request) {
      const signal = request.signal;
      if (signal?.aborted) throw new SourceReadError('cancelled', 'The read was cancelled.');
      if (request.limit !== undefined
        && (!Number.isSafeInteger(request.limit) || request.limit < 1)) {
        throw new TypeError('limit must be a positive safe integer.');
      }
      let info;
      try {
        info = await stat(resolved);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          return { status: 'absent', reason: 'not-a-directory' };
        }
        throw new SourceReadError('failed', `Could not inspect ${resolved}: ${String(error)}`);
      }
      if (!info.isDirectory()) return { status: 'absent', reason: 'not-a-directory' };

      let probe;
      let toplevel: string;
      try {
        probe = await probeWorkTree(resolved, signal);
        // realpath matches knowledgeBase's canonicalisation, so a
        // repository key is the same value on both sides of a link.
        toplevel = probe.status === 'worktree' ? await realpath(probe.toplevel) : '';
      } catch (error) {
        throw asSourceReadError(error);
      }
      if (probe.status === 'absent') return probe;

      // The pinned revision (HEAD by default) is resolved once here, at
      // read start; every git call below addresses the SHA it returned,
      // so the whole read sees one snapshot even when HEAD moves on.
      let sha: string;
      try {
        sha = await resolveCommit(toplevel, request.revision ?? 'HEAD', signal);
      } catch (error) {
        if (error instanceof GitFailure) {
          if (error.kind === 'cancelled') throw new SourceReadError('cancelled', 'The read was cancelled.');
          if (request.revision !== undefined || !NO_COMMIT.test(error.stderr)) {
            throw new SourceReadError(
              'failed',
              request.revision === undefined
                ? `Could not resolve the default revision: ${error.message}`
                : `The pinned revision ${request.revision} is not in this repository.`,
            );
          }
          return { status: 'absent', reason: 'no-history' };
        }
        throw error;
      }

      try {
        // Exclusions are resolved to repository-relative paths first.
        // An absolute entry is canonicalised through realpath, because
        // the toplevel is: an entry written through a symlinked path (a
        // /var tmpdir, a linked workspace) would otherwise escape the
        // toplevel spelling and be dropped, failing the exclusion open.
        const excluded = new Set<string>();
        for (const entry of request.exclude ?? []) {
          const path = repoPath(
            isAbsolute(entry) ? await canonicalPath(entry) : entry,
            toplevel,
          );
          if (path !== undefined) excluded.add(path);
        }
        // A kind lane's `task` is the phrase; its `topic` is the task
        // the lane serves, and that is what the matches are scored on.
        const terms = taskTerms(request.topic ?? request.task, request.paths ?? [], keyword.stopWords);
        const named: string[] = [];
        for (const path of request.paths ?? []) {
          const name = repoPath(
            isAbsolute(path) ? await canonicalPath(path) : path,
            toplevel,
          );
          if (name !== undefined) named.push(name);
        }
        // '' (a hint that named the root) is not a pathspec git accepts;
        // '.' under `git -C <toplevel>` names the same whole tree.
        const pathspec = named.map((name) => (name === '' ? '.' : name));
        const now = Date.now();
        const cut = request.wholeLanes === false;

        // With no exclusions the log pages carry bodies: a bare read keeps
        // them for its candidates, a lane-cut read measures each page's
        // shared words and releases the bodies, and a phrase read counts
        // each page's phrase and keeps only the matching bodies. With
        // exclusions the pages carry metadata only; the bodies of admitted
        // commits come from bounded `git log --stdin` batches, so a commit
        // that touched an excluded path never has its body read. One more
        // commit than the limit is enumerated when it can be known up
        // front, so `complete` knows whether the list was truncated;
        // phrase, kind and meaning lanes and exclusions enumerate the
        // whole history, since the limit then slices a filtered set, not
        // the enumeration.
        const wanted = excluded.size === 0 && request.limit !== undefined
          && request.phraseLane !== true && request.meaningLane === undefined
          ? request.limit + 1
          : undefined;
        const enumerated: ScoredCommit[] = [];
        const phrases: { commit: ScoredCommit; count: number }[] = [];
        const embedding = request.meaningLane === undefined ? undefined
          : await embedQuery(request.meaningLane.embed, request.task, signal);
        let pendingEmbed: string[] = [];
        const similarities: number[] = [];
        const flushEmbed = async () => {
          if (pendingEmbed.length === 0 || embedding === undefined) return;
          similarities.push(
            ...await embedSimilarities(request.meaningLane!.embed, embedding, pendingEmbed, signal));
          pendingEmbed = [];
        };
        for (let offset = 0; wanted === undefined || offset < wanted;) {
          const page = wanted === undefined ? LOG_PAGE : Math.min(LOG_PAGE, wanted - offset);
          const batch = parseLog(
            await runGit(toplevel, [
              'log', '--no-merges', '--no-renames', '-z',
              `--format=${excluded.size === 0 ? FULL_FORMAT : META_FORMAT}`,
              '--name-only', '-n', String(page),
              ...(offset === 0 ? [] : ['--skip', String(offset)]), sha,
            ], { signal }),
            excluded.size === 0,
          );
          for (const commit of batch) {
            if (excluded.size !== 0) {
              enumerated.push(scored(commit));
            } else if (embedding !== undefined) {
              // The page's body is embedded and released with it; only
              // the similarity survives.
              enumerated.push(scored(commit));
              pendingEmbed.push(`${commit.subject}\n${commit.body}`);
              if (pendingEmbed.length === 32) await flushEmbed();
            } else if (request.phraseLane === true && request.topic !== undefined) {
              // A kind lane's match keeps the commit's topic score, not
              // its body: only commits the curve keeps get one back.
              const count = phraseCount(commit.subject, request.task) + phraseCount(commit.body, request.task);
              if (count > 0) {
                phrases.push({
                  commit: scored(commit, { shared: hits(`${commit.subject}\n${commit.body}`, terms) }),
                  count,
                });
              }
            } else if (request.phraseLane === true) {
              const count = phraseCount(commit.subject, request.task) + phraseCount(commit.body, request.task);
              if (count > 0) phrases.push({ commit: scored(commit, { body: commit.body }), count });
            } else if (cut) {
              enumerated.push(scored(commit, { shared: hits(`${commit.subject}\n${commit.body}`, terms) }));
            } else {
              enumerated.push(scored(commit, { body: commit.body }));
            }
          }
          if (batch.length < page) break;
          offset += batch.length;
        }
        await flushEmbed();
        // A commit touching any excluded path is not admitted, even when
        // it also touched an allowed one; its body is never fetched.
        const admitted = excluded.size === 0
          ? enumerated
          : enumerated.filter((commit) => !touches(commit.changedPaths, [...excluded]));

        // A meaning lane embeds each admitted commit's subject and body
        // in bounded batches, keeps the similarity curve's side, and
        // fetches bodies only for the kept commits. With exclusions the
        // bodies it needs arrive in the same bounded batches, after the
        // path filter has dropped their commits.
        if (embedding !== undefined) {
          if (excluded.size !== 0) {
            for (let start = 0; start < admitted.length; start += BODY_PAGE) {
              const slice = admitted.slice(start, start + BODY_PAGE);
              const bodies = await readBodies(toplevel, slice.map((commit) => commit.sha), signal);
              for (const [index, body] of bodies.entries()) {
                pendingEmbed.push(`${slice[index]!.subject}\n${body}`);
                if (pendingEmbed.length === 32) await flushEmbed();
              }
            }
            await flushEmbed();
          }
          const order = admitted.map((_, index) => index)
            .sort((a, b) => (similarities[b] ?? 0) - (similarities[a] ?? 0)
              || `commit ${admitted[a]!.short}`.localeCompare(`commit ${admitted[b]!.short}`));
          const bend = cut ? laneBend(order.map((index) => similarities[index]!)) : undefined;
          // A cut lane where nothing scored above zero matched nothing:
          // it keeps no parts rather than fetch every body.
          const kept = bend === undefined
            ? (cut && !order.some((index) => similarities[index]! > 0) ? [] : order)
            : order.filter((index) => similarities[index]! > bend);
          // `limit` carries the caller's `nearest` cap: it slices the
          // kept set after the curve, not the enumeration before it.
          const limited = request.limit === undefined ? kept : kept.slice(0, request.limit);
          for (let start = 0; start < limited.length; start += BODY_PAGE) {
            const slice = limited.slice(start, start + BODY_PAGE);
            const bodies = await readBodies(toplevel, slice.map((index) => admitted[index]!.sha), signal);
            slice.forEach((index, at) => { admitted[index]!.body = bodies[at]!; });
          }
          const limitedReads = request.limit !== undefined && kept.length > request.limit;
          return {
            status: 'read' as const,
            revision: sha,
            meaningLane: true as const,
            candidates: limited.map((index): MemoryCandidate => ({
              sourceId: id,
              sourceRevision: sha,
              role: 'reference',
              id: `commit ${admitted[index]!.short}`,
              title: admitted[index]!.subject,
              text: admitted[index]!.body ?? '',
              contentRef: admitted[index]!.sha,
              date: { value: admitted[index]!.date, meaning: 'recorded' as const },
              changedPaths: admitted[index]!.changedPaths,
              repository: options.repository ?? toplevel,
              signals: { similarity: similarities[index]! },
              laneScore: similarities[index]!,
            })),
            complete: !limitedReads,
            matched: admitted.length,
            ...(cut ? { laneCutApplied: true as const } : {}),
            ...(limitedReads
              ? { partial: `the limit kept ${request.limit} of ${kept.length} candidates` }
              : {}),
          };
        }

        // A kind lane keeps the commits whose subject or body contains
        // the exact phrase, then ranks them by the task's own signal
        // score — never by how often the phrase occurs, so a direction
        // said once survives a phrase everyone says. Matches carry
        // compact scores until the curve cut picks the kept set; only
        // those bodies are fetched.
        if (request.phraseLane === true && request.topic !== undefined) {
          if (excluded.size !== 0) {
            for (let start = 0; start < admitted.length; start += BODY_PAGE) {
              const slice = admitted.slice(start, start + BODY_PAGE);
              const bodies = await readBodies(toplevel, slice.map((commit) => commit.sha), signal);
              slice.forEach((commit, index) => {
                const count = phraseCount(commit.subject, request.task)
                  + phraseCount(bodies[index]!, request.task);
                if (count > 0) {
                  phrases.push({
                    commit: { ...commit, shared: hits(`${commit.subject}\n${bodies[index]!}`, terms) },
                    count,
                  });
                }
              });
            }
          }
          const laneSignals = (commit: ScoredCommit): Record<string, number> => {
            const out: Record<string, number> = {};
            const shared = commit.shared ?? 0;
            if (shared > 0) out['shared_words'] = Math.min(keyword.sharedWordCap, shared);
            const ageDays = (now - Date.parse(commit.date)) / 86_400_000;
            out['recency'] = Math.exp(-Math.max(0, ageDays) / keyword.recencyDays);
            if (named.length > 0 && touches(commit.changedPaths, named)) {
              out['named_path_touch'] = keyword.namedPathWeight;
            }
            return out;
          };
          const laneSum = (entry: { signals: Record<string, number> }) =>
            Object.values(entry.signals).reduce((sum, value) => sum + value, 0);
          const ranked = phrases
            .map(({ commit, count }) => ({ commit, count, signals: laneSignals(commit) }))
            .sort((left, right) => laneSum(right) - laneSum(left)
              || `commit ${left.commit.short}`.localeCompare(`commit ${right.commit.short}`));
          // The curve sees every match; `limit` slices what it keeps.
          const bend = cut ? laneBend(ranked.map(laneSum)) : undefined;
          const curveKept = bend === undefined ? ranked : ranked.filter((entry) => laneSum(entry) > bend);
          const limitedByCount = request.limit !== undefined && curveKept.length > request.limit;
          const kept = limitedByCount ? curveKept.slice(0, request.limit) : curveKept;
          for (let start = 0; start < kept.length; start += BODY_PAGE) {
            const slice = kept.slice(start, start + BODY_PAGE);
            const bodies = await readBodies(toplevel, slice.map((entry) => entry.commit.sha), signal);
            slice.forEach((entry, index) => { entry.commit.body = bodies[index]!; });
          }
          return {
            status: 'read' as const,
            revision: sha,
            candidates: kept.map((entry): MemoryCandidate => ({
              sourceId: id,
              sourceRevision: sha,
              role: 'reference',
              id: `commit ${entry.commit.short}`,
              title: entry.commit.subject,
              text: entry.commit.body ?? '',
              contentRef: entry.commit.sha,
              date: { value: entry.commit.date, meaning: 'recorded' as const },
              changedPaths: entry.commit.changedPaths,
              repository: options.repository ?? toplevel,
              signals: { ...entry.signals, phrase: entry.count },
              laneScore: laneSum(entry),
            })),
            complete: !limitedByCount,
            ...(cut ? { laneCutApplied: true as const, matched: phrases.length } : {}),
            ...(limitedByCount
              ? { partial: `the limit kept ${request.limit} of ${curveKept.length} candidates` }
              : {}),
          };
        }

        // A phrase lane keeps the commits whose subject or body
        // contains the exact phrase; keyword scoring is skipped.
        if (request.phraseLane === true) {
          // With exclusions the admitted commits' bodies arrive in
          // bounded batches for counting; without them the page loop
          // counted each commit as its page arrived and `phrases` is
          // already complete.
          if (excluded.size !== 0) {
            for (let start = 0; start < admitted.length; start += BODY_PAGE) {
              const slice = admitted.slice(start, start + BODY_PAGE);
              const bodies = await readBodies(toplevel, slice.map((commit) => commit.sha), signal);
              slice.forEach((commit, index) => {
                const count = phraseCount(commit.subject, request.task) + phraseCount(bodies[index]!, request.task);
                if (count > 0) phrases.push({ commit: { ...commit, body: bodies[index]! }, count });
              });
            }
          }
          const matched = phrases
            .sort((a, b) => b.count - a.count
              || `commit ${a.commit.short}`.localeCompare(`commit ${b.commit.short}`));
          const limited = request.limit !== undefined && matched.length > request.limit;
          const emitted = limited ? matched.slice(0, request.limit) : matched;
          return {
            status: 'read' as const,
            revision: sha,
            candidates: emitted.map(({ commit, count }): MemoryCandidate => ({
              sourceId: id,
              sourceRevision: sha,
              role: 'reference',
              id: `commit ${commit.short}`,
              title: commit.subject,
              text: commit.body ?? '',
              contentRef: commit.sha,
              date: { value: commit.date, meaning: 'recorded' as const },
              changedPaths: commit.changedPaths,
              repository: options.repository ?? toplevel,
              signals: { phrase: count },
              laneScore: count,
            })),
            complete: !limited,
            ...(limited
              ? { partial: `the phrase limit kept ${request.limit} of ${matched.length} candidates` }
              : {}),
          };
        }
        const truncated = request.limit !== undefined && admitted.length > request.limit;
        const scoped = request.limit === undefined ? admitted : admitted.slice(0, request.limit);
        const bySha = new Set(scoped.map((commit) => commit.sha));
        const liveLines = new Map<string, number>();
        const coChange = new Map<string, number>();
        if (options.blame === true && named.length > 0) {
          // `paths` hints are not exempt from exclusion: a hint naming
          // an excluded file still never has its contents opened. The
          // filter excludes files before their contents are opened.
          const files = (
            await runGit(toplevel, ['ls-tree', '-r', '-z', '--name-only', sha, '--', ...pathspec], { signal })
          ).split('\0').filter((name) => name !== '')
            .filter((file) => !touches([file], [...excluded]));
          for (const file of files) {
            const output = await runGit(toplevel, ['blame', '--line-porcelain', sha, '--', file], { signal });
            const counts = new Map<string, number>();
            for (const match of output.matchAll(/^([0-9a-f]{40}) /gm)) {
              counts.set(match[1]!, (counts.get(match[1]!) ?? 0) + 1);
            }
            for (const [blamed, lines] of counts) {
              if (bySha.has(blamed)) {
                liveLines.set(blamed, (liveLines.get(blamed) ?? 0) + lines);
              }
            }
          }
        }
        if (options.coChange === true && named.length > 0) {
          // The first pass names all commits that touched a named
          // path; a `--name-only` log under the pathspec would list just
          // the named files, so the full path lists come from one
          // batched `git log --stdin` over those commits instead.
          const touchingShas = (await runGit(toplevel, [
            'log', '--no-merges', '--format=%H',
            sha, '--', ...pathspec,
          ], { signal }))
            .split('\n').map((line) => line.trim()).filter((line) => line !== '');
          const together = new Set<string>();
          if (touchingShas.length > 0) {
            const detail = await runGit(toplevel, [
              'log', '--no-walk=unsorted', '--stdin', '-z', '--format=%x1e%H', '--no-renames', '--name-only',
            ], { input: `${touchingShas.join('\n')}\n`, signal });
            for (const record of detail.split('\x1e')) {
              if (record.trim() === '') continue;
              const boundary = record.indexOf('\0');
              for (const file of pathNames(boundary < 0 ? '' : record.slice(boundary))) {
                if (!touches([file], named)) together.add(file);
              }
            }
          }
          const neighbours = [...together];
          if (neighbours.length > 0) {
            const touched = await runGit(toplevel, [
              'log', '--no-merges', '--format=%H', sha, '--', ...neighbours,
            ], { signal });
            for (const line of touched.split('\n')) {
              const commitSha = line.trim();
              if (bySha.has(commitSha)) coChange.set(commitSha, 1);
            }
          }
        }

        // Scoring needs each scoped commit's body once: when the pages
        // carried metadata only, the bodies come in bounded batches whose
        // contents are measured and released. A lane-cut read keeps just
        // the shared-word count; a bare read keeps the body it will emit.
        if (excluded.size !== 0) {
          for (let start = 0; start < scoped.length; start += BODY_PAGE) {
            const slice = scoped.slice(start, start + BODY_PAGE);
            const bodies = await readBodies(toplevel, slice.map((commit) => commit.sha), signal);
            slice.forEach((commit, index) => {
              commit.shared = hits(`${commit.subject}\n${bodies[index]!}`, terms);
              if (!cut) commit.body = bodies[index]!;
            });
          }
        }

        const signals = (commit: ScoredCommit) => {
          const out: Record<string, number> = {};
          const shared = commit.shared ?? hits(`${commit.subject}\n${commit.body ?? ''}`, terms);
          if (shared > 0) out['shared_words'] = Math.min(keyword.sharedWordCap, shared);
          const ageDays = (now - Date.parse(commit.date)) / 86_400_000;
          out['recency'] = Math.exp(-Math.max(0, ageDays) / keyword.recencyDays);
          if (named.length > 0 && touches(commit.changedPaths, named)) {
            out['named_path_touch'] = keyword.namedPathWeight;
          }
          const lines = liveLines.get(commit.sha);
          if (lines !== undefined) out['live_lines'] = keyword.liveLinesWeight + Math.log10(lines);
          if (coChange.has(commit.sha)) out['co_change'] = keyword.coChangeWeight;
          return out;
        };
        const emit = (commit: ScoredCommit, commitSignals: Record<string, number>): MemoryCandidate => ({
          sourceId: id,
          sourceRevision: sha,
          role: 'reference',
          id: `commit ${commit.short}`,
          title: commit.subject,
          text: commit.body ?? '',
          contentRef: commit.sha,
          date: { value: commit.date, meaning: 'recorded' as const },
          changedPaths: commit.changedPaths,
          repository: options.repository ?? toplevel,
          signals: commitSignals,
        });
        const signalSum = (entry: { signals: Record<string, number> }) =>
          Object.values(entry.signals).reduce((sum, value) => sum + value, 0);
        const partial = truncated
          ? (excluded.size === 0
            ? `the limit kept ${scoped.length} ${scoped.length === 1 ? 'commit' : 'commits'}; more exist`
            : `the limit kept ${scoped.length} of ${admitted.length} admitted commits`)
          : undefined;

        // With the lane cut on, the reader narrows its own lane at the
        // signal-sum score curve and reports the kept set, so the pick
        // does not cut it again. Only the kept commits' bodies are then
        // fetched, in bounded batches. A bare read keeps commit order.
        if (cut) {
          const ranked = scoped
            .map((commit) => ({ commit, signals: signals(commit) }))
            .sort((left, right) => signalSum(right) - signalSum(left)
              || `commit ${left.commit.short}`.localeCompare(`commit ${right.commit.short}`));
          const bend = laneBend(ranked.map(signalSum));
          const emitted = bend === undefined ? ranked : ranked.filter((entry) => signalSum(entry) > bend);
          for (let start = 0; start < emitted.length; start += BODY_PAGE) {
            const slice = emitted.slice(start, start + BODY_PAGE);
            const bodies = await readBodies(toplevel, slice.map((entry) => entry.commit.sha), signal);
            slice.forEach((entry, index) => { entry.commit.body = bodies[index]!; });
          }
          return {
            status: 'read' as const,
            revision: sha,
            candidates: emitted.map((entry) => emit(entry.commit, entry.signals)),
            complete: !truncated,
            laneCutApplied: true as const,
            matched: scoped.length,
            ...(partial === undefined ? {} : { partial }),
          };
        }

        return {
          status: 'read' as const,
          revision: sha,
          candidates: scoped.map((commit) => emit(commit, signals(commit))),
          complete: !truncated,
          ...(partial === undefined ? {} : { partial }),
        };
      } catch (error) {
        throw asSourceReadError(error);
      }
    },
  };
}
