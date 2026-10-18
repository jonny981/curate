import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LABEL_KINDS,
  pick,
  type MemoryCandidate,
  type PickAnswer,
  type PickBatch,
  type PickDecide,
  type PickLabels,
} from '../src/index.js';

const KIND_KEYS = new Set<string>(LABEL_KINDS.map((kind) => kind.key));

/** Counts label-store file reads open at once: the store's files are
 *  the only readFile calls a pick makes, so `max` is the widest the
 *  reads ever fan out. `storeWrites.fail` makes every store write fail
 *  as a directory the process cannot write would. */
const { storeReads, storeWrites } = vi.hoisted(() => ({
  storeReads: { inFlight: 0, max: 0 },
  storeWrites: { fail: false },
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      storeReads.inFlight += 1;
      storeReads.max = Math.max(storeReads.max, storeReads.inFlight);
      return (actual.readFile(...args) as Promise<unknown>)
        .finally(() => { storeReads.inFlight -= 1; });
    },
    writeFile: (...args: Parameters<typeof actual.writeFile>) => storeWrites.fail
      ? Promise.reject(Object.assign(
        new Error(`EACCES: permission denied, open '${String(args[0])}'`), { code: 'EACCES' }))
      : actual.writeFile(...args),
  };
});

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

interface Counting {
  decide: PickDecide;
  /** Questions the decide port carried, per call. */
  calls: PickBatch[];
  labelQuestions: { id: string; key: string }[];
}

/** A stand-in decider: answers every question and records which label
 *  questions it was asked. `probability` supplies the answer for any
 *  question key — the seven kind keys or 'reference' for relevance —
 *  and `fail` maps a question key to a non-answer status. */
function counting(
  probability: (question: PickBatch['questions'][number]) => number,
  fail: (question: PickBatch['questions'][number]) => PickAnswer | undefined = () => undefined,
): Counting {
  const calls: PickBatch[] = [];
  const labelQuestions: { id: string; key: string }[] = [];
  return {
    calls,
    labelQuestions,
    decide: async (batch) => {
      calls.push(batch);
      for (const question of batch.questions) {
        if (question.questionKey !== undefined && KIND_KEYS.has(question.questionKey)) {
          labelQuestions.push({ id: question.id, key: question.questionKey });
        }
      }
      return Object.fromEntries(batch.questions.map((question) => [
        question.key,
        fail(question) ?? answered(probability(question)),
      ]));
    },
  };
}

const labelOptions = (directory: string, extra: Partial<PickLabels> = {}) => ({
  labels: { directory, deciderId: 'test-decider', ...extra },
});

function threeParts(): MemoryCandidate[] {
  return [
    candidate({ sourceId: 'notes', id: 'p1', searchRanks: [0] }),
    candidate({ sourceId: 'notes', id: 'p2', searchRanks: [1] }),
    candidate({ sourceId: 'notes', id: 'p3', searchRanks: [2] }),
  ];
}

const directories: string[] = [];
function store(): string {
  const directory = mkdtempSync(join(tmpdir(), 'curate-labels-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  storeWrites.fail = false;
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe('pick labels', () => {
  it('labels every part and the task once through the decide port, then asks nothing on a second pick', async () => {
    const directory = store();
    const counter = counting(() => 0.8);
    const options = { task: 'Recall the plan', decide: counter.decide, ...labelOptions(directory) };

    const first = await pick(threeParts(), options);
    // Three parts and the task, seven kinds each.
    expect(counter.labelQuestions).toHaveLength(28);
    expect(new Set(counter.labelQuestions.map((question) => question.id))).toEqual(new Set(['p1', 'p2', 'p3', 'question']));
    expect(new Set(counter.labelQuestions.map((question) => question.key))).toEqual(KIND_KEYS);
    expect(first.record.labels).toEqual({
      questionVersion: 'memory-kind-labels-1',
      deciderId: 'test-decider',
      asked: 4,
      reused: 0,
      gate: 3,
      failedWrites: 0,
    });
    expect(readdirSync(directory)).toHaveLength(4);
    const stored = JSON.parse(readFileSync(join(directory, readdirSync(directory)[0]!), 'utf8'));
    expect(Object.keys(stored.labels).sort()).toEqual([...KIND_KEYS].sort());
    expect(Object.values(stored.labels).every((p) => typeof p === 'number' && p >= 0 && p <= 1)).toBe(true);

    counter.labelQuestions.length = 0;
    const second = await pick(threeParts(), options);
    expect(counter.labelQuestions).toHaveLength(0);
    expect(second.record.labels).toEqual({
      questionVersion: 'memory-kind-labels-1',
      deciderId: 'test-decider',
      asked: 0,
      reused: 4,
      gate: 3,
      failedWrites: 0,
    });
  });

  it('labels a changed part again while unchanged parts and the task are reused', async () => {
    const directory = store();
    const counter = counting(() => 0.8);
    const options = { task: 'Recall the plan', decide: counter.decide, ...labelOptions(directory) };
    await pick(threeParts(), options);

    counter.labelQuestions.length = 0;
    const changed = threeParts();
    changed[1] = candidate({ sourceId: 'notes', id: 'p2', text: 'an edited second part', searchRanks: [1] });
    const result = await pick(changed, options);

    expect(new Set(counter.labelQuestions.map((question) => question.id))).toEqual(new Set(['p2']));
    expect(counter.labelQuestions).toHaveLength(7);
    expect(result.record.labels!.asked).toBe(1);
    expect(result.record.labels!.reused).toBe(3);
  });

  it('labels every part again under a different deciderId or question-set version', async () => {
    const directory = store();
    const counter = counting(() => 0.8);
    const task = 'Recall the plan';
    await pick(threeParts(), { task, decide: counter.decide, ...labelOptions(directory) });

    counter.labelQuestions.length = 0;
    const otherDecider = await pick(threeParts(), {
      task, decide: counter.decide, ...labelOptions(directory, { deciderId: 'other-decider' }),
    });
    expect(counter.labelQuestions).toHaveLength(28);
    expect(otherDecider.record.labels!.asked).toBe(4);

    counter.labelQuestions.length = 0;
    const otherVersion = await pick(threeParts(), {
      task, decide: counter.decide, ...labelOptions(directory, { questionVersion: 'memory-kind-labels-2' }),
    });
    expect(counter.labelQuestions).toHaveLength(28);
    expect(otherVersion.record.labels!.asked).toBe(4);
    expect(otherVersion.record.labels!.questionVersion).toBe('memory-kind-labels-2');
  });

  it('never stores a refused, missing or errored label set and asks it again', async () => {
    const directory = store();
    let failed = true;
    const counter = counting(() => 0.8, (question) =>
      failed && question.id === 'p2' && question.questionKey === 'decision' ? { status: 'refused' } : undefined);
    const options = { task: 'Recall the plan', decide: counter.decide, ...labelOptions(directory) };
    await pick(threeParts(), options);
    expect(readdirSync(directory)).toHaveLength(3);

    counter.labelQuestions.length = 0;
    failed = false;
    const second = await pick(threeParts(), options);
    expect(new Set(counter.labelQuestions.map((question) => question.id))).toEqual(new Set(['p2']));
    expect(second.record.labels!.asked).toBe(1);
    expect(readdirSync(directory)).toHaveLength(4);
  });

  it('treats a missing, corrupt or wrong-shaped store file as a miss', async () => {
    const directory = store();
    const counter = counting(() => 0.8);
    const options = { task: 'Recall the plan', decide: counter.decide, ...labelOptions(directory) };
    await pick(threeParts(), options);
    const files = readdirSync(directory).sort();
    writeFileSync(join(directory, files[0]!), 'not json {');
    writeFileSync(join(directory, files[1]!), JSON.stringify({ labels: { personal: 'yes' } }));
    rmSync(join(directory, files[2]!));

    counter.labelQuestions.length = 0;
    const second = await pick(threeParts(), options);
    expect(counter.labelQuestions).toHaveLength(21);
    expect(second.record.labels!.asked).toBe(3);
    expect(second.record.labels!.reused).toBe(1);
  });

  it('gates the decide step to the union of keyword lanes and the label lane', async () => {
    const directory = store();
    // The task needs 'owns'; p3 carries it at 0.9 but sits past the
    // keyword cut, p2 carries it under the bar, p1 is the keyword hit.
    const counter = counting((question) =>
      question.questionKey === undefined ? 0.9
        : question.id === 'question' ? (question.questionKey === 'owns' ? 0.9 : 0.1)
          : question.questionKey === 'owns' ? (question.id === 'p3' ? 0.9 : 0.2) : 0.1);
    const options = {
      task: 'Recall the plan', decide: counter.decide,
      limits: { maxCandidates: 1 }, ...labelOptions(directory),
    };
    const result = await pick(threeParts(), options);

    const decided = new Set(counter.calls.flatMap((batch) => batch.questions)
      .filter((question) => question.questionKey === undefined)
      .map((question) => question.id));
    expect(decided).toEqual(new Set(['p1', 'p3']));
    expect(result.record.labels!.gate).toBe(2);
    // p2 sat inside the keyword lane past the candidate limit: the
    // limit, not the gate, is why it was never asked.
    expect(result.record.candidates.find((entry) => entry.id === 'p2'))
      .toMatchObject({ status: 'unassessed', reason: 'limits' });
  });

  it('orders the gated feed by reciprocal-rank fusion of the keyword and label orders', async () => {
    const directory = store();
    // p3 is the only in-lane part; it jumps the keyword rank it would
    // have waited behind, but never the top keyword hit.
    const counter = counting((question) =>
      question.questionKey === undefined ? 0.9
        : question.id === 'question' ? (question.questionKey === 'event' ? 0.9 : 0.1)
          : question.questionKey === 'event' ? (question.id === 'p3' ? 0.9 : 0.1) : 0.1);
    const parts = ['a', 'b', 'c'].map((id, index) =>
      candidate({ sourceId: 'notes', id, searchRanks: [index] }));
    parts[2] = candidate({ sourceId: 'notes', id: 'p3', searchRanks: [2] });
    const result = await pick(parts, {
      task: 'Recall the plan', decide: counter.decide, ...labelOptions(directory),
    });
    const decideOrder = counter.calls.flatMap((batch) => batch.questions)
      .filter((question) => question.questionKey === undefined)
      .map((question) => question.id);
    expect(decideOrder).toEqual(['a', 'p3', 'b']);
  });

  it('asks label questions on the full part text and reuses the set at any later text cut', async () => {
    const directory = store();
    // The habit statement sits past the first pick's text cut, so only
    // a full-text label ask can see it. p1 is a pool member no lane
    // kept — only its labels can carry it to the decide step — and p2
    // stays below the bar, labelled but never decided.
    const text = `${'Filler lead-in. '.repeat(20)}The user runs every morning before work.`;
    const p1 = candidate({ sourceId: 'notes', id: 'p1', text, poolOnly: true });
    const p2 = candidate({ sourceId: 'notes', id: 'p2',
      text: `${'Filler lead-in. '.repeat(20)}The user naps on Sundays.`, poolOnly: true });
    const counter = counting((question) =>
      question.questionKey === undefined ? 0.9
        : question.id === 'question' ? (question.questionKey === 'habit' ? 0.9 : 0.1)
          : question.questionKey === 'habit' && question.id === 'p1'
            ? (question.text.includes('runs every morning') ? 0.9 : 0) : 0.1);
    const options = {
      task: 'How often does the user run?', decide: counter.decide,
      ...labelOptions(directory),
    };
    const first = await pick([p1, p2], { ...options, limits: { maxQuestionText: 30 } });
    // The label batch carried the whole text; the rescued part's
    // decision ask kept the 30-character cut, and the part that never
    // reached the decide step records no `truncated` flag.
    const labelAsk = counter.calls.flatMap((batch) => batch.questions)
      .find((question) => question.id === 'p1' && question.questionKey === 'habit');
    expect(labelAsk?.text).toBe(text);
    const decideAsk = counter.calls.flatMap((batch) => batch.questions)
      .find((question) => question.id === 'p1' && question.questionKey === undefined);
    expect(decideAsk?.text).toHaveLength(30);
    expect(first.record.candidates.find((entry) => entry.id === 'p2')?.truncated).toBeUndefined();
    expect(first.selected.map((item) => item.id)).toEqual(['p1']);

    // A second pick with no text cut reuses the stored sets: the part
    // stays in the label lane instead of going undecided.
    const second = await pick([p1, p2], options);
    expect(second.record.labels!.asked).toBe(0);
    expect(second.record.labels!.reused).toBe(3);
    expect(second.selected.map((item) => item.id)).toEqual(['p1']);
  });

  it('batches label asks under the same maxBatchChars bound as decide asks', async () => {
    const directory = store();
    const counter = counting(() => 0.8);
    await pick(threeParts(), {
      task: 'Recall the plan', decide: counter.decide,
      limits: { maxBatchChars: 2000 }, ...labelOptions(directory),
    });
    const labelCalls = counter.calls.filter((batch) =>
      batch.questions.some((question) => question.questionKey !== undefined));
    expect(labelCalls.length).toBe(4);
    expect(labelCalls.every((batch) => batch.questions.length <= 7)).toBe(true);
    expect(labelCalls.filter((batch) => batch.task.startsWith('QUESTION the user asked:'))).toHaveLength(1);
    expect(labelCalls.filter((batch) => batch.task.startsWith('Label short excerpts'))).toHaveLength(3);
  });

  it('reads a large populated store in bounded groups and asks nothing on a second pick', async () => {
    const directory = store();
    const parts = Array.from({ length: 200 }, (_, index) =>
      candidate({ sourceId: 'notes', id: `p${index}`, searchRanks: [index] }));
    const counter = counting(() => 0.8);
    const options = { task: 'Recall the plan', decide: counter.decide, ...labelOptions(directory) };
    await pick(parts, options);
    expect(readdirSync(directory)).toHaveLength(201);

    counter.labelQuestions.length = 0;
    storeReads.max = 0;
    const second = await pick(parts, options);
    expect(counter.labelQuestions).toHaveLength(0);
    expect(second.record.labels).toEqual({
      questionVersion: 'memory-kind-labels-1',
      deciderId: 'test-decider',
      asked: 0,
      reused: 201,
      gate: 200,
      failedWrites: 0,
    });
    // The read fan-out stays under the pick's read group size however
    // many stored files the pool holds.
    expect(storeReads.max).toBeLessThanOrEqual(64);
  });

  it('lets a store read failure that is not a miss surface instead of relabelling', async () => {
    const file = join(store(), 'blocked');
    writeFileSync(file, 'a file where the store directory should be');
    await expect(pick(threeParts(), {
      task: 'Recall the plan', decide: counting(() => 0.8).decide,
      ...labelOptions(file),
    })).rejects.toThrow();
  });

  it('keeps the answers when the store cannot write, counts each failed write and warns once', async () => {
    const directory = store();
    storeWrites.fail = true;
    // p3 is a pool part no keyword lane holds: only its unstored labels
    // can carry it to the decide step.
    const counter = counting((question) =>
      question.questionKey === undefined ? 0.9
        : question.id === 'question' ? (question.questionKey === 'owns' ? 0.9 : 0.1)
          : question.questionKey === 'owns' ? (question.id === 'p3' ? 0.9 : 0.1) : 0.1);
    const parts = [
      candidate({ sourceId: 'notes', id: 'p1', searchRanks: [0] }),
      candidate({ sourceId: 'notes', id: 'p2', searchRanks: [1] }),
      candidate({ sourceId: 'notes', id: 'p3', poolOnly: true }),
    ];
    const options = { task: 'Recall the plan', decide: counter.decide, ...labelOptions(directory) };
    const first = await pick(parts, options);
    expect(new Set(first.selected.map((item) => item.id))).toEqual(new Set(['p1', 'p2', 'p3']));
    expect(first.record.labels).toMatchObject({ asked: 4, reused: 0, gate: 3, failedWrites: 4 });
    expect(first.record.labels!.warning).toMatch(/^4 label set\(s\) could not be stored \(EACCES: permission denied/);
    expect(readdirSync(directory)).toHaveLength(0);

    // Nothing was stored, so the next pick asks every set again.
    counter.labelQuestions.length = 0;
    const second = await pick(parts, options);
    expect(counter.labelQuestions).toHaveLength(28);
    expect(second.record.labels!.failedWrites).toBe(4);
  });

  it('decides every gated part after labelling when no limits are set', async () => {
    const directory = store();
    // 100 parts take five label batches at the default 150 questions a
    // batch, and the task one more. No batch or time limit is set, so
    // those batches spend nothing the decide step needs.
    const parts = Array.from({ length: 100 }, (_, index) =>
      candidate({ sourceId: 'notes', id: `p${index}`, searchRanks: [index] }));
    const counter = counting(() => 0.8);
    const result = await pick(parts, {
      task: 'Recall the plan', decide: counter.decide, ...labelOptions(directory),
    });
    const isLabelCall = (batch: PickBatch) =>
      batch.questions.some((question) => KIND_KEYS.has(question.questionKey ?? ''));
    const labelCalls = counter.calls.filter(isLabelCall);
    expect(labelCalls).toHaveLength(6);
    const firstDecideCall = counter.calls.findIndex((batch) => !isLabelCall(batch));
    expect(firstDecideCall).toBeGreaterThan(counter.calls.lastIndexOf(labelCalls.at(-1)!));
    const decided = new Set(counter.calls.flatMap((batch) => batch.questions)
      .filter((question) => question.questionKey === undefined)
      .map((question) => question.id));
    expect(decided.size).toBe(100);
    expect(result.record.candidates.filter((entry) => entry.status === 'unassessed')).toHaveLength(0);
    expect(result.selected).toHaveLength(100);
  });

  it('records parts the gate left out as unassessed by the gate, not a limit', async () => {
    const directory = store();
    // No limits are set: p3 is a pool part no keyword lane holds and
    // the task needs no kind it carries, so the gate alone excludes it.
    const counter = counting((question) =>
      question.questionKey === undefined ? 0.9
        : question.id === 'question' ? (question.questionKey === 'owns' ? 0.9 : 0.1)
          : question.questionKey === 'owns' ? (question.id === 'p2' ? 0.9 : 0.1) : 0.1);
    const parts = [
      candidate({ sourceId: 'notes', id: 'p1', searchRanks: [0] }),
      candidate({ sourceId: 'notes', id: 'p2', searchRanks: [1] }),
      candidate({ sourceId: 'notes', id: 'p3', poolOnly: true }),
    ];
    const result = await pick(parts, {
      task: 'Recall the plan', decide: counter.decide, ...labelOptions(directory),
    });
    expect(result.record.labels!.gate).toBe(2);
    expect(result.record.candidates.find((entry) => entry.id === 'p3'))
      .toMatchObject({ status: 'unassessed', reason: 'gate' });
    expect(result.selected.map((item) => item.id)).toEqual(['p1', 'p2']);
  });

  it('leaves the pick identical when the label option is unset', async () => {
    const counter = counting(() => 0.8);
    const parts = threeParts();
    const plain = await pick(parts, { task: 'Recall the plan', decide: counter.decide });
    expect(plain.record.labels).toBeUndefined();
    expect(counter.labelQuestions).toHaveLength(0);

    // Every label answers under the bar, so no part joins the lane and
    // the gate is the keyword lanes alone: identical output to plain.
    const gated = await pick(parts, {
      task: 'Recall the plan',
      decide: counting((question) => question.questionKey === undefined ? 0.8 : 0.1).decide,
      ...labelOptions(store()),
    });
    const { labels: _labels, ...record } = gated.record;
    expect(record).toEqual(plain.record);
    expect(gated.selected).toEqual(plain.selected);
  });
});
