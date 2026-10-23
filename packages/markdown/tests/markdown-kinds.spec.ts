import { execFileSync } from 'node:child_process';
import { readFile as actualReadFile, mkdir, mkdtemp, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { curate, pick, pickFromSources, type CandidateReadRequest, type MemoryCandidate, type PickDecide } from '@curatejs/core';
import { markdown, rules } from '../src/index.js';

const uncutPick = { everyRanked: true, everyScored: true, rare: false } as const;

const { fileReads } = vi.hoisted(() => ({ fileReads: [] as string[] }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, readFile: (...args: Parameters<typeof actualReadFile>) => {
    fileReads.push(String(args[0]));
    return actual.readFile(...args);
  } };
});
const directories: string[] = [];
async function tree(files: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), 'curate-markdown-kinds-'));
  directories.push(directory);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), text);
  }
  return realpath(directory);
}
const git = (directory: string, ...args: string[]) => execFileSync('git', ['-C', directory, '-c', 'core.hooksPath=/dev/null', ...args], {
  env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_AUTHOR_DATE: '2025-02-03T12:00:00Z', GIT_COMMITTER_DATE: '2025-02-03T12:00:00Z' },
  encoding: 'utf8', stdio: 'pipe',
});
const yes: PickDecide = async ({ questions }) => Object.fromEntries(questions.map((q) => [q.key, { status: 'answered', probability: 0.01 }]));
const read = async (paths: string[], kind: 'knowledge' | 'docs' | 'rules' | 'instructions', extra: Partial<CandidateReadRequest> = {}) => {
  const result = await markdown({ paths, kind }).read({ task: 'work on battery', ...extra });
  expect(result.status).toBe('read');
  if (result.status !== 'read') throw new Error('Expected Markdown candidates');
  return result;
};
afterEach(async () => {
  fileReads.length = 0;
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('Markdown paths and shared reads', () => {
  it('matches globs and hidden rules while skipping git ignores and dependency folders before opening content', async () => {
    const directory = await tree({ 'AGENTS.md': 'Root rule.', 'src/AGENTS.md': 'Source rule.', '.agents/guide.md': 'Hidden rule.',
      'ignored/AGENTS.md': 'Ignored.', 'node_modules/a/AGENTS.md': 'Dependency.', '.gitignore': 'ignored/\n' });
    git(directory, 'init', '-b', 'main');
    const result = await read([join(directory, '**/AGENTS.md'), join(directory, '.agents/*.md')], 'instructions');
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.every((c) => c.kind === 'instructions' && c.role === 'rule')).toBe(true);
    expect(fileReads.some((file) => file.includes('/ignored/') || file.includes('/node_modules/'))).toBe(false);
  });

  it('reads overlapping sources and repeated search lines once while keeping both kinds', async () => {
    const directory = await tree({ 'guide.md': 'Battery facts.' });
    const result = await pickFromSources([
      markdown({ paths: [directory, join(directory, '*.md')], kind: 'knowledge' }),
      markdown({ paths: [join(directory, 'guide.md')], kind: 'docs' }),
    ], { task: 'battery', searchLines: ['facts'] }, { ...uncutPick, task: 'battery', decide: yes });
    expect(fileReads.filter((file) => file === join(directory, 'guide.md'))).toHaveLength(1);
    expect(result.selected.map((c) => c.kind).sort()).toEqual(['docs', 'knowledge']);
    const next = await pickFromSources([markdown({ paths: [directory], kind: 'docs' })], { task: 'battery' }, { ...uncutPick, task: 'battery', decide: yes });
    expect(next.selected).toHaveLength(1);
    expect(fileReads.filter((file) => file === join(directory, 'guide.md'))).toHaveLength(2);
  });

  it('shares complete file text across phrase, meaning, and overlapping Markdown sources', async () => {
    const text = 'Battery facts. '.repeat(100);
    const directory = await tree({ 'guide.md': text });
    const result = await pickFromSources([
      markdown({ paths: [directory], kind: 'knowledge' }),
      markdown({ paths: [directory], kind: 'docs' }),
    ], { task: 'battery', searchPhrases: ['battery'], limit: 1,
      meaning: { nearest: 1, embed: async (texts) => texts.map(() => [1, 0]) },
    }, { ...uncutPick, task: 'battery', decide: async (batch, signal) => {
      expect(batch.questions.every((question) => question.text === text)).toBe(true);
      return yes(batch, signal);
    } });
    expect(fileReads.filter((file) => file === join(directory, 'guide.md'))).toHaveLength(1);
    expect(result.selected.map((candidate) => candidate.kind).sort()).toEqual(['docs', 'knowledge']);
    expect(result.selected.every((candidate) => candidate.text === text)).toBe(true);
  });

  it('keeps same-named files from separate roots distinct', async () => {
    const left = await tree({ 'note.md': 'Left.' });
    const right = await tree({ 'note.md': 'Right.' });
    const result = await pickFromSources([markdown({ paths: [left, right], kind: 'knowledge' })], { task: 'notes', searchLines: ['facts'], wholeLanes: true }, { ...uncutPick, task: 'notes', decide: yes });
    expect(result.selected).toHaveLength(2);
    expect(new Set(result.selected.map((c) => c.id)).size).toBe(2);
  });

  it('preserves whole long text by default and every character when a caller requests parts', async () => {
    const text = `## Battery\n${'Battery facts.\n'.repeat(150)}`;
    const directory = await tree({ 'guide.md': text });
    const source = markdown({ paths: [directory], kind: 'docs' });
    const whole = await pickFromSources([source], { task: 'battery' }, { ...uncutPick, task: 'battery', decide: async ({ questions }) => {
      expect(questions).toHaveLength(1);
      expect(questions[0]!.text).toBe(text);
      return yes({ task: 'battery', questions }, new AbortController().signal);
    } });
    expect(whole.selected).toHaveLength(1);
    const parts = await read([directory], 'docs', { maxQuestionText: 100 });
    expect([...parts.candidates].sort((a, b) => Number(a.id.split('.').at(-1)) - Number(b.id.split('.').at(-1))).map((c) => c.text).join('')).toBe(text);
    expect(parts.candidates.every((c) => c.text.length <= 100)).toBe(true);
  });
});

describe('Markdown rules and instructions', () => {
  it('keeps the existing rules reader full file text, ids, and exact signal set beyond 700 characters', async () => {
    const text = `# Battery\nSuperseded\nguide.ts\n${'one '.repeat(400)}`;
    const directory = await tree({ 'battery.md': text, 'README.md': 'Excluded.' });
    const result = await pickFromSources([rules(directory)], { task: 'battery', paths: ['guide.ts'] }, { ...uncutPick,
      task: 'battery', decide: async ({ questions }, signal) => {
        expect(questions).toHaveLength(1);
        expect(questions[0]).toMatchObject({ id: 'battery.md', title: 'battery.md', text });
        return yes({ task: 'battery', questions }, signal);
      },
    });
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]).toMatchObject({ sourceId: `rules:${directory}`, id: 'battery.md', title: 'battery.md', text, contentRef: 'battery.md' });
    expect(result.selected[0]!.signals).toEqual({ 'names-path': 3, bm25: 2 * Math.log(1 + 0.5 / 1.5) });
    expect(result.selected[0]).not.toHaveProperty('kind');
    expect(result.reads[0]).toMatchObject({ complete: true });
  });

  it('splits headings and top-level bullets into stable rules with parent text and intact nested lists and code', async () => {
    const text = '# Safety\nKeep the battery safe.\n## Charging\n- Limit current.\n  - Keep the fuse.\n- Stop on heat.\n```md\n# Not a heading\n- Not a rule\n```\n';
    const directory = await tree({ '.cursorrules': text });
    const result = await read([directory], 'rules');
    expect(result.candidates).toHaveLength(3);
    const first = result.candidates.find((c) => c.id.endsWith('/Limit%20current.'))!;
    const second = result.candidates.find((c) => c.id.endsWith('/Stop%20on%20heat.'))!;
    expect(first.text).toContain('Keep the battery safe.');
    expect(first.text).toContain('Keep the fuse.');
    expect(second.text).toContain('# Not a heading\n- Not a rule');
    await writeFile(join(directory, '.cursorrules'), text + '## Storage\nStore dry.\n');
    const extended = await read([directory], 'rules');
    expect(result.candidates.every((c) => extended.candidates.some((next) => next.id === c.id))).toBe(true);
  });

  it('honors Cursor globs and alwaysApply before decision calls, retaining scopes when task paths are unknown', async () => {
    const directory = await tree({ 'typescript.mdc': '---\nglobs: ["**/*.{ts,tsx}"]\n---\nUse types.',
      'python.mdc': '---\nglobs:\n  - "**/*.py"\n---\nUse Python.',
      'always.mdc': '---\nglobs: "**/*.py"\nalwaysApply: true\n---\nKeep secrets private.' });
    const picked = await pickFromSources([markdown({ paths: [directory], kind: 'rules' })], { task: 'battery', paths: ['src/battery.ts'] }, { ...uncutPick,
      task: 'battery', decide: async ({ questions }, signal) => { expect(questions).toHaveLength(1); expect(questions[0]!.text).toBe('Use types.'); return yes({ task: 'battery', questions }, signal); },
    });
    expect(picked.selected).toHaveLength(2);
    expect(picked.record.candidates.find((c) => c.id.includes('always.mdc'))).toMatchObject({ asked: false });
    expect((await read([directory], 'rules')).candidates).toHaveLength(3);
  });

  it('honors Copilot applyTo before any model call', async () => {
    const directory = await tree({ 'python.instructions.md': '---\napplyTo: "**/*.py"\n---\nUse Python.' });
    const decide = vi.fn(yes);
    const result = await pickFromSources([markdown({ paths: [directory], kind: 'instructions' })], { task: 'battery', paths: ['src/battery.ts'] }, { ...uncutPick, task: 'battery', decide });
    expect(result.selected).toEqual([]);
    expect(decide).not.toHaveBeenCalled();
    expect((await read([directory], 'instructions', { paths: ['src/battery.py'] })).candidates).toHaveLength(1);
  });

  it('ranks nearest parent instructions and records their real directory', async () => {
    const directory = await tree({ 'AGENTS.md': 'Root.', 'src/AGENTS.md': 'Source.', 'other/AGENTS.md': 'Other.' });
    git(directory, 'init', '-b', 'main');
    const result = await read([join(directory, '**/AGENTS.md')], 'instructions', { paths: ['src/battery.ts'] });
    expect(result.candidates[0]!.directory).toBe(join(directory, 'src'));
    expect(result.candidates[0]!.signals['instruction-location']).toBe(1);
    expect(result.candidates.find((c) => c.directory === directory)!.signals['instruction-location']).toBe(0.5);
    expect(result.candidates.find((c) => c.directory === join(directory, 'other'))!.signals).not.toHaveProperty('instruction-location');
  });
});

describe('Markdown dates, pins, and decisions', () => {
  it('uses recorded or updated dates outside git, then file modification time', async () => {
    const directory = await tree({ 'dated.md': '---\ndate: 2024-01-01\n---\nFacts.', 'updated.md': '---\nupdated: 2024-02-01\n---\nFacts.', 'modified.md': 'Facts.' });
    await utimes(join(directory, 'modified.md'), new Date('2024-03-01'), new Date('2024-03-01'));
    const candidates = (await read([directory], 'knowledge')).candidates;
    expect(candidates.find((c) => c.title.startsWith('dated.md'))!.date).toEqual({ value: '2024-01-01', meaning: 'recorded' });
    expect(candidates.find((c) => c.title.startsWith('updated.md'))!.date).toEqual({ value: '2024-02-01', meaning: 'changed' });
    expect(candidates.find((c) => c.title.startsWith('modified.md'))!.date).toEqual({ value: (await stat(join(directory, 'modified.md'))).mtime.toISOString(), meaning: 'modified' });
  });

  it.each(['knowledge', 'docs', 'rules', 'instructions'] as const)('uses committed dates and pinned bytes for %s', async (kind) => {
    const directory = await tree({ 'guide.md': '---\ndate: 2024-01-01\n---\nOriginal.' });
    git(directory, 'init', '-b', 'main'); git(directory, 'add', '.'); git(directory, '-c', 'commit.gpgsign=false', 'commit', '-m', 'Record guide');
    const revision = git(directory, 'rev-parse', 'HEAD').trim();
    await writeFile(join(directory, 'guide.md'), 'Later.'); await writeFile(join(directory, 'untracked.md'), 'Untracked.');
    const current = await read([directory], kind);
    expect(current.candidates.find((c) => c.title.startsWith('guide.md'))!.date).toEqual({ value: '2025-02-03T12:00:00+00:00', meaning: 'changed' });
    expect(current.candidates.find((c) => c.title.startsWith('untracked.md'))!.date).toBeUndefined();
    const pinned = await read([directory], kind, { revision });
    expect(pinned.revision).toBe(revision);
    expect(pinned.candidates).toHaveLength(1);
    expect(pinned.candidates[0]!.text).toBe('Original.');
  });

  it('uses kind-specific questions and records kinds while retaining low-score evidence and full curator text', async () => {
    const directory = await tree({ 'guide.md': 'Battery facts.' });
    const picked = await pickFromSources(['knowledge', 'docs', 'rules', 'instructions'].map((kind) => markdown({ paths: [directory], kind: kind as 'knowledge' | 'docs' | 'rules' | 'instructions' })), { task: 'battery' }, { ...uncutPick,
      task: 'battery', decide: async ({ questions }, signal) => {
        expect(questions.map((q) => q.kind).sort()).toEqual(['docs', 'instructions', 'knowledge', 'rules']);
        expect(new Set(questions.map((q) => q.question)).size).toBe(4);
        return yes({ task: 'battery', questions }, signal);
      },
    });
    expect(picked.selected).toHaveLength(4);
    expect(picked.record.candidates.map((c) => c.kind).sort()).toEqual(['docs', 'instructions', 'knowledge', 'rules']);
    const curated = await curate('battery', picked, { write: async (prompt) => `[2024-01-01] Battery facts (said 2024-01-01; ${/^### (.+?) \(/m.exec(prompt.body)![1]})` });
    expect(curated.record.items).toHaveLength(2);
    expect(curated.record.items.every((item) => item.candidate.kind === 'knowledge' || item.candidate.kind === 'docs')).toBe(true);
  });

  it('weights signals by kind, records those weights, and keeps host rules on rule questions', async () => {
    const candidates: MemoryCandidate[] = ['low', 'high'].map((id) => ({ sourceId: 'docs', id, title: id, text: id, kind: 'docs', role: 'reference', signals: { words: id === 'low' ? 1 : 3 } }));
    const ranking = { docs: { words: -1 } };
    const result = await pick(candidates, { ...uncutPick, task: 'battery', decide: yes, ranking, limits: { maxCandidates: 1 } });
    expect(result.selected.map((c) => c.id)).toEqual(['low']);
    expect(result.record.ranking).toEqual(ranking);
    const rule = { ...candidates[0]!, role: 'rule' as const };
    await pick([rule], { ...uncutPick, task: 'battery', decide: async ({ questions }, signal) => { expect(questions[0]!.question).toBe('Does this rule apply to this task?'); return yes({ task: 'battery', questions }, signal); } });
    await expect(pick(candidates, { ...uncutPick, task: 'battery', decide: yes, ranking: { docs: { words: NaN } } })).rejects.toThrow('finite');
  });
});
