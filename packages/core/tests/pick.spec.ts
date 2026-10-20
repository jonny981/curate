import { describe, expect, it } from 'vitest';

import {
  pick,
  curate,
  PickError,
  PICK_QUESTION_VERSION,
  type MemoryCandidate,
  type PickAnswer,
  type PickBatch,
  type PickCascade,
  type PickDecide,
} from '../src/index.js';

function candidate(overrides: Partial<MemoryCandidate> & Pick<MemoryCandidate, 'sourceId' | 'id'>): MemoryCandidate {
  return {
    role: 'reference',
    title: overrides.id,
    text: `text of ${overrides.sourceId}/${overrides.id}`,
    signals: { score: 0 },
    ...overrides,
  };
}

function answered(probability: number): PickAnswer {
  return { status: 'answered', probability };
}

function stubDecide(
  handler: (batch: PickBatch, call: number) => Record<string, PickAnswer>,
): { decide: PickDecide; calls: PickBatch[]; signals: AbortSignal[] } {
  const calls: PickBatch[] = [];
  const signals: AbortSignal[] = [];
  return {
    calls,
    signals,
    decide: async (batch, signal) => {
      calls.push(batch);
      signals.push(signal);
      return handler(batch, calls.length);
    },
  };
}

function allAnswered(batch: PickBatch, probability: number): Record<string, PickAnswer> {
  return Object.fromEntries(batch.questions.map((question) => [question.key, answered(probability)]));
}

describe('pick', () => {
  it('keeps every scored reference, orders by probability and gives the curator every weight', async () => {
    const candidates = [
      candidate({ sourceId: 'notes', id: 'zero', signals: { score: 10 } }),
      candidate({ sourceId: 'notes', id: 'strong' }),
      candidate({ sourceId: 'notes', id: 'weak' }),
      candidate({ sourceId: 'rules', id: 'does-not-apply', role: 'rule' }),
      candidate({ sourceId: 'rules', id: 'applies', role: 'rule' }),
    ];
    const probabilities: Record<string, number> = { zero: 0, strong: 0.9, weak: 0.01, 'does-not-apply': 0.59, applies: 0.6 };
    const { decide } = stubDecide((batch) => Object.fromEntries(batch.questions.map((q) =>
      [q.key, answered(probabilities[q.id]!)])));
    const picked = await pick(candidates, { task: 'Recall evidence', decide });
    expect(picked.selected.map((item) => item.id)).toEqual(['applies', 'does-not-apply', 'strong', 'weak', 'zero']);
    expect(picked.record.thresholds).toEqual({ reference: 0, rule: 0, linkedPathBar: 0.4 });
    const result = await curate('Recall evidence', picked, { write: async (prompt) => {
      expect(prompt.body).toContain('### E2 (0.01): weak');
      expect(prompt.body).toContain('### E3 (0): zero');
      expect(prompt.body).not.toContain('does-not-apply');
      return '[2026-01-01] Evidence (said 2026-01-01; E3)';
    } });
    expect(result.record.items.map((item) => [item.id, item.weight])).toEqual([
      ['strong', 0.9], ['weak', 0.01], ['zero', 0],
    ]);
  });

  it('ranks candidates inside a source and selects those at or above the threshold', async () => {
    const candidates = [
      candidate({ sourceId: 'notes', id: 'low', signals: { score: 1 } }),
      candidate({ sourceId: 'notes', id: 'high', signals: { score: 9 } }),
      candidate({ sourceId: 'notes', id: 'mid', signals: { score: 5 } }),
    ];
    const { decide, calls } = stubDecide((batch) =>
      Object.fromEntries(batch.questions.map((question) => [
        question.key,
        answered(question.id === 'low' ? 0.2 : 0.9),
      ])));

    const result = await pick(candidates, { task: 'fix the flaky test', decide, everyScored: { bar: 0.6 } });

    expect(result.selected.map((item) => item.id)).toEqual(['high', 'mid']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.questions.map((question) => question.id)).toEqual(['high', 'mid', 'low']);
    expect(result.record.questionVersion).toBe(PICK_QUESTION_VERSION);
    expect(result.record.thresholds).toEqual({ reference: 0.6, rule: 0, linkedPathBar: 0.4 });
    expect(result.record.limits).toEqual({ maxPerBatch: 150 });
    expect(result.record.candidates.map((entry) => [entry.id, entry.priority])).toEqual([
      ['low', 2],
      ['high', 0],
      ['mid', 1],
    ]);
    expect(result.record.candidates.map((entry) => entry.status)).toEqual([
      'rejected', 'selected', 'selected',
    ]);
    expect(result.record.rulesCoverage).toBe('complete');
  });

  it('shares the budget across reference sources so a large source cannot crowd out a small one', async () => {
    const commits = Array.from({ length: 500 }, (_, index) =>
      candidate({ sourceId: 'commits', id: `c${index}`, signals: { score: 1000 - index } }));
    const handbook = Array.from({ length: 5 }, (_, index) =>
      candidate({ sourceId: 'handbook', id: `h${index}`, signals: { score: index } }));
    const { decide, calls } = stubDecide((batch) => allAnswered(batch, 0.1));

    const result = await pick([...commits, ...handbook], {
      task: 'plan the release',
      decide,
      limits: { maxCandidates: 10, maxPerBatch: 10 },
    });

    const askedIds = calls.flatMap((batch) => batch.questions.map((question) => question.sourceId));
    expect(askedIds.filter((sourceId) => sourceId === 'handbook')).toHaveLength(5);
    expect(askedIds.filter((sourceId) => sourceId === 'commits')).toHaveLength(5);
    const unassessed = result.record.candidates.filter((entry) => entry.status === 'unassessed');
    expect(unassessed).toHaveLength(495);
    expect(unassessed.every((entry) => entry.status === 'unassessed' && entry.reason === 'limits')).toBe(true);
  });

  it('marks remaining candidates unassessed with reason cancelled when the signal aborts mid-run', async () => {
    const controller = new AbortController();
    const candidates = Array.from({ length: 5 }, (_, index) =>
      candidate({ sourceId: 'notes', id: `n${index}`, signals: { score: 5 - index } }));
    const { decide, calls, signals } = stubDecide((batch, call) => {
      if (call === 1) controller.abort();
      return allAnswered(batch, 0.9);
    });

    const result = await pick(candidates, {
      task: 'write the report',
      decide,
      limits: { maxPerBatch: 2 },
      signal: controller.signal,
    });

    expect(calls).toHaveLength(1);
    expect(signals[0]).toBe(controller.signal);
    expect(signals[0]!.aborted).toBe(true);
    expect(result.record.candidates.map((entry) => entry.status)).toEqual([
      'selected', 'selected', 'unassessed', 'unassessed', 'unassessed',
    ]);
    expect(result.record.candidates.slice(2).every((entry) =>
      entry.status === 'unassessed' && entry.reason === 'cancelled')).toBe(true);
  });

  it('keeps asking after a batch that selects nothing', async () => {
    const candidates = Array.from({ length: 6 }, (_, index) =>
      candidate({ sourceId: 'notes', id: `n${index}`, signals: { score: 6 - index } }));
    const { decide, calls } = stubDecide((batch, call) =>
      allAnswered(batch, call === 2 ? 0.1 : 0.9));

    const result = await pick(candidates, {
      task: 'triage the bug',
      decide,
      everyScored: { bar: 0.6 },
      limits: { maxPerBatch: 2 },
    });

    expect(calls).toHaveLength(3);
    expect(result.selected.map((item) => item.id)).toEqual(['n0', 'n1', 'n4', 'n5']);
    expect(result.record.candidates.map((entry) => entry.status)).toEqual([
      'selected', 'selected', 'rejected', 'rejected', 'selected', 'selected',
    ]);
  });

  it('asks and records two candidates that share a relative path in different sources', async () => {
    const candidates = [
      candidate({ sourceId: 'left', id: 'docs/todo.md' }),
      candidate({ sourceId: 'right', id: 'docs/todo.md' }),
    ];
    const { decide, calls } = stubDecide((batch) => {
      const answers: Record<string, PickAnswer> = {};
      for (const question of batch.questions) {
        if (question.sourceId === 'left') answers[question.key] = answered(0.9);
      }
      return answers;
    });

    const result = await pick(candidates, { task: 'review the list', decide });

    const questions = calls.flatMap((batch) => batch.questions);
    expect(questions.map((question) => question.sourceId)).toEqual(['left', 'right']);
    expect(new Set(questions.map((question) => question.key)).size).toBe(2);
    expect(result.selected.map((item) => item.sourceId)).toEqual(['left']);
    expect(result.record.candidates.map((entry) => [entry.sourceId, entry.status])).toEqual([
      ['left', 'selected'],
      ['right', 'unanswered'],
    ]);
  });

  it('records a missing key, a refusal and an out-of-range probability as unanswered', async () => {
    const candidates = Array.from({ length: 4 }, (_, index) =>
      candidate({ sourceId: 'notes', id: `n${index}` }));
    const { decide } = stubDecide((batch) => ({
      [batch.questions[0]!.key]: answered(0.9),
      [batch.questions[2]!.key]: { status: 'refused', detail: 'no opinion' },
      [batch.questions[3]!.key]: answered(1.5),
    }));

    const result = await pick(candidates, { task: 'pick a fix', decide });

    expect(result.selected.map((item) => item.id)).toEqual(['n0']);
    const statuses = result.record.candidates;
    expect(statuses[1]).toMatchObject({ status: 'unanswered', answer: 'missing' });
    expect(statuses[2]).toMatchObject({ status: 'unanswered', answer: 'refused', detail: 'no opinion' });
    expect(statuses[3]).toMatchObject({ status: 'unanswered', answer: 'error' });
    expect(statuses.some((entry) => entry.status === 'rejected')).toBe(false);
  });

  it('stops when a decide call stays pending past the elapsed limit', async () => {
    const candidates = Array.from({ length: 4 }, (_, index) =>
      candidate({ sourceId: 'notes', id: `n${index}` }));
    let received: AbortSignal | undefined;
    const decide: PickDecide = (_batch, signal) => {
      received = signal;
      return new Promise<Record<string, PickAnswer>>(() => {});
    };

    const result = await pick(candidates, {
      task: 'triage the queue',
      decide,
      limits: { maxPerBatch: 2, maxElapsedMs: 25 },
    });

    expect(received?.aborted).toBe(true);
    expect(result.record.candidates.map((entry) => entry.status)).toEqual([
      'unanswered', 'unanswered', 'unassessed', 'unassessed',
    ]);
    expect(result.record.candidates.slice(0, 2).every((entry) =>
      entry.status === 'unanswered' && entry.answer === 'error')).toBe(true);
    expect(result.record.candidates.slice(2).every((entry) =>
      entry.status === 'unassessed' && entry.reason === 'time')).toBe(true);
  });

  it('fails the pick when the decide call throws, carrying a record that names the batch and the error', async () => {
    const candidates = [
      candidate({ sourceId: 'notes', id: 'alpha', signals: { score: 3 } }),
      candidate({ sourceId: 'notes', id: 'beta', signals: { score: 2 } }),
      candidate({ sourceId: 'notes', id: 'unasked', signals: { score: 1 } }),
    ];
    const { decide, calls } = stubDecide(() => {
      throw new Error('engine down');
    });

    const failure = await pick(candidates, {
      task: 'fix it', decide, limits: { maxPerBatch: 2 },
    }).then(
      () => { throw new Error('the pick resolved'); },
      (reason: unknown) => reason as PickError,
    );

    expect(failure).toBeInstanceOf(PickError);
    expect(failure.message).toBe('The decide call failed for candidates alpha, beta: engine down');
    expect(failure.record.decideError).toEqual({ candidates: ['alpha', 'beta'], message: 'engine down' });
    expect(failure.record.candidates.map((entry) => entry.status)).toEqual([
      'unanswered', 'unanswered', 'unassessed',
    ]);
    expect(failure.record.candidates[0]).toMatchObject({ answer: 'error', detail: 'engine down' });
    expect(failure.record.candidates[2]).toMatchObject({ reason: 'error' });
    // No retry and no later batch: the first failure ends the pick.
    expect(calls).toHaveLength(1);
  });

  it('records cancelled rather than failing when the aborted decide call throws', async () => {
    const controller = new AbortController();
    const candidates = Array.from({ length: 4 }, (_, index) =>
      candidate({ sourceId: 'notes', id: `n${index}`, signals: { score: 5 - index } }));
    const { decide, calls } = stubDecide((batch, call) => {
      if (call === 1) {
        controller.abort();
        throw new Error('the host aborted the request');
      }
      return allAnswered(batch, 0.9);
    });

    const result = await pick(candidates, {
      task: 'write the report', decide, limits: { maxPerBatch: 2 }, signal: controller.signal,
    });

    expect(calls).toHaveLength(1);
    expect(result.record.candidates.map((entry) => entry.status)).toEqual([
      'unanswered', 'unanswered', 'unassessed', 'unassessed',
    ]);
    expect(result.record.candidates.slice(2).every((entry) =>
      entry.status === 'unassessed' && entry.reason === 'cancelled')).toBe(true);
  });

  it('marks a candidate unanswered when a later batch of its cascade fails after an earlier batch answered', async () => {
    const cascade: PickCascade = {
      bias: 0,
      first: 'gate',
      band: [0, 0.9],
      firstOnly: { bias: 0, weight: 1 },
      questions: [
        { key: 'gate', instructions: 'Gate?', true: 'yes', false: 'no', weight: 1 },
        { key: 'rest', instructions: 'Rest?', true: 'yes', false: 'no', weight: 1 },
      ],
    };
    const { decide, calls } = stubDecide((batch, call) => {
      if (call === 2) throw new Error('second request rejected');
      return Object.fromEntries(batch.questions.map((question) => [
        question.key, answered(question.id === 'b' ? 0.99 : 0.5),
      ]));
    });

    const failure = await pick([
      candidate({ sourceId: 'notes', id: 'a', signals: { score: 2 } }),
      candidate({ sourceId: 'notes', id: 'b', signals: { score: 1 } }),
    ], { task: 't', decide, cascade }).then(
      () => { throw new Error('the pick resolved'); },
      (reason: unknown) => reason as PickError,
    );

    expect(calls).toHaveLength(2);
    // The failed batch held only a's remaining question; b's gate answer
    // landed outside the band, so its cascade finished on the first call.
    expect(failure.record.decideError).toEqual({ candidates: ['a'], message: 'second request rejected' });
    const byId = new Map(failure.record.candidates.map((entry) => [entry.id, entry]));
    expect(byId.get('a')).toMatchObject({ status: 'unanswered', answer: 'error', detail: 'second request rejected' });
    expect(byId.get('a')!.questions).toEqual([
      { key: 'gate', status: 'answered', probability: 0.5 },
      { key: 'rest', status: 'error', detail: 'second request rejected' },
    ]);
    expect(byId.get('b')).toMatchObject({ status: 'selected' });
  });

  it('keeps a decided selection standing when a tag batch fails, with the error on the tag answers', async () => {
    const { decide, calls } = stubDecide((batch, call) => {
      if (call === 2) throw new Error('tag request rejected');
      return allAnswered(batch, 0.9);
    });

    const failure = await pick([candidate({ sourceId: 'notes', id: 'a' })], {
      task: 't', decide,
      tags: [{ key: 'intent', questions: [{ key: 'why', instructions: 'Why?', true: 't', false: 'f' }] }],
    }).then(
      () => { throw new Error('the pick resolved'); },
      (reason: unknown) => reason as PickError,
    );

    expect(calls).toHaveLength(2);
    expect(failure.record.decideError).toEqual({ candidates: ['a'], message: 'tag request rejected' });
    const entry = failure.record.candidates[0]!;
    expect(entry.status).toBe('selected');
    expect(entry.tags?.intent?.answers).toEqual([
      { key: 'why', status: 'error', detail: 'tag request rejected' },
    ]);
    expect(entry.tags?.intent?.value).toBeUndefined();
  });

  it('reports incomplete rule coverage when limits stop before the last rule', async () => {
    const rules = Array.from({ length: 3 }, (_, index) =>
      candidate({ sourceId: 'rules', id: `r${index}`, role: 'rule', signals: { score: index } }));
    const limited = stubDecide((batch) => allAnswered(batch, 0.9));

    const result = await pick(rules, {
      task: 'change the schema',
      decide: limited.decide,
      limits: { maxBatches: 1, maxPerBatch: 2 },
    });

    expect(result.record.rulesCoverage).toBe('incomplete');
    expect(result.record.candidates.find((entry) => entry.status === 'unassessed'))
      .toMatchObject({ id: 'r0', reason: 'limits' });

    const room = stubDecide((batch) => allAnswered(batch, 0.9));
    const complete = await pick(rules, {
      task: 'change the schema',
      decide: room.decide,
      limits: { maxPerBatch: 2 },
    });
    expect(complete.record.rulesCoverage).toBe('complete');
    expect(complete.selected).toHaveLength(3);
  });

  it('treats an unanswered rule as incomplete coverage', async () => {
    const rules = [
      candidate({ sourceId: 'rules', id: 'r0', role: 'rule' }),
      candidate({ sourceId: 'rules', id: 'r1', role: 'rule' }),
    ];
    const { decide } = stubDecide((batch) => ({
      [batch.questions[0]!.key]: answered(0.9),
      [batch.questions[1]!.key]: { status: 'refused' },
    }));

    const result = await pick(rules, { task: 'migrate the data', decide });

    expect(result.record.rulesCoverage).toBe('incomplete');
  });

  it('selects an applies-always rule without asking and still checks the rest', async () => {
    const rules = [
      candidate({ sourceId: 'rules', id: 'always', role: 'rule', applies: 'always' }),
      candidate({ sourceId: 'rules', id: 'maybe', role: 'rule' }),
    ];
    const { decide, calls } = stubDecide((batch) => allAnswered(batch, 0.9));

    const result = await pick(rules, { task: 'ship it', decide });

    expect(calls.flatMap((batch) => batch.questions.map((question) => question.id))).toEqual(['maybe']);
    expect(result.selected.map((item) => item.id)).toEqual(['always', 'maybe']);
    expect(result.record.candidates[0]).toMatchObject({ status: 'selected', asked: false });
    expect(result.record.rulesCoverage).toBe('complete');
  });

  it('judges full candidate text and every batch by default', async () => {
    const candidates = Array.from({ length: 751 }, (_, index) => candidate({
      sourceId: 'notes', id: `item-${index}`, text: 'x'.repeat(701) + `evidence-${index}`,
    }));
    const seen = new Map<string, string>();
    const result = await pick(candidates, { task: 'find evidence', decide: async (batch) => {
      for (const question of batch.questions) seen.set(question.id, question.text);
      return Object.fromEntries(batch.questions.map((question) => [question.key,
        answered(question.text.endsWith(`evidence-${question.id.slice(5)}`) ? 1 : 0)]));
    } });
    expect(seen.size).toBe(751);
    expect(candidates.every((candidate) => seen.get(candidate.id) === candidate.text)).toBe(true);
    expect(result.selected).toHaveLength(751);
    expect(result.record.candidates.every((entry) => entry.truncated === false)).toBe(true);
    expect(result.record.limits).toEqual({ maxPerBatch: 150 });
  });

  it('cuts question text to maxQuestionText and flags the candidate as truncated', async () => {
    const long = candidate({ sourceId: 'notes', id: 'long', text: 'x'.repeat(1000) });
    const short = candidate({ sourceId: 'notes', id: 'short', text: 'tiny' });
    const { decide, calls } = stubDecide((batch) => allAnswered(batch, 0.9));

    const result = await pick([long, short], {
      task: 'summarise',
      decide,
      limits: { maxQuestionText: 10 },
    });

    const shown = calls.flatMap((batch) => batch.questions);
    expect(shown.find((question) => question.id === 'long')?.text).toBe('x'.repeat(10));
    expect(shown.find((question) => question.id === 'short')?.text).toBe('tiny');
    expect(result.record.candidates.map((entry) => entry.truncated)).toEqual([true, false]);
  });

  // Each question in these cascades counts 11 characters of wording and
  // criteria ('Is it?' + 'yes' + 'no'); each item counts its id, title,
  // date and text once per batch however many questions it carries.
  const countingCascade: PickCascade = {
    bias: 0,
    questions: [
      { key: 'one', instructions: 'Is it?', true: 'yes', false: 'no', weight: 1 },
      { key: 'two', instructions: 'Is it?', true: 'yes', false: 'no', weight: 1 },
    ],
  };

  it('closes a batch at maxBatchChars, counting the task, each item once and each question’s wording', async () => {
    const candidates = [
      candidate({ sourceId: 'notes', id: 'a', title: 'a', text: 'x'.repeat(10), signals: { score: 3 } }),
      candidate({
        sourceId: 'notes', id: 'b', title: 'b', text: 'x'.repeat(10), signals: { score: 2 },
        date: { value: '2026-01-01', meaning: 'recorded' },
      }),
      candidate({ sourceId: 'notes', id: 'c', title: 'c', text: 'x'.repeat(10), signals: { score: 1 } }),
    ];
    const { decide, calls } = stubDecide((batch) => allAnswered(batch, 0.9));

    // 'a' counts 12 + 11 + 11 = 34 and 'b' counts 30 + 22 = 52 with its
    // date; the task's 6 characters leave room for a + b (92) inside the
    // bound of 110, but even c's first question (115) would pass it.
    const result = await pick(candidates, {
      task: 'fix it', decide, cascade: countingCascade, limits: { maxBatchChars: 110 },
    });

    expect(calls.map((batch) => batch.questions.map((question) => `${question.id}:${question.questionKey}`)))
      .toEqual([['a:one', 'a:two', 'b:one', 'b:two'], ['c:one', 'c:two']]);
    expect(result.record.limits).toEqual({ maxPerBatch: 150, maxBatchChars: 110 });
    expect(result.record.candidates.every((entry) => entry.status === 'selected')).toBe(true);
  });

  it('counts an item once per batch however many of its questions the batch holds', async () => {
    const cascade: PickCascade = {
      bias: 0,
      questions: ['one', 'two', 'three'].map((key) => ({
        key, instructions: 'Is it?', true: 'yes', false: 'no', weight: 1,
      })),
    };
    const { decide, calls } = stubDecide((batch) => allAnswered(batch, 0.9));

    // The item counts 1 + 1 + 20 = 22 once, plus 11 per question:
    // 1 + 22 + 33 = 56 reaches the bound exactly. Counting the item per
    // question (1 + 66 = 67) would split its questions across batches.
    await pick([candidate({ sourceId: 'notes', id: 'a', title: 'a', text: 'x'.repeat(20) })], {
      task: 't', decide, cascade, limits: { maxBatchChars: 56 },
    });

    expect(calls.map((batch) => batch.questions.map((question) => question.questionKey)))
      .toEqual([['one', 'two', 'three']]);
  });

  it('sends an item larger than maxBatchChars alone and drops or cuts nothing', async () => {
    const candidates = [
      candidate({ sourceId: 'notes', id: 'big', title: 'big', text: 'x'.repeat(200), signals: { score: 3 } }),
      candidate({ sourceId: 'notes', id: 's2', title: 's2', text: 'x'.repeat(10), signals: { score: 2 } }),
      candidate({ sourceId: 'notes', id: 's1', title: 's1', text: 'x'.repeat(10), signals: { score: 1 } }),
    ];
    const { decide, calls } = stubDecide((batch) => allAnswered(batch, 0.9));

    // 'big' counts 206 + 11 = 217, over the bound of 51, so it goes by
    // itself; the small items count 14 + 11 = 25 each and share a batch.
    const result = await pick(candidates, {
      task: 't', decide,
      cascade: { bias: 0, questions: [countingCascade.questions[0]!] },
      limits: { maxBatchChars: 51 },
    });

    expect(calls.map((batch) => batch.questions.map((question) => question.id)))
      .toEqual([['big'], ['s2', 's1']]);
    expect(result.selected.map((item) => item.id).sort()).toEqual(['big', 's1', 's2']);
    const questions = calls.flatMap((batch) => batch.questions);
    expect(questions.find((question) => question.id === 'big')?.text).toBe('x'.repeat(200));
    expect(result.record.candidates.every((entry) => entry.status === 'selected')).toBe(true);
  });

  it('closes a batch at maxPerBatch or maxBatchChars, whichever it reaches first', async () => {
    const candidates = Array.from({ length: 4 }, (_, index) => candidate({
      sourceId: 'notes', id: `n${index}`, title: `n${index}`,
      text: 'x'.repeat(20), signals: { score: 4 - index },
    }));

    // The count bound bites first: each item counts 24 + 11 = 35, all
    // four fit the character budget, so batches split at three questions.
    const counted = stubDecide((batch) => allAnswered(batch, 0.9));
    await pick(candidates, {
      task: 't', decide: counted.decide,
      cascade: { bias: 0, questions: [countingCascade.questions[0]!] },
      limits: { maxPerBatch: 3, maxBatchChars: 1000 },
    });
    expect(counted.calls.map((batch) => batch.questions.map((question) => question.id)))
      .toEqual([['n0', 'n1', 'n2'], ['n3']]);

    // The character bound bites first: 1 + 35 + 35 = 71 fits two items,
    // a third would pass it, so batches pair despite the room for 150.
    const sized = stubDecide((batch) => allAnswered(batch, 0.9));
    await pick(candidates, {
      task: 't', decide: sized.decide,
      cascade: { bias: 0, questions: [countingCascade.questions[0]!] },
      limits: { maxPerBatch: 150, maxBatchChars: 71 },
    });
    expect(sized.calls.map((batch) => batch.questions.map((question) => question.id)))
      .toEqual([['n0', 'n1'], ['n2', 'n3']]);
  });

  it('carries changedPaths into the record when a candidate has them', async () => {
    const candidates = [
      candidate({ sourceId: 'commits', id: 'c1', changedPaths: ['src/a.ts', 'docs/b.md'] }),
      candidate({ sourceId: 'commits', id: 'c2' }),
    ];
    const { decide } = stubDecide((batch) => allAnswered(batch, 0.9));

    const result = await pick(candidates, { task: 'ship it', decide });

    expect(result.record.candidates[0]).toMatchObject({ changedPaths: ['src/a.ts', 'docs/b.md'] });
    expect(result.record.candidates[1]).not.toHaveProperty('changedPaths');
  });

  it('reports incomplete rule coverage when the rule source could not enumerate, even with every rule answered', async () => {
    const rules = [
      candidate({ sourceId: 'rules', id: 'r0', role: 'rule' }),
      candidate({ sourceId: 'rules', id: 'r1', role: 'rule' }),
    ];
    const { decide } = stubDecide((batch) => allAnswered(batch, 0.9));

    const result = await pick(rules, {
      task: 'change the schema',
      decide,
      rulesEnumerationComplete: false,
    });

    expect(result.record.candidates.every((entry) => entry.status === 'selected')).toBe(true);
    expect(result.record.rulesCoverage).toBe('incomplete');
  });

  it('asks the rule question to rules and the evidence question to references', async () => {
    const candidates = [
      candidate({ sourceId: 'rules', id: 'r', role: 'rule' }),
      candidate({ sourceId: 'notes', id: 'n' }),
    ];
    const { decide, calls } = stubDecide((batch) => allAnswered(batch, 0.9));

    await pick(candidates, { task: 'do the thing', decide });

    const questions = calls.flatMap((batch) => batch.questions);
    expect(questions[0]).toMatchObject({
      id: 'r',
      question: 'Does this rule apply to this task?',
    });
    expect(questions[1]).toMatchObject({
      id: 'n',
      question: 'Does this item supply useful evidence, a constraint or a decision for this task?',
    });
    expect(questions.every((question) =>
      typeof question.trueCriterion === 'string' && typeof question.falseCriterion === 'string')).toBe(true);
  });
});

describe('the changed-path link', () => {
  const FULL_SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
  const commit = () => candidate({
    sourceId: 'commits',
    id: 'commit a1b2c3d',
    contentRef: FULL_SHA,
    repository: 'repo-1',
    changedPaths: ['docs/ops.md'],
  });
  const opsNote = () => candidate({
    sourceId: 'notes', id: 'ops', repository: 'repo-1', path: 'docs/ops.md',
  });
  const otherNote = () => candidate({
    sourceId: 'notes', id: 'other', repository: 'repo-1', path: 'docs/other.md',
  });

  function byId(answers: Record<string, PickAnswer>) {
    return (batch: PickBatch) => Object.fromEntries(
      batch.questions.map((question) => [question.key, answers[question.id] ?? answered(0.5)]),
    );
  }

  it('selects a note below the threshold when a selected commit changed its path', async () => {
    const { decide } = stubDecide((batch) =>
      byId({ 'commit a1b2c3d': answered(0.9), ops: answered(0.45), other: answered(0.45) })(batch));

    const result = await pick([commit(), opsNote(), otherNote()], { task: 'fix the ops doc', decide, everyScored: { bar: 0.6 } });

    expect(result.selected.map((item) => item.id).sort()).toEqual(['commit a1b2c3d', 'ops']);
    const byEntry = new Map(result.record.candidates.map((entry) => [entry.id, entry]));
    expect(byEntry.get('ops')).toMatchObject({
      status: 'selected',
      path: 'docs/ops.md',
      repository: 'repo-1',
      link: { sourceId: 'commits', id: 'commit a1b2c3d' },
    });
    // The carrier's saved entry keeps the full commit SHA: the short
    // one in `id` is display text, not the identity a record resolves.
    expect(byEntry.get('commit a1b2c3d')).toMatchObject({
      status: 'selected',
      contentRef: FULL_SHA,
    });
    expect(byEntry.get('commit a1b2c3d')).not.toHaveProperty('link');
    expect(byEntry.get('other')).toMatchObject({ status: 'rejected' });
    expect(result.record.thresholds).toEqual({ reference: 0.6, rule: 0, linkedPathBar: 0.4 });
  });

  it('holds the bar exactly: 0.39 does not link, 0.4 does', async () => {
    const wide = () => candidate({
      sourceId: 'commits',
      id: 'commit a1b2c3d',
      repository: 'repo-1',
      changedPaths: ['docs/ops.md', 'docs/low.md'],
    });
    const low = () => candidate({
      sourceId: 'notes', id: 'low', repository: 'repo-1', path: 'docs/low.md',
    });
    const { decide } = stubDecide((batch) =>
      byId({ 'commit a1b2c3d': answered(0.9), ops: answered(0.4), low: answered(0.39) })(batch));

    const result = await pick([wide(), opsNote(), low()], { task: 'fix the docs', decide, everyScored: { bar: 0.6 } });

    expect(result.selected.map((item) => item.id).sort()).toEqual(['commit a1b2c3d', 'ops']);
    expect(result.record.candidates.find((entry) => entry.id === 'low'))
      .toMatchObject({ status: 'rejected', probability: 0.39 });
  });

  it('honours a linkedPathBar override and never lowers the reference threshold', async () => {
    const { decide } = stubDecide((batch) =>
      byId({ 'commit a1b2c3d': answered(0.9), ops: answered(0.45) })(batch));

    const result = await pick([commit(), opsNote()], {
      task: 'fix the ops doc',
      decide,
      everyScored: { bar: 0.6 }, thresholds: { linkedPathBar: 0.5 },
    });

    expect(result.selected.map((item) => item.id)).toEqual(['commit a1b2c3d']);
    expect(result.record.candidates.find((entry) => entry.id === 'ops'))
      .toMatchObject({ status: 'rejected', probability: 0.45 });
    expect(result.record.thresholds.linkedPathBar).toBe(0.5);
    expect(result.record.thresholds.reference).toBe(0.6);
  });

  it('never links across repositories', async () => {
    const foreign = () => candidate({
      sourceId: 'notes', id: 'foreign', repository: 'repo-2', path: 'docs/ops.md',
    });
    const { decide } = stubDecide((batch) =>
      byId({ 'commit a1b2c3d': answered(0.9), foreign: answered(0.45) })(batch));

    const result = await pick([commit(), foreign()], { task: 'fix the ops doc', decide, everyScored: { bar: 0.6 } });

    expect(result.record.candidates.find((entry) => entry.id === 'foreign'))
      .toMatchObject({ status: 'rejected', probability: 0.45 });
  });

  it('never lets a linked candidate carry another over', async () => {
    // The mid candidate links in through the commit and itself touches
    // the deep note's path; it was not threshold-selected, so the deep
    // note must stay rejected.
    const mid = () => candidate({
      sourceId: 'notes',
      id: 'mid',
      repository: 'repo-1',
      path: 'docs/ops.md',
      changedPaths: ['docs/deep.md'],
    });
    const deep = () => candidate({
      sourceId: 'notes', id: 'deep', repository: 'repo-1', path: 'docs/deep.md',
    });
    const { decide } = stubDecide((batch) =>
      byId({
        'commit a1b2c3d': answered(0.9),
        mid: answered(0.45),
        deep: answered(0.45),
      })(batch));

    const result = await pick([commit(), mid(), deep()], { task: 'fix the docs', decide, everyScored: { bar: 0.6 } });

    expect(result.selected.map((item) => item.id).sort()).toEqual(['commit a1b2c3d', 'mid']);
    expect(result.record.candidates.find((entry) => entry.id === 'deep'))
      .toMatchObject({ status: 'rejected', probability: 0.45 });
  });

  it('never links a rule candidate', async () => {
    const rule = () => candidate({
      sourceId: 'rules', id: 'rule', role: 'rule', repository: 'repo-1', path: 'docs/ops.md',
    });
    const { decide } = stubDecide((batch) =>
      byId({ 'commit a1b2c3d': answered(0.9), rule: answered(0.45) })(batch));

    const result = await pick([commit(), rule()], { task: 'fix the ops doc', decide, everyScored: { bar: 0.6 }, thresholds: { rule: 0.6 } });

    expect(result.record.candidates.find((entry) => entry.id === 'rule'))
      .toMatchObject({ status: 'rejected', probability: 0.45 });
  });

  it('never links a candidate that did not answer over the bar', async () => {
    for (const answer of [
      { status: 'refused' as const },
      { status: 'error' as const, detail: 'decide broke' },
    ]) {
      const { decide } = stubDecide((batch) =>
        byId({ 'commit a1b2c3d': answered(0.9), ops: answer })(batch));

      const result = await pick([commit(), opsNote()], { task: 'fix the ops doc', decide, everyScored: { bar: 0.6 } });

      const entry = result.record.candidates.find((item) => item.id === 'ops');
      expect(entry!.status).toBe('unanswered');
      expect(entry!).not.toHaveProperty('link');
    }
    // A missing answer and an unassessed candidate behave the same way.
    const { decide: missing } = stubDecide((batch) =>
      Object.fromEntries(batch.questions
        .filter((question) => question.id !== 'ops')
        .map((question) => [question.key, answered(0.9)])));
    const missingResult = await pick([commit(), opsNote()], { task: 'x', decide: missing });
    expect(missingResult.record.candidates.find((entry) => entry.id === 'ops')!.status)
      .toBe('unanswered');

    const { decide: one } = stubDecide((batch) => allAnswered(batch, 0.9));
    const shortResult = await pick([commit(), opsNote()], {
      task: 'fix the ops doc',
      decide: one,
      limits: { maxCandidates: 1 },
    });
    const entry = shortResult.record.candidates.find((item) => item.id === 'ops');
    expect(entry).toMatchObject({ status: 'unassessed', reason: 'limits' });
    expect(entry).not.toHaveProperty('link');
  });

  it('leaves an ordinary above-threshold selection without a link field', async () => {
    const { decide } = stubDecide((batch) => allAnswered(batch, 0.9));

    const result = await pick([commit(), opsNote()], { task: 'fix the ops doc', decide, everyScored: { bar: 0.6 } });

    const entry = result.record.candidates.find((item) => item.id === 'ops');
    expect(entry).toMatchObject({ status: 'selected' });
    expect(entry).not.toHaveProperty('link');
  });
});
