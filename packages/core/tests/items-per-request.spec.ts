import { describe, expect, it } from 'vitest';
import { jevRequest, pick, rankedRead, type MemoryCandidate, type Mode, type PickBatch, type PickCascade, type PickDecide } from '../src/index.js';

const task = 'Which database did we choose?';
const needed = ['which database was chosen'];
const set: PickCascade = { bias: 0, questions: [
  { key: 'relevant', instructions: 'Relevant?', true: 'Yes', false: 'No', weight: 1 },
  { key: 'answers', instructions: 'Answers?', true: 'Yes', false: 'No', weight: 1 },
] };
const mode = (itemsPerRequest?: number): Mode => ({ name: 'notes', questions: set, read: rankedRead, needed: true,
  ...(itemsPerRequest === undefined ? {} : { itemsPerRequest }) });
const part = (index: number): MemoryCandidate => ({ sourceId: 'notes', role: 'reference', id: `n${index}`, title: `n${index}`,
  text: `Note ${index}${index === 2 ? ': we chose Postgres.' : '.'}`, signals: {}, searchRanks: [index] });
const parts = Array.from({ length: 6 }, (_, index) => part(index));
/** Answers every question 0.9 for the Postgres note and 0.2 otherwise,
 *  after a short wait, and keeps every request and the most open at once. */
const recording = () => {
  const batches: PickBatch[] = [];
  let open = 0;
  const state = { most: 0 };
  const decide: PickDecide = async (batch) => {
    batches.push(batch);
    open += 1;
    state.most = Math.max(state.most, open);
    await new Promise((resolve) => setTimeout(resolve, 5));
    open -= 1;
    return Object.fromEntries(batch.questions.map((question) => [question.key, { status: 'answered',
      probability: question.text.includes('Postgres') ? 0.9 : 0.2 }]));
  };
  return { batches, decide, state };
};

describe('items per request', () => {
  it('sends each item in a request of its own, with all its questions, all at once', async () => {
    const { batches, decide, state } = recording();
    const result = await pick(parts, { task, decide, needed, modesBySource: { notes: mode(1) } });
    expect(batches).toHaveLength(6);
    for (const batch of batches) {
      expect(new Set(batch.questions.map((question) => question.id)).size).toBe(1);
      expect(batch.questions.map((question) => question.questionKey)).toEqual(['relevant', 'answers']);
      expect(batch.needed).toEqual(needed);
    }
    expect(state.most).toBe(6);
    expect(result.record.levers.sources.notes!.itemsPerRequest).toBe(1);
    // As sent: the task and the needed facts beside the one item, judged on its own.
    expect(jevRequest(batches.find((batch) => batch.questions[0]!.id === 'n2')!)).toEqual({
      model: 'jev-latest',
      state: { task, needed, item: { id: 'n2', date: null, title: 'n2', text: 'Note 2: we chose Postgres.' } },
      questions: {
        q0: { type: 'noul', instructions: { question: 'Relevant?', item: 'item' }, criteria: { true: 'Yes', false: 'No' } },
        q1: { type: 'noul', instructions: { question: 'Answers?', item: 'item' }, criteria: { true: 'Yes', false: 'No' } },
      },
    });
  });

  it('holds as many items as it is set to', async () => {
    const { batches, decide } = recording();
    await pick(parts, { task, decide, needed, modesBySource: { notes: mode(4) } });
    expect(batches.map((batch) => new Set(batch.questions.map((question) => question.id)).size)).toEqual([4, 2]);
  });

  it('keeps the rating stop\'s waves to the same stretch of the order', async () => {
    const many = Array.from({ length: 40 }, (_, index) => part(index));
    const runs = await Promise.all([undefined, 1].map(async (itemsPerRequest) => {
      const { decide } = recording();
      const result = await pick(many, { task, decide, needed, stopWhenCold: { parts: 10 },
        limits: { maxPerBatch: 10 }, modesBySource: { notes: mode(itemsPerRequest) } });
      return result.record.pick!.stopWhenCold!;
    }));
    expect(runs[1]!.waves).toBe(runs[0]!.waves);
    expect(runs[1]!.rated).toBe(runs[0]!.rated);
  });

  it('leaves every request as it was when unset, and must be a positive whole number', async () => {
    const plain = recording();
    await pick(parts, { task, decide: plain.decide, needed, modesBySource: { notes: mode() } });
    expect(plain.batches).toHaveLength(1);
    await expect(pick(parts, { task, decide: plain.decide, modesBySource: { notes: mode(0) } }))
      .rejects.toThrow('modesBySource.notes.itemsPerRequest must be a positive whole number.');
  });
});
