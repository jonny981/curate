import { describe, expect, it } from 'vitest';
import {
  conversationRead, curate, jevRequest, pick, rankedRead, type MemoryCandidate, type Mode, type PickBatch, type PickCascade, type PickDecide,
} from '../src/index.js';

const task = 'Which database did we choose?';
const set: PickCascade = { bias: 0, questions: [{ key: 'relevant', instructions: 'Relevant?', true: 'Yes', false: 'No', weight: 1 }] };
const mode = (wholeMessages?: boolean): Mode => ({ name: 'agent-transcripts', questions: set, read: rankedRead,
  ...(wholeMessages === undefined ? {} : { wholeMessages }) });

const container = (session: string) => `claude-code:/home/sam/.claude/projects:app/${session}.jsonl`;
/** A transcript piece as the chat reader cuts it: a line, a block and a
 *  piece of the message on that line. Ranked pieces sit in the lane;
 *  the rest are pool members no lane holds. */
const piece = (session: string, line: number, at: number, text: string, options: {
  author?: 'person' | 'agent'; rank?: number; unit?: 'prompt' | 'report'; block?: number;
} = {}): MemoryCandidate => {
  const author = options.author ?? 'agent';
  const role = author === 'person' || options.unit === 'prompt' ? 'user' : 'assistant';
  return {
    sourceId: 'chat', role: 'reference', id: `${container(session)}:${line}:${options.block ?? 1}:${at}`,
    title: `claude-code ${session} ${role}`, text, signals: {},
    date: { value: `2026-10-0${line}T09:00:00Z`, meaning: 'recorded' },
    author, place: { container: container(session), at: [line, options.block ?? 1, at] },
    chat: { provider: 'claude-code', sessionId: session, role, ...(options.unit === undefined ? {} : { unit: options.unit }) },
    ...(options.rank === undefined ? { poolOnly: true as const } : { searchRanks: [options.rank] }),
  };
};
const recording = (rating: (text: string) => number = () => 0.9) => {
  const batches: PickBatch[] = [];
  const decide: PickDecide = async (batch) => {
    batches.push(batch);
    return Object.fromEntries(batch.questions.map((question) =>
      [question.key, { status: 'answered', probability: rating(question.text) }]));
  };
  return { batches, decide };
};
const status = (result: Awaited<ReturnType<typeof pick>>, id: string) => {
  const entry = result.record.candidates.find((item) => item.id === id)!;
  // The set's weight of 1 turns an answer into a score through its logit and back.
  return { status: entry.status, probability: 'probability' in entry ? Number(entry.probability!.toFixed(9)) : undefined };
};

// One agent report cut into three pieces, only the second of which the
// search ranked, and the person's reply.
const report = [
  piece('s1', 2, 1, 'Findings:\n'),
  piece('s1', 2, 2, '1. We chose Postgres.\n', { rank: 0 }),
  piece('s1', 2, 3, '2. Redis stays a cache.\n'),
];
const reply = piece('s1', 3, 1, 'Agreed.', { author: 'person', rank: 1 });

describe('whole messages', () => {
  it('asks once about the whole message of a ranked piece, and gives each piece its rating', async () => {
    const { batches, decide } = recording((text) => text.includes('Postgres') ? 0.9 : 0.001);
    const result = await pick([...report, reply], { task, decide, modesBySource: { chat: mode(true) } });
    const asked = batches.flatMap((batch) => batch.questions);
    expect(asked.map((question) => question.text)).toEqual(['Findings:\n1. We chose Postgres.\n2. Redis stays a cache.\n', 'Agreed.']);
    expect(asked[0]!.id).toBe(report[0]!.id);
    for (const part of report) expect(status(result, part.id)).toEqual({ status: 'selected', probability: 0.9 });
    expect(status(result, reply.id)).toEqual({ status: 'rejected', probability: 0.001 });
    expect(result.record.levers.sources.chat!.wholeMessages).toBe(true);
    expect(result.record.pick!.sent).toBe(2);
  });

  it('lays a kept message out once, whole', async () => {
    const result = await pick([...report, reply], { task, decide: recording().decide, modesBySource: { chat: mode(true) } });
    const { log, record } = await curate(task, result);
    expect(record.items.map((item) => item.candidate.text)).toEqual(['Findings:\n1. We chose Postgres.\n2. Redis stays a cache.\n', 'Agreed.']);
    expect(log.match(/We chose Postgres/g)).toHaveLength(1);
  });

  it('joins the blocks of one message apart by a blank line', async () => {
    const blocks = [piece('s1', 4, 1, 'First block.', { block: 1, rank: 0 }), piece('s1', 4, 1, 'Second block.', { block: 2 })];
    const { batches, decide } = recording();
    await pick(blocks, { task, decide, modesBySource: { chat: mode(true) } });
    expect(batches.flatMap((batch) => batch.questions).map((question) => question.text)).toEqual(['First block.\n\nSecond block.']);
  });

  it('sends a subagent\'s report with the request that produced it', async () => {
    const brief = [piece('agent-a1', 1, 1, 'Find which database the team chose. ', { unit: 'prompt' }),
      piece('agent-a1', 1, 2, 'Report the decision.', { unit: 'prompt' })];
    const found = piece('agent-a1', 9, 1, 'The team chose Postgres.', { unit: 'report', rank: 0 });
    const { batches, decide } = recording();
    await pick([...brief, found], { task, decide, modesBySource: { chat: mode(true) } });
    const question = batches.flatMap((batch) => batch.questions).find((item) => item.id === found.id)!;
    expect(question.facts).toEqual({ asked: 'Find which database the team chose. Report the decision.' });
    // The request as sent: the report's record carries the request after
    // its own fields.
    expect(jevRequest({ task, questions: [question] })).toEqual({
      model: 'jev-latest',
      state: {
        task,
        items: {
          1: {
            id: found.id,
            date: 'recorded 2026-10-09T09:00:00Z',
            title: 'claude-code agent-a1 assistant',
            text: 'The team chose Postgres.',
            author: 'agent',
            asked: 'Find which database the team chose. Report the decision.',
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

  it('sends a message too large for one request as numbered parts, each after the first with its first 1,000 characters', async () => {
    const long = Array.from({ length: 6 }, (_, index) =>
      piece('s2', 5, index + 1, `${index === 4 ? 'We chose Postgres. ' : ''}${'word '.repeat(40)}\n`, index === 0 ? { rank: 0 } : {}));
    const { batches, decide } = recording((text) => text.includes('Postgres') ? 0.8 : 0.01);
    const result = await pick(long, { task, decide, modesBySource: { chat: mode(true) }, limits: { maxBatchChars: 700 } });
    const asked = batches.flatMap((batch) => batch.questions);
    expect(asked.length).toBeGreaterThan(1);
    const n = asked.length;
    asked.forEach((question, index) => {
      expect(question.facts).toEqual({ part: `${index + 1} of ${n}`,
        ...(index === 0 ? {} : { opening: long.map((part) => part.text).join('').slice(0, 1000) }) });
    });
    // Every piece is sent once, in order, across the parts.
    expect(asked.map((question) => question.text).join('')).toBe(long.map((part) => part.text).join(''));
    // The message's rating is its best part's, on every piece.
    for (const part of long) expect(status(result, part.id)).toEqual({ status: 'selected', probability: 0.8 });
  });

  it('judges whole messages under the conversation read, which reaches each message once', async () => {
    // The person's question, ranked, then an agent's answer cut in three.
    const ask = piece('s3', 1, 1, 'Which database?', { author: 'person', rank: 0 });
    const answer = [1, 2, 3].map((at) => piece('s3', 2, at, at === 2 ? 'We chose Postgres. ' : `Part ${at}. `));
    const { batches, decide } = recording((text) => text.includes('Postgres') ? 0.9 : 0.001);
    const result = await pick([ask, ...answer], { task, decide,
      modesBySource: { chat: { ...mode(true), read: conversationRead() } } });
    const texts = batches.flatMap((batch) => batch.questions).map((question) => question.text);
    expect(texts).toEqual(['Which database?', 'Part 1. We chose Postgres. Part 3. ']);
    for (const part of answer) expect(status(result, part.id)).toEqual({ status: 'selected', probability: 0.9 });
  });

  it('leaves every request and the record as they were when off', async () => {
    const parts = [...report, reply];
    const plain = recording();
    const before = await pick(parts, { task, decide: plain.decide, modesBySource: { chat: mode() } });
    const off = recording();
    const after = await pick(parts, { task, decide: off.decide, modesBySource: { chat: mode(false) } });
    expect(off.batches).toEqual(plain.batches);
    expect(off.batches.flatMap((batch) => batch.questions).map((question) => question.text))
      .toEqual(['1. We chose Postgres.\n', 'Agreed.']);
    expect(after.record.candidates).toEqual(before.record.candidates);
    expect(after.record.levers.sources.chat).not.toHaveProperty('wholeMessages');
  });

  it('must be a boolean', async () => {
    await expect(pick(report, { task, decide: recording().decide,
      modesBySource: { chat: { ...mode(), wholeMessages: 'yes' as unknown as boolean } } }))
      .rejects.toThrow('modesBySource.chat.wholeMessages must be a boolean.');
  });
});
