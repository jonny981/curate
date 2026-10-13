import { afterEach, describe, expect, it, vi } from 'vitest';
import { curate, pick, type MemoryCandidate, type PickAnswer, type PickCascade, type PickCriterion, type PickDecide, type PickQuestion } from '../src/index.js';

const item = (id: string, overrides: Partial<MemoryCandidate> = {}): MemoryCandidate => ({
  sourceId: 'notes', id, role: 'reference', title: id, text: 'Evidence',
  signals: {}, ...overrides,
});
const answer = (probability: number): PickAnswer => ({ status: 'answered', probability });
const criterion = (key: string): PickCriterion => ({
  key, instructions: `Check ${key}?`, true: `${key} applies.`, false: `${key} does not apply.`,
});
const agreement = criterion('agreement');
const decisionRule = { question: agreement };

function decisions(resolve: (question: PickQuestion) => PickAnswer | undefined = () => answer(0.9)) {
  const calls: PickQuestion[][] = [];
  const decide: PickDecide = async ({ questions }) => {
    calls.push([...questions]);
    return Object.fromEntries(questions.flatMap((question) => {
      const result = resolve(question);
      return result === undefined ? [] : [[question.key, result]];
    }));
  };
  return { decide, calls, ids: () => calls.flat().map((question) => question.id) };
}

afterEach(() => vi.restoreAllMocks());

describe('search lane feeds', () => {
  it('retains the original feed and unions independently limited lane feeds once per candidate', async () => {
    const candidates = [
      item('keyword', { signals: { keyword: 9 }, searchRanks: [0, null, 1] }),
      item('first-lane', { signals: { keyword: 2 }, searchRanks: [1, 0, null] }),
      item('second-lane', { signals: { keyword: 1 }, searchRanks: [2, null, 0] }),
      item('outside', { searchRanks: [3, 2, 2] }),
    ];
    const stub = decisions();
    const result = await pick(candidates, {
      task: 'Find evidence', decide: stub.decide, limits: { maxCandidates: 1 },
    });
    expect(stub.ids()).toEqual(['first-lane', 'keyword', 'second-lane']);
    expect(new Set(stub.ids()).size).toBe(3);
    expect(result.selected.map((candidate) => candidate.id).sort())
      .toEqual(['first-lane', 'keyword', 'second-lane']);
    expect(result.record.candidates.find((entry) => entry.id === 'outside'))
      .toMatchObject({ status: 'unassessed', reason: 'limits' });
    expect(result.record.candidates.map((entry) => [entry.id, entry.priority]))
      .toEqual([['keyword', 0], ['first-lane', 0], ['second-lane', 0], ['outside', 2]]);
  });

  it('interleaves sources independently within each lane before applying its limit', async () => {
    const candidates = [
      item('a-original', { sourceId: 'a', signals: { score: 9 }, searchRanks: [0, null] }),
      item('a-first', { sourceId: 'a', searchRanks: [1, 0] }),
      item('a-next', { sourceId: 'a', searchRanks: [2, 1] }),
      item('b-original', { sourceId: 'b', signals: { score: 9 }, searchRanks: [0, null] }),
      item('b-first', { sourceId: 'b', searchRanks: [1, 0] }),
      item('b-next', { sourceId: 'b', searchRanks: [2, 1] }),
    ];
    const stub = decisions();
    await pick(candidates, { task: 'Find evidence', decide: stub.decide, limits: { maxCandidates: 2 } });
    expect(stub.ids()).toEqual(['a-first', 'b-first', 'a-original', 'b-original']);
    expect(new Set(stub.ids()).size).toBe(4);
  });

  it('does not invent lane hits for null ranks or add empty lanes to the budget', async () => {
    const stub = decisions();
    const result = await pick([
      item('first', { signals: { score: 3 }, searchRanks: [0, null] }),
      item('null', { signals: { score: 2 }, searchRanks: [1, null] }),
      item('later', { searchRanks: [2, null] }),
    ], { task: 'Find evidence', decide: stub.decide, limits: { maxCandidates: 1 } });
    expect(stub.ids()).toEqual(['first']);
    expect(result.record.candidates.slice(1).map((entry) => entry.status))
      .toEqual(['unassessed', 'unassessed']);
  });

  it('rejects a candidate with no rank in any declared lane before calling decide', async () => {
    const stub = decisions();
    await expect(pick([item('no-hit', { searchRanks: [null, null] })], {
      task: 'Find evidence', decide: stub.decide,
    })).rejects.toThrow('searchRanks');
    expect(stub.calls).toEqual([]);
  });

  it('shares every lane candidate budget with rules and keeps rules before references', async () => {
    const stub = decisions();
    const result = await pick([
      item('rule', { role: 'rule' }),
      item('keyword', { signals: { score: 9 } }),
      item('lane', { searchRanks: [0] }),
    ], { task: 'Find evidence', decide: stub.decide, limits: { maxCandidates: 1 } });
    expect(stub.ids()).toEqual(['rule']);
    expect(result.selected.map((candidate) => candidate.id)).toEqual(['rule']);
    expect(result.record.rulesCoverage).toBe('complete');
  });
});

describe('rank protection', () => {
  it('leaves decisions, records and output unchanged when both options are explicitly false', async () => {
    const candidates = [item('first', { signals: { score: 9 }, documentId: 'same' }), item('second', { documentId: 'same' })];
    const ordinary = decisions((question) => answer(question.id === 'first' ? 0.6 : 0.9));
    const disabled = decisions((question) => answer(question.id === 'first' ? 0.6 : 0.9));
    const expected = await pick(candidates, { task: 'Find evidence', decide: ordinary.decide });
    const actual = await pick(candidates, {
      task: 'Find evidence', decide: disabled.decide, rankProtection: false, bestPartFirst: false,
    });
    expect(actual).toEqual(expected);
    expect(disabled.calls).toEqual(ordinary.calls);
    expect(actual.record).not.toHaveProperty('rankProtection');
    expect(actual.record).not.toHaveProperty('bestPartFirst');
    expect(actual.record.candidates.every((entry) => !('searchRanks' in entry) && !('documentId' in entry))).toBe(true);
  });

  it('uses the first three ranks to protect selected references without changing their probabilities', async () => {
    const candidates = [
      item('first', { signals: { score: 9 } }),
      item('second', { signals: { score: 8 } }),
      item('third', { signals: { score: 7 } }),
      item('fourth', { signals: { score: 6 } }),
    ];
    const values: Record<string, number> = { first: 0.6, second: 0.9, third: 0.7, fourth: 1 };
    const stub = decisions((question) => answer(values[question.id]!));
    const result = await pick(candidates, { task: 'Find evidence', decide: stub.decide, rankProtection: true });
    // Scores are 0.9, 0.6, 0.425 and 0.55 respectively.
    expect(result.selected.map((candidate) => candidate.id)).toEqual(['first', 'second', 'fourth', 'third']);
    expect(result.record.candidates.map((entry) => 'probability' in entry ? entry.probability : undefined))
      .toEqual([0.6, 0.9, 0.7, 1]);
  });

  it('uses the rank four and rank eleven weight changes', async () => {
    const candidates = Array.from({ length: 11 }, (_, index) =>
      item(`rank-${index + 1}`, { signals: { score: 11 - index } }));
    const values: Record<string, number> = { 'rank-3': 0.4, 'rank-4': 0.55, 'rank-10': 0.4, 'rank-11': 0.32 };
    const stub = decisions((question) => answer(values[question.id] ?? 0));
    const result = await pick(candidates, {
      task: 'Find evidence', decide: stub.decide, rankProtection: true, thresholds: { reference: 0.1 },
    });
    // Scores: rank 4 = .37; rank 3 = .35; rank 11 = .22836; rank 10 = .22.
    expect(result.selected.map((candidate) => candidate.id)).toEqual(['rank-4', 'rank-3', 'rank-11', 'rank-10']);
  });

  it('passes decision probabilities to the curator after rank protection changes the order', async () => {
    const stub = decisions((question) => answer(question.id === 'first' ? 0.6 : 0.9));
    const picked = await pick([
      item('first', { signals: { score: 9 } }), item('second'),
    ], { task: 'Find evidence', decide: stub.decide, rankProtection: true });
    const curated = await curate('Find evidence', picked, {
      write: async (prompt) => {
        expect(prompt.body).toContain('### first (0.60): first');
        expect(prompt.body).toContain('### second (0.90): second');
        return '[2025-01-01] Evidence (said 2025-01-01; first, second)';
      },
    });
    expect(curated.record.items.map((entry) => [entry.id, entry.weight]))
      .toEqual([['first', 0.6], ['second', 0.9]]);
  });

  it('uses a candidate’s best lane rank instead of its weaker keyword rank', async () => {
    const stub = decisions((question) => answer(question.id === 'lane-first' ? 0.6 : 0.9));
    const result = await pick([
      item('keyword-first', { signals: { score: 10 }, searchRanks: [0, null, null] }),
      item('lane-first', { searchRanks: [9, null, 0] }),
    ], { task: 'Find evidence', decide: stub.decide, rankProtection: true });
    expect(result.selected.map((candidate) => candidate.id)).toEqual(['keyword-first', 'lane-first']);
    expect(result.record.candidates[1]).toMatchObject({ priority: 0 });
  });

  it('never promotes rejected, missing, refused or failed decisions into the selected list', async () => {
    const candidates = ['rejected', 'missing', 'refused', 'error', 'selected']
      .map((id, index) => item(id, { signals: { score: 5 - index } }));
    const stub = decisions((question) => {
      if (question.id === 'missing') return undefined;
      if (question.id === 'refused' || question.id === 'error') return { status: question.id };
      return answer(question.id === 'rejected' ? 0.1 : 0.9);
    });
    const result = await pick(candidates, { task: 'Find evidence', decide: stub.decide, rankProtection: true });
    expect(result.selected.map((candidate) => candidate.id)).toEqual(['selected']);
    expect(result.record.candidates.map((entry) => entry.status))
      .toEqual(['rejected', 'unanswered', 'unanswered', 'unanswered', 'selected']);
  });

  it('keeps rules and keepTop ahead of the protected reference order', async () => {
    const stub = decisions((question) => answer(question.id === 'rule' ? 0.6 : question.id === 'z-lane' ? 1 : 0.6));
    const result = await pick([
      item('rule', { role: 'rule' }),
      item('a-original', { signals: { score: 9 }, searchRanks: [0, 1] }),
      item('z-lane', { searchRanks: [1, 0] }),
    ], { task: 'Find evidence', decide: stub.decide, rankProtection: true, keepTop: 1 });
    expect(result.selected.map((candidate) => candidate.id)).toEqual(['rule', 'a-original', 'z-lane']);
  });
});

describe('best document part first', () => {
  const parts = () => [
    item('tail', { documentId: 'guide', signals: { score: 9 }, text: 'Background details' }),
    item('representative', { documentId: 'guide', title: 'Battery charge', text: 'Battery charge schedule' }),
  ];

  it('asks the part with the most distinct task words in its title and text first', async () => {
    const stub = decisions();
    await pick([
      item('repeat', { documentId: 'guide', signals: { score: 9 }, text: 'battery battery battery' }),
      item('best', { documentId: 'guide', title: 'CHARGE schedule', text: 'battery' }),
    ], { task: 'battery charge schedule', decide: stub.decide, bestPartFirst: true });
    expect(stub.calls.map((batch) => batch.map((question) => question.id))).toEqual([['best'], ['repeat']]);
  });

  it('ignores short words and repeated task words and breaks ties in feed order', async () => {
    const stub = decisions();
    await pick([
      item('first', { documentId: 'guide', signals: { score: 9 }, text: 'battery' }),
      item('short', { documentId: 'guide', text: 'battery to an is' }),
    ], { task: 'battery battery to an is', decide: stub.decide, bestPartFirst: true });
    expect(stub.calls.map((batch) => batch.map((question) => question.id))).toEqual([['first'], ['short']]);
  });

  it.each([
    ['explicit document', { documentId: 'guide' }, { documentId: 'guide' }],
    ['chat session', { chat: { provider: 'codex', sessionId: 'session', role: 'user' } },
      { chat: { provider: 'codex', sessionId: 'session', role: 'assistant' } }],
    ['markdown lines', { contentRef: 'docs/guide.md#L1-L10' }, { contentRef: 'docs/guide.md#L11-L20' }],
    ['markdown path', { path: 'docs/guide.md' }, { path: 'docs/guide.md' }],
  ] satisfies [string, Partial<MemoryCandidate>, Partial<MemoryCandidate>][])('groups parts by %s', async (_label, left, right) => {
    const stub = decisions((question) => answer(question.id === 'representative' ? 0.1 : 0.9));
    const result = await pick([
      item('tail', { ...left, text: 'Background' }),
      item('representative', { ...right, text: 'battery charge' }),
    ], { task: 'battery charge', decide: stub.decide, bestPartFirst: true });
    expect(stub.ids()).toEqual(['representative']);
    expect(result.record.candidates[0]).toMatchObject({ status: 'unassessed', reason: 'document' });
  });

  it.each([
    ['source', { sourceId: 'other', documentId: 'guide' }],
    ['revision', { sourceRevision: 'new', documentId: 'guide' }],
    ['chat provider', { chat: { provider: 'claude-code', sessionId: 'session', role: 'user' } }],
    ['chat session', { chat: { provider: 'codex', sessionId: 'other', role: 'user' } }],
    ['unmarked items', {}],
  ] satisfies [string, Partial<MemoryCandidate>][])('does not group across %s', async (label, other) => {
    const original = label === 'source' || label === 'revision'
      ? { documentId: 'guide', ...(label === 'revision' ? { sourceRevision: 'old' } : {}) }
      : label.startsWith('chat')
        ? { chat: { provider: 'codex' as const, sessionId: 'session', role: 'user' as const } }
        : {};
    const stub = decisions((question) => answer(question.id === 'first' ? 0.1 : 0.9));
    await pick([item('first', original), item('second', other)], {
      task: 'Find evidence', decide: stub.decide, bestPartFirst: true,
    });
    expect(stub.ids().sort()).toEqual(['first', 'second']);
  });

  it('uses an explicit document identity ahead of chat or markdown metadata', async () => {
    const stub = decisions((question) => answer(question.id === 'representative' ? 0.1 : 0.9));
    await pick([
      item('tail', { documentId: 'shared', contentRef: 'a.md#L1-L2' }),
      item('representative', { documentId: 'shared', contentRef: 'b.md#L3-L4', text: 'battery charge' }),
    ], { task: 'battery charge', decide: stub.decide, bestPartFirst: true });
    expect(stub.ids()).toEqual(['representative']);
  });

  it.each([0.3, 0.5, 0.8])('expands at probability %s even if the middle agreement rejects', async (probability) => {
    const stub = decisions((question) => answer(question.questionKey === 'agreement'
      ? (question.id === 'representative' ? 0 : 1)
      : question.id === 'representative' ? probability : 0.9));
    const result = await pick(parts(), {
      task: 'battery charge schedule', decide: stub.decide, bestPartFirst: true, decisionRule,
    });
    expect(stub.ids()).toContain('tail');
    expect(result.record.candidates[0]).toMatchObject({ status: 'selected' });
    expect(result.record.candidates[1]).toMatchObject({ status: probability > 0.7 ? 'selected' : 'rejected' });
  });

  it('skips the remaining parts only when the representative confidently falls below the low bar', async () => {
    const stub = decisions((question) => answer(question.id === 'representative' ? 0.299 : 0.9));
    const result = await pick(parts(), {
      task: 'battery charge schedule', decide: stub.decide, bestPartFirst: true, decisionRule,
    });
    expect(stub.ids()).toEqual(['representative']);
    expect(result.record.candidates[0]).toMatchObject({ status: 'unassessed', reason: 'document' });
    expect(result.record.candidates[1]).toMatchObject({ status: 'rejected', probability: 0.299 });
  });

  it('uses an overridden low bar for deciding whether to expand', async () => {
    const stub = decisions((question) => answer(question.id === 'representative' ? 0.39 : 0.9));
    const result = await pick(parts(), {
      task: 'battery charge schedule', decide: stub.decide, bestPartFirst: true,
      decisionRule: { ...decisionRule, low: 0.4 },
    });
    expect(stub.ids()).toEqual(['representative']);
    expect(result.record.candidates[0]).toMatchObject({ status: 'unassessed', reason: 'document' });
  });

  it('expands a selected representative even below the default low bar', async () => {
    const stub = decisions((question) => answer(question.id === 'representative' ? 0.2 : 0.9));
    const result = await pick(parts(), {
      task: 'battery charge schedule', decide: stub.decide, bestPartFirst: true, thresholds: { reference: 0.1 },
    });
    expect(stub.ids()).toEqual(['representative', 'tail']);
    expect(result.selected.map((candidate) => candidate.id).sort()).toEqual(['representative', 'tail']);
  });

  it.each(['missing', 'refused', 'error'] as const)('expands after an uncertain %s representative', async (status) => {
    const stub = decisions((question) => question.id === 'representative'
      ? status === 'missing' ? undefined : { status }
      : answer(0.9));
    const result = await pick(parts(), { task: 'battery charge schedule', decide: stub.decide, bestPartFirst: true });
    expect(stub.ids()).toEqual(['representative', 'tail']);
    expect(result.record.candidates[0]).toMatchObject({ status: 'selected' });
    expect(result.record.candidates[1]).toMatchObject({ status: 'unanswered', answer: status });
  });

  it('expands after the representative’s decision call throws', async () => {
    const asked: string[] = [];
    const result = await pick(parts(), {
      task: 'battery charge schedule', bestPartFirst: true,
      decide: async ({ questions }) => {
        asked.push(...questions.map((question) => question.id));
        if (questions.some((question) => question.id === 'representative')) throw new Error('decision failed');
        return Object.fromEntries(questions.map((question) => [question.key, answer(0.9)]));
      },
    });
    expect(asked).toEqual(['representative', 'tail']);
    expect(result.record.candidates[0]).toMatchObject({ status: 'selected' });
    expect(result.record.candidates[1]).toMatchObject({ status: 'unanswered', answer: 'error' });
  });

  it('never expands a document beyond the fed candidates or the lane budgets', async () => {
    const stub = decisions();
    const result = await pick([
      item('fed', { documentId: 'guide', signals: { score: 9 }, text: 'battery' }),
      item('outside', { documentId: 'guide', text: 'battery charge schedule' }),
    ], { task: 'battery charge schedule', decide: stub.decide, bestPartFirst: true, limits: { maxCandidates: 1 } });
    expect(stub.ids()).toEqual(['fed']);
    expect(result.record.candidates[1]).toMatchObject({ status: 'unassessed', reason: 'limits' });
  });

  it('completes representative cascades and agreement before asking another part', async () => {
    const cascade: PickCascade = {
      bias: 0, first: 'relevant', band: [0.1, 0.9], firstOnly: { bias: 0, weight: 1 },
      questions: [{ ...criterion('relevant'), weight: 1 }, { ...criterion('needed'), weight: 0 }],
    };
    const stub = decisions((question) => answer(question.questionKey === 'agreement' ? 0.1 : 0.5));
    await pick(parts(), { task: 'battery charge schedule', decide: stub.decide, bestPartFirst: true, cascade, decisionRule });
    expect(stub.calls.map((batch) => batch.map((question) => `${question.id}:${question.questionKey}`))).toEqual([
      ['representative:relevant'], ['representative:needed'], ['representative:agreement'],
      ['tail:relevant'], ['tail:needed'], ['tail:agreement'],
    ]);
  });

  it.each(['missing', 'refused', 'error'] as const)('expands when a fitted question returns %s despite a low combined score', async (status) => {
    const cascade: PickCascade = {
      bias: 0, questions: [{ ...criterion('relevant'), weight: 1 }, { ...criterion('needed'), weight: 0 }],
    };
    const stub = decisions((question) => {
      if (question.id === 'representative' && question.questionKey === 'needed') {
        return status === 'missing' ? undefined : { status };
      }
      return answer(question.id === 'representative' ? 0.1 : 0.9);
    });
    const result = await pick(parts(), {
      task: 'battery charge schedule', decide: stub.decide, bestPartFirst: true, cascade,
    });
    expect(stub.ids()).toEqual(['representative', 'representative', 'tail', 'tail']);
    expect(result.record.candidates[0]).toMatchObject({ status: 'selected' });
    expect(result.record.candidates[1]).toMatchObject({ status: 'rejected' });
  });

  it('does not treat deliberately unasked questions outside a cascade band as uncertain', async () => {
    const cascade: PickCascade = {
      bias: 0, first: 'relevant', band: [0.2, 0.8], firstOnly: { bias: 0, weight: 1 },
      questions: [{ ...criterion('relevant'), weight: 1 }, { ...criterion('needed'), weight: 0 }],
    };
    const stub = decisions((question) => answer(question.id === 'representative' ? 0.1 : 0.9));
    const result = await pick(parts(), {
      task: 'battery charge schedule', decide: stub.decide, bestPartFirst: true, cascade,
    });
    expect(stub.calls.map((batch) => batch.map((question) => `${question.id}:${question.questionKey}`)))
      .toEqual([['representative:relevant']]);
    expect(result.record.candidates[0]).toMatchObject({ status: 'unassessed', reason: 'document' });
  });

  it('uses each source kind’s cascade for representatives and expanded parts', async () => {
    const stub = decisions();
    const result = await pick([
      ...parts(),
      item('chat-tail', { sourceId: 'chat', documentId: 'session' }),
      item('chat-representative', { sourceId: 'chat', documentId: 'session', text: 'battery charge schedule' }),
    ], {
      task: 'battery charge schedule', decide: stub.decide, bestPartFirst: true,
      sourceKinds: { notes: 'markdown', chat: 'chat' },
      cascadesByKind: {
        markdown: { bias: 0, questions: [{ ...criterion('note'), weight: 1 }] },
        chat: { bias: 0, questions: [{ ...criterion('chat'), weight: 1 }] },
      },
    });
    expect(stub.calls.map((batch) => batch.map((question) => `${question.id}:${question.questionKey}`).sort())).toEqual([
      ['chat-representative:chat', 'representative:note'], ['chat-tail:chat', 'tail:note'],
    ]);
    expect(result.selected).toHaveLength(4);
  });

  it('still allows an assessed note to link to a selected commit after expansion', async () => {
    const stub = decisions((question) => answer(question.id === 'tail' ? 0.45 : 0.9));
    const result = await pick([
      item('commit', { sourceId: 'commits', repository: 'repo', changedPaths: ['guide.md'] }),
      item('tail', { documentId: 'guide', repository: 'repo', path: 'guide.md' }),
      item('representative', { documentId: 'guide', text: 'battery charge schedule' }),
    ], { task: 'battery charge schedule', decide: stub.decide, bestPartFirst: true });
    expect(result.record.candidates[1]).toMatchObject({
      status: 'selected', probability: 0.45, link: { sourceId: 'commits', id: 'commit' },
    });
  });
});

describe('stopping document assessment', () => {
  const parts = () => [
    item('tail', { documentId: 'guide', signals: { score: 9 } }),
    item('representative', { documentId: 'guide', text: 'battery charge' }),
  ];

  it('records limits for an unasked tail after the representative batch uses the budget', async () => {
    const stub = decisions((question) => answer(question.id === 'representative' ? 0.9 : 0.1));
    const result = await pick(parts(), {
      task: 'battery charge', decide: stub.decide, bestPartFirst: true, limits: { maxBatches: 1 },
    });
    expect(stub.ids()).toEqual(['representative']);
    expect(result.record.candidates[0]).toMatchObject({ status: 'unassessed', reason: 'limits' });
  });

  it('records cancellation rather than document rejection when the representative call aborts', async () => {
    const controller = new AbortController();
    const stub = decisions((question) => {
      if (question.id === 'representative') controller.abort();
      return answer(0.1);
    });
    const result = await pick(parts(), {
      task: 'battery charge', decide: stub.decide, bestPartFirst: true, signal: controller.signal,
    });
    expect(stub.ids()).toEqual(['representative']);
    expect(result.record.candidates[0]).toMatchObject({ status: 'unassessed', reason: 'cancelled' });
  });

  it('records elapsed time rather than document rejection between phases', async () => {
    let elapsed = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => elapsed);
    const stub = decisions((question) => {
      if (question.id === 'representative') elapsed = 100;
      return answer(0.1);
    });
    const result = await pick(parts(), {
      task: 'battery charge', decide: stub.decide, bestPartFirst: true, limits: { maxElapsedMs: 50 },
    });
    expect(stub.ids()).toEqual(['representative']);
    expect(result.record.candidates[0]).toMatchObject({ status: 'unassessed', reason: 'time' });
  });

  it('retains the stop reason when the representative’s agreement cannot be asked', async () => {
    const stub = decisions(() => answer(0.5));
    const result = await pick(parts(), {
      task: 'battery charge', decide: stub.decide, bestPartFirst: true, decisionRule, limits: { maxBatches: 1 },
    });
    expect(stub.ids()).toEqual(['representative']);
    expect(result.record.candidates.map((entry) => [entry.status, 'reason' in entry ? entry.reason : undefined]))
      .toEqual([['unassessed', 'limits'], ['unassessed', 'limits']]);
  });

  it('never skips document rules and never reports complete rule coverage when their questions stop', async () => {
    const stub = decisions((question) => answer(question.id === 'rule-a' ? 0.1 : 0.9));
    const result = await pick([
      item('rule-a', { role: 'rule', documentId: 'rules', signals: { score: 9 } }),
      item('rule-b', { role: 'rule', documentId: 'rules' }),
      ...parts(),
    ], {
      task: 'battery charge', decide: stub.decide, bestPartFirst: true,
      limits: { maxPerBatch: 1, maxBatches: 1 },
    });
    expect(stub.ids()).toEqual(['rule-a']);
    expect(result.record.candidates[1]).toMatchObject({ status: 'unassessed', reason: 'limits' });
    expect(result.record.rulesCoverage).toBe('incomplete');
  });

  it('assesses every rule even when rules share a document that the first answer rejects', async () => {
    const stub = decisions((question) => answer(question.id === 'rule-a' ? 0.1 : 0.9));
    const result = await pick([
      item('rule-a', { role: 'rule', documentId: 'rules', signals: { score: 9 } }),
      item('rule-b', { role: 'rule', documentId: 'rules' }),
    ], { task: 'battery charge', decide: stub.decide, bestPartFirst: true });
    expect(stub.ids()).toEqual(['rule-a', 'rule-b']);
    expect(result.record.rulesCoverage).toBe('complete');
    expect(result.selected.map((candidate) => candidate.id)).toEqual(['rule-b']);
  });
});
