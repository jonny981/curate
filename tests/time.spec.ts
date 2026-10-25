import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chat, chatSettings } from '@curatejs/chat';
import { git } from '@curatejs/git';
import { knowledgeBase, markdown } from '@curatejs/markdown';
import {
  curate, historySource, pick, pickFromSources, type CandidateReadResult, type MemoryCandidate, type PickDecide,
  type PickQuestion,
} from '@curatejs/core';

const directories: string[] = [];
async function folder(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'curate-time-'));
  directories.push(directory);
  return directory;
}
beforeEach(async () => { vi.stubEnv('XDG_CACHE_HOME', await folder()); });
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
/** Run git in the fixture with the person's hooks, signing and identity kept out. */
function run(directory: string, args: readonly string[], date?: string): void {
  execFileSync('git', ['-C', directory, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    env: { ...env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
      ...(date === undefined ? {} : { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }) },
    stdio: 'pipe',
  });
}
async function repository(commits: readonly { subject: string; date: string }[]): Promise<string> {
  const directory = await folder();
  run(directory, ['init', '-b', 'main']);
  for (const [index, { subject, date }] of commits.entries()) {
    await writeFile(join(directory, `file-${index}.txt`), subject);
    run(directory, ['add', '-A']);
    run(directory, ['commit', '-m', subject], date);
  }
  return directory;
}

async function transcripts(messages: readonly { text: string; at: string }[]): Promise<string> {
  const root = await folder();
  await mkdir(join(root, 'project'), { recursive: true });
  await writeFile(join(root, 'project', 'session.jsonl'), messages.map(({ text, at }) => JSON.stringify({
    type: 'user', timestamp: at, sessionId: 'session', message: { content: [{ type: 'text', text }] },
  })).join('\n') + '\n');
  return root;
}

function candidates(result: CandidateReadResult): readonly MemoryCandidate[] {
  if (result.status !== 'read') throw new Error(`Expected a read, got ${result.reason}`);
  return result.candidates;
}
const fakeClock = (at: string) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(at)); };

describe('git recency follows the task date, not the clock', () => {
  const recency = async (now: string) => {
    const repo = await repository([
      { subject: 'january change', date: '2025-01-01T12:00:00Z' },
      { subject: 'june change', date: '2025-06-01T12:00:00Z' },
    ]);
    fakeClock(now);
    const read = await git(repo).read({ task: 'change', taskDate: '2025-06-02', timeZone: 'UTC' });
    return Object.fromEntries(candidates(read).map((c) => [c.title, c.signals.recency]));
  };

  it('gives the same recency at two system times a year apart', async () => {
    expect(await recency('2027-01-01T00:00:00Z')).toEqual(await recency('2026-01-01T00:00:00Z'));
  });

  it("gives the June commit the recency for its age at the end of the task date", async () => {
    const age = (Date.parse('2025-06-02T23:59:59.999Z') - Date.parse('2025-06-01T12:00:00Z')) / 86_400_000;
    expect((await recency('2026-01-01T00:00:00Z'))['june change']).toBeCloseTo(Math.exp(-age / 60), 12);
  });
});

describe("chat's since window counts back from the task date", () => {
  it('keeps the message inside seven days of the task date', async () => {
    const root = await transcripts([
      { text: 'the earlier message', at: '2025-05-20T12:00:00Z' },
      { text: 'the later message', at: '2025-06-01T12:00:00Z' },
    ]);
    fakeClock('2026-03-01T00:00:00Z');
    const read = await chat({ paths: [root], providers: ['claude-code'], since: '7 days' })
      .read({ task: 'message', taskDate: '2025-06-02', timeZone: 'UTC' });
    expect(candidates(read).map((c) => c.text)).toEqual(['the later message']);
  });
});

describe('nothing from after the task date', () => {
  const messages = [
    { text: 'the message before', at: '2025-06-01T12:00:00Z' },
    { text: 'the message after', at: '2025-06-03T12:00:00Z' },
  ];
  const commits = [
    { subject: 'the commit before', date: '2025-06-01T12:00:00Z' },
    { subject: 'the commit after', date: '2025-06-03T12:00:00Z' },
  ];

  it('does not read a chat message dated after the task date', async () => {
    const root = await transcripts(messages);
    const read = await chat({ paths: [root], providers: ['claude-code'] })
      .read({ task: 'message', taskDate: '2025-06-02', timeZone: 'UTC' });
    expect(candidates(read).map((c) => c.text)).toEqual(['the message before']);
  });

  it('does not read a git commit dated after the task date', async () => {
    const repo = await repository(commits);
    const read = await git(repo).read({ task: 'commit', taskDate: '2025-06-02', timeZone: 'UTC' });
    expect(candidates(read).map((c) => c.title)).toEqual(['the commit before']);
  });

  it('reads both without a task date', async () => {
    const root = await transcripts(messages);
    const chatRead = await chat({ paths: [root], providers: ['claude-code'] }).read({ task: 'message' });
    expect(candidates(chatRead).map((c) => c.text).sort()).toEqual(['the message after', 'the message before']);
    const repo = await repository(commits);
    const gitRead = await git(repo).read({ task: 'commit' });
    expect(candidates(gitRead).map((c) => c.title).sort()).toEqual(['the commit after', 'the commit before']);
  });
});

describe("without a task date, readers measure from the pick's moment", () => {
  const asOf = '2025-06-02T23:59:59.999+00:00';

  it('gives git recency from that moment and still reads a later commit', async () => {
    const repo = await repository([
      { subject: 'june change', date: '2025-06-01T12:00:00Z' },
      { subject: 'later change', date: '2025-06-03T12:00:00Z' },
    ]);
    fakeClock('2027-01-01T00:00:00Z');
    const read = await git(repo).read({ task: 'change', asOf, timeZone: 'UTC' });
    const recency = Object.fromEntries(candidates(read).map((c) => [c.title, c.signals.recency]));
    expect(Object.keys(recency).sort()).toEqual(['june change', 'later change']);
    const age = (Date.parse(asOf) - Date.parse('2025-06-01T12:00:00Z')) / 86_400_000;
    expect(recency['june change']).toBeCloseTo(Math.exp(-age / 60), 12);
  });

  it("counts chat's since back from that moment and still reads a later message", async () => {
    const root = await transcripts([
      { text: 'the earlier message', at: '2025-05-20T12:00:00Z' },
      { text: 'the later message', at: '2025-06-01T12:00:00Z' },
      { text: 'the message after', at: '2025-06-03T12:00:00Z' },
    ]);
    fakeClock('2026-03-01T00:00:00Z');
    const read = await chat({ paths: [root], providers: ['claude-code'], since: '7 days' })
      .read({ task: 'message', asOf, timeZone: 'UTC' });
    expect(candidates(read).map((c) => c.text).sort()).toEqual(['the later message', 'the message after']);
  });
});

describe("chat dates in the user's zone", () => {
  const late = [{ text: 'the late message', at: '2025-06-01T23:30:00Z' }];

  it.each([
    ['Europe/London', '2025-06-02T00:30:00.000+01:00'],
    ['UTC', '2025-06-01T23:30:00.000+00:00'],
  ])('writes the date in %s', async (timeZone, value) => {
    const root = await transcripts(late);
    const read = await chat({ paths: [root], providers: ['claude-code'] }).read({ task: 'message', timeZone });
    expect(candidates(read).map((c) => c.date)).toEqual([{ value, meaning: 'recorded' }]);
  });

  it("shows the London date in the curator's evidence header", async () => {
    const root = await transcripts(late);
    const read = await chat({ paths: [root], providers: ['claude-code'] })
      .read({ task: 'message', timeZone: 'Europe/London' });
    const decide: PickDecide = async ({ questions }) =>
      Object.fromEntries(questions.map((q) => [q.key, { status: 'answered', probability: 0.9 }]));
    const picked = await pick(candidates(read), { task: 'What was the late message?', decide, everyScored: true });
    const bodies: string[] = [];
    await curate('What was the late message?', picked, { write: async ({ body }) => { bodies.push(body); return ''; } });
    expect(bodies.join('\n')).toContain('### E1 (2025-06-02T00:30:00.000+01:00, ');
  });
});

describe('every Markdown file gets a date', () => {
  const MODIFIED = new Date('2025-05-05T10:00:00Z');
  const COMMITTED = '2025-01-10T12:00:00+00:00';
  async function notes(): Promise<string> {
    const directory = await folder();
    run(directory, ['init', '-b', 'main']);
    await writeFile(join(directory, 'clean.md'), '# Clean\nA clean note.\n');
    await writeFile(join(directory, 'edited.md'), '# Edited\nAn edited note.\n');
    await writeFile(join(directory, 'declared.md'), '---\ndate: 2024-01-05\n---\n# Declared\nA declared note.\n');
    run(directory, ['add', '-A']);
    run(directory, ['commit', '-m', 'add the notes'], COMMITTED);
    await writeFile(join(directory, 'edited.md'), '# Edited\nAn edited note, changed since.\n');
    await writeFile(join(directory, 'new.md'), '# New\nA new note.\n');
    for (const name of ['clean.md', 'edited.md', 'declared.md', 'new.md']) {
      await utimes(join(directory, name), MODIFIED, MODIFIED);
    }
    return directory;
  }
  const dates = (read: CandidateReadResult) =>
    Object.fromEntries(candidates(read).map((c) => [c.title.slice(0, c.title.indexOf(':')), c.date]));
  const modified = { value: MODIFIED.toISOString(), meaning: 'modified' };
  const changed = { value: COMMITTED, meaning: 'changed' };

  it.each(['new.md', 'edited.md'])('dates %s by its modified time', async (name) => {
    const directory = await notes();
    const read = dates(await markdown({ paths: [directory], kind: 'docs' }).read({ task: 'note' }));
    expect(read[name]).toEqual(modified);
  });

  it('keeps the commit date of a clean note, and markdown() keeps it over a declared date', async () => {
    const directory = await notes();
    const read = dates(await markdown({ paths: [directory], kind: 'docs' }).read({ task: 'note' }));
    expect(read['clean.md']).toEqual(changed);
    expect(read['declared.md']).toEqual(changed);
  });

  it('keeps a declared date through knowledgeBase(), inside and outside the repository', async () => {
    const directory = await notes();
    const inside = dates(await knowledgeBase(directory).read({ task: 'note' }));
    expect(inside['declared.md']).toEqual({ value: '2024-01-05', meaning: 'recorded' });
    const outside = await folder();
    await writeFile(join(outside, 'declared.md'), '---\ndate: 2024-01-05\n---\n# Declared\nA declared note.\n');
    expect(dates(await knowledgeBase(outside).read({ task: 'note' }))['declared.md'])
      .toEqual({ value: '2024-01-05', meaning: 'recorded' });
  });

  it('dates an undeclared note outside a repository by its modified time through knowledgeBase()', async () => {
    const outside = await folder();
    await writeFile(join(outside, 'plain.md'), '# Plain\nA plain note.\n');
    await utimes(join(outside, 'plain.md'), MODIFIED, MODIFIED);
    expect(dates(await knowledgeBase(outside).read({ task: 'note' }))['plain.md']).toEqual(modified);
  });

  it('never uses a modified time in a read pinned to HEAD', async () => {
    const directory = await notes();
    const read = dates(await markdown({ paths: [directory], kind: 'docs' }).read({ task: 'note', revision: 'HEAD' }));
    expect(read['new.md']).toBeUndefined();
    expect(read['edited.md']).toEqual(changed);
  });
});

describe("the task's period lets missed parts in", () => {
  const task = 'What did I decide in March?';
  async function source() {
    const root = await transcripts([
      { text: 'Pricing stays flat for every plan.', at: '2025-03-15T10:00:00Z' },
      { text: 'Support tickets go to the shared queue.', at: '2025-04-02T10:00:00Z' },
      { text: 'Which roadmap did I decide on?', at: '2025-05-10T10:00:00Z' },
    ]);
    return historySource({ reader: chat({ paths: [root], providers: ['claude-code'] }), ...chatSettings, labels: false });
  }
  function recording() {
    const asked: PickQuestion[] = [];
    const decide: PickDecide = async ({ questions }) => {
      asked.push(...questions);
      return Object.fromEntries(questions.map((q) => [q.key, { status: 'answered', probability: 0.9 }]));
    };
    return { asked, decide };
  }
  const textOf = (read: CandidateReadResult, id: string) => candidates(read).find((c) => c.id === id)?.text;

  async function picked() {
    const { asked, decide } = recording();
    const result = await pickFromSources([await source()], { task, taskDate: '2025-06-02', timeZone: 'Europe/London' },
      { task, decide });
    return { asked: new Set(asked.map((q) => q.text)), result };
  }

  it('brings the March part to the decide step', async () => {
    const { asked, result } = await picked();
    expect(asked.has('Pricing stays flat for every plan.')).toBe(true);
    const march = result.record.candidates.find((entry) => textOf(result.reads[0]!, entry.id) === 'Pricing stays flat for every plan.');
    expect(march).toMatchObject({ dateWindow: 'task-period', status: 'selected' });
    expect(result.record.taskPeriod).toEqual({ from: '2025-03-01T00:00:00.000+00:00', to: '2025-03-31T23:59:59.999+01:00' });
  });

  it('leaves the April part out', async () => {
    const { asked } = await picked();
    expect(asked.has('Support tickets go to the shared queue.')).toBe(false);
  });

  it('counts the March part in the taskPeriod effects entry', async () => {
    const { result } = await picked();
    const effect = result.record.effects.find((entry) => entry.setting === 'taskPeriod');
    expect(effect).toMatchObject({ source: result.record.candidates[0]!.sourceId, actedOn: 1, added: 1, dropped: 0 });
  });

  it('leaves the March part out with taskPeriod off', async () => {
    const { asked, decide } = recording();
    const picked = await pickFromSources([await source()], { task, taskDate: '2025-06-02', timeZone: 'Europe/London' },
      { task, decide, taskPeriod: false });
    expect(asked.map((q) => q.text)).not.toContain('Pricing stays flat for every plan.');
    expect(picked.record.taskPeriod).toBeUndefined();
    expect(picked.record.effects.some((entry) => entry.setting === 'taskPeriod')).toBe(false);
  });
});
