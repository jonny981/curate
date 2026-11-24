import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  memory, pick, rankedRead,
  type CandidateSource, type MemoryCandidate, type PickAnswer, type PickBatch, type PickDecide,
} from '../src/index.js';
import { jev, type JevCall } from '../src/models.js';
import { modesOf } from './fixtures/modes.js';

afterEach(() => vi.unstubAllGlobals());

/** `count` parts ranked 0..count-1 in one keyword lane, best first: the
 *  fused order is p0, p1, ... */
const ranked = (count: number, text = (i: number) => `text of p${i}`): MemoryCandidate[] =>
  Array.from({ length: count }, (_, i) => ({
    sourceId: 'notes', id: `p${i}`, role: 'reference' as const, title: `p${i}`, text: text(i),
    signals: { score: 0 }, searchRanks: [i],
  }));

/** A decide stand-in that rates each part from `rating` by its id, and
 *  records each batch and how many were open at once. */
function rated(rating: (id: string) => number) {
  const calls: PickBatch[] = [];
  let open = 0;
  let peak = 0;
  const decide: PickDecide = async (batch) => {
    calls.push(batch);
    open += 1;
    peak = Math.max(peak, open);
    await new Promise((resolve) => setTimeout(resolve, 1));
    open -= 1;
    return Object.fromEntries(batch.questions.map((question) =>
      [question.key, { status: 'answered', probability: rating(question.id) } satisfies PickAnswer]));
  };
  return { decide, calls, peak: () => peak };
}

const asked = (calls: readonly PickBatch[]) => calls.flatMap((batch) => batch.questions.map((q) => q.id));
const index = (id: string) => Number(id.slice(1));
/** Two parts a batch: batch n (from 1) holds p(2n-2) and p(2n-1). */
const twoABatch = { maxPerBatch: 2 } as const;
const batchOf = (id: string) => Math.floor(index(id) / 2) + 1;
/** The stop with its default floor and share, judging windows of two
 *  rated parts, so a window is a batch of `twoABatch`; it is off unless
 *  set. */
const on = { stopWhenCold: { parts: 2 } } as const;

describe('the rating stop', () => {
  it('stops on the floor after the first batch once its wave rated a part at the floor, rating only the first wave', async () => {
    // p2, in the first wave's second batch, rates 0.5, at or above the
    // floor, so the stop may fire; every other part rates 0.05, under it.
    const { decide, calls, peak } = rated((id) => (id === 'p2' ? 0.5 : 0.05));
    const picked = await pick(ranked(20), { task: 'recall the plan', decide, ...on, limits: twoABatch });

    // The first wave is two batches, sent at once; the rule fires on the first.
    expect(calls).toHaveLength(2);
    expect(peak()).toBe(2);
    expect(asked(calls)).toEqual(['p0', 'p1', 'p2', 'p3']);
    expect(picked.record.pick!.stopWhenCold).toEqual({
      floor: 0.1, share: 0.2, parts: 2, waves: 1, windows: 1, rated: 4, unread: 16, kept: 4, atFloor: 1, ended: 'cold',
      cold: { window: 1, best: 0.05, bestBefore: 0, under: 'floor' },
    });
    expect(picked.record.levers.stopWhenCold).toEqual({ floor: 0.1, share: 0.2, parts: 2 });
    const unread = picked.record.candidates.filter((entry) => index(entry.id) >= 4);
    expect(unread).toHaveLength(16);
    expect(unread.every((entry) => entry.status === 'unassessed' && entry.reason === 'stopWhenCold')).toBe(true);
    // Each unread part keeps its place in the fused order, counted from 0.
    expect(unread.map((entry) => (entry as { place?: number }).place)).toEqual(Array.from({ length: 16 }, (_, i) => i + 4));
    expect(picked.record.pick!.kept).toBe(4);

    // maxInFlight still bounds the requests open at once inside a wave.
    const one = rated((id) => (id === 'p2' ? 0.5 : 0.05));
    const serial = await pick(ranked(20), { task: 'recall the plan', decide: one.decide,
      ...on, limits: { ...twoABatch, maxInFlight: 1 } });
    expect(one.peak()).toBe(1);
    expect(asked(one.calls)).toEqual(['p0', 'p1', 'p2', 'p3']);
    expect(serial.record.pick!.stopWhenCold).toEqual(picked.record.pick!.stopWhenCold);
  });

  it('stops when a batch\'s best rating falls under a share of the best before it', async () => {
    // Batch bests 0.9, 0.5, then 0.15: over the floor, under 0.2 x 0.9.
    const best = [0.9, 0.5, 0.15, 0.6, 0.6, 0.6];
    const { decide, calls } = rated((id) => (index(id) % 2 === 0 ? best[batchOf(id) - 1]! : 0.01));
    const picked = await pick(ranked(12), { task: 'recall the plan', decide, ...on, limits: twoABatch });

    // Wave 2 holds batches 3 and 4; batch 4 was already sent with it.
    expect(asked(calls)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
    expect(picked.record.pick!.stopWhenCold).toMatchObject({
      waves: 2, windows: 3, rated: 8, unread: 4,
      cold: { window: 3, best: 0.15, bestBefore: 0.9, under: 'share' },
    });
    expect(picked.record.candidates.filter((entry) => entry.status === 'unassessed').map((entry) => entry.id))
      .toEqual(['p8', 'p9', 'p10', 'p11']);
    // The over-read part warm in batch 4 is still kept.
    expect(picked.selected.map((part) => part.id)).toContain('p6');
  });

  it('reads on while each batch holds a warm part, however few', async () => {
    // One warm part in each batch, each over the floor and over 0.2 x
    // the best before it; every other part is cold.
    const warm: Record<string, number> = { p1: 0.9, p2: 0.5, p5: 0.3, p7: 0.2, p8: 0.19 };
    const { decide, calls } = rated((id) => warm[id] ?? 0.001);
    const picked = await pick(ranked(10), { task: 'recall the plan', decide, ...on, limits: twoABatch });

    expect(asked(calls)).toHaveLength(10);
    expect(picked.record.pick!.stopWhenCold).toEqual({
      floor: 0.1, share: 0.2, parts: 2, waves: 3, windows: 5, rated: 10, unread: 0, kept: 5, atFloor: 5, ended: 'order' });
    expect(picked.record.candidates.some((entry) => entry.status === 'unassessed')).toBe(false);
  });

  it('checks a wave\'s batches in order, so a cold batch stops the read even when a later batch of its wave is warm', async () => {
    // Batch 1 warm, batch 2 cold, batch 3 cold, batch 4 warm. A read one
    // batch at a time stops after batch 2; the wave sent batches 1 and
    // 2 together, so nothing past them is read.
    const best = [0.9, 0.05, 0.05, 0.9];
    const { decide, calls } = rated((id) => best[batchOf(id) - 1]!);
    const picked = await pick(ranked(8), { task: 'recall the plan', decide, ...on, limits: twoABatch });
    expect(asked(calls)).toEqual(['p0', 'p1', 'p2', 'p3']);
    expect(picked.record.pick!.stopWhenCold).toMatchObject({ waves: 1, windows: 2, cold: { window: 2, under: 'floor' } });

    // Batch 3 cold, batch 4 warm: both sit in wave 2, which stops at
    // batch 3; batch 4's warm parts were already rated and are kept.
    const later = [0.9, 0.5, 0.05, 0.9, 0.9];
    const second = rated((id) => later[batchOf(id) - 1]!);
    const again = await pick(ranked(10), { task: 'recall the plan', decide: second.decide, ...on, limits: twoABatch });
    expect(asked(second.calls)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
    expect(again.record.pick!.stopWhenCold).toMatchObject({ windows: 3, cold: { window: 3 }, unread: 2 });
    expect(again.selected.map((part) => part.id)).toEqual(expect.arrayContaining(['p6', 'p7']));
  });

  it('does not let a copy of a warm part keep a cold batch reading', async () => {
    // p2 repeats p0's text, so it rides free on p0's answer in batch 2
    // (p2, p3, p4); the batch's own answers are all cold.
    const parts = ranked(10, (i) => (i === 2 ? 'text of p0' : `text of p${i}`));
    const { decide, calls } = rated((id) => (id === 'p0' ? 0.9 : 0.01));
    const picked = await pick(parts, { task: 'recall the plan', decide, ...on, limits: twoABatch });
    expect(asked(calls)).toEqual(['p0', 'p1', 'p3', 'p4']);
    expect(picked.record.pick!.stopWhenCold).toMatchObject({
      windows: 2, rated: 5, unread: 5, cold: { window: 2, best: 0.01, bestBefore: 0.9, under: 'floor' } });
    expect(picked.record.candidates.find((entry) => entry.id === 'p2')).toMatchObject({ status: 'selected', probability: 0.9 });
  });

  it('reads the decision score pick() keeps on, not a raw first answer', async () => {
    // Every first answer is 0.95, outside the band, so the score is the
    // first-only combine: 1 / (1 + e^-(-6 + logit 0.95)) = 0.045, cold.
    // p2's is 0.999, which scores 0.71, at or above the floor.
    const questions = { notes: { bias: 0, first: 'relevant', band: [0.1, 0.9] as const,
      firstOnly: { bias: -6, weight: 1 },
      questions: [
        { key: 'relevant', instructions: 'Is it relevant?', true: 'yes', false: 'no', weight: 1 },
        { key: 'needed', instructions: 'Is it needed?', true: 'yes', false: 'no', weight: 1 },
      ] } };
    const { decide, calls } = rated((id) => (id === 'p2' ? 0.999 : 0.95));
    const picked = await pick(ranked(10), { task: 'recall the plan', decide, ...on, limits: twoABatch,
      modesBySource: modesOf(questions), everyScored: true });
    expect(calls).toHaveLength(2);
    expect(picked.record.pick!.stopWhenCold!.cold).toMatchObject({ window: 1, under: 'floor' });
    expect(picked.record.pick!.stopWhenCold!.cold!.best).toBeCloseTo(0.045, 3);
  });

  it('asks a cascade\'s second question inside the wave that asked its first', async () => {
    // First answers 0.5 sit inside the band, so each part is asked
    // `needed` too; its combine is logit-weighted, warm at 0.5.
    const questions = { notes: { bias: 0, first: 'relevant', band: [0.1, 0.9] as const,
      firstOnly: { bias: 0, weight: 1 },
      questions: [
        { key: 'relevant', instructions: 'Is it relevant?', true: 'yes', false: 'no', weight: 1 },
        { key: 'needed', instructions: 'Is it needed?', true: 'yes', false: 'no', weight: 1 },
      ] } };
    const { decide, calls } = rated(() => 0.5);
    await pick(ranked(8), { task: 'recall the plan', decide, ...on, limits: twoABatch, modesBySource: modesOf(questions) });
    const keys = calls.map((batch) => batch.questions.map((q) => `${q.id}:${q.questionKey}`));
    // Wave 1: two first-round batches, then the second round for their
    // four parts; only then wave 2.
    expect(keys).toEqual([
      ['p0:relevant', 'p1:relevant'], ['p2:relevant', 'p3:relevant'],
      ['p0:needed', 'p1:needed'], ['p2:needed', 'p3:needed'],
      ['p4:relevant', 'p5:relevant'], ['p6:relevant', 'p7:relevant'],
      ['p4:needed', 'p5:needed'], ['p6:needed', 'p7:needed'],
    ]);
  });

  it.each([['unset', {}], ['false', { stopWhenCold: false } as const]])(
    'is off unless set: %s rates the whole fused order at once', async (_name, setting) => {
      const { decide, calls, peak } = rated(() => 0.05);
      const picked = await pick(ranked(20), { task: 'recall the plan', decide, limits: twoABatch, ...setting });
      expect(calls).toHaveLength(10);
      expect(peak()).toBe(10);
      expect(picked.record.candidates.some((entry) => entry.status === 'unassessed')).toBe(false);
      expect(picked.record.levers.stopWhenCold).toBe(false);
      expect(picked.record.pick).not.toHaveProperty('stopWhenCold');
      expect(picked.record.effects.some((entry) => entry.setting === 'stopWhenCold')).toBe(false);
    });

  it('does not stop before the read has kept a part', async () => {
    // Every part scores 0.001, under the keep bar (0.0146), except p13
    // at 0.5 in batch 7. Waves 1 to 3 are cold but keep nothing, so the
    // read goes on; wave 4 keeps p13 and stops at its own cold batch 8.
    const { decide, calls } = rated((id) => (id === 'p13' ? 0.5 : 0.001));
    const picked = await pick(ranked(20), { task: 'recall the plan', decide, ...on, limits: twoABatch });
    expect(asked(calls)).toEqual(Array.from({ length: 16 }, (_, i) => `p${i}`));
    expect(picked.record.pick!.stopWhenCold).toEqual({
      floor: 0.1, share: 0.2, parts: 2, waves: 4, windows: 8, rated: 16, unread: 4, kept: 1, atFloor: 1, ended: 'cold',
      cold: { window: 8, best: 0.001, bestBefore: 0.5, under: 'floor' } });
    expect(picked.selected.map((part) => part.id)).toEqual(['p13']);
  });

  it('does not stop before the read has rated a part at or above the floor: three long notes, the answer third', async () => {
    // Three long notes, each its own batch. The first rates 0.05, over
    // the keep bar (0.0146) and under the floor, so it is kept and its
    // batch is cold; the second rates 0.03. The third holds the answer
    // and rates 0.95: the read must reach it.
    const rating: Record<string, number> = { p0: 0.05, p1: 0.03, p2: 0.95 };
    const { decide, calls } = rated((id) => rating[id]!);
    const picked = await pick(ranked(3, (i) => `note ${i} ${'words of a long note '.repeat(400)}`), {
      task: 'recall the plan', decide, stopWhenCold: { parts: 1 }, limits: { maxBatchChars: 10_000 } });
    expect(calls).toHaveLength(3);
    expect(asked(calls)).toEqual(['p0', 'p1', 'p2']);
    expect(picked.record.pick!.stopWhenCold).toEqual({
      floor: 0.1, share: 0.2, parts: 1, waves: 2, windows: 3, rated: 3, unread: 0, kept: 3, atFloor: 1, ended: 'order' });
    expect(picked.selected.map((part) => part.id)).toContain('p2');
  });

  it('reads the whole order when no part reaches the floor, keeps what the bar keeps, and says why', async () => {
    // Every part rates 0.05: kept, and under the floor. The first wave
    // is cold, but nothing rated reaches the floor, so the read goes on
    // to the end of the order.
    const { decide, calls } = rated(() => 0.05);
    const picked = await pick(ranked(20), { task: 'recall the plan', decide, ...on, limits: twoABatch });
    expect(asked(calls)).toHaveLength(20);
    expect(picked.selected).toHaveLength(20);
    expect(picked.record.candidates.some((entry) => entry.status === 'unassessed')).toBe(false);
    expect(picked.record.pick!.stopWhenCold).toEqual({
      floor: 0.1, share: 0.2, parts: 2, waves: 5, windows: 10, rated: 20, unread: 0, kept: 20, atFloor: 0, ended: 'order' });
    expect(picked.record.effects.find((entry) => entry.setting === 'stopWhenCold')!.summary)
      .toBe('stopWhenCold on notes: no part rated at or above the floor 0.1, so the stop could not fire and '
        + 'the read rated every one of 20 parts in the order.');
  });

  it('can read further with a higher floor: one above every rating reads to the end and says why', async () => {
    // p0 rates 0.2 and every other part 0.05. At a floor of 0.1, p0 is at
    // or above it, so the stop fires at the cold batch 2 after 4 parts.
    // At a floor of 0.3 no part reaches it, so the stop may never fire
    // and the read rates all 20: five times the parts.
    const at = async (floor: number) => {
      const { decide, calls } = rated((id) => (id === 'p0' ? 0.2 : 0.05));
      const picked = await pick(ranked(20), { task: 'recall the plan', decide, limits: twoABatch, stopWhenCold: { floor, parts: 2 } });
      return { picked, asked: asked(calls) };
    };
    const low = await at(0.1);
    expect(low.asked).toHaveLength(4);
    expect(low.picked.record.pick!.stopWhenCold).toMatchObject({
      floor: 0.1, rated: 4, atFloor: 1, ended: 'cold', cold: { window: 2, under: 'floor' } });
    const high = await at(0.3);
    expect(high.asked).toHaveLength(20);
    expect(high.picked.record.pick!.stopWhenCold).toEqual({
      floor: 0.3, share: 0.2, parts: 2, waves: 5, windows: 10, rated: 20, unread: 0, kept: 20, atFloor: 0, ended: 'order' });
    expect(high.picked.record.effects.find((entry) => entry.setting === 'stopWhenCold')!.summary)
      .toBe('stopWhenCold on notes: no part rated at or above the floor 0.3, so the stop could not fire and '
        + 'the read rated every one of 20 parts in the order.');
  });

  it('waits for a part at or above the call\'s own floor', async () => {
    // The first wave rates 0.3: at the default floor, under a floor of
    // 0.5, so it is cold and the stop may not fire yet. p4 rates 0.9 in
    // batch 3; batch 4 rates 0.01 and stops the read.
    const { decide, calls } = rated((id) => (index(id) < 4 ? 0.3 : id === 'p4' ? 0.9 : 0.01));
    const picked = await pick(ranked(12), { task: 'recall the plan', decide, limits: twoABatch,
      stopWhenCold: { floor: 0.5, parts: 2 } });
    expect(asked(calls)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
    expect(picked.record.pick!.stopWhenCold).toEqual({
      floor: 0.5, share: 0.2, parts: 2, waves: 2, windows: 4, rated: 8, unread: 4, kept: 5, atFloor: 1, ended: 'cold',
      cold: { window: 4, best: 0.01, bestBefore: 0.9, under: 'floor' } });
    expect(picked.selected.map((part) => part.id)).toContain('p4');
  });

  it('waits for a part at the size-based bar when everyScored sets one by size', async () => {
    // Every part scores 0.05 but p8 at 0.9; the curve's bar is 0.8 at
    // every size, so only p8 is ever kept and the read must reach it.
    const { decide, calls } = rated((id) => (id === 'p8' ? 0.9 : 0.05));
    const picked = await pick(ranked(10), { task: 'recall the plan', decide, ...on, limits: twoABatch,
      everyScored: { bySize: [[0, 0.8], [100, 0.8]] } });
    expect(asked(calls)).toHaveLength(10);
    expect(picked.selected.map((part) => part.id)).toEqual(['p8']);
    expect(picked.record.pick!.stopWhenCold).toEqual({
      floor: 0.1, share: 0.2, parts: 2, waves: 3, windows: 5, rated: 10, unread: 0, kept: 1, atFloor: 1, ended: 'order' });
  });

  it.each([
    ['the default bar', {}, 4, 10],
    ['everyScored: true', { everyScored: true }, 4, 10],
    ['a source bar', { modesBySource: { notes: { name: 'notes', bar: 0.5, read: rankedRead } } }, 1, 1],
    ['a flat everyScored bar', { everyScored: { bar: 0.8 } }, 1, 1],
    ['an everyScored size curve', { everyScored: { bySize: [[0, 0.8], [100, 0.8]] } }, 1, 1],
    ['a size curve that rises with the parts decided', { everyScored: { bySize: [[0, 0.01], [4, 0.01], [5, 0.8]] } }, 4, 1],
    ['a rule kept at its own bar', { modesBySource: { notes: { name: 'notes', bar: 0.5, read: rankedRead } },
      ruleBarBySource: { notes: 0.5 }, rule: true }, 1, 1],
  ] as const)('keeps the guard, the floor gate and selection on one bar: %s', async (_name, setting, kept, keptWithNoEarlyFloor) => {
    // p8 scores 0.9, a rule 0.9, p1 `early`, every other part 0.05. At
    // 0.3, p1 is at the floor in the first wave, so only the guard can
    // hold the stop; at 0.05, nothing reaches the floor before p8.
    for (const [early, expected] of [[0.3, kept], [0.05, keptWithNoEarlyFloor]] as const) {
      const { rule, ...options } = { rule: false, ...setting };
      const parts = [...ranked(10), ...(rule ? [{ sourceId: 'notes', id: 'r0', role: 'rule' as const,
        title: 'r0', text: 'a rule', signals: { score: 0 } }] : [])];
      const { decide } = rated((id) => (id === 'p8' || id === 'r0' ? 0.9 : id === 'p1' ? early : 0.05));
      const picked = await pick(parts, { task: 'recall the plan', decide, ...on, limits: twoABatch, ...options });
      const stop = picked.record.pick!.stopWhenCold!;
      const read = picked.record.candidates.filter((entry) => entry.role === 'reference'
        && (entry.status === 'selected' || entry.status === 'rejected'));
      const selected = read.filter((entry) => entry.status === 'selected');
      // The guard's count is the selection's: the read references it kept.
      expect(stop.kept).toBe(selected.length);
      expect(stop.kept).toBe(expected);
      // The gate's count is the read references rated at or above the floor.
      expect(stop.atFloor).toBe(read.filter((entry) =>
        (entry.status === 'selected' || entry.status === 'rejected') && entry.probability! >= stop.floor).length);
      // A stop never fires with nothing kept or nothing at the floor, and
      // a read that kept only p8 reached it.
      if (stop.ended === 'cold') {
        expect(stop.kept).toBeGreaterThan(0);
        expect(stop.atFloor).toBeGreaterThan(0);
      }
      if (expected === 1) expect(selected.map((entry) => entry.id)).toEqual(['p8']);
      if (rule) expect(picked.selected.map((part) => part.id)).toContain('r0');
    }
  });

  it('reads the whole order when nothing reaches the keep bar, and says it kept none', async () => {
    const { decide, calls } = rated(() => 0.001);
    const picked = await pick(ranked(10), { task: 'recall the plan', decide, ...on, limits: twoABatch });
    expect(asked(calls)).toHaveLength(10);
    expect(picked.selected).toEqual([]);
    expect(picked.record.pick!.stopWhenCold).toEqual({
      floor: 0.1, share: 0.2, parts: 2, waves: 3, windows: 5, rated: 10, unread: 0, kept: 0, atFloor: 0, ended: 'order' });
    expect(picked.record.effects.find((entry) => entry.setting === 'stopWhenCold')!.summary)
      .toBe('stopWhenCold on notes: no part reached the keep bar, so the read rated every one of 10 parts in the order and kept none.');
  });

  it('keeps every part the stopped read rated at or above the keep bar', async () => {
    // Every first-wave part but p2 scores 0.05: over the keep bar
    // (0.0146), under the floor (0.1); p2 scores 0.5. The read stops
    // after that wave and keeps all four; the text holds them.
    const source: CandidateSource = {
      id: 'notes', role: 'reference',
      read: async () => ({ status: 'read', complete: true, laneCutApplied: true, candidates: ranked(20) }),
    };
    const { decide } = rated((id) => (id === 'p2' ? 0.5 : index(id) < 4 ? 0.05 : 0.9));
    const recalled = await memory({ sources: [source], decide,
      pick: { ...on, limits: twoABatch }, curate: { sentenceCutoff: false } }).recall('recall the plan');
    expect(recalled.picked.record.pick!.stopWhenCold).toMatchObject({ rated: 4, ended: 'cold', cold: { window: 1, under: 'floor' } });
    expect(recalled.picked.selected.map((part) => part.id).sort()).toEqual(['p0', 'p1', 'p2', 'p3']);
    for (const id of ['p0', 'p1', 'p2', 'p3']) expect(recalled.log).toContain(`text of ${id}`);
  });

  it.each([
    ['a batch limit', { limits: { maxPerBatch: 2, maxBatches: 1 } }, 'limits', 2],
    ['a cancellation', { limits: twoABatch, cancelAt: 'p2' }, 'cancelled', 4],
  ] as const)('says when %s, not the ratings or the order, ended the read', async (_name, setup, ended, rated_) => {
    // Ten unique parts all scoring 0.5: the ratings never go cold, so
    // only the dial can end the read early.
    const controller = new AbortController();
    const decide: PickDecide = async (batch) => {
      if ('cancelAt' in setup && batch.questions.some((q) => q.id === setup.cancelAt)) controller.abort();
      return Object.fromEntries(batch.questions.map((q) => [q.key, { status: 'answered', probability: 0.5 } satisfies PickAnswer]));
    };
    const picked = await pick(ranked(10), { task: 'recall the plan', decide, ...on, limits: setup.limits,
      signal: controller.signal });
    expect(picked.record.pick!.stopWhenCold).toEqual({
      // A dial that ends the read leaves its parts unjudged: the ratings did not end it.
      floor: 0.1, share: 0.2, parts: 2, waves: 1, windows: 0, rated: rated_, unread: 10 - rated_, kept: rated_, atFloor: rated_, ended });
    expect(picked.record.candidates.filter((entry) => entry.status === 'unassessed')
      .every((entry) => entry.status === 'unassessed' && entry.reason === ended)).toBe(true);
    expect(picked.record.effects.find((entry) => entry.setting === 'stopWhenCold')!.summary)
      .toBe(`stopWhenCold on notes: a stop (${ended}) ended the read before the ratings went cold or the order ran out, `
        + `so it rated ${rated_} of 10 parts in the order and left ${10 - rated_} unread.`);
  });

  it('says when the time limit ended the read', async () => {
    const decide: PickDecide = async (batch) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return Object.fromEntries(batch.questions.map((q) => [q.key, { status: 'answered', probability: 0.5 } satisfies PickAnswer]));
    };
    const picked = await pick(ranked(10), { task: 'recall the plan', decide, ...on,
      limits: { ...twoABatch, maxElapsedMs: 20 } });
    expect(picked.record.pick!.stopWhenCold).toMatchObject({ windows: 0, rated: 0, unread: 10, ended: 'time' });
    expect(picked.record.pick!.stopWhenCold).not.toHaveProperty('cold');
  });

  it('takes its own floor and share per call', async () => {
    // Batch bests 0.9, 0.3, 0.2: the default share (0.2 x 0.9 = 0.18)
    // reads all three; a share of 0.5 stops at the second.
    const best = [0.9, 0.3, 0.2];
    const { decide, calls } = rated((id) => best[batchOf(id) - 1]!);
    const picked = await pick(ranked(6), { task: 'recall the plan', decide, limits: { maxPerBatch: 2 },
      stopWhenCold: { share: 0.5, parts: 2 } });
    expect(asked(calls)).toEqual(['p0', 'p1', 'p2', 'p3']);
    expect(picked.record.pick!.stopWhenCold).toMatchObject({ floor: 0.1, share: 0.5, cold: { window: 2, under: 'share' } });

    // A floor of 0.5 stops at the second batch.
    const strict = rated((id) => best[batchOf(id) - 1]!);
    const early = await pick(ranked(6), { task: 'recall the plan', decide: strict.decide, limits: twoABatch,
      stopWhenCold: { floor: 0.5, parts: 2 } });
    expect(early.record.pick!.stopWhenCold).toMatchObject({ floor: 0.5, share: 0.2, cold: { window: 2, under: 'floor' } });
  });

  it('stays inside a feed size, and the size\'s cut keeps its own reason', async () => {
    const warm = rated(() => 0.9);
    const bounded = await pick(ranked(20), { task: 'recall the plan', decide: warm.decide, ...on, limits: twoABatch,
      feed: { order: 'combsum', size: 6 } });
    expect(asked(warm.calls)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
    expect(bounded.record.pick!.feed).toEqual({ order: 'combsum', size: 6, unjudged: 14 });
    expect(bounded.record.pick!.stopWhenCold).toMatchObject({ rated: 6, unread: 0 });
    expect(bounded.record.candidates.filter((entry) => entry.status === 'unassessed')
      .every((entry) => entry.reason === 'feed')).toBe(true);

    const cold = rated((id) => (id === 'p2' ? 0.5 : 0.05));
    const stopped = await pick(ranked(20), { task: 'recall the plan', decide: cold.decide, ...on, limits: twoABatch,
      feed: { order: 'combsum', size: 10 } });
    expect(asked(cold.calls)).toEqual(['p0', 'p1', 'p2', 'p3']);
    const reasons = stopped.record.candidates.filter((entry) => entry.status === 'unassessed')
      .map((entry) => entry.status === 'unassessed' ? entry.reason : undefined);
    expect(reasons).toEqual([...Array(6).fill('stopWhenCold'), ...Array(10).fill('feed')]);
  });

  it('keeps working when the service rejects an oversized request inside a wave', async () => {
    // Each part's text names its rating; the service rejects any state
    // over 7,000 characters, so every four-part batch is split in two.
    const best = [0.8, 0.6, 0.05, 0.9, 0.9];
    const parts = ranked(20, (i) => `rating ${best[Math.floor(i / 4)]} of part ${i} ${'x'.repeat(3_000)}`);
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init!.body)) as {
        state: { items: Record<string, { text: string }> };
        questions: Record<string, { instructions: { item: string } }>;
      };
      if (JSON.stringify(body.state).length > 7_000) return new Response('request too large', { status: 400 });
      return Response.json({ answers: Object.fromEntries(Object.entries(body.questions).map(([name, question]) => {
        const item = body.state.items[question.instructions.item.replace(/^items\./, '')]!;
        return [name, { noul: Number(/rating ([\d.]+)/.exec(item.text)![1]) }];
      })) });
    }));
    const calls: JevCall[] = [];
    const decide = jev({ apiKey: 'test-key', onCall: (call) => { calls.push(call); } });
    const picked = await pick(parts, { task: 'recall the plan', decide, stopWhenCold: { parts: 4 }, limits: { maxPerBatch: 4 } });

    expect(calls.some((call) => call.status === 400 && call.splits === 2)).toBe(true);
    expect(picked.record.pick!.stopWhenCold).toMatchObject({
      waves: 2, windows: 3, rated: 16, unread: 4, cold: { window: 3, under: 'floor' } });
    const read = picked.record.candidates.filter((entry) => index(entry.id) < 16);
    expect(read.every((entry) => entry.status === 'selected' || entry.status === 'rejected')).toBe(true);
    expect(picked.record.candidates.filter((entry) => index(entry.id) >= 16)
      .every((entry) => entry.status === 'unassessed' && entry.reason === 'stopWhenCold')).toBe(true);
  });

  it('judges windows of parts, not requests, so a cold request inside a warm window does not stop the read', async () => {
    // Two parts a request; p0 rates 0.9, p4 holds a later answer at 0.5,
    // every other part 0.05. Judged per request, the second request
    // (p2, p3) is cold and the read stops before p4. Judged in windows of
    // four, the first window holds p0 and the second p4, and the read
    // stops only at the third.
    const rating = (id: string) => (id === 'p0' ? 0.9 : id === 'p4' ? 0.5 : 0.05);
    const perRequest = await pick(ranked(20), { task: 'recall the plan', decide: rated(rating).decide, ...on, limits: twoABatch });
    expect(perRequest.selected.map((part) => part.id)).not.toContain('p4');
    const { decide, calls } = rated(rating);
    const windowed = await pick(ranked(20), { task: 'recall the plan', decide, stopWhenCold: { parts: 4 }, limits: twoABatch });
    expect(windowed.selected.map((part) => part.id)).toContain('p4');
    expect(asked(calls)).toEqual(Array.from({ length: 12 }, (_, i) => `p${i}`));
    expect(windowed.record.pick!.stopWhenCold).toMatchObject({ parts: 4, windows: 3, rated: 12, unread: 8, cold: { window: 3, under: 'floor' } });
  });

  it('judges each request alone when every source of the ranked read is in a mode that asks so and the call names no window', async () => {
    // The same ratings as above: p0 0.9, p4 0.5, every other part 0.05.
    const rating = (id: string) => (id === 'p0' ? 0.9 : id === 'p4' ? 0.5 : 0.05);
    const perRequestMode = { notes: { name: 'notes', read: rankedRead, stopWindow: 'request' as const } };
    const { decide, calls } = rated(rating);
    const picked = await pick(ranked(20), { task: 'recall the plan', decide, stopWhenCold: {}, limits: twoABatch,
      modesBySource: perRequestMode });
    // The second request (p2, p3) is cold: the read stops after the first wave, before p4.
    expect(asked(calls)).toEqual(['p0', 'p1', 'p2', 'p3']);
    expect(picked.selected.map((part) => part.id)).not.toContain('p4');
    expect(picked.record.pick!.stopWhenCold).toMatchObject({ parts: 'request', waves: 1, windows: 2, rated: 4, unread: 16,
      cold: { window: 2, best: 0.05, bestBefore: 0.9, under: 'floor' } });

    // A window the call names wins over the mode's.
    const named = await pick(ranked(20), { task: 'recall the plan', decide: rated(rating).decide, stopWhenCold: { parts: 4 },
      limits: twoABatch, modesBySource: perRequestMode });
    expect(named.selected.map((part) => part.id)).toContain('p4');
    expect(named.record.pick!.stopWhenCold).toMatchObject({ parts: 4 });

    // One source of the ranked read in a mode without it: windows of 150 for the whole read.
    const other = ranked(20).map((part, i) => (i % 2 === 1 ? { ...part, sourceId: 'other' } : part));
    const mixed = await pick(other, { task: 'recall the plan', decide: rated(rating).decide, stopWhenCold: {}, limits: twoABatch,
      modesBySource: { ...perRequestMode, other: { name: 'other', read: rankedRead } } });
    expect(mixed.record.pick!.stopWhenCold).toMatchObject({ parts: 150, rated: 20, ended: 'order' });
  });

  it('judges 150 rated parts at a time when the call sets no window', async () => {
    const { decide } = rated((id) => (id === 'p2' ? 0.5 : 0.05));
    const picked = await pick(ranked(20), { task: 'recall the plan', decide, stopWhenCold: {}, limits: twoABatch });
    expect(picked.record.levers.stopWhenCold).toEqual({ floor: 0.1, share: 0.2, parts: 150 });
    // Twenty parts never fill a window, so the read reaches the order's end.
    expect(picked.record.pick!.stopWhenCold).toMatchObject({ parts: 150, windows: 0, rated: 20, unread: 0, ended: 'order' });
  });

  it('rejects a window that is not a whole number of parts', async () => {
    const { decide } = rated(() => 0.5);
    for (const parts of [0, 1.5, -2]) {
      await expect(pick(ranked(3), { task: 't', decide, stopWhenCold: { parts } })).rejects.toThrow('stopWhenCold.parts must be a whole number, 1 or more.');
    }
  });

  it('records what the stop did for each source in the effects', async () => {
    const { decide } = rated((id) => (id === 'p2' ? 0.5 : 0.05));
    const picked = await pick(ranked(20), { task: 'recall the plan', decide, ...on, limits: twoABatch });
    const effect = picked.record.effects.find((entry) => entry.setting === 'stopWhenCold')!;
    expect(effect).toMatchObject({ source: 'notes', actedOn: 20, added: 0, dropped: null });
    expect(effect.summary).toBe('stopWhenCold on notes: the ratings went cold at window 1, whose best rating 0.05 '
      + 'was under the floor 0.1, so the read rated 4 of 20 parts in the order and left 16 unread.');
  });

  it('memory() finishes when only the stop or the feed size left parts unasked', async () => {
    const source: CandidateSource = {
      id: 'notes', role: 'reference',
      read: async () => ({ status: 'read', complete: true, laneCutApplied: true, candidates: ranked(20) }),
    };
    const { decide } = rated((id) => (id === 'p0' ? 0.9 : 0.05));
    const recalled = await memory({ sources: [source], decide,
      pick: { ...on, limits: twoABatch, feed: { order: 'combsum', size: 10 } },
      curate: { sentenceCutoff: false } }).recall('recall the plan');
    const reasons = new Set(recalled.picked.record.candidates.flatMap((entry) =>
      entry.status === 'unassessed' ? [entry.reason] : []));
    expect(reasons).toEqual(new Set(['stopWhenCold', 'feed']));
  });

  it('rejects the removed thoroughness option by name, and a malformed stop, before any decide call', async () => {
    const { decide, calls } = rated(() => 0.9);
    // @ts-expect-error thoroughness is no longer an option
    await expect(pick(ranked(3), { task: 't', decide, thoroughness: 'normal' }))
      .rejects.toThrow('`thoroughness` is not an option; use `stopWhenCold`');
    await expect(pick(ranked(3), { task: 't', decide, stopWhenCold: { floor: 2 } }))
      .rejects.toThrow('stopWhenCold must be false or hold a floor and a share between 0 and 1.');
    await expect(pick(ranked(3), { task: 't', decide, stopWhenCold: true as never }))
      .rejects.toThrow('stopWhenCold must be false or hold a floor and a share between 0 and 1.');
    await expect(pick(ranked(3), { task: 't', decide, stopWhenCold: { cutoff: 0.1 } as never }))
      .rejects.toThrow('`stopWhenCold.cutoff` is not an option');
    await expect(pick(ranked(3), { task: 't', decide, everyRanked: true, stopWhenCold: false }))
      .rejects.toThrow('everyRanked and stopWhenCold cannot both be set');
    expect(calls).toHaveLength(0);
  });
});
