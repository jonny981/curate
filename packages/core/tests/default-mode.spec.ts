import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  conversationRecall, defaultMode, LABEL_KINDS, memory, pick, pickFromSources,
  type CandidateSource, type MemoryCandidate, type PickDecide,
} from '../src/index.js';

const task = 'What billing constraint applies?';
const labelKindsBySource = { notes: LABEL_KINDS };
const log = '[2026-01-12] Preserve currency (said 2026-01-12; E1)';
const parts: MemoryCandidate[] = ['billing', 'weak', 'unrelated'].map((id) => ({
  sourceId: 'notes', id, role: 'reference', title: id, text: `The ${id} note.`,
  signals: { keyword: 1 }, date: { value: '2026-01-12', meaning: 'recorded' },
}));
const source: CandidateSource = {
  id: 'notes', role: 'reference', labelKinds: LABEL_KINDS,
  read: async (request) => ({
    status: 'read', complete: true, laneCutApplied: true,
    candidates: request.wholeLanes ? parts : parts.slice(0, 2),
  }),
};
const decide: PickDecide = async ({ questions }) => Object.fromEntries(questions.map((q) => [q.key, {
  status: 'answered', probability: q.id === 'weak' ? 0.001 : q.id === 'unrelated' ? 0 : 0.8,
}]));
let cacheRoot: string;

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), 'curate-default-mode-'));
  vi.stubEnv('XDG_CACHE_HOME', cacheRoot);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(cacheRoot, { recursive: true, force: true });
});

describe('default mode', () => {
  it('cuts weak decisions and leaves labels off by default', async () => {
    const result = await pick(parts, { task, decide, labelKindsBySource });
    expect(result.record.levers).toEqual({
      preset: 'default', everyRanked: true, everyScored: { bar: 0.0146 },
      labels: false, route: false, rare: false,
    });
    expect(result.selected.map((part) => part.id)).toEqual(['billing']);
    expect(result.record.labels).toBeUndefined();
  });

  it('exports the default preset and resolves it the same way as omitted settings', async () => {
    const implicit = await pickFromSources([source], { task }, { task, decide });
    const explicit = await pickFromSources([source], { task, ...defaultMode.read }, {
      task, decide, ...defaultMode.pick,
    });
    expect(implicit.record.levers).toEqual({
      preset: 'default', wholeLanes: false, everyRanked: true, everyScored: { bar: 0.0146 },
      labels: false, route: false, rare: false,
    });
    expect(explicit.record.levers).toEqual(implicit.record.levers);
    expect(explicit.selected).toEqual(implicit.selected);
    expect(implicit.record.candidates.map((part) => part.id)).toEqual(['billing', 'weak']);
  });

  it('recalls in default mode without enabling labels', async () => {
    const result = await memory({ sources: [source], decide, write: async () => log }).recall(task);
    expect(result.log).toContain('billing');
    expect(result.picked.record.levers.preset).toBe('default');
    expect(result.result.record.levers).toMatchObject({
      preset: 'default', everyScored: { bar: 0.0146 }, labels: false,
    });
    expect(result.picked.selected.map((part) => part.id)).toEqual(['billing']);
  });

  it.each(['missing', 'refused'] as const)('rejects %s task labels before treating a part as excluded', async (status) => {
    const incomplete: PickDecide = async (batch, signal) => batch.questions[0]?.sourceId === 'labels'
      ? Object.fromEntries(batch.questions.map((q) => [q.key, { status }])) : decide(batch, signal);
    const write = vi.fn(async () => log);
    await expect(memory({ sources: [source], decide: incomplete, write,
      pick: { labels: { directory: cacheRoot, deciderId: 'incomplete' } },
    }).recall(task)).rejects.toMatchObject({ cause: { record: { candidates: expect.arrayContaining([
      expect.objectContaining({ id: 'unrelated', status: 'unassessed', reason: 'limits' }),
    ]) } } });
    expect(write).not.toHaveBeenCalled();
  });

  it('writes labels without configuration and reuses them in a fresh memory instance', async () => {
    const calls = vi.fn(decide);
    await memory({ sources: [source], decide: calls, write: async () => log, preset: 'conversation-recall' }).recall(task);
    expect(readdirSync(join(cacheRoot, 'curate', 'labels'))).toHaveLength(4);
    expect(calls.mock.calls.some(([batch]) => batch.questions.some((q) => q.questionKey === 'personal'))).toBe(true);

    calls.mockClear();
    const second = await memory({ sources: [source], decide: calls, write: async () => log, preset: 'conversation-recall' }).recall(task);
    expect(second.picked.record.labels).toMatchObject({ asked: 0, reused: 4 });
    // Relevance is task-specific; only the seven kind labels are cached.
    expect(calls.mock.calls.flatMap(([batch]) => batch.questions).every((q) => q.questionKey === undefined)).toBe(true);
  });

  it('separates decider identities in the same default directory', async () => {
    const first = Object.assign(vi.fn(decide), { deciderId: 'first-model' });
    const second = Object.assign(vi.fn(decide), { deciderId: 'second-model' });
    await pick(parts, { ...conversationRecall.pick, task, decide: first, labelKindsBySource });
    const other = await pick(parts, { ...conversationRecall.pick, task, decide: second, labelKindsBySource });
    expect(other.record.labels).toMatchObject({ deciderId: 'second-model', asked: 4, reused: 0 });
    expect(readdirSync(join(cacheRoot, 'curate', 'labels'))).toHaveLength(8);
    expect((await pick(parts, { ...conversationRecall.pick, task, decide: first, labelKindsBySource })).record.labels).toMatchObject({ asked: 0, reused: 4 });
  });

  it('honours the existing directory and identity overrides', async () => {
    const directory = join(cacheRoot, 'chosen-labels');
    const tagged = Object.assign(vi.fn(decide), { deciderId: 'model-id' });
    const result = await pick(parts, { task, decide: tagged, labelKindsBySource, labels: { directory, deciderId: 'override' } });
    expect(result.record.labels?.deciderId).toBe('override');
    expect(readdirSync(cacheRoot)).toEqual(['chosen-labels']);
    expect(readdirSync(directory)).toHaveLength(4);
  });

  it('keeps labels off explicitly while retaining the default decision bar', async () => {
    const result = await memory({ sources: [source], decide, write: async () => log,
      pick: { labels: false },
    }).recall(task);
    expect(result.picked.record.levers.preset).toBe('default');
    expect(result.picked.record.labels).toBeUndefined();
    expect(result.picked.selected.map((part) => part.id)).toEqual(['billing']);
    expect(readdirSync(cacheRoot)).toEqual([]);
  });

  it.each(['default', 'conversation-recall'] as const)('honours the explicit %s preset', async (preset) => {
    const result = await memory({ sources: [source], decide, write: async () => log, preset }).recall(task);
    expect(result.result.record.levers.preset).toBe(preset);
    expect(result.picked.record.levers.labels).toBe(preset === 'conversation-recall');
    expect(result.picked.selected.map((part) => part.id)).toEqual(['billing']);
  });
});
