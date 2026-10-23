import { describe, expect, it, vi } from 'vitest';
import { chat } from '@curatejs/chat';
import { gitHistory } from '@curatejs/git';
import { knowledgeBase, markdown, rules } from '@curatejs/markdown';
import { LABEL_KINDS, type CandidateSource, type PickDecide } from '@curatejs/core';
// @ts-expect-error The standalone JavaScript command has no type declarations.
import { pickFullSources } from '../skills/curate/run.mjs';

describe('reader rare-word defaults', () => {
  it.each([
    ['git', () => gitHistory('/nonexistent')],
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
      ...(id === 'chat' ? { labelKinds: LABEL_KINDS } : {}),
      read: vi.fn(async () => ({ status: 'read' as const, complete: true, candidates: [{
        sourceId: id, id: 'one', title: 'one', text: 'one', role: 'reference' as const, signals: { score: 1 },
      }] })) });
    const decide: PickDecide = async ({ questions }) => Object.fromEntries(questions.map((q) =>
      [q.key, { status: 'answered', probability: 0.9 }]));
    const git = reader('git', true);
    const transcript = reader('chat', false);
    const result = await pickFullSources([git, transcript], { task: 'one' }, { task: 'one', decide });
    expect(git.read).toHaveBeenCalledTimes(2);
    expect(transcript.read).toHaveBeenCalledTimes(1);
    expect(result.record.levers.preset).toBe('agent-tasks');
    vi.mocked(git.read).mockClear();
    await pickFullSources([git], { task: 'one' }, { task: 'one', decide, rare: false });
    expect(git.read).toHaveBeenCalledTimes(1);
  });
});
