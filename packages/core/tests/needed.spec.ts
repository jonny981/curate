import { describe, expect, it } from 'vitest';
import { jevRequest, pick, rankedRead, type MemoryCandidate, type PickBatch, type PickCascade, type PickDecide } from '../src/index.js';

const task = 'Which database did we choose?';
const set: PickCascade = { bias: 0, questions: [{ key: 'relevant', instructions: 'Relevant?', true: 'Yes', false: 'No', weight: 1 }] };
const part = (sourceId: string, id: string): MemoryCandidate => ({
  sourceId, id, role: 'reference', title: id, text: `${sourceId} evidence ${id}`, signals: { score: 1 },
});
const parts = [part('agents', 'a1'), part('notes', 'n1'), part('agents', 'a2'), part('notes', 'n2')];
const modesBySource = {
  agents: { name: 'agent-transcripts', questions: set, read: rankedRead, needed: true },
  notes: { name: 'notes', questions: set, read: rankedRead },
};
const recording = () => {
  const batches: PickBatch[] = [];
  const decide: PickDecide = async (batch) => {
    batches.push(batch);
    return Object.fromEntries(batch.questions.map((question) => [question.key, { status: 'answered', probability: 0.9 }]));
  };
  return { batches, decide };
};
const facts = ['Which database was chosen', 'Why it was chosen'];

describe('the facts the answer needs', () => {
  it('go in the state of requests of parts whose mode lists them, and of no other request', async () => {
    const { batches, decide } = recording();
    await pick(parts, { task, decide, everyRanked: true, everyScored: true, modesBySource, needed: facts });
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      const sources = new Set(batch.questions.map((question) => question.sourceId));
      expect(sources.size).toBe(1);
      expect(batch.needed).toEqual(sources.has('agents') ? facts : undefined);
    }
    const listed = batches.find((batch) => batch.needed !== undefined)!;
    const { state } = jevRequest(listed);
    expect(Object.keys(state)).toEqual(['task', 'needed', 'items']);
    expect(state.needed).toEqual(facts);
    expect(jevRequest(batches.find((batch) => batch.needed === undefined)!).state).not.toHaveProperty('needed');
  });

  it('leave every request as it was when the call gives none', async () => {
    const plain = recording();
    await pick(parts, { task, decide: plain.decide, everyRanked: true, everyScored: true, modesBySource });
    const empty = recording();
    await pick(parts, { task, decide: empty.decide, everyRanked: true, everyScored: true, modesBySource, needed: [] });
    expect(plain.batches.every((batch) => batch.needed === undefined)).toBe(true);
    expect(empty.batches).toEqual(plain.batches);
  });

  it('must be nonempty strings', async () => {
    await expect(pick(parts, { task, decide: recording().decide, modesBySource, needed: ['ok', ' '] }))
      .rejects.toThrow('needed must be a list of facts, each a nonempty string.');
  });
});
