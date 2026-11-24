import { afterEach, describe, expect, it, vi } from 'vitest';
import { jev } from '../src/models.js';
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

  it('keep identical text apart when only one of its parts is asked with them, in either source order', async () => {
    // One text, said by the same author in two sources: one mode lists the
    // facts, the other does not. The rater answers 0.9 with the facts in
    // the state and 0.001 without, so a shared answer shows.
    const same = (sourceId: string, rank: number): MemoryCandidate => ({ sourceId, id: sourceId, role: 'reference',
      author: 'person', title: 'Evidence', text: 'We chose Postgres for its transactions.', searchRanks: [rank], signals: {} });
    const modes = { facts: { ...modesBySource.agents }, plain: { ...modesBySource.notes } };
    const stored = new Map<string, unknown>();
    const cache = { deciderId: 'stub', store: { get: async (key: string) => stored.get(key), set: async (key: string, value: unknown) => { stored.set(key, value); } } };
    const asked: (readonly string[] | undefined)[] = [];
    const decide: PickDecide = async (batch) => {
      asked.push(batch.needed);
      return Object.fromEntries(batch.questions.map((question) =>
        [question.key, { status: 'answered', probability: batch.needed === undefined ? 0.001 : 0.9 }]));
    };
    const probability = (result: Awaited<ReturnType<typeof pick>>, sourceId: string) => {
      const entry = result.record.candidates.find((item) => item.sourceId === sourceId);
      return entry !== undefined && 'probability' in entry ? entry.probability : undefined;
    };
    for (const order of [['facts', 'plain'], ['plain', 'facts']]) {
      stored.clear();
      asked.length = 0;
      const options = { task, decide, modesBySource: modes, needed: facts, cache };
      const both = await pick(order.map((sourceId, rank) => same(sourceId, rank)), options);
      expect(probability(both, 'facts')).toBeCloseTo(0.9, 12);
      expect(probability(both, 'plain')).toBeCloseTo(0.001, 12);
      expect(asked.map((list) => list !== undefined).sort()).toEqual([false, true]);
      // A later call on one source takes its own stored answer.
      asked.length = 0;
      const plainLater = await pick([same('plain', 0)], options);
      const factsLater = await pick([same('facts', 0)], options);
      expect(asked).toEqual([]);
      expect(probability(plainLater, 'plain')).toBeCloseTo(0.001, 12);
      expect(probability(factsLater, 'facts')).toBeCloseTo(0.9, 12);
    }
  });

  it('must be nonempty strings', async () => {
    await expect(pick(parts, { task, decide: recording().decide, modesBySource, needed: ['ok', ' '] }))
      .rejects.toThrow('needed must be a list of facts, each a nonempty string.');
  });
});

describe('the facts the answer needs, as jev() posts them', () => {
  afterEach(() => vi.unstubAllGlobals());
  type Body = { state: { task: string; needed?: string[]; items: Record<string, { text: string }> }; questions: Record<string, unknown> };
  /** A stubbed decision service that keeps every posted body and answers
   *  each question, or answers `reject(body)` when it gives a status. */
  const service = (reject: (body: Body) => number | undefined = () => undefined) => {
    const bodies: Body[] = [];
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init!.body)) as Body;
      bodies.push(body);
      const status = reject(body);
      if (status !== undefined) return new Response('request too large', { status });
      return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, { noul: 0.9 }])) });
    }));
    return bodies;
  };
  const question = (id: string, text: string) => ({ key: `${id}:relevant`, sourceId: 'agents', id, role: 'reference' as const,
    title: id, text, question: 'Relevant?', trueCriterion: 'Yes', falseCriterion: 'No' });

  it('carries the list in the posted state of a mode that asks for it, and not in another', async () => {
    const bodies = service();
    await pick(parts, { task, decide: jev({ apiKey: 'test-key' }), everyRanked: true, everyScored: true, modesBySource, needed: facts });
    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) {
      const agents = Object.values(body.state.items).some((item) => item.text.startsWith('agents'));
      expect(body.state.needed).toEqual(agents ? facts : undefined);
    }
  });

  it('keeps the list in each half of a request the service rejects as too large, and in a halved resend', async () => {
    // Two items: the first request is rejected, each half is accepted.
    const split = service((body) => Object.keys(body.state.items).length > 1 ? 400 : undefined);
    await jev({ apiKey: 'test-key' })({ task, needed: facts, questions: [question('a', 'first part'), question('b', 'second part')] },
      new AbortController().signal);
    expect(split.map((body) => Object.keys(body.state.items).length)).toEqual([2, 1, 1]);
    expect(split.every((body) => JSON.stringify(body.state.needed) === JSON.stringify(facts))).toBe(true);
    vi.unstubAllGlobals();
    // One item: its text is halved until the service accepts it.
    const halved = service((body) => Object.values(body.state.items)[0]!.text.length > 10 ? 400 : undefined);
    await jev({ apiKey: 'test-key' })({ task, needed: facts, questions: [question('a', 'a part long enough to halve twice')] },
      new AbortController().signal);
    expect(halved.length).toBeGreaterThan(1);
    expect(halved.every((body) => JSON.stringify(body.state.needed) === JSON.stringify(facts))).toBe(true);
  });

  it('counts the list when it plans requests inside the size limits', async () => {
    // Items that fit two to a request without the list, and one to a
    // request with it.
    const bodies = service();
    const long = (n: number) => `${'word '.repeat(6_000)}${n}`;
    const needed = ['x'.repeat(40_000)];
    await jev({ apiKey: 'test-key' })({ task, needed, questions: [question('a', long(1)), question('b', long(2)), question('c', long(3))] },
      new AbortController().signal);
    for (const body of bodies) {
      expect(body.state.needed).toEqual(needed);
      expect(JSON.stringify(body.state).length).toBeLessThanOrEqual(32_000 * 3);
    }
    expect(bodies.length).toBe(3);
  });
});
