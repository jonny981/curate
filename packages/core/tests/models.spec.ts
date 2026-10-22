import { afterEach, describe, expect, it, vi } from 'vitest';
import { jev, openAIDecisions, chatWriter } from '../src/models.js';
import type { PickBatch } from '../src/pick.js';

afterEach(() => vi.unstubAllGlobals());

function reply(body: unknown, status = 200) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(body, { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const batch: PickBatch = {
  task: 'What billing constraint applies?',
  questions: [{
    key: '/docs/billing.md#1:relevant',
    role: 'reference',
    question: 'Does this help?',
    trueCriterion: 'It helps.',
    falseCriterion: 'It does not help.',
    sourceId: 'docs',
    id: '/docs/billing.md#1',
    title: 'Billing',
    text: 'Preserve the order currency.',
    kind: 'docs',
    date: { value: '2026-01-12', meaning: 'recorded' },
  }],
};

describe('decider identity', () => {
  it.each([
    { name: 'Jev', create: jev, model: 'jev-latest', id: 'typesafe:jev-latest' },
    { name: 'OpenAI Decisions', create: openAIDecisions, model: 'gpt-6-luna', id: 'openai:gpt-6-luna' },
  ])('keeps $name identity across API keys and changes it with the model', ({ create, model, id }) => {
    const fetch = reply({});
    const first = create({ apiKey: 'first-secret' });
    const second = create({ apiKey: 'second-secret', model });
    const otherModel = create({ apiKey: 'first-secret', model: 'other-model' });

    expect(first.deciderId).toBe(id);
    expect(second.deciderId).toBe(id);
    expect(otherModel.deciderId).not.toBe(id);
    expect(otherModel.deciderId).toContain('other-model');
    expect([first.deciderId, second.deciderId, otherModel.deciderId].join(' ')).not.toContain('secret');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps different providers separate even with the same model name', () => {
    const typesafe = jev({ apiKey: 'test-key', model: 'same-model' });
    const openai = openAIDecisions({ apiKey: 'test-key', model: 'same-model' });
    expect(typesafe.deciderId).not.toBe(openai.deciderId);
  });
});

describe('jev', () => {
  it('sends evidence and criteria under safe question names and restores the caller keys', async () => {
    const fetch = reply({ model: 'jev-latest', answers: { q0: { type: 'noul', noul: 0.8 } } });
    const signal = new AbortController().signal;
    const answers = await jev({ apiKey: 'test-key' })(batch, signal);

    expect(answers).toEqual({ '/docs/billing.md#1:relevant': { status: 'answered', probability: 0.8 } });
    expect(fetch).toHaveBeenCalledWith('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      signal,
      body: expect.any(String),
    });
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({
      model: 'jev-latest',
      state: 'What billing constraint applies?',
      questions: {
        q0: {
          type: 'noul',
          instructions: 'Does this help?\n\nEvidence: {"sourceId":"docs","id":"/docs/billing.md#1","role":"reference","kind":"docs","date":{"value":"2026-01-12","meaning":"recorded"},"title":"Billing","text":"Preserve the order currency."}',
          criteria: { true: 'It helps.', false: 'It does not help.' },
        },
      },
    });
  });

  it('uses a caller-selected model', async () => {
    const fetch = reply({ answers: { q0: { noul: 1 } } });
    await jev({ apiKey: 'test-key', model: 'jev-custom' })(batch, new AbortController().signal);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body)).model).toBe('jev-custom');
  });

  it('keeps probabilities at both bounds and marks invalid or absent answers missing', async () => {
    reply({ answers: {
      q0: { noul: 0 }, q1: { noul: 1 }, q2: { noul: -0.1 }, q3: { noul: 1.1 },
      q4: { noul: '0.8' }, q5: { noul: null }, q6: null,
    } });
    const questions = Array.from({ length: 8 }, (_, index) => ({ ...batch.questions[0]!, key: `key-${index}` }));
    const answers = await jev({ apiKey: 'test-key' })({ ...batch, questions }, new AbortController().signal);
    expect(answers).toEqual({
      'key-0': { status: 'answered', probability: 0 },
      'key-1': { status: 'answered', probability: 1 },
      'key-2': { status: 'missing' },
      'key-3': { status: 'missing' },
      'key-4': { status: 'missing' },
      'key-5': { status: 'missing' },
      'key-6': { status: 'missing' },
      'key-7': { status: 'missing' },
    });
  });

  it.each([{}, null])('marks answers missing when the response has no answers: %j', async (body) => {
    reply(body);
    await expect(jev({ apiKey: 'test-key' })(batch, new AbortController().signal))
      .resolves.toEqual({ '/docs/billing.md#1:relevant': { status: 'missing' } });
  });
});

describe('openAIDecisions', () => {
  it('sends named predicate questions and maps reordered answers and refusals to caller keys', async () => {
    const fetch = reply({ answers: [
      { name: 'q2', type: 'refusal' },
      { name: 'q1', type: 'predicate', probability: 1 },
      { name: 'q0', type: 'predicate', probability: 0.8 },
    ] });
    const signal = new AbortController().signal;
    const questions = [batch.questions[0]!,
      { ...batch.questions[0]!, key: 'second:key' },
      { ...batch.questions[0]!, key: 'third:key' }];
    const answers = await openAIDecisions({ apiKey: 'test-key' })({ ...batch, questions }, signal);

    expect(answers).toEqual({
      '/docs/billing.md#1:relevant': { status: 'answered', probability: 0.8 },
      'second:key': { status: 'answered', probability: 1 },
      'third:key': { status: 'refused' },
    });
    expect(fetch).toHaveBeenCalledWith('https://api.openai.com/v1/decisions', {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      signal,
      body: expect.any(String),
    });
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({
      model: 'gpt-6-luna',
      input: 'What billing constraint applies?',
      questions: [{
        type: 'predicate',
        name: 'q0',
        instructions: 'Does this help?\nTrue: It helps.\nFalse: It does not help.\nEvidence: {"sourceId":"docs","id":"/docs/billing.md#1","role":"reference","kind":"docs","date":{"value":"2026-01-12","meaning":"recorded"},"title":"Billing","text":"Preserve the order currency."}',
      }, expect.objectContaining({ type: 'predicate', name: 'q1' }),
      expect.objectContaining({ type: 'predicate', name: 'q2' })],
    });
  });

  it('uses a caller-selected model', async () => {
    const fetch = reply({ answers: [{ name: 'q0', type: 'predicate', probability: 0 }] });
    await openAIDecisions({ apiKey: 'test-key', model: 'custom-decider' })(batch, new AbortController().signal);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body)).model).toBe('custom-decider');
  });

  it('keeps zero and marks invalid, absent or wrong-type probabilities missing', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(`{"answers":[
      {"name":"q0","type":"predicate","probability":0},
      {"name":"q1","type":"predicate","probability":-0.1},
      {"name":"q2","type":"predicate","probability":1.1},
      {"name":"q3","type":"predicate","probability":"0.8"},
      {"name":"q4","type":"predicate","probability":1e999},
      {"name":"q5","type":"predicate"},
      {"name":"q6","type":"other","probability":0.8},
      null
    ]}`));
    vi.stubGlobal('fetch', fetch);
    const questions = Array.from({ length: 8 }, (_, index) => ({ ...batch.questions[0]!, key: `key-${index}` }));
    await expect(openAIDecisions({ apiKey: 'test-key' })({ ...batch, questions }, new AbortController().signal))
      .resolves.toEqual({
        'key-0': { status: 'answered', probability: 0 },
        'key-1': { status: 'missing' },
        'key-2': { status: 'missing' },
        'key-3': { status: 'missing' },
        'key-4': { status: 'missing' },
        'key-5': { status: 'missing' },
        'key-6': { status: 'missing' },
        'key-7': { status: 'missing' },
      });
  });

  it.each([{}, null])('marks answers missing when the response has no answers: %j', async (body) => {
    reply(body);
    await expect(openAIDecisions({ apiKey: 'test-key' })(batch, new AbortController().signal))
      .resolves.toEqual({ '/docs/billing.md#1:relevant': { status: 'missing' } });
  });

  it.each([undefined, ''])('rejects a missing API key before making a request: %j', (apiKey) => {
    const fetch = reply({});
    expect(() => openAIDecisions({ apiKey })).toThrow(/API key/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports an HTTP error', async () => {
    reply({ error: 'unavailable' }, 503);
    await expect(openAIDecisions({ apiKey: 'test-key' })(batch, new AbortController().signal))
      .rejects.toThrow('HTTP 503');
  });
});

describe('chatWriter', () => {
  it('sends the instructions and evidence to Chat Completions and returns the reply', async () => {
    const fetch = reply({ choices: [{ message: { role: 'assistant', content: 'A dated log.' } }] });
    const signal = new AbortController().signal;
    const write = chatWriter({ apiKey: 'test-key', model: 'writer-model' });
    await expect(write({ instructions: 'Cite each fact.', body: 'Evidence.' }, signal)).resolves.toBe('A dated log.');
    expect(fetch).toHaveBeenCalledWith('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({ model: 'writer-model', messages: [
        { role: 'system', content: 'Cite each fact.' },
        { role: 'user', content: 'Evidence.' },
      ] }),
    });
  });

  it('accepts an empty reply from a custom provider for a later curation batch', async () => {
    const fetch = reply({ choices: [{ message: { content: '' } }] });
    const write = chatWriter({ apiKey: 'test-key', model: 'writer-model', url: 'https://example.test/chat' });
    await expect(write({ instructions: '', body: '' }, new AbortController().signal)).resolves.toBe('');
    expect(fetch.mock.calls[0]![0]).toBe('https://example.test/chat');
  });

  it.each([{}, null, { choices: [] }, { choices: [{ message: { content: null } }] }])(
    'rejects a response with no text reply: %j', async (body) => {
      reply(body);
      await expect(chatWriter({ apiKey: 'test-key', model: 'writer-model' })(
        { instructions: '', body: '' }, new AbortController().signal,
      )).rejects.toThrow('Writer returned no log.');
    },
  );
});

describe('model request errors', () => {
  it.each([undefined, ''])('rejects a missing API key before either factory can make a request: %j', (apiKey) => {
    const fetch = reply({});
    expect(() => jev({ apiKey })).toThrow(/API key/);
    expect(() => chatWriter({ apiKey, model: 'writer-model' })).toThrow(/API key/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports HTTP errors from either provider', async () => {
    reply({ error: 'unavailable' }, 503);
    const signal = new AbortController().signal;
    await expect(jev({ apiKey: 'test-key' })(batch, signal)).rejects.toThrow('HTTP 503');
    await expect(chatWriter({ apiKey: 'test-key', model: 'writer-model' })(
      { instructions: '', body: '' }, signal,
    )).rejects.toThrow('HTTP 503');
  });
});
