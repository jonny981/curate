import { afterEach, describe, expect, it, vi } from 'vitest';
import { DecisionServiceError, jev } from '../src/models.js';
import { pick, PickError, type MemoryCandidate } from '../src/pick.js';

afterEach(() => vi.unstubAllGlobals());

const parts: MemoryCandidate[] = Array.from({ length: 40 }, (_, index) => ({
  sourceId: 'notes', id: `notes/a-long-path/to-a-note-${index}.md#${index}`, role: 'reference',
  title: `Part ${index}`, text: `part ${index}`, signals: { keyword: 1 },
}));
const BILLING = JSON.stringify({ detail: { error_type: 'billing_error', message: 'Your organization has no available TypeSafe API credits. Please add more credits and/or set up auto-reload at https://console.typesafe.ai/settings/billing' } });

/** The pick's failure when every request gets `reply`. */
async function failure(reply: () => Response | Promise<Response>): Promise<PickError> {
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async () => reply()));
  return pick(parts, { task: 'Which database?', decide: jev({ apiKey: 'test-key' }), everyRanked: true, everyScored: true })
    .then(() => { throw new Error('the pick resolved'); }, (reason: unknown) => reason as PickError);
}

describe('a decide call the decision service refuses', () => {
  it('leads with no credit and the service\'s own message when it answers 402, and counts the parts it left', async () => {
    const error = await failure(() => new Response(BILLING, { status: 402 }));
    expect(error).toBeInstanceOf(PickError);
    expect(error.message.split('\n')[0]).toBe('The decide call failed. The decision service has no credit (HTTP 402): '
      + 'Your organization has no available TypeSafe API credits. Please add more credits and/or set up auto-reload at https://console.typesafe.ai/settings/billing');
    expect(error.message).not.toContain(parts[0]!.id);
    expect(error.message).toContain(`${error.record.decideError!.candidates.length} parts of the refused request were not decided; record.decideError lists the ids.`);
    expect(error.record.decideError!.candidates.length).toBeGreaterThan(0);
    expect(error.cause).toBeInstanceOf(DecisionServiceError);
    expect(error.cause).toMatchObject({ status: 402, reason: 'credit', reply: BILLING });
  });

  it('says the key was refused when it answers 401', async () => {
    const error = await failure(() => Response.json({ detail: 'Invalid API key' }, { status: 401 }));
    expect(error.message.split('\n')[0]).toBe('The decide call failed. The decision service refused the API key (HTTP 401): Invalid API key');
    expect(error.cause).toMatchObject({ status: 401, reason: 'key' });
  });

  it('says it could not reach the service when the request gets no reply', async () => {
    const error = await failure(() => { throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND api.typesafe.ai') }); });
    expect(error.message.split('\n')[0]).toBe('The decide call failed. The decision service could not be reached: fetch failed (getaddrinfo ENOTFOUND api.typesafe.ai)');
    expect(error.cause).toMatchObject({ status: 0, reason: 'unreachable' });
  });

  it('names any other refusal with its status and body', async () => {
    const error = await failure(() => new Response('upstream overloaded', { status: 503 }));
    expect(error.message.split('\n')[0]).toBe('The decide call failed. The decision service refused the request (HTTP 503): upstream overloaded');
    expect(error.cause).toMatchObject({ status: 503, reason: 'refused' });
  });

  it('says the service is still rate-limiting when a 429 asks for a wait past the minute', async () => {
    const error = await failure(() => new Response('quota spent', { status: 429, headers: { 'retry-after': '120' } }));
    expect(error.message.split('\n')[0]).toBe('The decide call failed. The decision service is still rate-limiting requests (HTTP 429) '
      + 'after 0 s; a rate-limited request waits at most 60 s, and the last reply asked for 120 s more (Retry-After: 120): quota spent');
    expect(error.cause).toBeInstanceOf(DecisionServiceError);
    expect(error.cause).toMatchObject({ status: 429, reason: 'busy' });
  });

  it('waits out a 429 and decides as usual', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      calls += 1;
      if (calls === 1) return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } });
      const body = JSON.parse(String(init!.body)) as { questions: Record<string, unknown> };
      return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map((name) => [name, { noul: 0.7 }])) });
    }));
    const result = await pick(parts.slice(0, 2), { task: 'Which database?', decide: jev({ apiKey: 'test-key' }), everyRanked: true, everyScored: true });
    expect(result.selected).toHaveLength(2);
    expect(calls).toBe(2);
  });
});
