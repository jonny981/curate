import { describe, expect, it } from 'vitest';

import {
  THOROUGHNESS, pick,
  type MemoryCandidate, type PickAnswer, type PickBatch, type PickDecide,
} from '../src/index.js';

function part(id: string, searchRanks: readonly (number | null)[], overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    sourceId: 'orchard', id, role: 'reference', title: id, text: `text of ${id}`,
    signals: { score: 0 }, searchRanks, ...overrides,
  };
}

function stubDecide(): { decide: PickDecide; calls: PickBatch[] } {
  const calls: PickBatch[] = [];
  return {
    calls,
    decide: async (batch) => {
      calls.push(batch);
      return Object.fromEntries(batch.questions.map((question) =>
        [question.key, { status: 'answered', probability: 0.9 } satisfies PickAnswer]));
    },
  };
}

const asked = (calls: readonly PickBatch[]) => [...new Set(calls.flatMap((batch) => batch.questions.map((q) => q.id)))];

// Two keyword lanes. `alone` tops lane 0 and is in no other lane;
// `second` and `third` sit lower in lane 0 but both lanes hold them.
//   best place:  alone 1, third 1, second 0.75, last 0.33
//   summed place: third 1.5, second 1.42, alone 1, last 0.58
const ALONE = part('alone', [0, null]);
const SECOND = part('second', [1, 1]);
const THIRD = part('third', [2, 0]);
const LAST = part('last', [3, 2]);
const PARTS = [ALONE, SECOND, THIRD, LAST];

describe('feed', () => {
  it('feeds by the sum of lane places, so parts two lanes agree on come before a part one lane placed first', async () => {
    const shipped = stubDecide();
    await pick(PARTS, { task: 'recall the plan', decide: shipped.decide });
    expect(asked(shipped.calls).slice(0, 2)).toEqual(['alone', 'third']);

    const { decide, calls } = stubDecide();
    const picked = await pick(PARTS, { task: 'recall the plan', decide, feed: { order: 'combsum', size: 2 } });
    expect(asked(calls)).toEqual(['third', 'second']);
    const status = (id: string) => picked.record.candidates.find((entry) => entry.id === id);
    expect(status('alone')).toMatchObject({ status: 'unassessed', reason: 'thoroughness' });
    expect(status('last')).toMatchObject({ status: 'unassessed', reason: 'thoroughness' });
  });

  it('places a part one lane holds by that lane alone', async () => {
    const { decide, calls } = stubDecide();
    await pick(PARTS, { task: 'recall the plan', decide, feed: { order: 'combsum', size: 3 } });
    expect(asked(calls)).toEqual(['third', 'second', 'alone']);
  });

  it('keeps the default order between parts whose sums are equal', async () => {
    const left = part('left', [0, null]);
    const right = part('right', [null, 0]);
    for (const parts of [[left, right], [right, left]]) {
      const shipped = stubDecide();
      await pick(parts, { task: 'recall the plan', decide: shipped.decide });
      const { decide, calls } = stubDecide();
      await pick(parts, { task: 'recall the plan', decide, feed: { order: 'combsum', size: 1 } });
      expect(asked(calls)).toEqual(asked(shipped.calls).slice(0, 1));
    }
  });

  it('reads a meaning lane by the part\'s place among its own source, and leaves a names lane out', async () => {
    // Lane 0 is a meaning lane, lane 1 a names lane, lane 2 a keyword lane.
    const near = part('near', [0, null, 1]);
    const far = part('far', [1, null, 2]);
    const named = part('named', [2, 0, 0]);
    const reads = { orchard: { lanes: ['meaning', 'names', 'task'], wholeLanes: false } } as never;
    const { decide, calls } = stubDecide();
    await pick([near, far, named], {
      task: 'recall the plan', decide, readsBySource: reads, feed: { order: 'combsum', size: 2 } });
    // near 1 + 2/3, named 1/3 + 1, far 2/3 + 1/3. Counting the names
    // lane would put `named` first.
    expect(asked(calls)).toEqual(['near', 'named']);
  });

  it('never displaces a rule', async () => {
    const rule = part('water-at-dawn', [3, null], { role: 'rule' });
    const { decide, calls } = stubDecide();
    const picked = await pick([...PARTS, rule], { task: 'recall the plan', decide, feed: { order: 'combsum', size: 1 } });
    expect(asked(calls)).toContain('water-at-dawn');
    expect(asked(calls).filter((id) => id !== 'water-at-dawn')).toEqual(['third']);
    expect(picked.record.candidates.find((entry) => entry.id === 'water-at-dawn')!.status).not.toBe('unassessed');
  });

  it('records the order, the size and how many ranked parts the size left unjudged', async () => {
    const { decide } = stubDecide();
    const picked = await pick(PARTS, { task: 'recall the plan', decide, feed: { order: 'combsum', size: 3 } });
    expect(picked.record.pick!.feed).toEqual({ order: 'combsum', size: 3, unjudged: 1 });
    expect(picked.record.pick!.thoroughness).toEqual({ level: 'normal', depth: 3 });
    expect(picked.record.pick!.sent).toBe(3);
    const effect = picked.record.effects.find((entry) => entry.setting === 'thoroughness')!;
    expect(effect.summary).toContain('the feed size of 3 parts kept 3 of 4 ranked parts and left 1 undecided');
  });

  it('with no size, keeps the level\'s depth and records the order alone', async () => {
    const { decide, calls } = stubDecide();
    const picked = await pick(PARTS, { task: 'recall the plan', decide, thoroughness: 'quick', feed: { order: 'combsum' } });
    expect(asked(calls)).toEqual(['third', 'second', 'alone', 'last']);
    expect(picked.record.pick!.feed).toEqual({ order: 'combsum', unjudged: 0 });
    expect(picked.record.pick!.thoroughness).toEqual({ level: 'quick', depth: THOROUGHNESS.quick });
  });

  it('lets the size stand in place of the level\'s depth, smaller or larger', async () => {
    const small = stubDecide();
    await pick(PARTS, { task: 'recall the plan', decide: small.decide, thoroughness: 'normal', feed: { order: 'combsum', size: 2 } });
    expect(asked(small.calls)).toHaveLength(2);

    const many = Array.from({ length: THOROUGHNESS.quick + 10 }, (_, index) => part(`p${index}`, [index]));
    const large = stubDecide();
    const picked = await pick(many, {
      task: 'recall the plan', decide: large.decide, thoroughness: 'quick', feed: { order: 'combsum', size: THOROUGHNESS.quick + 5 } });
    expect(picked.record.pick!.sent).toBe(THOROUGHNESS.quick + 5);
    expect(picked.record.pick!.feed).toEqual({ order: 'combsum', size: THOROUGHNESS.quick + 5, unjudged: 5 });
  });

  it('leaves the record without a feed entry when the option is not given', async () => {
    const { decide } = stubDecide();
    const picked = await pick(PARTS, { task: 'recall the plan', decide });
    expect(picked.record.pick).not.toHaveProperty('feed');
  });

  it.each([
    [{ order: 'rrf' }, "feed.order must be 'combsum'."],
    [{ size: 2 }, "feed.order must be 'combsum'."],
    [{ order: 'combsum', size: 0 }, 'feed.size must be a positive integer.'],
    [{ order: 'combsum', size: 1.5 }, 'feed.size must be a positive integer.'],
    [{ order: 'combsum', size: '3' }, 'feed.size must be a positive integer.'],
    [{ order: 'combsum', depth: 3 }, 'depth'],
  ])('rejects %j before any decide call', async (feed, message) => {
    const { decide, calls } = stubDecide();
    await expect(pick(PARTS, { task: 'recall the plan', decide, feed: feed as never })).rejects.toThrow(message);
    expect(calls).toHaveLength(0);
  });

  it('cannot combine with everyRanked, which has no fused feed to order', async () => {
    const { decide, calls } = stubDecide();
    await expect(pick(PARTS, { task: 'recall the plan', decide, everyRanked: true, feed: { order: 'combsum' } }))
      .rejects.toThrow('feed and everyRanked cannot both be set');
    expect(calls).toHaveLength(0);
  });
});
