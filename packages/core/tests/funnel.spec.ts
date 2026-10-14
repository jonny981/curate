import { describe, expect, it } from 'vitest';

import {
  cutScoreCurve,
  pick,
  pickFromSources,
  type CandidateSource,
  type MemoryCandidate,
  type PickDecide,
  type PickTagSet,
} from '../src/index.js';

const candidate = (id: string, score = 1, overrides: Partial<MemoryCandidate> = {}): MemoryCandidate => ({
  id, sourceId: 'notes', role: 'reference', title: id, text: `Text ${id}`,
  signals: { score }, ...overrides,
});
const yes: PickDecide = async ({ questions }) => Object.fromEntries(
  questions.map((q) => [q.key, { status: 'answered' as const, probability: 0.9 }]),
);
const reader = (candidates: MemoryCandidate[], extra: Partial<CandidateSource> = {}): CandidateSource => ({
  id: 'reader', role: 'reference',
  read: async () => ({ status: 'read', complete: true, candidates }),
  ...extra,
});

describe('cutScoreCurve', () => {
  it('keeps at most two positive scores whole and ignores the rest', () => {
    expect(cutScoreCurve([9])).toBe(1);
    expect(cutScoreCurve([9, 0.001])).toBe(2);
    expect(cutScoreCurve([0, -2, 4])).toBe(1);
    expect(cutScoreCurve([0, -1])).toBe(0);
    expect(cutScoreCurve([])).toBe(0);
  });

  it('cuts a lane where its own curve flattens into a tail', () => {
    expect(cutScoreCurve([10, 9, 8, 1, 1, 1])).toBe(3);
    expect(cutScoreCurve([10, 1, 1])).toBe(1);
  });

  it('keeps equal scores together and keeps a curve with no knee whole', () => {
    expect(cutScoreCurve([3, 3, 3, 3])).toBe(4);
    expect(cutScoreCurve([5, 4, 3, 2, 1])).toBe(5);
    expect(cutScoreCurve([10, 9, 8, 7, 1])).toBe(5);
  });
});

describe('lane cuts', () => {
  it('cuts each keyword lane at its own curve and reports read and kept counts', async () => {
    const scored = [10, 9, 8, 1, 1, 1].map((score, index) => candidate(`s${index}`, score));
    const result = await pickFromSources([reader(scored)], { task: 'task' }, { task: 'task', decide: yes });
    expect(result.reads[0]).toMatchObject({
      lanes: [{ task: 'task', lane: 'search', read: 6, kept: 3 }],
    });
    expect(result.selected.map((item) => item.id)).toEqual(['s0', 's1', 's2']);
  });

  it('keeps every part when laneCut is false', async () => {
    const scored = [10, 9, 8, 1, 1, 1].map((score, index) => candidate(`s${index}`, score));
    const result = await pickFromSources([reader(scored)], { task: 'task', laneCut: false }, { task: 'task', decide: yes });
    expect(result.selected).toHaveLength(6);
    expect(result.reads[0]).toMatchObject({ lanes: [{ task: 'task', lane: 'search', read: 6, kept: 6 }] });
  });

  it('applies the cut inside each lane of a multi-search union', async () => {
    const calls: string[] = [];
    const source: CandidateSource = {
      id: 'reader', role: 'reference',
      read: async (request) => {
        calls.push(request.task);
        return {
          status: 'read', complete: true,
          candidates: request.task === 'first'
            ? [10, 9, 8, 1, 1].map((score, index) => candidate(`f${index}`, score))
            : [7, 6, 5].map((score, index) => candidate(`e${index}`, score)),
        };
      },
    };
    const result = await pickFromSources([source], { task: 'first', searchLines: ['extra'] }, { task: 'first', decide: yes });
    expect(calls).toEqual(['first', 'extra']);
    const read = result.reads[0]!;
    if (read.status !== 'read') throw new Error('read failed');
    expect(read.lanes).toEqual([
      { task: 'first', lane: 'search', read: 5, kept: 3 },
      { task: 'extra', lane: 'search', read: 3, kept: 3 },
    ]);
    expect(read.candidates.map((item) => item.id).sort()).toEqual(['e0', 'e1', 'e2', 'f0', 'f1', 'f2']);
    expect(read.candidates.find((item) => item.id === 'f0')?.searchRanks).toEqual([0, null]);
    expect(read.candidates.find((item) => item.id === 'e0')?.searchRanks).toEqual([null, 0]);
  });

  it('never imposes a ceiling: a wide union of equal scores is kept whole', async () => {
    const wide = Array.from({ length: 3000 }, (_, index) => candidate(`w${index}`, 5));
    const result = await pickFromSources([reader(wide)], { task: 'task' }, { task: 'task', decide: yes });
    expect(result.selected).toHaveLength(3000);
    expect(result.reads[0]).toMatchObject({ lanes: [{ task: 'task', lane: 'search', read: 3000, kept: 3000 }] });
  });

  it('keeps nothing and records no search match when no candidate scored', async () => {
    const flat = [candidate('a', 0), candidate('b', 0), candidate('c', -1)];
    const result = await pickFromSources([reader(flat)], { task: 'task' }, { task: 'task', decide: yes });
    expect(result.selected).toEqual([]);
    const read = result.reads[0]!;
    if (read.status !== 'read') throw new Error('read failed');
    expect(read.candidates).toEqual([]);
    expect(read.noSearchMatch).toBe(true);
    expect(read.lanes).toEqual([{ task: 'task', lane: 'search', read: 3, kept: 0 }]);
  });

  it('cuts on laneScore when a candidate carries one, not the merged signal', async () => {
    const items = [10, 9, 8, 1, 1, 1].map((laneScore, index) =>
      candidate(`m${index}`, 1, { laneScore }));
    const result = await pickFromSources([reader(items)], { task: 'task' }, { task: 'task', decide: yes });
    expect(result.selected.map((item) => item.id)).toEqual(['m0', 'm1', 'm2']);
    expect(result.reads[0]).toMatchObject({ lanes: [{ task: 'task', lane: 'search', read: 6, kept: 3 }] });
  });

  it('drops candidates no lane scored and never cuts a rule source', async () => {
    const dropped = await pickFromSources([reader([candidate('hit', 4), candidate('miss', 0)])],
      { task: 'task' }, { task: 'task', decide: yes });
    expect(dropped.selected.map((item) => item.id)).toEqual(['hit']);
    const ruleSource: CandidateSource = {
      id: 'rules', role: 'rule',
      read: async () => ({
        status: 'read', complete: true,
        candidates: [{ ...candidate('rule', 0), role: 'rule' as const }],
      }),
    };
    const kept = await pickFromSources([ruleSource], { task: 'task' }, { task: 'task', decide: yes });
    expect(kept.selected).toHaveLength(1);
  });

  it('admits nothing from a zero-score search lane when a sibling lane scored', async () => {
    const source: CandidateSource = {
      id: 'reader', role: 'reference',
      read: async (request) => ({
        status: 'read', complete: true,
        candidates: request.task === 'flat'
          ? [candidate('flat-a', 0), candidate('flat-b', 0)]
          : [10, 9, 8, 1, 1, 1].map((score, index) => candidate(`e${index}`, score)),
      }),
    };
    const result = await pickFromSources([source], { task: 'flat', searchLines: ['extra'] }, { task: 'flat', decide: yes });
    const read = result.reads[0]!;
    if (read.status !== 'read') throw new Error('read failed');
    expect(read.lanes).toEqual([
      { task: 'flat', lane: 'search', read: 2, kept: 0 },
      { task: 'extra', lane: 'search', read: 6, kept: 3 },
    ]);
    // The union is only the scoring lane's cut, and the read scored.
    expect(read.candidates.map((item) => item.id).sort()).toEqual(['e0', 'e1', 'e2']);
    expect(read.noSearchMatch).toBeUndefined();
  });

  it('keeps nothing and records no search match when every search lane of the read scored zero', async () => {
    const flat = reader([candidate('a', 0), candidate('b', 0)]);
    const result = await pickFromSources([flat], { task: 'flat', searchLines: ['also flat'] }, { task: 'flat', decide: yes });
    expect(result.selected).toEqual([]);
    const read = result.reads[0]!;
    if (read.status !== 'read') throw new Error('read failed');
    expect(read.candidates).toEqual([]);
    expect(read.noSearchMatch).toBe(true);
    expect(read.lanes?.map((lane) => lane.kept)).toEqual([0, 0]);
  });

  it('reports no miss when a phrase lane matched what keyword lanes missed', async () => {
    const source: CandidateSource = {
      id: 'reader', role: 'reference',
      read: async () => ({
        status: 'read', complete: true,
        candidates: [candidate('hit', 0, { text: 'got my invoice today' }), candidate('other', 0)],
      }),
    };
    const result = await pickFromSources([source], { task: 'task', searchPhrases: ['got my'] }, { task: 'task', decide: yes });
    const read = result.reads[0]!;
    if (read.status !== 'read') throw new Error('read failed');
    // The keyword lane scored zero but the phrase lane matched: the
    // read kept a candidate, so it is no miss.
    expect(read.lanes).toEqual([
      { task: 'task', lane: 'search', read: 2, kept: 0 },
      { task: 'got my', lane: 'phrase', read: 2, kept: 1 },
    ]);
    expect(read.candidates.map((item) => item.id)).toEqual(['hit']);
    expect(read.noSearchMatch).toBeUndefined();
  });
});

describe('kind lanes', () => {
  const chatItem = (id: string, text: string, role: 'user' | 'assistant' = 'user'): MemoryCandidate => ({
    ...candidate(id, 1),
    sourceId: 'transcript', text,
    chat: { provider: 'codex', sessionId: 'one', role },
  });

  it('searches each source kind in its own phrases and unions the matches', async () => {
    const calls: string[] = [];
    const chatSource: CandidateSource = {
      id: 'chat-reader', kind: 'chat', role: 'reference',
      read: async (request) => {
        calls.push(request.task);
        return {
          status: 'read', complete: true,
          candidates: [
            chatItem('direction', 'we need to ship the funnel this week'),
            chatItem('aside', 'the weather was fine'),
          ],
        };
      },
    };
    const noteSource: CandidateSource = {
      id: 'notes-reader', kind: 'markdown', role: 'reference',
      read: async () => ({
        status: 'read', complete: true,
        candidates: [
          candidate('decision', 1, { sourceId: 'notes', text: 'decision: cut the funnel at the curve' }),
          candidate('other', 1, { sourceId: 'notes', text: 'shopping list' }),
        ],
      }),
    };
    const result = await pickFromSources([chatSource, noteSource], {
      task: 'directions', kindLanes: { chat: ['we need to'], markdown: ['decision:'] },
    }, { task: 'directions', decide: yes });
    expect(calls).toEqual(['directions', 'we need to']);
    const lanes = result.reads.flatMap((read) => read.status === 'read' ? read.lanes ?? [] : []);
    expect(lanes).toEqual([
      { task: 'directions', lane: 'search', read: 2, kept: 2 },
      { task: 'we need to', lane: 'kind', read: 2, kept: 1 },
      { task: 'directions', lane: 'search', read: 2, kept: 2 },
      { task: 'decision:', lane: 'kind', read: 2, kept: 1 },
    ]);
    expect(result.selected.map((item) => item.id).sort()).toEqual(['aside', 'decision', 'direction', 'other']);
    expect(result.selected.find((item) => item.id === 'direction')?.searchRanks).toEqual([1, 0]);
  });

  it('never cuts a kind lane on phrase counts: a direction said once survives a phrase everyone says', async () => {
    const chatSource: CandidateSource = {
      id: 'chat-reader', kind: 'chat', role: 'reference',
      read: async (request) => ({
        status: 'read', complete: true,
        candidates: request.task === 'never'
          ? [
              chatItem('dense', 'never ever never do that, never'),
              chatItem('one-off', 'never push without asking'),
              chatItem('mention-a', 'i never thought so'),
              chatItem('mention-b', 'he never replied'),
              chatItem('mention-c', 'they never called'),
            ]
          : [chatItem('other', 'plain talk')],
      }),
    };
    const result = await pickFromSources([chatSource], {
      task: 'task', kindLanes: { chat: ['never'] },
    }, { task: 'task', decide: yes });
    const read = result.reads[0]!;
    if (read.status !== 'read') throw new Error('read failed');
    // A reader that cannot score the task returns every phrase match
    // and the pick keeps them all: the occurrence count is no relevance
    // measure, so a one-off direction is never dropped for it.
    expect(read.lanes).toEqual([
      { task: 'task', lane: 'search', read: 1, kept: 1 },
      { task: 'never', lane: 'kind', read: 5, kept: 5 },
    ]);
    expect(result.selected.map((item) => item.id).sort())
      .toEqual(['dense', 'mention-a', 'mention-b', 'mention-c', 'one-off', 'other']);
  });

  it('trusts the kept set of a kind lane the reader scored by the task topic', async () => {
    // A streaming reader gets the phrase in `task` and the topic in
    // `topic`, scores its matches by the topic, cuts at that curve and
    // flags laneCutApplied; the pick keeps what it returned rather than
    // cutting a second time.
    const requests: { task: string; phrase?: boolean; topic?: string; cut?: boolean }[] = [];
    const chatSource: CandidateSource = {
      id: 'chat-reader', kind: 'chat', role: 'reference',
      read: async (request) => {
        requests.push({ task: request.task, phrase: request.phraseLane, topic: request.topic, cut: request.laneCut });
        return request.phraseLane === true
          ? {
              status: 'read' as const, complete: true, laneCutApplied: true as const, matched: 9,
              candidates: [
                { ...chatItem('relevant-once', 'never ship on friday'), laneScore: 5 },
                { ...chatItem('also-relevant', 'never skip the review'), laneScore: 3 },
              ],
            }
          : { status: 'read' as const, complete: true, candidates: [chatItem('other', 'plain talk')] };
      },
    };
    const result = await pickFromSources([chatSource], {
      task: 'the shipping task', kindLanes: { chat: ['never'] },
    }, { task: 'the shipping task', decide: yes });
    expect(requests).toEqual([
      { task: 'the shipping task', phrase: undefined, topic: undefined, cut: true },
      { task: 'never', phrase: true, topic: 'the shipping task', cut: true },
    ]);
    const read = result.reads[0]!;
    if (read.status !== 'read') throw new Error('read failed');
    expect(read.lanes).toEqual([
      { task: 'the shipping task', lane: 'search', read: 1, kept: 1 },
      { task: 'never', lane: 'kind', read: 9, kept: 2 },
    ]);
    expect(result.selected.find((item) => item.id === 'relevant-once')?.searchRanks).toEqual([null, 0]);
    expect(result.selected.find((item) => item.id === 'also-relevant')?.searchRanks).toEqual([null, 1]);
  });

  it('keeps every kind match when laneCut is false', async () => {
    const chatSource: CandidateSource = {
      id: 'chat-reader', kind: 'chat', role: 'reference',
      read: async (request) => ({
        status: 'read', complete: true,
        candidates: request.task === 'never'
          ? [
              chatItem('dense', 'never never ship it'),
              chatItem('mention-a', 'i never thought so'),
              chatItem('mention-b', 'he never replied'),
            ]
          : [chatItem('other', 'plain talk')],
      }),
    };
    const result = await pickFromSources([chatSource], {
      task: 'task', kindLanes: { chat: ['never'] }, laneCut: false,
    }, { task: 'task', decide: yes });
    const read = result.reads[0]!;
    if (read.status !== 'read') throw new Error('read failed');
    expect(read.lanes?.find((lane) => lane.lane === 'kind')).toMatchObject({ read: 3, kept: 3 });
    expect(result.selected).toHaveLength(4);
  });

  it('keeps only the named person\'s own messages in a kind lane with speakerOnly', async () => {
    const chatSource: CandidateSource = {
      id: 'chat-reader', kind: 'chat', role: 'reference',
      read: async (request) => ({
        status: 'read', complete: true,
        candidates: request.task === 'we need to'
          ? [chatItem('mine', 'we need to ship', 'user'), chatItem('theirs', 'we need to wait', 'assistant')]
          : [chatItem('mine', 'we need to ship', 'user')],
      }),
    };
    const withSpeaker = await pickFromSources([chatSource], {
      task: 'what they said', kindLanes: { chat: ['we need to'] }, speakerOnly: true,
    }, { task: 'what they said', decide: yes });
    expect(withSpeaker.selected.map((item) => item.id)).toEqual(['mine']);
    const without = await pickFromSources([chatSource], {
      task: 'what they said', kindLanes: { chat: ['we need to'] },
    }, { task: 'what they said', decide: yes });
    expect(without.selected.map((item) => item.id).sort()).toEqual(['mine', 'theirs']);
  });

  it('rejects malformed lane options', async () => {
    const source = reader([candidate('a')]);
    await expect(pickFromSources([source], { task: 't', kindLanes: { chat: 'we need to' } as never }, { task: 't', decide: yes }))
      .rejects.toThrow('kindLanes');
    await expect(pickFromSources([source], { task: 't', kindLanes: { bogus: ['x'] } as never }, { task: 't', decide: yes }))
      .rejects.toThrow('kindLanes');
    await expect(pickFromSources([source], { task: 't', kindLanes: { chat: ['  '] } }, { task: 't', decide: yes }))
      .rejects.toThrow('kindLanes');
    await expect(pickFromSources([source], { task: 't', laneCut: 1 as never }, { task: 't', decide: yes }))
      .rejects.toThrow('laneCut');
    await expect(pickFromSources([source], { task: 't', speakerOnly: 'yes' as never }, { task: 't', decide: yes }))
      .rejects.toThrow('speakerOnly');
  });
});

describe('decision tags', () => {
  const intent: PickTagSet = {
    key: 'intent',
    questions: [
      { key: 'decision', instructions: 'A decision?', true: 'Decided.', false: 'Not decided.' },
      { key: 'fact', instructions: 'A fact?', true: 'States a fact.', false: 'Not a fact.' },
    ],
  };
  const corrects: PickTagSet = {
    key: 'corrects',
    questions: [{ key: 'yes', instructions: 'Corrects earlier?', true: 'It corrects.', false: 'It does not.' }],
  };

  it('asks tag questions only of kept references and records every answer', async () => {
    const asked: [string | undefined, string | undefined][] = [];
    const result = await pick([
      candidate('kept', 3), candidate('dropped', 1), { ...candidate('rule', 0), role: 'rule' },
    ], {
      task: 'task', tags: [intent, corrects],
      decide: async (batch) => {
        asked.push(...batch.questions.map((q) => [q.id, q.tagSet] as [string | undefined, string | undefined]));
        return Object.fromEntries(batch.questions.map((q) => [q.key, {
          status: 'answered' as const,
          probability: q.tagSet === undefined ? (q.id === 'dropped' ? 0.1 : 0.9)
            : q.questionKey === 'intent.decision' ? 0.8
              : q.tagSet === 'corrects' ? 0.7 : 0.2,
        }]));
      },
      thresholds: { reference: 0.5 },
    });
    expect(asked.filter(([, tag]) => tag !== undefined).map(([id]) => id)).toEqual(['kept', 'kept', 'kept']);
    const entry = result.record.candidates.find((item) => item.id === 'kept')!;
    expect(entry.tags?.intent).toMatchObject({
      value: 'decision',
      answers: [{ key: 'decision', status: 'answered', probability: 0.8 }, { key: 'fact', status: 'answered', probability: 0.2 }],
    });
    expect(entry.tags?.corrects?.value).toBe('yes');
    expect(result.record.candidates.find((item) => item.id === 'dropped')).not.toHaveProperty('tags');
    expect(result.record.candidates.find((item) => item.id === 'rule')).not.toHaveProperty('tags');
    expect(result.record.tags).toEqual([intent, corrects]);
  });

  it('values a single-question set to no below 0.5 and keeps missing and error answers', async () => {
    const result = await pick([candidate('kept', 3)], {
      task: 'task', tags: [corrects],
      decide: async (batch) => Object.fromEntries(batch.questions.map((q) => [q.key,
        q.tagSet === 'corrects' ? { status: 'answered' as const, probability: 0.4 }
          : { status: 'answered' as const, probability: 0.9 }])),
    });
    expect(result.record.candidates[0]?.tags?.corrects?.value).toBe('no');
    const partial = await pick([candidate('kept', 3)], {
      task: 'task', tags: [intent],
      decide: async (batch) => Object.fromEntries(batch.questions.map((q) => [q.key,
        q.tagSet === 'intent' && q.questionKey === 'intent.fact'
          ? { status: 'refused' as const, detail: 'out of scope' }
          : { status: 'answered' as const, probability: 0.9 }])),
    });
    expect(partial.record.candidates[0]?.tags?.intent).toMatchObject({
      value: 'decision',
      answers: [{ key: 'decision', status: 'answered' }, { key: 'fact', status: 'refused', detail: 'out of scope' }],
    });
    const none = await pick([candidate('kept', 3)], {
      task: 'task', tags: [intent],
      decide: async (batch) => Object.fromEntries(batch.questions.map((q) => [q.key,
        q.tagSet === 'intent' ? { status: 'missing' as const } : { status: 'answered' as const, probability: 0.9 }])),
    });
    expect(none.record.candidates[0]?.tags?.intent?.value).toBeUndefined();
  });

  it('leaves a multi-question set value unset when no answer reaches 0.5', async () => {
    const result = await pick([candidate('kept', 3)], {
      task: 'task', tags: [intent],
      decide: async (batch) => Object.fromEntries(batch.questions.map((q) => [q.key,
        q.tagSet === 'intent'
          ? { status: 'answered' as const, probability: q.questionKey === 'intent.decision' ? 0.3 : 0.1 }
          : { status: 'answered' as const, probability: 0.9 }])),
    });
    const tag = result.record.candidates[0]?.tags?.intent;
    expect(tag?.value).toBeUndefined();
    expect(tag?.answers).toEqual([
      { key: 'decision', status: 'answered', probability: 0.3 },
      { key: 'fact', status: 'answered', probability: 0.1 },
    ]);
  });

  it('records the highest importance level answered yes at 0.5 or more', async () => {
    const importance: PickTagSet = {
      key: 'importance',
      questions: ['critical', 'important', 'relevant', 'passing'].map((key) => ({
        key, instructions: `Is it ${key}?`, true: `It is ${key}.`, false: 'It is not.',
      })),
    };
    const answer = (levels: Record<string, number>): PickDecide => async (batch) =>
      Object.fromEntries(batch.questions.map((q) => [q.key, {
        status: 'answered' as const,
        probability: q.tagSet === 'importance' ? levels[q.questionKey!.split('.')[1]!]! : 0.9,
      }]));
    const top = await pick([candidate('kept', 3)], {
      task: 'task', tags: [importance],
      decide: answer({ critical: 0.9, important: 0.8, relevant: 0.8, passing: 0.8 }),
    });
    expect(top.record.candidates[0]?.tags?.importance?.value).toBe('critical');
    const mid = await pick([candidate('kept', 3)], {
      task: 'task', tags: [importance],
      decide: answer({ critical: 0.3, important: 0.8, relevant: 0.8, passing: 0.8 }),
    });
    expect(mid.record.candidates[0]?.tags?.importance?.value).toBe('important');
    const none = await pick([candidate('kept', 3)], {
      task: 'task', tags: [importance],
      decide: answer({ critical: 0.3, important: 0.3, relevant: 0.3, passing: 0.3 }),
    });
    expect(none.record.candidates[0]?.tags?.importance?.value).toBeUndefined();
  });

  it('adds per-kind sets without changing selection', async () => {
    const commitKind: PickTagSet = {
      key: 'commit-kind',
      questions: [{ key: 'fix', instructions: 'A fix?', true: 'It fixes.', false: 'It does not.' }],
    };
    const asked: [string, string | undefined][] = [];
    const result = await pick([
      candidate('commit', 3, { sourceId: 'history' }), candidate('note', 3),
    ], {
      task: 'task', tags: [corrects], tagsByKind: { 'git-history': [commitKind] },
      sourceKinds: { history: 'git-history' },
      decide: async (batch) => {
        asked.push(...batch.questions.map((q) => [q.id, q.tagSet] as [string, string | undefined]));
        return Object.fromEntries(batch.questions.map((q) => [q.key, { status: 'answered' as const, probability: 0.9 }]));
      },
    });
    const tags = asked.filter(([, set]) => set !== undefined);
    expect(tags.sort()).toEqual([['commit', 'commit-kind'], ['commit', 'corrects'], ['note', 'corrects']]);
    expect(result.record.candidates.find((item) => item.id === 'commit')?.tags?.['commit-kind']?.value).toBe('yes');
    expect(result.record.candidates.find((item) => item.id === 'commit')?.sourceKind).toBe('git-history');
    expect(result.record.candidates.find((item) => item.id === 'note')?.tags?.['commit-kind']).toBeUndefined();
    expect(result.selected).toHaveLength(2);
    expect(result.record.tagsByKind).toEqual({ 'git-history': [commitKind] });
  });

  it('records tag questions a stop left unasked as unassessed with the reason', async () => {
    const partial = await pick([candidate('kept', 3)], {
      task: 'task', tags: [intent],
      limits: { maxBatches: 2, maxPerBatch: 1 },
      decide: yes,
    });
    // One relevance batch, then one tag batch of two: 'fact' was never asked.
    expect(partial.record.candidates[0]?.tags?.intent).toEqual({
      value: 'decision',
      answers: [
        { key: 'decision', status: 'answered', probability: 0.9 },
        { key: 'fact', status: 'unassessed', detail: 'limits' },
      ],
    });
    const skipped = await pick([candidate('kept', 3)], {
      task: 'task', tags: [intent],
      limits: { maxBatches: 1, maxPerBatch: 1 },
      decide: yes,
    });
    // The relevance batch used the only batch: the whole tag pass is
    // recorded as unassessed, not absent and not 'missing'.
    expect(skipped.record.candidates[0]?.tags?.intent).toEqual({
      answers: [
        { key: 'decision', status: 'unassessed', detail: 'limits' },
        { key: 'fact', status: 'unassessed', detail: 'limits' },
      ],
    });
  });

  it('rejects duplicate tag set keys for one candidate', async () => {
    await expect(pick([candidate('a', 3, { sourceId: 'history' })], {
      task: 'task', tags: [corrects],
      tagsByKind: { 'git-history': [corrects] },
      sourceKinds: { history: 'git-history' },
      decide: yes,
    })).rejects.toThrow('unique');
    await expect(pick([candidate('a')], {
      task: 'task', tags: [{ key: 'intent', questions: [] }],
      decide: yes,
    })).rejects.toThrow('tag set');
  });
});

describe('size-dependent reference bar', () => {
  it('interpolates the bar between points and records the applied value', async () => {
    const scores = [0.9, 0.5, 0.29, 0.2];
    const result = await pick(scores.map((p, index) => candidate(`c${index}`, 4 - index)), {
      task: 'task', thresholds: { referenceBySize: [[2, 0.1], [6, 0.5]] },
      decide: async (batch) => Object.fromEntries(batch.questions.map((q, index) => [
        q.key, { status: 'answered' as const, probability: scores[index]! }])),
    });
    // Four decided references sit halfway between the points: bar 0.3.
    expect(result.record.thresholds.appliedReference).toBeCloseTo(0.3);
    expect(result.record.thresholds.referenceBySize).toEqual([[2, 0.1], [6, 0.5]]);
    expect(result.selected.map((item) => item.id)).toEqual(['c0', 'c1']);
    expect(result.record.candidates.find((item) => item.id === 'c3')).toMatchObject({ status: 'rejected', probability: 0.2 });
  });

  it('holds the flat bars outside the points and counts only decided references', async () => {
    const flat = await pick([candidate('a', 3), candidate('b', 1)], {
      task: 'task', thresholds: { referenceBySize: [[10, 0], [100, 0.9]] },
      decide: async (batch) => Object.fromEntries(batch.questions.map((q) => [q.key, { status: 'answered' as const, probability: 0.4 }])),
    });
    expect(flat.record.thresholds.appliedReference).toBe(0);
    expect(flat.selected).toHaveLength(2);
    const oneMissing = await pick([candidate('a', 3), { ...candidate('b', 1), role: 'rule' as const }], {
      task: 'task', thresholds: { referenceBySize: [[0, 0], [2, 0.5]] },
      decide: async (batch) => Object.fromEntries(batch.questions.map((q) => [q.key,
        q.id === 'b' ? { status: 'missing' as const } : { status: 'answered' as const, probability: 0.4 }])),
    });
    // One decided reference: interpolated bar 0.25.
    expect(oneMissing.record.thresholds.appliedReference).toBeCloseTo(0.25);
    expect(oneMissing.selected.map((item) => item.id)).toEqual(['a']);
  });

  it('validates its points', async () => {
    for (const points of [
      [], [[1, 0], [1, 0.5]], [[-1, 0]], [[1.5, 0]], [[1, -0.1]], [[1, 2]], [[1, Number.NaN]],
    ] as const) {
      await expect(pick([candidate('a')], {
        task: 'task', thresholds: { referenceBySize: points }, decide: yes,
      })).rejects.toThrow('referenceBySize');
    }
  });
});
