import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { curate, historySource, pickFromSources, type PickCascade } from '@curatejs/core';
import { chat, chatSettings } from '@curatejs/chat';
import { git as gitSource, gitSettings } from '@curatejs/git';
import { knowledgeBase, markdownSettings, rules, rulesSettings } from '@curatejs/markdown';

const uncutPick = { everyRanked: true, everyScored: true, rare: false } as const;

it('combines search options and source questions across real readers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'curate-search-integration-'));
  try {
    for (const name of ['notes', 'policy', 'transcripts']) await mkdir(join(directory, name));
    await writeFile(join(directory, 'notes', 'guide.md'), '## Backup\nApple orchard backup evidence.\n## Audit\nBanana harvest restoration evidence.\n');
    await writeFile(join(directory, 'policy', 'rule.md'), 'Keep source dates.\n');
    await writeFile(join(directory, 'transcripts', 'session.jsonl'), [
      { type: 'session_meta', timestamp: '2026-01-01T10:00:00Z', payload: { id: 'fruit' } },
      ...['Apple orchard backup evidence.', 'Banana harvest restoration evidence.'].map((text) => ({
        type: 'response_item', timestamp: '2026-01-01T10:01:00Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
      })),
    ].map((record) => JSON.stringify(record)).join('\n'));
    const git = (...args: string[]) => execFileSync('git', ['-C', directory, '-c', 'core.hooksPath=/dev/null', ...args], {
      env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' }, stdio: 'pipe',
    });
    git('init', '-b', 'main');
    git('add', 'notes', 'policy');
    git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Apple orchard backup', '-m', 'Preserve banana harvest evidence.');
    const fitted = (key: string): PickCascade => ({ bias: 0, questions: [{
      key, instructions: `Check ${key}?`, true: 'It supplies evidence.', false: 'It supplies no evidence.', weight: 1,
    }] });
    const readers = [historySource({ reader: chat({ paths: [join(directory, 'transcripts')], providers: ['codex'] }), ...chatSettings, labels: false, questions: fitted('chat') }),
      historySource({ reader: gitSource(directory), ...gitSettings, questions: fitted('history') }),
      historySource({ reader: knowledgeBase(join(directory, 'notes')), ...markdownSettings, questions: fitted('note') }),
      historySource({ reader: rules(join(directory, 'policy')), ...rulesSettings, questions: fitted('note') })];
    const kinds = new Map(readers.map((reader) => [reader.id, reader.kind]));
    const task = 'Apple orchard. Answer in one line. Cite both.';
    const calls: string[][] = [];
    const result = await pickFromSources(readers, { task, searchLines: ['Banana harvest'], stripSearchInstructions: true }, { ...uncutPick,
      task, bestPartFirst: true, rankProtection: true, limits: { maxCandidates: 4 },
      decide: async (batch) => {
        expect(batch.task).toBe(task);
        calls.push(batch.questions.map((question) => `${question.sourceId}:${question.id}:${question.questionKey}`));
        return Object.fromEntries(batch.questions.map((question) => {
          // A rule is asked the rule question, never the source's set.
          expect(question.questionKey).toBe(question.role === 'rule' ? undefined
            : kinds.get(question.sourceId) === 'chat' ? 'chat' : kinds.get(question.sourceId) === 'git-history' ? 'history' : 'note');
          return [question.key, { status: 'answered', probability: 0.5 }];
        }));
      },
    });
    // The rule is asked too, in the first batch.
    expect(calls.map((questions) => questions.length)).toEqual([4, 2]);
    expect(result.selected).toHaveLength(6);
    expect(result.record.rulesCoverage).toBe('complete');
    expect(result.record.candidates.filter((entry) => entry.role === 'reference').every((entry) =>
      entry.status === 'selected' && entry.probability === 0.5
      && entry.orderScore !== undefined)).toBe(true);
    const curated = await curate(task, result, { write: async (prompt) => {
      expect(prompt.body).toContain(`TASK:\n${task}`);
      expect(prompt.body).toContain('Banana harvest restoration evidence.');
      expect(prompt.body).toContain(', 0.5):');
      expect(prompt.body).not.toContain('Keep source dates.');
      return '[2026-01-01] Backup evidence (said 2026-01-01; E1)';
    } });
    expect(curated.record.items).toHaveLength(5);
    expect(curated.record.items.every((item) => item.weight === 0.5)).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
