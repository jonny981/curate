import { GIT_KEYWORD_SETTINGS, gitSettings, type GitKeywordSettings } from './defaults.js';
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
  sinceCutoff,
  taskMoment,
} from '@curatejs/core/internal';
import { bm25Term, tokenize, taskTerms, phraseCount, laneBend, normalized, similarity } from '@curatejs/core/internal';
import {
  checkIndexOption, indexDirectory, indexFilePath, openIndexFile, updateIndex, wordBag, bagEntries,
  type IndexDatabase, type StoredIndexOptions, type StoredIndexReport,
} from '@curatejs/core/internal';
import type { MemoryCandidate } from '@curatejs/core';
import {
  historySource,
  SourceReadError,
  type CandidateReadContext,
  type CandidateReadRequest,
  type CandidateReadResult,
  type CandidateSource,
} from '@curatejs/core';

export interface GitOptions {
  /** Override the exported GIT_KEYWORD_SETTINGS. */
  readonly keyword?: Partial<GitKeywordSettings>;
  /** The source's stable id; defaults to `git:<resolved repo>`. */
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
  /** Read only commits dated at or after an ISO date or a duration
   *  before the task date (for example, '14 days'); the task date is
   *  the read request's `taskDate`, else its `asOf`, else now. Omitted
   *  means the whole history. */
  readonly since?: string;
  /** Read only commits that changed at least one of these paths: a
   *  filter, unlike the read request's `paths`, which only hints at
   *  ranking. Entries are repository paths, or absolute paths inside
   *  the work tree. */
  readonly paths?: readonly string[];
  /** Paths this source alone refuses, joined onto the read request's
   *  `exclude` for its reads only: a commit that touched one is dropped
   *  before its body is ever fetched. */
  readonly exclude?: readonly string[];
  /** The stored index: one local file for this source, made on its
   *  first read and brought up to date at the start of each call with
   *  the commits it does not hold yet. A read of the head then takes each
   *  commit's subject, body and paths from the file; git only lists the
   *  commit names, once per call and date range. A read pinned to a
   *  revision reads the file only when this call brought it to that
   *  commit; any other pinned read runs git as before. `false` reads git
   *  directly on every read. */
  readonly index?: StoredIndexOptions | false;
}

interface LogCommit {
  readonly sha: string;
  readonly short: string;
  readonly date: string;
  readonly subject: string;
  readonly body: string;
  readonly changedPaths: readonly string[];
}

/** Each task word's mentions in a commit's subject and body joined, in
 *  task-word order, and that text's word count: all BM25 needs. */
interface Mentions {
  readonly counts: readonly number[];
  readonly length: number;
}

/** What a read keeps per commit once its page or body batch is released:
 *  the candidate's fields and its measured mentions, never the body
 *  unless the result emits it. */
interface ScoredCommit {
  readonly sha: string;
  readonly short: string;
  readonly date: string;
  readonly subject: string;
  readonly changedPaths: readonly string[];
  /** Task-word mentions, set when a body was measured for this commit. */
  mentions?: Mentions;
  /** The commit's BM25 score, set once the lane's counts are complete. */
  bm25?: number;
  /** The body, held only while the result still needs it. */
  body?: string;
}

/** Split or trimmed strings are slices of the page they came from, so
 *  a retained field would pin that whole page of log output. Fields a
 *  result keeps are copied flat before they are stored. */
const flat = (text: string): string => Buffer.from(text).toString('utf8');

const scored = (commit: Omit<LogCommit, 'body'>, extra: { mentions?: Mentions; body?: string } = {}): ScoredCommit => ({
  sha: flat(commit.sha), short: flat(commit.short), date: flat(commit.date),
  subject: flat(commit.subject), changedPaths: commit.changedPaths.map(flat),
  ...(extra.mentions === undefined ? {} : { mentions: extra.mentions }),
  ...(extra.body === undefined ? {} : { body: flat(extra.body) }),
});

/** Counts each task word's mentions in a commit's subject and body. */
function measure(subject: string, body: string, termIndex: ReadonlyMap<string, number>): Mentions {
  const tokens = tokenize(`${subject}\n${body}`);
  const counts = new Array<number>(termIndex.size).fill(0);
  for (const token of tokens) {
    const at = termIndex.get(token);
    if (at !== undefined) counts[at] = counts[at]! + 1;
  }
  return { counts, length: tokens.length };
}

/** Sets each commit's BM25 score. The commit count, how many commits hold
 *  each word and the average length all count these commits only, so a
 *  word common inside the lane ranks as common. */
function scoreBm25(commits: readonly ScoredCommit[], k1: number, b: number): void {
  const count = commits.length;
  const average = count === 0 ? 0 : commits.reduce((sum, commit) => sum + commit.mentions!.length, 0) / count;
  const holding: number[] = [];
  for (const commit of commits) {
    commit.mentions!.counts.forEach((f, at) => {
      if (f > 0) holding[at] = (holding[at] ?? 0) + 1;
    });
  }
  for (const commit of commits) {
    let score = 0;
    if (average > 0) {
      commit.mentions!.counts.forEach((f, at) => {
        if (f > 0) score += bm25Term(f, holding[at]!, count, commit.mentions!.length, average, k1, b);
      });
    }
    commit.bm25 = score;
  }
}

/** Records are separated by \x1e and fields by \x1f; `-z` leaves paths
 *  literal and NUL-separated, so a name with spaces or non-ASCII bytes is
 *  never quoted. */
const FULL_FORMAT = '%x1e%H%x1f%h%x1f%cI%x1f%s%x1f%b%x1f';
const META_FORMAT = '%x1e%H%x1f%h%x1f%cI%x1f%s';
/** The stored index's path check: no subject, so a commit it skips is
 *  never read past its name, date and paths. The empty last field keeps
 *  the layout `parseLog` reads. */
const PATHS_FORMAT = '%x1e%H%x1f%h%x1f%cI%x1f';
/** Commits per `git log` call. A long history is enumerated in pages so
 *  the parsed page's memory is released before the next. */
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

/** A commit as the stored index holds it: what a read emits. */
interface StoredCommit {
  readonly date: string;
  readonly subject: string;
  readonly body: string;
  readonly changedPaths: readonly string[];
  readonly length: number;
}

/** A source's stored index after this call's update, at the head it
 *  was brought up to date to. Commits stay in the file until a lane
 *  reads them. */
interface GitIndex {
  readonly path: string;
  readonly directory: string;
  readonly head: string;
  /** Every commit the file holds a subject and body for. */
  readonly held: ReadonlySet<string>;
  /** Every non-merge commit the head reaches, in `git log` order, with
   *  the abbreviation git gives it now. */
  readonly order: readonly { readonly sha: string; readonly short: string }[];
  readonly report: StoredIndexReport;
  /** The commit list of each date range this call read, listed once. */
  readonly ranges: Map<string, Promise<readonly { readonly sha: string; readonly short: string }[]>>;
}

/** The non-merge commits `sha` reaches inside `range`, in `git log`
 *  order, each with its full and abbreviated name. */
async function listCommits(
  toplevel: string, sha: string, range: readonly string[], signal: AbortSignal | undefined,
): Promise<{ sha: string; short: string }[]> {
  const output = await runGit(toplevel, ['log', '--no-merges', '--format=%H%x1f%h', ...range, sha], { signal });
  return output.split('\n').filter((line) => line !== '').map((line) => {
    const [full = '', short = ''] = line.split('\x1f');
    return { sha: full, short };
  });
}

/** Bring a source's stored index up to date with the head, in one write
 *  transaction. Commits the file does not hold are read in bounded
 *  batches and written as each batch arrives. A commit outside the
 *  call's date range is left unread and unrecorded, so a later call
 *  whose range holds it reads it then. With exclusions or a path list a
 *  commit's paths are listed first. A commit that touched one of the
 *  source's own excluded paths, or changed none of its listed paths, is
 *  recorded by name only: its subject and body are never read. A stored
 *  commit the head no longer reaches empties the file, and every commit
 *  is read again. */
async function syncGitIndex(
  path: string, directory: string, toplevel: string, head: string, own: readonly string[],
  only: readonly string[] | undefined, range: readonly string[], requested: readonly string[],
  signal: AbortSignal | undefined,
): Promise<GitIndex> {
  const database = await openIndexFile(path, directory);
  try {
    return await updateIndex(path, database, async () => {
      const started = performance.now();
      database.exec(`CREATE TABLE IF NOT EXISTS commits (sha TEXT PRIMARY KEY, date TEXT NOT NULL,
          subject TEXT NOT NULL, body TEXT NOT NULL, paths TEXT NOT NULL,
          length INTEGER NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS skipped (sha TEXT PRIMARY KEY) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS postings (term TEXT NOT NULL, sha TEXT NOT NULL,
          count INTEGER NOT NULL, PRIMARY KEY (term, sha)) WITHOUT ROWID;`);
      const order = await listCommits(toplevel, head, [], signal);
      const reached = new Set(order.map((commit) => commit.sha));
      const held = new Set((database.prepare('SELECT sha FROM commits').all() as { sha: string }[]).map((row) => row.sha));
      const skipped = new Set((database.prepare('SELECT sha FROM skipped').all() as { sha: string }[]).map((row) => row.sha));
      const rebuilt = [...held, ...skipped].some((sha) => !reached.has(sha));
      let removed = 0;
      if (rebuilt) {
        removed = held.size;
        database.exec('DELETE FROM commits; DELETE FROM skipped; DELETE FROM postings;');
        held.clear();
        skipped.clear();
      }
      const insert = database.prepare(`INSERT INTO commits (sha, date, subject, body, paths, length)
        VALUES (?, ?, ?, ?, ?, ?)`);
      const insertPosting = database.prepare('INSERT OR IGNORE INTO postings (term, sha, count) VALUES (?, ?, ?)');
      const skip = database.prepare('INSERT INTO skipped (sha) VALUES (?)');
      const dated = range.length === 0 ? undefined
        : new Set((await listCommits(toplevel, head, range, signal)).map((commit) => commit.sha));
      const missing = order.map((commit) => commit.sha)
        .filter((sha) => !held.has(sha) && !skipped.has(sha) && (dated === undefined || dated.has(sha)));
      let added = 0;
      for (let start = 0; start < missing.length; start += BODY_PAGE) {
        let batch = missing.slice(start, start + BODY_PAGE);
        if (own.length !== 0 || only !== undefined || requested.length !== 0) {
          const listed = parseLog(await runGit(toplevel, [
            'log', '--no-walk=unsorted', '--stdin', '--no-renames', '-z', `--format=${PATHS_FORMAT}`, '--name-only',
          ], { input: `${batch.join('\n')}\n`, signal }), false);
          const out = new Set<string>();
          for (const commit of listed) {
            if (touches(commit.changedPaths, own) || (only !== undefined && !touches(commit.changedPaths, only))) {
              skip.run(commit.sha);
              out.add(commit.sha);
            } else if (touches(commit.changedPaths, requested)) {
              // Left unread and unrecorded: a later call that does not
              // exclude it reads it then.
              out.add(commit.sha);
            }
          }
          batch = batch.filter((sha) => !out.has(sha));
        }
        if (batch.length === 0) continue;
        // A name cut from git's output would keep that whole output alive
        // in the set of held commits; the listing's own copy is kept.
        const names = new Map(batch.map((sha) => [sha, sha]));
        for (const commit of parseLog(await runGit(toplevel, [
          'log', '--no-walk=unsorted', '--stdin', '--no-renames', '-z', `--format=${FULL_FORMAT}`, '--name-only',
        ], { input: `${batch.join('\n')}\n`, signal }), true)) {
          const tokens = tokenize(`${commit.subject}\n${commit.body}`);
          insert.run(commit.sha, commit.date, commit.subject, commit.body, JSON.stringify(commit.changedPaths),
            tokens.length);
          for (const [term, count] of bagEntries(wordBag(tokens))) {
            insertPosting.run(term, commit.sha, count);
          }
          held.add(names.get(commit.sha) ?? commit.sha);
          added += 1;
        }
      }
      return { path, directory, head, held, order, ranges: new Map(),
        report: { parts: held.size, added, removed, rebuilt, ms: Math.round(performance.now() - started) } };
    });
  } finally {
    database.close();
  }
}

/** `git log` arguments for a date range in milliseconds. Git reads
 *  `@<seconds>` exactly; commit dates hold whole seconds. */
function dateRange(since: number, until: number): string[] {
  return [
    ...(Number.isFinite(since) ? [`--since=@${Math.ceil(since / 1000)}`] : []),
    ...(Number.isFinite(until) ? [`--until=@${Math.floor(until / 1000)}`] : []),
  ];
}

const NO_COMMIT = /Needed a single revision|does not have any commits|unknown revision|ambiguous argument/i;

/**
 * A repository's commit history: one candidate per non-merge commit,
 * newest first, carrying its subject, body, commit date and the files it
 * changed. Git runs through core's shared helper: `execFile` with no
 * shell, a scrubbed environment, no time or size limit, and the
 * request's abort signal reaching the process.
 *
 * With no exclusions, `git log` pages enumerate commits and paths, and
 * each page's task words are counted as it arrives. With exclusions, a
 * metadata pass lists paths first and a commit that touched any excluded
 * path is dropped before its body is ever fetched. A lane-cut read keeps
 * compact per-commit word counts, scores them with BM25 once they are
 * complete, and fetches bodies only for the commits the curve kept.
 * `blame` and `coChange` are opt-in extras on top.
 */
export function git(
  repo: string | URL,
  options: GitOptions = {},
): CandidateSource {
  const keyword = { ...GIT_KEYWORD_SETTINGS, ...options.keyword };
  const directory = repo instanceof URL ? fileURLToPath(repo) : repo;
  if (typeof directory !== 'string' || directory.trim() === '') {
    throw new TypeError('repo must be a directory path or a file: URL.');
  }
  const resolved = resolve(directory);
  const id = options.id ?? `git:${resolved}`;
  sinceCutoff(options.since, Date.now());
  const paths = options.paths?.map((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '') throw new TypeError('paths must contain non-empty strings.');
    return entry;
  });
  const exclude = options.exclude?.map((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '') throw new TypeError('exclude must contain non-empty strings.');
    return entry;
  });
  checkIndexOption(options.index);
  // One update per call: every read of one pick shares its read
  // context, so the index is brought up to date on the first read and
  // reused by every later lane whose date range lies inside the one that
  // update stored. A read with no context updates alone.
  const calls = new WeakMap<object, Map<string,
    { readonly since: number; readonly until: number; readonly loading: Promise<GitIndex> }[]>>();
  // One call asks git where the work tree is once, and a commit the call
  // already resolved is its own name: the pick pins every later lane to
  // the first lane's commit, so those lanes start no git process here.
  const asked = new WeakMap<object, { toplevel?: string; readonly commits: Set<string> }>();
  const resolveExcluded = async (entries: readonly string[], toplevel: string) => {
    const resolved = new Set<string>();
    for (const entry of entries) {
      const path = repoPath(isAbsolute(entry) ? await canonicalPath(entry) : entry, toplevel);
      if (path !== undefined) resolved.add(path);
    }
    return [...resolved];
  };
  const loadIndex = async (
    directory: string, toplevel: string, head: string, range: readonly string[], requested: readonly string[],
    signal: AbortSignal | undefined,
  ) => {
    // The source's own exclusions, path list and look-back decide which
    // commits exist: they name the file.
    const path = indexFilePath(directory, id, { exclude: exclude ?? [],
      ...(paths === undefined ? {} : { paths }), ...(options.since === undefined ? {} : { since: options.since }) });
    return syncGitIndex(path, directory, toplevel, head, await resolveExcluded(exclude ?? [], toplevel),
      paths === undefined ? undefined : await resolveExcluded(paths, toplevel), range, requested, signal);
  };
  const reader: CandidateSource = {
    id,
    kind: 'git-history',
    role: 'reference',
    ...(options.since === undefined ? {} : { since: options.since }),
    ...(paths === undefined ? {} : { paths }),
    ...(exclude === undefined ? {} : { exclude }),
    async read(request: CandidateReadRequest, context?: CandidateReadContext) {
      const signal = request.signal;
      if (signal?.aborted) throw new SourceReadError('cancelled', 'The read was cancelled.');
      if (request.limit !== undefined
        && (!Number.isSafeInteger(request.limit) || request.limit < 1)) {
        throw new TypeError('limit must be a positive safe integer.');
      }
      // Recency counts back from the task date, else the pick's moment, else now.
      const now = taskMoment(request.taskDate ?? request.asOf, request.timeZone);
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

      let call = context === undefined ? undefined : asked.get(context);
      if (context !== undefined && call === undefined) asked.set(context, call = { commits: new Set() });
      let toplevel: string;
      if (call?.toplevel !== undefined) {
        toplevel = call.toplevel;
      } else {
        let probe;
        try {
          probe = await probeWorkTree(resolved, signal);
          // realpath matches knowledgeBase's canonicalisation, so a
          // repository key is the same value on both sides of a link.
          toplevel = probe.status === 'worktree' ? await realpath(probe.toplevel) : '';
        } catch (error) {
          throw asSourceReadError(error);
        }
        if (probe.status === 'absent') return probe;
        if (call !== undefined) call.toplevel = toplevel;
      }

      // The pinned revision (HEAD by default) is resolved once here, at
      // read start; every git call below addresses the SHA it returned,
      // so the whole read sees one snapshot even when HEAD moves on.
      let sha: string;
      try {
        sha = request.revision !== undefined && call?.commits.has(request.revision) === true
          ? request.revision : await resolveCommit(toplevel, request.revision ?? 'HEAD', signal);
        call?.commits.add(sha);
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

      // This read's own connection to the stored index, closed when it ends.
      let database: IndexDatabase | undefined;
      try {
        // A read of the head brings the stored index up to date, once per
        // call, and reads it. A pinned read reads it only when this call
        // already brought it to the pinned commit, as the later lanes of a
        // call are pinned to the first lane's; any other pinned read reads git.
        const directory = indexDirectory(options.index);
        let stored: GitIndex | undefined;
        if (directory !== undefined) {
          const requested = await resolveExcluded(request.exclude ?? [], toplevel);
          // The call's date range: the source's look-back and the task
          // date. A relative look-back moves with the clock, so a later
          // lane's range starts later and still lies inside the first.
          // Each read keeps its own date filter below.
          const since = sinceCutoff(options.since, now);
          const until = request.taskDate === undefined ? Number.POSITIVE_INFINITY : now;
          const key = JSON.stringify(requested);
          let byRead = context === undefined ? undefined : calls.get(context);
          if (context !== undefined && byRead === undefined) calls.set(context, byRead = new Map());
          let loading = byRead?.get(key)?.find((update) => update.since <= since && update.until >= until)?.loading;
          if (loading === undefined && request.revision === undefined) {
            loading = loadIndex(directory, toplevel, sha, dateRange(since, until), requested, signal);
            if (byRead !== undefined) byRead.set(key, [...byRead.get(key) ?? [], { since, until, loading }]);
          }
          const loaded = await loading;
          if (loaded?.head === sha) {
            stored = loaded;
            database = await openIndexFile(loaded.path, loaded.directory);
          }
        }
        const indexed = stored === undefined ? {} : { index: stored.report };
        // Exclusions are resolved to repository-relative paths first.
        // An absolute entry is canonicalised through realpath, because
        // the toplevel is: an entry written through a symlinked path (a
        // /var tmpdir, a linked workspace) would otherwise escape the
        // toplevel spelling and be dropped, failing the exclusion open.
        const excluded = new Set<string>();
        for (const entry of [...(exclude ?? []), ...(request.exclude ?? [])]) {
          const path = repoPath(
            isAbsolute(entry) ? await canonicalPath(entry) : entry,
            toplevel,
          );
          if (path !== undefined) excluded.add(path);
        }
        // The source's own `paths` is a filter, resolved to
        // repository-relative paths like an exclusion. An entry outside
        // the repository resolves to nothing: it can admit nothing.
        const only = paths === undefined ? undefined : (await Promise.all(paths.map(async (entry) =>
          repoPath(isAbsolute(entry) ? await canonicalPath(entry) : entry, toplevel))))
          .filter((path): path is string => path !== undefined);
        // A kind lane's `task` is the phrase; its `topic` is the task
        // the lane serves, and that is what the matches are scored on.
        const terms = taskTerms(request.topic ?? request.task, request.paths ?? [], keyword.stopWords);
        const termIndex = new Map(terms.map((term, at) => [term, at]));
        const embedBox = context?.shared;
        let embedShared = embedBox?.get(reader) as { meaning?: Lite } | undefined;
        if (embedBox !== undefined && embedShared === undefined) embedBox.set(reader, embedShared = {});
        // A stored commit's row, read once per read when a lane needs it.
        const rowOf = database?.prepare('SELECT date, subject, body, paths, length FROM commits WHERE sha = ?');
        const storedCommit = (commitSha: string): StoredCommit => {
          const row = rowOf!.get(commitSha) as Record<string, unknown>;
          return {
            date: row.date as string, subject: row.subject as string, body: row.body as string,
            changedPaths: JSON.parse(row.paths as string) as string[], length: row.length as number,
          };
        };
        // A stored commit's task-word mentions come from its postings:
        // the same token counts `measure` counts in its text. Each task
        // term's count is a point lookup on the postings primary key, so
        // the rows never outlive the lane's page.
        const postingOf = database?.prepare('SELECT count FROM postings WHERE term = ? AND sha = ?');
        const lengthOf = database?.prepare('SELECT length FROM commits WHERE sha = ?');
        const mentionsOf = (commit: { readonly sha: string; readonly subject: string }, body: string): Mentions => {
          if (stored === undefined) return measure(commit.subject, body, termIndex);
          return {
            counts: terms.map((term) =>
              (postingOf!.get(term, commit.sha) as { count: number } | undefined)?.count ?? 0),
            length: (lengthOf!.get(commit.sha) as { length: number }).length,
          };
        };
        const bodiesOf = async (shas: readonly string[]): Promise<readonly string[]> => stored === undefined
          ? readBodies(toplevel, shas, signal) : shas.map((commitSha) => storedCommit(commitSha).body);
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
        // With a task date, a commit dated after it is not read; a period
        // read keeps only the commits dated inside the task's period, and
        // the source's own `since` bounds the history from below.
        const period = request.taskPeriod;
        const sinceMs = Math.max(sinceCutoff(options.since, now),
          period === undefined ? Number.NEGATIVE_INFINITY : Date.parse(period.from));
        const until = Math.min(request.taskDate === undefined ? Number.POSITIVE_INFINITY : now,
          period === undefined ? Number.POSITIVE_INFINITY : Date.parse(period.to));
        const range = dateRange(sinceMs, until);
        // A commit must pass both filters before its body is fetched:
        // the exclusions and the source's own path list each gate it.
        const filtered = excluded.size !== 0 || only !== undefined;
        const cut = request.wholeLanes === false;
        // With `wholeLanes` on a lane read keeps every commit and marks
        // each one the cut would have dropped.
        const mark = request.wholeLanes === true;

        // With no exclusions the log pages carry bodies: a bare read keeps
        // them for its candidates, a lane-cut read measures each page's
        // task-word mentions and releases the bodies, and a phrase read counts
        // each page's phrase and keeps only the matching bodies. With
        // exclusions the pages carry metadata only; the bodies of admitted
        // commits come from bounded `git log --stdin` batches, so a commit
        // that touched an excluded path never has its body read. One more
        // commit than the limit is enumerated when it can be known up
        // front, so `complete` knows whether the list was truncated;
        // phrase, kind and meaning lanes and exclusions enumerate the
        // whole history, since the limit then slices a filtered set, not
        // the enumeration.
        const wanted = !filtered && request.limit !== undefined
          && request.phraseLane !== true && request.meaningLane === undefined
          ? request.limit + 1
          : undefined;
        const enumerated: ScoredCommit[] = [];
        const phrases: { commit: ScoredCommit; count: number }[] = [];
        // The first meaning lane of a call scores every commit against
        // the call's whole query list at once, and the lanes after it
        // read the held scores; a read outside a shared context scores
        // its own query alone, as before.
        const meaningQueries = request.meaningLane === undefined ? undefined
          : (request.meaningQueries ?? [request.task]);
        interface Lite {
          queries: readonly string[];
          sims: Map<string, number[]>;
        }
        let lite = meaningQueries === undefined ? undefined : embedShared?.meaning;
        let queryVectors: readonly Float64Array[] | undefined;
        if (meaningQueries !== undefined && (lite === undefined || lite.queries.length !== meaningQueries.length
          || lite.queries.some((query, index) => query !== meaningQueries[index]))) {
          lite = { queries: meaningQueries, sims: new Map() };
          queryVectors = (await request.meaningLane!.embed(meaningQueries, signal)).map((vector) => normalized(vector));
          if (embedShared !== undefined) embedShared.meaning = lite;
        }
        let pendingEmbed: { sha: string; text: string }[] = [];
        const flushEmbed = async () => {
          const held = lite;
          const queries = queryVectors;
          if (pendingEmbed.length === 0 || queries === undefined || held === undefined) return;
          const vectors = await request.meaningLane!.embed(pendingEmbed.map((part) => part.text), signal);
          if (vectors.length !== pendingEmbed.length) throw new TypeError('embed must return one vector per input text.');
          pendingEmbed.forEach((part, index) => {
            const unit = normalized(vectors[index]!, queries[0]!.length);
            held.sims.set(part.sha, queries.map((query) => similarity(unit, query)));
          });
          pendingEmbed = [];
        };
        // The lane's own query is not on the shared list: score it alone.
        let at = lite?.queries.indexOf(request.task) ?? -1;
        if (lite !== undefined && at === -1) {
          lite = { queries: [request.task], sims: new Map() };
          queryVectors = (await request.meaningLane!.embed([request.task], signal)).map((vector) => normalized(vector));
          at = 0;
        }
        // With the index, the commits in the date range come from the
        // file, in `git log` order; a commit the source's own exclusions
        // left unstored is one the direct read would drop too.
        let listed: readonly { readonly sha: string; readonly short: string }[] | undefined;
        if (stored !== undefined) {
          const key = JSON.stringify(range);
          let listing = range.length === 0 ? Promise.resolve(stored.order) : stored.ranges.get(key);
          if (listing === undefined) stored.ranges.set(key, listing = listCommits(toplevel, stored.head, range, signal));
          listed = (await listing).filter((commit) => stored.held.has(commit.sha));
        }
        for (let offset = 0; wanted === undefined || offset < wanted;) {
          const page = wanted === undefined ? LOG_PAGE : Math.min(LOG_PAGE, wanted - offset);
          const batch = listed !== undefined
            ? listed.slice(offset, offset + page).map(({ sha: commitSha, short }): LogCommit => {
              const held = storedCommit(commitSha);
              return { sha: commitSha, short, date: held.date, subject: held.subject,
                body: filtered ? '' : held.body, changedPaths: held.changedPaths };
            })
            : parseLog(
              await runGit(toplevel, [
                'log', '--no-merges', '--no-renames', '-z',
                `--format=${filtered ? META_FORMAT : FULL_FORMAT}`,
                '--name-only', '-n', String(page), ...range,
                ...(offset === 0 ? [] : ['--skip', String(offset)]), sha,
              ], { signal }),
              !filtered,
            );
          for (const commit of batch) {
            if (filtered) {
              enumerated.push(scored(commit));
            } else if (lite !== undefined) {
              // The page's body is embedded and released with it; only
              // the similarity survives.
              enumerated.push(scored(commit));
              if (!lite.sims.has(commit.sha)) {
                pendingEmbed.push({ sha: commit.sha, text: `${commit.subject}\n${commit.body}` });
                if (pendingEmbed.length === 32) await flushEmbed();
              }
            } else if (request.phraseLane === true && request.topic !== undefined) {
              // A kind lane's match keeps the commit's topic score, not
              // its body: only commits the curve keeps get one back.
              const count = phraseCount(commit.subject, request.task) + phraseCount(commit.body, request.task);
              if (count > 0) {
                phrases.push({
                  commit: scored(commit, { mentions: mentionsOf(commit, commit.body) }),
                  count,
                });
              }
            } else if (request.phraseLane === true) {
              const count = phraseCount(commit.subject, request.task) + phraseCount(commit.body, request.task);
              if (count > 0) phrases.push({ commit: scored(commit, { body: commit.body }), count });
            } else if (cut) {
              enumerated.push(scored(commit, { mentions: mentionsOf(commit, commit.body) }));
            } else {
              enumerated.push(scored(commit, { body: commit.body }));
            }
          }
          if (batch.length < page) break;
          offset += batch.length;
        }
        await flushEmbed();
        // A commit touching any excluded path is not admitted, even when
        // it also touched an allowed one; its body is never fetched. A
        // path list admits only the commits that changed one of its
        // paths.
        const admitted = !filtered
          ? enumerated
          : enumerated.filter((commit) => !touches(commit.changedPaths, [...excluded])
            && (only === undefined || touches(commit.changedPaths, only)));

        // A meaning lane embeds each admitted commit's subject and body
        // in bounded batches, keeps the similarity curve's side, and
        // fetches bodies only for the kept commits. With exclusions the
        // bodies it needs arrive in the same bounded batches, after the
        // path filter has dropped their commits.
        if (lite !== undefined) {
          if (filtered) {
            for (let start = 0; start < admitted.length; start += BODY_PAGE) {
              const slice = admitted.slice(start, start + BODY_PAGE);
              const bodies = await bodiesOf(slice.map((commit) => commit.sha));
              for (const [index, body] of bodies.entries()) {
                if (lite.sims.has(slice[index]!.sha)) continue;
                pendingEmbed.push({ sha: slice[index]!.sha, text: `${slice[index]!.subject}\n${body}` });
                if (pendingEmbed.length === 32) await flushEmbed();
              }
            }
            await flushEmbed();
          }
          const similarities = admitted.map((commit) => lite.sims.get(commit.sha)![at]!);
          const order = admitted.map((_, index) => index)
            .sort((a, b) => (similarities[b] ?? 0) - (similarities[a] ?? 0)
              || `commit ${admitted[a]!.short}`.localeCompare(`commit ${admitted[b]!.short}`));
          const bend = cut || mark ? laneBend(order.map((index) => similarities[index]!)) : undefined;
          // A cut lane where nothing scored above zero matched nothing:
          // it keeps no parts rather than fetch every body.
          const matched = order.some((index) => similarities[index]! > 0);
          const passes = (index: number) => bend === undefined ? matched : similarities[index]! > bend;
          const kept = cut ? order.filter(passes) : order;
          // `limit` carries the caller's `nearest` cap: it slices the
          // kept set after the curve, not the enumeration before it.
          const limited = request.limit === undefined ? kept : kept.slice(0, request.limit);
          // The lane reports its whole scored list as ids and scores in
          // `meaningScores`; `candidates` still holds every kept commit —
          // under `wholeLanes` that is the whole list, with the commits a
          // cut would drop marked.
          // A caller that uses whole candidates only inside the bend gets
          // those alone, so the marked commits' bodies are never fetched.
          const whole = mark && request.keptBodiesOnly === true ? limited.filter(passes) : limited;
          for (let start = 0; start < whole.length; start += BODY_PAGE) {
            const slice = whole.slice(start, start + BODY_PAGE);
            const bodies = await bodiesOf(slice.map((index) => admitted[index]!.sha));
            slice.forEach((index, at) => { admitted[index]!.body = bodies[at]!; });
          }
          const limitedReads = request.limit !== undefined && kept.length > request.limit;
          return {
            status: 'read' as const,
            revision: sha,
            ...indexed,
            meaningLane: true as const,
            meaningScores: (mark ? order : limited).map((index) => ({
              id: `commit ${admitted[index]!.short}`, similarity: similarities[index]!,
              ...(mark && !passes(index) ? { pastLaneCut: true as const } : {}),
            })),
            candidates: whole.map((index): MemoryCandidate => ({
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
              ...(mark && !passes(index) ? { pastLaneCut: true as const } : {}),
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
        // compact word counts until the curve cut picks the kept set; only
        // those bodies are fetched.
        if (request.phraseLane === true && request.topic !== undefined) {
          if (filtered) {
            for (let start = 0; start < admitted.length; start += BODY_PAGE) {
              const slice = admitted.slice(start, start + BODY_PAGE);
              const bodies = await bodiesOf(slice.map((commit) => commit.sha));
              slice.forEach((commit, index) => {
                const count = phraseCount(commit.subject, request.task)
                  + phraseCount(bodies[index]!, request.task);
                if (count > 0) {
                  phrases.push({
                    commit: { ...commit, mentions: mentionsOf(commit, bodies[index]!) },
                    count,
                  });
                }
              });
            }
          }
          // BM25 counts over the phrase matches this lane ranks.
          scoreBm25(phrases.map(({ commit }) => commit), keyword.k1, keyword.b);
          const laneSignals = (commit: ScoredCommit): Record<string, number> => {
            const out: Record<string, number> = {};
            if (commit.bm25! > 0) out['bm25'] = commit.bm25!;
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
          const bend = cut || mark ? laneBend(ranked.map(laneSum)) : undefined;
          const passes = (entry: (typeof ranked)[number]) => bend === undefined || laneSum(entry) > bend;
          const curveKept = cut ? ranked.filter(passes) : ranked;
          const limitedByCount = request.limit !== undefined && curveKept.length > request.limit;
          const kept = limitedByCount ? curveKept.slice(0, request.limit) : curveKept;
          for (let start = 0; start < kept.length; start += BODY_PAGE) {
            const slice = kept.slice(start, start + BODY_PAGE);
            const bodies = await bodiesOf(slice.map((entry) => entry.commit.sha));
            slice.forEach((entry, index) => { entry.commit.body = bodies[index]!; });
          }
          return {
            status: 'read' as const,
            revision: sha,
            ...indexed,
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
              ...(mark && !passes(entry) ? { pastLaneCut: true as const } : {}),
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
          if (filtered) {
            for (let start = 0; start < admitted.length; start += BODY_PAGE) {
              const slice = admitted.slice(start, start + BODY_PAGE);
              const bodies = await bodiesOf(slice.map((commit) => commit.sha));
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
            ...indexed,
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
        // the mentions; a bare read keeps the body it will emit.
        if (filtered) {
          for (let start = 0; start < scoped.length; start += BODY_PAGE) {
            const slice = scoped.slice(start, start + BODY_PAGE);
            const bodies = await bodiesOf(slice.map((commit) => commit.sha));
            slice.forEach((commit, index) => {
              commit.mentions = mentionsOf(commit, bodies[index]!);
              if (!cut) commit.body = bodies[index]!;
            });
          }
        }
        // BM25 counts over the commits this lane ranks: those left after
        // the look-back, the path filter, the exclusions, the task's date
        // or period, and the limit.
        for (const commit of scoped) commit.mentions ??= mentionsOf(commit, commit.body ?? '');
        scoreBm25(scoped, keyword.k1, keyword.b);

        const signals = (commit: ScoredCommit) => {
          const out: Record<string, number> = {};
          if (commit.bm25! > 0) out['bm25'] = commit.bm25!;
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
          ? (!filtered
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
            const bodies = await bodiesOf(slice.map((entry) => entry.commit.sha));
            slice.forEach((entry, index) => { entry.commit.body = bodies[index]!; });
          }
          return {
            status: 'read' as const,
            revision: sha,
            ...indexed,
            candidates: emitted.map((entry) => emit(entry.commit, entry.signals)),
            complete: !truncated,
            laneCutApplied: true as const,
            matched: scoped.length,
            ...(partial === undefined ? {} : { partial }),
          };
        }

        // With `wholeLanes` on, each commit the signal-sum cut would have
        // dropped is marked; the read still keeps commit order.
        const scopedSignals = scoped.map(signals);
        const sums = scopedSignals.map((commitSignals) => signalSum({ signals: commitSignals }));
        const bend = mark ? laneBend(sums) : undefined;
        return {
          status: 'read' as const,
          revision: sha,
          ...indexed,
          candidates: scoped.map((commit, index) => ({ ...emit(commit, scopedSignals[index]!),
            ...(bend !== undefined && sums[index]! <= bend ? { pastLaneCut: true as const } : {}) })),
          complete: !truncated,
          ...(partial === undefined ? {} : { partial }),
        };
      } catch (error) {
        throw asSourceReadError(error);
      } finally {
        database?.close();
      }
    },
  };
  return historySource({ reader, ...gitSettings });
}
