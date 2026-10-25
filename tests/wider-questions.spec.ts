import { describe, expect, it, vi } from 'vitest';

import { CHAT_CASCADE, chatSettings, PERSONAL_CHAT_WRITTEN_CASCADE } from '@curatejs/chat';
import {
  COUNT_MARKER, historySource, pickFromSources, type MemoryCandidate, type PickAnswer, type PickBatch,
  type PickCriterion, type PickDecide, type PickQuestion,
} from '@curatejs/core';
import { fixtureSource, task } from './fixtures/source-settings.js';

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const logit = (p: number) => Math.log(Math.max(p, 1e-4) / Math.max(1 - p, 1e-4));
const clamped = (p: number) => logit(Math.min(Math.max(p, 1e-4), 1 - 1e-4));

/** A decide that keeps every request and answers each question with `answer`, or 0.5 when it returns nothing. */
function recording(answer: (q: PickQuestion) => number | undefined) {
  const requests: PickBatch[] = [];
  const decide: PickDecide = Object.assign(async (batch: PickBatch) => {
    requests.push(batch);
    return Object.fromEntries(batch.questions.map((q): [string, PickAnswer] =>
      [q.key, { status: 'answered', probability: answer(q) ?? 0.5 }]));
  }, { deciderId: 'fixture' });
  return { requests, decide };
}

const isTask = (q: PickQuestion) => q.sourceId === 'labels';
const pool = (n: number): MemoryCandidate[] => Array.from({ length: n }, (_, i) => ({
  sourceId: 'chat', id: `chat#${i}`, title: `chat part ${i}`, role: 'reference' as const,
  text: `billing deploy part ${i}`, signals: { keyword: 1 - i / 100 },
}));

describe('the count marker keeps a part below the bar', () => {
  // With relevant at 0.5, own and needed at this answer leave CHAT_CASCADE's score near 0.005.
  const low = sigmoid((Math.log(0.005 / 0.995) - CHAT_CASCADE.bias) / (0.8588 + 0.5134));
  const run = async (list: number, instance: number) => {
    const source = historySource({ reader: fixtureSource('chat', pool(1), { rare: false }), ...chatSettings,
      labels: false, questions: { ...CHAT_CASCADE, typed: [COUNT_MARKER] } });
    const { requests, decide } = recording((q) => isTask(q) ? (q.questionKey === 'list' ? list : 0.1)
      : q.questionKey === 'relevant' ? 0.5 : q.questionKey === 'instance' ? instance : low);
    const picked = await pickFromSources([source], { task }, { task, decide, answerTypes: true });
    return { picked, asked: requests.flatMap((r) => r.questions).filter((q) => !isTask(q)) };
  };

  it('keeps a part scoring 0.005 that answers instance at 0.8, and records what kept it', async () => {
    const { picked } = await run(0.9, 0.8);
    const [entry] = picked.record.candidates;
    expect(entry).toMatchObject({ id: 'chat#0', status: 'selected', keptBy: 'instance' });
    expect((entry as { probability: number }).probability).toBeCloseTo(0.005, 6);
    expect((entry as { probability: number }).probability).toBeLessThan(chatSettings.bar);
    expect(picked.record.effects.find((e) => e.setting === 'typed')).toMatchObject({ actedOn: 1, added: 1, dropped: 0 });
  });

  it('rejects the same part when it answers instance at 0.3', async () => {
    const { picked } = await run(0.9, 0.3);
    expect(picked.record.candidates).toMatchObject([{ id: 'chat#0', status: 'rejected' }]);
    expect(picked.record.candidates[0]).not.toHaveProperty('keptBy');
  });

  it('never asks instance on a task answered list at 0.1', async () => {
    const { picked, asked } = await run(0.1, 0.8);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.filter((q) => q.questionKey === 'instance')).toEqual([]);
    expect(picked.record.candidates).toMatchObject([{ id: 'chat#0', status: 'rejected' }]);
  });
});

const WRITTEN: readonly PickCriterion[] = [
  { key: 'a', instructions: 'Does this part name the billing deploy?', true: 'It names it', false: 'It does not' },
  { key: 'b', instructions: 'Does this part give a deploy constraint?', true: 'It gives one', false: 'It gives none' },
];
const written = () => historySource({ reader: fixtureSource('chat', pool(12), { rare: false }), ...chatSettings,
  labels: false, questions: PERSONAL_CHAT_WRITTEN_CASCADE });

describe('written questions are asked and weighed', () => {
  // personal_fact below, inside and above the 0.1 to 0.9 band by part; every other answer varies by part and question.
  const FIRST = [0.05, 0.5, 0.95, 0.3];
  const answer = (q: PickQuestion) => {
    const i = Number(q.id.split('#')[1]);
    if (q.questionKey === 'personal_fact') return FIRST[i % 4];
    const k = q.questionKey === 'task1' ? 1 : q.questionKey === 'task2' ? 2 : q.questionKey === 'needed' ? 3
      : q.questionKey === 'aside' ? 4 : 5;
    return ((i * 7 + k * 13) % 20) / 20 + 0.02;
  };

  it('asks them of every part inside the band and no other, and the score is the formula', async () => {
    const writeQuestions = vi.fn(async () => WRITTEN);
    const { requests, decide } = recording(answer);
    const picked = await pickFromSources([written()], { task }, { task, decide, writeQuestions });
    expect(writeQuestions).toHaveBeenCalledTimes(1);
    expect(picked.record.writtenQuestions).toEqual({ questions: WRITTEN.map((q, i) => ({ ...q, key: `task${i + 1}` })) });

    const asked = requests.flatMap((r) => r.questions).filter((q) => !isTask(q));
    const inBand = (id: string) => [0.5, 0.3].includes(FIRST[Number(id.split('#')[1]) % 4]!);
    const writtenAsked = asked.filter((q) => q.questionKey === 'task1' || q.questionKey === 'task2');
    expect(new Set(writtenAsked.map((q) => q.id))).toEqual(new Set(pool(12).map((c) => c.id).filter(inBand)));
    expect(writtenAsked.find((q) => q.questionKey === 'task1')?.question).toBe(WRITTEN[0]!.instructions);

    const set = PERSONAL_CHAT_WRITTEN_CASCADE;
    for (const entry of picked.record.candidates) {
      const got = Object.fromEntries((entry.questions ?? []).map((q) => [q.key, q.status === 'answered' ? q.probability : NaN]));
      const probability = (entry as { probability: number }).probability;
      if (!inBand(entry.id)) {
        expect(Object.keys(got)).not.toContain('task1');
        expect(probability).toBeCloseTo(sigmoid(set.firstOnly!.bias + set.firstOnly!.weight * logit(got.personal_fact!)), 12);
        continue;
      }
      const [highest, second] = [got.task1!, got.task2!].sort((x, y) => y - x);
      const z = set.bias + set.questions.reduce((sum, q) => sum + q.weight * logit(got[q.key]!), 0)
        + set.written!.highest * clamped(highest!) + set.written!.second * clamped(second!);
      expect(probability).toBeCloseTo(sigmoid(z), 12);
    }
    expect(picked.record.effects.find((e) => e.setting === 'written')).toMatchObject({ source: 'chat', actedOn: 6 });
  });
});

describe('written questions beside the count marker', () => {
  // Every set question at 0.5 scores about 0.083; both written answers at 0.99 lift it to about 0.597, over the bar 0.5.
  const run = async (instance: number) => {
    const source = historySource({ reader: fixtureSource('chat', pool(1), { rare: false }), ...chatSettings,
      labels: false, bar: 0.5, questions: { ...PERSONAL_CHAT_WRITTEN_CASCADE, typed: [COUNT_MARKER] } });
    const { decide } = recording((q) => isTask(q) ? (q.questionKey === 'list' ? 0.9 : 0.1)
      : q.questionKey === 'instance' ? instance : q.questionKey?.startsWith('task') === true ? 0.99 : 0.5);
    return pickFromSources([source], { task }, { task, decide, answerTypes: true, writeQuestions: async () => WRITTEN });
  };

  it('credits written with no part that the count marker keeps without them', async () => {
    const picked = await run(0.8);
    expect(picked.record.candidates).toMatchObject([{ id: 'chat#0', status: 'selected' }]);
    expect((picked.record.candidates[0] as { probability: number }).probability).toBeGreaterThanOrEqual(0.5);
    expect(picked.record.effects.find((e) => e.setting === 'written')).toMatchObject({ actedOn: 1, added: 0, dropped: 0 });
  });

  it('credits written with the part when the count marker would not keep it', async () => {
    const picked = await run(0.3);
    expect(picked.record.candidates).toMatchObject([{ id: 'chat#0', status: 'selected' }]);
    expect(picked.record.effects.find((e) => e.setting === 'written')).toMatchObject({ actedOn: 1, added: 1, dropped: 0 });
  });
});

describe('written questions fail loudly', () => {
  it('writeQuestions with no source carrying written throws before any request', async () => {
    const { requests, decide } = recording(() => 0.5);
    const source = historySource({ reader: fixtureSource('chat', pool(3), { rare: false }), ...chatSettings, labels: false });
    await expect(pickFromSources([source], { task }, { task, decide, writeQuestions: async () => WRITTEN }))
      .rejects.toThrow(new TypeError('writeQuestions is set, but no source\'s question set has written weights.'));
    expect(requests).toEqual([]);
  });

  it('a source carrying written with no writeQuestions throws, naming the source', async () => {
    const { requests, decide } = recording(() => 0.5);
    await expect(pickFromSources([written()], { task }, { task, decide })).rejects.toThrow(new TypeError(
      'chat\'s questions weigh written questions, which need writeQuestions.'));
    expect(requests).toEqual([]);
  });

  it('a writer returning one question throws before any decide request', async () => {
    const { requests, decide } = recording(() => 0.5);
    await expect(pickFromSources([written()], { task }, { task, decide, writeQuestions: async () => WRITTEN.slice(0, 1) }))
      .rejects.toThrow(/2 to 4/);
    expect(requests).toEqual([]);
  });
});
