import { describe, expect, it, vi } from 'vitest';
import { chat } from '@curatejs/chat';
import { git } from '@curatejs/git';
import { knowledgeBase, markdown, rules } from '@curatejs/markdown';
import { type CandidateSource, type PickDecide } from '@curatejs/core';
// @ts-expect-error The standalone JavaScript command has no type declarations.
import { pickFullSources } from '../skills/curate/run.mjs';

describe('reader rare-word defaults', () => {
  it.each([
    ['git', () => git('/nonexistent')],
    ['Markdown', () => markdown({ paths: ['/nonexistent'], kind: 'docs' })],
    ['knowledge notes', () => knowledgeBase('/nonexistent')],
    ['rules', () => rules('/nonexistent')],
  ] as const)('enables rare words on %s', (_name, create) => {
    expect(create().rare).toBe(true);
  });

  it('leaves chat rare words off', () => {
    expect(chat({ paths: ['/nonexistent'] }).rare ?? false).toBe(false);
  });

  it('caches full pools only for enabled source defaults in the skill', async () => {
    const reader = (id: string, rare: boolean): CandidateSource => ({ id, role: 'reference', rare,
      read: vi.fn(async () => ({ status: 'read' as const, complete: true, candidates: [{
        sourceId: id, id: 'one', title: 'one', text: 'one', role: 'reference' as const, signals: { score: 1 },
      }] })) });
    const decide: PickDecide = async ({ questions }) => Object.fromEntries(questions.map((q) =>
      [q.key, { status: 'answered', probability: 0.9 }]));
    const git = reader('git', true);
    const transcript = reader('chat', false);
    // On the old feed a full-pool read happens only where rare is on; a
    // thoroughness level reads every source's pool for the fused order.
    const result = await pickFullSources([git, transcript], { task: 'one' },
      { task: 'one', decide, everyRanked: true });
    expect(git.read).toHaveBeenCalledTimes(2);
    expect(transcript.read).toHaveBeenCalledTimes(1);
    expect(result.record.levers.sources).toEqual({ git: { labels: false, rare: true, bar: 0.0146 }, chat: { labels: false, rare: false, bar: 0.0146 } });
    vi.mocked(git.read).mockClear();
    await pickFullSources([git], { task: 'one' }, { task: 'one', decide, everyRanked: true, rare: false });
    expect(git.read).toHaveBeenCalledTimes(1);
  });
});
