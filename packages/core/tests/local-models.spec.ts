import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { chatWriter, jev, localDecisions } from '../src/models.js';
import type { PickBatch } from '../src/pick.js';

/** A server on 127.0.0.1 that keeps each request and answers with `reply`. */
async function serve(reply: (body: Record<string, unknown>) => unknown) {
  const requests: { url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
  const server = createServer((request, response) => {
    let text = '';
    request.on('data', (chunk) => { text += chunk; });
    request.on('end', () => {
      const body = JSON.parse(text) as Record<string, unknown>;
      requests.push({ url: request.url ?? '', headers: request.headers, body });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(reply(body)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { requests, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

const batch: PickBatch = {
  task: 'What billing constraint applies?',
  questions: [{
    key: 'billing:relevant',
    role: 'reference',
    question: 'Does this help?',
    trueCriterion: 'It helps.',
    falseCriterion: 'It does not help.',
    sourceId: 'docs',
    id: '/docs/billing.md#1',
    title: 'Billing',
    text: 'Preserve the order currency.',
    date: { value: '2026-01-12', meaning: 'recorded' },
  }],
};

/** A chat reply whose first token carries these top log-probabilities. */
const topLogprobs = (top: Record<string, number>) => ({
  choices: [{ message: { content: 'x' }, logprobs: { content: [{ token: 'x', logprob: 0,
    top_logprobs: Object.entries(top).map(([token, logprob]) => ({ token, logprob })) }] } }],
});

describe('localDecisions', () => {
  it('asks one question a request, with the task, the criteria and the item, and no key', async () => {
    const { requests, base } = await serve(() => topLogprobs({ yes: -0.1, no: -2.4 }));
    const decide = localDecisions({ url: `${base}/v1/chat/completions`, model: 'local' });
    const two = { ...batch, questions: [batch.questions[0]!, { ...batch.questions[0]!, key: 'second' }] };
    await decide(two, new AbortController().signal);

    expect(requests).toHaveLength(2);
    expect(requests[0]!.url).toBe('/v1/chat/completions');
    expect(requests[0]!.headers.authorization).toBeUndefined();
    const body = requests[0]!.body;
    expect(body).toMatchObject({ model: 'local', max_tokens: 1, temperature: 0, logprobs: true, top_logprobs: 20 });
    const [system, user] = body.messages as { role: string; content: string }[];
    expect(system!.role).toBe('system');
    expect(system!.content).toMatch(/one word, yes or no/);
    for (const part of ['What billing constraint applies?', 'Does this help?', 'It helps.', 'It does not help.',
      '/docs/billing.md#1 (recorded 2026-01-12)', 'Billing', 'Preserve the order currency.']) {
      expect(user!.content).toContain(part);
    }
  });

  it('sends a key when given one', async () => {
    const { requests, base } = await serve(() => topLogprobs({ yes: 0 }));
    await localDecisions({ url: `${base}/v1/chat/completions`, model: 'local', apiKey: 'test-key' })(
      batch, new AbortController().signal);
    expect(requests[0]!.headers.authorization).toBe('Bearer test-key');
  });

  it.each<{ top: Record<string, number>; expected: number; digits: number }>([
    { top: { yes: -0.1, no: -2.4 }, expected: 0.909, digits: 3 },
    { top: { ' Yes': -0.7, yes: -1.2, No: -0.9 },
      expected: (Math.exp(-0.7) + Math.exp(-1.2)) / (Math.exp(-0.7) + Math.exp(-1.2) + Math.exp(-0.9)), digits: 10 },
  ])('reads yes over yes plus no from the first token: $top', async ({ top, expected, digits }) => {
    const { base } = await serve(() => topLogprobs(top));
    const answers = await localDecisions({ url: `${base}/v1/chat/completions`, model: 'local' })(
      batch, new AbortController().signal);
    expect(answers['billing:relevant']).toEqual({ status: 'answered', probability: expect.closeTo(expected, digits) });
  });

  it('marks the answer missing when neither yes nor no is among the top tokens', async () => {
    const { base } = await serve(() => topLogprobs({ maybe: -0.1 }));
    await expect(localDecisions({ url: `${base}/v1/chat/completions`, model: 'local' })(
      batch, new AbortController().signal)).resolves.toEqual({ 'billing:relevant': { status: 'missing' } });
  });

  it('throws when the server returns no log-probabilities', async () => {
    const { base } = await serve(() => ({ choices: [{ message: { content: 'yes' } }] }));
    const url = `${base}/v1/chat/completions`;
    await expect(localDecisions({ url, model: 'local' })(batch, new AbortController().signal)).rejects.toThrow(
      `The model server at ${url} returned no log-probabilities; localDecisions needs a server that does.`);
  });

  it('records the server and the model in its deciderId', async () => {
    expect(localDecisions({ url: 'http://127.0.0.1:8000/v1/chat/completions', model: 'local' }).deciderId)
      .toBe('local:127.0.0.1:8000/v1/chat/completions:local');
  });

  it('sends nothing after the signal is aborted', async () => {
    const { requests, base } = await serve(() => topLogprobs({ yes: 0 }));
    const controller = new AbortController();
    controller.abort();
    await expect(localDecisions({ url: `${base}/v1/chat/completions`, model: 'local' })(batch, controller.signal))
      .rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
});

describe('jev at another address', () => {
  it('posts to the given url with no authorization header when there is no key', async () => {
    const { requests, base } = await serve(() => ({ answers: { q0: { noul: 0.7 } } }));
    const decide = jev({ url: `${base}/v1/systemone`, model: 'clef-flash' });
    await expect(decide(batch, new AbortController().signal))
      .resolves.toEqual({ 'billing:relevant': { status: 'answered', probability: 0.7 } });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('/v1/systemone');
    expect(requests[0]!.headers.authorization).toBeUndefined();
    expect(requests[0]!.body.model).toBe('clef-flash');
  });

  it('records the server in its deciderId', () => {
    expect(jev({ url: 'http://127.0.0.1:30000/v1/systemone', model: 'clef-flash' }).deciderId)
      .toBe('jev:127.0.0.1:30000/v1/systemone:clef-flash:items-once');
  });

  it.each([undefined, ''])('still requires a key at the default address: %j', (apiKey) => {
    expect(() => jev({ apiKey })).toThrow(/API key/);
    expect(() => jev({})).toThrow(/API key/);
  });
});

describe('chatWriter at another address', () => {
  it('posts with no authorization header when there is no key', async () => {
    const { requests, base } = await serve(() => ({ choices: [{ message: { content: 'A dated log.' } }] }));
    const write = chatWriter({ url: `${base}/v1/chat/completions`, model: 'local' });
    await expect(write({ instructions: 'Cite.', body: 'Evidence.' }, new AbortController().signal))
      .resolves.toBe('A dated log.');
    expect(requests[0]!.headers.authorization).toBeUndefined();
  });

  it.each([undefined, ''])('still requires a key at the default address: %j', (apiKey) => {
    expect(() => chatWriter({ apiKey, model: 'writer-model' })).toThrow(/API key/);
    expect(() => chatWriter({ model: 'writer-model' })).toThrow(/API key/);
  });
});
