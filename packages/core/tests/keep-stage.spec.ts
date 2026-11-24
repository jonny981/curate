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

describe('the exchange around what the person said, each kind at its own bar', () => {
  const said = (container: string, line: number, text: string, author: 'person' | 'agent' | 'tool', unit?: 'prompt' | 'report'): MemoryCandidate => ({
    sourceId: 'chat', role: 'reference', id: `${container}:${line}:1:1`, title: `claude-code s1 ${author}`, text, signals: {},
    date: { value: `2026-10-01T09:${String(line).padStart(2, '0')}:00Z`, meaning: 'recorded' }, author,
    place: { container, at: [line, 1, 1] },
    chat: { provider: 'claude-code', sessionId: 's1', role: author === 'agent' ? 'assistant' : 'user', ...(unit === undefined ? {} : { unit }) },
    searchRanks: [line],
  });
  const main = container('s1');
  const sub = `${main.replace(/\.jsonl$/, '')}/subagents/agent-a7.jsonl`;
  const talk = [
    said(main, 1, 'Should we use Postgres or SQLite?', 'agent'),
    said(main, 2, 'Postgres, for transactions.', 'person'),
    said(main, 3, 'build log: all green', 'tool'),
    said(main, 4, 'Done: switched to Postgres.', 'agent'),
    said(main, 5, 'Thanks.', 'person'),
    said(main, 6, 'Anything else?', 'agent'),
    said(sub, 1, 'Look into which database we use.', 'agent', 'prompt'),
    said(sub, 9, 'We chose Postgres.', 'agent', 'report'),
  ];
  const ratings: Record<string, number> = { 'Postgres, for transactions.': 0.9, 'We chose Postgres.': 0.95, 'build log: all green': 0.5 };
  const decide: PickDecide = async (batch) => Object.fromEntries(batch.questions.map((question) => [question.key, { status: 'answered',
    probability: batch.stage !== 'keep' ? 0.5 : question.questionKey === 'answers' ? ratings[question.text] ?? 0.1 : 0.02 }]));
  const exchangeMode = mode({ bar: 0.5, exchange: true, barByKind: { 'person message': 0.76, 'subagent final report': 0.59, 'agent step': 1,
    'tool output': 0.81, 'subagent prompt': 1 } });

  it('keeps each kind at its own bar, and the agent messages around a kept message of the person, and a report\'s request', async () => {
    const result = await pick(talk, { task, decide, everyRanked: true, modesBySource: { chat: exchangeMode } });
    expect(result.selected.map((part) => part.text).sort()).toEqual(['Done: switched to Postgres.', 'Look into which database we use.',
      'Postgres, for transactions.', 'Should we use Postgres or SQLite?', 'We chose Postgres.']);
    // Tool output at 0.5 is under its own bar of 0.81, and joins no exchange.
    expect(entry(result, talk[2]!)).toMatchObject({ status: 'rejected', probability: 0.5 });
    expect(entry(result, talk[1]!)).toMatchObject({ status: 'selected', keptAs: 'rating', probability: 0.9 });
    const anchor = { sourceId: 'chat', id: talk[1]!.id };
    expect(entry(result, talk[0]!)).toMatchObject({ status: 'selected', keptAs: 'exchange', exchange: [anchor] });
    expect(entry(result, talk[3]!)).toMatchObject({ status: 'selected', keptAs: 'exchange', exchange: [anchor] });
    expect(entry(result, talk[5]!)).toMatchObject({ status: 'rejected' });
    expect(entry(result, talk[6]!)).toMatchObject({ status: 'selected', keptAs: 'exchange', exchange: [{ sourceId: 'chat', id: talk[7]!.id }] });
    expect(result.record.keep!.sources.chat).toMatchObject({ byExchange: 3 });
  });

  it('lays each exchange out as one passage in conversation order, placed by its strongest message', async () => {
    const result = await pick(talk, { task, decide, everyRanked: true, modesBySource: { chat: exchangeMode } });
    const { log } = await curate(task, result, { person: 'Sam' });
    expect(log).toBe([
      '### Most likely answer', '',
      '#### session s1, an exchange (said 2026-10-01 09:01 to 2026-10-01 09:09)', '',
      '[2026-10-01 09:01] agent:\nLook into which database we use.', '',
      '[2026-10-01 09:09] agent:\nWe chose Postgres.', '',
      '#### session s1, an exchange (said 2026-10-01 09:01 to 2026-10-01 09:04)', '',
      '[2026-10-01 09:01] agent:\nShould we use Postgres or SQLite?', '',
      '[2026-10-01 09:02] Sam:\nPostgres, for transactions.', '',
      '[2026-10-01 09:04] agent:\nDone: switched to Postgres.', '',
    ].join('\n'));
  });

  it('cuts an agent message kept only for the exchange to the paragraph nearest the person\'s, naming the rest by id', async () => {
    const long = [
      said(main, 1, 'Here is the comparison.\n\nSQLite is simpler.\n\nShould we use Postgres or SQLite?', 'agent'),
      said(main, 2, 'Postgres, for transactions.', 'person'),
      said(main, 4, 'Done: switched to Postgres.\n\nThe migration ran.\n\nTests are green.', 'agent'),
      said(sub, 1, 'Look into which database we use.', 'agent', 'prompt'),
      said(sub, 9, 'We chose Postgres.\n\nIt has transactions.', 'agent', 'report'),
    ];
    const cutting = mode({ bar: 0.5, exchange: { nearest: 'paragraph' }, barByKind: { 'person message': 0.76, 'subagent final report': 0.59,
      'agent step': 1, 'subagent prompt': 1 } });
    const rate: PickDecide = async (batch) => Object.fromEntries(batch.questions.map((question) => [question.key, { status: 'answered',
      probability: batch.stage !== 'keep' ? 0.5 : question.questionKey === 'answers' ? question.text.startsWith('Postgres,') ? 0.9
        : question.text.startsWith('We chose') ? 0.95 : 0.1 : 0.02 }]));
    const result = await pick(long, { task, decide: rate, everyRanked: true, modesBySource: { chat: cutting } });
    expect(result.record.levers.sources.chat!.keep).toMatchObject({ exchange: { nearest: 'paragraph' } });
    const { log } = await curate(task, result, { person: 'Sam' });
    // The message he answers keeps its closing paragraph, the reply its opening one; the report, kept on its rating, stays whole.
    expect(log).toContain(`[2026-10-01 09:01] agent:\n[earlier paragraphs left out; the whole message is ${long[0]!.id}]\n\nShould we use Postgres or SQLite?`);
    expect(log).toContain(`[2026-10-01 09:04] agent:\nDone: switched to Postgres.\n\n[later paragraphs left out; the whole message is ${long[2]!.id}]`);
    expect(log).toContain('We chose Postgres.\n\nIt has transactions.');
    expect(log).not.toContain('SQLite is simpler.');
    // Without the setting the exchange stays whole.
    const whole = await pick(long, { task, decide: rate, everyRanked: true, modesBySource: { chat: { ...cutting, keep: { ...cutting.keep!, exchange: true } } } });
    expect((await curate(task, whole, { person: 'Sam' })).log).toContain('SQLite is simpler.');
  });

  it('keeps a message of the person alone under the exchange bar, and with its exchange at or over it', async () => {
    const at = (rating: number, wanted?: 'one decision' | 'everything said') => pick(talk, { task, ...(wanted === undefined ? {} : { wanted }),
      decide: async (batch) => Object.fromEntries(batch.questions.map((question) => [question.key, { status: 'answered',
        probability: batch.stage !== 'keep' ? 0.5 : question.questionKey === 'answers' ? question.text === 'Postgres, for transactions.' ? rating
          : ratings[question.text] ?? 0.1 : 0.02 }])),
      everyRanked: true, modesBySource: { chat: mode({ bar: 0.5, exchange: true,
        barByKind: { 'person message': { 'one decision': 0.28, 'everything said': 0.04 }, 'subagent final report': 0.59, 'agent step': 1,
          'tool output': 0.81, 'subagent prompt': 1 }, exchangeBar: { 'one decision': 0.76, 'everything said': 0.04 } }) } });
    // One decision: under the person's bar of 0.28 the message is dropped; from 0.28 to under 0.76 it is kept alone; at 0.76, with its exchange.
    expect(entry(await at(0.27, 'one decision'), talk[1]!)).toMatchObject({ status: 'rejected' });
    const alone = await at(0.28, 'one decision');
    expect(entry(alone, talk[1]!)).toMatchObject({ status: 'selected', keptAs: 'rating', probability: 0.28 });
    expect(entry(alone, talk[0]!)).toMatchObject({ status: 'rejected' });
    expect(entry(alone, talk[3]!)).toMatchObject({ status: 'rejected' });
    expect(entry(await at(0.75, 'one decision'), talk[0]!)).toMatchObject({ status: 'rejected' });
    const joined = await at(0.76, 'one decision');
    expect(entry(joined, talk[0]!)).toMatchObject({ status: 'selected', keptAs: 'exchange' });
    expect(entry(joined, talk[3]!)).toMatchObject({ status: 'selected', keptAs: 'exchange' });
    // A report keeps its request whatever the person's exchange bar says.
    expect(entry(alone, talk[6]!)).toMatchObject({ status: 'selected', keptAs: 'exchange' });
    // Everything said: the exchange comes with every kept message of the person.
    expect(entry(await at(0.3, 'everything said'), talk[0]!)).toMatchObject({ status: 'selected', keptAs: 'exchange' });
    await expect(pick(talk, { task, decide, modesBySource: { chat: mode({ exchangeBar: 2 }) } })).rejects.toThrow('keep.exchangeBar');
  });

  it('refuses a bar for a kind it does not know', async () => {
    await expect(pick(talk, { task, decide, modesBySource: { chat: mode({ barByKind: { 'agent reply': 0.5 } }) } }))
      .rejects.toThrow('keep.barByKind names "agent reply"');
    await expect(pick(talk, { task, decide, modesBySource: { chat: mode({ exchange: { nearest: 'sentence' as never } }) } }))
      .rejects.toThrow("keep.exchange must be a boolean or { nearest: 'paragraph' }.");
  });
});
