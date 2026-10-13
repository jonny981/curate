import { describe, expect, it } from 'vitest';
import { pick, type MemoryCandidate, type PickCascade, type PickDecide } from '../src/index.js';

const cascade: PickCascade = {
  bias: -1.7305, first: 'relevant', band: [0.1, 0.9],
  firstOnly: { bias: -0.6674, weight: 1.2882 },
  questions: [
    { key: 'relevant', instructions: 'Relevant?', true: 'Useful', false: 'Other', weight: 0.7031 },
    { key: 'own', instructions: 'Own situation?', true: 'Own', false: 'General', weight: 0.8588 },
    { key: 'needed', instructions: 'Needed?', true: 'Needed', false: 'Other', weight: 0.5134 },
  ],
};
const item = (id: string, score = 0): MemoryCandidate => ({
  sourceId: 'chat', role: 'reference', id, title: id, text: 'Evidence',
  date: { value: '2023-05-20', meaning: 'recorded' }, signals: { keyword: score },
});
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const logit = (p: number) => Math.log(Math.max(p, 0.0001) / Math.max(1 - p, 0.0001));

describe('fitted decision questions', () => {
  it('asks first questions before narrow questions, only inside the inclusive band', async () => {
    const calls: string[][] = [];
    const values: Record<string, number> = { low: 0, high: 1, middle: 0.5, edge: 0.1 };
    const decide: PickDecide = async ({ questions }) => {
      calls.push(questions.map((q) => `${q.id}:${q.questionKey}`));
      expect(questions.every((q) => q.date?.value === '2023-05-20')).toBe(true);
      return Object.fromEntries(questions.map((q) => [q.key, {
        status: 'answered', probability: q.questionKey === 'relevant' ? values[q.id]! : 0.8,
      }]));
    };
    const result = await pick(['low', 'high', 'middle', 'edge'].map((id, i) => item(id, 4 - i)), {
      task: 'Recall', cascade, decide, thresholds: { reference: 0 }, limits: { maxPerBatch: 2 },
    });
    expect(calls).toEqual([
      ['low:relevant', 'high:relevant'], ['middle:relevant', 'edge:relevant'],
      ['middle:own', 'middle:needed'], ['edge:own', 'edge:needed'],
    ]);
    const weights = Object.fromEntries(result.record.candidates.map((entry) =>
      [entry.id, 'probability' in entry ? entry.probability : undefined]));
    expect(weights.low).toBe(sigmoid(-0.6674 + 1.2882 * logit(0)));
    expect(weights.high).toBe(sigmoid(-0.6674 + 1.2882 * logit(1)));
    expect(weights.middle).toBe(sigmoid(-1.7305 + 0.7031 * logit(0.5) + 0.8588 * logit(0.8) + 0.5134 * logit(0.8)));
    expect(result.record.cascade).toEqual(cascade);
    expect(result.record.candidates[0]?.questions?.map((q) => q.status)).toEqual(['answered', 'missing', 'missing']);
  });

  it('uses bias and available fitted answers when a narrow answer is missing', async () => {
    const decide: PickDecide = async ({ questions }) => Object.fromEntries(questions
      .filter((q) => q.questionKey !== 'needed')
      .map((q) => [q.key, { status: 'answered', probability: q.questionKey === 'own' ? 0.8 : 0.5 }]));
    const result = await pick([item('a')], { task: 'Recall', cascade, decide, thresholds: { reference: 0 } });
    expect(result.record.candidates[0]).toMatchObject({ probability: sigmoid(-1.7305 + 0.8588 * logit(0.8)) });
    const missing = await pick([item('a')], { task: 'Recall', cascade, decide: async () => ({}) });
    expect(missing.record.candidates[0]).toMatchObject({ status: 'unanswered', answer: 'missing' });
  });

  it('keeps rule questions separate and source keys distinct', async () => {
    const keys: string[] = [];
    const decide: PickDecide = async ({ questions }) => {
      for (const q of questions) {
        keys.push(q.key);
        if (q.role === 'rule') expect(q.questionKey).toBeUndefined();
      }
      return Object.fromEntries(questions.map((q) => [q.key, { status: 'answered', probability: 0.8 }]));
    };
    await pick([item('same'), { ...item('same'), sourceId: 'other' }, { ...item('r'), role: 'rule' }], {
      task: 'Recall', cascade, decide,
    });
    expect(new Set(keys).size).toBe(7);
    expect(keys).toContain(JSON.stringify(['chat', 'same', 'needed']));
  });

  it('bounds questions per batch and candidates across both steps', async () => {
    const sizes: number[] = [];
    const decide: PickDecide = async ({ questions }) => {
      sizes.push(questions.length);
      return Object.fromEntries(questions.map((q) => [q.key, { status: 'answered', probability: 0.5 }]));
    };
    const result = await pick([item('a', 3), item('b', 2), item('c', 1)], {
      task: 'Recall', cascade, decide, limits: { maxPerBatch: 2, maxCandidates: 2 },
    });
    expect(sizes).toEqual([2, 2, 2]);
    expect(result.record.candidates[2]).toMatchObject({ status: 'unassessed', reason: 'limits' });
  });

  it('leaves in-band candidates unassessed when the batch limit stops their narrow questions', async () => {
    const decide: PickDecide = async ({ questions }) => Object.fromEntries(questions.map((q) =>
      [q.key, { status: 'answered', probability: q.id === 'outside' ? 1 : 0.8 }]));
    const result = await pick([item('inside', 2), item('outside', 1)], {
      task: 'Recall', cascade, decide, limits: { maxPerBatch: 2, maxBatches: 1 },
    });
    expect(result.record.candidates[0]).toMatchObject({ status: 'unassessed', reason: 'limits' });
    expect(result.record.candidates[1]).toMatchObject({ status: 'selected' });
    const full = await pick([item('inside')], { task: 'Recall', cascade, decide });
    expect(full.record.candidates[0]).toMatchObject({ status: 'selected' });
    const unstaged = await pick([item('inside')], {
      task: 'Recall', cascade: { bias: cascade.bias, questions: cascade.questions }, decide,
      limits: { maxPerBatch: 1, maxBatches: 1 },
    });
    expect(unstaged.record.candidates[0]).toMatchObject({ status: 'unassessed', reason: 'limits' });
  });

  it.each([
    { ...cascade, bias: NaN }, { ...cascade, first: 'unknown' },
    { ...cascade, band: [0.9, 0.1] }, { ...cascade, firstOnly: undefined },
    { ...cascade, questions: [cascade.questions[0], cascade.questions[0]] },
  ])('rejects invalid fitted configuration before calling decide', async (invalid) => {
    let calls = 0;
    await expect(pick([item('a')], {
      task: 'Recall', cascade: invalid as PickCascade, decide: async () => { calls++; return {}; },
    })).rejects.toThrow('cascade');
    expect(calls).toBe(0);
  });
});

describe('selection after decisions', () => {
  const decide: PickDecide = async ({ questions }) => Object.fromEntries(questions.map((q) => [q.key, {
    status: 'answered', probability: q.id === 'weak' ? 0.1 : q.id === 'keyword' ? 0.7 : 0.9,
  }]));
  const candidates = [item('keyword', 9), item('strong', 5), item('weak', 10)];

  it('orders by decision weight and keeps all passing items without a size cap', async () => {
    const result = await pick(candidates.map((c) => ({ ...c, text: 'x'.repeat(30_000) })), { task: 'Recall', decide });
    expect(result.selected.map((c) => c.id)).toEqual(['strong', 'keyword']);
    expect(result.selected.every((c) => c.text.length === 30_000)).toBe(true);
  });

  it('promotes selected top keyword hits without admitting rejected ones', async () => {
    const result = await pick(candidates, { task: 'Recall', decide, keepTop: 2 });
    expect(result.selected.map((c) => c.id)).toEqual(['keyword', 'strong']);
    expect(result.record.keepTop).toBe(2);
    expect((await pick(candidates, { task: 'Recall', decide, keepTop: 0 })).selected.map((c) => c.id))
      .toEqual(['strong', 'keyword']);
  });

  it.each([-1, 0.5, Infinity])('rejects keepTop=%s', async (keepTop) => {
    await expect(pick(candidates, { task: 'Recall', decide, keepTop })).rejects.toThrow('keepTop');
  });
});
