import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  historySource, memory, SourceReadError,
  type CandidateReadResult, type CandidateSource, type CurateWrite, type MemoryCandidate,
  type PickCascade, type PickDecide,
} from '../src/index.js';

const TASK = 'What billing constraint must this change preserve?';
const LOG = '[2026-01-12] Keep the order currency (said 2026-01-12; E1)';
const INCOMPLETE = 'Context collection did not finish; inspect the source and decision records.';
const note = (id = 'billing'): MemoryCandidate => ({
  sourceId: 'notes', id, role: 'reference', title: 'Billing',
  text: 'Keep the order currency.', signals: { keyword: 1 },
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
  it('returns the cited log, exact joined rules and both full results', async () => {
    const rules: MemoryCandidate[] = ['Keep currency.\n', 'Never round an order twice.'].map((text, i) => ({
      ...note(`rule-${i}`), role: 'rule', applies: 'always', text,
    }));
    const write = vi.fn<CurateWrite>(async () => LOG);
    const recalled = await memory({ sources: [source([note(), ...rules])], decide, write }).recall(TASK);
    expect(recalled.log).toBe(LOG.replace('E1', 'billing'));
    expect(recalled.rules).toBe(rules.map((item) => item.text).join('\n\n'));
    expect(recalled.result.log).toBe(recalled.log);
    expect(recalled.result.record.items).toHaveLength(1);
    expect(recalled.picked.selected).toHaveLength(3);
    expect(write.mock.calls[0]?.[0].body).not.toContain('Never round an order twice.');
    expect(recalled.result.record.levers.everyScored).toBeUndefined();
    expect(Object.values(recalled.result.record.levers.sources).map((settings) => settings.bar)).toEqual([0.0146]);
  });

  it('propagates a failed source read without calling either model', async () => {
    const failure = new SourceReadError('failed', 'Unreadable transcript.');
    const decide = vi.fn();
    const write = vi.fn();
    const broken = { ...source(), read: async () => { throw failure; } };
    await expect(memory({ sources: [broken], decide, write }).recall(TASK)).rejects.toBe(failure);
    expect(decide).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it.each<CandidateReadResult>([
    { status: 'absent', reason: 'missing folder' },
    { status: 'read', complete: false, partial: 'skipped a file', candidates: [note()] },
  ])('rejects an unfinished read ($status) before writing', async (read) => {
    const write = vi.fn(async () => LOG);
    const reader = { ...source(), read: async () => read };
    const attempt = memory({ sources: [reader], decide, write }).recall(TASK);
    await expect(attempt).rejects.toThrow(INCOMPLETE);
    await expect(attempt).rejects.toMatchObject({ cause: { reads: [expect.objectContaining(read)] } });
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects an unanswered candidate before writing', async () => {
    const write = vi.fn(async () => LOG);
    const attempt = memory({ sources: [source()], decide: async () => ({}), write }).recall(TASK);
    await expect(attempt).rejects.toThrow(INCOMPLETE);
    await expect(attempt).rejects.toMatchObject({
      cause: { record: { candidates: [expect.objectContaining({ status: 'unanswered' })] } },
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects unassessed candidates when a caller limit stops decisions', async () => {
    const write = vi.fn(async () => LOG);
    const attempt = memory({
      sources: [source([note(), note('second')])], decide, write,
      pick: { limits: { maxPerBatch: 1, maxBatches: 1 } },
    }).recall(TASK);
    await expect(attempt).rejects.toThrow(INCOMPLETE);
    await expect(attempt).rejects.toMatchObject({ cause: { record: { candidates: expect.arrayContaining([
      expect.objectContaining({ id: 'second', status: 'unassessed' }),
    ]) } } });
    expect(write).not.toHaveBeenCalled();
  });

  it('asks the questions each source carries', async () => {
    const questions: (string | undefined)[] = [];
    const recalled = await memory({
      sources: [historySource({ reader: { ...source(), kind: 'markdown' }, rare: false, labels: false, bar: 0.0146,
        questions: fitted('from-source') })],
      decide: async (batch, signal) => {
        questions.push(...batch.questions.map((question) => question.questionKey));
        return decide(batch, signal);
      },
      write: async () => LOG,
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
      write: async () => LOG,
      ...(override ? { pick: { everyScored: true as const } } : {}),
    }).recall(TASK);
    expect(recalled.picked.selected.map((item) => item.id)).toEqual(override ? ['billing', 'weak'] : ['billing']);
    expect(recalled.result.record.levers.everyScored).toEqual(override ? true : undefined);
    expect(Object.values(recalled.result.record.levers.sources).map((settings) => settings.bar)).toEqual([override ? 0 : 0.0146]);
  });

  it('passes read options, writer options and cancellation through the existing calls', async () => {
    const reader = source();
    const read = vi.fn(reader.read);
    const decideSpy = vi.fn(decide);
    const write = vi.fn(async () => LOG);
    const { signal } = new AbortController();
    const recalled = await memory({
      sources: [{ ...reader, read }], decide: decideSpy, write,
      read: { wholeLanes: true, paths: ['billing.ts'], exclude: ['private'], revision: 'HEAD' },
      curate: { context: true, taskDate: '2026-01-13' },
    }).recall(TASK, { signal });
    expect(read.mock.calls[0]?.[0]).toMatchObject({
      task: TASK, wholeLanes: true, paths: ['billing.ts'], exclude: ['private'], revision: 'HEAD', signal,
    });
    expect(decideSpy.mock.calls[0]?.[1]).toBe(signal);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('(asked 2026-01-13)') }), signal);
    expect(recalled.result.record.context).toBe(true);
    expect(recalled.result.record.levers.wholeLanes).toBe(true);
  });
});
