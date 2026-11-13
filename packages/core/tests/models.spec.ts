import { afterEach, describe, expect, it, vi } from 'vitest';
import { jev, openAIDecisions } from '../src/models.js';
import { LABEL_KINDS, labelPartQuestion } from '../src/labels.js';
import { pick, type MemoryCandidate, type PickBatch, type PickQuestion } from '../src/pick.js';

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
    { name: 'Jev', create: jev, model: 'jev-latest', id: 'typesafe:jev-latest:item-records' },
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
  it('sends the item in the state, criteria under safe question names, and restores the caller keys', async () => {
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
      state: {
        task: 'What billing constraint applies?',
        items: {
          1: { id: '/docs/billing.md#1', date: 'recorded 2026-01-12', title: 'Billing', text: 'Preserve the order currency.' },
        },
      },
      questions: {
        q0: {
          type: 'noul',
          instructions: { question: 'Does this help?', item: 'items.1' },
          criteria: { true: 'It helps.', false: 'It does not help.' },
        },
      },
    });
  });

  it('puts a part\'s author in its record where the reader marked one, and a missing date as null', async () => {
    const fetch = reply({ answers: {} });
    const chatPart: PickQuestion = { ...batch.questions[0]!, key: 'chat', sourceId: 'chat', id: 'chat:1', title: 'a message',
      text: 'Use Postgres.', author: 'person' };
    const { date: _date, ...undated } = batch.questions[0]!;
    await jev({ apiKey: 'test-key' })({ ...batch, questions: [chatPart, undated] }, new AbortController().signal);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body)).state.items).toEqual({
      1: { id: 'chat:1', date: 'recorded 2026-01-12', title: 'a message', text: 'Use Postgres.', author: 'person' },
      2: { id: '/docs/billing.md#1', date: null, title: 'Billing', text: 'Preserve the order currency.' },
    });
  });

  it('carries a chat part\'s author from the pick to its record, and none for a part without one', async () => {
    const fetch = reply({ answers: {} });
    const candidate = (id: string, author?: 'person' | 'agent'): MemoryCandidate => ({
      sourceId: 'notes', id, role: 'reference', title: id, text: `text ${id}`, signals: { keyword: 1 },
      ...(author === undefined ? {} : { author, chat: { provider: 'claude-code', sessionId: 's', role: 'user' } }),
    });
    await pick([candidate('mine', 'person'), candidate('relayed', 'agent'), candidate('note')], {
      task: 'What did we decide?', everyRanked: true, everyScored: true, decide: jev({ apiKey: 'test-key' }),
    });
    const records = Object.values(JSON.parse(String(fetch.mock.calls[0]![1]!.body)).state.items) as Record<string, unknown>[];
    expect(Object.fromEntries(records.map((record) => [record.id, record.author]))).toEqual({ mine: 'person', relayed: 'agent', note: undefined });
    expect(records.find((record) => record.id === 'note')).not.toHaveProperty('author');
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

/** A fetch stub that keeps each request body and answers every question it names. */
function answering() {
  const bodies: string[] = [];
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
    const body = String(init!.body);
    bodies.push(body);
    const sent = JSON.parse(body) as { questions: Record<string, unknown> };
    return Response.json({ answers: Object.fromEntries(Object.keys(sent.questions).map((name) => [name, { noul: 0.5 }])) });
  }));
  return bodies;
}

/** A part asked the seven label kinds, as a pick asks it. */
function labelled(index: number, text: string): PickQuestion[] {
  const id = `chat:claude-code:/sessions/${String(index).padStart(4, '0')}`.padEnd(120, 'x');
  return LABEL_KINDS.map((kind) => ({
    key: JSON.stringify(['chat', id, kind.key]), questionKey: kind.key, role: 'reference' as const,
    ...labelPartQuestion(kind), sourceId: 'chat', id, title: `part ${index}`, text,
    date: { value: '2026-01-12', meaning: 'recorded' },
  }));
}

type JevBody = {
  state: { task: string; items: Record<string, { text: string }> };
  questions: Record<string, { instructions: { question: string; item: string }; criteria: { true: string; false: string } }>;
};

describe('jev request size', () => {
  it('sends each part once, in the state, and each question names its item', async () => {
    const texts = [0, 1].map((index) => `text of part ${index} `.repeat(50).slice(0, 700));
    const bodies = answering();
    await jev({ apiKey: 'test' })({ task: 'Label the parts.', questions: texts.flatMap((text, index) => labelled(index, text)) },
      new AbortController().signal);

    expect(bodies).toHaveLength(1);
    const body = JSON.parse(bodies[0]!) as JevBody;
    for (const text of texts) expect(bodies[0]!.split(text)).toHaveLength(2);
    expect(Object.values(body.state.items).map((item) => item.text)).toEqual(texts);
    const questions = Object.values(body.questions);
    expect(questions).toHaveLength(14);
    for (const [index, question] of questions.entries()) {
      for (const text of texts) expect(JSON.stringify(question.instructions)).not.toContain(text);
      expect(question.instructions.item).toBe(`items.${index < 7 ? 1 : 2}`);
    }

    const twenty = answering();
    await jev({ apiKey: 'test' })({ task: 'Label the parts.', questions: Array.from({ length: 20 }, (_, index) =>
      labelled(index, `text of part ${index} `.repeat(50).slice(0, 700))).flat() }, new AbortController().signal);
    console.log(`20 parts asked seven label kinds: ${twenty.length} request(s), body ${twenty.reduce((sum, body) => sum + body.length, 0)} characters`);
  });

  /** What a request's state plus its longest question hold, in characters
   *  as sent: field names, quotes and escapes included. */
  const stateAndLongest = (body: JevBody) => JSON.stringify(body.state).length + Math.max(...Object.values(body.questions)
    .map((q) => JSON.stringify(q.instructions).length + q.criteria.true.length + q.criteria.false.length));

  it('splits a batch so each request stays inside the bounds and keeps an item with its questions', async () => {
    const texts = Array.from({ length: 20 }, (_, index) => `${String(index).padStart(2, '0')} ${'long part text '.repeat(700)}`.slice(0, 10_000));
    expect(texts.join('').length).toBe(200_000);
    const batch: PickBatch = { task: 'Label the parts.', questions: texts.flatMap((text, index) => labelled(index, text)) };
    const bodies = answering();
    const answers = await jev({ apiKey: 'test' })(batch, new AbortController().signal);

    expect(bodies.length).toBeGreaterThanOrEqual(3);
    for (const raw of bodies) {
      const body = JSON.parse(raw) as JevBody;
      expect(stateAndLongest(body)).toBeLessThanOrEqual(96_000);
      expect(raw.length).toBeLessThanOrEqual(192_000);
    }
    for (const [index, text] of texts.entries()) {
      const holding = bodies.filter((raw) => Object.values((JSON.parse(raw) as JevBody).state.items).some((item) => item.text === text));
      expect(holding).toHaveLength(1);
      const body = JSON.parse(holding[0]!) as JevBody;
      const [item] = Object.entries(body.state.items).find(([, record]) => record.text === text)!;
      const named = Object.values(body.questions).filter((q) => q.instructions.item === `items.${item}`);
      expect(named.map((q) => q.instructions.question), `part ${index}`)
        .toEqual(LABEL_KINDS.map((kind) => labelPartQuestion(kind).question));
    }
    expect(Object.keys(answers).sort()).toEqual(batch.questions.map((q) => q.key).sort());
    expect(Object.values(answers).every((answer) => answer.status === 'answered')).toBe(true);
  });

  it('counts the state as sent, so text that doubles when escaped still splits inside the bound', async () => {
    // 90,000 characters of text, under the bound as written, near
    // 180,000 once each quote mark is escaped in the request.
    const texts = Array.from({ length: 10 }, (_, index) => `${index} ${'"'.repeat(8_998)}`);
    const bodies = answering();
    await jev({ apiKey: 'test' })({ task: 'Label the parts.', questions: texts.flatMap((text, index) => labelled(index, text)) },
      new AbortController().signal);
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    for (const raw of bodies) expect(stateAndLongest(JSON.parse(raw) as JevBody)).toBeLessThanOrEqual(96_000);
  });

  it('sends an item larger than the bound alone', async () => {
    const big = 'x'.repeat(120_000);
    const bodies = answering();
    await jev({ apiKey: 'test' })({ task: 'Label the parts.', questions: [...labelled(0, big), ...labelled(1, 'small')] },
      new AbortController().signal);
    expect(bodies).toHaveLength(2);
    const first = JSON.parse(bodies[0]!) as JevBody;
    expect(Object.values(first.state.items).map((item) => item.text)).toEqual([big]);
    expect(Object.keys(first.questions)).toHaveLength(7);
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

describe('model request errors', () => {
  it.each([undefined, ''])('rejects a missing API key before the factory can make a request: %j', (apiKey) => {
    const fetch = reply({});
    expect(() => jev({ apiKey })).toThrow(/API key/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports HTTP errors', async () => {
    reply({ error: 'unavailable' }, 503);
    const signal = new AbortController().signal;
    await expect(jev({ apiKey: 'test-key' })(batch, signal)).rejects.toThrow('HTTP 503');
  });
});
