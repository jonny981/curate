import { afterEach, describe, expect, it, vi } from 'vitest';
import { jev, type JevCall } from '../src/models.js';
import {
  ANSWER_CASCADE, curate, jevRequest, pick, rankedRead, type MemoryCandidate, type Mode, type PickBatch, type PickCascade, type PickDecide,
} from '../src/index.js';

const task = 'Which database did Sam choose?';
const needed = ['which database Sam chose'];
/** The read's own question, one per part. */
const read: PickCascade = { bias: 0, questions: [{ key: 'relevant', instructions: 'Relevant?', true: 'Yes', false: 'No', weight: 1 }] };
const container = (session: string) => `claude-code:/home/sam/.claude/projects:app/${session}.jsonl`;
const piece = (session: string, line: number, at: number, text: string, author: 'person' | 'agent' = 'agent'): MemoryCandidate => {
  const role = author === 'person' ? 'user' : 'assistant';
  return {
    sourceId: 'chat', role: 'reference', id: `${container(session)}:${line}:1:${at}`, title: `claude-code ${session} ${role}`, text, signals: {},
    date: { value: `2026-10-0${line}T09:0${at}:00Z`, meaning: 'recorded' }, author,
    place: { container: container(session), at: [line, 1, at] }, chat: { provider: 'claude-code', sessionId: session, role },
    searchRanks: [line * 10 + at],
  };
};
// Three messages: one states the choice, one only a fact the answer needs, one is about something else.
const parts = [
  piece('s1', 1, 1, 'We chose '), piece('s1', 1, 2, 'Postgres.'),
  piece('s1', 2, 1, 'Sam picked the database last week.', 'person'),
  piece('s1', 3, 1, 'The build log is green.'),
];
const keepSet: PickCascade = { ...ANSWER_CASCADE, combine: 'highest' };
const mode = (keep: Partial<NonNullable<Mode['keep']>> = {}): Mode => ({ name: 'agent-transcripts', questions: read, read: rankedRead, needed: false,
  keep: { questions: keepSet, bar: { 'one decision': 0.59, 'everything said': 0.04 }, wholeMessages: true, hardFacts: true, ...keep } });
/** The read rates every part 0.5; the second stage rates each whole message by what it says. */
const deciding = () => {
  const batches: PickBatch[] = [];
  const decide: PickDecide = async (batch) => {
    batches.push(batch);
    return Object.fromEntries(batch.questions.map((question) => [question.key, { status: 'answered', probability:
      batch.stage !== 'keep' ? 0.5
        : question.questionKey === 'answers' ? (question.text === 'We chose Postgres.' ? 0.9 : question.text.startsWith('Sam picked') ? 0.1 : 0.03)
          : question.text.startsWith('Sam picked') ? 0.8 : 0.02 }]));
  };
  return { batches, decide };
};
const entry = (result: Awaited<ReturnType<typeof pick>>, part: MemoryCandidate) => result.record.candidates.find((one) => one.id === part.id)!;

afterEach(() => { vi.unstubAllGlobals(); });

describe('a second stage over the read\'s kept parts', () => {
  it('leaves the read on its own questions, then judges each kept message whole, batched, with hard facts and the needed facts', async () => {
    const { batches, decide } = deciding();
    await pick(parts, { task, decide, needed, person: 'Sam', wanted: 'one decision', everyRanked: true, modesBySource: { chat: mode() } });
    const first = batches.filter((batch) => batch.stage === undefined);
    const second = batches.filter((batch) => batch.stage === 'keep');
    expect(first.flatMap((batch) => batch.questions).map((question) => question.question)).toEqual(Array(4).fill('Relevant?'));
    expect(first.every((batch) => batch.needed === undefined && batch.person === undefined)).toBe(true);
    // One request holds the three messages, each asked once, whole, with both questions.
    expect(second).toHaveLength(1);
    const state = jevRequest(second[0]!).state;
    expect(state).toMatchObject({ task, needed, person: 'Sam', wanted: 'one decision' });
    expect(Object.values(state.items!).map((item) => item.text)).toEqual(['We chose Postgres.', 'Sam picked the database last week.', 'The build log is green.']);
    expect(Object.values(state.items!)[1]).toMatchObject({ author: 'Sam', kind: 'Sam message', pieces: 1 });
    expect(second[0]!.questions.map((question) => question.question)).toEqual(Array(3).fill(null).flatMap(() =>
      ['Does this item answer the task?', 'Does this item state this needed fact: which database Sam chose']));
  });

  it('keeps a message at the bar for the kind of task, by the highest of its answers, every piece at its message\'s score', async () => {
    const kept = async (wanted?: 'one decision' | 'everything said') => {
      const result = await pick(parts, { task, decide: deciding().decide, needed, ...(wanted === undefined ? {} : { wanted }),
        everyRanked: true, modesBySource: { chat: mode() } });
      return { ids: result.selected.map((part) => part.text), result };
    };
    const one = await kept('one decision');
    // The choice at 0.9 and the fact at 0.8 clear 0.59; the build log at 0.03 does not.
    expect(one.ids).toEqual(['We chose ', 'Postgres.', 'Sam picked the database last week.']);
    expect(entry(one.result, parts[1]!)).toMatchObject({ status: 'selected', probability: 0.9, readProbability: 0.5 });
    expect(entry(one.result, parts[2]!)).toMatchObject({ status: 'selected', probability: 0.8 });
    expect(entry(one.result, parts[3]!)).toMatchObject({ status: 'rejected', probability: 0.03, readProbability: 0.5 });
    expect(one.result.record.keep).toEqual({ asked: 3, requests: 1, unanswered: 0, sources: { chat: { kept: 3, dropped: 1, bar: 0.59 } } });
    expect(one.result.record.levers.sources.chat!.keep).toMatchObject({ bar: 0.59, wholeMessages: true, hardFacts: true });
    // Everything said keeps at 0.04, as does a pick that names no kind.
    expect((await kept('everything said')).ids).toHaveLength(3);
    expect((await kept()).result.record.keep!.sources.chat!.bar).toBe(0.04);
    // The text lays the kept messages out whole, strongest first, each with who said it.
    const { log } = await curate(task, one.result, { person: 'Sam' });
    expect(log.indexOf('We chose Postgres.')).toBeLessThan(log.indexOf('Sam picked the database'));
    expect(log).toContain('#### session s1 (said 2026-10-02 09:01), Sam');
    expect(log).not.toContain('build log');
  });

  it('sends each message alone when the stage sets one item a request', async () => {
    const { batches, decide } = deciding();
    await pick(parts, { task, decide, needed, everyRanked: true, modesBySource: { chat: mode({ itemsPerRequest: 1 }) } });
    const second = batches.filter((batch) => batch.stage === 'keep');
    expect(second).toHaveLength(3);
    expect(second.every((batch) => batch.alone === true && jevRequest(batch).state.item !== undefined)).toBe(true);
  });

  it('marks each second-stage request in the calls jev() reports, so each stage can be priced apart', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
      return Response.json({ usage: { input_tokens: 10 }, answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, { noul: 0.7 }])) });
    }));
    const calls: JevCall[] = [];
    await pick(parts, { task, needed, everyRanked: true, decide: jev({ apiKey: 'test-key', onCall: (call) => { calls.push(call); } }),
      modesBySource: { chat: mode() } });
    expect(calls.filter((call) => call.stage === 'keep')).toHaveLength(1);
    expect(calls.filter((call) => call.stage === undefined).length).toBeGreaterThan(0);
  });

  it('refuses a second stage with read-only machinery or a bar outside 0 to 1', async () => {
    const decide: PickDecide = async () => ({});
    await expect(pick(parts, { task, decide, modesBySource: { chat: mode({ questions: { ...keepSet, written: { highest: 1, second: 0 } } }) } }))
      .rejects.toThrow('keep.questions takes no written');
    await expect(pick(parts, { task, decide, modesBySource: { chat: mode({ bar: 2 }) } }))
      .rejects.toThrow('keep.bar must be a number between 0 and 1');
  });
});
