import { afterEach, describe, expect, it, vi } from 'vitest';
import { jev } from '../src/models.js';
import { jevTextRequest, pick, rankedRead, type MemoryCandidate, type Mode, type PickBatch, type PickCascade, type PickDecide } from '../src/index.js';

const task = 'Which bread did I bake?';
const set: PickCascade = { bias: 0, questions: [{ key: 'current', instructions: 'Does this item answer it?', true: 'It does', false: 'It does not', weight: 1 }] };
const note = (id: string, text: string): MemoryCandidate => ({ sourceId: 'notes', role: 'reference', id, title: `${id}: Bread`, text, signals: {},
  date: { value: '2023/05/21 (Sun) 23:38', meaning: 'recorded' }, searchRanks: [0] });
const parts = [note('session-001.md#1', 'I baked rye.'), note('session-002.md#1', 'Sourdough next week.')];
const mode = (settings: Partial<Mode> = {}): Mode => ({ name: 'notes', questions: set, read: rankedRead, request: 'text', ...settings });
const recording = () => {
  const batches: PickBatch[] = [];
  const decide: PickDecide = async (batch) => {
    batches.push(batch);
    return Object.fromEntries(batch.questions.map((question) => [question.key, { status: 'answered', probability: 0.5 }]));
  };
  return { batches, decide };
};
afterEach(() => { vi.unstubAllGlobals(); });

describe('the plain-text request form', () => {
  it('is main\'s form: the task, then each item as text, each question naming its item by number', async () => {
    const { batches, decide } = recording();
    await pick(parts, { task, decide, everyRanked: true, modesBySource: { notes: mode() } });
    expect(batches).toHaveLength(1);
    expect(batches[0]!.form).toBe('text');
    expect(jevTextRequest(batches[0]!)).toEqual({
      model: 'jev-latest',
      state: 'Which bread did I bake?\n\n'
        + 'Item 1: session-001.md#1 (recorded 2023/05/21 (Sun) 23:38)\nsession-001.md#1: Bread\n\nI baked rye.\n\n'
        + 'Item 2: session-002.md#1 (recorded 2023/05/21 (Sun) 23:38)\nsession-002.md#1: Bread\n\nSourdough next week.',
      questions: {
        q0: { type: 'noul', instructions: 'Does this item answer it?\n\nItem 1', criteria: { true: 'It does', false: 'It does not' } },
        q1: { type: 'noul', instructions: 'Does this item answer it?\n\nItem 2', criteria: { true: 'It does', false: 'It does not' } },
      },
    });
  });

  it('is what jev() sends for such a batch, and the record names the form', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      bodies.push(String(init.body));
      const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
      return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, { noul: 0.5 }])) });
    }));
    const result = await pick(parts, { task, decide: jev({ apiKey: 'test-key' }), everyRanked: true, modesBySource: { notes: mode() } });
    expect(typeof JSON.parse(bodies[0]!).state).toBe('string');
    expect(result.record.levers.sources.notes!.request).toBe('text');
  });

  it('gives way to the JSON state where the request carries what only it holds, or the mode does not ask for text', async () => {
    for (const [settings, extra] of [
      [{ needed: true }, { needed: ['which bread'] }],
      [{ hardFacts: true }, {}],
      [{ itemsPerRequest: 1 }, {}],
      [{ request: 'json' as const }, {}],
      [{ request: undefined }, {}],
    ] as const) {
      const { batches, decide } = recording();
      await pick(parts, { task, decide, everyRanked: true, ...extra, modesBySource: { notes: mode(settings) } });
      expect(batches.map((batch) => batch.form), JSON.stringify(settings)).toEqual(batches.map(() => undefined));
    }
  });

  it('refuses a form it does not know', async () => {
    const { decide } = recording();
    await expect(pick(parts, { task, decide, modesBySource: { notes: mode({ request: 'xml' as never }) } }))
      .rejects.toThrow("request must be 'text' or 'json'.");
  });
});
