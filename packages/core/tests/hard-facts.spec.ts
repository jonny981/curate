import { describe, expect, it } from 'vitest';
import {
  conversationRead, jevRequest, pick, rankedRead, type MemoryCandidate, type Mode, type PickBatch, type PickCascade, type PickDecide,
} from '../src/index.js';

const task = 'What did Ana decide about the database?';
const set: PickCascade = { bias: 0, questions: [{ key: 'relevant', instructions: 'Relevant?', true: 'Yes', false: 'No', weight: 1 }] };
const mode = (settings: Partial<Mode> = {}): Mode => ({ name: 'agent-transcripts', questions: set, read: conversationRead(), ...settings });

const container = 'claude-code:/home/ana/.claude/projects:app/s1.jsonl';
/** A transcript piece as the chat reader cuts it. */
const piece = (line: number, at: number, author: 'person' | 'agent' | 'tool', text: string, rank?: number): MemoryCandidate => ({
  sourceId: 'chat', role: 'reference', id: `${container}:${line}:1:${at}`,
  title: `claude-code s1 ${author === 'agent' ? 'assistant' : author === 'tool' ? 'tool-result' : 'user'}`, text, signals: {},
  date: { value: `2026-10-01T09:0${line}:00Z`, meaning: 'recorded' }, author,
  place: { container, at: [line, 1, at] },
  chat: { provider: 'claude-code', sessionId: 's1', role: author === 'agent' ? 'assistant' : author === 'tool' ? 'tool-result' : 'user' },
  ...(rank === undefined ? { poolOnly: true as const } : { searchRanks: [rank] }),
});
// The person asks; an agent proposes in two pieces; a tool answers; the
// agent asks to go ahead; the person agrees; the agent reports.
const session = [
  piece(1, 1, 'person', 'Which database should we use?', 0),
  piece(2, 1, 'agent', 'Two options. ', 1),
  piece(2, 2, 'agent', 'Postgres or SQLite.'),
  piece(3, 1, 'tool', '{"rows": 3}'),
  piece(4, 1, 'agent', 'Shall I go with Postgres?'),
  piece(5, 1, 'person', "Let's do it", 2),
  piece(6, 1, 'agent', 'Done: Postgres it is.'),
];
const at = (line: number, part = 1) => session.find((item) => item.place!.at[0] === line && item.place!.at[2] === part)!;
const recording = () => {
  const batches: PickBatch[] = [];
  const decide: PickDecide = async (batch) => {
    batches.push(batch);
    return Object.fromEntries(batch.questions.map((question) => [question.key, { status: 'answered', probability: 0.9 }]));
  };
  return { batches, decide };
};
const asked = (batches: readonly PickBatch[], id: string) => batches.flatMap((batch) => batch.questions).find((question) => question.id === id);

describe('hard facts in the state', () => {
  it('give each transcript item its kind, session, place, the start of the message it answers and of the person\'s reply', async () => {
    const { batches, decide } = recording();
    await pick(session, { task, decide, modesBySource: { chat: mode({ hardFacts: true }) } });
    // The person's reply answers the nearest earlier message by anyone else.
    expect(asked(batches, at(5).id)!.facts).toEqual({ kind: 'person message', session: 's1', position: 5, pieces: 1,
      replies_to: { id: at(4).id, text: 'Shall I go with Postgres?' } });
    // Another side's message answers the person's message before it, and
    // the person's next message answers it; each carries the other's start,
    // whole messages joined.
    expect(asked(batches, at(2, 2).id)!.facts).toEqual({ kind: 'agent step', session: 's1', position: 2, pieces: 2, piece: 2,
      replies_to: { id: at(1).id, text: 'Which database should we use?' },
      answered_by: { id: at(5).id, text: "Let's do it" } });
    expect(asked(batches, at(1).id)!.facts).toEqual({ kind: 'person message', session: 's1', position: 1, pieces: 1 });
    expect(asked(batches, at(3).id)!.facts).toEqual({ kind: 'tool output', session: 's1', position: 3, pieces: 1,
      replies_to: { id: at(1).id, text: 'Which database should we use?' }, answered_by: { id: at(5).id, text: "Let's do it" } });
    expect(asked(batches, at(6).id)!.facts).toEqual({ kind: 'agent step', session: 's1', position: 6, pieces: 1,
      replies_to: { id: at(5).id, text: "Let's do it" } });
  });

  it('carry the first 1,000 characters of a long message they quote', async () => {
    const long = [piece(1, 1, 'person', `${'a'.repeat(700)}\n`, 0), piece(1, 2, 'person', `${'b'.repeat(700)}\n`),
      piece(2, 1, 'agent', 'Noted.', 1)];
    const { batches, decide } = recording();
    await pick(long, { task, decide, modesBySource: { chat: mode({ hardFacts: true }) } });
    const quoted = asked(batches, long[2]!.id)!.facts!.replies_to as { id: string; text: string };
    expect(quoted).toEqual({ id: long[0]!.id, text: `${'a'.repeat(700)}\n${'b'.repeat(299)}` });
  });

  it('put the person and how many answers are wanted at the top of the state, as sent', async () => {
    const { batches, decide } = recording();
    await pick([at(5)], { task, decide, person: 'Ana', wanted: 'one decision',
      modesBySource: { chat: mode({ hardFacts: true, read: rankedRead }) } });
    // The person's own messages are marked with their name.
    expect(batches).toHaveLength(1);
    expect(jevRequest(batches[0]!)).toEqual({
      model: 'jev-latest',
      state: {
        task,
        person: 'Ana',
        wanted: 'one decision',
        items: {
          1: {
            id: at(5).id,
            date: 'recorded 2026-10-01T09:05:00Z',
            title: 'claude-code s1 user',
            text: "Let's do it",
            author: 'Ana',
            kind: 'Ana message',
            session: 's1',
            pieces: 1,
          },
        },
      },
      questions: {
        q0: {
          type: 'noul',
          instructions: { question: 'Relevant?', item: 'items.1' },
          criteria: { true: 'Yes', false: 'No' },
        },
      },
    });
  });

  it('leave out what needs the whole transcript when the read does not walk it', async () => {
    const { batches, decide } = recording();
    await pick(session, { task, decide, modesBySource: { chat: mode({ hardFacts: true, read: rankedRead }) } });
    expect(asked(batches, at(2).id)!.facts).toEqual({ kind: 'agent step', session: 's1', pieces: 2, piece: 1 });
    expect(asked(batches, at(5).id)!.facts).toEqual({ kind: 'person message', session: 's1', pieces: 1 });
  });

  it('give a whole message its facts without a piece number', async () => {
    const { batches, decide } = recording();
    await pick(session, { task, decide, modesBySource: { chat: mode({ hardFacts: true, wholeMessages: true }) } });
    expect(asked(batches, at(2).id)).toMatchObject({ text: 'Two options. Postgres or SQLite.',
      facts: { kind: 'agent step', session: 's1', position: 2, pieces: 2 } });
    expect(asked(batches, at(2).id)!.facts).not.toHaveProperty('piece');
  });

  it('give a commit and a note their kind only', async () => {
    const plain = (sourceId: string): MemoryCandidate => ({ sourceId, role: 'reference', id: `${sourceId}-1`, title: sourceId,
      text: 'We chose Postgres.', signals: {}, searchRanks: [0] });
    const { batches, decide } = recording();
    await pick([plain('history'), plain('notes')], { task, decide, sourceKinds: { history: 'git-history', notes: 'markdown' },
      modesBySource: { history: mode({ hardFacts: true, read: rankedRead }), notes: mode({ hardFacts: true, read: rankedRead }) } });
    expect(asked(batches, 'history-1')!.facts).toEqual({ kind: 'commit' });
    expect(asked(batches, 'notes-1')!.facts).toEqual({ kind: 'note' });
  });

  it('send the person and wanted only on requests of a mode that writes hard facts', async () => {
    const other = { ...at(1), sourceId: 'other', id: 'other-1', text: 'Another session.' };
    const { batches, decide } = recording();
    await pick([at(1), other], { task, decide, person: 'Ana', wanted: 'everything said',
      modesBySource: { chat: mode({ hardFacts: true, read: rankedRead }), other: mode({ read: rankedRead }) } });
    expect(batches).toHaveLength(2);
    for (const batch of batches) {
      const facts = batch.questions[0]!.sourceId === 'chat';
      expect(batch.person).toBe(facts ? 'Ana' : undefined);
      expect(batch.wanted).toBe(facts ? 'everything said' : undefined);
      expect(batch.questions[0]!.facts === undefined).toBe(!facts);
    }
  });

  it('store an answer asked with the person apart from one asked without', async () => {
    const stored = new Map<string, unknown>();
    const cache = { deciderId: 'stub', store: { get: async (key: string) => stored.get(key), set: async (key: string, value: unknown) => { stored.set(key, value); } } };
    const options = { task, cache, modesBySource: { chat: mode({ hardFacts: true, read: rankedRead }) } };
    const first = recording();
    await pick([at(5)], { ...options, decide: first.decide });
    const named = recording();
    await pick([at(5)], { ...options, decide: named.decide, person: 'Ana' });
    const again = recording();
    await pick([at(5)], { ...options, decide: again.decide, person: 'Ana' });
    expect([first.batches.length, named.batches.length, again.batches.length]).toEqual([1, 1, 0]);
  });

  it('leave every request as it was when off, with or without a person and wanted', async () => {
    const plain = recording();
    const before = await pick(session, { task, decide: plain.decide, modesBySource: { chat: mode() } });
    const off = recording();
    const after = await pick(session, { task, decide: off.decide, person: 'Ana', wanted: 'one decision',
      modesBySource: { chat: mode({ hardFacts: false }) } });
    expect(off.batches).toEqual(plain.batches);
    expect(after.record.candidates).toEqual(before.record.candidates);
    expect(after.record.levers.sources.chat).not.toHaveProperty('hardFacts');
  });

  it('check the person, wanted and the setting', async () => {
    const decide = recording().decide;
    await expect(pick(session, { task, decide, person: ' ' })).rejects.toThrow('person must be a nonempty string');
    await expect(pick(session, { task, decide, wanted: 'some' as 'one decision' }))
      .rejects.toThrow("wanted must be 'one decision' or 'everything said'.");
    await expect(pick(session, { task, decide, modesBySource: { chat: mode({ hardFacts: 1 as unknown as boolean }) } }))
      .rejects.toThrow('modesBySource.chat.hardFacts must be a boolean.');
  });
});

describe('whole messages, hard facts and one item a request, in the conversation read', () => {
  it('rate a short reply around a warm message alone and whole, with what it answers and the reply to it', async () => {
    // The person asks; an agent answers in two short pieces; the person agrees.
    const exchange = [
      piece(1, 1, 'person', 'Should we use Postgres or SQLite?', 0),
      piece(2, 1, 'agent', 'Postgres. '),
      piece(2, 2, 'agent', 'For transactions.'),
      piece(3, 1, 'person', 'Good, ship it.', 1),
      piece(4, 1, 'agent', 'Unrelated build log.'),
    ];
    const requests: PickBatch[] = [];
    const decide: PickDecide = async (batch) => {
      requests.push(batch);
      // The question is warm, so the read rings out from it to its reply.
      return Object.fromEntries(batch.questions.map((question) => [question.key, { status: 'answered',
        probability: /Postgres/.test(question.text) ? 0.9 : 0.05 }]));
    };
    const result = await pick(exchange, { task, decide, person: 'Ana', wanted: 'one decision',
      modesBySource: { chat: mode({ wholeMessages: true, hardFacts: true, itemsPerRequest: 1 }) } });
    // Every request the read sent held one item, judged on its own.
    for (const request of requests) {
      expect(new Set(request.questions.map((question) => question.id)).size).toBe(1);
      expect(request.alone).toBe(true);
      expect(jevRequest(request).state).toHaveProperty('item');
    }
    // The reply was asked once, whole, with both neighbours' starts.
    const reply = requests.flatMap((request) => request.questions).filter((question) => question.id === exchange[1]!.id);
    expect(reply).toHaveLength(1);
    expect(reply[0]).toMatchObject({ text: 'Postgres. For transactions.', facts: { kind: 'agent step', pieces: 2,
      replies_to: { id: exchange[0]!.id, text: 'Should we use Postgres or SQLite?' },
      answered_by: { id: exchange[3]!.id, text: 'Good, ship it.' } } });
    // The person's messages carry their name and the message they answer.
    const agreed = requests.flatMap((request) => request.questions).find((question) => question.id === exchange[3]!.id)!;
    expect(agreed.facts).toMatchObject({ author: 'Ana', kind: 'Ana message', replies_to: { id: exchange[1]!.id, text: 'Postgres. For transactions.' } });
    expect(requests.find((request) => request.questions[0]!.id === exchange[3]!.id)).toMatchObject({ person: 'Ana', wanted: 'one decision' });
    // Its rating is each piece's, and it is laid out whole.
    for (const part of exchange.slice(1, 3)) {
      const entry = result.record.candidates.find((candidate) => candidate.id === part.id)!;
      expect(entry.status).toBe('selected');
    }
  });
});
