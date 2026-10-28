import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  LABEL_KINDS,
  decisionFileStore,
  pick,
  type DecisionStore,
  type MemoryCandidate,
  type PickAnswer,
  type PickBatch,
  type PickCascade,
  type PickDecide,
} from '../src/index.js';

const uncutPick = { everyRanked: true, everyScored: true, rare: false } as const;

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
const allAnswered = (batch: PickBatch, probability: number) =>
  Object.fromEntries(batch.questions.map((question) => [question.key, answered(probability)]));

/** A stand-in decider counting every batch it was asked. */
function counting(probability = 0.9): { decide: PickDecide; calls: PickBatch[] } {
  const calls: PickBatch[] = [];
  return {
    calls,
    decide: async (batch) => {
      calls.push(batch);
      return allAnswered(batch, probability);
    },
  };
}

/** A store counting its reads and writes over an in-memory map. */
function countingStore(): {
  store: DecisionStore; gets: number; sets: number;
  values: Map<string, unknown>; failWrites: boolean;
} {
  const values = new Map<string, unknown>();
  const counted = { gets: 0, sets: 0, failWrites: false };
  return {
    ...counted,
    get gets() { return counted.gets; },
    get sets() { return counted.sets; },
    get failWrites() { return counted.failWrites; },
    set failWrites(fail: boolean) { counted.failWrites = fail; },
    values,
    store: {
      get: async (key) => { counted.gets += 1; return values.get(key); },
      set: async (key, value) => {
        counted.sets += 1;
        if (counted.failWrites) throw new Error('the store is read-only');
        values.set(key, value);
      },
    },
  };
}

const directories: string[] = [];
function storeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'curate-decisions-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

const fitted: PickCascade = {
  bias: -1.7,
  first: 'relevant',
  band: [0.1, 0.9],
  firstOnly: { bias: -0.7, weight: 1.3 },
  questions: [
    { key: 'relevant', instructions: 'Relevant?', true: 'yes', false: 'no', weight: 0.7 },
    { key: 'own', instructions: 'Own life?', true: 'yes', false: 'no', weight: 0.8 },
    { key: 'needed', instructions: 'Needed?', true: 'yes', false: 'no', weight: 0.8 },
  ],
};

function threeParts(): MemoryCandidate[] {
  return [
    candidate({ sourceId: 'notes', id: 'p1' }),
    candidate({ sourceId: 'notes', id: 'p2' }),
    candidate({ sourceId: 'notes', id: 'p3' }),
  ];
}

describe('pick decision cache', () => {
  it('reuses a stored answer across batches: a second identical pick makes zero decider calls', async () => {
    const directory = storeDirectory();
    const counter = counting();
    const options = { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      cache: { store: decisionFileStore(directory), deciderId: 'test-decider' },
    };
    const first = await pick(threeParts(), options);
    const asked = counter.calls.flatMap((batch) => batch.questions).length;
    expect(asked).toBe(3);
    expect(readdirSync(directory)).toHaveLength(3);
    expect(first.record.cache).toEqual({
      questionVersion: 'memory-pick-questions-1', deciderId: 'test-decider',
      asked: 3, reused: 0, failedWrites: 0,
    });

    counter.calls.length = 0;
    const second = await pick(threeParts(), options);
    expect(counter.calls).toHaveLength(0);
    expect(second.selected.map((item) => item.id)).toEqual(first.selected.map((item) => item.id));
    expect(second.record.cache).toEqual({
      questionVersion: 'memory-pick-questions-1', deciderId: 'test-decider',
      asked: 0, reused: 3, failedWrites: 0,
    });
    expect(second.record.candidates.every((entry) =>
      entry.status === 'selected' && entry.reused === true)).toBe(true);
  });

  it('keeps the truncated flag on a reused answer', async () => {
    const directory = storeDirectory();
    // A decider marking every answer truncated, the way jev() marks an
    // item whose evidence text it had to halve for the model to take it.
    const decide: PickDecide = async (batch) => Object.fromEntries(batch.questions.map(
      (question) => [question.key, { status: 'answered' as const, probability: 0.9, truncated: true }]));
    const options = { ...uncutPick,
      task: 'Recall the plan', decide,
      questionsBySource: { notes: {
        bias: 0,
        questions: [{ key: 'relevant', instructions: 'Relevant?', true: 'yes', false: 'no', weight: 1 }],
      } },
      cache: { store: decisionFileStore(directory), deciderId: 'test-decider' },
    };
    const first = await pick(threeParts(), options);
    expect(first.record.candidates.every((entry) =>
      entry.questions?.[0]?.truncated === true)).toBe(true);

    const second = await pick(threeParts(), options);
    expect(second.record.cache).toMatchObject({ asked: 0, reused: 3 });
    expect(second.record.candidates.every((entry) =>
      entry.questions?.every((question) => question.truncated === true && question.reused === true)))
      .toBe(true);
  });

  it('asks only the new part when a later pick gains a neighbour in the same batch', async () => {
    const directory = storeDirectory();
    const counter = counting();
    const options = { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      cache: { store: decisionFileStore(directory), deciderId: 'test-decider' },
    };
    await pick(threeParts().slice(0, 2), options);
    counter.calls.length = 0;
    const second = await pick(threeParts(), options);
    expect(counter.calls.flatMap((batch) => batch.questions.map((question) => question.id)))
      .toEqual(['p3']);
    expect(second.record.cache).toMatchObject({ asked: 1, reused: 2 });
  });

  it('asks only the added part when a kind part joins a cached pick of plain parts', async () => {
    const counter = counting();
    const options = { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      cache: { store: countingStore().store, deciderId: 'test-decider' },
    };
    await pick(threeParts().slice(0, 2), options);
    counter.calls.length = 0;
    const mixed = [
      ...threeParts().slice(0, 2),
      candidate({ sourceId: 'notes', id: 'p3', kind: 'knowledge' }),
    ];
    const second = await pick(mixed, options);
    // The pick's question-set version moves to 2 with a kind present,
    // but the key's version is the constant: p1 and p2 hit their stored
    // answers, and only the new part is asked.
    expect(second.record.questionVersion).toBe('memory-pick-questions-2');
    expect(second.record.cache).toMatchObject({
      questionVersion: 'memory-pick-questions-1', asked: 1, reused: 2,
    });
    expect(counter.calls.flatMap((batch) => batch.questions.map((question) => question.id)))
      .toEqual(['p3']);
  });

  it('asks every part again for a changed task', async () => {
    const counted = countingStore();
    const counter = counting();
    const options = { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      cache: { store: counted.store, deciderId: 'test-decider' },
    };
    await pick(threeParts(), options);
    counter.calls.length = 0;
    const second = await pick(threeParts(), { ...options, task: 'A different task' });
    expect(counter.calls.flatMap((batch) => batch.questions)).toHaveLength(3);
    expect(second.record.cache).toMatchObject({ asked: 3, reused: 0 });
  });

  it('asks every part again for a changed question-set version', async () => {
    const counted = countingStore();
    const counter = counting();
    const options = { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      cache: { store: counted.store, deciderId: 'test-decider' },
    };
    await pick(threeParts(), options);
    counter.calls.length = 0;
    const second = await pick(threeParts(), {
      ...options, cache: { ...options.cache, questionVersion: 'memory-pick-questions-9' },
    });
    expect(counter.calls.flatMap((batch) => batch.questions)).toHaveLength(3);
    expect(second.record.cache).toMatchObject({
      asked: 3, reused: 0, questionVersion: 'memory-pick-questions-9',
    });
  });

  it('asks every part again under a different deciderId', async () => {
    const counted = countingStore();
    const counter = counting();
    const options = { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      cache: { store: counted.store, deciderId: 'test-decider' },
    };
    await pick(threeParts(), options);
    counter.calls.length = 0;
    const second = await pick(threeParts(), {
      ...options, cache: { ...options.cache, deciderId: 'other-decider' },
    });
    expect(counter.calls.flatMap((batch) => batch.questions)).toHaveLength(3);
    expect(second.record.cache).toMatchObject({ asked: 3, reused: 0, deciderId: 'other-decider' });
  });

  it('asks again for that part only when its title changes', async () => {
    const counter = counting();
    const options = { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      cache: { store: countingStore().store, deciderId: 'test-decider' },
    };
    await pick(threeParts(), options);
    counter.calls.length = 0;
    const changed = threeParts();
    changed[1] = candidate({ sourceId: 'notes', id: 'p2', title: 'a new title' });
    const second = await pick(changed, options);
    expect(counter.calls.flatMap((batch) => batch.questions.map((question) => question.id)))
      .toEqual(['p2']);
    expect(second.record.cache).toMatchObject({ asked: 1, reused: 2 });
  });

  it('asks again for that part only when its role changes', async () => {
    const counter = counting();
    const options = { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      cache: { store: countingStore().store, deciderId: 'test-decider' },
    };
    await pick(threeParts(), options);
    counter.calls.length = 0;
    const changed = threeParts();
    changed[1] = candidate({ sourceId: 'notes', id: 'p2', role: 'rule' });
    const second = await pick(changed, options);
    expect(counter.calls.flatMap((batch) => batch.questions.map((question) => question.id)))
      .toEqual(['p2']);
    expect(second.record.cache).toMatchObject({ asked: 1, reused: 2 });
  });

  it('asks again for that part only when its source id changes', async () => {
    const counter = counting();
    const options = { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      cache: { store: countingStore().store, deciderId: 'test-decider' },
    };
    await pick(threeParts(), options);
    counter.calls.length = 0;
    const changed = threeParts();
    // Every other part field stays what it was: only the source id
    // the question carries can tell this part from the stored one.
    changed[1] = candidate({
      sourceId: 'other', id: 'p2', title: 'p2', text: 'text of notes/p2',
    });
    const second = await pick(changed, options);
    expect(counter.calls.flatMap((batch) => batch.questions.map((question) => question.id)))
      .toEqual(['p2']);
    expect(second.record.cache).toMatchObject({ asked: 1, reused: 2 });
  });

  it('asks again for that part only when its kind changes', async () => {
    const counter = counting(0.5);
    const options = { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide, questionsBySource: { notes: fitted },
      cache: { store: countingStore().store, deciderId: 'test-decider' },
    };
    await pick(threeParts(), options);
    counter.calls.length = 0;
    const changed = threeParts();
    // Under a question set the kind changes no wording: only the kind field
    // the question carries can tell this part from the stored one.
    changed[1] = candidate({ sourceId: 'notes', id: 'p2', kind: 'knowledge' });
    const second = await pick(changed, options);
    expect(counter.calls.flatMap((batch) => batch.questions.map((question) => question.id)))
      .toEqual(['p2', 'p2', 'p2']);
    expect(second.record.cache).toMatchObject({ asked: 3, reused: 6 });
  });

  it('asks again for that part only when its date changes with unchanged text', async () => {
    const counter = counting();
    const options = { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      cache: { store: countingStore().store, deciderId: 'test-decider' },
    };
    const parts = (value: string) => [
      candidate({ sourceId: 'notes', id: 'p1' }),
      candidate({ sourceId: 'notes', id: 'p2', date: { value, meaning: 'recorded' } }),
      candidate({ sourceId: 'notes', id: 'p3' }),
    ];
    await pick(parts('2024-01-01'), options);
    counter.calls.length = 0;
    const second = await pick(parts('2024-01-02'), options);
    expect(counter.calls.flatMap((batch) => batch.questions.map((question) => question.id)))
      .toEqual(['p2']);
    expect(second.record.cache).toMatchObject({ asked: 1, reused: 2 });
  });

  it('asks again for that part only when its date meaning changes with unchanged text', async () => {
    const counter = counting();
    const options = { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      cache: { store: countingStore().store, deciderId: 'test-decider' },
    };
    const parts = (meaning: 'recorded' | 'modified') => [
      candidate({ sourceId: 'notes', id: 'p1' }),
      candidate({ sourceId: 'notes', id: 'p2', date: { value: '2024-01-01', meaning } }),
      candidate({ sourceId: 'notes', id: 'p3' }),
    ];
    await pick(parts('recorded'), options);
    counter.calls.length = 0;
    const second = await pick(parts('modified'), options);
    expect(counter.calls.flatMap((batch) => batch.questions.map((question) => question.id)))
      .toEqual(['p2']);
    expect(second.record.cache).toMatchObject({ asked: 1, reused: 2 });
  });

  it('asks every part again when the decision text cut changes', async () => {
    const counted = countingStore();
    const counter = counting();
    const options = { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      cache: { store: counted.store, deciderId: 'test-decider' },
      limits: { maxQuestionText: 100 },
    };
    await pick(threeParts(), options);
    counter.calls.length = 0;
    const second = await pick(threeParts(), {
      ...options, limits: { maxQuestionText: 200 },
    });
    expect(counter.calls.flatMap((batch) => batch.questions)).toHaveLength(3);
    expect(second.record.cache).toMatchObject({ asked: 3, reused: 0 });
  });

  it('asks again for that part only when its text changes', async () => {
    const counter = counting();
    const options = { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      cache: { store: countingStore().store, deciderId: 'test-decider' },
    };
    await pick(threeParts(), options);
    counter.calls.length = 0;
    const changed = threeParts();
    changed[1] = candidate({ sourceId: 'notes', id: 'p2', text: 'an edited second part' });
    const second = await pick(changed, options);
    expect(counter.calls.flatMap((batch) => batch.questions.map((question) => question.id)))
      .toEqual(['p2']);
    expect(second.record.cache).toMatchObject({ asked: 1, reused: 2 });
  });

  it('asks again for that part only when its text changes past the decision text cut', async () => {
    const counter = counting();
    const options = { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      limits: { maxQuestionText: 20 },
      cache: { store: countingStore().store, deciderId: 'test-decider' },
    };
    const parts = (suffix: string) => [
      candidate({ sourceId: 'notes', id: 'p1' }),
      candidate({ sourceId: 'notes', id: 'p2', text: `${'x'.repeat(20)}${suffix}` }),
      candidate({ sourceId: 'notes', id: 'p3' }),
    ];
    const first = await pick(parts(' a hidden suffix'), options);
    // The cut hides the suffix: the decider saw only the 20-character
    // prefix, and the record's truncated flag says so.
    expect(first.record.candidates.find((entry) => entry.id === 'p2'))
      .toMatchObject({ truncated: true });
    counter.calls.length = 0;
    const second = await pick(parts(' an edited suffix'), options);
    expect(counter.calls.flatMap((batch) => batch.questions.map((question) => question.id)))
      .toEqual(['p2']);
    // The re-asked question shows the same cut prefix as before: the
    // full text, not the shown text, changed its key.
    expect(counter.calls[0]!.questions[0]!.text).toBe('x'.repeat(20));
    expect(second.record.cache).toMatchObject({ asked: 1, reused: 2 });
  });

  it('asks again when the rendered question wording changes', async () => {
    const counted = countingStore();
    const counter = counting();
    const options = { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide, questionsBySource: { notes: fitted },
      cache: { store: counted.store, deciderId: 'test-decider' },
    };
    await pick(threeParts(), options);
    const asked = counter.calls.flatMap((batch) => batch.questions).length;
    counter.calls.length = 0;
    const reworded: PickCascade = {
      ...fitted,
      questions: fitted.questions.map((question) => ({ ...question, instructions: `${question.instructions} Still?` })),
    };
    const second = await pick(threeParts(), { ...options, questionsBySource: { notes: reworded } });
    expect(counter.calls.flatMap((batch) => batch.questions)).toHaveLength(asked);
    expect(second.record.cache).toMatchObject({ asked, reused: 0 });
  });

  it('asks again when a rendered question true criterion changes', async () => {
    const counted = countingStore();
    const counter = counting();
    const options = { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide, questionsBySource: { notes: fitted },
      cache: { store: counted.store, deciderId: 'test-decider' },
    };
    await pick(threeParts(), options);
    const asked = counter.calls.flatMap((batch) => batch.questions).length;
    counter.calls.length = 0;
    const recriteria: PickCascade = {
      ...fitted,
      questions: fitted.questions.map((question) => ({ ...question, true: `${question.true} Still.` })),
    };
    const second = await pick(threeParts(), { ...options, questionsBySource: { notes: recriteria } });
    expect(counter.calls.flatMap((batch) => batch.questions)).toHaveLength(asked);
    expect(second.record.cache).toMatchObject({ asked, reused: 0 });
  });

  it('asks again when a rendered question false criterion changes', async () => {
    const counted = countingStore();
    const counter = counting();
    const options = { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide, questionsBySource: { notes: fitted },
      cache: { store: counted.store, deciderId: 'test-decider' },
    };
    await pick(threeParts(), options);
    const asked = counter.calls.flatMap((batch) => batch.questions).length;
    counter.calls.length = 0;
    const recriteria: PickCascade = {
      ...fitted,
      questions: fitted.questions.map((question) => ({ ...question, false: `${question.false} Still.` })),
    };
    const second = await pick(threeParts(), { ...options, questionsBySource: { notes: recriteria } });
    expect(counter.calls.flatMap((batch) => batch.questions)).toHaveLength(asked);
    expect(second.record.cache).toMatchObject({ asked, reused: 0 });
  });

  it('sends the decider a batch holding only the parts that missed', async () => {
    const counted = countingStore();
    const counter = counting();
    const options = { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      cache: { store: counted.store, deciderId: 'test-decider' },
      limits: { maxPerBatch: 10 },
    };
    await pick(threeParts(), options);
    counter.calls.length = 0;
    const changed = threeParts();
    changed[1] = candidate({ sourceId: 'notes', id: 'p2', text: 'an edited second part' });
    await pick(changed, options);
    expect(counter.calls).toHaveLength(1);
    expect(counter.calls[0]!.questions.map((question) => question.id)).toEqual(['p2']);
  });

  it('never stores a refused or missing answer and asks it again', async () => {
    const directory = storeDirectory();
    let fail = true;
    const calls: PickBatch[] = [];
    const decide: PickDecide = async (batch) => {
      calls.push(batch);
      return Object.fromEntries(batch.questions.map((question) => [
        question.key,
        fail && question.id === 'p2' ? { status: 'refused' as const }
          : fail && question.id === 'p3' ? { status: 'missing' as const }
            : answered(0.9),
      ]));
    };
    const options = { ...uncutPick,
      task: 'Recall the plan', decide,
      cache: { store: decisionFileStore(directory), deciderId: 'test-decider' },
    };
    const first = await pick(threeParts(), options);
    // p3 'missing' above is an explicit reply, still not an answered result.
    expect(readdirSync(directory)).toHaveLength(1);
    expect(first.record.cache).toMatchObject({ asked: 3, reused: 0 });

    calls.length = 0;
    fail = false;
    const second = await pick(threeParts(), options);
    expect(calls.flatMap((batch) => batch.questions.map((question) => question.id)))
      .toEqual(['p2', 'p3']);
    expect(second.record.cache).toMatchObject({ asked: 2, reused: 1 });
    expect(readdirSync(directory)).toHaveLength(3);
  });

  it('treats a corrupt, wrong-shaped or out-of-range entry as a miss and completes the pick', async () => {
    const directory = storeDirectory();
    const counter = counting();
    const options = { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      cache: { store: decisionFileStore(directory), deciderId: 'test-decider' },
    };
    await pick(threeParts(), options);
    const files = readdirSync(directory).sort();
    writeFileSync(join(directory, files[0]!), 'not json {');
    writeFileSync(join(directory, files[1]!), JSON.stringify({ answer: { status: 'answered', probability: 2 } }));
    writeFileSync(join(directory, files[2]!), JSON.stringify({ labels: { owns: 0.9 } }));

    counter.calls.length = 0;
    const second = await pick(threeParts(), options);
    expect(counter.calls.flatMap((batch) => batch.questions)).toHaveLength(3);
    expect(second.record.cache).toMatchObject({ asked: 3, reused: 0 });
    expect(second.selected).toHaveLength(3);
  });

  it('treats a store whose get throws as all misses and completes the pick', async () => {
    let sets = 0;
    const store: DecisionStore = {
      get: async () => { throw new Error('the directory is gone'); },
      set: async () => { sets += 1; },
    };
    const counter = counting();
    const result = await pick(threeParts(), { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      cache: { store, deciderId: 'test-decider' },
    });
    expect(counter.calls.flatMap((batch) => batch.questions)).toHaveLength(3);
    expect(result.record.cache).toMatchObject({ asked: 3, reused: 0 });
    expect(sets).toBe(3);
    expect(result.selected).toHaveLength(3);
  });

  it('keeps the answers when the store cannot write, counts each failed write and warns once', async () => {
    const counted = countingStore();
    counted.failWrites = true;
    const counter = counting();
    const result = await pick(threeParts(), { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      cache: { store: counted.store, deciderId: 'test-decider' },
    });
    expect(result.selected.map((item) => item.id)).toEqual(['p1', 'p2', 'p3']);
    expect(result.record.cache).toMatchObject({ asked: 3, reused: 0, failedWrites: 3 });
    expect(result.record.cache!.warning).toMatch(/^3 decision\(s\) could not be stored \(the store is read-only\)/);
    expect(counted.values.size).toBe(0);

    // Nothing was stored, so the next pick asks every question again.
    counted.failWrites = false;
    counter.calls.length = 0;
    const second = await pick(threeParts(), { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      cache: { store: counted.store, deciderId: 'test-decider' },
    });
    expect(counter.calls.flatMap((batch) => batch.questions)).toHaveLength(3);
    expect(second.record.cache).toMatchObject({ asked: 3, reused: 0, failedWrites: 0 });
  });

  it('applies a changed threshold to a full hit with zero calls', async () => {
    const directory = storeDirectory();
    let call = 0;
    const probabilities = [0.4, 0.7, 0.95];
    const decide: PickDecide = async (batch) => {
      call += 1;
      return allAnswered(batch, probabilities[call % probabilities.length]!);
    };
    const parts = threeParts();
    // Answer each id its own probability.
    const keyed = new Map(probabilities.map((probability, index) => [parts[index]!.id, probability]));
    const byId: PickDecide = async (batch) => Object.fromEntries(
      batch.questions.map((question) => [question.key, answered(keyed.get(question.id)!)]),
    );
    const options = (threshold: number) => ({ ...uncutPick,
      task: 'Recall the plan', decide: byId,
      everyScored: { bar: threshold },
      cache: { store: decisionFileStore(directory), deciderId: 'test-decider' },
    });
    const first = await pick(parts, options(0.5));
    expect(first.selected.map((item) => item.id).sort()).toEqual(['p2', 'p3']);

    const second = await pick(parts, options(0.8));
    expect(second.selected.map((item) => item.id)).toEqual(['p3']);
    expect(second.record.cache).toMatchObject({ asked: 0, reused: 3 });
  });

  it('makes every call and reads and writes nothing with cache: false', async () => {
    const counted = countingStore();
    const counter = counting();
    const options = { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      cache: { store: counted.store, deciderId: 'test-decider' },
    };
    await pick(threeParts(), options);
    const getsAfter = counted.gets;
    const setsAfter = counted.sets;
    counter.calls.length = 0;
    // The bypass overrides a cache the shared options object carries,
    // the way a caller spreading its options into a held-out run uses it.
    const bypassed = await pick(threeParts(), { ...options, cache: false });
    expect(counter.calls.flatMap((batch) => batch.questions)).toHaveLength(3);
    expect(counted.gets).toBe(getsAfter);
    expect(counted.sets).toBe(setsAfter);
    expect(bypassed.record).not.toHaveProperty('cache');
  });

  it('returns identical output when no cache is passed', async () => {
    const counted = countingStore();
    const counter = counting();
    const plain = await pick(threeParts(), { ...uncutPick, task: 'Recall the plan', decide: counter.decide });
    const bypassed = await pick(threeParts(), { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide, cache: false,
    });
    expect({ ...bypassed.record, asOf: plain.record.asOf }).toEqual(plain.record);
    const cached = await pick(threeParts(), { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      cache: { store: counted.store, deciderId: 'test-decider' },
    });
    expect(cached.selected.map((item) => item.id)).toEqual(plain.selected.map((item) => item.id));
    const { cache: _cache, ...rest } = cached.record;
    expect({ ...rest, asOf: plain.record.asOf }).toEqual(plain.record);
  });

  it('needs a working store port and a nonempty deciderId', async () => {
    const counter = counting();
    const base = { ...uncutPick, task: 'Recall the plan', decide: counter.decide };
    // @ts-expect-error the store is required
    await expect(pick(threeParts(), { ...base, cache: { deciderId: 'x' } }))
      .rejects.toThrow('cache.store must supply get(key) and set(key, value).');
    await expect(pick(threeParts(), {
      // @ts-expect-error set is required too
      ...base, cache: { store: { get: async () => undefined }, deciderId: 'x' },
    })).rejects.toThrow('cache.store must supply get(key) and set(key, value).');
    await expect(pick(threeParts(), {
      ...base, cache: { store: countingStore().store, deciderId: '' },
    })).rejects.toThrow('cache.deciderId must be a nonempty string.');
    await expect(pick(threeParts(), {
      ...base, cache: { store: countingStore().store, deciderId: 'x', questionVersion: ' ' },
    })).rejects.toThrow('cache.questionVersion must be a nonempty string.');
  });

  it('never marks an always-applies rule reused: it is never asked', async () => {
    const counted = countingStore();
    const counter = counting();
    const always = candidate({ sourceId: 'notes', id: 'r1', role: 'rule', applies: 'always' });
    const options = { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      cache: { store: counted.store, deciderId: 'test-decider' },
    };
    await pick([always, ...threeParts()], options);
    counter.calls.length = 0;
    const second = await pick([always, ...threeParts()], options);
    expect(counter.calls).toHaveLength(0);
    const entry = second.record.candidates.find((item) => item.id === 'r1');
    expect(entry).toMatchObject({ status: 'selected', asked: false });
    expect(entry).not.toHaveProperty('reused');
    expect(second.record.cache).toMatchObject({ asked: 0, reused: 3 });
  });

  it('reuses every answered cascade question and marks the verdict reused', async () => {
    const counted = countingStore();
    const counter = counting(0.5);
    const options = { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide, questionsBySource: { notes: fitted },
      cache: { store: counted.store, deciderId: 'test-decider' },
    };
    const first = await pick(threeParts(), options);
    // 0.5 sits inside the band, so every part asked all three questions.
    expect(first.record.cache).toMatchObject({ asked: 9, reused: 0 });

    counter.calls.length = 0;
    const second = await pick(threeParts(), options);
    expect(counter.calls).toHaveLength(0);
    expect(second.record.cache).toMatchObject({ asked: 0, reused: 9 });
    expect(second.record.candidates.every((entry) =>
      entry.status === 'selected' && entry.reused === true
      && entry.questions?.every((answer) =>
        answer.status === 'answered' && answer.reused === true))).toBe(true);
  });

  it('reuses tag answers on a second pick', async () => {
    const counted = countingStore();
    const counter = counting(0.9);
    const options = { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      tags: [{ key: 'intent', questions: [{ key: 'correction', instructions: 'Corrects?', true: 't', false: 'f' }] }],
      cache: { store: counted.store, deciderId: 'test-decider' },
    };
    const first = await pick(threeParts().slice(0, 1), options);
    expect(first.record.cache).toMatchObject({ asked: 2, reused: 0 });

    counter.calls.length = 0;
    const second = await pick(threeParts().slice(0, 1), options);
    expect(counter.calls).toHaveLength(0);
    expect(second.record.cache).toMatchObject({ asked: 0, reused: 2 });
    expect(second.record.candidates[0]!.tags?.intent?.answers).toEqual([
      { key: 'correction', status: 'answered', probability: 0.9, reused: true },
    ]);
  });

  it('asks two tag sets sharing one question wording separately', async () => {
    const counted = countingStore();
    const calls: PickBatch[] = [];
    // The decider answers by tag set: a shared key would hand one
    // set's stored answer to the other.
    const decide: PickDecide = async (batch) => {
      calls.push(batch);
      return Object.fromEntries(batch.questions.map((question) => [
        question.key, answered(question.tagSet === 'tone' ? 0.2 : 0.9),
      ]));
    };
    const options = { ...uncutPick,
      task: 'Recall the plan', decide,
      tags: [
        { key: 'tone', questions: [{ key: 'q', instructions: 'Same?', true: 't', false: 'f' }] },
        { key: 'intent', questions: [{ key: 'q', instructions: 'Same?', true: 't', false: 'f' }] },
      ],
      cache: { store: counted.store, deciderId: 'test-decider' },
    };
    // One decision answer and two tag answers: identical wording on
    // different tag sets keys two different answers, so each is asked
    // and each is stored under its own key.
    const first = await pick(threeParts().slice(0, 1), options);
    expect(first.record.cache).toMatchObject({ asked: 3, reused: 0 });
    expect(counted.values.size).toBe(3);

    calls.length = 0;
    const second = await pick(threeParts().slice(0, 1), options);
    expect(calls).toHaveLength(0);
    expect(second.record.cache).toMatchObject({ asked: 0, reused: 3 });
    expect(second.record.candidates[0]!.tags?.tone?.answers).toEqual([
      { key: 'q', status: 'answered', probability: 0.2, reused: true },
    ]);
    expect(second.record.candidates[0]!.tags?.intent?.answers).toEqual([
      { key: 'q', status: 'answered', probability: 0.9, reused: true },
    ]);
  });

  it('asks two cascade questions sharing one wording under their own names', async () => {
    const counted = countingStore();
    const calls: PickBatch[] = [];
    // The decider answers by question name: a shared key would hand
    // one question's stored answer to the other.
    const decide: PickDecide = async (batch) => {
      calls.push(batch);
      return Object.fromEntries(batch.questions.map((question) => [
        question.key, answered(question.questionKey === 'again' ? 0.2 : 0.9),
      ]));
    };
    const shared: PickCascade = {
      bias: -1.7,
      questions: [
        { key: 'relevant', instructions: 'Same?', true: 't', false: 'f', weight: 0.7 },
        { key: 'again', instructions: 'Same?', true: 't', false: 'f', weight: 0.8 },
      ],
    };
    const options = { ...uncutPick,
      task: 'Recall the plan', decide, questionsBySource: { notes: shared },
      cache: { store: counted.store, deciderId: 'test-decider' },
    };
    // Identical wording under two question names keys two answers:
    // each is asked and stored under its own key.
    const first = await pick(threeParts().slice(0, 1), options);
    expect(first.record.cache).toMatchObject({ asked: 2, reused: 0 });
    expect(counted.values.size).toBe(2);

    calls.length = 0;
    const second = await pick(threeParts().slice(0, 1), options);
    expect(calls).toHaveLength(0);
    expect(second.record.cache).toMatchObject({ asked: 0, reused: 2 });
    expect(second.record.candidates[0]!.questions).toEqual([
      { key: 'relevant', status: 'answered', probability: 0.9, reused: true },
      { key: 'again', status: 'answered', probability: 0.2, reused: true },
    ]);
  });

  it('asks two tag sets apart when their question names join to one fitted name', async () => {
    const counted = countingStore();
    const counter = counting(0.9);
    const options = { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      // Set 'a' with question 'b.c' and set 'a.b' with question 'c'
      // both name the fitted question 'a.b.c' and share one wording:
      // only the tag set tells their store keys apart.
      tags: [
        { key: 'a', questions: [{ key: 'b.c', instructions: 'Same?', true: 't', false: 'f' }] },
        { key: 'a.b', questions: [{ key: 'c', instructions: 'Same?', true: 't', false: 'f' }] },
      ],
      cache: { store: counted.store, deciderId: 'test-decider' },
    };
    const first = await pick(threeParts().slice(0, 1), options);
    expect(first.record.cache).toMatchObject({ asked: 3, reused: 0 });
    expect(counted.values.size).toBe(3);

    counter.calls.length = 0;
    const second = await pick(threeParts().slice(0, 1), options);
    expect(counter.calls).toHaveLength(0);
    expect(second.record.cache).toMatchObject({ asked: 0, reused: 3 });
    expect(second.record.candidates[0]!.tags?.a?.answers).toEqual([
      { key: 'b.c', status: 'answered', probability: 0.9, reused: true },
    ]);
    expect(second.record.candidates[0]!.tags?.['a.b']?.answers).toEqual([
      { key: 'c', status: 'answered', probability: 0.9, reused: true },
    ]);
  });

  it('keeps label asks on the label store and decisions on the cache', async () => {
    const directory = storeDirectory();
    const counted = countingStore();
    const counter = counting(0.9);
    const options = { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      labels: { directory, deciderId: 'test-decider' },
      labelKindsBySource: { notes: LABEL_KINDS },
      cache: { store: counted.store, deciderId: 'test-decider' },
    };
    const first = await pick(threeParts(), options);
    expect(first.record.labels).toMatchObject({ asked: 4, reused: 0 });
    expect(first.record.cache).toMatchObject({ asked: 3, reused: 0 });

    counter.calls.length = 0;
    const second = await pick(threeParts(), options);
    expect(counter.calls).toHaveLength(0);
    expect(second.record.labels).toMatchObject({ asked: 0, reused: 4 });
    expect(second.record.cache).toMatchObject({ asked: 0, reused: 3 });
  });

  it('selects nothing on a warm cache when the signal is already aborted', async () => {
    const counted = countingStore();
    const counter = counting();
    const options = { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      cache: { store: counted.store, deciderId: 'test-decider' },
    };
    await pick(threeParts(), options);
    const gets = counted.gets;
    counter.calls.length = 0;

    const stopped = await pick(threeParts(), { ...options, signal: AbortSignal.abort() });
    // The stop is checked before the first read: nothing was read,
    // reused, asked or selected, and every part records the stop.
    expect(counted.gets).toBe(gets);
    expect(counter.calls).toHaveLength(0);
    expect(stopped.selected).toHaveLength(0);
    expect(stopped.record.candidates.every((entry) =>
      entry.status === 'unassessed' && entry.reason === 'cancelled')).toBe(true);
    expect(stopped.record.cache).toMatchObject({ asked: 0, reused: 0 });
  });

  it('applies no warm-cache hit when the signal aborts while the reads run', async () => {
    const counted = countingStore();
    const counter = counting();
    await pick(threeParts(), { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      cache: { store: counted.store, deciderId: 'test-decider' },
    });
    const gets = counted.gets;
    counter.calls.length = 0;

    const controller = new AbortController();
    const aborting: DecisionStore = {
      get: async (key) => {
        controller.abort();
        return counted.store.get(key);
      },
      set: counted.store.set,
    };
    const stopped = await pick(threeParts(), { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      signal: controller.signal,
      cache: { store: aborting, deciderId: 'test-decider' },
    });
    // The reads ran but the signal fired first: no hit applied, no
    // decider call followed, and every part records the stop.
    expect(counted.gets).toBe(gets + 3);
    expect(counter.calls).toHaveLength(0);
    expect(stopped.selected).toHaveLength(0);
    expect(stopped.record.candidates.every((entry) =>
      entry.status === 'unassessed' && entry.reason === 'cancelled')).toBe(true);
    expect(stopped.record.cache).toMatchObject({ asked: 0, reused: 0 });
  });

  it('records a time stop when warm-cache reads run past the elapsed limit', async () => {
    const counted = countingStore();
    const counter = counting();
    await pick(threeParts(), { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      cache: { store: counted.store, deciderId: 'test-decider' },
    });
    const gets = counted.gets;
    counter.calls.length = 0;

    const slow: DecisionStore = {
      get: async (key) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return counted.store.get(key);
      },
      set: counted.store.set,
    };
    const stopped = await pick(threeParts(), { ...uncutPick,
      task: 'Recall the plan', decide: counter.decide,
      limits: { maxElapsedMs: 30 },
      cache: { store: slow, deciderId: 'test-decider' },
    });
    // The reads ran past the limit: no hit applied, no decider call
    // followed, and every part records the stop.
    expect(counted.gets).toBe(gets + 3);
    expect(counter.calls).toHaveLength(0);
    expect(stopped.selected).toHaveLength(0);
    expect(stopped.record.candidates.every((entry) =>
      entry.status === 'unassessed' && entry.reason === 'time')).toBe(true);
    expect(stopped.record.cache).toMatchObject({ asked: 0, reused: 0 });
  });
});
