import { describe, expect, it, vi, afterEach } from 'vitest';

import { pickFromSources, rankedRead, type PickAnswer, type PickCascade } from '@curatejs/core';
import { jev } from '@curatejs/core/models';
import { AGENT_CHAT_CASCADE, agentTranscripts, chat, JUDGMENT_CHAT_CASCADE } from '@curatejs/chat';
import { GIT_HISTORY_CASCADE } from '@curatejs/git';
import { MARKDOWN_CASCADE } from '@curatejs/markdown';
// @ts-expect-error The standalone JavaScript command has no type declarations.
import { CHAT_MODES, maxDecisionBatchChars, parseSources } from '../skills/curate/run.mjs';

afterEach(() => vi.unstubAllGlobals());

const FITTED: PickCascade = {
  anonymousItems: true,
  model: { keys: ['topic_match', 'answerhood'], mu: [0, 2], sd: [1, 1], w: [1, 1], b: -1, bar: 0.42 },
  questions: [
    { key: 'topic_match', instructions: "Is this excerpt about the question's subject?",
      true: 'Same subject', false: 'Different subject' },
    { key: 'answerhood', instructions: 'Could this excerpt itself be the answer?',
      levels: ['a', 'b', 'c', 'd', 'e'] },
  ],
};

const item = {
  sourceId: 'chat', id: 'chat:r:f:1:1:1', role: 'reference' as const, title: 't',
  text: 'user: evidence', signals: { keyword: 1 },
  chat: { provider: 'codex' as const, sessionId: 's', role: 'user' as const },
};

const score = { probabilities: [0, 0, 0, 0.4, 0.6] } as const;
const decide = async ({ questions }: { questions: readonly { key: string; levels?: readonly string[] }[] }) =>
  Object.fromEntries(questions.map((question) => [question.key,
    question.levels === undefined ? { status: 'answered', probability: 0.8 } satisfies PickAnswer
      : { status: 'answered', probabilities: [...score.probabilities] } satisfies PickAnswer]));

describe('sources.json judgment selection', () => {
  it('accepts questions: judgments and a bar on chat sources only', () => {
    for (const type of ['claude-code', 'codex'] as const) {
      const parsed = parseSources({ sources: [{ type, path: '/x', questions: 'judgments', bar: 0.3,
        ...(type === 'codex' ? { allowedCwd: '/x' } : {}) }] });
      expect(parsed.sources[0]).toMatchObject({ questions: 'judgments', bar: 0.3 });
    }
    expect(CHAT_MODES.judgments).toMatchObject({ questions: JUDGMENT_CHAT_CASCADE, read: rankedRead });
    // 'default' names today's mode: the same source an omitted key produces.
    expect(CHAT_MODES.default).toBe(agentTranscripts);
    const named = parseSources({ sources: [{ type: 'claude-code', path: '/x', questions: 'default' }] });
    expect(named.sources[0]).toMatchObject({ questions: 'default' });
    expect(() => parseSources({ sources: [{ type: 'claude-code', path: '/x', questions: 'other' }] }))
      .toThrowError(/questions/);
    expect(() => parseSources({ sources: [{ type: 'git', path: '.', questions: 'judgments' }] }))
      .toThrowError(/Unknown key/);
    expect(() => parseSources({ sources: [{ type: 'markdown', path: '/x', questions: 'judgments' }] }))
      .toThrowError(/Unknown key/);
    expect(() => parseSources({ sources: [{ type: 'claude-code', path: '/x', bar: 2 }] }))
      .toThrowError(/bar/);
  });
});

describe('a fitted model set through pickFromSources', () => {
  const source = (overrides: Partial<Parameters<typeof chat>[0]>) => ({
    ...chat({ id: 'chat', ...overrides }),
    read: async () => ({ status: 'read' as const, complete: true, candidates: [item] }),
  });

  const fitted = { name: 'fitted', questions: FITTED, read: rankedRead };

  it('selects the set through chat({ mode }) and scores it at its fitted bar', async () => {
    const selected = await pickFromSources([source({ mode: fitted })], { task: 'the task' },
      { task: 'the task', decide });
    expect(selected.record.candidates[0]!.status).toBe('selected');

    const rejected = await pickFromSources([source({ mode: { ...fitted, bar: 0.999 } })], { task: 'the task' },
      { task: 'the task', decide });
    expect(rejected.record.candidates[0]!.status).toBe('rejected');
  });

  it('lets the everyScored pick override win over the source bar', async () => {
    const result = await pickFromSources([source({ mode: fitted })], { task: 'the task' },
      { task: 'the task', decide, everyScored: { bar: 0.999 } });
    expect(result.record.candidates[0]!.status).toBe('rejected');
  });

  it('keeps the default set and bar without selection', async () => {
    const result = await pickFromSources([source({})], { task: 'the task' },
      { task: 'the task', decide });
    expect(result.record.levers.sources.chat?.questions).toBe(AGENT_CHAT_CASCADE);
    expect(result.record.candidates[0]!.status).toBe('selected');
  });
});

describe('decision request bodies for a judgment set', () => {
  it('renders anonymous items and score criteria while the default set stays identified', async () => {
    const bodies: { state: { items: Record<string, unknown> }; questions: Record<string, { type: string; criteria: unknown }> }[] = [];
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      bodies.push(body);
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(body.questions) as [string, { type: string }][]) {
        answers[id] = q.type === 'score' ? { score: 0.5, probabilities: { 0: 0, 1: 0, 2: 0, 3: 0.4, 4: 0.6 } }
          : { noul: 0.8 };
      }
      return Response.json({ model: 'jev-latest', answers });
    }));
    const readers = (set: PickCascade, id: string) => ({
      id, role: 'reference' as const, kind: 'chat' as const,
      mode: { name: id, questions: set, read: rankedRead },
      read: async () => ({ status: 'read' as const, complete: true,
        candidates: [{ ...item, sourceId: id }] }),
    });
    // Every ranked part is decided, so both items can share a request: on
    // the fused order the agent set's part has the chat read's own requests.
    await pickFromSources([readers(FITTED, 'anon'), readers(AGENT_CHAT_CASCADE, 'named')], { task: 'the task' },
      { task: 'the task', decide: jev({ apiKey: 'test' }), everyRanked: true });

    // The first body holds both items: the judgment set's anonymous
    // item renders as text alone, the default set's identified item as
    // id, title and text. A second band-round body renumbers its lone
    // item, so the id check is scoped to the shared body.
    const shared = bodies.find((body) => '2' in body.state.items)!;
    expect(shared.state.items).toEqual({
      1: { date: null, text: 'user: evidence' },
      2: { id: 'chat:r:f:1:1:1', date: null, title: 't', text: 'user: evidence' },
    });
    const types = bodies.flatMap((body) => Object.values(body.questions).map((q) => q.type));
    expect(types).toContain('score');
    expect(types).toContain('noul');
  });
});

describe('maxDecisionBatchChars', () => {
  const longest = (cascades: readonly PickCascade[]) => Math.max(...cascades
    .flatMap((cascade) => cascade.questions)
    .map((question) => question.instructions.length + ('levels' in question
      ? question.levels.join('').length : question.true.length + question.false.length)));

  it('is the state bound less the longest question, levels counted like criteria', () => {
    const sets = [AGENT_CHAT_CASCADE, GIT_HISTORY_CASCADE, MARKDOWN_CASCADE, JUDGMENT_CHAT_CASCADE];
    expect(maxDecisionBatchChars(sets)).toBe(32_000 * 3 - longest(sets));
    // A score question's levels count like true and false criteria:
    // lengthening them past the longest noul question lowers the bound.
    const stretched: PickCascade = { ...JUDGMENT_CHAT_CASCADE,
      questions: JUDGMENT_CHAT_CASCADE.questions.map((question) => 'levels' in question
        ? { ...question, levels: [...question.levels, 'l'.repeat(300)] } : question) };
    const swapped = [AGENT_CHAT_CASCADE, GIT_HISTORY_CASCADE, MARKDOWN_CASCADE, stretched];
    expect(maxDecisionBatchChars(swapped)).toBe(32_000 * 3 - longest(swapped));
    expect(maxDecisionBatchChars(swapped)).toBeLessThan(maxDecisionBatchChars(sets));
  });
});
