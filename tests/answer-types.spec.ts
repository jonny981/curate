import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chatSettings } from '@curatejs/chat';
import { GIT_HISTORY_CASCADE, gitSettings } from '@curatejs/git';
import { markdownSettings } from '@curatejs/markdown';
import {
  curate, historySource, LABEL_LANE_BAR, type AnswerType, memory, pickFromSources, type CandidateSource, type CuratePrompt, type CurateWrite,
  type LabelKind, type MemoryCandidate, type PickAnswer, type PickBatch, type PickCascade, type PickDecide, type PickQuestion,
  type PickRecord, type PickResult,
} from '@curatejs/core';
import { decide, fixtureSource, parts, task } from './fixtures/source-settings.js';

const BASELINE = join(__dirname, 'fixtures/answer-types-baseline.json');

let cache: string;
beforeEach(() => { cache = mkdtempSync(join(tmpdir(), 'curate-answer-types-')); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(cache, { recursive: true, force: true }); });

/** A fresh label store for each run. */
let runs = 0;
const freshStore = () => vi.stubEnv('XDG_CACHE_HOME', join(cache, `run-${runs += 1}`));

/** The fixture's decide, keeping every request it was sent. */
function recording(how: PickDecide = decide) {
  const requests: PickBatch[] = [];
  const recorded: PickDecide = Object.assign(async (batch: PickBatch, signal: AbortSignal) => {
    requests.push(batch);
    return how(batch, signal);
  }, { deciderId: 'fixture' });
  return { requests, decide: recorded };
}

/** A writer that keeps each prompt and returns one valid log line. */
function writer() {
  const prompts: CuratePrompt[] = [];
  const write: CurateWrite = async (prompt) => {
    prompts.push(prompt);
    return '[2026-01-08] The billing deploy waits for the queue to drain (said 2026-01-08; E1)';
  };
  return { prompts, write };
}

const chat = (labels: boolean) =>
  historySource({ reader: fixtureSource('chat', parts('chat', 'chatword'), { rare: false }), ...chatSettings, labels });
const git = () => historySource({ reader: fixtureSource('git', parts('git', 'gitword'), { rare: true }), ...gitSettings });
const markdown = () =>
  historySource({ reader: fixtureSource('markdown', parts('markdown', 'noteword'), { rare: false }), ...markdownSettings });

const RUNS: Readonly<Record<string, () => CandidateSource[]>> = {
  'defaults chat': () => [chat(false)],
  'defaults git': () => [git()],
  'defaults markdown': () => [markdown()],
  'defaults all': () => [chat(false), git(), markdown()],
  'chat labels': () => [chat(true)],
  'chat labels all': () => [chat(true), git(), markdown()],
};

// The picks and curator prompts the build before answer types made on this fixture, one fresh label store per
// run: each run's selected ids in order and the SHA-256 of its canonical `JSON.stringify([selected, record,
// requests])`, the whole record with its effects and every decide request; and the SHA-256 of the curator's
// prompts for `defaults all`.
interface Baseline {
  readonly runs: Readonly<Record<string, { readonly selected: readonly string[]; readonly sha256: string }>>;
  readonly prompts: string;
}
const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const baseline = (): Baseline => JSON.parse(readFileSync(BASELINE, 'utf8'));
/** The record as the baseline build wrote it: without each source's `labelBar` and the bar the labels
 *  summary names, which the label bar setting added, without the names the presets' name lanes
 *  looked for and their `names` entries, which the name lanes added, and without the moment, the
 *  time zone and the task-period entries, which the task date added. */
const asBaseline = ({ names: _names, asOf: _asOf, timeZone: _timeZone, ...record }: PickRecord): PickRecord => ({ ...record,
  levers: { ...record.levers, sources: Object.fromEntries(Object.entries(record.levers.sources)
    .map(([id, { labelBar: _labelBar, ...settings }]) => [id, settings])) },
  effects: record.effects.filter((entry) => entry.setting !== 'names' && entry.setting !== 'taskPeriod').map((entry) => entry.setting !== 'labels' ? entry
    : { ...entry, summary: entry.summary.replace(` at the label bar ${LABEL_LANE_BAR}:`, ':') }) });

async function snapshot(): Promise<Baseline> {
  const runs: Record<string, Baseline['runs'][string]> = {};
  let prompts = '';
  for (const [name, sources] of Object.entries(RUNS)) {
    freshStore();
    const { requests, decide: how } = recording();
    const picked = await pickFromSources(sources(), { task }, { task, decide: how });
    const selected = picked.selected.map((c) => c.id);
    runs[name] = { selected, sha256: sha256([selected, asBaseline(picked.record), requests]) };
    if (name === 'defaults all') {
      const curator = writer();
      await curate(task, picked, { write: curator.write });
      prompts = sha256(curator.prompts);
    }
  }
  return { runs, prompts };
}

describe('with answerTypes and answerHint off and no typed questions', () => {
  it('every pick and the curator prompts equal the baseline byte for byte', async () => {
    expect(await snapshot()).toEqual(baseline());
  });
});

// The ten answer types as the decide request must word them: key, question, true criterion, false criterion.
const TYPES = [
  ['date', 'Is the answer a point in time?',
    'The answer names when something happened or will happen: a calendar date, a day of the week, a month, a year or a time of day.',
    'The answer is not a point in time.'],
  ['duration', 'Is the answer a length of time?',
    'The answer is how long something lasted or took, or how much time passed between two events or since an event (days, weeks, months, years).',
    'The answer is not a length of time.'],
  ['order', 'Does the answer depend on the order of two or more events?',
    'The question asks which happened first, last, before or after, or asks for events in sequence.',
    'The question does not ask about the order of events.'],
  ['number', 'Is the answer a number?',
    'The answer is a number: a quantity, a count, an amount of money, a measurement, an age, a score or a percentage.',
    'The answer is not a number.'],
  ['entity', 'Is the answer a specific named thing?',
    'The answer is a particular person, place, product, brand, organisation, pet, or title of a book, film, show or song.',
    'The answer is not a particular named person, place, product or title.'],
  ['yesno', 'Can the question be answered with yes or no?',
    'The question asks whether something is true, happened or holds, so a yes or a no answers it.',
    'A yes or a no does not answer the question.'],
  ['list', 'Does the answer need every instance of something gathered?',
    'The answer is a count of items or events, or a complete list of them, so every instance must be found.',
    'The answer does not need instances counted or listed.'],
  ['advice', 'Does the question ask for a recommendation, a suggestion or an opinion?',
    'The user asks what they should do, choose, try or think, rather than asking for a fact from their past.',
    'The user asks for a fact, not for a recommendation or an opinion.'],
  ['preference', "Does the answer depend on the user's own preferences?",
    "The user's stated likes, dislikes, tastes, wants or limits shape what a good answer is.",
    "The user's preferences do not shape the answer."],
  ['latest', 'Does the question ask for the current or most recent value of something that can change?',
    'The answer is the most recent value or state of something that may have changed over time; an earlier value would be out of date.',
    'The question does not ask for a current or latest value.'],
] as const;
const TYPE_KEYS: readonly string[] = TYPES.map(([key]) => key);

/** True for a question the pick asks about the task itself rather than a part. */
const aboutTask = (q: PickQuestion) => q.sourceId === 'labels';
const isAnswerType = (q: PickQuestion) => aboutTask(q) && TYPE_KEYS.includes(q.questionKey ?? '')
  && JSON.parse(q.key).includes('answerType');

/** The fixture's decide, answering each answer type at the given probability (0.1 when not given), and any
 *  part question `parts` names at its value. */
function typed(types: Readonly<Record<string, number>>,
  parts: (q: PickQuestion) => number | undefined = () => undefined): PickDecide {
  return Object.assign(async (batch: PickBatch, signal: AbortSignal) => {
    const answers: Record<string, PickAnswer> = await decide(batch, signal);
    for (const q of batch.questions) {
      const p = isAnswerType(q) ? types[q.questionKey!] ?? 0.1 : parts(q);
      if (p !== undefined) answers[q.key] = { status: 'answered', probability: p };
    }
    return answers;
  }, { deciderId: 'fixture' });
}

const taskRequests = (requests: readonly PickBatch[]) => requests.filter((r) => r.questions.some(aboutTask));

describe('answerTypes asks the ten types in one request', () => {
  it('sends exactly one request about the task, holding the ten questions', async () => {
    freshStore();
    const { requests, decide: how } = recording(typed({}));
    await pickFromSources([git()], { task }, { task, decide: how, answerTypes: true });
    const about = taskRequests(requests);
    expect(about).toHaveLength(1);
    expect(about[0]!.questions.map((q) => [q.questionKey, q.question, q.trueCriterion, q.falseCriterion]))
      .toEqual(TYPES.map((type) => [...type]));
  });

  it('records the types answered at 0.5 or more, in order', async () => {
    freshStore();
    const { decide: how } = recording(typed({ number: 0.5, date: 0.9, entity: 0.49 }));
    const picked = await pickFromSources([git()], { task }, { task, decide: how, answerTypes: true });
    const record = picked.record.answerTypes;
    expect(record?.bar).toBe(0.5);
    expect(record?.needed).toEqual(['date', 'number']);
    expect(record?.answers).toHaveLength(10);
  });

  it('rides in the label request about the task, with no second task request', async () => {
    freshStore();
    const { requests, decide: how } = recording(typed({ date: 0.9 }));
    await pickFromSources([chat(true)], { task }, { task, decide: how, answerTypes: true });
    const about = taskRequests(requests);
    expect(about).toHaveLength(1);
    const asked = about[0]!.questions;
    expect(asked.filter(isAnswerType).map((q) => q.questionKey)).toEqual(TYPE_KEYS);
    expect(asked.filter((q) => !isAnswerType(q)).length).toBeGreaterThan(0);
  });

  it('adds no task request when two label sets each send one, and rides in the first', async () => {
    const constraint: readonly LabelKind[] = [{ key: 'constraint', name: 'a constraint',
      part: { true: 'The excerpt states a constraint.', false: 'The excerpt states no constraint.' } }];
    const sources = () => [chat(true), historySource({
      reader: fixtureSource('markdown', parts('markdown', 'noteword'), { rare: false }), ...markdownSettings, labels: constraint })];
    const about = async (answerTypes: boolean) => {
      freshStore();
      const { requests, decide: how } = recording(typed({}));
      await pickFromSources(sources(), { task }, { task, decide: how, answerTypes });
      return taskRequests(requests);
    };
    const off = await about(false);
    const on = await about(true);
    expect(off).toHaveLength(2);
    expect(on).toHaveLength(off.length);
    expect(on.map((r) => r.questions.filter(isAnswerType).map((q) => q.questionKey))).toEqual([TYPE_KEYS, []]);
  });
});

/** The git set plus one typed question about when a decision was made. */
const DATED: PickCascade = {
  ...GIT_HISTORY_CASCADE,
  typed: [{ answerType: 'date', key: 'when-decided', instructions: 'Does this commit say when this was decided?',
    true: 'It gives the date or time of the decision', false: 'It gives no date for the decision', weight: 1 }],
};
const datedGit = () =>
  historySource({ reader: fixtureSource('git', parts('git', 'gitword'), { rare: true }), ...gitSettings, questions: DATED });

describe('a typed question is asked only when the task needs its type', () => {
  const run = async (date: number) => {
    freshStore();
    const { requests, decide: how } = recording(typed({ date }));
    const picked = await pickFromSources([datedGit(), chat(false)], { task }, { task, decide: how, answerTypes: true });
    const asked = requests.flatMap((r) => r.questions).filter((q) => !aboutTask(q));
    return { picked, asked };
  };

  it('asks every git part asked its set, and no chat part, when the task needs a date', async () => {
    const { asked } = await run(0.9);
    const setAsked = new Set(asked.filter((q) => q.sourceId === 'git' && q.questionKey === 'current').map((q) => q.id));
    const typedAsked = new Set(asked.filter((q) => q.questionKey === 'when-decided').map((q) => q.id));
    expect(setAsked.size).toBeGreaterThan(0);
    expect(typedAsked).toEqual(setAsked);
    expect(asked.filter((q) => q.questionKey === 'when-decided' && q.sourceId !== 'git')).toEqual([]);
  });

  it('asks no part when the task needs no date, and says why', async () => {
    const { picked, asked } = await run(0.1);
    expect(asked.filter((q) => q.questionKey === 'when-decided')).toEqual([]);
    expect(picked.record.effects.find((e) => e.setting === 'typed' && e.source === 'git')?.summary).toBe(
      'typed on git: the task needed none of its answer types, so no typed question was asked. '
      + 'It added no part and kept out no part.');
  });

  it('records the typed entry for a source that returned no part', async () => {
    const empty = () =>
      historySource({ reader: fixtureSource('git', [], { rare: true }), ...gitSettings, questions: DATED });
    const effect = async (date: number) => {
      freshStore();
      const picked = await pickFromSources([empty(), chat(false)], { task }, { task, decide: typed({ date }), answerTypes: true });
      return picked.record.effects.filter((e) => e.setting === 'typed');
    };
    expect(await effect(0.9)).toEqual([{ setting: 'typed', source: 'git', actedOn: 0, added: 0, dropped: 0,
      summary: 'typed on git: 0 parts were asked typed questions, but no part crossed the bar because of them. '
        + 'It added no part and kept out no part.' }]);
    expect((await effect(0.1)).map((e) => e.summary)).toEqual([
      'typed on git: the task needed none of its answer types, so no typed question was asked. '
      + 'It added no part and kept out no part.']);
  });
});

describe('a typed answer moves a part across its bar', () => {
  it('keeps a part just below the bar and drops one just above it', async () => {
    // One question at bias logit(bar): a part's answer of sigmoid(-0.1) leaves it just below the bar, sigmoid(0.1)
    // just above; the typed answer then adds about +2.94 (0.95) or -2.94 (0.05).
    const bar = gitSettings.bar;
    const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
    const ONE: PickCascade = {
      bias: Math.log(bar / (1 - bar)),
      questions: [{ key: 'about', instructions: 'Is this commit about the task?', true: 'It is', false: 'It is not', weight: 1 }],
      typed: DATED.typed,
    };
    const pool: MemoryCandidate[] = ['below', 'above'].map((name, i) => ({ sourceId: 'git', id: `git#${name}`,
      title: name, role: 'reference', text: `deploy billing ${name}`, signals: { keyword: 1 - i / 10 } }));
    const source = historySource({ reader: fixtureSource('git', pool, { rare: false }), ...gitSettings, rare: false, questions: ONE });
    const answer = (q: PickQuestion) => q.questionKey === 'about' ? sigmoid(q.id === 'git#below' ? -0.1 : 0.1)
      : q.questionKey === 'when-decided' ? (q.id === 'git#below' ? 0.95 : 0.05) : undefined;
    freshStore();
    const picked = await pickFromSources([source], { task }, { task, decide: typed({ date: 0.9 }, answer), answerTypes: true });
    const status = Object.fromEntries(picked.record.candidates.map((c) => [c.id, c.status]));
    expect(status).toEqual({ 'git#below': 'selected', 'git#above': 'rejected' });
    const effect = picked.record.effects.find((e) => e.setting === 'typed' && e.source === 'git');
    expect(effect).toMatchObject({ actedOn: 2, added: 1, dropped: 1 });
  });
});

/** The `defaults all` pick, with an answerTypes record whose needed types are given. */
async function allPick(needed: readonly AnswerType[]): Promise<PickResult> {
  freshStore();
  const picked = await pickFromSources(RUNS['defaults all']!(), { task }, { task, decide });
  return { ...picked, record: { ...picked.record, answerTypes: { bar: 0.5, answers: [], needed } } };
}
const HINT = 'The answer likely needs: a date, a number.';

describe('answerHint adds one line to the curator\'s task', () => {
  it('adds the needed types under the task line', async () => {
    const curator = writer();
    await curate(task, await allPick(['date', 'number']), { write: curator.write, answerHint: true });
    expect(curator.prompts.length).toBeGreaterThan(0);
    for (const prompt of curator.prompts) expect(prompt.body).toContain(`TASK:\n${task}\n${HINT}\n\nEVIDENCE:`);
    const without = curator.prompts.map((prompt) => ({ ...prompt, body: prompt.body.replace(`\n${HINT}\n`, '\n') }));
    expect(sha256(without), 'with the hint line taken out, the prompts differ from the baseline').toBe(baseline().prompts);
  });

  it('adds nothing when no type cleared the bar, and says so', async () => {
    const curator = writer();
    const result = await curate(task, await allPick([]), { write: curator.write, answerHint: true });
    expect(sha256(curator.prompts)).toBe(baseline().prompts);
    expect(result.record.effects.find((e) => e.setting === 'answerHint')?.summary).toBe(
      'answerHint: no answer type cleared the bar, so the curator\'s task carried no hint and it added no line.');
  });

  it('reaches the curator through memory()', async () => {
    freshStore();
    const curator = writer();
    await memory({ sources: [git()], decide: typed({ date: 0.9 }), write: curator.write,
      pick: { answerTypes: true }, curate: { answerHint: true } }).recall(task);
    expect(curator.prompts[0]!.body).toContain(`TASK:\n${task}\nThe answer likely needs: a date.\n\nEVIDENCE:`);
  });
});

describe('settings that would sit unread throw', () => {
  it('typed questions with answerTypes off throw before any read', async () => {
    const read = vi.fn(datedGit().read);
    const source: CandidateSource = { ...datedGit(), read };
    const call = () => pickFromSources([source], { task }, { task, decide });
    await expect(call()).rejects.toThrow(TypeError);
    await expect(call()).rejects.toThrow(
      "git's questions include typed questions, which are asked only when answerTypes is on.");
    expect(read).not.toHaveBeenCalled();
  });

  it('a typed question needs a unique key, a finite weight and a known answer type', () => {
    const [question] = DATED.typed!;
    for (const typed of [[{ ...question!, key: 'current' }], [{ ...question!, weight: Number.NaN }],
      [{ ...question!, answerType: 'colour' }]]) {
      expect(() => historySource({ reader: fixtureSource('git', [], { rare: false }), ...gitSettings,
        questions: { ...GIT_HISTORY_CASCADE, typed } as PickCascade }))
        .toThrow('a question set\'s typed questions need keys unique across questions and typed, '
          + 'finite weights and a known answerType.');
    }
  });

  it('answerHint without the pick\'s answer types throws', async () => {
    freshStore();
    const picked = await pickFromSources([git()], { task }, { task, decide });
    await expect(curate(task, picked, { write: writer().write, answerHint: true }))
      .rejects.toThrow(/^curate: answerHint needs the answer types a pick records when it runs with answerTypes on\.$/);
  });
});
