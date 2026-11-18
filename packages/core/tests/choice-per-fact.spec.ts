import { afterEach, describe, expect, it, vi } from 'vitest';
import { DecisionServiceError, jev } from '../src/models.js';
import {
  choosePerFact, curate, FACT_CHOICE, jevListRequest, pick, rankedRead, type MemoryCandidate, type Mode, type PickCascade,
  type PickDecide, type PickItem, type PickListDecide, type PickListRequest,
} from '../src/index.js';

const task = 'Which database did we choose, and why?';
const item = (id: string, text: string): PickItem => ({ sourceId: 'chat', id, title: id, text, role: 'reference' });
const fact = 'which database was chosen';

/** A stand-in list decider: the Choice puts its weight on the items whose
 *  text holds `word`, the first of them highest; the companion says yes
 *  while one is in the state. Every request is kept. */
const lister = (word = 'Postgres') => {
  const requests: PickListRequest[] = [];
  const list: PickListDecide = async (request) => {
    requests.push(request);
    const keys = request.items.map(([key]) => key);
    const hits = request.items.filter(([, part]) => part.text.includes(word)).map(([key]) => key);
    return Object.fromEntries(Object.entries(request.questions).map(([name, question]) => {
      if (question.type === 'noul') return [name, { status: 'answered', probability: hits.length > 0 ? 0.9 : 0.05 }];
      const weight = (key: string) => hits.length === 0 ? 1 / keys.length
        : key === hits[0] ? (hits.length > 1 ? 0.8 : 1) : hits.includes(key) ? 0.2 / (hits.length - 1) : 0;
      return [name, { status: 'answered', probabilities: Object.fromEntries(question.options.map((key) => [key, weight(key)])) }];
    }));
  };
  return { requests, list };
};
const items = [item('a', 'We looked at options.'), item('b', 'We chose Postgres.'), item('c', 'Lunch was late.'), item('d', 'Postgres, for its transactions.')]
  .map((part, index) => [`P${index + 1}`, part] as const);

describe('a Choice per needed fact', () => {
  it('is sent as the maker\'s list recipe: the parts in the state, their keys as options, the companion beside it', () => {
    expect(jevListRequest({ task, needed: [fact], items: items.slice(0, 2),
      questions: { pick: { type: 'choice', question: FACT_CHOICE.question(fact), options: ['P1', 'P2'] },
        any: { type: 'noul', question: FACT_CHOICE.any(fact), trueCriterion: FACT_CHOICE.true, falseCriterion: FACT_CHOICE.false } } }))
      .toEqual({
        model: 'jev-latest',
        state: {
          task,
          needed: [fact],
          items: {
            P1: { id: 'a', date: null, title: 'a', text: 'We looked at options.' },
            P2: { id: 'b', date: null, title: 'b', text: 'We chose Postgres.' },
          },
        },
        questions: {
          pick: {
            type: 'choice',
            instructions: { question: 'Which item states this needed fact: which database was chosen', items: 'items' },
            criteria: { P1: null, P2: null },
          },
          any: {
            type: 'noul',
            instructions: { question: 'Does any item state this needed fact: which database was chosen', items: 'items' },
            criteria: {
              true: 'An item states the fact itself',
              false: 'The items share its subject, plan it, ask about it or report work toward it, without stating it',
            },
          },
        },
      });
  });

  it('removes each pick and asks again until the companion says no', async () => {
    const { requests, list } = lister();
    const result = await choosePerFact({ task, facts: [fact], items, list, signal: new AbortController().signal, bar: 0.3,
      maxChars: Number.POSITIVE_INFINITY });
    expect(result.facts).toEqual([{ fact, ended: 'no', picks: [
      { key: 'P2', round: 1, probability: 0.8, any: 0.9 }, { key: 'P4', round: 2, probability: 1, any: 0.9 }] }]);
    expect(requests.map((request) => request.items.map(([key]) => key))).toEqual([['P1', 'P2', 'P3', 'P4'], ['P1', 'P3', 'P4'], ['P1', 'P3']]);
    expect([result.rounds, result.requests]).toEqual([3, 3]);
  });

  it('sends the options reversed, the state unchanged, to measure the lean toward the first option', async () => {
    const { requests, list } = lister();
    await choosePerFact({ task, facts: [fact], items, list, signal: new AbortController().signal, bar: 0.3,
      maxChars: Number.POSITIVE_INFINITY, reverseOptions: true });
    const first = requests[0]!;
    expect(first.items.map(([key]) => key)).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(first.questions.pick).toMatchObject({ type: 'choice', options: ['P4', 'P3', 'P2', 'P1'] });
  });

  it('cuts a list too long for one request into windows, picks among their picks, and asks again only the window that changed', async () => {
    const { requests, list } = lister();
    const size = (keys: number) => JSON.stringify(jevListRequest({ task, items: items.slice(0, keys),
      questions: { pick: { type: 'choice', question: FACT_CHOICE.question(fact), options: items.slice(0, keys).map(([key]) => key) } } }));
    // Room for two items a request, not three.
    const result = await choosePerFact({ task, facts: [fact], items, list, signal: new AbortController().signal, bar: 0.3,
      maxChars: size(2).length });
    const asked = requests.map((request) => request.items.map(([key]) => key));
    // Round 1: both windows, then a Choice among their two picks.
    expect(asked.slice(0, 3)).toEqual([['P1', 'P2'], ['P3', 'P4'], ['P2', 'P4']]);
    // Round 2: only the window that lost P2.
    expect(asked[3]).toEqual(['P1']);
    expect(result.facts[0]!.picks.map((pick) => pick.key)).toEqual(['P2', 'P4']);
  });

  it('asks a window the service refuses as too large again in halves, and the Choice among their picks the same way', async () => {
    const { requests, list } = lister();
    // The service takes at most two items a request.
    const strict: PickListDecide = async (request, signal) => {
      if (request.items.length > 2) {
        requests.push(request);
        throw new DecisionServiceError(400, '{"detail":{"error_type":"max_tokens_exceeded"}}', 'max_tokens_exceeded');
      }
      return list(request, signal);
    };
    const result = await choosePerFact({ task, facts: [fact], items, list: strict, signal: new AbortController().signal, bar: 0.3,
      maxChars: Number.POSITIVE_INFINITY });
    expect(requests.map((request) => request.items.map(([key]) => key)).slice(0, 4))
      .toEqual([['P1', 'P2', 'P3', 'P4'], ['P1', 'P2'], ['P3', 'P4'], ['P2', 'P4']]);
    expect(result.facts[0]!.picks.map((pick) => pick.key)).toEqual(['P2', 'P4']);
  });

  it('never puts more options in one Choice than the service takes', async () => {
    const { requests, list } = lister('no such word');
    const many = Array.from({ length: 300 }, (_, index) => [`P${index + 1}`, item(`i${index}`, 'x')] as const);
    await choosePerFact({ task, facts: [fact], items: many, list, signal: new AbortController().signal, bar: 0.3,
      maxChars: Number.POSITIVE_INFINITY });
    expect(requests.map((request) => request.items.length)).toEqual([255, 45]);
  });
});

describe('a Choice per needed fact in a pick', () => {
  const set: PickCascade = { bias: 0, questions: [{ key: 'relevant', instructions: 'Relevant?', true: 'Yes', false: 'No', weight: 1 }] };
  const mode = (choicePerFact?: Mode['choicePerFact']): Mode => ({ name: 'notes', questions: set, read: rankedRead, needed: true,
    ...(choicePerFact === undefined ? {} : { choicePerFact }) });
  const part = (id: string, text: string, day: number, rank: number): MemoryCandidate => ({ sourceId: 'notes', role: 'reference', id,
    title: id, text, signals: {}, searchRanks: [rank], date: { value: `2026-10-0${day}`, meaning: 'recorded' } });
  // Rated best first: the lunch note, then the options, then the two answers.
  const parts = [part('c', 'Lunch was late.', 3, 0), part('a', 'We looked at options.', 1, 1),
    part('b', 'We chose Postgres.', 2, 2), part('d', 'Postgres, for its transactions.', 4, 3)];
  const ratings: Record<string, number> = { a: 0.6, b: 0.5, c: 0.9, d: 0.4 };
  const decider = (list?: PickListDecide): PickDecide => Object.assign(async (batch: Parameters<PickDecide>[0]) =>
    Object.fromEntries(batch.questions.map((question) => [question.key, { status: 'answered' as const, probability: ratings[question.id]! }])),
  list === undefined ? {} : { list });

  it('marks the picks, leads the text with them in the order picked, and keeps every other kept part after them', async () => {
    const { requests, list } = lister();
    const result = await pick(parts, { task, decide: decider(list), needed: [fact], modesBySource: { notes: mode(true) } });
    // The items go in the order they were said.
    expect(requests[0]!.items.map(([, part]) => part.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(requests[0]!.needed).toEqual([fact]);
    expect(result.record.choicePerFact).toMatchObject({ bar: 0.3, rounds: 3, requests: 3,
      facts: [{ fact, ended: 'no', picks: [{ id: 'b', round: 1 }, { id: 'd', round: 2 }] }] });
    const entry = (id: string) => result.record.candidates.find((candidate) => candidate.id === id)!;
    expect(entry('b').chosen).toEqual([{ fact: 0, round: 1, probability: 0.8 }]);
    expect(entry('c').chosen).toBeUndefined();
    expect(result.record.levers.sources.notes!.choicePerFact).toEqual({ bar: 0.3 });
    const { log, record } = await curate(task, result);
    expect(record.items.map((taken) => taken.candidate.id)).toEqual(['b', 'd', 'c', 'a']);
    expect(log.indexOf('We chose Postgres.')).toBeLessThan(log.indexOf('Lunch was late.'));
    // Both picks, and only they, make the `Most likely answer` section.
    const lead = log.split(/\n### (?!#)/)[0]!;
    expect(lead).toContain('Postgres, for its transactions.');
    expect(lead).not.toContain('Lunch was late.');
    // Nothing is dropped: the same parts are kept as with the setting off.
    const off = await pick(parts, { task, decide: decider(), needed: [fact], modesBySource: { notes: mode() } });
    expect(result.selected.map((candidate) => candidate.id).sort()).toEqual(off.selected.map((candidate) => candidate.id).sort());
  });

  it('asks an identical text once, at its first place, and marks every copy with its pick', async () => {
    const { requests, list } = lister();
    const copy = part('e', 'We chose Postgres.', 5, 4);
    ratings.e = 0.45;
    const result = await pick([...parts, copy], { task, decide: decider(list), needed: [fact], modesBySource: { notes: mode(true) } });
    expect(requests[0]!.items.map(([, item]) => item.id)).toEqual(['a', 'b', 'c', 'd']);
    const entry = (id: string) => result.record.candidates.find((candidate) => candidate.id === id)!;
    expect(entry('e').chosen).toEqual(entry('b').chosen);
    delete ratings.e;
  });

  it('asks nothing when the call gives no needed facts, and says so', async () => {
    const { requests, list } = lister();
    const result = await pick(parts, { task, decide: decider(list), modesBySource: { notes: mode({ bar: 0.5 }) } });
    expect(requests).toEqual([]);
    expect(result.record.choicePerFact).toEqual({ bar: 0.5, facts: [], rounds: 0, requests: 0, skipped: 'the call gave no needed facts' });
  });

  it('leaves the pick and the text as they were when off', async () => {
    const before = await pick(parts, { task, decide: decider(), needed: [fact], modesBySource: { notes: mode() } });
    const after = await pick(parts, { task, decide: decider(lister().list), needed: [fact], modesBySource: { notes: mode(false) } });
    expect(after.record.candidates).toEqual(before.record.candidates);
    expect(after.record).not.toHaveProperty('choicePerFact');
    expect((await curate(task, after)).log).toBe((await curate(task, before)).log);
  });

  it('needs a decider that answers list requests, and a bar between 0 and 1', async () => {
    await expect(pick(parts, { task, decide: decider(), needed: [fact], modesBySource: { notes: mode(true) } }))
      .rejects.toThrow('choicePerFact needs a decider that answers list requests, such as jev().');
    await expect(pick(parts, { task, decide: decider(lister().list), modesBySource: { notes: mode({ bar: 2 }) } }))
      .rejects.toThrow('modesBySource.notes.choicePerFact.bar must be a number between 0 and 1.');
  });
});

describe('a list request, as jev() posts it', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts the list request body and reads a Choice\'s probabilities and a yes/no', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init!.body)));
      return Response.json({ answers: {
        pick: { type: 'choice', choice: 'P2', confidence: 0.9, probabilities: { P1: 0.05, P2: 0.95 } },
        any: { type: 'noul', noul: 0.97 } } });
    }));
    const request: PickListRequest = { task, items: items.slice(0, 2),
      questions: { pick: { type: 'choice', question: FACT_CHOICE.question(fact), options: ['P1', 'P2'] },
        any: { type: 'noul', question: FACT_CHOICE.any(fact), trueCriterion: FACT_CHOICE.true, falseCriterion: FACT_CHOICE.false } } };
    const decide = jev({ apiKey: 'test-key' });
    const answers = await decide.list!(request, new AbortController().signal);
    expect(bodies).toEqual([jevListRequest(request)]);
    expect(answers).toEqual({ pick: { status: 'answered', probabilities: { P1: 0.05, P2: 0.95 } }, any: { status: 'answered', probability: 0.97 } });
    expect(decide.list!.maxChars).toBe(96_000);
  });

  it('lets a list request refused as too large fail alone, so a smaller one under the same signal still goes', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init!.body)) as { state: { items: object } };
      return Object.keys(body.state.items).length > 2
        ? new Response('{"detail":{"error_type":"max_tokens_exceeded"}}', { status: 400 })
        : Response.json({ answers: { any: { type: 'noul', noul: 0.4 } } });
    }));
    const decide = jev({ apiKey: 'test-key' });
    const signal = new AbortController().signal;
    const question = { any: { type: 'noul' as const, question: FACT_CHOICE.any(fact), trueCriterion: FACT_CHOICE.true, falseCriterion: FACT_CHOICE.false } };
    await expect(decide.list!({ task, items: items.slice(0, 3), questions: question }, signal)).rejects.toMatchObject({ status: 400 });
    await expect(decide.list!({ task, items: items.slice(0, 2), questions: question }, signal))
      .resolves.toEqual({ any: { status: 'answered', probability: 0.4 } });
  });
});
