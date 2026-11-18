import { describe, expect, it } from 'vitest';

import {
  conversationRead, pickFromSources,
  type CandidateReadRequest, type CandidateSource, type MemoryCandidate, type ModeParts, type PickBatch,
} from '../src/index.js';

// Two sources whose mode reads on its own, each with one part a keyword
// lane holds and two person parts no lane holds, all at one date. The
// pool parts come to the conversation read by key.
const DATE = '2026-10-01T09:00:00.000Z';
const part = (sourceId: string, id: string, author: 'person' | 'agent', line: number): MemoryCandidate => ({
  sourceId, id, role: 'reference', title: id, text: author === 'agent' ? 'the orchard plan' : `note ${id}`,
  author, chat: { provider: 'codex', sessionId: `${sourceId}-session`, role: author === 'person' ? 'user' : 'assistant' },
  place: { container: `${sourceId}:file`, at: [line, 1, 1] }, date: { value: DATE, meaning: 'recorded' }, signals: {},
});
const read = conversationRead();
const source = (id: string, byKey: boolean): CandidateSource => {
  const lane = part(id, `${id}-lane`, 'agent', 1);
  // The source's whole read lists the lane part, then the person parts.
  const all = [lane, part(id, `${id}-first`, 'person', 2), part(id, `${id}-second`, 'person', 3)];
  const place = (candidate: MemoryCandidate) => all.findIndex((one) => one.id === candidate.id);
  const parts: ModeParts = {
    // A part handed by key is made afresh, as no lane read it.
    transcript: () => ({ length: all.length, id: (position) => all[position]!.id,
      part: (position) => ({ ...all[position]!, poolOnly: true }), texts: () => all.map((one) => one.text), ties: false }),
    *person() { for (const one of all) if (one.author === 'person') yield { ...one, poolOnly: true }; },
    units: () => [],
    place: (candidate) => { const at = place(candidate); return at < 0 ? Number.POSITIVE_INFINITY : at; },
    close: () => {},
    eachText: (visit) => { for (const one of all) visit(one.id, one.text); },
    dealt: (laneIds) => {
      const rest = all.filter((one) => !laneIds.has(one.id));
      return (candidate) => rest.findIndex((one) => one.id === candidate.id);
    },
    ordered: () => parts,
  };
  return { id, kind: 'chat', role: 'reference', mode: { name: 'talk', read },
    async read(request: CandidateReadRequest) {
      if (request.poolIds === true && byKey) {
        return { status: 'read', complete: true, candidates: [], poolIds: all.map((one) => one.id), parts };
      }
      if (request.wholeLanes === true && request.limit === undefined) {
        return { status: 'read', complete: true, candidates: all.map((one) => ({ ...one, signals: { keyword: one === lane ? 1 : 0 } })) };
      }
      return { status: 'read', complete: true, candidates: [{ ...lane, signals: { keyword: 1 } }] };
    } };
};
const asked = async (byKey: boolean) => {
  const batches: PickBatch[] = [];
  const result = await pickFromSources([source('a', byKey), source('b', byKey)], { task: 'orchard plan' }, {
    task: 'orchard plan',
    decide: async (batch) => {
      batches.push(batch);
      return Object.fromEntries(batch.questions.map((question) => [question.key, { status: 'answered', probability: 0.01 }]));
    },
  });
  return { order: batches.flatMap((batch) => batch.questions.map((question) => question.id)), record: result.record };
};

describe('a conversation read that reaches parts by key', () => {
  it('reads equal-date person parts in the order the pick deals parts: round by round across sources, lane parts first', async () => {
    const { order } = await asked(true);
    const people = order.filter((id) => id.endsWith('-first') || id.endsWith('-second'));
    // Each source's lane part is dealt first; then its pool parts in its
    // whole read's order, one source after another in each round.
    expect(people).toEqual(['a-first', 'b-first', 'a-second', 'b-second']);
    // The same order the pick gives when every part is handed to it.
    expect((await asked(false)).order.filter((id) => id.endsWith('-first') || id.endsWith('-second'))).toEqual(people);
  });

  it('lists the parts it reached and counts the rest by source', async () => {
    const { record } = await asked(true);
    const pool = record.candidates.filter((entry) => entry.poolOnly === true);
    expect(pool.map((entry) => entry.id)).toEqual(['a-first', 'a-second', 'b-first', 'b-second']);
    expect(pool.every((entry) => Object.keys(entry.signals).length === 0)).toBe(true);
    expect(record.unheld).toEqual({ a: 0, b: 0 });
  });
});
