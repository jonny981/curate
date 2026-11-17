import { describe, expect, it } from 'vitest';
import { conversationRead, pick, type MemoryCandidate, type PickCascade, type PickDecide } from '../src/index.js';
import { agentUnits, chatRead, topicShifts, unitDescriptors } from '../src/chat-read.js';
import { modesOf } from './fixtures/modes.js';

type Author = 'person' | 'agent';

/** The chat reader's part id: the transcript file, then line, block and piece. */
const idOf = (session: string, line: number) => `claude-code:/home/me/.claude/projects:app/${session}.jsonl:${line}:1:1`;

/** A generated transcript part. Ranks put it in the search lanes; without
 *  them it is a pool member no lane holds. */
const part = (session: string, line: number, author: Author,
  options: { ranks?: (number | null)[]; text?: string; sourceId?: string } = {}): MemoryCandidate => ({
  sourceId: options.sourceId ?? 'chat', role: 'reference', id: idOf(session, line),
  title: `claude-code ${session} ${author === 'person' ? 'user' : 'assistant'}`,
  text: options.text ?? `${session} part ${line}`,
  date: { value: new Date(Date.UTC(2026, 9, 1, 0, line)).toISOString(), meaning: 'recorded' },
  author, place: { container: `claude-code:/home/me/.claude/projects:app/${session}.jsonl`, at: [line, 1, 1] },
  chat: { provider: 'claude-code', sessionId: session, role: author === 'person' ? 'user' : 'assistant' },
  signals: {},
  ...(options.ranks === undefined ? { poolOnly: true as const } : { searchRanks: options.ranks }),
});

/** Answers each question with its part's rating (0.001 when unlisted; no
 *  answer for an id in `unanswered`) and keeps the ids of every request,
 *  in order. */
const rater = (ratings: Readonly<Record<string, number>>, unanswered: ReadonlySet<string> = new Set()) => {
  const asked: string[][] = [];
  const decide: PickDecide = async ({ questions }) => {
    asked.push(questions.map((question) => question.id));
    return Object.fromEntries(questions.filter((question) => !unanswered.has(question.id)).map((question) =>
      [question.key, { status: 'answered', probability: ratings[question.id] ?? 0.001 }]));
  };
  return { asked, decide };
};

const task = 'Which database did we choose?';
const chatKind = { chat: 'chat' } as const;
const question = (key: string) => ({ key, instructions: `${key}?`, true: 'Yes', false: 'No', weight: 1 });
/** A question set whose one question's answer is the part's rating, so
 *  the read sees each rating as the rater gives it. */
const agentSet: PickCascade = { bias: 0, questions: [question('relevant')] };
/** Agent transcripts: the set in a mode read with the conversation read. */
const agentRead = { sourceKinds: chatKind, modesBySource: modesOf({ chat: agentSet }, conversationRead()) };

/** One person part per two-part session, ranked in lane 0 in order, each
 *  followed by a cold reply no lane holds. */
const personSessions = (count: number) => Array.from({ length: count }, (_, index) => [
  part(`s${index}`, 1, 'person', { ranks: [index] }),
  part(`s${index}`, 2, 'agent'),
]).flat();

describe('the chat read', () => {
  it('reads the person\'s own parts first, then rings out from each warm one', async () => {
    const a = (line: number) => idOf('a', line);
    const parts = Array.from({ length: 12 }, (_, index) => {
      const line = index + 1;
      return line === 1 ? part('a', 1, 'person', { ranks: [0] })
        : line === 6 ? part('a', 6, 'person', { ranks: [1] })
          : part('a', line, 'agent');
    });
    const { asked, decide } = rater({ [a(6)]: 0.9, [a(7)]: 0.8, [a(5)]: 0.5, [a(1)]: 0.02 });
    await pick(parts, { task, decide, ...agentRead });
    // The person's parts, the warm one's reply, then one more part on each
    // side while the last ring held a warm part.
    expect(asked.slice(0, 4)).toEqual([[a(1), a(6)], [a(7)], [a(5), a(8)], [a(4), a(9)]]);
  });

  it('opens a segment holding a lane\'s top part, where no person part is, and finds its answer', async () => {
    const talk = [part('talk', 1, 'person', { ranks: [0, null] }), part('talk', 2, 'agent'),
      part('talk', 3, 'person', { ranks: [1, null] }), part('talk', 4, 'agent')];
    const agents = (top: boolean) => Array.from({ length: 10 }, (_, index) =>
      part('agents', index + 1, 'agent', index === 4 && top ? { ranks: [null, 0] } : {}));
    const ratings = { [idOf('talk', 1)]: 0.9, [idOf('talk', 2)]: 0.5, [idOf('agents', 5)]: 0.3, [idOf('agents', 6)]: 0.8 };
    const answer = idOf('agents', 6);

    const opened = await pick([...talk, ...agents(true)], { task, decide: rater(ratings).decide, ...agentRead });
    const found = opened.record.candidates.find((entry) => entry.id === answer);
    expect(found?.status).toBe('selected');
    expect(found && 'probability' in found ? found.probability : 0).toBeCloseTo(0.8, 12);
    expect(opened.record.pick?.chatRead?.segments).toBe(2);

    // Without the lane's top part in that session nothing leads there.
    const unopened = await pick([...talk, part('talk', 5, 'agent', { ranks: [null, 0] }), ...agents(false)],
      { task, decide: rater(ratings).decide, ...agentRead });
    expect(unopened.record.candidates.find((entry) => entry.id === answer)?.status).toBe('unassessed');
  });

  it('stops when a request adds at most 0.3 times the most an earlier request added', async () => {
    const parts = personSessions(336);
    const warm = (from: number, count: number) => Object.fromEntries(Array.from({ length: count },
      (_, index) => [idOf(`s${from + index}`, 1), 0.9]));
    // Request 1 adds 10 warm parts, request 2 adds 3: 3 is 0.3 times 10.
    const { asked, decide } = rater({ ...warm(0, 10), ...warm(112, 3), ...warm(224, 50) });
    const result = await pick(parts, { task, decide, ...agentRead });
    expect(result.record.pick?.chatRead).toMatchObject({ requests: 2, ended: 'fall', unread: 112 });
    const third = new Set(Array.from({ length: 112 }, (_, index) => idOf(`s${224 + index}`, 1)));
    expect(asked.flat().some((id) => third.has(id))).toBe(false);
    for (const entry of result.record.candidates.filter((item) => third.has(item.id))) {
      expect(entry).toMatchObject({ status: 'unassessed', reason: 'chatRead' });
    }
  });

  it('does not stop before the first warm part', async () => {
    const parts = personSessions(336);
    const rate = (from: number, count: number, value: number) => Object.fromEntries(Array.from({ length: count },
      (_, index) => [idOf(`s${from + index}`, 1), value]));
    // Request 1 gets no rating at all, request 2 adds 10 warm parts and request 3 adds 2.
    const first = new Set(Array.from({ length: 112 }, (_, index) => idOf(`s${index}`, 1)));
    const { decide } = rater({ ...rate(112, 10, 0.9), ...rate(224, 2, 0.9) }, first);
    const result = await pick(parts, { task, decide, ...agentRead });
    expect(result.record.pick?.chatRead).toMatchObject({ requests: 3, ended: 'fall' });
  });

  it('keeps the ranked read for any set unless the mode says otherwise', async () => {
    // One person part per session, each ranked in the one lane; part 300
    // is an answer the ranked read reaches.
    const parts = Array.from({ length: 336 }, (_, index) => part(`s${index}`, 1, 'person', { ranks: [index] }));
    const ratings = Object.fromEntries(parts.map((item, index) => [item.id, index < 10 || index === 300 ? 0.9 : 0.001]));
    for (const set of [agentSet, { bias: 0, questions: [question('personal_fact')] }]) {
      const ranked = await pick(parts, { task, decide: rater(ratings).decide, sourceKinds: chatKind,
        modesBySource: modesOf({ chat: set }) });
      expect(ranked.record.pick?.chatRead).toBeUndefined();
      expect(ranked.selected.map((item) => item.id)).toContain(parts[300]!.id);
      const own = await pick(parts, { task, decide: rater(ratings).decide, sourceKinds: chatKind,
        modesBySource: modesOf({ chat: set }, conversationRead()) });
      expect(own.record.pick?.chatRead).toBeDefined();
    }
  });

  it('reaches every part the current read reaches when its stop does not fire', async () => {
    // One person part, then ranked agent parts in sessions of their own:
    // those past the lane's top ten are reached only through the order.
    const parts = [part('a', 1, 'person', { ranks: [0] }), part('a', 2, 'agent'),
      ...Array.from({ length: 15 }, (_, index) => part(`x${index}`, 1, 'agent', { ranks: [index + 1] }))];
    // The rest of the order adds more warm parts than the person's request did.
    const ratings = { [idOf('a', 1)]: 0.9, [idOf('x12', 1)]: 0.5, [idOf('x13', 1)]: 0.4, [idOf('x14', 1)]: 0.6 };
    const current = rater(ratings);
    const before = await pick(parts, { task, decide: current.decide, modesBySource: modesOf({ chat: agentSet }) });
    const chat = rater(ratings);
    const after = await pick(parts, { task, decide: chat.decide, ...agentRead });
    // The mode chooses the read, not the set: the set in a mode with the
    // ranked read keeps the current read, and another set in a mode with
    // the conversation read gets the chat read.
    expect(before.record.pick?.chatRead).toBeUndefined();
    expect(after.record.pick?.chatRead).toMatchObject({ ended: 'order', unread: 0 });
    const plainSet: PickCascade = { bias: 0, questions: [question('personal_fact')] };
    const conversation = await pick(parts, { task, decide: rater(ratings).decide,
      modesBySource: modesOf({ chat: plainSet }, conversationRead()) });
    expect(conversation.record.pick?.chatRead).toMatchObject({ ended: 'order', unread: 0 });
    expect(conversation.record.levers.sources.chat?.mode).toBe('chat');
    const reached = new Set(chat.asked.flat());
    expect(current.asked.flat().filter((id) => !reached.has(id))).toEqual([]);
    const kept = (result: typeof before) => result.selected.map((item) => item.id).sort();
    expect(kept(before).filter((id) => !kept(after).includes(id))).toEqual([]);
  });

  it('leaves a second source kind in the same call to its own read', async () => {
    const note = (index: number): MemoryCandidate => ({
      sourceId: 'notes', role: 'reference', id: `notes/decisions.md#${index}`, title: `Decision ${index}`,
      text: `Note ${index}`, signals: {}, searchRanks: [index],
    });
    const notes = Array.from({ length: 6 }, (_, index) => note(index));
    const ratings = { ...Object.fromEntries(notes.map((item, index) => [item.id, index % 2 ? 0.7 : 0.01])),
      [idOf('s0', 1)]: 0.9, [idOf('s112', 1)]: 0.9 };
    const both = rater(ratings);
    const together = await pick([...personSessions(336), ...notes],
      { task, decide: both.decide, ...agentRead, sourceKinds: { chat: 'chat', notes: 'markdown' } });
    const alone = rater(ratings);
    const apart = await pick(notes, { task, decide: alone.decide, sourceKinds: { notes: 'markdown' } });
    expect(together.record.pick?.chatRead?.ended).toBe('fall');
    const isNote = (id: string) => id.startsWith('notes/');
    expect(both.asked.map((ids) => ids.filter(isNote)).filter((ids) => ids.length > 0)).toEqual(alone.asked);
    const entries = (result: typeof apart) => result.record.candidates.filter((entry) => isNote(entry.id))
      .map(({ id, status, ...rest }) => ({ id, status, probability: 'probability' in rest ? rest.probability : undefined }));
    expect(entries(together)).toEqual(entries(apart));
  });

  it('leaves a chat source with another question set to its own read', async () => {
    // A personal chat history in the same call: kind 'chat', in a mode
    // with the ranked read.
    const personalSet: PickCascade = { bias: 0, questions: [question('personal_fact')] };
    const diary = Array.from({ length: 20 }, (_, index) => part('d', index + 1, index % 2 ? 'agent' : 'person',
      { sourceId: 'diary', ...(index < 12 ? { ranks: [index] } : {}) }));
    const ratings = { ...Object.fromEntries(diary.map((item, index) => [item.id, index % 3 ? 0.6 : 0.002])),
      ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [idOf(`s${index}`, 1), 0.9])),
      ...Object.fromEntries(Array.from({ length: 3 }, (_, index) => [idOf(`s${112 + index}`, 1), 0.9])) };
    const isDiary = (id: string) => diary.some((item) => item.id === id);
    const both = rater(ratings);
    const together = await pick([...personSessions(336), ...diary], { task, decide: both.decide,
      sourceKinds: { chat: 'chat', diary: 'chat' },
      modesBySource: { ...modesOf({ chat: agentSet }, conversationRead()), ...modesOf({ diary: personalSet }) } });
    const alone = rater(ratings);
    const apart = await pick(diary, { task, decide: alone.decide,
      sourceKinds: { diary: 'chat' }, modesBySource: modesOf({ diary: personalSet }) });
    expect(together.record.pick?.chatRead?.ended).toBe('fall');
    expect(apart.record.pick?.chatRead).toBeUndefined();
    const diaryAsked = (asked: string[][]) => asked.map((ids) => ids.filter(isDiary)).filter((ids) => ids.length > 0);
    expect(diaryAsked(both.asked)).toEqual(diaryAsked(alone.asked));
    const entries = (result: typeof apart) => result.record.candidates.filter((entry) => entry.sourceId === 'diary')
      .map((entry) => ({ id: entry.id, status: entry.status,
        probability: 'probability' in entry ? entry.probability : undefined, reason: 'reason' in entry ? entry.reason : undefined }));
    expect(entries(together)).toEqual(entries(apart));
  });

  it('advances the walks of every opened segment together, a ring a round', async () => {
    const a = (line: number) => idOf('a', line);
    const b = (line: number) => idOf('b', line);
    // Two agent-only sessions, each opened by a lane's top part.
    const parts = Array.from({ length: 9 }, (_, index) => [
      part('a', index + 1, 'agent', index === 4 ? { ranks: [0] } : {}),
      part('b', index + 1, 'agent', index === 4 ? { ranks: [1] } : {}),
    ]).flat();
    const { asked, decide } = rater({ [a(5)]: 0.9, [a(4)]: 0.5, [a(6)]: 0.5, [a(3)]: 0.5, [a(7)]: 0.5,
      [b(5)]: 0.9, [b(4)]: 0.5, [b(6)]: 0.5 });
    await pick(parts, { task, decide, ...agentRead });
    // The order, then each segment's starts, then both walks one ring a
    // round: b's ends after its second ring, a's after its third.
    expect(asked).toEqual([[a(5), b(5)], [a(9), a(8), b(9), b(8)],
      [a(4), a(6), b(4), b(6)], [a(3), a(7), b(3), b(7)], [a(2)]]);
  });

  it('keeps identical text from two authors apart: each part keeps its own rating', async () => {
    const text = 'We decided to keep Postgres for the ledger.';
    const parts = [
      part('p', 1, 'person', { ranks: [0], text }), part('p', 2, 'agent'),
      part('q', 1, 'agent', { ranks: [1], text }), part('q', 2, 'agent'),
    ];
    const { asked, decide } = rater({ [idOf('p', 1)]: 0.9, [idOf('q', 1)]: 0.005 });
    const result = await pick(parts, { task, decide, ...agentRead });
    expect(asked[0]).toEqual([idOf('p', 1)]);
    expect(asked.flat().filter((id) => id === idOf('q', 1))).toHaveLength(1);
    const status = (id: string) => result.record.candidates.find((entry) => entry.id === id);
    const probability = (id: string) => { const entry = status(id); return entry && 'probability' in entry ? entry.probability : 0; };
    expect(status(idOf('p', 1))?.status).toBe('selected');
    expect(probability(idOf('p', 1))).toBeCloseTo(0.9, 12);
    expect(status(idOf('q', 1))?.status).toBe('rejected');
    expect(probability(idOf('q', 1))).toBeCloseTo(0.005, 12);
  });
});

describe('reads of several modes in one call', () => {
  const notes = Array.from({ length: 6 }, (_, index): MemoryCandidate => ({
    sourceId: 'notes', role: 'reference', id: `notes/decisions.md#${index}`, title: `Decision ${index}`,
    text: `Note ${index}`, signals: {}, searchRanks: [index],
  }));
  const mixed = { ...agentRead, sourceKinds: { chat: 'chat', notes: 'markdown' } } as const;
  /** The rater's answers 5 ms after each request, or 30 ms when it asks
   *  about one of `slower`, with the sources of every request open at
   *  once. */
  const slow = (ratings: Readonly<Record<string, number>>, slower: ReadonlySet<string> = new Set()) => {
    const { asked, decide: rate } = rater(ratings);
    const open: string[][] = [];
    const overlaps: string[][][] = [];
    const decide: PickDecide = async (batch, signal) => {
      const sources = [...new Set(batch.questions.map((item) => item.sourceId))];
      open.push(sources);
      overlaps.push([...open]);
      await new Promise((resolve) => setTimeout(resolve,
        batch.questions.some((item) => slower.has(item.id)) ? 30 : 5));
      open.splice(open.indexOf(sources), 1);
      return rate(batch, signal);
    };
    return { asked, overlaps, decide };
  };

  it('runs the ranked read and the conversation read at once', async () => {
    const { overlaps, decide } = slow({ [idOf('s0', 1)]: 0.9, [notes[1]!.id]: 0.7 });
    const result = await pick([...personSessions(4), ...notes], { task, decide, ...mixed });
    expect(overlaps.some((open) => open.flat().includes('notes') && open.flat().includes('chat'))).toBe(true);
    expect(result.selected.map((item) => item.id)).toEqual(expect.arrayContaining([idOf('s0', 1), notes[1]!.id]));
  });

  it('keeps the reads together inside the call\'s request limits', async () => {
    const ratings = { [idOf('s0', 1)]: 0.9, [notes[1]!.id]: 0.7 };
    const one = slow(ratings);
    await pick([...personSessions(4), ...notes], { task, decide: one.decide, ...mixed,
      limits: { maxPerBatch: 2, maxInFlight: 1 } });
    expect(Math.max(...one.overlaps.map((open) => open.length))).toBe(1);
    const three = slow(ratings);
    const capped = await pick([...personSessions(4), ...notes], { task, decide: three.decide, ...mixed,
      limits: { maxPerBatch: 2, maxBatches: 3 } });
    expect(three.asked).toHaveLength(3);
    expect(capped.record.candidates.some((entry) => entry.status === 'unassessed' && entry.reason === 'limits')).toBe(true);
  });

  it('sends no queued request of another read once a request has failed', async () => {
    // Three modes, each with a conversation read of its own; one request
    // open at a time, and the first request fails.
    const own = (source: string) => Array.from({ length: 6 }, (_, i): MemoryCandidate => ({ sourceId: source, id: `${source}${i}`,
      role: 'reference', title: 'Part', text: `unique ${source} item ${i}`, author: 'person',
      place: { container: `${source}${i}`, at: [1] }, searchRanks: [i], signals: { keyword: 1 } }));
    let failed = false;
    const after: string[] = [];
    const decide: PickDecide = async (batch) => {
      if (failed) after.push(...batch.questions.map((item) => item.id));
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (batch.questions[0]!.sourceId === 'a') { failed = true; throw new Error('synthetic refusal'); }
      return Object.fromEntries(batch.questions.map((item) => [item.key, { status: 'answered', probability: 0.9 }]));
    };
    const modes = Object.fromEntries(['a', 'b', 'c'].map((source) => [source, { name: source, questions: agentSet, read: conversationRead() }]));
    await expect(pick(['a', 'b', 'c'].flatMap(own), { task, decide, modesBySource: modes, limits: { maxPerBatch: 2, maxInFlight: 1 } }))
      .rejects.toThrow('synthetic refusal');
    expect(after).toEqual([]);
  });

  it('asks a text once when two reads reach it at the same time, and both parts take its answer', async () => {
    // A ranked source with the agent set holds the person's first message
    // word for word. Whichever read asks it first, its request is still
    // open when the other read's own requests have answered.
    const diary = part('d', 1, 'person', { sourceId: 'diary', ranks: [0], text: 's0 part 1' });
    const { asked, decide } = slow({ [idOf('s0', 1)]: 0.9, [diary.id]: 0.9 }, new Set([idOf('s0', 1), diary.id]));
    const result = await pick([...personSessions(4), diary], { task, decide, sourceKinds: { chat: 'chat', diary: 'chat' },
      modesBySource: { ...modesOf({ chat: agentSet }, conversationRead()), ...modesOf({ diary: agentSet }) } });
    expect(asked.flat().filter((id) => id === idOf('s0', 1) || id === diary.id)).toHaveLength(1);
    for (const id of [idOf('s0', 1), diary.id]) {
      const entry = result.record.candidates.find((item) => item.id === id);
      expect(entry?.status).toBe('selected');
      expect(entry && 'probability' in entry ? entry.probability : 0).toBeCloseTo(0.9, 12);
    }
  });

  it('asks that text twice when only one of the two reads carries the facts the answer needs', async () => {
    // As above, but the conversation read's mode lists the facts and the
    // ranked one does not: an answer asked with the facts is not the
    // answer to the same text asked without them.
    const diary = part('d', 1, 'person', { sourceId: 'diary', ranks: [0], text: 's0 part 1' });
    const shared = new Set([idOf('s0', 1), diary.id]);
    const asked: { id: string; needed: boolean }[] = [];
    const decide: PickDecide = async (batch) => {
      for (const question of batch.questions) asked.push({ id: question.id, needed: batch.needed !== undefined });
      await new Promise((resolve) => setTimeout(resolve, batch.questions.some((item) => shared.has(item.id)) ? 30 : 5));
      return Object.fromEntries(batch.questions.map((question) =>
        [question.key, { status: 'answered', probability: batch.needed === undefined ? 0.002 : 0.9 }]));
    };
    const result = await pick([...personSessions(4), diary], { task, decide, sourceKinds: { chat: 'chat', diary: 'chat' },
      needed: ['Which database was chosen'],
      modesBySource: { chat: { name: 'chat', questions: agentSet, read: conversationRead(), needed: true }, ...modesOf({ diary: agentSet }) } });
    expect(asked.filter((item) => shared.has(item.id))).toEqual(expect.arrayContaining([
      { id: idOf('s0', 1), needed: true }, { id: diary.id, needed: false }]));
    const probability = (id: string) => {
      const entry = result.record.candidates.find((item) => item.id === id);
      return entry && 'probability' in entry ? entry.probability : undefined;
    };
    expect(probability(idOf('s0', 1))).toBeCloseTo(0.9, 12);
    expect(probability(diary.id)).toBeCloseTo(0.002, 12);
  });
});

describe('the chat read beside stopWhenCold', () => {
  const warmAt = (from: number, count: number) => Object.fromEntries(Array.from({ length: count },
    (_, index) => [idOf(`s${from + index}`, 1), 0.9]));

  it('leaves an agent source to its own stop when stopWhenCold is set', async () => {
    const ratings = { ...warmAt(0, 10), ...warmAt(112, 3), ...warmAt(224, 50) };
    const plain = rater(ratings);
    const without = await pick(personSessions(336), { task, decide: plain.decide, ...agentRead });
    const cold = rater(ratings);
    // A floor and share that would end any read of the order at its first batch.
    const withStop = await pick(personSessions(336), { task, decide: cold.decide, ...agentRead,
      stopWhenCold: { floor: 0.99, share: 0.99 } });
    expect(cold.asked).toEqual(plain.asked);
    expect(withStop.record.pick?.chatRead).toEqual(without.record.pick?.chatRead);
    expect(withStop.record.pick?.chatRead).toMatchObject({ requests: 2, ended: 'fall' });
    expect(withStop.record.candidates.some((entry) => 'reason' in entry && entry.reason === 'stopWhenCold')).toBe(false);
    expect(withStop.record.effects.find((entry) => entry.setting === 'stopWhenCold' && entry.source === 'chat')?.summary)
      .toBe("stopWhenCold on chat: the chat read read this source's parts, and its own stop decided how far.");
  });

  it('does not stop before it has kept a part, so the call ends with something selected', async () => {
    // Agent-written parts only, one ranked part a session. Requests 1 and 2
    // hold warm parts under the keep bar; request 2's fall waits, request 3
    // finds kept ones, and request 4's fall ends the read.
    const parts = Array.from({ length: 448 }, (_, index) => part(`x${index}`, 1, 'agent', { ranks: [index] }));
    const rate = (from: number, count: number, value: number) => Object.fromEntries(Array.from({ length: count },
      (_, index) => [idOf(`x${from + index}`, 1), value]));
    const ratings = { ...Object.fromEntries(parts.map((item) => [item.id, 0.0005])),
      ...rate(0, 10, 0.01), ...rate(112, 2, 0.01), ...rate(224, 10, 0.5), ...rate(336, 1, 0.5) };
    for (const stopWhenCold of [undefined, {}] as const) {
      const result = await pick(parts, { task, decide: rater(ratings).decide, ...agentRead,
        ...(stopWhenCold === undefined ? {} : { stopWhenCold }) });
      expect(result.record.pick?.chatRead).toMatchObject({ requests: 4, ended: 'fall' });
      expect(result.selected).toHaveLength(11);
    }
  });
});

describe('the conversation read\'s rules', () => {
  it('takes its walk and stop decisions as rules in place of the measured ones', async () => {
    const a = (line: number) => idOf('a', line);
    const parts = Array.from({ length: 12 }, (_, index) => {
      const line = index + 1;
      return line === 1 ? part('a', 1, 'person', { ranks: [0] })
        : line === 6 ? part('a', 6, 'person', { ranks: [1] })
          : part('a', line, 'agent');
    });
    const ratings = { [a(6)]: 0.9, [a(7)]: 0.8, [a(5)]: 0.5, [a(1)]: 0.02 };
    const measured = rater(ratings);
    await pick(parts, { task, decide: measured.decide, ...agentRead });
    // The measured rule rates the warm part's reply next.
    expect(measured.asked[1]).toEqual([a(7)]);
    const still = rater(ratings);
    await pick(parts, { task, decide: still.decide, sourceKinds: chatKind,
      modesBySource: modesOf({ chat: agentSet }, conversationRead({ walksOn: () => false })) });
    expect(still.asked.flat()).not.toContain(a(7));
    // A stop that fires after every request ends the read after its first.
    const ratingsMany = Object.fromEntries(Array.from({ length: 336 }, (_, index) => [idOf(`s${index}`, 1), 0.9]));
    const stopped = await pick(personSessions(336), { task, decide: rater(ratingsMany).decide, sourceKinds: chatKind,
      modesBySource: modesOf({ chat: agentSet }, conversationRead({ stops: () => true })) });
    expect(stopped.record.pick?.chatRead).toMatchObject({ requests: 1, ended: 'fall' });
    const measuredMany = await pick(personSessions(336), { task, decide: rater(ratingsMany).decide, ...agentRead });
    expect(measuredMany.record.pick?.chatRead?.requests).toBe(3);
  });
});

describe('the cost of a read', () => {
  it('looks up ratings a bounded number of times on a long single-topic transcript', async () => {
    // 800 warm parts of one transcript and one topic. Walk checks read
    // only the facts the walk rule uses: computing every neighbour and
    // segment fact for each check cost 386 million lookups here.
    const n = 800;
    const parts: MemoryCandidate[] = Array.from({ length: n }, (_, index) => ({ sourceId: 'chat', id: `p${index}`,
      role: 'reference', title: 'title', text: `postgres database migration schema unique ${index}`, signals: {},
      author: 'agent', place: { container: 's.jsonl', at: [index + 1, 1, 1] } }));
    const rated = new Set<MemoryCandidate>();
    let lookups = 0;
    const result = await chatRead({ parts, order: parts, byKeyword: parts, lanes: [[parts[n / 2]!]],
      rate: async (some) => { for (const item of some) rated.add(item); },
      score: (item) => { lookups += 1; return rated.has(item) ? 0.8 : undefined; },
      kept: () => true, stopped: () => false });
    expect(result.read).toHaveLength(n);
    expect(lookups).toBeLessThan(600_000);
  });
});

describe('the topic split', () => {
  it('cuts a session where its words change', () => {
    const texts = [
      ...Array.from({ length: 20 }, () => 'postgres database migration schema'),
      ...Array.from({ length: 20 }, () => 'kubernetes cluster deployment helm'),
    ];
    expect(topicShifts(texts)).toEqual([20]);
    expect(topicShifts(texts.slice(0, 19))).toEqual([]);
  });
});

describe('the chat read under a caller\'s limits', () => {
  // One person part per session, each ranked in the one lane, and every
  // part warm: only a limit can end the read early.
  const parts = Array.from({ length: 336 }, (_, index) => part(`s${index}`, 1, 'person', { ranks: [index] }));
  const warm = Object.fromEntries(parts.map((item) => [item.id, 0.9]));

  it('reaches only the parts a candidate limit admits', async () => {
    const limited = { maxCandidates: 1 };
    const own = rater(warm);
    const read = await pick(parts, { task, decide: own.decide, ...agentRead, limits: limited });
    const plain = rater(warm);
    await pick(parts, { task, decide: plain.decide, sourceKinds: chatKind, modesBySource: modesOf({ chat: agentSet }),
      limits: limited });
    expect(own.asked.flat()).toEqual(plain.asked.flat());
    expect(own.asked.flat()).toHaveLength(1);
    expect(read.selected).toHaveLength(1);
    expect(read.record.candidates.filter((entry) => entry.status === 'unassessed')
      .every((entry) => entry.status === 'unassessed' && entry.reason === 'limits')).toBe(true);
  });

  it.each([
    ['a batch limit', { maxPerBatch: 2, maxBatches: 1 }, undefined, 2, 'limits'],
    ['a cancellation', { maxPerBatch: 2, maxInFlight: 1 }, idOf('s2', 1), 4, 'cancelled'],
    ['a time limit', { maxPerBatch: 2, maxElapsedMs: 20 }, undefined, 0, 'time'],
  ] as const)('counts only the parts it rated when %s ends a request', async (_name, limits, cancelAt, rated, ended) => {
    const controller = new AbortController();
    const asked: string[] = [];
    const decide: PickDecide = async ({ questions }) => {
      if (questions.some((question) => question.id === cancelAt)) controller.abort();
      if (ended === 'time') await new Promise((resolve) => setTimeout(resolve, 200));
      asked.push(...questions.map((question) => question.id));
      return Object.fromEntries(questions.map((question) => [question.key, { status: 'answered', probability: 0.9 }]));
    };
    const read = await pick(parts, { task, decide, ...agentRead, limits, signal: controller.signal });
    expect(read.record.pick?.chatRead).toEqual({ requests: 1, segments: 0, units: 0, rated, unread: 336 - rated, ended });
    expect(read.record.candidates.filter((entry) => entry.status === 'selected')).toHaveLength(rated);
    expect(read.record.candidates.filter((entry) => entry.status === 'unassessed')
      .every((entry) => entry.status === 'unassessed' && entry.reason === ended)).toBe(true);
  });
});

describe('the units of agent work as one more start', () => {
  /** A part of a subagent's transcript, marked as its prompt or its report. */
  const agentPart = (agent: string, line: number, piece: number, unit: 'prompt' | 'report', text: string): MemoryCandidate => ({
    sourceId: 'chat', role: 'reference', id: `claude-code:/home/me/.claude/projects:app/s/subagents/agent-${agent}.jsonl:${line}:1:${piece}`,
    title: `claude-code s ${unit === 'prompt' ? 'user' : 'assistant'} (agent)`, text,
    date: { value: new Date(Date.UTC(2026, 9, 1, 1, line)).toISOString(), meaning: 'recorded' },
    author: 'agent', place: { container: `claude-code:/home/me/.claude/projects:app/s/subagents/agent-${agent}.jsonl`, at: [line, 1, piece] },
    chat: { provider: 'claude-code', sessionId: 's', role: unit === 'prompt' ? 'user' : 'assistant', unit },
    signals: {}, poolOnly: true,
  });
  /** Twelve subagents, each a one-part prompt and a six-part report;
   *  agent a7 was asked about the database and its fourth report part
   *  says which one was chosen. */
  const agents = Array.from({ length: 12 }, (_, n) => {
    const name = `a${n}`;
    const topic = n === 7 ? 'postgres database transactions' : `module${n} refactor cleanup`;
    return [agentPart(name, 1, 1, 'prompt', `Look into the ${topic} question for the team.`),
      ...Array.from({ length: 6 }, (_, k) => agentPart(name, 9, k + 1, 'report',
        n === 7 && k === 3 ? 'We chose Postgres for its transactions.' : `Report on ${topic}, part ${k + 1}.`))];
  }).flat();
  const answer = agents.find((part) => part.text === 'We chose Postgres for its transactions.')!;
  const ratings = { [idOf('s0', 1)]: 0.9, [answer.id]: 0.8,
    ...Object.fromEntries(agents.filter((part) => part.place!.container.includes('agent-a7')).map((part) => [part.id, part === answer ? 0.8 : 0.5])) };
  const embed = async (texts: readonly string[]) => texts.map((text) =>
    [/postgres|database/i.test(text) ? 1 : 0, /module|refactor/i.test(text) ? 1 : 0, 0.1]);

  it('ranks each kind of unit against the queries, opens those above the bend and finds the answer inside', async () => {
    const { asked, decide } = rater(ratings);
    const result = await pick([...personSessions(4), ...agents], { task, decide, ...agentRead,
      queriesBySource: { chat: [task, 'postgres database decision'] }, embed });
    expect(result.selected.map((part) => part.id)).toContain(answer.id);
    expect(result.record.pick?.chatRead?.units).toBe(2);
    // Only agent a7's prompt and report were read among the agents' parts.
    const agentIds = new Set(agents.map((part) => part.id));
    expect(new Set(asked.flat().filter((id) => agentIds.has(id)).map((id) => id.replace(/:\d+:1:\d+$/, ''))))
      .toEqual(new Set(['claude-code:/home/me/.claude/projects:app/s/subagents/agent-a7.jsonl']));
  });

  it('ranks by keyword alone with no embedder, and opens no unit with no queries', async () => {
    const keyword = await pick([...personSessions(4), ...agents], { task, decide: rater(ratings).decide, ...agentRead,
      queriesBySource: { chat: [task, 'postgres database decision'] } });
    expect(keyword.selected.map((part) => part.id)).toContain(answer.id);
    const none = await pick([...personSessions(4), ...agents], { task, decide: rater(ratings).decide, ...agentRead, embed });
    expect(none.record.pick?.chatRead?.units).toBe(0);
    expect(none.selected.map((part) => part.id)).not.toContain(answer.id);
  });

  it('describes a unit by its first 600 characters, its headings, its rarest words and, for a report, its prompt', () => {
    // The expected text is the one the measured script (climb13.py) makes from the same parts.
    const prompt = agentPart('b', 1, 1, 'prompt', 'Find the cache code.');
    const report = [agentPart('b', 5, 1, 'report', '# Findings\nThe cache lives in store.ts and expires hourly.'),
      agentPart('b', 5, 2, 'report', '## Next\nNothing else touches the cache.')];
    const other = [agentPart('c', 1, 1, 'prompt', 'Check the cache tests.')];
    const units = agentUnits([...report, prompt, ...other]);
    expect(units.map((unit) => [unit.kind, unit.parts.length])).toEqual([['report', 2], ['prompt', 1], ['prompt', 1]]);
    // A line an agent wrote in the user's turn of a session that is not a
    // subagent's counts as a summary when it holds three parts or more.
    const said = (session: string, line: number, pieces: number): MemoryCandidate[] => Array.from({ length: pieces }, (_, k) => ({
      ...part(session, line, 'agent', { text: `summary ${session} ${k}` }), id: `claude-code:/home/me/.claude/projects:app/${session}.jsonl:${line}:1:${k + 1}`,
      place: { container: `claude-code:/home/me/.claude/projects:app/${session}.jsonl`, at: [line, 1, k + 1] },
      chat: { provider: 'claude-code', sessionId: session, role: 'user' } }));
    const sideNote = { ...agentPart('b', 3, 1, 'report', 'aside'), chat: { provider: 'claude-code' as const, sessionId: 's', role: 'user' as const } };
    expect(agentUnits([...said('main', 4, 3), ...said('main', 9, 2), ...report, sideNote, ...said('b', 7, 3).map((item) =>
      ({ ...item, place: { ...item.place!, container: report[0]!.place!.container } }))])
      .map((unit) => [unit.kind, unit.parts.length])).toEqual([['summary', 3], ['report', 2]]);
    expect(unitDescriptors(units)[0]).toBe('# Findings\nThe cache lives in store.ts and expires hourly. ## Next\nNothing else touches the cache.\n'
      + '# Findings\n'
      + 'else expires findings hourly lives next nothing store touches cache\n'
      + 'Find the cache code.');
  });
});
