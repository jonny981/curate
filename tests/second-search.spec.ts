import { describe, expect, it } from 'vitest';
import { conversationRead, type CandidateReadRequest, type CandidateSource, type MemoryCandidate, type PickCascade, type PickDecide } from '@curatejs/core';
// @ts-expect-error The standalone JavaScript command has no type declarations.
import { pickFullSources, rareLines, searchAgain, searchSource } from '../skills/curate/run.mjs';

describe('the second search\'s lines', () => {
  const part = (text: string) => ({ text });
  it('takes each seed\'s rarest words that the task does not use, rarest first', () => {
    // 400 parts: a word is rare in 2 of them (0.5% of 400 is 2).
    const parts = [part('zanzibar quokka 2026-11-13 alpha'), part('zanzibar quokka 2026-11-13 kiwi'),
      ...Array.from({ length: 398 }, (_, index) => part(`common filler ${index}`))];
    // 'quokka' is in the task, 'kiwi' and 'alpha' are short of five
    // letters or in one part only, 'common' is in every part.
    expect(rareLines('Where is the quokka?', ['zanzibar quokka 2026-11-13 alpha common'], parts))
      .toEqual(['2026-11-13 zanzibar']);
    // At most eight words a line, rarer words first, then alphabetical.
    const many = Array.from({ length: 10 }, (_, index) => `wordy${String.fromCharCode(97 + index)}`);
    const twice = [part(many.join(' ')), part(many.join(' ')), part('wordyz'), part('wordyz'), part('wordyz')];
    expect(rareLines('task', [`${many.join(' ')} wordyz`], [...twice, ...Array.from({ length: 995 }, () => part('x'))]))
      .toEqual([many.slice(0, 8).join(' ')]);
    // A seed with no rare word gives no line.
    expect(rareLines('task', ['common filler'], parts)).toEqual([]);
  });
});

type Author = 'person' | 'agent';
const task = 'Which database did we choose?';
/** The chat reader's part id: the transcript file, then line, block and piece. */
const idOf = (session: string, line: number) => `claude-code:/home/me/.claude/projects:app/${session}.jsonl:${line}:1:1`;
const part = (session: string, line: number, author: Author, text: string, minute: number): MemoryCandidate => ({
  sourceId: 'agents', role: 'reference', id: idOf(session, line), title: `claude-code ${session}`, text,
  date: { value: new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString(), meaning: 'recorded' },
  author, place: { container: `claude-code:/home/me/.claude/projects:app/${session}.jsonl`, at: [line, 1, 1] },
  chat: { provider: 'claude-code', sessionId: session, role: author === 'person' ? 'user' : 'assistant' },
  signals: {},
});
// A set that marks its source as agent transcripts, as the agent set
// does, with a `person` weight.
const agentSet: PickCascade = { bias: 0, person: 4.5,
  questions: [{ key: 'relevant', instructions: 'relevant?', true: 'Yes', false: 'No', weight: 1 }] };

describe('the second search on coding-agent transcripts', () => {
  it('reads round two\'s order after the chat read stopped in round one, and keeps what only round two reached', async () => {
    // 230 two-part sessions: the person asks about the database, a cold
    // reply follows. Only the first person part is warm, and only it and
    // one agent part in a session no search reaches name 'zanzibar'. Every
    // other word is in every part or in one part only.
    const tag = (index: number) => String.fromCharCode(97 + Math.floor(index / 26), 97 + (index % 26));
    const parts = Array.from({ length: 230 }, (_, index) => [
      part(`s${index}`, 1, 'person', index === 0 ? 'database database zanzibar' : `database choice p${tag(index)}`, 1000 + index),
      part(`s${index}`, 2, 'agent', `reply r${tag(index)}`, 1000 + index),
    ]).flat();
    const answer = part('late', 1, 'agent', 'zanzibar holds the stored records', 10);
    const all = [...parts, answer];
    const words = (text: string) => text.toLowerCase().match(/[a-z]+/g) ?? [];
    const source: CandidateSource = { id: 'agents', kind: 'chat', role: 'reference',
      mode: { name: 'agent-transcripts', questions: agentSet, read: conversationRead() },
      async read(request: CandidateReadRequest) {
        const asked = new Set(words(request.task));
        const scored = all.map((candidate) => ({ ...candidate,
          signals: { keyword: words(candidate.text).filter((word) => asked.has(word)).length } }));
        return { status: 'read', complete: true, candidates: request.wholeLanes === true ? scored
          : scored.filter((candidate) => candidate.signals.keyword > 0) };
      } };
    const ratings = new Map([[idOf('s0', 1), 0.9], [answer.id, 0.8]]);
    const asked: string[][] = [];
    const decide: PickDecide = async ({ questions }) => {
      asked.push(questions.map((question) => question.id));
      return Object.fromEntries(questions.map((question) =>
        [question.key, { status: 'answered', probability: ratings.get(question.id) ?? 0.00001 }]));
    };
    const store = new Map<string, unknown>();
    const cache = { deciderId: 'test', store: {
      get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => { store.set(key, value); } } };
    const pickWith = (searches: unknown, lines: number) => pickFullSources(
      [searchSource(source, { chat: searches }, [], '/nonexistent', { readAudit: false })],
      { task, searchLines: Array.from({ length: lines }, (_, i) => `curate-search:${i}`) }, { task, decide, cache });

    const first = await pickWith({ keywords: [], answers: [] }, 0);
    const roundOne = new Set(asked.flat());
    const requestsBefore = asked.length;
    // The chat read's stop fired in round one, before it reached the
    // agent part no search held.
    expect(first.record.pick.chatRead.ended).toBe('fall');
    expect(first.record.candidates.find((entry: { id: string }) => entry.id === answer.id)?.status).toBe('unassessed');

    const again = await searchAgain(task, first, new Set(['agents']), (lines: { keywords: string[]; answers: string[] }) =>
      pickWith(lines, lines.keywords.length + lines.answers.length));
    expect(again.lines).toEqual({ keywords: ['zanzibar', task], answers: ['zanzibar', task, task, task] });
    expect(again.seeds[0]).toMatchObject({ id: idOf('s0', 1) });
    // Round two's chat read started again on round two's order: it rated
    // the agent part the new line ranks first, and asked about no part
    // round one had rated.
    const roundTwo = asked.slice(requestsBefore).flat();
    expect(roundTwo).toContain(answer.id);
    expect(roundTwo.filter((id) => roundOne.has(id))).toEqual([]);
    expect(again.record.cache.reused).toBeGreaterThan(0);
    // The kept part joins round one's selection, with its own entry.
    expect(again.added).toBe(1);
    expect(again.picked.selected.map((candidate: MemoryCandidate) => candidate.id)).toContain(answer.id);
    expect(again.picked.record.candidates.filter((entry: { id: string }) => entry.id === answer.id))
      .toEqual([expect.objectContaining({ status: 'selected' })]);
  });

  it('runs no second pick when round one\'s warmest parts hold no rare word', async () => {
    const first = { selected: [], reads: [{ status: 'read', candidates: [part('a', 1, 'person', 'database', 1)] }],
      record: { candidates: [{ sourceId: 'agents', id: idOf('a', 1), status: 'selected', probability: 0.9 }] } };
    let called = false;
    const again = await searchAgain(task, first, new Set(['agents']), async () => { called = true; });
    expect(called).toBe(false);
    expect(again).toEqual({ picked: first });
  });
});
