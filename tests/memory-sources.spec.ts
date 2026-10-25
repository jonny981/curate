import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import { historySource, memory, type PickQuestion } from '@curatejs/core';
import { chat, CHAT_CASCADE, chatSettings } from '@curatejs/chat';
import { git as gitSource, GIT_HISTORY_CASCADE } from '@curatejs/git';
import { markdown, MARKDOWN_CASCADE } from '@curatejs/markdown';

it('uses each real reader question set with no question option', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'curate-memory-'));
  try {
    vi.stubEnv('XDG_CACHE_HOME', join(directory, 'cache'));
    for (const name of ['docs', 'policy', 'transcripts']) await mkdir(join(directory, name));
    await writeFile(join(directory, 'docs/billing.md'), '---\ndate: 2026-01-12\n---\n# Billing\nKeep the order currency.\n');
    await writeFile(join(directory, 'policy/rules.md'), 'Never round an order twice.\n');
    await writeFile(join(directory, 'transcripts/session.jsonl'), JSON.stringify({
      type: 'user', timestamp: '2026-01-12T10:00:00Z', sessionId: 'billing',
      message: { content: 'Billing must keep the order currency.' },
    }) + '\n');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const git = (...args: string[]) => execFileSync('git', ['-C', directory, '-c', 'core.hooksPath=/dev/null', ...args], {
      env: { ...env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
        GIT_AUTHOR_DATE: '2026-01-12T10:00:00Z', GIT_COMMITTER_DATE: '2026-01-12T10:00:00Z' },
      stdio: 'pipe',
    });
    git('init', '-b', 'main');
    git('add', 'docs');
    git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Keep billing currency', '-m', 'Invoices preserve the order currency.');
    const sources = [
      historySource({ reader: chat({ paths: [join(directory, 'transcripts')], providers: ['claude-code'] }), ...chatSettings, labels: false }),
      gitSource(directory),
      markdown({ paths: [join(directory, 'docs')], kind: 'docs' }),
      markdown({ paths: [join(directory, 'policy')], kind: 'rules' }),
    ];
    const questions: PickQuestion[] = [];
    const { log, rules, picked, result } = await memory({
      sources,
      decide: async (batch) => {
        questions.push(...batch.questions);
        return Object.fromEntries(batch.questions.map((q) => [q.key, { status: 'answered', probability: 0.5 }]));
      },
      write: async ({ body }) => {
        expect(body).not.toContain('Never round an order twice.');
        return '[2026-01-12] Keep the order currency (said 2026-01-12; E1)';
      },
    }).recall('What billing constraint must this change preserve?');
    for (const [index, cascade] of [CHAT_CASCADE, GIT_HISTORY_CASCADE, MARKDOWN_CASCADE].entries()) {
      const asked = questions.filter((q) => q.sourceId === sources[index]!.id);
      expect(asked.map((q) => q.questionKey).sort()).toEqual(cascade.questions.map((q) => q.key).sort());
      for (const q of asked) {
        expect(q.question).toBe(cascade.questions.find((item) => item.key === q.questionKey)!.instructions);
      }
    }
    expect(Object.values(picked.record.levers.sources).every((settings) => !settings.labels)).toBe(true);
    expect(Object.values(picked.record.levers.sources).every((settings) => settings.bar === 0.0146)).toBe(true);
    expect(picked.record.labels).toBeUndefined();
    expect(picked.selected.filter((item) => item.role === 'reference')).toHaveLength(3);
    expect(result.record.items).toHaveLength(3);
    expect(rules).toContain('Never round an order twice.');
    expect(log).toContain('Keep the order currency');
    expect(log).not.toContain('; E1)');
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
