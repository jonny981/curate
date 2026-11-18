import { afterEach, describe, expect, it, vi } from 'vitest';
import { DecisionServiceError, jev } from '../src/models.js';
import {
  choosePerFact, curate, ENOUGH_QUESTION, FACT_CHOICE, jevListRequest, pick, rankedRead, type MemoryCandidate, type Mode,
  type PickCascade, type PickDecide, type PickItem, type PickListDecide, type PickListRequest,
} from '../src/index.js';

const task = 'Which database did we choose, and why?';
const fact = 'which database was chosen';
const item = (id: string, text: string, author: PickItem['author'] = 'agent'): PickItem => ({ sourceId: 'chat', id, title: id, text,
  role: 'reference', author, date: { value: `2026-10-0${id.charCodeAt(0) - 96}T09:00:00Z`, meaning: 'recorded' } });
const items = [item('a', 'We looked at options.'), item('b', 'We chose Postgres.', 'person'), item('c', 'Lunch was late.'),
  item('d', 'Postgres, for its transactions.')].map((part, index) => [`P${index + 1}`, part] as const);
const keys = items.map(([key]) => key);
const signal = new AbortController().signal;
/** A list request's Choice options, in the order sent. */
const optionsOf = (request: PickListRequest) => {
  const question = request.questions.pick;
  return question?.type === 'choice' ? question.options : [];
};

/** A stand-in list decider: a Choice puts 0.8 on the first option whose
 *  text holds `word` and shares the rest among the others that do; the
 *  sufficiency question says yes once `enoughAt` picks are in. */
const lister = (word = 'Postgres', enoughAt = Number.POSITIVE_INFINITY) => {
  const requests: PickListRequest[] = [];
  const list: PickListDecide = async (request) => {
    requests.push(request);
    const text = new Map(request.items.map(([key, part]) => [key, part.text]));
    return Object.fromEntries(Object.entries(request.questions).map(([name, question]) => {
      if (question.type === 'noul') return [name, { status: 'answered', probability: request.items.length >= enoughAt ? 0.9 : 0.2 }];
      const hits = question.options.filter((key) => text.get(key)!.includes(word));
      const weight = (key: string) => hits.length === 0 ? 1 / question.options.length
        : key === hits[0] ? (hits.length > 1 ? 0.8 : 1) : hits.includes(key) ? 0.2 / (hits.length - 1) : 0;
      return [name, { status: 'answered', probabilities: Object.fromEntries(question.options.map((key) => [key, weight(key)])) }];
    }));
  };
  return { requests, list };
};

describe('a Choice per needed fact', () => {
  it('is sent as the maker\'s large-choice recipe: the task in the state, each candidate written into its own option', () => {
    expect(jevListRequest({ task, needed: [fact], person: 'Ana', items: items.slice(0, 2),
      questions: { pick: { type: 'choice', described: true, question: FACT_CHOICE.question(fact), options: ['P1', 'P2'] } } }))
      .toEqual({
        model: 'jev-latest',
        state: { task, needed: [fact], person: 'Ana' },
        questions: {
          pick: {
            type: 'choice',
            instructions: 'Which of these items states this needed fact: which database was chosen',
            criteria: {
              P1: 'agent, 2026-10-01: We looked at options.',
              P2: 'Ana, 2026-10-02: We chose Postgres.',
            },
          },
        },
      });
  });

  it('writes an item with fields code knows as an option object holding them', () => {
    const body = jevListRequest({ task, items: [['P1', { ...items[0]![1], facts: { kind: 'agent step', pieces: 1 } }]],
      questions: { pick: { type: 'choice', described: true, question: FACT_CHOICE.question(fact), options: ['P1'] } } });
    expect(body.questions.pick).toMatchObject({ criteria: { P1: { said: 'agent, 2026-10-01', text: 'We looked at options.', kind: 'agent step', pieces: 1 } } });
  });

  it('removes each pick and asks again until no candidate is left, and ranks every candidate', async () => {
    const { requests, list } = lister();
    const result = await choosePerFact({ task, facts: [fact], items, candidates: [keys], list, signal, maxChars: Number.POSITIVE_INFINITY });
    expect(requests.map(optionsOf)).toEqual([['P1', 'P2', 'P3', 'P4'], ['P1', 'P3', 'P4'], ['P1', 'P3'], ['P3']]);
    expect(result.facts[0]).toMatchObject({ fact, ended: 'empty', picks: [{ key: 'P2', round: 1, probability: 0.8 },
      { key: 'P4', round: 2, probability: 1 }, { key: 'P1', round: 3, probability: 0.5 }, { key: 'P3', round: 4, probability: 1 }] });
    expect(result.facts[0]!.ranked.map((entry) => entry.key)).toEqual(['P2', 'P4', 'P1', 'P3']);
  });

  it('ends every loop once the sufficiency question, asked of the picks alone, says they suffice', async () => {
    const { requests, list } = lister('Postgres', 2);
    const result = await choosePerFact({ task, facts: [fact, 'why it was chosen'], items, candidates: [keys, keys], list, signal,
      maxChars: Number.POSITIVE_INFINITY, enough: 0.7 });
    const asked = requests.filter((request) => request.questions.enough !== undefined);
    expect(asked.map((request) => request.items.map(([key]) => key))).toEqual([['P2'], ['P2', 'P4']]);
    expect(jevListRequest(asked[0]!)).toMatchObject({ state: { task, items: { P2: { text: 'We chose Postgres.' } } },
      questions: { enough: { type: 'noul', instructions: { question: ENOUGH_QUESTION.question, items: 'items' },
        criteria: { true: ENOUGH_QUESTION.true, false: ENOUGH_QUESTION.false } } } });
    expect(result.facts.map((loop) => loop.ended)).toEqual(['enough', 'enough']);
    expect(result.enough).toEqual([0.2, 0.9]);
    // Each fact still ranks every candidate, the picks first.
    expect(result.facts[0]!.ranked.map((entry) => entry.key)).toEqual(['P2', 'P4', 'P1', 'P3']);
  });

  it('sends the options reversed to measure the lean toward the first option', async () => {
    const { requests, list } = lister();
    await choosePerFact({ task, facts: [fact], items, candidates: [keys], list, signal, maxChars: Number.POSITIVE_INFINITY,
      reverseOptions: true });
    expect(requests[0]!.questions.pick).toMatchObject({ type: 'choice', options: ['P4', 'P3', 'P2', 'P1'] });
  });

  it('cuts candidates too long for one request into windows, picks among their picks, and asks again only the window that changed', async () => {
    const { requests, list } = lister();
    const size = (from: number, to: number) => {
      const body = jevListRequest({ task, items: items.slice(from, to),
        questions: { pick: { type: 'choice', described: true, question: FACT_CHOICE.question(fact), options: keys.slice(from, to) } } });
      return JSON.stringify(body.state).length + JSON.stringify(body.questions.pick).length;
    };
    // Room for either pair, and for no three.
    const room = Math.max(size(0, 2), size(2, 4));
    expect(room).toBeLessThan(Math.min(size(0, 3), size(1, 4)));
    const result = await choosePerFact({ task, facts: [fact], items, candidates: [keys], list, signal, maxChars: room });
    const asked = requests.map(optionsOf);
    expect(asked.slice(0, 4)).toEqual([['P1', 'P2'], ['P3', 'P4'], ['P2', 'P4'], ['P1']]);
    expect(result.facts[0]!.picks.map((pick) => pick.key).slice(0, 2)).toEqual(['P2', 'P4']);
  });

  it('asks a window the service refuses as too large again in halves', async () => {
    const { requests, list } = lister();
    const strict: PickListDecide = async (request, signal_) => {
      if (request.items.length > 2) {
        requests.push(request);
        throw new DecisionServiceError(400, '{"detail":{"error_type":"max_tokens_exceeded"}}', 'max_tokens_exceeded');
      }
      return list(request, signal_);
    };
    const result = await choosePerFact({ task, facts: [fact], items, candidates: [keys], list: strict, signal,
      maxChars: Number.POSITIVE_INFINITY });
    expect(requests.map((request) => request.items.map(([key]) => key)).slice(0, 4))
      .toEqual([['P1', 'P2', 'P3', 'P4'], ['P1', 'P2'], ['P3', 'P4'], ['P2', 'P4']]);
    expect(result.facts[0]!.picks.map((pick) => pick.key).slice(0, 2)).toEqual(['P2', 'P4']);
  });

  it('never puts more options in one Choice than the service takes', async () => {
    const { requests, list } = lister('no such word');
    const many = Array.from({ length: 300 }, (_, index) => [`P${index + 1}`, item('a', 'x')] as const);
    await choosePerFact({ task, facts: [fact], items: many, candidates: [many.map(([key]) => key)], list, signal,
      maxChars: Number.POSITIVE_INFINITY, enough: 0 });
    expect(requests.slice(0, 2).map((request) => request.items.length)).toEqual([255, 45]);
  });
});

describe('a Choice per needed fact in a pick', () => {
  const set: PickCascade = { bias: 0, questions: [{ key: 'relevant', instructions: 'Relevant?', true: 'Yes', false: 'No', weight: 1 }] };
  const mode = (choicePerFact?: Mode['choicePerFact'], questions: PickCascade = set): Mode => ({ name: 'notes', questions, read: rankedRead,
    needed: true, ...(choicePerFact === undefined ? {} : { choicePerFact }) });
  const part = (id: string, text: string, day: number, rank: number): MemoryCandidate => ({ sourceId: 'notes', role: 'reference', id,
    title: id, text, signals: {}, searchRanks: [rank], date: { value: `2026-10-0${day}`, meaning: 'recorded' } });
  // Rated: the lunch note best, then the options, then the two answers.
  const parts = [part('c', 'Lunch was late.', 3, 0), part('a', 'We looked at options.', 1, 1),
    part('b', 'We chose Postgres.', 2, 2), part('d', 'Postgres, for its transactions.', 4, 3)];
  const ratings: Record<string, number> = { a: 0.6, b: 0.5, c: 0.9, d: 0.4 };
  const decider = (list?: PickListDecide): PickDecide => Object.assign(async (batch: Parameters<PickDecide>[0]) =>
    Object.fromEntries(batch.questions.map((question) => [question.key, { status: 'answered' as const,
      probability: question.questionKey === 'fact1' ? (question.text.includes('Postgres') ? 0.9 : 0.1) : ratings[question.id]! }])),
  list === undefined ? {} : { list });
  const options = (request: PickListRequest) => optionsOf(request).map((key) => request.items.find(([own]) => own === key)![1].id);

  it('screens each fact to the candidates rated best, leads the text with the picks, and keeps every other kept part', async () => {
    const { requests, list } = lister();
    const result = await pick(parts, { task, decide: decider(list), needed: [fact], modesBySource: { notes: mode({ candidates: 3, enough: false }) } });
    // The three rated best, best first.
    expect(options(requests[0]!)).toEqual(['c', 'a', 'b']);
    expect(requests[0]!.needed).toEqual([fact]);
    expect(result.record.choicePerFact).toMatchObject({ candidates: 3, rounds: 3, requests: 3,
      facts: [{ fact, ended: 'empty', picks: [{ id: 'b', round: 1 }, { id: 'c', round: 2 }, { id: 'a', round: 3 }] }] });
    const entry = (id: string) => result.record.candidates.find((candidate) => candidate.id === id)!;
    expect(entry('b').chosen).toEqual([{ fact: 0, round: 1, probability: 1 }]);
    expect(entry('d').chosen).toBeUndefined();
    expect(result.record.levers.sources.notes!.choicePerFact).toEqual({ candidates: 3 });
    const { log, record } = await curate(task, result);
    expect(record.items.map((taken) => taken.candidate.id)).toEqual(['b', 'c', 'a', 'd']);
    expect(log.split(/\n### (?!#)/)[0]).not.toContain('Postgres, for its transactions.');
    const off = await pick(parts, { task, decide: decider(), needed: [fact], modesBySource: { notes: mode() } });
    expect(result.selected.map((candidate) => candidate.id).sort()).toEqual(off.selected.map((candidate) => candidate.id).sort());
  });

  it('screens by the set\'s own question for the fact when it asks one', async () => {
    const { requests, list } = lister();
    const facts: PickCascade = { ...set, facts: { question: { key: 'fact', instructions: 'States {fact}?', true: 'Yes', false: 'No' }, highest: 0 } };
    await pick(parts, { task, decide: decider(list), needed: [fact], modesBySource: { notes: mode({ candidates: 2 }, facts) } });
    expect(options(requests[0]!)).toEqual(['b', 'd']);
  });

  it('asks the sufficiency question by default, and records its answers', async () => {
    const { list } = lister('Postgres', 1);
    const result = await pick(parts, { task, decide: decider(list), needed: [fact], modesBySource: { notes: mode(true) } });
    expect(result.record.choicePerFact).toMatchObject({ candidates: 20, rounds: 1, enough: { bar: 0.7, answers: [0.9] },
      facts: [{ ended: 'enough', picks: [{ id: 'b' }] }] });
    expect(result.record.choicePerFact!.facts[0]!.ranked.map((entry) => entry.id)).toEqual(['b', 'd', 'c', 'a']);
  });

  it('asks an identical or near-identical text once, at its first place, and marks every copy with its pick', async () => {
    const { requests, list } = lister();
    // The same words, with other case, punctuation and Markdown.
    const copy = part('e', '**We chose postgres**', 5, 4);
    ratings.e = 0.95;
    const result = await pick([...parts, copy], { task, decide: decider(list), needed: [fact], modesBySource: { notes: mode(true) } });
    // The option stands at its best copy's rating: first of the screen.
    expect(options(requests[0]!)[0]).toBe('b');
    expect(options(requests[0]!)).not.toContain('e');
    const entry = (id: string) => result.record.candidates.find((candidate) => candidate.id === id)!;
    expect(entry('e').chosen).toEqual(entry('b').chosen);
    delete ratings.e;
  });

  it('asks nothing when the call gives no needed facts, and says so', async () => {
    const { requests, list } = lister();
    const result = await pick(parts, { task, decide: decider(list), modesBySource: { notes: mode(true) } });
    expect(requests).toEqual([]);
    expect(result.record.choicePerFact).toEqual({ candidates: 20, facts: [], rounds: 0, requests: 0, skipped: 'the call gave no needed facts' });
  });

  it('leaves the pick and the text as they were when off', async () => {
    const before = await pick(parts, { task, decide: decider(), needed: [fact], modesBySource: { notes: mode() } });
    const after = await pick(parts, { task, decide: decider(lister().list), needed: [fact], modesBySource: { notes: mode(false) } });
    expect(after.record.candidates).toEqual(before.record.candidates);
    expect(after.record).not.toHaveProperty('choicePerFact');
    expect((await curate(task, after)).log).toBe((await curate(task, before)).log);
  });

  it('needs a decider that answers list requests, and checks its settings', async () => {
    await expect(pick(parts, { task, decide: decider(), needed: [fact], modesBySource: { notes: mode(true) } }))
      .rejects.toThrow('choicePerFact needs a decider that answers list requests, such as jev().');
    await expect(pick(parts, { task, decide: decider(lister().list), modesBySource: { notes: mode({ candidates: 0 }) } }))
      .rejects.toThrow('modesBySource.notes.choicePerFact.candidates must be a positive whole number.');
    await expect(pick(parts, { task, decide: decider(lister().list), modesBySource: { notes: mode({ enough: { bar: -1 } }) } }))
      .rejects.toThrow('modesBySource.notes.choicePerFact.enough.bar must be a number between 0 and 1.');
  });
});

describe('a list request, as jev() posts it', () => {
  afterEach(() => vi.unstubAllGlobals());
  const request: PickListRequest = { task, items: items.slice(0, 2),
    questions: { pick: { type: 'choice', described: true, question: FACT_CHOICE.question(fact), options: ['P1', 'P2'] } } };

  it('posts the list request body and reads a Choice\'s probabilities', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init!.body)));
      return Response.json({ answers: { pick: { type: 'choice', choice: 'P2', confidence: 0.9, probabilities: { P1: 0.05, P2: 0.95 } } } });
    }));
    const decide = jev({ apiKey: 'test-key' });
    expect(await decide.list!(request, signal)).toEqual({ pick: { status: 'answered', probabilities: { P1: 0.05, P2: 0.95 } } });
    expect(bodies).toEqual([jevListRequest(request)]);
    expect(decide.list!.maxChars).toBe(96_000);
  });

  it('lets a list request refused as too large fail alone, so a smaller one under the same signal still goes', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init!.body)) as { questions: { pick: { criteria: object } } };
      return Object.keys(body.questions.pick.criteria).length > 1
        ? new Response('{"detail":{"error_type":"max_tokens_exceeded"}}', { status: 400 })
        : Response.json({ answers: { pick: { type: 'choice', probabilities: { P1: 1 } } } });
    }));
    const decide = jev({ apiKey: 'test-key' });
    await expect(decide.list!(request, signal)).rejects.toMatchObject({ status: 400 });
    await expect(decide.list!({ ...request, questions: { pick: { ...request.questions.pick!, options: ['P1'] } as never } }, signal))
      .resolves.toEqual({ pick: { status: 'answered', probabilities: { P1: 1 } } });
  });
});
