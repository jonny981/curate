import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runGit } from '../src/git.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('runGit', () => {
  it('returns git output larger than Node\'s 1 MiB default in full', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'curate-git-'));
    temporaryDirectories.push(repo);
    execFileSync('git', ['-C', repo, 'init', '-b', 'main']);
    // About 2 MiB, past execFile's default maxBuffer of 1 MiB. The message
    // goes in a file because an argument this long exceeds the operating
    // system's command-line limit. The two settings keep the person's hooks
    // and commit signing out of the commit.
    const message = `a large commit\n\n${`${'word '.repeat(15)}words\n`.repeat(26_000)}`.trimEnd();
    expect(message.length).toBeGreaterThan(2 * 1024 * 1024);
    const messageFile = join(repo, 'message.txt');
    await writeFile(messageFile, message);
    execFileSync(
      'git',
      ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-F', messageFile],
      {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      },
    );

    const output = await runGit(repo, ['log', '-1', '--format=%B']);

    expect(output.trimEnd()).toBe(message);
  });
});
