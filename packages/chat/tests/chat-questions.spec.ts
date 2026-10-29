import { describe, expect, it } from 'vitest';

import { historySource, pickFromSources, type CandidateSource, type PickQuestion } from '@curatejs/core';
import { chat, chatSettings, CHAT_CASCADE } from '../src/index.js';

describe('source decision questions', () => {
  it('asks agent transcripts no own question while preserving the personal provider questions', async () => {
    const agent = chat({ id: 'agent' });
    const reader = (id: string): CandidateSource => ({
      id, role: 'reference', kind: 'chat',
      read: async () => ({ status: 'read', complete: true, laneCutApplied: true,
        candidates: [{ sourceId: id, id: 'part', role: 'reference', title: id,
          text: `${id} evidence`, signals: { keyword: 1 } }] }),
    });
    const sources = [
      { ...agent, labelKinds: [], names: false, read: reader('agent').read },
      historySource({ reader: reader('personal'), ...chatSettings, labels: false, names: false }),
    ];
    const asked: PickQuestion[] = [];
    const result = await pickFromSources(sources, { task: 'Recall evidence' }, {
      task: 'Recall evidence', everyScored: true, rare: false,
      decide: async ({ questions }) => {
        asked.push(...questions);
        return Object.fromEntries(questions.map((question) => [question.key,
          { status: 'answered', probability: 0.5 }]));
      },
    });
    expect(asked.filter((question) => question.sourceId === 'agent').map((question) => question.questionKey))
      .toEqual(['relevant', 'needed']);
    expect(asked.filter((question) => question.sourceId === 'personal').map((question) => question.questionKey))
      .toEqual(['relevant', 'own', 'needed']);
    expect(result.record.levers.sources.agent?.questions?.questions.map((question) => question.key))
      .toEqual(['relevant', 'needed']);
    expect(result.record.levers.sources.personal?.questions).toEqual(CHAT_CASCADE);
    expect(chatSettings.questions).toBe(CHAT_CASCADE);
  });
});
