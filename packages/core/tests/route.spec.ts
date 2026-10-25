import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  curate,
  LABEL_KINDS,
  ROUTE_QUESTIONS,
  pick,
  type CuratePrompt,
  type MemoryCandidate,
  type PickBatch,
  type PickDecide,
  type PickLabels,
} from '../src/index.js';

const uncutPick = { everyRanked: true, everyScored: true, rare: false } as const;

const KIND_KEYS = new Set<string>(LABEL_KINDS.map((kind) => kind.key));
const ROUTE_KEYS = new Set<string>(ROUTE_QUESTIONS.map((route) => route.key));

const LOG = '[2023-05-13] Visited York (said 2023-05-20; notes#2)';
// The curator sees short item ids and cites them; curate() returns the log with full ids restored.
const WRITTEN = '[2023-05-13] Visited York (said 2023-05-20; E1)';

function candidate(id: string): MemoryCandidate {
  return {
    sourceId: 'notes', id, title: `Title ${id}`, text: `Text ${id}`,
    role: 'reference', signals: {},
  };
}

function threeParts(): MemoryCandidate[] {
  return [
    candidate('p1'),
    candidate('p2'),
    candidate('p3'),
  ];
}

function writer(text: string = WRITTEN): { write: (prompt: CuratePrompt) => Promise<string>; calls: CuratePrompt[] } {
  const calls: CuratePrompt[] = [];
  return {
    calls,
    write: async (prompt) => {
      calls.push(prompt);
      return text;
    },
  };
}

interface Counting {
  decide: PickDecide;
  calls: PickBatch[];
  /** Every question key in each call that carried a route question:
   *  the whole batch's keys, so a route batch mixed with other
   *  questions shows them. */
  routeCalls: (string | undefined)[][];
}

/** A stand-in decider: answers every question and records which calls
 *  carried route questions. The `probability` callback supplies the
 *  answer for each question — a decide ask has no `questionKey`, a
 *  kind ask carries its kind key and a route ask its route key. */
function counting(probability: (question: PickBatch['questions'][number]) => number): Counting {
  const calls: PickBatch[] = [];
  const routeCalls: (string | undefined)[][] = [];
  return {
    calls, routeCalls,
    decide: async (batch) => {
      calls.push(batch);
      const routes = batch.questions
        .filter((question) => question.questionKey !== undefined && ROUTE_KEYS.has(question.questionKey))
        .map((question) => question.questionKey!);
      if (routes.length) routeCalls.push(batch.questions.map((question) => question.questionKey));
      return Object.fromEntries(batch.questions.map((question) => [
        question.key,
        { status: 'answered' as const, probability: probability(question) },
      ]));
    },
  };
}

const labelOptions = (directory: string, extra: Partial<PickLabels> = {}) => ({
  everyScored: true as const,
  labels: { directory, deciderId: 'test-decider', ...extra },
  labelKindsBySource: { notes: LABEL_KINDS },
});

const directories: string[] = [];
function store(): string {
  const directory = mkdtempSync(join(tmpdir(), 'curate-route-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe('route: jev', () => {
  it('asks the four route questions once per pick, in the same request as the question\'s kind labels', async () => {
    const counter = counting(() => 0.8);
    const result = await pick(threeParts(), {
      task: 'Recall the plan', decide: counter.decide, route: 'jev', ...labelOptions(store()),
    });
    expect(counter.routeCalls).toHaveLength(1);
    const call = counter.calls.find((batch) =>
      batch.questions.some((question) => question.questionKey !== undefined && ROUTE_KEYS.has(question.questionKey)));
    const keys = new Set(call!.questions.map((question) => question.questionKey));
    expect(keys).toEqual(new Set([...KIND_KEYS, ...ROUTE_KEYS]));
    expect(result.record.route?.answers.map((answer) => answer.key))
      .toEqual(ROUTE_QUESTIONS.map((route) => route.key));
  });

  it('asks the route questions alone when labels are off or the task\'s kind labels are reused', async () => {
    // With labels off, the route questions go alone.
    const alone = counting(() => 0.8);
    const parts = threeParts();
    await pick(parts, { ...uncutPick, task: 'Recall the plan', decide: alone.decide, route: 'jev' });
    expect(alone.routeCalls).toEqual([['count', 'date', 'taste', 'latest']]);

    // With the task's label set stored, the route questions still go alone.
    const reused = counting(() => 0.8);
    const options = {
      task: 'Recall the plan', decide: reused.decide, route: 'jev' as const,
      ...labelOptions(store()),
    };
    await pick(parts, options);
    reused.routeCalls.length = 0;
    const again = await pick(parts, options);
    expect(reused.routeCalls).toEqual([['count', 'date', 'taste', 'latest']]);
    expect(again.record.route).toBeDefined();
  });

  it('keeps the task\'s route questions in one request under tight batch limits', async () => {
    // Labels off and maxPerBatch 2: the four route questions still go in one request.
    const off = counting(() => 0.8);
    await pick(threeParts(), { ...uncutPick,
      task: 'Recall the plan', decide: off.decide, route: 'jev', limits: { maxPerBatch: 2 },
    });
    expect(off.routeCalls).toEqual([['count', 'date', 'taste', 'latest']]);

    // Labels on and maxPerBatch 7: the kind labels and the route
    // questions share one request.
    const on = counting(() => 0.8);
    await pick(threeParts(), {
      task: 'Recall the plan', decide: on.decide, route: 'jev',
      limits: { maxPerBatch: 7 }, ...labelOptions(store()),
    });
    expect(on.routeCalls).toHaveLength(1);
    expect(new Set(on.routeCalls[0])).toEqual(new Set([...KIND_KEYS, ...ROUTE_KEYS]));
  });

  it.each([
    ['count', ['working'], { working: true, preferenceAdvice: false, preferenceChange: false }],
    ['date', ['working'], { working: true, preferenceAdvice: false, preferenceChange: false }],
    ['latest', ['working'], { working: true, preferenceAdvice: false, preferenceChange: false }],
    ['taste', ['preferenceAdvice', 'preferenceChange'], { working: false, preferenceAdvice: true, preferenceChange: true }],
  ] as const)('a %s answer at the bar switches exactly its options', async (key, on, expected) => {
    const picked = await pick([candidate('notes#2')], { ...uncutPick,
      task: 'Recall the plan', route: 'jev',
      decide: counting((question) =>
        question.questionKey === undefined ? 0.9 : question.questionKey === key ? 0.5 : 0.1).decide,
    });
    expect(picked.record.route?.on).toEqual(on);
    const { write, calls } = writer();
    const result = await curate('Recall the plan', picked, { write, route: 'jev' });
    expect(result.record).toMatchObject(expected);
    expect(result.record.route).toBe('jev');
    if (key === 'taste') {
      expect(calls[0]!.instructions).toContain('Advice preferences:');
      expect(calls[0]!.instructions).toContain('Changed preference:');
      expect(calls[0]!.instructions).not.toContain('Working (the curator');
    } else {
      expect(calls[0]!.instructions).toContain('number each distinct instance');
      expect(calls[0]!.instructions).not.toContain('Advice preferences:');
    }
  });

  it.each(['count', 'date', 'taste', 'latest'] as const)('a %s answer just below the bar switches nothing', async (key) => {
    const picked = await pick([candidate('notes#2')], { ...uncutPick,
      task: 'Recall the plan', route: 'jev',
      decide: counting((question) =>
        question.questionKey === undefined ? 0.9 : question.questionKey === key ? 0.49 : 0.1).decide,
    });
    expect(picked.record.route?.on).toEqual([]);
  });

  it.each([0.49, 0.5])('a taste answer of %s switches the preference lines only at the shared bar', async (probability) => {
    const picked = await pick([candidate('notes#2')], { ...uncutPick,
      task: 'Recall the plan', route: 'jev',
      decide: counting((question) =>
        question.questionKey === undefined ? 0.9 : question.questionKey === 'taste' ? probability : 0.1).decide,
    });
    expect(picked.record.route?.on.includes('preferenceAdvice')).toBe(probability >= 0.5);
  });

  it('switches nothing when every route answer is below the bar', async () => {
    const picked = await pick([candidate('notes#2')], { ...uncutPick,
      task: 'Recall the plan', route: 'jev',
      decide: counting((question) => question.questionKey === undefined ? 0.9 : 0.4).decide,
    });
    expect(picked.record.route?.on).toEqual([]);
    const result = await curate('Recall the plan', picked, { write: writer().write, route: 'jev' });
    expect(result.record).toMatchObject({ working: false, preferenceAdvice: false, preferenceChange: false });
    expect(result.log).toBe(LOG);
  });

  it('refuses route: jev and routeByTask together', async () => {
    const picked = await pick([candidate('notes#2')], { ...uncutPick,
      task: 'Recall the plan', route: 'jev', decide: counting(() => 0.9).decide,
    });
    await expect(curate('Recall the plan', picked, {
      write: writer().write, route: 'jev', routeByTask: true,
    })).rejects.toThrow(/route.*routeByTask/);
  });

  it('refuses route: jev on a pick that recorded no route answers', async () => {
    const picked = await pick([candidate('notes#2')], { ...uncutPick,
      task: 'Recall the plan', decide: counting(() => 0.9).decide,
    });
    await expect(curate('Recall the plan', picked, { write: writer().write, route: 'jev' }))
      .rejects.toThrow(/route/);
  });

  it('lets explicit curator options override the route', async () => {
    const picked = await pick([candidate('notes#2')], { ...uncutPick,
      task: 'Recall the plan', route: 'jev',
      decide: counting((question) =>
        question.questionKey === undefined ? 0.9 : question.questionKey === 'taste' ? 0.9 : 0.1).decide,
    });
    const result = await curate('Recall the plan', picked, {
      write: writer().write, route: 'jev', preferenceAdvice: false, working: true,
    });
    expect(result.record).toMatchObject({ working: true, preferenceAdvice: false, preferenceChange: true });
  });

  it('leaves the pick and the curate identical when the route option is unset', async () => {
    const counter = counting(() => 0.9);
    const parts = [candidate('notes#2')];
    const plain = await pick(parts, { ...uncutPick, task: 'Recall the plan', decide: counter.decide });
    expect(plain.record.route).toBeUndefined();
    expect(counter.routeCalls).toHaveLength(0);

    const routed = await pick(parts, { ...uncutPick,
      task: 'Recall the plan', route: 'jev', decide: counting(() => 0.9).decide,
    });
    const { route: _route, levers, ...record } = routed.record;
    expect({ ...record, asOf: plain.record.asOf, levers: { ...levers, route: false } }).toEqual(plain.record);
    expect(routed.selected).toEqual(plain.selected);

    const result = await curate('Recall the plan', plain, { write: writer().write });
    expect(result.record).not.toHaveProperty('route');
  });
});
