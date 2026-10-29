import { afterEach, describe, expect, it, vi } from 'vitest';
import { jev, type JevCall } from '../src/models.js';
import { pick, type MemoryCandidate } from '../src/pick.js';

afterEach(() => vi.unstubAllGlobals());

const uncutPick = { everyRanked: true, everyScored: true, rare: false } as const;

/** A plain reference part asked its one relevance question. */
function part(index: number, text: string): MemoryCandidate {
  return {
    sourceId: 'notes', id: `part-${index}`, role: 'reference',
    title: `Part ${index}`, text, signals: { keyword: 1 },
  };
}

type JevBody = { state: string; questions: Record<string, { instructions: string }> };

/** A fetch stub that answers every question asked of it, but rejects a
 *  request whose state is over `cap` characters with HTTP 400
 *  'request too large'. */
function limited(cap = 20_000) {
  const bodies: JevBody[] = [];
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init!.body)) as JevBody;
    bodies.push(body);
    if (body.state.length > cap) return new Response('request too large', { status: 400 });
    return Response.json({
      usage: { input_tokens: body.state.length, output_tokens: 1 },
      answers: Object.fromEntries(Object.keys(body.questions).map((name) => [name, { noul: 0.7 }])),
    });
  }));
  return bodies;
}

describe('a Jev request the service rejects as too large', () => {
  it('splits the batch, answers every part and reports each request with its split count', async () => {
    const bodies = limited();
    const calls: JevCall[] = [];
    const decide = jev({ apiKey: 'test-key', onCall: (call) => { calls.push(call); } });
    const picked = await pick(Array.from({ length: 12 }, (_, index) => part(index, `${index} ${'x'.repeat(3_000)}`)), {
      ...uncutPick, task: 'What did the notes decide?', decide });

    expect(picked.selected).toHaveLength(12);
    expect(bodies.length).toBeGreaterThanOrEqual(3);
    expect(bodies[0]!.state.length).toBeGreaterThan(20_000);
    for (const body of bodies.slice(1)) expect(body.state.length).toBeLessThanOrEqual(20_000);
    expect(calls).toHaveLength(bodies.length);
    expect(calls.map((call) => call.status)).toEqual([400, 200, 200]);
    expect(calls.reduce((sum, call) => sum + call.splits, 0)).toBeGreaterThan(0);
    for (const call of calls) {
      expect(typeof call.size).toBe('number');
      expect(typeof call.ms).toBe('number');
      expect(typeof call.started).toBe('string');
    }
  });

  it('halves one oversized item until it fits and marks its answers truncated', async () => {
    const bodies = limited();
    const decide = jev({ apiKey: 'test-key' });
    const picked = await pick([part(0, 'x'.repeat(50_000))], {
      ...uncutPick, task: 'notes?', decide,
      questionsBySource: {
        notes: {
          bias: 0,
          questions: [{ key: 'relevant', instructions: 'Is this part relevant?', true: 'relevant', false: 'not relevant', weight: 1 }],
        },
      },
    });

    expect(picked.selected).toHaveLength(1);
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    expect(bodies[0]!.state.length).toBeGreaterThan(20_000);
    expect(bodies.map((body) => body.state.length)).toEqual([...bodies.map((body) => body.state.length)].sort((a, b) => b - a));
    expect(bodies[bodies.length - 1]!.state.length).toBeLessThanOrEqual(20_000);
    expect(picked.record.candidates[0]?.questions?.[0])
      .toMatchObject({ status: 'answered', probability: 0.7, truncated: true });
  });

  it('fails loudly with the reply body when every request is rejected', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      bodies.push(String(init!.body));
      return new Response('malformed', { status: 400 });
    }));
    const decide = jev({ apiKey: 'test-key' });
    await expect(pick([part(0, 'short text')], { ...uncutPick, task: 'notes?', decide }))
      .rejects.toThrow('malformed');
  });

  it('stops at once on a rejection no larger than a body already accepted', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      const body = String(init!.body);
      bodies.push(body);
      if (bodies.length === 1) {
        const sent = JSON.parse(body) as JevBody;
        return Response.json({ answers: Object.fromEntries(Object.keys(sent.questions).map((name) => [name, { noul: 0.7 }])) });
      }
      return new Response('malformed', { status: 400 });
    }));
    const decide = jev({ apiKey: 'test-key' });
    await expect(pick([part(0, 'a longer first text'), part(1, 'x')], {
      ...uncutPick, task: 'notes?', limits: { maxPerBatch: 1 }, decide })).rejects.toThrow('malformed');
    expect(bodies).toHaveLength(2);
  });

  it('splits a batch that shares its state with an accepted request but asks more questions', async () => {
    const bodies: { raw: string; body: JevBody }[] = [];
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      const raw = String(init!.body);
      const body = JSON.parse(raw) as JevBody;
      bodies.push({ raw, body });
      if (raw.length > 2_000) return new Response('request too large', { status: 400 });
      return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map((name) => [name, { noul: 0.7 }])) });
    }));
    const cascade = {
      bias: 0, first: 'gate', band: [0, 1] as const, firstOnly: { bias: 0, weight: 1 },
      questions: [
        { key: 'gate', instructions: 'Does this part help?', true: 'helps', false: 'does not', weight: 1 },
        ...Array.from({ length: 5 }, (_, index) => ({
          key: `k${index}`, instructions: `k${index} ${'y'.repeat(120)}`, true: 'a'.repeat(30), false: 'b'.repeat(30), weight: 1,
        })),
      ],
    };
    const decide = jev({ apiKey: 'test-key' });
    const picked = await pick([part(0, 'x'.repeat(300)), part(1, 'y'.repeat(300))], {
      ...uncutPick, task: 'notes?', decide, questionsBySource: { notes: cascade } });

    expect(picked.selected).toHaveLength(2);
    expect(bodies.length).toBeGreaterThanOrEqual(4);
    // The first request asks the gate question of both items; the
    // second asks the five follow-ups of the same items, so its state
    // is identical and only its questions grew.
    expect(bodies[0]!.body.state).toBe(bodies[1]!.body.state);
    expect(Object.keys(bodies[0]!.body.questions)).toHaveLength(2);
    expect(Object.keys(bodies[1]!.body.questions)).toHaveLength(10);
    expect(bodies[1]!.raw.length).toBeGreaterThan(2_000);
    for (const half of bodies.slice(2)) {
      expect(half.raw.length).toBeLessThanOrEqual(2_000);
      expect(Object.keys(half.body.questions)).toHaveLength(5);
    }
    for (const entry of picked.record.candidates) {
      expect(entry.questions?.every((question) => question.status === 'answered')).toBe(true);
    }
  });

  it('reports a request that never got a reply once, with its error, then fails the pick', async () => {
    const calls: JevCall[] = [];
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('socket hangup')));
    const decide = jev({ apiKey: 'test-key', onCall: (call) => { calls.push(call); } });
    await expect(pick([part(0, 'short text')], { ...uncutPick, task: 'notes?', decide }))
      .rejects.toThrow('socket hangup');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ questions: 1, status: 0, splits: 0 });
    expect(calls[0]!.error).toContain('socket hangup');
    expect(typeof calls[0]!.ms).toBe('number');
    expect(typeof calls[0]!.size).toBe('number');
    expect(typeof calls[0]!.started).toBe('string');
  });

  it('records a truncated resend through the onCall hook as one split', async () => {
    const calls: JevCall[] = [];
    const bodies = limited();
    const decide = jev({ apiKey: 'test-key', onCall: (call) => { calls.push(call); } });
    await pick([part(0, 'x'.repeat(50_000))], { ...uncutPick, task: 'notes?', decide });
    expect(calls.map((call) => call.splits)).toEqual([1, 1, 0]);
    expect(bodies).toHaveLength(3);
  });
});
