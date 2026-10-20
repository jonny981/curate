import { describe, expect, it } from 'vitest';

import {
  pick,
  pickFromSources,
  type CandidateSource,
  type DecisionStore,
  type MemoryCandidate,
  type PickAnswer,
  type PickBatch,
  type PickDecide,
} from '../src/index.js';

function candidate(overrides: Partial<MemoryCandidate> & Pick<MemoryCandidate, 'sourceId' | 'id'>): MemoryCandidate {
  return {
    role: 'reference',
    title: overrides.id,
    text: 'plain',
    signals: { score: 0 },
    ...overrides,
  };
}

const answered = (probability: number): PickAnswer => ({ status: 'answered', probability });

function stubDecide(
  handler: (question: PickBatch['questions'][number]) => PickAnswer,
): { decide: PickDecide; calls: PickBatch[] } {
  const calls: PickBatch[] = [];
  return {
    calls,
    decide: async (batch) => {
      calls.push(batch);
      return Object.fromEntries(batch.questions.map((question) => [question.key, handler(question)]));
    },
  };
}

const decidedIds = (calls: PickBatch[]) => calls.flatMap((batch) => batch.questions)
  .map((question) => question.id);

const timesAsked = (calls: PickBatch[], id: string) => decidedIds(calls)
  .filter((askedId) => askedId === id).length;

// 'plain' sits in every part, so the document-frequency bound — not a
// stop list — keeps it out of the rare words. 'zephyr' is the rare
// word a seed shares with the part the first pass missed.
function parts(count: number, words: Record<string, string> = {}): MemoryCandidate[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `p${index}`;
    return candidate({ sourceId: 'notes', id, text: words[id] ?? 'plain', searchRanks: [index] });
  });
}

describe('pick rare-word round', () => {
  it('makes no extra calls when the rare round is not set', async () => {
    // Same shape as the pull-in test: a missed part shares a rare word
    // with a selected one, but with `rare` unset nobody reaches for it.
    const counter = stubDecide((question) => answered(question.id === 'p3' ? 0.1 : 0.9));
    const candidates = parts(10, { p0: 'plain zephyr', p7: 'plain zephyr' });
    const result = await pick(candidates, {
      task: 'Recall the plan', decide: counter.decide,
      everyScored: { bar: 0.5 }, everyRanked: { c: 0.68 },
    });

    expect(decidedIds(counter.calls)).toEqual(parts(4).map((item) => item.id));
    expect(result.record.pick).toEqual({ n: 10, c: 0.68, kept: 4, ranking: 'keyword' });
    expect(result.record.pick).not.toHaveProperty('rare');
    expect(result.selected.map((item) => item.id)).toEqual(['p0', 'p1', 'p2']);
  });

  it('pulls a missed part that shares a rare word with a selected part into the decide step', async () => {
    // 0.68 x 10^0.8 rounds to 4: p0-p3 are decided, p4-p9 are cut with
    // reason 'pick'. p7 shares 'zephyr' (in 2 of 10 parts, under the
    // 0.5 x 10 bound) with the selected p0, so the round asks it; at
    // 0.5 it clears the 0.0146 addition bar and is selected.
    const counter = stubDecide((question) => answered(question.id === 'p3' ? 0.1 : 0.9));
    const candidates = parts(10, { p0: 'plain zephyr', p7: 'plain zephyr' });
    const result = await pick(candidates, {
      task: 'Recall the plan', decide: counter.decide,
      everyScored: { bar: 0.5 },
      everyRanked: { c: 0.68 }, rare: { share: 0.5 },
    });

    expect(decidedIds(counter.calls)).toEqual(['p0', 'p1', 'p2', 'p3', 'p7']);
    expect(result.selected.map((item) => item.id)).toEqual(['p0', 'p1', 'p2', 'p7']);
    expect(result.record.pick?.rare).toMatchObject({
      share: 0.5, bar: 0.0146, asked: 1, added: 1,
      pulled: [{ sourceId: 'notes', id: 'p7' }],
    });
    expect(result.record.pick?.rare?.words).toContain('zephyr');
    expect(result.record.pick?.rare?.words).not.toContain('plain');
    expect(result.record.candidates.find((entry) => entry.id === 'p7'))
      .toMatchObject({ status: 'selected', asked: true, probability: 0.9 });
  });

  it('pulls nothing on a common word', async () => {
    // 'plain' is in all 10 parts, over the 0.5 x 10 bound, so it is
    // not rare and p7 is never pulled in.
    const counter = stubDecide((question) => answered(question.id === 'p3' ? 0.1 : 0.9));
    const candidates = parts(10, {});
    const result = await pick(candidates, {
      task: 'Recall the plan', decide: counter.decide,
      everyScored: { bar: 0.5 },
      everyRanked: { c: 0.68 }, rare: { share: 0.5 },
    });

    expect(decidedIds(counter.calls)).toEqual(parts(4).map((item) => item.id));
    expect(result.selected.map((item) => item.id)).toEqual(['p0', 'p1', 'p2']);
    expect(result.record.pick?.rare).toMatchObject({ asked: 0, added: 0, pulled: [] });
    expect(result.record.pick?.rare?.words).toEqual([]);
  });

  it('asks each part at most once across both rounds', async () => {
    // p7 shares 'zephyr' with two seeds; p3 answered 0.1 in the first
    // round — below the 0.5 selection bar, above the addition bar — so
    // the round reuses its score instead of asking again. Each part is
    // asked once in total.
    const counter = stubDecide((question) => answered(question.id === 'p3' ? 0.1 : 0.9));
    const candidates = parts(10, {
      p0: 'plain zephyr', p1: 'plain zephyr', p3: 'plain zephyr', p7: 'plain zephyr',
    });
    const result = await pick(candidates, {
      task: 'Recall the plan', decide: counter.decide,
      everyScored: { bar: 0.5 },
      everyRanked: { c: 0.68 }, rare: { share: 0.5 },
    });

    // 'zephyr' is in 4 parts — under the bound of 5 — and pulls p3 and
    // p7. p3 joins on its first-round score, p7 on its new answer.
    expect(timesAsked(counter.calls, 'p7')).toBe(1);
    expect(timesAsked(counter.calls, 'p3')).toBe(1);
    expect(result.record.pick?.rare).toMatchObject({ asked: 1, added: 2 });
    expect(result.selected.map((item) => item.id)).toEqual(['p0', 'p1', 'p2', 'p7', 'p3']);
  });

  it('keeps the reused marker on pulled parts when a cached pick repeats', async () => {
    // p0 selects and shares 'zephyr' (3 of 10 parts, under the 0.5 x 10
    // bound) with the missed p7 and p8, so the round pulls and asks
    // both: p7 clears the addition bar, p8 does not. The repeat serves
    // every answer from the store, and each pulled part's entry must
    // carry the reused marker the cache supplied — selected or not.
    const values = new Map<string, unknown>();
    const store: DecisionStore = {
      get: async (key) => values.get(key),
      set: async (key, value) => { values.set(key, value); },
    };
    const counter = stubDecide((question) =>
      answered(question.id === 'p3' || question.id === 'p8' ? 0.01 : 0.9));
    const candidates = parts(10, { p0: 'plain zephyr', p7: 'plain zephyr', p8: 'plain zephyr' });
    const options = {
      task: 'Recall the plan', decide: counter.decide,
      everyScored: { bar: 0.5 }, everyRanked: { c: 0.68 }, rare: { share: 0.5 },
      cache: { store, deciderId: 'test-decider' },
    };
    const first = await pick(candidates, options);
    expect(first.record.pick?.rare).toMatchObject({ asked: 2, added: 1 });
    expect(first.record.cache).toMatchObject({ asked: 6, reused: 0 });
    counter.calls.length = 0;

    const second = await pick(candidates, options);
    expect(counter.calls).toHaveLength(0);
    expect(second.record.cache).toMatchObject({ asked: 0, reused: 6 });
    expect(second.record.candidates.find((entry) => entry.id === 'p7'))
      .toMatchObject({ status: 'selected', reused: true });
    expect(second.record.candidates.find((entry) => entry.id === 'p8'))
      .toMatchObject({ status: 'rejected', reused: true });
  });

  it('pulls a pool-only part the lane cut dropped, through pickFromSources', async () => {
    // The lane's score curve keeps the steep head (w0-w2); w3-w9 stay
    // in the read's uncut pool as pool-only parts, out of the queue.
    // w9 shares 'zephyr' (in 2 of 10 parts, under the 0.5 x 10 bound)
    // with the selected w0, so the round asks it and it clears the
    // addition bar; the other pool parts stay out of the record.
    const counter = stubDecide(() => answered(0.9));
    const pool = [10, 9, 8, 1, 1, 1, 1, 1, 1, 1].map((score, index) =>
      candidate({ sourceId: 'notes', id: `w${index}`, signals: { score },
        text: index === 0 || index === 9 ? 'plain zephyr' : 'plain' }));
    const source: CandidateSource = {
      id: 'notes', role: 'reference',
      read: async () => ({ status: 'read', complete: true, candidates: pool }),
    };
    const result = await pickFromSources([source], { task: 'Recall the plan' }, {
      task: 'Recall the plan', decide: counter.decide,
      everyScored: { bar: 0.5 },
      rare: { share: 0.5 },
    });

    expect(decidedIds(counter.calls)).toEqual(['w0', 'w1', 'w2', 'w9']);
    expect(result.selected.map((item) => item.id)).toEqual(['w0', 'w1', 'w2', 'w9']);
    expect(result.record.pick?.rare).toMatchObject({
      asked: 1, added: 1,
      pulled: [{ sourceId: 'notes', id: 'w9' }],
    });
    expect(result.record.candidates).toHaveLength(4);
    expect(result.record.candidates.find((entry) => entry.id === 'w9'))
      .toMatchObject({ poolOnly: true, status: 'selected', asked: true, probability: 0.9 });
    expect(result.record.candidates.some((entry) =>
      entry.poolOnly === true && entry.id !== 'w9')).toBe(false);
  });

  it.each([
    [1000, 1, true],
    [500, 0, false],
  ])('scales the rarity bound with N: share 0.02, word in 15 parts, N=%i adds %i', async (count, added, rare) => {
    // 'zephyr' sits in 15 parts: under 0.02 x 1000 = 20 it is rare and
    // pulls the missed part; over 0.02 x 500 = 10 it is not.
    const counter = stubDecide((question) =>
      answered(question.id !== 'p7' && Number(question.id.slice(1)) < 15 ? 0.9 : 0.2));
    const candidates = parts(count, {
      p0: 'plain zephyr', p7: 'plain zephyr',
      ...Object.fromEntries(Array.from({ length: 14 }, (_, index) =>
        [`p${index + 1}`, 'plain zephyr filler'])),
    });
    const result = await pick(candidates, {
      task: 'Recall the plan', decide: counter.decide,
      everyScored: { bar: 0.5 },
      rare: { share: 0.02 },
    });

    expect(result.record.pick?.n).toBe(count);
    expect(result.record.pick?.rare?.added).toBe(added);
    if (rare) expect(result.record.pick?.rare?.words).toContain('zephyr');
    else expect(result.record.pick?.rare?.words).not.toContain('zephyr');
    expect(result.selected.some((item) => item.id === 'p7')).toBe(rare);
  });

  it('refuses an invalid pick option before any decide call', async () => {
    const counter = stubDecide(() => answered(0.9));
    const task = { task: 'Recall the plan', decide: counter.decide };
    await expect(pick(parts(10), { ...task, everyRanked: {} as never })).rejects.toThrow(TypeError);
    await expect(pick(parts(10), { ...task, everyRanked: { c: 0 } })).rejects.toThrow(TypeError);
    await expect(pick(parts(10), { ...task, everyRanked: 0.68 as never }))
      .rejects.toThrow(TypeError);
    await expect(pick(parts(10), { ...task, everyScored: {} as never })).rejects.toThrow(TypeError);
    await expect(pick(parts(10), { ...task, everyScored: false as never })).rejects.toThrow(TypeError);
    await expect(pick(parts(10), { ...task, everyScored: { bar: 2 } })).rejects.toThrow(TypeError);
    await expect(pick(parts(10), { ...task, rare: 1 as never })).rejects.toThrow(TypeError);
    for (const share of [0, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(pick(parts(10), { ...task, rare: { share } }))
        .rejects.toThrow(TypeError);
    }
    for (const bar of [-0.1, 1.5, Number.NaN]) {
      await expect(pick(parts(10), { ...task, rare: { bar } }))
        .rejects.toThrow(TypeError);
    }
    expect(counter.calls).toHaveLength(0);
  });
});
