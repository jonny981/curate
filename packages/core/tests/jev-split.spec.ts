import { afterEach, describe, expect, it, vi } from 'vitest';
import { jev, type JevCall } from '../src/models.js';
import { pick, type MemoryCandidate, type PickBatch } from '../src/pick.js';

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

describe('Jev request dispatch', () => {
  it('waits for the rate-limit wait a reply names and resends the same request', async () => {
    const bodies: string[] = [];
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      bodies.push(String(init!.body));
      calls += 1;
      if (calls === 1) return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } });
      return Response.json({ usage: { input_tokens: 10, output_tokens: 1 }, answers: { q0: { noul: 0.7 } } });
    }));
    const recorded: JevCall[] = [];
    const decide = jev({ apiKey: 'test-key', onCall: (call) => { recorded.push(call); } });
    const answers = await decide({ task: 'notes?', questions: [{
      key: 'q', sourceId: 's', id: '1', role: 'reference', question: 'Relevant?',
      trueCriterion: 'yes', falseCriterion: 'no', title: 'part', text: 'text',
    }] }, AbortSignal.timeout(10_000));
    expect(calls).toBe(2);
    // A rate-limited request is resent unchanged, never split.
    expect(bodies[0]).toBe(bodies[1]);
    expect(recorded.map((call) => call.status)).toEqual([429, 200]);
    expect(recorded.every((call) => call.splits === 0)).toBe(true);
    expect(answers.q).toMatchObject({ status: 'answered', probability: 0.7 });
  });

  it('lets 80 sends go at once and spreads further sends across seconds', async () => {
    vi.useFakeTimers();
    try {
      const sent: number[] = [];
      vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
        sent.push(Date.now());
        return Response.json({ answers: { q0: { noul: 0.5 } } });
      }));
      const decide = jev({ apiKey: 'test-key' });
      const signal = AbortSignal.timeout(60_000);
      const runs = Array.from({ length: 100 }, (_, index) => decide({ task: 'notes?', questions: [{
        key: `q${index}`, sourceId: 's', id: `${index}`, role: 'reference', question: 'Relevant?',
        trueCriterion: 'yes', falseCriterion: 'no', title: 'part', text: `text ${index}`,
      }] }, signal));
      await vi.advanceTimersByTimeAsync(1);
      // 80 requests a second: the rest wait for allowance to refill.
      expect(sent).toHaveLength(80);
      await vi.advanceTimersByTimeAsync(400);
      expect(sent).toHaveLength(100);
      await Promise.all(runs);
    } finally { vi.useRealTimers(); }
  });

  it('spends estimated tokens from the same refilling allowance', async () => {
    vi.useFakeTimers();
    try {
      const sent: number[] = [];
      vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
        sent.push(Date.now());
        return Response.json({ answers: { q0: { noul: 0.5 } } });
      }));
      const decide = jev({ apiKey: 'test-key' });
      const signal = AbortSignal.timeout(60_000);
      // ~67,000 estimated tokens a send at three characters a token.
      const big = 'x'.repeat(200_000);
      const runs = [0, 1].map((index) => decide({ task: 'notes?', questions: [{
        key: `q${index}`, sourceId: 's', id: `${index}`, role: 'reference', question: 'Relevant?',
        trueCriterion: 'yes', falseCriterion: 'no', title: 'part', text: big,
      }] }, signal));
      await vi.advanceTimersByTimeAsync(1);
      // 100,000 tokens a second: the first send spent two thirds of it.
      expect(sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(200);
      expect(sent).toHaveLength(1);
      // ~330 ms of refill gives the second send its tokens.
      await vi.advanceTimersByTimeAsync(200);
      expect(sent).toHaveLength(2);
      await Promise.all(runs);
    } finally { vi.useRealTimers(); }
  });

  it('sends split children only as the refilled allowance allows', async () => {
    vi.useFakeTimers();
    try {
      const sent: number[] = [];
      let rejected = false;
      vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
        sent.push(Date.now());
        const body = JSON.parse(String(init!.body)) as { state: string; questions: Record<string, unknown> };
        // Only the first oversized request is rejected; its children fit.
        if (!rejected && body.state.length > 5_000) {
          rejected = true;
          return new Response('request too large', { status: 400 });
        }
        return Response.json({
          answers: Object.fromEntries(Object.keys(body.questions).map((name) => [name, { noul: 0.5 }])),
        });
      }));
      const decide = jev({ apiKey: 'test-key' });
      const signal = AbortSignal.timeout(60_000);
      const small = Array.from({ length: 80 }, (_, index) => decide({ task: 'notes?', questions: [{
        key: `q${index}`, sourceId: 's', id: `${index}`, role: 'reference', question: 'Relevant?',
        trueCriterion: 'yes', falseCriterion: 'no', title: 'part', text: `text ${index}`,
      }] }, signal));
      // One batch whose two items share a request too big for the
      // service's limit: it is sent as the 81st send, then splits.
      const wide = decide({ task: 'notes?', questions: [0, 1].map((index) => ({
        key: `w${index}`, sourceId: 's', id: `w${index}`, role: 'reference' as const, question: 'Relevant?',
        trueCriterion: 'yes', falseCriterion: 'no', title: 'part', text: 'x'.repeat(4_000),
      })) }, signal);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toHaveLength(80);
      await vi.advanceTimersByTimeAsync(30);
      // The parent went out on the refill and was rejected; its halves
      // wait behind it and send one refill at a time.
      expect(sent).toHaveLength(82);
      await vi.advanceTimersByTimeAsync(60);
      expect(sent).toHaveLength(83);
      const answers = await wide;
      expect(Object.values(answers).every((answer) => answer.status === 'answered')).toBe(true);
      await Promise.all(small);
    } finally { vi.useRealTimers(); }
  });

  it('stops sends still waiting for allowance when a request fails terminally', async () => {
    vi.useFakeTimers();
    try {
      const sent: number[] = [];
      let first = true;
      vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
        sent.push(Date.now());
        if (first) { first = false; return new Response('server error', { status: 500 }); }
        return Response.json({ answers: { q0: { noul: 0.5 } } });
      }));
      const decide = jev({ apiKey: 'test-key' });
      const signal = AbortSignal.timeout(60_000);
      const runs = Array.from({ length: 90 }, (_, index) =>
        decide({ task: 'notes?', questions: [{
          key: `q${index}`, sourceId: 's', id: `${index}`, role: 'reference', question: 'Relevant?',
          trueCriterion: 'yes', falseCriterion: 'no', title: 'part', text: `text ${index}`,
        }] }, signal).then(
          (answers) => ({ ok: true as const, answers }),
          (error: unknown) => ({ ok: false as const, error })));
      await vi.advanceTimersByTimeAsync(1);
      // The first second's 80 went out; ten more waited for the refill.
      expect(sent).toHaveLength(80);
      await vi.advanceTimersByTimeAsync(10_000);
      // The failure ended the queued sends: they never reached fetch.
      expect(sent).toHaveLength(80);
      const outcomes = await Promise.all(runs);
      expect(outcomes[0]).toMatchObject({ ok: false });
      expect(String((outcomes[0] as { error: unknown }).error)).toContain('HTTP 500');
      expect(outcomes.slice(1, 80).every((outcome) => outcome.ok)).toBe(true);
      // The sends the failure dropped carry its own reason.
      for (const outcome of outcomes.slice(80)) {
        expect(outcome.ok).toBe(false);
        expect(String((outcome as { error: unknown }).error)).toContain('HTTP 500');
      }
    } finally { vi.useRealTimers(); }
  });

  it('stops a send still waiting for allowance when its own signal aborts', async () => {
    vi.useFakeTimers();
    try {
      const sent: number[] = [];
      vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
        sent.push(Date.now());
        return Response.json({ answers: { q0: { noul: 0.5 } } });
      }));
      const decide = jev({ apiKey: 'test-key' });
      const signal = AbortSignal.timeout(60_000);
      const control = new AbortController();
      const runs = Array.from({ length: 80 }, (_, index) => decide({ task: 'notes?', questions: [{
        key: `q${index}`, sourceId: 's', id: `${index}`, role: 'reference', question: 'Relevant?',
        trueCriterion: 'yes', falseCriterion: 'no', title: 'part', text: `text ${index}`,
      }] }, signal));
      const held = decide({ task: 'notes?', questions: [{
        key: 'q', sourceId: 's', id: 'held', role: 'reference', question: 'Relevant?',
        trueCriterion: 'yes', falseCriterion: 'no', title: 'part', text: 'held text',
      }] }, control.signal).then(() => 'answered', (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toHaveLength(80);
      control.abort(new Error('caller gave up'));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sent).toHaveLength(80);
      const outcome = await held;
      expect(outcome).toBeInstanceOf(Error);
      expect(String((outcome as Error).message)).toContain('caller gave up');
      await Promise.all(runs);
    } finally { vi.useRealTimers(); }
  });

  it('decides again on a later pick after a terminal failure', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      n += 1;
      if (n === 1) return new Response('server error', { status: 500 });
      return Response.json({ answers: { q0: { noul: 0.7 } } });
    }));
    const decide = jev({ apiKey: 'test-key' });
    await expect(pick([part(0, 'short text')], { ...uncutPick, task: 'notes?', decide }))
      .rejects.toThrow('HTTP 500');
    // The failure stopped that pick's sends, not the adapter: the same
    // decide answers a later pick once the service recovers.
    const picked = await pick([part(0, 'short text')], { ...uncutPick, task: 'notes?', decide });
    expect(picked.selected).toHaveLength(1);
  });

  it('stops queued sends before the failure\'s record write can wait on them', async () => {
    vi.useFakeTimers();
    try {
      const sent: number[] = [];
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let first = true;
      vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
        sent.push(Date.now());
        if (first) { first = false; return new Response('server error', { status: 500 }); }
        return Response.json({ answers: { q0: { noul: 0.5 } } });
      }));
      // The shipped record save is asynchronous: the failure's write is
      // held open while request 81 waits for allowance behind it.
      const decide = jev({ apiKey: 'test-key', onCall: async (call) => {
        if (call.status === 500) await gate;
      } });
      const signal = AbortSignal.timeout(60_000);
      const runs = Array.from({ length: 81 }, (_, index) =>
        decide({ task: 'notes?', questions: [{
          key: `q${index}`, sourceId: 's', id: `${index}`, role: 'reference', question: 'Relevant?',
          trueCriterion: 'yes', falseCriterion: 'no', title: 'part', text: `text ${index}`,
        }] }, signal).then(() => 'ok', (error: unknown) => error));
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toHaveLength(80);
      // The queued send was dropped before the held-open write began:
      // no refill lets it through while the write is still open.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sent).toHaveLength(80);
      release();
      const outcomes = await Promise.all(runs);
      expect(outcomes[0]).toBeInstanceOf(Error);
      expect(String((outcomes[0] as Error).message)).toContain('HTTP 500');
      expect(outcomes.slice(1, 80).every((outcome) => outcome === 'ok')).toBe(true);
      expect(outcomes[80]).toBeInstanceOf(Error);
      expect(String((outcomes[80] as Error).message)).toContain('HTTP 500');
    } finally { vi.useRealTimers(); }
  });

  it('settles every started subrequest before a failure returns', async () => {
    const calls: JevCall[] = [];
    let sent = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      sent += 1;
      const body = JSON.parse(String(init!.body)) as JevBody;
      if (body.state.includes('aaaa')) return new Response('server error', { status: 500 });
      await gate;
      return Response.json({ answers: { q0: { noul: 0.5 } } });
    }));
    const decide = jev({ apiKey: 'test-key', onCall: (call) => { calls.push(call); } });
    let recordedAtThrow = -1;
    // Each item is too large to share one request, so the batch plans
    // two subrequests; the second's reply is held past the failure.
    const outcome = decide({ task: 'notes?', questions: [
      { key: 'qa', sourceId: 's', id: 'a', role: 'reference', question: 'Relevant?',
        trueCriterion: 'yes', falseCriterion: 'no', title: 'part a', text: `aaaa ${'x'.repeat(100_000)}` },
      { key: 'qb', sourceId: 's', id: 'b', role: 'reference', question: 'Relevant?',
        trueCriterion: 'yes', falseCriterion: 'no', title: 'part b', text: `bbbb ${'x'.repeat(100_000)}` },
    ] }, AbortSignal.timeout(60_000)).then(
      (answers) => answers,
      (error: unknown) => { recordedAtThrow = calls.length; return error; });
    await vi.waitFor(() => expect(sent).toBe(2));
    release();
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toContain('HTTP 500');
    // The sibling's 200 was reported before the failure returned.
    expect(recordedAtThrow).toBe(2);
    expect(calls.map((call) => call.status).sort((a, b) => a - b)).toEqual([200, 500]);
  });

  it('settles a rejected request\'s split children before the failure returns', async () => {
    const calls: JevCall[] = [];
    let sent = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      sent += 1;
      const body = JSON.parse(String(init!.body)) as JevBody;
      if (sent === 1) return new Response('request too large', { status: 400 });
      if (body.state.includes('bbbb')) return new Response('half failed', { status: 500 });
      await gate;
      return Response.json({ answers: { q0: { noul: 0.5 } } });
    }));
    const decide = jev({ apiKey: 'test-key', onCall: (call) => { calls.push(call); } });
    let recordedAtThrow = -1;
    const outcome = decide({ task: 'notes?', questions: [
      { key: 'qa', sourceId: 's', id: 'a', role: 'reference', question: 'Relevant?',
        trueCriterion: 'yes', falseCriterion: 'no', title: 'part a', text: 'aaaa' },
      { key: 'qb', sourceId: 's', id: 'b', role: 'reference', question: 'Relevant?',
        trueCriterion: 'yes', falseCriterion: 'no', title: 'part b', text: 'bbbb' },
    ] }, AbortSignal.timeout(60_000)).then(
      (answers) => answers,
      (error: unknown) => { recordedAtThrow = calls.length; return error; });
    await vi.waitFor(() => expect(sent).toBe(3));
    release();
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toContain('HTTP 500');
    // The succeeding half's 200 was reported before the failure returned.
    expect(recordedAtThrow).toBe(3);
    expect(calls.map((call) => call.status).sort((a, b) => a - b)).toEqual([200, 400, 500]);
    expect(calls.find((call) => call.status === 400)?.splits).toBe(2);
  });

  it('stops the failed pick\'s later batches still queued behind maxInFlight', async () => {
    const sent: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      sent.push(String(init!.body));
      if (sent.length === 1) return new Response('server error', { status: 500 });
      return Response.json({ answers: { q0: { noul: 0.7 } } });
    }));
    // The failure's record write is held open while the pick's later
    // batches queue up behind it.
    const decide = jev({ apiKey: 'test-key', onCall: async (call) => {
      if (call.status === 500) await gate;
    } });
    let called = 0;
    const counting = Object.assign((batch: PickBatch, signal: AbortSignal) => {
      called += 1;
      return decide(batch, signal);
    }, { deciderId: decide.deciderId });
    const promise = pick(Array.from({ length: 8 }, (_, index) => part(index, `text ${index}`)), {
      ...uncutPick, task: 'notes?', decide: counting, limits: { maxPerBatch: 2, maxInFlight: 2 } });
    await vi.waitFor(() => expect(called).toBe(3));
    // The third batch was dispatched but its send never reached fetch:
    // the pick's own failure had already stopped its waits.
    expect(sent).toHaveLength(2);
    release();
    await expect(promise).rejects.toThrow('HTTP 500');
    // The fourth batch was never even dispatched once the failure landed.
    expect(called).toBe(3);
    expect(sent).toHaveLength(2);
  });

  it('leaves another pick\'s sends waiting for allowance running when one fails', async () => {
    vi.useFakeTimers();
    try {
      const sent: number[] = [];
      let first = true;
      vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
        sent.push(Date.now());
        if (first) { first = false; return new Response('server error', { status: 500 }); }
        return Response.json({ answers: { q0: { noul: 0.5 } } });
      }));
      const decide = jev({ apiKey: 'test-key' });
      // Two picks through the one adapter, each under its own signal as
      // a pick hands every one of its batches the same signal object.
      const failed = decide({ task: 'notes?', questions: [{
        key: 'q', sourceId: 's', id: 'x', role: 'reference', question: 'Relevant?',
        trueCriterion: 'yes', falseCriterion: 'no', title: 'part', text: 'text',
      }] }, new AbortController().signal).then(() => 'ok', (error: unknown) => error);
      const other = AbortSignal.timeout(60_000);
      const runs = Array.from({ length: 80 }, (_, index) =>
        decide({ task: 'notes?', questions: [{
          key: `q${index}`, sourceId: 's', id: `${index}`, role: 'reference', question: 'Relevant?',
          trueCriterion: 'yes', falseCriterion: 'no', title: 'part', text: `text ${index}`,
        }] }, other).then(() => 'ok', (error: unknown) => error));
      await vi.advanceTimersByTimeAsync(1);
      // The failing pick's send went out in the first second's burst;
      // the other pick's last send still waits for the refill.
      expect(sent).toHaveLength(80);
      await vi.advanceTimersByTimeAsync(10_000);
      // The failure dropped none of the other pick's waits.
      expect(sent).toHaveLength(81);
      const outcome = await failed;
      expect(outcome).toBeInstanceOf(Error);
      expect(String((outcome as Error).message)).toContain('HTTP 500');
      expect((await Promise.all(runs)).every((result) => result === 'ok')).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('lets the adapter finish recording a timed-out request before the pick returns', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      })));
    let recorded: JevCall | undefined;
    let writeDone = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const decide = jev({ apiKey: 'test-key', onCall: async (call) => {
      recorded = call;
      await gate;
      writeDone = true;
    } });
    const promise = pick([part(0, 'short text')], {
      ...uncutPick, task: 'notes?', decide, limits: { maxElapsedMs: 20 } });
    let returned = false;
    void promise.then(() => { returned = true; }, () => { returned = true; });
    // The deadline fires, the request is aborted and its status-0 record
    // write begins; the pick waits for that write before it returns,
    // however long the write takes.
    await vi.waitFor(() => expect(recorded).toBeDefined());
    expect(returned).toBe(false);
    // Held open past a second, the unfinished write still holds the pick.
    await new Promise((resolve) => { setTimeout(resolve, 1_100); });
    expect(returned).toBe(false);
    expect(writeDone).toBe(false);
    release();
    await promise;
    expect(writeDone).toBe(true);
    expect(recorded).toMatchObject({ status: 0 });
  });
});
