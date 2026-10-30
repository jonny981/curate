import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  LABEL_KINDS,
  THOROUGHNESS,
  pick,
  pickFromSources,
  type CandidateSource,
  type MemoryCandidate,
  type PickAnswer,
  type PickBatch,
  type PickDecide,
} from '../src/index.js';

const uncutPick = { everyRanked: true, everyScored: true, rare: false } as const;

const KIND_KEYS = new Set<string>(LABEL_KINDS.map((kind) => kind.key));

function candidate(overrides: Partial<MemoryCandidate> & Pick<MemoryCandidate, 'sourceId' | 'id'>): MemoryCandidate {
  return {
    role: 'reference',
    title: overrides.id,
    text: `text of ${overrides.sourceId}/${overrides.id}`,
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

const allAnswered = stubDecide(() => answered(0.9));

function parts(count: number): MemoryCandidate[] {
  return Array.from({ length: count }, (_, index) =>
    candidate({ sourceId: 'notes', id: `p${index}`, searchRanks: [index] }));
}

const decidedIds = (calls: PickBatch[]) => calls.flatMap((batch) => batch.questions)
  .filter((question) => !KIND_KEYS.has(question.questionKey ?? ''))
  .map((question) => question.id);

const directories: string[] = [];
function store(): string {
  const directory = mkdtempSync(join(tmpdir(), 'curate-topk-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe('pick scaled top-k', () => {
  it('sends the same parts as a pick without the dial on a history smaller than the depth', async () => {
    const candidates = parts(20);
    const task = 'Recall the plan';
    const baseline = stubDecide(() => answered(0.9));
    const plain = await pick(candidates, { ...uncutPick, task, decide: baseline.decide });
    // The known baseline: every candidate is decided and selected.
    expect(decidedIds(baseline.calls)).toEqual(candidates.map((item) => item.id));
    expect(plain.selected.map((item) => item.id)).toEqual(candidates.map((item) => item.id));
    const absent = await pick(candidates, { ...uncutPick, task, decide: allAnswered.decide, everyRanked: undefined });
    // With `everyRanked` unset the thoroughness lever runs at 'deep'; on
    // a history inside its depth the same parts are decided.
    expect(absent.selected).toEqual(plain.selected);
    expect(absent.record.pick).toEqual({ n: 20, sent: 20, questions: 20, kept: 20,
      thoroughness: { level: 'deep', depth: THOROUGHNESS.deep }, ranking: 'fusion' });
  });

  it.each([
    [50, 0.68, 16],
    [100, 0.68, 27],
    [200, 0.68, 47],
    [500, 0.68, 98],
    [10, 2.17, 10],
  ])('keeps the top round(c × N^0.8) of the keyword ranking: N=%i c=%f keeps %i', async (count, c, kept) => {
    const counter = stubDecide(() => answered(0.9));
    const result = await pick(parts(count), { ...uncutPick, task: 'Recall the plan', decide: counter.decide, everyRanked: { c } });

    expect(decidedIds(counter.calls)).toEqual(parts(kept).map((item) => item.id));
    expect(result.record.pick).toEqual({ n: count, sent: kept, questions: kept, c, kept, ranking: 'keyword' });
    expect(result.selected).toHaveLength(kept);
    const dropped = result.record.candidates.slice(kept);
    expect(dropped).toHaveLength(count - kept);
    expect(dropped.every((entry) => entry.status === 'unassessed' && entry.reason === 'pick')).toBe(true);
  });

  it('counts every reference part toward N, including pool-only parts no lane holds', async () => {
    // A history larger than its admitted ranking: 50 lane members plus
    // 450 pool-only parts. N is the history's 500, so the
    // round(0.68 × 500^0.8) = 98 bound keeps all 50 admitted parts.
    const counter = stubDecide(() => answered(0.9));
    const laneMembers = parts(50);
    const pool = Array.from({ length: 450 }, (_, index) =>
      candidate({ sourceId: 'notes', id: `x${index}`, poolOnly: true }));
    const result = await pick([...laneMembers, ...pool], { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide, everyRanked: { c: 0.68 },
    });

    expect(result.record.pick).toEqual({ n: 500, sent: 50, questions: 50, c: 0.68, kept: 50, ranking: 'keyword' });
    expect(decidedIds(counter.calls)).toEqual(laneMembers.map((item) => item.id));
    expect(result.selected).toHaveLength(50);
    // With the gate off the pool parts only count toward N: they never
    // enter the feed, so the record holds the 50 lane members and no
    // 'limits' entries for parts nothing limited.
    expect(result.record.candidates).toHaveLength(50);
    expect(result.record.candidates.every((entry) =>
      entry.poolOnly !== true && entry.status === 'selected')).toBe(true);
  });

  it('records pool-only parts unassessed when the dial is absent', async () => {
    // A direct caller can pass pool-only parts with no gate and no
    // dial: no lane holds them so they are never asked, but they keep
    // the record they always had — 'unassessed' with reason 'limits'.
    const counter = stubDecide(() => answered(0.9));
    const laneMembers = parts(3);
    const pool = [0, 1].map((index) =>
      candidate({ sourceId: 'notes', id: `x${index}`, poolOnly: true }));
    const result = await pick([...laneMembers, ...pool], { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
    });

    expect(result.record.pick).toEqual({ n: 5, sent: 3, questions: 3, kept: 3, ranking: 'keyword' });
    expect(decidedIds(counter.calls)).toEqual(laneMembers.map((item) => item.id));
    const entries = result.record.candidates.filter((entry) => entry.poolOnly === true);
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.status === 'unassessed' && entry.reason === 'limits')).toBe(true);
  });

  it('passes rules through uncounted and uncut', async () => {
    const counter = stubDecide(() => answered(0.9));
    const rule = candidate({ sourceId: 'notes', id: 'rule-1', role: 'rule' });
    const result = await pick([rule, ...parts(100)], { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide, everyRanked: { c: 0.68 },
    });

    // N counts reference parts only: 100, not 101. The bound keeps 27
    // references; the rule is decided and selected on top of them.
    expect(result.record.pick).toEqual({ n: 100, sent: 28, questions: 28, c: 0.68, kept: 27, ranking: 'keyword' });
    expect(decidedIds(counter.calls)).toEqual(['rule-1', ...parts(27).map((item) => item.id)]);
    expect(result.record.candidates.find((entry) => entry.id === 'rule-1'))
      .toMatchObject({ status: 'selected', asked: true });
    expect(result.record.rulesCoverage).toBe('complete');
  });

  it('reads the source pool through pickFromSources so N is the history size', async () => {
    // The lane cut admits only the steep head of the read. With the
    // dial set the read still carries the whole pool, so N is 120 and
    // its bound decides every admitted part.
    const counter = stubDecide(() => answered(0.9));
    const pool = [10, 9, 8, ...Array.from({ length: 117 }, () => 1)]
      .map((score, index) => candidate({ sourceId: 'notes', id: `w${index}`, signals: { score } }));
    const source: CandidateSource = {
      id: 'notes', role: 'reference',
      read: async () => ({ status: 'read', complete: true, candidates: pool }),
    };
    const result = await pickFromSources([source], { task: 'Recall the plan' },
      { ...uncutPick, task: 'Recall the plan', decide: counter.decide, everyRanked: { c: 0.68 } });

    expect(result.record.pick).toEqual({ n: 120, sent: 3, questions: 3, c: 0.68, kept: 3, ranking: 'keyword' });
    // The 117 pool members count toward N but, with the gate off, stay
    // out of the feed and the record: it holds only the three lane
    // members, all decided and selected — nothing records 'limits'
    // for a part no limit cut.
    expect(result.record.candidates).toHaveLength(3);
    expect(result.record.candidates.every((entry) =>
      entry.status === 'selected' && entry.poolOnly !== true)).toBe(true);
    expect(decidedIds(counter.calls)).toEqual(['w0', 'w1', 'w2']);
  });

  it('keeps noSearchMatch on a nonempty history no keyword search matched', async () => {
    // The pool exists only to count N: with the gate off a keyword
    // miss on a nonempty history still reports the miss, and no pool
    // member reaches the decide step.
    const counter = stubDecide(() => answered(0.9));
    const pool = Array.from({ length: 120 }, (_, index) =>
      candidate({ sourceId: 'notes', id: `w${index}`, signals: { score: 0 } }));
    const source: CandidateSource = {
      id: 'notes', role: 'reference',
      read: async () => ({ status: 'read', complete: true, candidates: pool }),
    };
    const result = await pickFromSources([source], { task: 'Recall the plan' },
      { ...uncutPick, task: 'Recall the plan', decide: counter.decide, everyRanked: { c: 0.68 } });

    const read = result.reads[0]!;
    expect(read).toMatchObject({ status: 'read', noSearchMatch: true });
    if (read.status === 'read') {
      expect(read.candidates).toHaveLength(120);
      expect(read.candidates.every((item) => item.poolOnly === true)).toBe(true);
    }
    expect(result.record.pick).toEqual({ n: 120, sent: 0, questions: 0, c: 0.68, kept: 0, ranking: 'keyword' });
    expect(result.record.candidates).toHaveLength(0);
    expect(counter.calls).toHaveLength(0);
  });

  it('cuts the label gate’s fused order when the gate fused its lane', async () => {
    const directory = store();
    // The task needs 'event'; p3 carries it at 0.9 so the label lane
    // lifts it to second in the fused order: a, p3, b.
    const counter = stubDecide((question) => {
      if (question.questionKey === undefined) return answered(0.9);
      if (question.id === 'question') return answered(question.questionKey === 'event' ? 0.9 : 0.1);
      return answered(question.questionKey === 'event' && question.id === 'p3' ? 0.9 : 0.1);
    });
    const candidates = ['a', 'b', 'p3'].map((id, index) =>
      candidate({ sourceId: 'notes', id, searchRanks: [index] }));
    const result = await pick(candidates, { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      labels: { directory, deciderId: 'test-decider' },
      labelKindsBySource: { notes: LABEL_KINDS },
      everyRanked: { c: 0.68 },
    });

    // 0.68 × 3^0.8 rounds to 2: the fused order's top two are a and p3;
    // the keyword order alone would have kept a and b.
    expect(decidedIds(counter.calls)).toEqual(['a', 'p3']);
    expect(result.record.pick).toEqual({ n: 3, sent: 2, questions: 2, c: 0.68, kept: 2, ranking: 'fusion' });
    expect(result.record.labels!.gate).toBe(3);
    expect(result.record.candidates.find((entry) => entry.id === 'b'))
      .toMatchObject({ status: 'unassessed', reason: 'pick' });
  });

  it('cuts the keyword order when labels are on but no task kind reaches the bar', async () => {
    const directory = store();
    // The task's label answers clear no kind, so the gate never fuses
    // its lane: the dial cuts the keyword order and says so.
    const counter = stubDecide((question) => answered(question.id === 'question' ? 0.1 : 0.9));
    const candidates = ['a', 'b', 'p3'].map((id, index) =>
      candidate({ sourceId: 'notes', id, searchRanks: [index] }));
    const result = await pick(candidates, { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      labels: { directory, deciderId: 'test-decider' },
      labelKindsBySource: { notes: LABEL_KINDS },
      everyRanked: { c: 0.68 },
    });

    expect(result.record.labels).toBeDefined();
    // 0.68 × 3^0.8 rounds to 2 on the keyword order: a and b, not the
    // fused order's a and p3.
    expect(result.record.pick).toEqual({ n: 3, sent: 2, questions: 2, c: 0.68, kept: 2, ranking: 'keyword' });
    expect(decidedIds(counter.calls)).toEqual(['a', 'b']);
    expect(result.record.candidates.find((entry) => entry.id === 'p3'))
      .toMatchObject({ status: 'unassessed', reason: 'pick' });
  });

  it('refuses an invalid c before any decide call', async () => {
    const counter = stubDecide(() => answered(0.9));
    for (const c of [0, -0.5, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      await expect(pick(parts(10), { ...uncutPick,
        task: 'Recall the plan', decide: counter.decide, everyRanked: { c: c as number },
      })).rejects.toThrow(TypeError);
    }
    await expect(pick(parts(10), { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide, everyRanked: 0.68 as never,
    })).rejects.toThrow(TypeError);
    expect(counter.calls).toHaveLength(0);
  });
});
