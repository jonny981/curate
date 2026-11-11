import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  historySource, memory, SourceReadError,
  type CandidateReadResult, type CandidateSource, type MemoryCandidate,
  type PickBatch, type PickCascade, type PickDecide,
} from '../src/index.js';

const TASK = 'What billing constraint must this change preserve?';
const LAID_OUT = '### Most likely answer\n\n#### notes (said 2026-01-12)\n\nKeep the order currency. billing\n';
const SENTENCE = 'Does this sentence supply evidence, a constraint or a decision for this task?';
const sentenceBatches = (batches: readonly PickBatch[]) => batches.filter((batch) => batch.questions.some((q) => q.question === SENTENCE));
const INCOMPLETE = 'Context collection did not finish; inspect the source and decision records.';
const note = (id = 'billing'): MemoryCandidate => ({
  sourceId: 'notes', id, role: 'reference', title: 'Billing',
  text: `Keep the order currency. ${id}`, signals: { keyword: 1 },
  date: { value: '2026-01-12', meaning: 'recorded' },
});
const source = (candidates = [note()]): CandidateSource => ({
  id: 'notes', role: 'mixed',
  read: async () => ({ status: 'read', complete: true, candidates }),
});
const decide: PickDecide = async ({ questions }) => Object.fromEntries(
  questions.map((q) => [q.key, { status: 'answered', probability: 0.8 }]),
);
const fitted = (key: string): PickCascade => ({
  bias: 0, questions: [{ key, instructions: `Check ${key}.`, true: 'Yes.', false: 'No.', weight: 1 }],
});

let cacheRoot: string;
beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), 'curate-memory-'));
  vi.stubEnv('XDG_CACHE_HOME', cacheRoot);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(cacheRoot, { recursive: true, force: true });
});

describe('memory', () => {
  it('lays out the kept parts in their own words, with exact joined rules and both full results', async () => {
    const rules: MemoryCandidate[] = ['Keep currency.\n', 'Never round an order twice.'].map((text, i) => ({
      ...note(`rule-${i}`), role: 'rule', applies: 'always', text,
    }));
    const recalled = await memory({ sources: [source([note(), ...rules])], decide }).recall(TASK);
    expect(recalled.log).toBe(LAID_OUT);
    expect(recalled.rules).toBe(rules.map((item) => item.text).join('\n\n'));
    expect(recalled.result.log).toBe(recalled.log);
    expect(recalled.result.record.items).toHaveLength(1);
    expect(recalled.picked.selected).toHaveLength(3);
    expect(recalled.log).not.toContain('Never round an order twice.');
    expect(recalled.result.record.levers.everyScored).toBeUndefined();
    expect(Object.values(recalled.result.record.levers.sources).map((settings) => settings.bar)).toEqual([0.0146]);
  });

  it('rates the sentences of the parts laid out with the same decide, at 0.1 by default', async () => {
    const batches: PickBatch[] = [];
    const rate: PickDecide = async (batch, signal) => {
      batches.push(batch);
      return batch.questions.some((q) => q.question === SENTENCE)
        ? Object.fromEntries(batch.questions.map((q) => [q.key, { status: 'answered', probability: q.text === 'billing' ? 0.09 : 0.1 }]))
        : decide(batch, signal);
    };
    const recalled = await memory({ sources: [source()], decide: rate }).recall(TASK);
    expect(sentenceBatches(batches)).toHaveLength(1);
    expect(recalled.result.record.sentences).toMatchObject({ cutoff: 0.1, kept: 1, of: 2 });
    expect(recalled.log).toBe('### Most likely answer\n\n#### notes (said 2026-01-12)\n\nKeep the order currency. …\n');
  });

  it('rates no sentence when curate.sentenceCutoff is false', async () => {
    const batches: PickBatch[] = [];
    const recalled = await memory({ sources: [source()], curate: { sentenceCutoff: false },
      decide: async (batch, signal) => { batches.push(batch); return decide(batch, signal); } }).recall(TASK);
    expect(sentenceBatches(batches)).toHaveLength(0);
    expect(recalled.log).toBe(LAID_OUT);
    expect(recalled.result.record).not.toHaveProperty('sentences');
  });

  it('propagates a failed source read without calling the decision model', async () => {
    const failure = new SourceReadError('failed', 'Unreadable transcript.');
    const decide = vi.fn();
    const broken = { ...source(), read: async () => { throw failure; } };
    await expect(memory({ sources: [broken], decide }).recall(TASK)).rejects.toBe(failure);
    expect(decide).not.toHaveBeenCalled();
  });

  it.each<CandidateReadResult>([
    { status: 'absent', reason: 'missing folder' },
    { status: 'read', complete: false, partial: 'skipped a file', candidates: [note()] },
  ])('rejects an unfinished read ($status) before the layout', async (read) => {
    const batches: PickBatch[] = [];
    const reader = { ...source(), read: async () => read };
    const attempt = memory({ sources: [reader], decide: async (batch, signal) => { batches.push(batch); return decide(batch, signal); } }).recall(TASK);
    await expect(attempt).rejects.toThrow(INCOMPLETE);
    // Lane ranks join the candidates inside the read, so the members
    // compare on the fields the reader itself returned.
    await expect(attempt).rejects.toMatchObject({ cause: { reads: [expect.objectContaining(
      read.status === 'read' ? { ...read, candidates: read.candidates.map((candidate) => expect.objectContaining(candidate)) } : read,
    )] } });
    expect(sentenceBatches(batches)).toHaveLength(0);
  });

  it('rejects an unanswered candidate before the layout', async () => {
    const batches: PickBatch[] = [];
    const attempt = memory({ sources: [source()], decide: async (batch) => { batches.push(batch); return {}; } }).recall(TASK);
    await expect(attempt).rejects.toThrow(INCOMPLETE);
    await expect(attempt).rejects.toMatchObject({
      cause: { record: { candidates: [expect.objectContaining({ status: 'unanswered' })] } },
    });
    expect(sentenceBatches(batches)).toHaveLength(0);
  });

  it('rejects unassessed candidates when a caller limit stops decisions', async () => {
    const batches: PickBatch[] = [];
    const attempt = memory({
      sources: [source([note(), note('second')])], decide: async (batch, signal) => { batches.push(batch); return decide(batch, signal); },
      pick: { limits: { maxPerBatch: 1, maxBatches: 1 } },
    }).recall(TASK);
    await expect(attempt).rejects.toThrow(INCOMPLETE);
    await expect(attempt).rejects.toMatchObject({ cause: { record: { candidates: expect.arrayContaining([
      expect.objectContaining({ id: 'second', status: 'unassessed' }),
    ]) } } });
    expect(sentenceBatches(batches)).toHaveLength(0);
  });

  it('asks the questions each source carries', async () => {
    const questions: (string | undefined)[] = [];
    const recalled = await memory({
      sources: [historySource({ reader: { ...source(), kind: 'markdown' }, rare: false, labels: false, bar: 0.0146,
        names: false, questions: fitted('from-source') })],
      decide: async (batch, signal) => {
        questions.push(...batch.questions.filter((question) => question.sourceId === 'notes').map((question) => question.questionKey));
        return decide(batch, signal);
      },
    }).recall(TASK);
    expect(questions).toEqual(['from-source']);
    expect(recalled.picked.record.levers.sources.notes?.questions).toEqual(fitted('from-source'));
    expect(recalled.rules).toBe('');
  });

  it.each([false, true])('cuts at the 0.0146 bar by default and lets an explicit lever win (override %s)', async (override) => {
    const recalled = await memory({
      sources: [source([note(), note('weak')])],
      decide: async ({ questions }) => Object.fromEntries(questions.map((q) => [q.key, {
        status: 'answered', probability: q.id === 'weak' ? 0.001 : 0.8,
      }])),
      ...(override ? { pick: { everyScored: true as const } } : {}),
    }).recall(TASK);
    expect(recalled.picked.selected.map((item) => item.id)).toEqual(override ? ['billing', 'weak'] : ['billing']);
    expect(recalled.result.record.levers.everyScored).toEqual(override ? true : undefined);
    expect(Object.values(recalled.result.record.levers.sources).map((settings) => settings.bar)).toEqual([override ? 0 : 0.0146]);
  });

  it('passes read options, layout options and cancellation through the existing calls', async () => {
    const reader = source();
    const read = vi.fn(reader.read);
    const decideSpy = vi.fn(decide);
    const controller = new AbortController();
    const { signal } = controller;
    const recalled = await memory({
      sources: [{ ...reader, read }], decide: decideSpy,
      read: { wholeLanes: true, paths: ['billing.ts'], exclude: ['private'], revision: 'HEAD' },
      curate: { answerTokens: 500, sentenceCutoff: 0.5 },
    }).recall(TASK, { signal });
    expect(read.mock.calls[0]?.[0]).toMatchObject({
      task: TASK, wholeLanes: true, paths: ['billing.ts'], exclude: ['private'], revision: 'HEAD', signal,
    });
    // The decide call's own signal fires when the caller's does.
    const decideSignal = decideSpy.mock.calls[0]?.[1];
    expect(decideSignal).toBeInstanceOf(AbortSignal);
    controller.abort();
    expect(decideSignal?.aborted).toBe(true);
    // The sentence request goes out with the caller's own signal.
    expect(decideSpy.mock.calls.at(-1)?.[1]).toBe(signal);
    expect(recalled.result.record.answerTokens).toBe(500);
    expect(recalled.result.record.sentences?.cutoff).toBe(0.5);
    expect(recalled.result.record.levers.wholeLanes).toBe(true);
  });

  it('rejects a layout option curate does not take before any read', async () => {
    let reads = 0;
    const reader: CandidateSource = { ...source(), read: async () => { reads += 1; return { status: 'read', complete: true, candidates: [note()] }; } };
    await expect(memory({ sources: [reader], decide, curate: { taskDate: 'Monday' } as never }).recall(TASK))
      .rejects.toThrow('`taskDate` is not an option');
    expect(reads).toBe(0);
  });
});

describe('the task date', () => {
  it('names the moment in the pick record', async () => {
    const reads: { taskDate?: string; timeZone?: string }[] = [];
    const reader: CandidateSource = { ...source(), read: async (request) => {
      reads.push({ taskDate: request.taskDate, timeZone: request.timeZone });
      return { status: 'read', complete: true, candidates: [note()] };
    } };
    const { picked } = await memory({ sources: [reader], decide })
      .recall(TASK, { taskDate: '2025-06-02', timeZone: 'Europe/London' });
    expect(reads[0]).toEqual({ taskDate: '2025-06-02', timeZone: 'Europe/London' });
    expect(picked.record).toMatchObject({ asOf: '2025-06-02T23:59:59.999+01:00', timeZone: 'Europe/London' });
  });

  it('gives every read of one recall the same moment when no task date is given', async () => {
    const reads: { taskDate?: string; asOf?: string }[] = [];
    const reader = (id: string): CandidateSource => ({ ...source(), id, read: async (request) => {
      reads.push({ taskDate: request.taskDate, asOf: request.asOf });
      // The clock moves a year while the first source reads.
      if (reads.length === 1) vi.setSystemTime(new Date('2026-06-02T12:00:00Z'));
      return { status: 'read', complete: true, candidates: [{ ...note(), sourceId: id }] };
    } });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2025-06-02T12:00:00Z'));
    try {
      const { picked } = await memory({ sources: [reader('notes'), reader('more-notes')], decide })
        .recall(TASK, { timeZone: 'UTC' });
      expect(picked.record.asOf).toBe('2025-06-02T12:00:00.000+00:00');
      expect(reads).toEqual([{ taskDate: undefined, asOf: picked.record.asOf }, { taskDate: undefined, asOf: picked.record.asOf }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['taskDate', { taskDate: 'last Tuesday' }],
    ['taskDate offset hour', { taskDate: '2025-06-02T09:15:00+24:00' }],
    ['taskDate offset minute', { taskDate: '2025-06-02T09:15:00+01:60' }],
    ['taskDate offset', { taskDate: '2025-06-02T09:15:00+99:99' }],
    ['timeZone', { timeZone: 'Mars/Olympus' }],
  ] as const)(
    'throws a TypeError for a bad %s before any read', async (_name, time) => {
      let reads = 0;
      const reader: CandidateSource = { ...source(), read: async () => { reads += 1; return { status: 'read', complete: true, candidates: [] }; } };
      await expect(memory({ sources: [reader], decide }).recall(TASK, time))
        .rejects.toThrow(TypeError);
      expect(reads).toBe(0);
    });
});
