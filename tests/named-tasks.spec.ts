import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chatSettings, PERSONAL_CHAT_WRITTEN_CASCADE } from '@curatejs/chat';
import {
  historySource, pickFromSources, type CandidateSource, type MemoryCandidate, type PickAnswer, type PickBatch,
  type PickCascade, type PickCriterion, type PickDecide, type PickQuestion,
} from '@curatejs/core';
import { phraseCount } from '@curatejs/core/internal';
import { sha256 } from './fixtures/bars-and-batches.js';
import { namedTask, offRuns, routedPrompt } from './fixtures/named-tasks.js';
import { decide, fixtureSource, parts } from './fixtures/source-settings.js';

let cache: string;
beforeEach(() => { cache = mkdtempSync(join(tmpdir(), 'curate-named-tasks-')); vi.stubEnv('XDG_CACHE_HOME', cache); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(cache, { recursive: true, force: true }); });

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const logit = (p: number) => Math.log(p / (1 - p));
const clamped = (p: number) => logit(Math.min(Math.max(p, 1e-4), 1 - 1e-4));

/** A decide that keeps every request and answers each question with `answer`. */
function recording(answer: (q: PickQuestion) => number) {
  const requests: PickBatch[] = [];
  const how: PickDecide = Object.assign(async (batch: PickBatch) => {
    requests.push(batch);
    return Object.fromEntries(batch.questions.map((q): [string, PickAnswer] =>
      [q.key, { status: 'answered', probability: answer(q) }]));
  }, { deciderId: 'fixture' });
  return { requests, how };
}

describe('a name lane brings in a part the search missed', () => {
  const task = 'When did I join Book Lovers Unite?';
  const club: MemoryCandidate = { sourceId: 'chat', id: 'chat#400', title: 'chat part 400', role: 'reference',
    text: 'I joined Book Lovers Unite on a Tuesday', signals: { keyword: 0 } };
  /** The fixture's chat reader, answering a phrase read with the parts that hold its phrase. */
  const source = (names: boolean): CandidateSource => {
    const pool = [...parts('chat', 'chatword'), club];
    const reader = fixtureSource('chat', pool, { rare: false });
    return historySource({ ...chatSettings, labels: false, names, reader: { ...reader,
      read: async (request, context) => request.phraseLane === true
        ? { status: 'read', complete: true, candidates: pool.filter((c) => phraseCount(c.text, request.task) > 0) }
        : reader.read(request, context) } });
  };
  // The fixture's answers, except that every question about the club's part is answered yes.
  const keepClub: PickDecide = Object.assign(async (batch: PickBatch, signal: AbortSignal) => ({
    ...await decide(batch, signal),
    ...Object.fromEntries(batch.questions.filter((q) => q.id === club.id)
      .map((q): [string, PickAnswer] => [q.key, { status: 'answered', probability: 0.99 }])),
  }), { deciderId: 'fixture' });

  it('decides the part with names on, and credits the name lane', async () => {
    const picked = await pickFromSources([source(true)], { task }, { task, decide: keepClub });
    expect(picked.record.candidates.find((c) => c.id === club.id)).toMatchObject({ status: 'selected', asked: true });
    expect(picked.record.names).toEqual({ found: ['Book Lovers Unite'], by: 'code' });
    const read = picked.reads[0]!;
    expect(read.status === 'read' ? read.lanes : []).toContainEqual({ task: 'Book Lovers Unite', lane: 'name', read: 1, kept: 1 });
    expect(picked.record.effects.find((e) => e.setting === 'names')).toMatchObject({ source: 'chat', actedOn: 1, added: 1 });
  });

  it('never decides it with names off', async () => {
    const picked = await pickFromSources([source(false)], { task }, { task, decide: keepClub });
    expect(picked.record.candidates.find((c) => c.id === club.id)).toBeUndefined();
    expect(picked.record).not.toHaveProperty('names');
    expect(picked.record.effects.find((e) => e.setting === 'names')).toBeUndefined();
  });

  it('asks a caller\'s findNames once and searches what it returns', async () => {
    const findNames = vi.fn(async () => ['book lovers unite']);
    const picked = await pickFromSources([source(true)], { task: 'When did I join the club?' },
      { task: 'When did I join the club?', decide: keepClub, findNames });
    expect(findNames).toHaveBeenCalledTimes(1);
    expect(picked.record.names).toEqual({ found: ['book lovers unite'], by: 'caller' });
    expect(picked.record.candidates.find((c) => c.id === club.id)).toMatchObject({ status: 'selected' });
  });

  it('records the names when every source with name lanes on is absent', async () => {
    const absent = historySource({ ...chatSettings, labels: false, names: true, reader: {
      ...fixtureSource('chat', [], { rare: false }), read: async () => ({ status: 'absent', reason: 'no history' }) } });
    const picked = await pickFromSources([absent], { task }, { task, decide: keepClub });
    expect(picked.reads[0]!.status).toBe('absent');
    expect(picked.record.names).toEqual({ found: ['Book Lovers Unite'], by: 'code' });
  });

  it('gives a source whose read matched nothing a names entry with zero counts', async () => {
    const empty = historySource({ ...chatSettings, labels: false, names: true, reader: {
      ...fixtureSource('chat', [], { rare: false }), read: async () => ({ status: 'read', complete: true, candidates: [] }) } });
    const picked = await pickFromSources([empty], { task }, { task, decide: keepClub });
    expect(picked.record.effects.filter((e) => e.setting === 'names')).toEqual([{ setting: 'names', source: 'chat',
      actedOn: 0, added: 0, dropped: 0, summary: 'names on chat: the lanes held no part, so they added none. It added no part.' }]);
  });
});

describe('the name term moves a score', () => {
  const task = 'Who graduated first among Emma, Rachel and Alex?';
  const NAME_ANSWERS: Readonly<Record<string, number>> = { Emma: 0.8, Rachel: 0.3, Alex: 0.1 };
  const WRITTEN: readonly PickCriterion[] = [
    { key: 'a', instructions: 'Does this part name a graduation?', true: 'It does', false: 'It does not' },
    { key: 'b', instructions: 'Does this part give a date?', true: 'It does', false: 'It does not' },
  ];
  // Part 0 answers personal_fact inside the set's band, part 1 below it.
  const pool: MemoryCandidate[] = [0, 1].map((i) => ({ sourceId: 'chat', id: `chat#${i}`, title: `chat part ${i}`,
    role: 'reference', text: `Emma graduated in May, part ${i}`, signals: { keyword: 1 - i / 10 } }));
  const nameOf = (q: PickQuestion) => Object.keys(NAME_ANSWERS).find((name) => q.question === `Does this part mention ${name}?`);
  const answer = (q: PickQuestion) => {
    const name = nameOf(q);
    if (name !== undefined) return NAME_ANSWERS[name]!;
    if (q.questionKey === 'personal_fact') return q.id === 'chat#0' ? 0.5 : 0.05;
    return 0.2 + ((q.questionKey?.length ?? 0) % 5) / 10;
  };
  const run = async (questions: PickCascade, on: string) => {
    const { requests, how } = recording(answer);
    const source = historySource({ reader: fixtureSource('chat', pool, { rare: false }), ...chatSettings,
      labels: false, names: false, questions });
    const picked = await pickFromSources([source], { task: on }, { task: on, decide: how, writeQuestions: async () => WRITTEN });
    const score = (id: string) => (picked.record.candidates.find((c) => c.id === id) as { probability: number }).probability;
    return { picked, requests, score };
  };
  const { named, ...without } = PERSONAL_CHAT_WRITTEN_CASCADE;

  it('adds highest × logit(the best name answer) + hasNames to the logit', async () => {
    expect(named).toBeDefined();
    const plain = await run(without, task);
    const { picked, requests, score } = await run(PERSONAL_CHAT_WRITTEN_CASCADE, task);
    expect(logit(score('chat#0'))).toBeCloseTo(logit(plain.score('chat#0')) + named!.highest * clamped(0.8) + named!.hasNames, 10);
    expect(score('chat#1')).toBe(plain.score('chat#1'));
    // Asked once per name, of the part inside the band only, in the request with the set's other questions.
    const asked = requests.flatMap((r) => r.questions).filter((q) => nameOf(q) !== undefined);
    expect(asked.map((q) => [q.id, nameOf(q)])).toEqual([['chat#0', 'Emma'], ['chat#0', 'Rachel'], ['chat#0', 'Alex']]);
    const request = requests.find((r) => r.questions.some((q) => nameOf(q) !== undefined))!;
    expect(request.questions.some((q) => q.questionKey === 'needed')).toBe(true);
    expect(asked[0]).toMatchObject({ trueCriterion: 'The part names Emma, or refers to it in a way that can only mean Emma',
      falseCriterion: 'The part does not name Emma or clearly refer to it, even if it is about the same topic' });
    expect(picked.record.names).toEqual({ found: ['Emma', 'Rachel', 'Alex'], by: 'code' });
    expect(picked.record.effects.find((e) => e.setting === 'named')).toMatchObject({ source: 'chat', actedOn: 1 });
  });

  it('asks no name question on a task with no names, and the score is unchanged', async () => {
    const on = 'Which graduation came first?';
    const plain = await run(without, on);
    const { requests, score } = await run(PERSONAL_CHAT_WRITTEN_CASCADE, on);
    expect(requests.flatMap((r) => r.questions).filter((q) => q.question.startsWith('Does this part mention'))).toEqual([]);
    expect(score('chat#0')).toBe(plain.score('chat#0'));
  });
});

interface Baseline {
  readonly runs: Awaited<ReturnType<typeof offRuns>>;
  readonly routedPrompt: string;
}
const baseline: Baseline = JSON.parse(readFileSync(join(__dirname, 'fixtures/named-tasks-baseline.json'), 'utf8'));

describe('names off changes nothing', () => {
  it('picks, decide requests and curator prompts match the build before name lanes', async () => {
    expect(await offRuns(Object.keys(baseline.runs))).toEqual(baseline.runs);
    expect(Object.keys(baseline.runs)).toContain(namedTask);
  });

  it('a routeByTask curator prompt on a task once tagged changed is the same', async () => {
    expect(sha256(await routedPrompt('What is my current address?'))).toBe(baseline.routedPrompt);
  });
});
