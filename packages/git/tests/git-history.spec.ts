import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, writeFileSync } from 'node:fs';
import { appendFile, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pickFromSources, type CandidateSource } from '@curatejs/core';
import { git as gitSource } from '../src/index.js';
import { commitDate } from '@curatejs/core/internal';

// The reader's own git invocations always carry `-c core.hooksPath=…`;
// recording only those calls keeps the fixture's own commits out of the
// counts the specs assert on. The child environment rides along so the
// locale pinning is asserted on what the process actually received, the
// stdin stream is tapped so a spec can see which revisions a batched
// read asked for, and the child is handed to onGitChild so a spec can
// act on the running process.
const gitCalls: string[][] = [];
const gitInputs: (string | undefined)[] = [];
const gitEnvs: (NodeJS.ProcessEnv | undefined)[] = [];
let onGitChild: ((child: ChildProcess, args: readonly string[]) => void) | undefined;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const wrapped = (...rest: unknown[]) => {
    const child = (actual.execFile as (...call: unknown[]) => ChildProcess)(...rest);
    const args = rest[1];
    if (Array.isArray(args) && args.some((arg) => String(arg).startsWith('core.hooksPath='))) {
      const recorded = args.map(String);
      gitCalls.push(recorded);
      gitInputs.push(undefined);
      const index = gitCalls.length - 1;
      const stdin = child.stdin;
      if (stdin !== null) {
        const end = stdin.end.bind(stdin) as (...call: unknown[]) => unknown;
        stdin.end = ((...call: unknown[]) => {
          if (typeof call[0] === 'string' && call[0] !== '') gitInputs[index] = call[0];
          return end(...call);
        }) as typeof stdin.end;
      }
      gitEnvs.push((rest[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env);
      onGitChild?.(child, recorded);
    }
    return child;
  };
  return { ...actual, execFile: wrapped };
});

const temporaryDirectories: string[] = [];

const IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(directory: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', directory, ...args], { env: { ...process.env, ...env } },
      (error, stdout) => {
        if (error === null) resolve(stdout.toString());
        else reject(error);
      });
  });
}

interface FixtureCommit {
  readonly subject: string;
  readonly body?: string;
  readonly date?: string;
  readonly files: Record<string, string>;
}

async function writeFiles(directory: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    const file = join(directory, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

async function commit(
  directory: string,
  message: string,
  date?: string,
): Promise<void> {
  await git(directory, ['add', '-A']);
  await git(directory, ['commit', '-m', message], {
    ...IDENTITY,
    ...(date === undefined ? {} : { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }),
  });
}

async function repository(commits: readonly FixtureCommit[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'curate-git-'));
  temporaryDirectories.push(directory);
  await git(directory, ['init', '-b', 'main']);
  for (const { subject, body, date, files } of commits) {
    await writeFiles(directory, files);
    await commit(directory, body === undefined ? subject : `${subject}\n\n${body}`, date);
  }
  return directory;
}

/** Two non-merge commits, then a merge that carries a branch commit
 *  with it. */
async function repositoryWithMerge(): Promise<string> {
  const directory = await repository([
    {
      subject: 'first change',
      body: 'the first body',
      date: '2026-09-01T10:00:00Z',
      files: { 'docs/a.md': 'first version' },
    },
    {
      subject: 'second change',
      body: 'the second body',
      date: '2026-10-01T10:00:00Z',
      files: { 'docs/b.md': 'second file' },
    },
  ]);
  await git(directory, ['checkout', '-b', 'side']);
  await writeFiles(directory, { 'docs/side.md': 'side file' });
  await commit(directory, 'side change', '2026-10-02T10:00:00Z');
  await git(directory, ['checkout', 'main']);
  await git(directory, ['merge', '--no-ff', 'side', '-m', 'merge the side branch'], IDENTITY);
  return directory;
}

function read(
  source: CandidateSource,
  request: { task: string } & Omit<Parameters<CandidateSource['read']>[0], 'task'>,
) {
  return source.read(request);
}

beforeEach(() => {
  gitCalls.length = 0;
  gitInputs.length = 0;
  gitEnvs.length = 0;
  onGitChild = undefined;
});

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('commitDate', () => {
  // git 2.39 prints a UTC committer date as +00:00 and git 2.55 prints Z;
  // the fixture specs only see whichever git the machine has.
  it('gives a UTC date one form whatever the git version', () => {
    expect(commitDate('2026-10-02T10:00:00Z')).toBe('2026-10-02T10:00:00+00:00');
    expect(commitDate('2026-10-02T10:00:00+00:00')).toBe('2026-10-02T10:00:00+00:00');
  });

  it('leaves a date with another offset unchanged', () => {
    expect(commitDate('2026-10-02T11:00:00+01:00')).toBe('2026-10-02T11:00:00+01:00');
  });
});

describe('git', () => {
  it('emits one candidate per non-merge commit, newest first, carrying the commit fields', async () => {
    const directory = await repositoryWithMerge();
    const toplevel = (await git(directory, ['rev-parse', '--show-toplevel'])).trim();
    const head = (await git(directory, ['rev-parse', 'HEAD'])).trim();
    const side = (await git(directory, ['rev-parse', 'side'])).trim();

    const result = await read(gitSource(directory), { task: 'work on the docs' });

    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    expect(result.revision).toBe(head);
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[0]).toMatchObject({
      sourceId: `git:${directory}`,
      sourceRevision: head,
      role: 'reference',
      id: `commit ${side.slice(0, 7)}`,
      title: 'side change',
      text: '',
      contentRef: side,
      changedPaths: ['docs/side.md'],
      repository: toplevel,
    });
    expect(result.candidates[0]!.date).toEqual({
      value: '2026-10-02T10:00:00+00:00',
      meaning: 'recorded',
    });
    expect(result.candidates[1]).toMatchObject({
      id: `commit ${(await git(directory, ['rev-parse', 'HEAD~1'])).trim().slice(0, 7)}`,
      title: 'second change',
      text: 'the second body',
      changedPaths: ['docs/b.md'],
    });
    expect(result.candidates[1]!.contentRef).toHaveLength(40);
    expect(result.candidates[2]).toMatchObject({
      title: 'first change',
      text: 'the first body',
      changedPaths: ['docs/a.md'],
    });
    expect(result.candidates.every((candidate) => candidate.title !== 'merge the side branch')).toBe(true);
    expect(result.complete).toBe(true);
  });

  it('accepts a file: URL for the repository', async () => {
    const directory = await repository([{ subject: 'one', files: { 'a.md': 'a' } }]);
    const result = await read(gitSource(new URL(`file://${directory}`)), { task: 'work' });
    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    expect(result.candidates).toHaveLength(1);
  });

  it('reports absent for a directory that is not a repository', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'curate-git-'));
    temporaryDirectories.push(directory);
    await expect(read(gitSource(directory), { task: 'work' }))
      .resolves.toEqual({ status: 'absent', reason: 'no-history' });
  });

  it('reports absent for a bare repository, which has no work tree', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'curate-git-'));
    temporaryDirectories.push(directory);
    await git(directory, ['init', '--bare', '-b', 'main']);
    await expect(read(gitSource(directory), { task: 'work' }))
      .resolves.toEqual({ status: 'absent', reason: 'no-history' });
  });

  it('reports absent for a path that is not a directory', async () => {
    const directory = await repository([{ subject: 'one', files: { 'a.md': 'a' } }]);
    await expect(read(gitSource(join(directory, 'a.md')), { task: 'work' }))
      .resolves.toEqual({ status: 'absent', reason: 'not-a-directory' });
  });

  it('reports absent for an empty repository and for a missing git binary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'curate-git-'));
    temporaryDirectories.push(directory);
    await git(directory, ['init', '-b', 'main']);
    await expect(read(gitSource(directory), { task: 'work' }))
      .resolves.toEqual({ status: 'absent', reason: 'no-history' });

    const withoutBinaries = await mkdtemp(join(tmpdir(), 'curate-git-'));
    temporaryDirectories.push(withoutBinaries);
    const path = process.env.PATH;
    process.env.PATH = withoutBinaries;
    try {
      await expect(read(gitSource(directory), { task: 'work' }))
        .resolves.toEqual({ status: 'absent', reason: 'no-git-binary' });
    } finally {
      process.env.PATH = path;
    }
  });

  it('throws a SourceReadError for a pinned revision the repository does not have', async () => {
    const directory = await repository([{ subject: 'one', files: { 'a.md': 'a' } }]);
    const missing = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    await expect(read(gitSource(directory), { task: 'work', revision: missing }))
      .rejects.toMatchObject({ name: 'SourceReadError', code: 'failed' });
  });

  it('resolves the pin once and carries the SHA to every later git call', async () => {
    const directory = await repository([
      { subject: 'one', files: { 'a.md': 'a' } },
      { subject: 'two', files: { 'b.md': 'b' } },
    ]);
    const head = (await git(directory, ['rev-parse', 'HEAD'])).trim();

    await read(gitSource(directory), { task: 'work', revision: 'HEAD' });

    const revParses = gitCalls.filter((args) => args.includes('rev-parse'));
    expect(revParses.map((args) => args.slice(6))).toEqual([
      ['rev-parse', '--show-toplevel'],
      ['rev-parse', '--verify', 'HEAD^{commit}'],
    ]);
    const later = gitCalls.filter((args) => !args.includes('rev-parse'));
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((args) => args.includes(head))).toBe(true);
    expect(later.every((args) => !args.includes('HEAD'))).toBe(true);
  });

  it('enumerates only the commits the pinned revision names', async () => {
    const directory = await repository([
      { subject: 'one', files: { 'a.md': 'a' } },
      { subject: 'two', files: { 'b.md': 'b' } },
    ]);
    const first = (await git(directory, ['rev-parse', 'HEAD~1'])).trim();

    const result = await read(gitSource(directory), { task: 'work', revision: first });

    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    expect(result.revision).toBe(first);
    expect(result.candidates.map((candidate) => candidate.title)).toEqual(['one']);
  });

  it('keeps the resolved snapshot when HEAD advances after the pin resolves', async () => {
    const directory = await repository([
      { subject: 'one', files: { 'a.md': 'a' } },
      { subject: 'two', files: { 'b.md': 'b' } },
    ]);
    const pinned = (await git(directory, ['rev-parse', 'HEAD'])).trim();
    onGitChild = (child, args) => {
      // The pause the proof needs: 'HEAD' has already resolved, and this
      // commit lands before the enumeration starts. The read must still
      // describe the SHA the resolution returned.
      if (args.includes('--verify')) {
        child.once('close', () => {
          writeFileSync(join(directory, 'c.md'), 'c');
          execFileSync('git', ['-C', directory, 'add', '-A'], {
            env: { ...process.env, ...IDENTITY },
          });
          execFileSync('git', ['-C', directory, 'commit', '-m', 'racing commit'], {
            env: { ...process.env, ...IDENTITY },
          });
        });
      }
    };
    try {
      const result = await read(gitSource(directory), { task: 'work', revision: 'HEAD' });

      expect(result.status).toBe('read');
      if (result.status !== 'read') return;
      expect(result.revision).toBe(pinned);
      expect(result.candidates.map((candidate) => candidate.title)).toEqual(['two', 'one']);
      const logs = gitCalls.filter((args) => args[6] === 'log');
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.every((args) => args.includes(pinned))).toBe(true);
      expect(logs.every((args) => !args.includes('HEAD'))).toBe(true);
    } finally {
      onGitChild = undefined;
    }
  });

  it('drops a commit that touched an excluded path and never fetches its body', async () => {
    const directory = await repository([
      { subject: 'kept', body: 'the kept body', files: { 'a.md': 'a' } },
      { subject: 'mixed', body: 'the mixed body', files: { 'a.md': 'a2', 'secret.md': 's' } },
    ]);
    const mixed = (await git(directory, ['rev-parse', 'HEAD'])).trim();

    const kept = (await git(directory, ['rev-parse', 'HEAD~1'])).trim();
    const result = await read(
      gitSource(directory),
      { task: 'work', exclude: ['secret.md'] },
    );

    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    expect(result.candidates.map((candidate) => candidate.title)).toEqual(['kept']);
    // The admitted commit's body comes from the batched read.
    expect(result.candidates[0]!.text).toBe('the kept body');
    // The exclusion ran before any body was read: the metadata pass
    // carries no `%b`, and the one batched body read names only the
    // admitted commit on its stdin.
    const logs = gitCalls.filter((args) => args[6] === 'log' && !args.includes('--stdin'));
    expect(logs).toHaveLength(1);
    const format = logs[0]!.find((arg) => arg.startsWith('--format='));
    expect(format).toBeDefined();
    expect(format).not.toContain('%b');
    const bodies = gitCalls
      .map((args, index) => ({ args, index }))
      .filter(({ args }) => args.includes('--stdin'));
    expect(bodies).toHaveLength(1);
    expect(gitInputs[bodies[0]!.index]).toContain(kept);
    expect(gitInputs[bodies[0]!.index]).not.toContain(mixed);
  });

  it('pairs each admitted commit with its own body on the batched read', async () => {
    const directory = await repository([
      { subject: 'first', body: 'the first body', files: { 'a.md': 'a' } },
      { subject: 'hidden', body: 'the hidden body', files: { 'secret.md': 's' } },
      { subject: 'second', body: 'the second body', files: { 'b.md': 'b' } },
    ]);
    const result = await read(gitSource(directory), { task: 'work', exclude: ['secret.md'] });
    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    expect(result.candidates.map((candidate) => [candidate.title, candidate.text])).toEqual([
      ['second', 'the second body'],
      ['first', 'the first body'],
    ]);
  });

  it('drops a commit that renamed an excluded path, and never fetches its body', async () => {
    const directory = await repository([
      { subject: 'kept', body: 'kept body', files: { 'docs/a.md': 'a' } },
      { subject: 'birth', body: 'the secret body', files: { 'docs/secret.md': 's' } },
    ]);
    await git(directory, ['mv', 'docs/secret.md', 'docs/public.md']);
    await commit(directory, 'rename it');
    const renamed = (await git(directory, ['rev-parse', 'HEAD'])).trim();

    const result = await read(
      gitSource(directory),
      { task: 'work', exclude: ['docs/secret.md'] },
    );

    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    // The rename's deletion side touched docs/secret.md, so the commit
    // is not admitted even though its destination is allowed.
    expect(result.candidates.map((candidate) => candidate.title)).toEqual(['kept']);
    const bodies = gitCalls
      .map((args, index) => ({ args, index }))
      .filter(({ args }) => args.includes('--stdin'));
    expect(bodies).toHaveLength(1);
    expect(gitInputs[bodies[0]!.index]).not.toContain(renamed);
  });

  it('treats an exclusion naming the repository root as excluding everything beneath it', async () => {
    const directory = await repository([
      { subject: 'one', body: 'first body', files: { 'a.md': 'a' } },
      { subject: 'two', body: 'second body', files: { 'b.md': 'b' } },
    ]);

    // The root as an absolute path, the directory above it, and the
    // relative '.' all name the same thing: every repository path sits
    // beneath the entry, so no commit is admitted.
    for (const entry of [directory, dirname(directory), '.']) {
      const result = await read(gitSource(directory), { task: 'work', exclude: [entry] });

      expect(result.status).toBe('read');
      if (result.status !== 'read') return;
      expect(result.candidates).toHaveLength(0);
      expect(result.complete).toBe(true);
      // Nothing was admitted, so no body pass ever ran.
      expect(gitCalls.filter((args) => args.includes('--stdin'))).toHaveLength(0);
      gitCalls.length = 0;
      gitInputs.length = 0;
    }
  });

  it('reads only commits dated on or after its own since, measured from the task date', async () => {
    const directory = await repository([
      { subject: 'day before', body: 'the old body', date: '2026-10-20T12:00:00Z', files: { 'a.md': 'a' } },
      { subject: 'on the day', body: 'the new body', date: '2026-10-21T13:00:00Z', files: { 'b.md': 'b' } },
    ]);

    const result = await read(
      gitSource(directory, { since: '7 days' }),
      { task: 'work', taskDate: '2026-10-28T12:00:00Z' },
    );

    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    // 2026-10-28T12:00:00Z less seven days is 2026-10-21T12:00:00Z: the
    // commit a day earlier is never read, the one later that day is.
    expect(result.candidates.map((candidate) => candidate.title)).toEqual(['on the day']);
    // The bound reaches git itself on the metadata pass, so the older
    // commit is never even enumerated.
    const logs = gitCalls.filter((args) => args.includes('log') && !args.includes('--stdin'));
    expect(logs[0]!.some((arg) => arg === `--since=@${Math.ceil(Date.parse('2026-10-21T12:00:00Z') / 1000)}`)).toBe(true);
  });

  it('reads only commits that changed a path its own paths names', async () => {
    const directory = await repository([
      { subject: 'src change', body: 'the src body', files: { 'src/a.ts': 'a' } },
      { subject: 'docs change', body: 'the docs body', files: { 'docs/b.md': 'b' } },
    ]);

    const result = await read(gitSource(directory, { paths: ['src'] }), { task: 'work' });

    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    expect(result.candidates.map((candidate) => candidate.title)).toEqual(['src change']);
  });

  it('keeps its own exclusions to itself: another source on the same repository still reads the path', async () => {
    const directory = await repository([
      { subject: 'kept', body: 'the kept body', files: { 'a.md': 'a' } },
      { subject: 'hidden', body: 'the hidden body', files: { 'secret.md': 's' } },
    ]);
    const hidden = (await git(directory, ['rev-parse', 'HEAD'])).trim();

    const excluding = gitSource(directory, { id: 'git:a', exclude: ['secret.md'] });
    const picked = await pickFromSources(
      [excluding, gitSource(directory, { id: 'git:b' })],
      { task: 'work' },
      {
        task: 'work',
        everyRanked: true,
        everyScored: true,
        rare: false,
        decide: async (batch) => Object.fromEntries(
          batch.questions.map((question) => [question.key, { status: 'answered' as const, probability: 0.9 }])),
      },
    );

    expect(picked.reads[0]!.status).toBe('read');
    if (picked.reads[0]!.status !== 'read') return;
    expect(picked.reads[0]!.candidates.map((candidate) => candidate.title)).toEqual(['kept']);
    expect(picked.reads[1]!.status).toBe('read');
    if (picked.reads[1]!.status !== 'read') return;
    expect(picked.reads[1]!.candidates.map((candidate) => candidate.title).sort()).toEqual(['hidden', 'kept']);
    // The excluding source never fetched the hidden commit's body;
    // the other source did.
    expect(gitInputs.filter((input) => input?.includes(hidden))).toHaveLength(1);
    expect(picked.record.levers.sources['git:a']).toMatchObject({ exclude: ['secret.md'] });
  });

  it('lists the old and new names of a rename in changedPaths', async () => {
    const directory = await repository([
      { subject: 'birth', files: { 'docs/secret.md': 's' } },
    ]);
    await git(directory, ['mv', 'docs/secret.md', 'docs/public.md']);
    await commit(directory, 'rename it');

    const result = await read(gitSource(directory), { task: 'work' });

    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    const rename = result.candidates.find((candidate) => candidate.title === 'rename it')!;
    expect(rename.changedPaths).toEqual(
      expect.arrayContaining(['docs/secret.md', 'docs/public.md']),
    );
  });

  it('applies the limit to admitted commits, so excluded commits cannot consume it', async () => {
    const directory = await repository([
      { subject: 'kept', body: 'kept body', files: { 'a.md': 'a' } },
      { subject: 'secret one', files: { 'secret.md': 'one' } },
      { subject: 'secret two', files: { 'secret.md': 'two' } },
    ]);

    const result = await read(
      gitSource(directory),
      { task: 'work', exclude: ['secret.md'], limit: 1 },
    );

    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    expect(result.candidates.map((candidate) => candidate.title)).toEqual(['kept']);
    expect(result.complete).toBe(true);
  });

  it('honours an absolute exclude written through a symlinked path', async () => {
    const directory = await repository([
      { subject: 'kept', files: { 'a.md': 'a' } },
      { subject: 'secret', body: 'the secret body', files: { 'secret.md': 's' } },
    ]);
    const parent = await mkdtemp(join(tmpdir(), 'curate-link-'));
    temporaryDirectories.push(parent);
    const link = join(parent, 'repo-link');
    await symlink(directory, link);

    const result = await read(
      gitSource(link),
      { task: 'work', exclude: [join(link, 'secret.md')] },
    );

    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    expect(result.candidates.map((candidate) => candidate.title)).toEqual(['kept']);
  });

  it('truncates to the limit and reports the read incomplete', async () => {
    const directory = await repository([
      { subject: 'one', files: { 'a.md': 'a' } },
      { subject: 'two', files: { 'b.md': 'b' } },
    ]);

    const result = await read(gitSource(directory), { task: 'work', limit: 1 });

    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    expect(result.candidates.map((candidate) => candidate.title)).toEqual(['two']);
    expect(result.complete).toBe(false);
    expect(result.partial).toBe('the limit kept 1 commit; more exist');
  });

  it('lists only the changed paths, never paths the message merely mentions', async () => {
    const directory = await repository([
      {
        subject: 'touch a',
        body: 'this change also discusses docs/untouched.md in prose',
        files: { 'docs/a.md': 'a' },
      },
    ]);

    const result = await read(gitSource(directory), { task: 'work' });

    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    expect(result.candidates[0]!.changedPaths).toEqual(['docs/a.md']);
  });

  it('scores task words with BM25 and marks named-path touches', async () => {
    const directory = await repository([
      {
        subject: 'billing work',
        body: 'how billing retries settle',
        files: { 'docs/billing.md': 'b' },
      },
      { subject: 'chore', body: 'assorted notes', files: { 'docs/misc.md': 'o' } },
    ]);

    const result = await read(gitSource(directory), {
      task: 'explain the billing retries',
      paths: ['docs/misc.md'],
    });

    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    const byTitle = new Map(result.candidates.map((candidate) => [candidate.title, candidate]));
    expect(byTitle.get('billing work')!.signals['bm25']!).toBeGreaterThan(0);
    expect(byTitle.get('chore')!.signals['bm25']).toBeUndefined();
    expect(byTitle.get('chore')!.signals['named_path_touch']).toBe(3);
    expect(byTitle.get('billing work')!.signals['named_path_touch']).toBeUndefined();
    expect(result.candidates.every((candidate) => typeof candidate.signals['recency'] === 'number')).toBe(true);
  });

  it('does not mark a named-path touch for paths outside the repository', async () => {
    const directory = await repository([{ subject: 'one', files: { 'a.md': 'a' } }]);

    const result = await read(gitSource(directory), {
      task: 'work',
      paths: ['/etc/passwd', join(directory, '..', 'outside.md')],
    });

    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    expect(result.candidates[0]!.signals['named_path_touch']).toBeUndefined();
  });

  it('runs one log pass and the pin resolution when nothing is opted in', async () => {
    const directory = await repository([{ subject: 'one', files: { 'a.md': 'a' } }]);

    await read(gitSource(directory), { task: 'work' });

    const commands = gitCalls.map((args) => args[6]);
    expect(commands).toEqual(['rev-parse', 'rev-parse', 'log']);
  });

  it('adds the live-lines signal only when blame is opted in', async () => {
    const directory = await repository([
      { subject: 'add the guide', files: { 'docs/a.md': 'first line\nsecond line' } },
      { subject: 'add another file', files: { 'docs/b.md': 'b' } },
    ]);
    const writer = (await git(directory, ['rev-parse', 'HEAD~1'])).trim();

    const plain = await read(gitSource(directory), { task: 'work', paths: ['docs/a.md'] });
    const blamed = await read(gitSource(directory, { blame: true }), { task: 'work', paths: ['docs/a.md'] });

    if (plain.status !== 'read' || blamed.status !== 'read') throw new Error('reads failed');
    expect(plain.candidates.every((candidate) => candidate.signals['live_lines'] === undefined)).toBe(true);
    const byRef = new Map(blamed.candidates.map((candidate) => [candidate.contentRef, candidate]));
    expect(byRef.get(writer)!.signals['live_lines']).toBeGreaterThan(2);
    expect(gitCalls.some((args) => args[6] === 'blame')).toBe(true);
  });

  it('fails the read if a blame process cannot finish', async () => {
    const directory = await repository([{ subject: 'one', files: { 'a.md': 'line' } }]);
    onGitChild = (child, args) => {
      if (args[6] === 'blame') child.kill('SIGKILL');
    };
    await expect(read(gitSource(directory, { blame: true }), { task: 'work', paths: ['a.md'] }))
      .rejects.toMatchObject({ code: 'failed' });
  });

  it('blames every named file, including files beyond the first sixty', async () => {
    const directory = await repository([
      { subject: 'write first sixty', files: Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`docs/a${index}.md`, 'line'])) },
      { subject: 'write last file', files: { 'docs/z.md': 'last line' } },
    ]);
    const result = await read(gitSource(directory, { blame: true }), { task: 'work', paths: ['docs'] });
    if (result.status !== 'read') throw new Error('read failed');
    expect(result.candidates.find((candidate) => candidate.title === 'write last file')!.signals['live_lines']).toBe(2);
    expect(gitCalls.filter((args) => args[6] === 'blame')).toHaveLength(61);
  });

  it('keeps every co-change neighbour after a single shared change', async () => {
    const files = Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`n${index}.md`, 'first']));
    const directory = await repository([
      { subject: 'pair once', files: { 'x.md': 'x', ...files } },
      { subject: 'last neighbour alone', files: { 'n9.md': 'second' } },
    ]);
    const result = await read(gitSource(directory, { coChange: true }), { task: 'work', paths: ['x.md'] });
    if (result.status !== 'read') throw new Error('read failed');
    expect(result.candidates.find((candidate) => candidate.title === 'last neighbour alone')!.signals['co_change']).toBe(1);
  });

  it('uses the full named-path and neighbour histories for co-change', async () => {
    const directory = await repository([
      { subject: 'old shared change', files: { 'x.md': 'x', 'y.md': 'y' } },
    ]);
    const base = (await git(directory, ['rev-parse', 'HEAD'])).trim();
    let input = '';
    for (const [file, count, label] of [['x.md', 201, 'named'], ['y.md', 301, 'neighbour']] as const) {
      for (let index = 0; index < count; index++) {
        const text = `${label} ${index}`;
        input += `commit refs/heads/main\ncommitter Test <test@example.com> 1700000000 +0000\ndata ${Buffer.byteLength(text)}\n${text}\n`;
        if (!input.includes('from ')) input += `from ${base}\n`;
        input += `M 100644 inline ${file}\ndata ${Buffer.byteLength(text)}\n${text}\n\n`;
      }
    }
    execFileSync('git', ['-C', directory, 'fast-import', '--quiet'], { input });
    const result = await read(gitSource(directory, { coChange: true }), { task: 'work', paths: ['x.md'] });
    if (result.status !== 'read') throw new Error('read failed');
    expect(result.candidates.find((candidate) => candidate.title === 'old shared change')!.signals['co_change']).toBe(1);
    expect(result.candidates.find((candidate) => candidate.title === 'neighbour 0')!.signals['co_change']).toBe(1);
  });

  it('never opens an excluded file for blame, even when a paths hint names its folder', async () => {
    const directory = await repository([
      { subject: 'add open', files: { 'docs/a.md': 'line one\nline two' } },
      { subject: 'add private', files: { 'docs/private.md': 'hidden' } },
    ]);

    const result = await read(gitSource(directory, { blame: true }), {
      task: 'work',
      paths: ['docs'],
      exclude: ['docs/private.md'],
    });

    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    const blames = gitCalls.filter((args) => args[6] === 'blame');
    expect(blames.length).toBeGreaterThan(0);
    expect(blames.some((args) => args.includes('docs/a.md'))).toBe(true);
    expect(blames.every((args) => !args.includes('docs/private.md'))).toBe(true);
  });

  it('adds the co-change signal only when coChange is opted in', async () => {
    const directory = await repository([
      { subject: 'pair one', files: { 'x.md': 'x1', 'y.md': 'y1' } },
      { subject: 'pair two', files: { 'x.md': 'x2', 'y.md': 'y2' } },
      { subject: 'pair three', files: { 'x.md': 'x3', 'y.md': 'y3' } },
      { subject: 'solo', files: { 'z.md': 'z' } },
    ]);

    const plain = await read(gitSource(directory), { task: 'work', paths: ['x.md'] });
    const enriched = await read(
      gitSource(directory, { coChange: true }),
      { task: 'work', paths: ['x.md'] },
    );

    if (plain.status !== 'read' || enriched.status !== 'read') throw new Error('reads failed');
    expect(plain.candidates.every((candidate) => candidate.signals['co_change'] === undefined)).toBe(true);
    const byTitle = new Map(enriched.candidates.map((candidate) => [candidate.title, candidate]));
    expect(byTitle.get('pair one')!.signals['co_change']).toBe(1);
    expect(byTitle.get('pair two')!.signals['co_change']).toBe(1);
    expect(byTitle.get('pair three')!.signals['co_change']).toBe(1);
    expect(byTitle.get('solo')!.signals['co_change']).toBeUndefined();
  });

  it('tells a non-repository apart under a non-English locale', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'curate-git-'));
    temporaryDirectories.push(directory);
    const names = ['LANG', 'LC_ALL', 'LANGUAGE'] as const;
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    // git translates its stderr; the absent/throw decision must not
    // depend on the caller's locale.
    process.env.LANG = 'de_DE.UTF-8';
    process.env.LC_ALL = 'de_DE.UTF-8';
    process.env.LANGUAGE = 'de';
    try {
      await expect(read(gitSource(directory), { task: 'work' }))
        .resolves.toEqual({ status: 'absent', reason: 'no-history' });
    } finally {
      for (const name of names) {
        const value = previous.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    expect(gitEnvs.length).toBeGreaterThan(0);
    expect(gitEnvs.every((env) => env?.LC_ALL === 'C')).toBe(true);
  });

  it('turns log.showSignature off on every call, whatever the repository asks', async () => {
    const directory = await repository([{ subject: 'one', files: { 'a.md': 'a' } }]);
    // A repository (or a caller's own git settings) can ask git to print
    // a signature line before each signed commit; those lines are not
    // commit fields and would land in the parsers' output.
    await git(directory, ['config', 'log.showSignature', 'true']);

    const result = await read(gitSource(directory), { task: 'work' });

    expect(result.status).toBe('read');
    expect(gitCalls.length).toBeGreaterThan(0);
    expect(gitCalls.every((args) => args.includes('log.showSignature=false'))).toBe(true);
  });

  it('propagates a cancellation into the running git process', async () => {
    const directory = await repository([{ subject: 'one', files: { 'a.md': 'a' } }]);
    // A stand-in git that cannot finish before the abort lands, so the
    // signal provably reaches a live process. `exec` replaces the shell
    // with the sleeper, so no orphaned child outlives it.
    const bin = await mkdtemp(join(tmpdir(), 'curate-bin-'));
    temporaryDirectories.push(bin);
    await writeFile(join(bin, 'git'), '#!/bin/sh\nexec sleep 10\n');
    await chmod(join(bin, 'git'), 0o755);
    const controller = new AbortController();
    let spawned: ChildProcess | undefined;
    onGitChild = (child) => {
      spawned = child;
      child.once('spawn', () => controller.abort());
    };
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      await expect(read(gitSource(directory), { task: 'work', signal: controller.signal }))
        .rejects.toMatchObject({ name: 'SourceReadError', code: 'cancelled' });
    } finally {
      process.env.PATH = path;
      onGitChild = undefined;
    }
    expect(spawned?.killed).toBe(true);
  });

  it('rejects a cancelled read before git is asked', async () => {
    const directory = await repository([{ subject: 'one', files: { 'a.md': 'a' } }]);
    const controller = new AbortController();
    controller.abort();

    await expect(read(gitSource(directory), { task: 'work', signal: controller.signal }))
      .rejects.toMatchObject({ code: 'cancelled' });
    expect(gitCalls).toHaveLength(0);
  });

  it('keeps repositories with the same relative paths distinct', async () => {
    const first = await repository([{ subject: 'first', files: { 'docs/a.md': 'a' } }]);
    const second = await repository([{ subject: 'second', files: { 'docs/a.md': 'a' } }]);

    const left = await read(gitSource(first), { task: 'work' });
    const right = await read(gitSource(second), { task: 'work' });

    if (left.status !== 'read' || right.status !== 'read') throw new Error('reads failed');
    expect(left.candidates[0]!.changedPaths).toEqual(['docs/a.md']);
    expect(right.candidates[0]!.changedPaths).toEqual(['docs/a.md']);
    expect(left.candidates[0]!.repository).not.toBe(right.candidates[0]!.repository);
    expect(left.candidates[0]!.contentRef).not.toBe(right.candidates[0]!.contentRef);
  });

  it('uses a caller-supplied source id and repository key', async () => {
    const directory = await repository([{ subject: 'one', files: { 'a.md': 'a' } }]);

    const result = await read(
      gitSource(directory, { id: 'history', repository: 'shared-key' }),
      { task: 'work' },
    );

    if (result.status !== 'read') throw new Error('read failed');
    expect(result.candidates[0]!.sourceId).toBe('history');
    expect(result.candidates[0]!.repository).toBe('shared-key');
  });

  it('keeps the heap roughly flat reading a generated history of 75,000 commits', { timeout: 180_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'curate-git-'));
    temporaryDirectories.push(directory);
    await git(directory, ['init', '-b', 'main']);
    // 75,000 commits of about 8 KB each: holding every body at once is
    // over half a gigabyte, so a read that buffers the corpus trips the
    // 1 GB bar while a read that scores each batch and releases it stays
    // far under it. fast-import builds the history in seconds.
    const body = 'padding the commit body with enough routine text to weigh it down '.repeat(120);
    const input = join(directory, 'import.txt');
    for (let block = 0; block < 75; block++) {
      let chunk = '';
      for (let index = block * 1000; index < block * 1000 + 1000; index++) {
        const matching = index % 100 === 0;
        const subject = matching ? `battery backup evidence ${index}` : `routine note ${index}`;
        const message = `${subject}\n\n${matching ? 'battery backup evidence ' : ''}${body} ${index}`;
        chunk += `commit refs/heads/main\ncommitter Test <test@example.com> ${1700000000 + index} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n`;
      }
      await appendFile(input, chunk);
    }
    const fd = openSync(input, 'r');
    try {
      execFileSync('git', ['-C', directory, 'fast-import', '--quiet'], { stdio: [fd, 'ignore', 'inherit'] });
    } finally {
      closeSync(fd);
    }
    await rm(input);

    const embed = async (texts: readonly string[]) =>
      texts.map((text) => (text.includes('battery backup') ? [1, 0] : [0, 1]));
    const source = gitSource(directory);
    const samples: number[] = [];
    const timer = setInterval(() => samples.push(process.memoryUsage().heapUsed), 5);
    let result: Awaited<ReturnType<ReturnType<typeof gitSource>['read']>>;
    let kindResult: typeof result;
    let meaningResult: typeof result;
    try {
      result = await read(source, { task: 'battery backup evidence', wholeLanes: false });
      // A kind lane matches every body's 'padding the commit' and must
      // rank the matches by the topic, never buffer all 75,000 bodies;
      // the meaning lane likewise scores and releases each page.
      kindResult = await read(source, {
        task: 'padding the commit', phraseLane: true, topic: 'battery backup evidence', wholeLanes: false,
      });
      meaningResult = await read(source, {
        task: 'battery backup evidence', wholeLanes: false, meaningLane: { embed },
      });
    } finally {
      clearInterval(timer);
    }
    samples.push(process.memoryUsage().heapUsed);

    for (const lane of [result, kindResult, meaningResult]) {
      expect(lane.status).toBe('read');
      if (lane.status !== 'read') return;
      // Every commit was scored (matched counts the scored set), and the
      // curve kept the 750 commits carrying the task's terms.
      expect(lane.matched).toBe(75_000);
      expect(lane.laneCutApplied).toBe(true);
    }
    if (result.status !== 'read' || kindResult.status !== 'read'
      || meaningResult.status !== 'read') return;
    expect(result.candidates).toHaveLength(750);
    expect(result.candidates.every((candidate) => (candidate.signals['bm25'] ?? 0) > 0)).toBe(true);
    expect(kindResult.candidates).toHaveLength(750);
    expect(kindResult.candidates.every((candidate) =>
      (candidate.signals['phrase'] ?? 0) > 0 && (candidate.signals['bm25'] ?? 0) > 0)).toBe(true);
    expect(meaningResult.meaningLane).toBe(true);
    expect(meaningResult.candidates).toHaveLength(750);
    expect(meaningResult.candidates.every((candidate) => candidate.signals['similarity'] === 1)).toBe(true);
    const peak = Math.max(...samples);
    expect(peak).toBeLessThan(1024 * 1024 * 1024);
  });
});

it('marks the commits the cut would drop when a read keeps whole lanes', async () => {
  const directory = await repository(['battery backup decided', 'unrelated breakfast', 'battery cells degrade', 'a fourth note']
    .map((subject, index) => ({ subject: `we said ${subject}`, date: '2026-10-01T10:00:00Z', files: { [`f${index}.md`]: subject } })));
  const embed = async (texts: readonly string[]) => texts.map((text) => (text.includes('battery') ? [1, 0] : [0, 1]));
  const source = gitSource(directory);
  const lanes = [
    { task: 'battery' },
    { task: 'we said', phraseLane: true, topic: 'battery' },
    { task: 'battery', meaningLane: { embed } },
  ];
  for (const lane of lanes) {
    const [bare, cut, whole] = await Promise.all([undefined, false, true].map((wholeLanes) =>
      source.read({ ...lane, ...(wholeLanes === undefined ? {} : { wholeLanes }) })));
    if (bare?.status !== 'read' || cut?.status !== 'read' || whole?.status !== 'read') throw new Error('Expected a read');
    // The same parts as a plain read, with the parts a cut read leaves out marked.
    expect(whole.candidates.map((candidate) => candidate.id)).toEqual(bare.candidates.map((candidate) => candidate.id));
    expect(bare.candidates.filter((candidate) => candidate.pastLaneCut !== undefined)).toEqual([]);
    const kept = new Set(cut.candidates.map((candidate) => candidate.id));
    expect(kept.size).toBeGreaterThan(0);
    expect(kept.size).toBeLessThan(whole.candidates.length);
    expect(whole.candidates.filter((candidate) => candidate.pastLaneCut === true).map((candidate) => candidate.id))
      .toEqual(whole.candidates.filter((candidate) => !kept.has(candidate.id)).map((candidate) => candidate.id));
  }
});

it('allows a host to override commit keyword weights', async () => {
  const directory = await repository([{ subject: 'backup evidence', files: { 'backup.md': 'backup' } }]);
  // With k1 at 0 each word scores its idf alone: ln(1 + 0.5 / 1.5) for a
  // word held by the only commit.
  const result = await read(gitSource(directory, { keyword: { k1: 0 } }), { task: 'backup evidence' });
  expect(result.status).toBe('read');
  if (result.status !== 'read') throw new Error('Expected commit candidates');
  expect(result.candidates[0]!.signals.bm25).toBeCloseTo(2 * Math.log(1 + 0.5 / 1.5), 12);
});

describe('the BM25 keyword score', () => {
  const asOf = '2026-10-25T16:00:00Z';
  const sum = (signals: Record<string, number>) => Object.values(signals).reduce((total, value) => total + value, 0);
  // Commits sharing no task word, so each task word's idf has a real
  // commit count to weigh against.
  const fillers = (count: number, date = '2026-09-01T10:00:00Z') => Array.from({ length: count }, (_, index) => ({
    subject: `routine note ${index}`, body: 'assorted chores', date, files: { [`filler/${index}.md`]: String(index) },
  }));
  const byFile = async (source: CandidateSource, request: Parameters<typeof read>[1]) => {
    const result = await read(source, { asOf, ...request });
    if (result.status !== 'read') throw new Error('Expected commit candidates');
    return { result, of: (file: string) => result.candidates.find((candidate) => candidate.changedPaths?.includes(file))! };
  };

  it('ranks a commit sharing more task words above one sharing three', async () => {
    // The commit with three words is a day newer, so a score that stops
    // counting at three words would rank it first on recency.
    const directory = await repository([
      ...fillers(10),
      { subject: 'billing ledger refund', body: 'invoice', date: '2026-10-01T10:00:00Z', files: { 'four.md': '4' } },
      { subject: 'billing ledger refund', body: 'notes', date: '2026-10-02T10:00:00Z', files: { 'three.md': '3' } },
    ]);
    const { of } = await byFile(gitSource(directory), { task: 'billing ledger refund invoice' });
    expect(sum(of('four.md').signals)).toBeGreaterThan(sum(of('three.md').signals));
  });

  it('ranks a rare task word above a common one', async () => {
    // Battery sits in eight commits and zephyr in one; the battery commit
    // is a day newer and the same length.
    const directory = await repository([
      ...Array.from({ length: 7 }, (_, index) => ({
        subject: `battery note ${index}`, date: '2026-09-01T10:00:00Z', files: { [`b/${index}.md`]: String(index) },
      })),
      { subject: 'zephyr check done', date: '2026-10-01T10:00:00Z', files: { 'rare.md': 'r' } },
      { subject: 'battery check done', date: '2026-10-02T10:00:00Z', files: { 'common.md': 'c' } },
    ]);
    const { of } = await byFile(gitSource(directory), { task: 'zephyr battery' });
    expect(of('rare.md').signals['bm25']!).toBeGreaterThan(of('common.md').signals['bm25']!);
    expect(sum(of('rare.md').signals)).toBeGreaterThan(sum(of('common.md').signals));
  });

  it('adds for repeated mentions, but less each time', async () => {
    // Three commits of three words each, so only the mentions differ.
    const directory = await repository([
      ...fillers(4),
      { subject: 'zephyr alpha gamma', date: '2026-10-01T10:00:00Z', files: { 'one.md': '1' } },
      { subject: 'zephyr zephyr gamma', date: '2026-10-01T10:00:00Z', files: { 'two.md': '2' } },
      { subject: 'zephyr zephyr zephyr', date: '2026-10-01T10:00:00Z', files: { 'three.md': '3' } },
    ]);
    const { of } = await byFile(gitSource(directory), { task: 'zephyr' });
    const [one, two, three] = ['one.md', 'two.md', 'three.md'].map((file) => of(file).signals['bm25']!);
    expect(two!).toBeGreaterThan(one!);
    expect(three!).toBeGreaterThan(two!);
    expect(three! - two!).toBeLessThan(two! - one!);
  });

  it('counts the same mention in a long body for less than in a short one', async () => {
    const directory = await repository([
      ...fillers(4),
      { subject: 'zephyr check', date: '2026-10-01T10:00:00Z', files: { 'short.md': 's' } },
      {
        subject: 'zephyr check',
        body: 'a long body of routine words that pads the commit well past the average length '.repeat(4),
        date: '2026-10-01T10:00:00Z',
        files: { 'long.md': 'l' },
      },
    ]);
    const { of } = await byFile(gitSource(directory), { task: 'zephyr' });
    expect(of('short.md').signals['bm25']!).toBeGreaterThan(of('long.md').signals['bm25']!);
  });

  it('ranks a word common inside the commits a read keeps as common', async () => {
    // The whole history holds zephyr in seven commits and battery in four.
    // The recent commits hold battery in four and zephyr in one.
    const directory = await repository([
      ...Array.from({ length: 6 }, (_, index) => ({
        subject: `zephyr archive ${index}`, date: '2025-03-01T10:00:00Z', files: { [`old/${index}.md`]: String(index) },
      })),
      { subject: 'battery fix one', date: '2026-10-01T10:00:00Z', files: { 'recent/battery.md': 'b' } },
      { subject: 'zephyr fix two', date: '2026-10-01T10:00:00Z', files: { 'recent/zephyr.md': 'z' } },
      ...['three', 'four', 'five'].map((word) => ({
        subject: `battery tune ${word}`, date: '2026-10-01T10:00:00Z', files: { [`recent/${word}.md`]: word },
      })),
    ]);
    const task = 'battery zephyr';
    const whole = await byFile(gitSource(directory), { task });
    expect(whole.of('recent/battery.md').signals['bm25']!)
      .toBeGreaterThan(whole.of('recent/zephyr.md').signals['bm25']!);
    for (const options of [{ since: '2026-06-01' }, { paths: ['recent'] }, { exclude: ['old'] }]) {
      const { result, of } = await byFile(gitSource(directory, options), { task });
      expect(result.candidates).toHaveLength(5);
      expect(of('recent/zephyr.md').signals['bm25']!).toBeGreaterThan(of('recent/battery.md').signals['bm25']!);
    }
    // An exclusion lists the whole history before the limit cuts it, so
    // only the limit keeps the old commits out of the counts.
    const limited = await byFile(gitSource(directory, { exclude: ['elsewhere'] }), { task, limit: 5 });
    expect(limited.result.candidates).toHaveLength(5);
    expect(limited.of('recent/zephyr.md').signals['bm25']!)
      .toBeGreaterThan(limited.of('recent/battery.md').signals['bm25']!);
  });

  it('ranks a kind search by BM25 counted over its phrase matches', async () => {
    // Battery is common among the matches and zephyr rare, though zephyr
    // is common in the whole history. The battery match is a day newer.
    const directory = await repository([
      ...Array.from({ length: 6 }, (_, index) => ({
        subject: `zephyr archive ${index}`, date: '2026-09-01T10:00:00Z', files: { [`old/${index}.md`]: String(index) },
      })),
      ...['cells', 'packs', 'tests'].map((word) => ({
        subject: `we chose battery ${word}`, date: '2026-09-15T10:00:00Z', files: { [`${word}.md`]: word },
      })),
      { subject: 'we chose zephyr today', date: '2026-10-01T10:00:00Z', files: { 'zephyr.md': 'z' } },
      { subject: 'we chose battery today', date: '2026-10-02T10:00:00Z', files: { 'battery.md': 'b' } },
    ]);
    const { result, of } = await byFile(gitSource(directory), { task: 'we chose', phraseLane: true, topic: 'battery zephyr' });
    expect(result.candidates).toHaveLength(5);
    expect(of('zephyr.md').signals['bm25']!).toBeGreaterThan(of('battery.md').signals['bm25']!);
    expect(result.candidates[0]!.changedPaths).toEqual(['zephyr.md']);
  });
});
