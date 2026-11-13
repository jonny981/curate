import { describe, expect, it } from 'vitest';
import { pick, type MemoryCandidate, type PickCascade, type PickDecide } from '../src/index.js';
import { checkCascade } from '../src/options.js';
import { modesOf } from './fixtures/modes.js';

const uncutPick = { everyRanked: true, everyScored: true } as const;

const fitted: PickCascade = {
  bias: -1.7305, first: 'relevant', band: [0.1, 0.9],
  firstOnly: { bias: -0.6674, weight: 1.2882 },
  questions: [
    { key: 'relevant', instructions: 'Relevant?', true: 'Useful', false: 'Other', weight: 0.7031 },
    { key: 'own', instructions: 'Own situation?', true: 'Own', false: 'General', weight: 0.8588 },
    { key: 'needed', instructions: 'Needed?', true: 'Needed', false: 'Other', weight: 0.5134 },
  ],
};
const item = (id: string, score = 0): MemoryCandidate => ({
  sourceId: 'chat', role: 'reference', id, title: id, text: `Evidence ${id}`,
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
    const result = await pick(['low', 'high', 'middle', 'edge'].map((id, i) => item(id, 4 - i)), { ...uncutPick,
      task: 'Recall', modesBySource: modesOf({ chat: fitted }), decide, everyScored: { bar: 0 }, limits: { maxPerBatch: 2 },
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
    expect(result.record.levers.sources.chat?.questions).toEqual(fitted);
    expect(result.record.candidates[0]?.questions?.map((q) => q.status)).toEqual(['answered', 'missing', 'missing']);
  });

  it('uses bias and available fitted answers when a narrow answer is missing', async () => {
    const decide: PickDecide = async ({ questions }) => Object.fromEntries(questions
      .filter((q) => q.questionKey !== 'needed')
      .map((q) => [q.key, { status: 'answered', probability: q.questionKey === 'own' ? 0.8 : 0.5 }]));
    const result = await pick([item('a')], { ...uncutPick, task: 'Recall', modesBySource: modesOf({ chat: fitted }), decide, everyScored: { bar: 0 } });
    expect(result.record.candidates[0]).toMatchObject({ probability: sigmoid(-1.7305 + 0.8588 * logit(0.8)) });
    const missing = await pick([item('a')], { ...uncutPick, task: 'Recall', modesBySource: modesOf({ chat: fitted }), decide: async () => ({}) });
    expect(missing.record.candidates[0]).toMatchObject({ status: 'unanswered', answer: 'missing' });
  });

  it('shares identical reference questions across sources and keeps rule questions separate', async () => {
    const keys: string[] = [];
    const decide: PickDecide = async ({ questions }) => {
      for (const q of questions) {
        keys.push(q.key);
        if (q.role === 'rule') expect(q.questionKey).toBeUndefined();
      }
      return Object.fromEntries(questions.map((q) => [q.key, { status: 'answered', probability: 0.8 }]));
    };
    await pick([item('same'), { ...item('same'), sourceId: 'other' }, { ...item('r'), role: 'rule' }], { ...uncutPick,
      task: 'Recall', modesBySource: modesOf({ chat: fitted, other: fitted }), decide,
    });
    expect(new Set(keys).size).toBe(4);
    expect(keys).toContain(JSON.stringify(['chat', 'same', 'needed']));
  });

  it('bounds questions per batch and candidates across both steps', async () => {
    const sizes: number[] = [];
    const decide: PickDecide = async ({ questions }) => {
      sizes.push(questions.length);
      return Object.fromEntries(questions.map((q) => [q.key, { status: 'answered', probability: 0.5 }]));
    };
    const result = await pick([item('a', 3), item('b', 2), item('c', 1)], { ...uncutPick,
      task: 'Recall', modesBySource: modesOf({ chat: fitted }), decide, limits: { maxPerBatch: 2, maxCandidates: 2 },
    });
    expect(sizes).toEqual([2, 2, 2]);
    expect(result.record.candidates[2]).toMatchObject({ status: 'unassessed', reason: 'limits' });
  });

  it('leaves in-band candidates unassessed when the batch limit stops their narrow questions', async () => {
    const decide: PickDecide = async ({ questions }) => Object.fromEntries(questions.map((q) =>
      [q.key, { status: 'answered', probability: q.id === 'outside' ? 1 : 0.8 }]));
    const result = await pick([item('inside', 2), item('outside', 1)], { ...uncutPick,
      task: 'Recall', modesBySource: modesOf({ chat: fitted }), decide, limits: { maxPerBatch: 2, maxBatches: 1 },
    });
    expect(result.record.candidates[0]).toMatchObject({ status: 'unassessed', reason: 'limits' });
    expect(result.record.candidates[1]).toMatchObject({ status: 'selected' });
    const full = await pick([item('inside')], { ...uncutPick, task: 'Recall', modesBySource: modesOf({ chat: fitted }), decide });
    expect(full.record.candidates[0]).toMatchObject({ status: 'selected' });
    const unstaged = await pick([item('inside')], { ...uncutPick,
      task: 'Recall', modesBySource: modesOf({ chat: { bias: fitted.bias, questions: fitted.questions } }), decide,
      limits: { maxPerBatch: 1, maxBatches: 1 },
    });
    expect(unstaged.record.candidates[0]).toMatchObject({ status: 'unassessed', reason: 'limits' });
  });

  it.each([
    { ...fitted, bias: NaN }, { ...fitted, first: 'unknown' },
    { ...fitted, band: [0.9, 0.1] }, { ...fitted, firstOnly: undefined },
    { ...fitted, questions: [fitted.questions[0], fitted.questions[0]] },
    { ...fitted, person: NaN }, { ...fitted, person: '4.5' },
  ])('rejects invalid fitted configuration before calling decide', async (invalid) => {
    let calls = 0;
    await expect(pick([item('a')], { ...uncutPick,
      task: 'Recall', modesBySource: modesOf({ chat: invalid as PickCascade }), decide: async () => { calls++; return {}; },
    })).rejects.toThrow('question set');
    expect(calls).toBe(0);
  });
});

describe('the person\'s own words in the score', () => {
  const said = (id: string, author?: 'person' | 'agent'): MemoryCandidate => ({
    ...item(id, 1),
    ...(author === undefined ? {} : { author, chat: { provider: 'claude-code', sessionId: 's', role: 'user' } }),
  });
  const withPerson: PickCascade = { ...fitted, person: 4.5 };
  /** Each part's decision probability when `relevant` is answered per
   *  part and every other question 0.8. */
  const scored = async (cascade: PickCascade, relevant: Record<string, number>, bar = 0) => {
    const decide: PickDecide = async ({ questions }) => Object.fromEntries(questions.map((q) =>
      [q.key, { status: 'answered', probability: q.questionKey === 'relevant' ? relevant[q.id]! : 0.8 }]));
    const result = await pick([said('mine', 'person'), said('relayed', 'agent'), said('unmarked')], { ...uncutPick,
      task: 'Recall', modesBySource: modesOf({ chat: cascade }), decide, everyScored: { bar } });
    const probability = Object.fromEntries(result.record.candidates.map((entry) =>
      [entry.id, 'probability' in entry ? entry.probability : undefined]));
    return { result, probability };
  };

  it('adds the set\'s person weight to the logit of a part the person wrote, outside the band and inside it', async () => {
    const outside = (await scored(withPerson, { mine: 0.05, relayed: 0.05, unmarked: 0.05 })).probability;
    expect(outside.mine).toBeCloseTo(sigmoid(-0.6674 + 1.2882 * logit(0.05) + 4.5), 12);
    expect(outside.relayed).toBeCloseTo(sigmoid(-0.6674 + 1.2882 * logit(0.05)), 12);
    expect(outside.unmarked).toBe(outside.relayed);
    const inside = (await scored(withPerson, { mine: 0.5, relayed: 0.5, unmarked: 0.5 })).probability;
    const z = -1.7305 + 0.7031 * logit(0.5) + 0.8588 * logit(0.8) + 0.5134 * logit(0.8);
    expect(inside.mine).toBeCloseTo(sigmoid(z + 4.5), 12);
    expect(inside.relayed).toBeCloseTo(sigmoid(z), 12);
    expect(inside.unmarked).toBe(inside.relayed);
  });

  it('adds nothing in a set without a person weight', async () => {
    const { probability } = await scored(fitted, { mine: 0.5, relayed: 0.5, unmarked: 0.5 });
    expect(probability.mine).toBe(probability.relayed);
  });

  it('raises the person\'s part in the order and filters out no other part', async () => {
    // The agent's part rated 0.95 still leads; the person's part rated
    // 0.05 clears the bar that the unmarked part rated 0.05 does not.
    const { result } = await scored(withPerson, { mine: 0.05, relayed: 0.95, unmarked: 0.05 }, 0.0146);
    expect(result.selected.map((candidate) => candidate.id)).toEqual(['relayed', 'mine']);
    expect(result.record.candidates.find((entry) => entry.id === 'unmarked')).toMatchObject({ status: 'rejected' });
    const without = await scored(fitted, { mine: 0.05, relayed: 0.95, unmarked: 0.05 }, 0.0146);
    expect(without.result.selected.map((candidate) => candidate.id)).toEqual(['relayed']);
  });

  it('rejects a person weight on a model-scored set', () => {
    expect(() => checkCascade({
      model: { keys: ['a'], mu: [0], sd: [1], w: [1], b: 0, bar: 0.5 },
      questions: [{ key: 'a', instructions: 'i', true: 't', false: 'f' }],
      person: 1,
    })).toThrowError(/question set/);
  });
});

describe('selection after decisions', () => {
  const decide: PickDecide = async ({ questions }) => Object.fromEntries(questions.map((q) => [q.key, {
    status: 'answered', probability: q.id === 'weak' ? 0.1 : q.id === 'keyword' ? 0.7 : 0.9,
  }]));
  const candidates = [item('keyword', 9), item('strong', 5), item('weak', 10)];

  it('orders by decision weight and keeps all passing items without a size cap', async () => {
    const result = await pick(candidates.map((c) => ({ ...c, text: c.id + 'x'.repeat(30_000 - c.id.length) })), { ...uncutPick, task: 'Recall', decide });
    expect(result.selected.map((c) => c.id)).toEqual(['strong', 'keyword', 'weak']);
    expect(result.selected.every((c) => c.text.length === 30_000)).toBe(true);
  });

  it('promotes selected top keyword hits without admitting rejected ones', async () => {
    const result = await pick(candidates, { ...uncutPick, task: 'Recall', decide, keepTop: 2, everyScored: { bar: 0.6 } });
    expect(result.selected.map((c) => c.id)).toEqual(['keyword', 'strong']);
    expect(result.record.keepTop).toBe(2);
    expect((await pick(candidates, { ...uncutPick, task: 'Recall', decide, keepTop: 0, everyScored: { bar: 0.6 } })).selected.map((c) => c.id))
      .toEqual(['strong', 'keyword']);
  });

  it.each([-1, 0.5, Infinity])('rejects keepTop=%s', async (keepTop) => {
    await expect(pick(candidates, { ...uncutPick, task: 'Recall', decide, keepTop })).rejects.toThrow('keepTop');
  });
});
