import { describe, expect, it } from 'vitest';

import { pick, type MemoryCandidate, type PickQuestion } from '../src/index.js';

describe('identical decision text', () => {
  const said = (id: string, author: 'person' | 'agent', score: number): MemoryCandidate => ({
    sourceId: 'chat', id, title: id, text: 'Use Postgres.', role: 'reference', signals: { score },
    author, chat: { provider: 'claude-code', sessionId: 's', role: author === 'person' ? 'user' : 'assistant' },
  });
  /** A decider that answers by the author it is shown, and the questions it was asked. */
  const byAuthor = (asked: PickQuestion[]) => async ({ questions }: { questions: readonly PickQuestion[] }) => {
    asked.push(...questions);
    return Object.fromEntries(questions.map((question) => [question.key,
      { status: 'answered' as const, probability: question.author === 'person' ? 0.9 : 0.001 }]));
  };

  it('asks identical text from two authors once each, so neither takes the other\'s answer', async () => {
    const asked: PickQuestion[] = [];
    const result = await pick([said('agent-said', 'agent', 2), said('person-said', 'person', 1)], {
      task: 'What did the person choose?', everyRanked: true, everyScored: { bar: 0.0146 }, decide: byAuthor(asked),
    });
    expect(asked.map((question) => question.id)).toEqual(['agent-said', 'person-said']);
    expect(result.record.candidates.map((entry) => [entry.id, entry.status, 'probability' in entry && entry.probability]))
      .toEqual([['agent-said', 'rejected', 0.001], ['person-said', 'selected', 0.9]]);
  });

  it('still asks identical text from one author once', async () => {
    const asked: PickQuestion[] = [];
    const result = await pick([said('first', 'person', 2), said('second', 'person', 1)], {
      task: 'What did the person choose?', everyRanked: true, everyScored: { bar: 0.0146 }, decide: byAuthor(asked),
    });
    expect(asked.map((question) => question.id)).toEqual(['first']);
    expect(result.selected.map((part) => part.id)).toEqual(['first', 'second']);
  });

  it.each([
    { maxPerBatch: 150, bestPartFirst: false },
    { maxPerBatch: 1, bestPartFirst: false },
    { maxPerBatch: 150, bestPartFirst: true },
  ])('asks once for three copies and propagates kept and rejected answers: %j', async (settings) => {
    const parts: MemoryCandidate[] = ['keep', 'reject'].flatMap((text) =>
      Array.from({ length: 3 }, (_, index) => ({
        sourceId: 'notes', id: `${text}-${index}`, title: `${text} copy ${index}`,
        documentId: text, text, role: 'reference', signals: { score: 6 - index },
      })));
    const asked: PickQuestion[] = [];
    const result = await pick(parts, {
      task: 'Recall evidence', everyRanked: true, everyScored: { bar: 0.6 },
      bestPartFirst: settings.bestPartFirst, limits: { maxPerBatch: settings.maxPerBatch },
      decide: async ({ questions }) => {
        asked.push(...questions);
        return Object.fromEntries(questions.map((question) => [question.key,
          { status: 'answered', probability: question.text === 'keep' ? 0.9 : 0.1 }]));
      },
    });
    expect(asked.map((question) => question.text).sort()).toEqual(['keep', 'reject']);
    expect(result.selected.map((part) => part.id).sort()).toEqual(['keep-0', 'keep-1', 'keep-2']);
    expect(result.record.candidates.map((entry) => [entry.id, entry.status, 'probability' in entry && entry.probability]))
      .toEqual(parts.map((part) => [part.id, part.text === 'keep' ? 'selected' : 'rejected', part.text === 'keep' ? 0.9 : 0.1]));
  });

  it.each([true, false])(
    'asks each title-only part its own question, relevant first: %s',
    async (relevantFirst) => {
      const commit = (id: string, subject: string): MemoryCandidate => ({
        sourceId: 'git', id, title: subject, text: '', role: 'reference', signals: { score: 1 },
      });
      const parts = relevantFirst
        ? [commit('a', 'keep the billing fix'), commit('b', 'drop the typo fix')]
        : [commit('b', 'drop the typo fix'), commit('a', 'keep the billing fix')];
      const asked: PickQuestion[] = [];
      const result = await pick(parts, {
        task: 'Recall evidence', everyRanked: true, everyScored: { bar: 0.6 },
        decide: async ({ questions }) => {
          asked.push(...questions);
          return Object.fromEntries(questions.map((question) => [question.key,
            { status: 'answered', probability: question.title.startsWith('keep') ? 0.9 : 0.1 }]));
        },
      });
      expect(asked.map((question) => question.id).sort()).toEqual(['a', 'b']);
      expect(result.selected.map((part) => part.id)).toEqual(['a']);
      expect(result.record.candidates.map((entry) => [entry.id, entry.status]))
        .toEqual(parts.map((part) => [part.id, part.title.startsWith('keep') ? 'selected' : 'rejected']));
    });
});
