import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { memory, pickFromSources, type PickDecide, type PickQuestion } from '@curatejs/core';
import { markdown, rules } from '@curatejs/markdown';

const directories: string[] = [];
async function tree(files: Readonly<Record<string, string>>): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'curate-rule-library-')));
  directories.push(directory);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), text);
  }
  return directory;
}
beforeEach(async () => { vi.stubEnv('XDG_CACHE_HOME', await tree({})); });
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

/** Answers each question by the first listed phrase its text holds, 0.9 otherwise, and keeps every question. */
function answering(answers: Readonly<Record<string, number>> = {}) {
  const asked: PickQuestion[] = [];
  const decide: PickDecide = async ({ questions }) => {
    asked.push(...questions);
    return Object.fromEntries(questions.map((q) => [q.key, { status: 'answered' as const,
      probability: Object.entries(answers).find(([phrase]) => q.text.includes(phrase))?.[1] ?? 0.9 }]));
  };
  return { asked, decide };
}

const ALWAYS_ON = {
  'CLAUDE.md': 'Claude Code reads this every session.\n',
  'AGENTS.md': 'Codex reads this every session.\n',
  '.cursorrules': 'Cursor reads this every session.\n',
  'always.mdc': '---\nalwaysApply: true\n---\nCursor applies this every session.\n',
  'pinned.md': '---\napplies: always\n---\nThis file says it applies always.\n',
};
const SKIPPED = [
  '.cursorrules (a harness loads .cursorrules every session)',
  'AGENTS.md (a harness loads AGENTS.md every session)',
  'CLAUDE.md (a harness loads CLAUDE.md every session)',
  'always.mdc (declared always-on (alwaysApply: true): the agent\'s harness loads always-on rules)',
  'pinned.md (declared always-on (applies: always): the agent\'s harness loads always-on rules)',
];
const LIBRARY = '# Billing\n- Store money as integer cents.\n- Round once, at the end.\n- Keep the order currency.\n'
  + '- Log every refund.\n- Name invoices by date.\n';

describe('the rule library', () => {
  it('never asks about or returns an always-on file, and records each one it skipped', async () => {
    const directory = await tree({ ...ALWAYS_ON,
      'commits.md': 'Sign every commit.\n', 'reviews.md': 'Ask for one review.\n' });
    const { asked, decide } = answering();
    const source = rules(directory);
    const picked = await pickFromSources([source], { task: 'commit the billing fix' }, { task: 'commit the billing fix', decide });
    expect(asked.map((q) => q.text).sort()).toEqual(['Ask for one review.\n', 'Sign every commit.\n']);
    expect(picked.selected.map((c) => c.text).sort()).toEqual(['Ask for one review.\n', 'Sign every commit.\n']);
    expect(picked.selected.every((c) => c.applies === undefined)).toBe(true);
    const read = picked.reads[0]!;
    expect(read.status === 'read' ? read.alwaysOnSkipped?.map((skip) => `${skip.file} (${skip.reason})`).sort() : undefined)
      .toEqual(SKIPPED);

    const instructions = await tree({ 'AGENTS.md': 'Root.\n', 'src/AGENTS.md': 'Source.\n' });
    const agents = markdown({ paths: [join(instructions, '**/AGENTS.md')], kind: 'instructions' });
    const none = answering();
    const result = await pickFromSources([agents], { task: 'work on src' }, { task: 'work on src', decide: none.decide });
    expect(none.asked).toEqual([]);
    expect(result.selected).toEqual([]);
    expect(result.reads[0]).toMatchObject({ status: 'read', candidates: [] });
  });

  it('picks one rule at a time at the bar and returns each word for word, with the heading above it', async () => {
    const directory = await tree({ 'billing.md': LIBRARY });
    const notes = await tree({ 'billing.md': 'Billing moved to cents in 2025.\n' });
    const { asked, decide } = answering({ 'integer cents': 0.95, 'Round once': 0.9, 'order currency': 0.6,
      'every refund': 0.4, 'invoices by date': 0.2 });
    // memory() curates a log too, so one note goes in beside the library.
    const library = rules(directory);
    const { rules: text, picked } = await memory({ sources: [library, markdown({ paths: [notes], kind: 'docs' })], decide,
      write: async () => '[2025-01-01] Billing moved to cents (said 2025-01-01; E1)' }).recall('Change how billing stores money');
    expect(asked.filter((q) => q.sourceId === library.id)).toHaveLength(5);
    const expected = ['- Store money as integer cents.\n', '- Round once, at the end.\n', '- Keep the order currency.\n']
      .map((rule) => `# Billing\n${rule}`);
    const picks = picked.selected.filter((c) => c.role === 'rule').map((c) => c.text);
    expect([...picks].sort()).toEqual([...expected].sort());
    expect(text).toBe(picks.join('\n\n'));
  });

  it('shows a Cursor rule\'s description to the decision model in the rule\'s title', async () => {
    const directory = await tree({ 'money.mdc': '---\ndescription: Money is stored as integer cents\n---\nNever use floats for money.\n' });
    const { asked, decide } = answering();
    await pickFromSources([rules(directory)], { task: 'Change billing' }, { task: 'Change billing', decide });
    expect(asked.map((q) => [q.title, q.text])).toEqual([['money.mdc: Money is stored as integer cents', 'Never use floats for money.\n']]);
  });

  it('reads Cursor globs scope', async () => {
    const directory = await tree({ 'billing.mdc': '---\nglobs: src/billing/**\n---\nStore money as integer cents.\n',
      'commits.md': 'Sign every commit.\n' });
    const texts = async (paths: string[]) => {
      const read = await rules(directory).read({ task: 'change the code', paths });
      return read.status === 'read' ? read.candidates.map((c) => c.text).sort() : [];
    };
    expect(await texts(['src/billing/invoice.ts'])).toEqual(['Sign every commit.\n', 'Store money as integer cents.\n']);
    expect(await texts(['src/auth/login.ts'])).toEqual(['Sign every commit.\n']);
  });

  it('checks globs and applyTo against the repository root, for relative and absolute task paths', async () => {
    const project = await tree({ '.cursor/rules/billing.mdc': '---\nglobs: src/billing/**\n---\nStore money as integer cents.\n',
      '.cursor/rules/auth.instructions.md': '---\napplyTo: src/auth/**\n---\nHash every password.\n',
      '.cursor/rules/commits.md': 'Sign every commit.\n' });
    execFileSync('git', ['-C', project, 'init', '-q', '-b', 'main'], { stdio: 'pipe' });
    const texts = async (paths: string[]) => {
      const read = await rules(join(project, '.cursor/rules')).read({ task: 'change the code', paths });
      return read.status === 'read' ? read.candidates.map((c) => c.text).sort() : [];
    };
    for (const path of ['src/billing/invoice.ts', join(project, 'src/billing/invoice.ts')]) {
      expect(await texts([path])).toEqual(['Sign every commit.\n', 'Store money as integer cents.\n']);
    }
    for (const path of ['src/auth/login.ts', join(project, 'src/auth/login.ts')]) {
      expect(await texts([path])).toEqual(['Hash every password.\n', 'Sign every commit.\n']);
    }
  });

  it('records the always-on files skipped and what the bar picked and dropped', async () => {
    const directory = await tree({ ...ALWAYS_ON, 'billing.md': LIBRARY });
    const { decide } = answering({ 'integer cents': 0.95, 'Round once': 0.9, 'order currency': 0.6,
      'every refund': 0.4, 'invoices by date': 0.2 });
    const source = rules(directory);
    const picked = await pickFromSources([source], { task: 'Change how billing stores money' },
      { task: 'Change how billing stores money', decide });
    const effect = (setting: string) => picked.record.effects.find((entry) => entry.setting === setting && entry.source === source.id);
    expect(effect('alwaysOnSkipped')).toEqual({ setting: 'alwaysOnSkipped', source: source.id, actedOn: 5, added: 0, dropped: null,
      summary: `alwaysOnSkipped on ${source.id}: skipped 5 always-on files the agent's harness loads itself: ${SKIPPED.join('; ')}.` });
    expect(effect('ruleBar')).toEqual({ setting: 'ruleBar', source: source.id, actedOn: 5, added: 0, dropped: 2,
      summary: `ruleBar on ${source.id}: asked 5 rules, picked 3, dropped 2 below the bar 0.5.` });
  });
});
