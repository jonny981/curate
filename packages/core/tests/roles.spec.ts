import { afterEach, describe, expect, it, vi } from 'vitest';
import { jev } from '../src/models.js';
import {
  conversationRead, jevRequest, pick, ROLE_QUESTION, type MemoryCandidate, type Mode, type PickBatch, type PickCascade, type PickDecide,
  type PickListDecide, type PickListRequest,
} from '../src/index.js';

const task = 'What did Ana decide about the database?';
const set: PickCascade = { bias: 0, questions: [{ key: 'relevant', instructions: 'Relevant?', true: 'Yes', false: 'No', weight: 1 }] };
const mode = (settings: Partial<Mode> = {}): Mode => ({ name: 'agent-transcripts', questions: set, read: conversationRead(), ...settings });
const container = 'claude-code:/home/ana/.claude/projects:app/s1.jsonl';
const piece = (line: number, author: 'person' | 'agent', text: string, rank?: number): MemoryCandidate => ({
  sourceId: 'chat', role: 'reference', id: `${container}:${line}:1:1`, title: `claude-code s1 ${author === 'agent' ? 'assistant' : 'user'}`,
  text, signals: {}, date: { value: `2026-10-01T09:0${line}:00Z`, meaning: 'recorded' }, author,
  place: { container, at: [line, 1, 1] },
  chat: { provider: 'claude-code', sessionId: 's1', role: author === 'agent' ? 'assistant' : 'user' },
  ...(rank === undefined ? { poolOnly: true as const } : { searchRanks: [rank] }),
});
const session = [piece(1, 'person', 'Which database should we use?', 0), piece(2, 'agent', 'Shall I go with Postgres?', 1),
  piece(3, 'person', "Let's do it", 2), piece(4, 'agent', 'Done: Postgres it is.', 3)];
const keys = ROLE_QUESTION.options.map(([key]) => key);
/** Rates every part 0.9, and answers the role Choice from the text: a
 *  question is a proposal, "Let's" an approval, anything else a decision. */
const recording = () => {
  const batches: PickBatch[] = [];
  const decide: PickDecide = async (batch) => {
    batches.push(batch);
    return Object.fromEntries(batch.questions.map((question) => {
      if (question.options === undefined) return [question.key, { status: 'answered', probability: 0.9 }];
      const pick = question.text.startsWith('Shall') ? 'proposal' : question.text.startsWith("Let's") ? 'approval' : 'decision';
      return [question.key, { status: 'answered', probabilities: keys.map((key) => key === pick ? 0.93 : 0.01) }];
    }));
  };
  return { batches, decide };
};

describe('what each kept part is doing', () => {
  it('asks one Choice per kept part among the eight situations, as sent', async () => {
    const { batches, decide } = recording();
    await pick([session[1]!], { task, decide, modesBySource: { chat: mode({ roles: true }) } });
    const asked = batches.flatMap((batch) => batch.questions).filter((question) => question.options !== undefined);
    expect(asked).toHaveLength(1);
    expect(jevRequest({ task, questions: asked }).questions).toEqual({
      q0: {
        type: 'choice',
        instructions: { question: 'What does this item do with the subject of the task?', item: 'items.1' },
        criteria: {
          decision: 'It states a decision, result or fact about the subject as settled',
          proposal: 'It proposes or plans something about the subject that is not yet settled',
          step: 'It reports a step of the work on the subject while the work is going on',
          question: 'It asks about the subject',
          approval: 'It agrees to or approves what came before it',
          repeat: 'It repeats or quotes something said earlier',
          tool: 'It is the output of a tool or a command',
          mention: 'It only mentions the subject in passing',
        },
      },
    });
  });

  it('records each kept part\'s role, and marks the proposal the person\'s next message approved', async () => {
    const { decide } = recording();
    const result = await pick(session, { task, decide, modesBySource: { chat: mode({ roles: true }) } });
    const entry = (line: number) => result.record.candidates.find((candidate) => candidate.id === session[line - 1]!.id)!;
    expect(entry(2).doing?.choice).toBe('proposal');
    expect(entry(2).doing?.probabilities.proposal).toBe(0.93);
    expect(entry(3).doing?.choice).toBe('approval');
    expect(entry(2).approvedBy).toBe(session[2]!.id);
    expect(entry(4).approvedBy).toBeUndefined();
    expect(result.record.levers.sources.chat!.roles).toBe(true);
  });

  it('puts the role and the approval in the state of a Choice per needed fact', async () => {
    const requests: PickListRequest[] = [];
    const list: PickListDecide = async (request) => {
      requests.push(request);
      return { pick: { status: 'answered', probabilities: Object.fromEntries(request.items.map(([key], index) => [key, index === 0 ? 1 : 0])) },
        any: { status: 'answered', probability: 0.1 } };
    };
    const { decide } = recording();
    await pick(session, { task, decide: Object.assign(decide, { list }), needed: ['which database'],
      modesBySource: { chat: mode({ roles: true, choicePerFact: true }) } });
    const proposal = requests[0]!.items.find(([, item]) => item.id === session[1]!.id)![1];
    expect(proposal.facts).toEqual({ doing: 'proposal', approved_by: session[2]!.id });
  });

  it('leaves every request and the record as they were when off', async () => {
    const plain = recording();
    const before = await pick(session, { task, decide: plain.decide, modesBySource: { chat: mode() } });
    const off = recording();
    const after = await pick(session, { task, decide: off.decide, modesBySource: { chat: mode({ roles: false }) } });
    expect(off.batches).toEqual(plain.batches);
    expect(after.record.candidates).toEqual(before.record.candidates);
  });
});

describe('a per-item Choice, as jev() posts it', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads its probabilities in the options\' order', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json({ answers: {
      q0: { type: 'choice', choice: 'approval', confidence: 0.8, probabilities: { approval: 0.9, decision: 0.1 } } } })));
    const answers = await jev({ apiKey: 'test-key' })({ task, questions: [{ key: 'k', sourceId: 'chat', id: 'a', role: 'reference',
      title: 'a', text: "Let's do it", question: 'Which?', options: [['decision', 'Settled'], ['approval', 'Agrees']] }] },
    new AbortController().signal);
    expect(answers).toEqual({ k: { status: 'answered', probabilities: [0.1, 0.9] } });
  });
});
