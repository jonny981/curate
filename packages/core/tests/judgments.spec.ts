import { afterEach, describe, expect, it, vi } from 'vitest';

import { decisionKey, storedDecision } from '../src/decisions.js';
import { judgmentFacts, judgmentPopulation, modelScore } from '../src/judgments.js';
import { jev, jevRequest } from '../src/models.js';
import { checkCascade } from '../src/options.js';
import { pick, type MemoryCandidate, type PickAnswer, type PickCascade } from '../src/pick.js';
import { classifyTask } from '../src/task.js';
import { taskMoment } from '../src/time.js';

afterEach(() => vi.unstubAllGlobals());

const uncutPick = { everyRanked: true, everyScored: true, rare: false } as const;

const LEVELS = ["can't be the answer", 'the kind asked, but not this one',
  'possible but uncertain or partial', 'likely, with some doubt', 'definitely the answer'] as const;

/** The measured two-question set with invented weights: topic_match and
 *  answerhood answered once per part, combined through the model with
 *  the code facts. */
const SET: PickCascade = {
  anonymousItems: true,
  model: {
    keys: ['topic_match', 'answerhood', 'hasUser', 'kwScore'],
    mu: [-1, 1.5, 0.5, 0.4],
    sd: [1, 0.5, 0.5, 0.2],
    w: [1, 0.7, 0.3, -0.4],
    b: -0.5,
    bar: 0.42,
  },
  questions: [
    {
      key: 'topic_match',
      instructions: "Is this excerpt about the question's subject?",
      true: 'Same subject',
      false: 'Different subject',
    },
    {
      key: 'answerhood',
      instructions: 'Could this excerpt itself be the answer?',
      levels: LEVELS,
    },
  ],
};

function chat(overrides: Partial<MemoryCandidate> & Pick<MemoryCandidate, 'sourceId' | 'id'>): MemoryCandidate {
  return {
    role: 'reference',
    title: `title of ${overrides.id}`,
    text: `text of ${overrides.id}`,
    signals: {},
    ...overrides,
  };
}

/** A decide that answers every noul ask with `probability` and every
 *  levelled ask with `probabilities`. */
const answerAll = (probability: number, probabilities: readonly number[]) =>
  async ({ questions }: { questions: readonly { key: string; levels?: readonly string[] }[] }) =>
    Object.fromEntries(questions.map((question) => [question.key,
      question.levels === undefined
        ? { status: 'answered', probability } satisfies PickAnswer
        : { status: 'answered', probabilities: [...probabilities] } satisfies PickAnswer]));

describe('model-scored question sets', () => {
  it('asks both judgments of each part in one round and combines through the weights', async () => {
    const batches: string[][] = [];
    const decide = async (batch: { questions: readonly { key: string; questionKey?: string; levels?: readonly string[] }[] }) => {
      batches.push(batch.questions.map((question) => question.questionKey ?? question.key));
      return answerAll(0.8, [0.1, 0.1, 0.2, 0.3, 0.3])(batch);
    };
    const candidates = [
      chat({ sourceId: 'chat', id: 'chat:r:f:1:1:1', date: { value: '2025-01-01T12:00:00.000Z', meaning: 'recorded' },
        signals: { keyword: 0.7 }, chat: { provider: 'codex', sessionId: 'a', role: 'user' } }),
      chat({ sourceId: 'chat', id: 'chat:r:f:1:1:2', date: { value: '2025-01-01T12:00:00.000Z', meaning: 'recorded' },
        signals: { keyword: 0.4 }, chat: { provider: 'codex', sessionId: 'a', role: 'assistant' } }),
    ];
    const result = await pick(candidates, {
      ...uncutPick, task: 'Which database did we pick?', questionsBySource: { chat: SET }, decide,
    });

    // One round: no first/band, so every question is asked together.
    expect(batches).toEqual([[ 'topic_match', 'answerhood', 'topic_match', 'answerhood' ]]);

    const entry = result.record.candidates[0]!;
    // topic_match logit(0.8), answerhood expectation 2.6, hasUser 1, kwScore 0.7.
    const z = -0.5 + 1 * ((Math.log(0.8 / 0.2) - -1) / 1) + 0.7 * ((2.6 - 1.5) / 0.5)
      + 0.3 * ((1 - 0.5) / 0.5) + -0.4 * ((0.7 - 0.4) / 0.2);
    expect(entry.status).toBe('selected');
    expect('probability' in entry && entry.probability).toBeCloseTo(1 / (1 + Math.exp(-z)), 12);

    const second = result.record.candidates[1]!;
    const z2 = -0.5 + 1 * ((Math.log(0.8 / 0.2) - -1) / 1) + 0.7 * ((2.6 - 1.5) / 0.5)
      + 0.3 * ((0 - 0.5) / 0.5) + -0.4 * ((0.4 - 0.4) / 0.2);
    expect('probability' in second && second.probability).toBeCloseTo(1 / (1 + Math.exp(-z2)), 12);
  });

  it('keeps one part\'s questions in a single batch at the character bound', async () => {
    const batches: string[][] = [];
    const decide = async (batch: { questions: readonly { key: string; id: string; questionKey?: string; levels?: readonly string[] }[] }) => {
      batches.push(batch.questions.map((question) => `${question.id}:${question.questionKey}`));
      return answerAll(0.8, [0.1, 0.1, 0.2, 0.3, 0.3])(batch);
    };
    const task = 'the task';
    const parts = [
      chat({ sourceId: 'chat', id: 'chat:r:f:1:1:1', text: 'aaaa', signals: {},
        chat: { provider: 'codex', sessionId: 's', role: 'user' } }),
      chat({ sourceId: 'chat', id: 'chat:r:f:1:1:2', text: 'bbbb', signals: {},
        chat: { provider: 'codex', sessionId: 's', role: 'assistant' } }),
    ];
    const wording = (spec: PickCascade['questions'][number]) => spec.instructions.length
      + ('levels' in spec ? spec.levels.join('').length : spec.true.length + spec.false.length);
    // The bound holds the first part's pair plus exactly one of the
    // second part's questions and its item: a batch closed between a
    // part's questions would send the second part's text twice.
    const bound = task.length
      + wording(SET.questions[0]!) + wording(SET.questions[1]!) + parts[0]!.text.length
      + wording(SET.questions[0]!) + parts[1]!.text.length;
    const result = await pick(parts, { ...uncutPick, task,
      questionsBySource: { chat: SET }, decide, limits: { maxBatchChars: bound } });
    expect(batches).toEqual([
      ['chat:r:f:1:1:1:topic_match', 'chat:r:f:1:1:1:answerhood'],
      ['chat:r:f:1:1:2:topic_match', 'chat:r:f:1:1:2:answerhood'],
    ]);
    expect(result.record.candidates.map((entry) => entry.status)).toEqual(['selected', 'selected']);
  });

  it('imputes a missing answer at the fitted mean instead of failing', async () => {
    const candidates = [
      chat({ sourceId: 'chat', id: 'chat:r:f:1:1:1', signals: { keyword: 0.7 },
        chat: { provider: 'codex', sessionId: 'a', role: 'user' } }),
    ];
    const result = await pick(candidates, {
      ...uncutPick, task: 'the task', questionsBySource: { chat: SET },
      decide: async ({ questions }) => Object.fromEntries(questions.map((question) => [question.key,
        question.questionKey === 'answerhood' ? { status: 'missing' } satisfies PickAnswer
          : { status: 'answered', probability: 0.8 } satisfies PickAnswer])),
    });
    const entry = result.record.candidates[0]!;
    const z = -0.5 + 1 * ((Math.log(0.8 / 0.2) - -1) / 1) + 0.7 * 0
      + 0.3 * ((1 - 0.5) / 0.5) + -0.4 * ((0.7 - 0.4) / 0.2);
    expect('probability' in entry && entry.probability).toBeCloseTo(1 / (1 + Math.exp(-z)), 12);
  });

  it('fails closed on a model without fitted weights before any decide call', async () => {
    const decide = vi.fn(async () => ({}));
    const parts = [chat({ sourceId: 'chat', id: 'chat:r:f:1:1:1' })];
    for (const model of [
      {},
      // Complete arrays and b without a fitted bar: the set cannot select.
      { keys: ['a'], mu: [0], sd: [1], w: [1], b: 0 },
      { keys: ['a'], mu: [0], sd: [1], w: [1], b: 0, bar: 2 },
    ] as const) {
      await expect(pick(parts, {
        ...uncutPick, task: 'the task', questionsBySource: { chat: { ...SET, model: model as never } }, decide,
      })).rejects.toThrowError(/model|weights/);
    }
    expect(decide).not.toHaveBeenCalled();
  });

  it('rejects a levelled question outside a model set', () => {
    expect(() => checkCascade({
      bias: -1,
      questions: [{ key: 'a', instructions: 'i', levels: ['x', 'y'] }],
    } as PickCascade)).toThrowError(TypeError);
    expect(() => checkCascade({
      bias: -1,
      questions: [{ key: 'a', instructions: 'i', true: 't', false: 'f', levels: ['x', 'y'] }],
    } as PickCascade)).toThrowError(TypeError);
    expect(() => checkCascade(SET)).not.toThrow();
    expect(() => checkCascade({ ...SET, first: 'topic_match' })).toThrowError(TypeError);
    expect(() => checkCascade({ ...SET, anonymousItems: 'yes' } as never)).toThrowError(TypeError);
  });
});

describe('score questions through jevRequest and jev', () => {
  it('renders a levelled question as criteria, not true/false', () => {
    const batch = {
      task: 'the task',
      questions: [{
        key: 'k0', role: 'reference', question: 'Could this excerpt itself be the answer?',
        levels: LEVELS, sourceId: 's', id: 'anon', title: 'hidden', text: 'the text',
        anonymous: true,
        date: { value: '2025-01-01T12:00:00.000Z', meaning: 'recorded' },
      }, {
        key: 'k1', role: 'reference', question: 'same subject?',
        trueCriterion: 'Same subject', falseCriterion: 'Different subject',
        sourceId: 's', id: 'named', title: 'shown', text: 'other text',
      }],
    } as const;
    const body = jevRequest(batch as never);
    expect(body.questions).toEqual({
      q0: { type: 'score', instructions: 'Could this excerpt itself be the answer?\n\nItem 1', criteria: [...LEVELS] },
      q1: { type: 'noul', instructions: 'same subject?\n\nItem 2', criteria: { true: 'Same subject', false: 'Different subject' } },
    });
    // The anonymous item carries date and text only; the named one keeps its id and title.
    expect(body.state).toContain('Item 1: (recorded 2025-01-01T12:00:00.000Z)\n\nthe text');
    expect(body.state).not.toContain('anon');
    expect(body.state).not.toContain('hidden');
    expect(body.state).toContain('Item 2: named\nshown\n\nother text');
  });

  it('strips # session lines from anonymous item text only', () => {
    const batch = {
      task: 't',
      questions: [{
        key: 'k0', role: 'reference', question: 'q', levels: ['a', 'b'],
        sourceId: 's', id: 'i1', title: 't1', anonymous: true,
        text: '# session aaa\nuser: kept line',
      }, {
        key: 'k1', role: 'reference', question: 'q', trueCriterion: 't', falseCriterion: 'f',
        sourceId: 's', id: 'i2', title: 't2',
        text: '# session bbb\nuser: kept too',
      }],
    } as const;
    const { state } = jevRequest(batch as never);
    expect(state).toContain('Item 1: user: kept line');
    expect(state).not.toContain('aaa');
    // Identified items keep their text verbatim.
    expect(state).toContain('Item 2: i2\nt2\n\n# session bbb\nuser: kept too');
  });

  it('reads score answers into probabilities and fails malformed ones', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({
      model: 'jev-latest',
      answers: {
        q0: { score: 0.04, probabilities: { 0: 0.98, 1: 0.02, 2: 0, 3: 0, 4: 0 } },
        q1: { score: 0.5, probabilities: { 0: 0.2, 1: 0.2, 2: 0.2, 3: 0.2, 4: 0.2 } },
        q2: { noul: 0.7 },
        q3: { score: 0.5, probabilities: { 0: 0.2, 1: 0.2, 2: 0.2 } },
      },
    }));
    vi.stubGlobal('fetch', fetch);
    const answers = await jev({ apiKey: 'test' })({
      task: 't',
      questions: [
        { key: 'a', role: 'reference', question: 'q', levels: LEVELS, sourceId: 's', id: 'i', title: 't', text: 'x' },
        { key: 'b', role: 'reference', question: 'q', levels: LEVELS, sourceId: 's', id: 'i', title: 't', text: 'x' },
        { key: 'c', role: 'reference', question: 'q', trueCriterion: 't', falseCriterion: 'f', sourceId: 's', id: 'i', title: 't', text: 'x' },
        { key: 'd', role: 'reference', question: 'q', levels: LEVELS, sourceId: 's', id: 'i', title: 't', text: 'x' },
      ],
    }, new AbortController().signal);
    expect(answers).toEqual({
      a: { status: 'answered', probabilities: [0.98, 0.02, 0, 0, 0] },
      b: { status: 'answered', probabilities: [0.2, 0.2, 0.2, 0.2, 0.2] },
      c: { status: 'answered', probability: 0.7 },
      d: { status: 'missing' },
    });
  });
});

describe('decision keys and stored answers for score questions', () => {
  const question = {
    key: 'k', role: 'reference' as const, question: 'q', trueCriterion: 't', falseCriterion: 'f',
    sourceId: 's', id: 'i', title: 't', text: 'x',
  };
  it('keeps an identified noul question\'s key at its stored value', () => {
    // Answers stored before levels and anonymity existed hashed the
    // array without them; an unchanged noul question still hits them.
    expect(decisionKey('task', 'v1', 'decider', 700, question, 'x'))
      .toBe('da9b6ea3fcfdfc45e56d3bd40a2ea21ae8415e69ea4e8f00ee30e89c9c8bba1d');
  });
  it('hashes levels and anonymity into the decision key', () => {
    const base = decisionKey('task', 'v1', 'decider', 700, question, 'x');
    expect(decisionKey('task', 'v1', 'decider', 700, { ...question, levels: ['a', 'b'] }, 'x')).not.toBe(base);
    expect(decisionKey('task', 'v1', 'decider', 700, { ...question, anonymous: true }, 'x')).not.toBe(base);
    expect(decisionKey('task', 'v1', 'decider', 700, { ...question, levels: ['b', 'a'] }, 'x'))
      .not.toBe(decisionKey('task', 'v1', 'decider', 700, { ...question, levels: ['a', 'b'] }, 'x'));
  });
  it('replays only valid level distributions', () => {
    expect(storedDecision({ answer: { status: 'answered', probabilities: [0.2, 0.8] } }))
      .toEqual({ status: 'answered', probabilities: [0.2, 0.8] });
    expect(storedDecision({ answer: { status: 'answered', probabilities: [0.2, 0.8], truncated: true } }))
      .toEqual({ status: 'answered', probabilities: [0.2, 0.8], truncated: true });
    expect(storedDecision({ answer: { status: 'answered', probabilities: [0.9, 0.9] } })).toBeUndefined();
    expect(storedDecision({ answer: { status: 'answered', probabilities: ['0.8', 0.2] } })).toBeUndefined();
    expect(storedDecision({ answer: { status: 'answered', probabilities: [0.5] } })).toBeUndefined();
    expect(storedDecision({ answer: { status: 'answered', probabilities: [0.5, 0.5], probability: 0.1 } })).toBeUndefined();
  });
});

describe('code facts on production-shaped candidates', () => {
  const task = 'List every Postgres migration we ran';
  const taskMs = taskMoment('2025-01-10T00:00:00Z');
  const pool = [
    chat({ sourceId: 'chat', id: 'chat:r:f:3:1:1', signals: {},
      chat: { provider: 'codex', sessionId: 'a', role: 'user' } }),
    chat({ sourceId: 'chat', id: 'chat:r:f:1:1:1', date: { value: '2025-01-01T12:00:00.000Z', meaning: 'recorded' },
      signals: { keyword: 0.9 }, chat: { provider: 'codex', sessionId: 'a', role: 'user' } }),
    chat({ sourceId: 'chat', id: 'chat:r:f:1:1:2', date: { value: '2025-01-01T12:00:00.000Z', meaning: 'recorded' },
      signals: { keyword: 0.9 }, chat: { provider: 'codex', sessionId: 'a', role: 'assistant' } }),
    chat({ sourceId: 'chat', id: 'chat:r:f:2:1:1', date: { value: '2025-01-01T12:00:00.000Z', meaning: 'recorded' },
      signals: { keyword: 0.5 }, chat: { provider: 'codex', sessionId: 'b', role: 'assistant' } }),
  ];

  it('orders position by date, session, then the part id\'s numbers', () => {
    const population = judgmentPopulation(pool);
    expect(population.poolSize).toBe(4);
    expect(population.position.get(pool[0]!)).toBe(0); // no date sorts first
    expect(population.position.get(pool[1]!)).toBe(1);
    expect(population.position.get(pool[2]!)).toBe(2); // same session, higher numbers
    expect(population.position.get(pool[3]!)).toBe(3); // later session id
  });

  it('ranks by keyword score descending, leaving unscored parts without a rank', () => {
    const population = judgmentPopulation(pool);
    expect(population.kwRank.get(pool[1]!)).toBe(0); // 0.9 first, stable order
    expect(population.kwRank.get(pool[2]!)).toBe(1);
    expect(population.kwRank.get(pool[3]!)).toBe(2);
    expect(population.kwRank.get(pool[0]!)).toBeUndefined();
  });

  it('computes the section-4 feature table', () => {
    expect(classifyTask(task)).toEqual(['count', 'named']);
    const population = judgmentPopulation(pool);
    expect(judgmentFacts(pool[1]!, population, task, taskMs)).toEqual({
      hasUser: 1, hasAssistant: 0, userShare: 1,
      daysBefore: 9, position: 1, poolSize: 4,
      kwScore: 0.9, kwRank: 0,
      kind_count: 1, kind_date: 0, kind_advice: 0, kind_named: 1, kind_other: 0,
    });
    expect(judgmentFacts(pool[0]!, population, task, taskMs)).toEqual({
      hasUser: 1, hasAssistant: 0, userShare: 1,
      daysBefore: 180, position: 0, poolSize: 4,
      kind_count: 1, kind_date: 0, kind_advice: 0, kind_named: 1, kind_other: 0,
    });
  });
});

describe('modelScore', () => {
  const model = {
    keys: ['a', 'b', 'missing_key'] as const,
    mu: [0, 10, 5], sd: [2, 5, 1], w: [1, -0.5, 2], b: 0.5, bar: 0.9,
  };
  it('scores positionally on keys and imputes missing features at mu', () => {
    expect(modelScore(model, { a: 4, b: 20 })).toBeCloseTo(
      1 / (1 + Math.exp(-(0.5 + 1 * ((4 - 0) / 2) + -0.5 * ((20 - 10) / 5) + 2 * 0))), 12);
    expect(modelScore(model, { a: 0, b: 10 })).toBeCloseTo(1 / (1 + Math.exp(-0.5)), 12);
  });
});
