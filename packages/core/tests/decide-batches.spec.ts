import { describe, expect, it, vi } from 'vitest';
import { pick, type MemoryCandidate, type PickAnswer, type PickBatch } from '../src/pick.js';

const uncutPick = { everyRanked: true, everyScored: true, rare: false } as const;

function part(index: number, text: string): MemoryCandidate {
  return {
    sourceId: 'notes', id: `part-${index}`, role: 'reference',
    title: `Part ${index}`, text, signals: { keyword: 1 },
  };
}

const answerAll = (batch: PickBatch, probability = 0.8): Record<string, PickAnswer> =>
  Object.fromEntries(batch.questions.map((question) => [question.key, { status: 'answered' as const, probability }]));

describe('independent decision batches of one round', () => {
  it('go out at once and apply their replies in dispatch order', async () => {
    const started: PickBatch[] = [];
    const gates: (() => void)[] = [];
    const decide = vi.fn((batch: PickBatch) => {
      started.push(batch);
      return new Promise<Record<string, PickAnswer>>((resolve) => {
        gates.push(() => resolve(answerAll(batch)));
      });
    });
    const promise = pick(Array.from({ length: 8 }, (_, index) => part(index, `text ${index}`)), {
      ...uncutPick, task: 'notes?', decide, limits: { maxPerBatch: 4 } });
    await vi.waitFor(() => expect(started).toHaveLength(2));
    // The second batch went out while the first was still open.
    gates[1]!();
    gates[0]!();
    const picked = await promise;
    expect(picked.selected).toHaveLength(8);
    const answered = picked.record.candidates.filter((entry) => entry.status === 'selected');
    expect(answered).toHaveLength(8);
    expect(answered.map((entry) => entry.id)).toEqual(Array.from({ length: 8 }, (_, index) => `part-${index}`));
    // A serialized decider sees the same batches and produces the same
    // selection and candidate record.
    const serialized: PickBatch[] = [];
    let chain: Promise<Record<string, PickAnswer>> | undefined;
    const sequential = (batch: PickBatch) => {
      serialized.push(batch);
      const send = (chain ?? Promise.resolve()).then(() => answerAll(batch));
      chain = send;
      return send;
    };
    const pickedSeq = await pick(Array.from({ length: 8 }, (_, index) => part(index, `text ${index}`)), {
      ...uncutPick, task: 'notes?', decide: sequential, limits: { maxPerBatch: 4 } });
    const timing = (value: unknown) => JSON.parse(JSON.stringify(value,
      (key, v) => (key === 'ms' || key === 'timings' ? undefined : v)));
    expect(serialized.map((batch) => batch.questions.map((question) => question.key)))
      .toEqual(started.map((batch) => batch.questions.map((question) => question.key)));
    expect(timing(pickedSeq.record.candidates)).toEqual(timing(picked.record.candidates));
    expect(pickedSeq.selected.map((candidate) => candidate.id))
      .toEqual(picked.selected.map((candidate) => candidate.id));
  });

  it('holds at most maxInFlight requests open, keeping the default\'s requests, answers and selection', async () => {
    let open = 0;
    let peak = 0;
    const started: PickBatch[] = [];
    const decide = vi.fn(async (batch: PickBatch) => {
      started.push(batch);
      open += 1;
      peak = Math.max(peak, open);
      await new Promise((resolve) => { setTimeout(resolve, 10); });
      open -= 1;
      return answerAll(batch);
    });
    const candidates = () => Array.from({ length: 16 }, (_, index) => part(index, `text ${index}`));
    const picked = await pick(candidates(), {
      ...uncutPick, task: 'notes?', decide, limits: { maxPerBatch: 4, maxInFlight: 2 } });
    expect(peak).toBe(2);
    expect(started).toHaveLength(4);
    expect(picked.selected).toHaveLength(16);
    // The unbounded default asks the same batches and reaches the same
    // answers and selection.
    const unbounded: PickBatch[] = [];
    const pickedDefault = await pick(candidates(), {
      ...uncutPick, task: 'notes?',
      decide: (batch: PickBatch) => { unbounded.push(batch); return Promise.resolve(answerAll(batch)); },
      limits: { maxPerBatch: 4 } });
    const timing = (value: unknown) => JSON.parse(JSON.stringify(value,
      (key, v) => (key === 'ms' || key === 'timings' ? undefined : v)));
    expect(started.map((batch) => batch.questions.map((question) => question.key)))
      .toEqual(unbounded.map((batch) => batch.questions.map((question) => question.key)));
    expect(timing(picked.record.candidates)).toEqual(timing(pickedDefault.record.candidates));
    expect(picked.selected.map((candidate) => candidate.id))
      .toEqual(pickedDefault.selected.map((candidate) => candidate.id));
  });

  it('keeps a later batch\'s real answers when an earlier batch is rejected', async () => {
    let count = 0;
    const decide = vi.fn(async (batch: PickBatch) => {
      count += 1;
      if (count === 1) throw new Error('service down');
      return answerAll(batch);
    });
    const promise = pick(Array.from({ length: 6 }, (_, index) => part(index, `text ${index}`)), {
      ...uncutPick, task: 'notes?', decide, limits: { maxPerBatch: 2 } });
    await expect(promise).rejects.toThrow('service down');
    expect(decide).toHaveBeenCalledTimes(3);
  });

  it('starts no queued batch after a batch fails under a maxInFlight cap', async () => {
    const decide = vi.fn(async (batch: PickBatch) => {
      if (decide.mock.calls.length === 1) throw new Error('service down');
      return answerAll(batch);
    });
    const promise = pick(Array.from({ length: 8 }, (_, index) => part(index, `text ${index}`)), {
      ...uncutPick, task: 'notes?', decide, limits: { maxPerBatch: 2, maxInFlight: 1 } });
    await expect(promise).rejects.toThrow('service down');
    // Only the failed batch was ever dispatched; the three behind it
    // stayed queued, as they would in a sequential run that stopped.
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('still settles a batch in flight when a sibling batch fails', async () => {
    let calls = 0;
    let secondFinished = false;
    const decide = vi.fn(async (batch: PickBatch) => {
      calls += 1;
      if (calls === 1) throw new Error('service down');
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      secondFinished = true;
      return answerAll(batch);
    });
    const promise = pick(Array.from({ length: 8 }, (_, index) => part(index, `text ${index}`)), {
      ...uncutPick, task: 'notes?', decide, limits: { maxPerBatch: 2, maxInFlight: 2 } });
    await expect(promise).rejects.toThrow('service down');
    // The batch in flight when the first failed ran to its end; the
    // two queued behind it never started.
    expect(decide).toHaveBeenCalledTimes(2);
    expect(secondFinished).toBe(true);
  });
});
