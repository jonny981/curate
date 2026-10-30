import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LABEL_KINDS, memory, pick,
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
// The same source without label kinds: what a reader carries when its labels are off.
const { labelKinds: _kinds, ...plain }: CandidateSource = source;
const decide: PickDecide = async ({ questions }) => Object.fromEntries(questions.map((q) => [q.key, {
  status: 'answered', probability: q.id === 'weak' ? 0.001 : q.id === 'unrelated' ? 0 : 0.8,
}]));
let cacheRoot: string;

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), 'curate-source-labels-'));
  vi.stubEnv('XDG_CACHE_HOME', cacheRoot);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(cacheRoot, { recursive: true, force: true });
});

describe('labels carried by a source', () => {
  it('cuts weak decisions and asks no labels when no source carries label kinds', async () => {
    const result = await pick(parts, { task, decide });
    expect(result.record.levers).toEqual({
      thoroughness: 'deep', route: false, rare: false,
      sources: { notes: { labels: false, rare: false, bar: 0.0146 } },
    });
    expect(result.selected.map((part) => part.id)).toEqual(['billing']);
    expect(result.record.labels).toBeUndefined();
  });

  it('recalls without labels from a source that carries no label kinds', async () => {
    const result = await memory({ sources: [plain], decide, write: async () => log }).recall(task);
    expect(result.log).toContain('billing');
    expect(result.picked.record.levers.sources).toEqual({ notes: { labels: false, rare: false, bar: 0.0146 } });
    expect(result.result.record.levers.sources).toEqual(result.picked.record.levers.sources);
    expect(result.picked.selected.map((part) => part.id)).toEqual(['billing']);
  });

  it.each(['missing', 'refused'] as const)('rejects %s task labels before treating a part as excluded', async (status) => {
    const incomplete: PickDecide = async (batch, signal) => batch.questions[0]?.sourceId === 'labels'
      ? Object.fromEntries(batch.questions.map((q) => [q.key, { status }])) : decide(batch, signal);
    const write = vi.fn(async () => log);
    await expect(memory({ sources: [source], decide: incomplete, write,
      pick: { everyRanked: true, labels: { directory: cacheRoot, deciderId: 'incomplete' } },
    }).recall(task)).rejects.toMatchObject({ cause: { record: { candidates: expect.arrayContaining([
      expect.objectContaining({ id: 'unrelated', status: 'unassessed', reason: 'limits' }),
    ]) } } });
    expect(write).not.toHaveBeenCalled();
  });

  it('writes labels without configuration and reuses them in a fresh memory instance', async () => {
    const calls = vi.fn(decide);
    await memory({ sources: [source], decide: calls, write: async () => log }).recall(task);
    // The pool member outside the fused order is never labelled.
    expect(readdirSync(join(cacheRoot, 'curate', 'labels'))).toHaveLength(3);
    expect(calls.mock.calls.some(([batch]) => batch.questions.some((q) => q.questionKey === 'personal'))).toBe(true);

    calls.mockClear();
    const second = await memory({ sources: [source], decide: calls, write: async () => log }).recall(task);
    expect(second.picked.record.labels).toMatchObject({ asked: 0, reused: 3 });
    // Relevance is task-specific; only the seven kind labels are cached.
    expect(calls.mock.calls.flatMap(([batch]) => batch.questions).every((q) => q.questionKey === undefined)).toBe(true);
  });

  it('separates decider identities in the same default directory', async () => {
    const first = Object.assign(vi.fn(decide), { deciderId: 'first-model' });
    const second = Object.assign(vi.fn(decide), { deciderId: 'second-model' });
    await pick(parts, { task, decide: first, labelKindsBySource });
    const other = await pick(parts, { task, decide: second, labelKindsBySource });
    expect(other.record.labels).toMatchObject({ deciderId: 'second-model', asked: 4, reused: 0 });
    expect(readdirSync(join(cacheRoot, 'curate', 'labels'))).toHaveLength(8);
    expect((await pick(parts, { task, decide: first, labelKindsBySource })).record.labels).toMatchObject({ asked: 0, reused: 4 });
  });

  it('honours the existing directory and identity overrides', async () => {
    const directory = join(cacheRoot, 'chosen-labels');
    const tagged = Object.assign(vi.fn(decide), { deciderId: 'model-id' });
    const result = await pick(parts, { task, decide: tagged, labelKindsBySource, labels: { directory, deciderId: 'override' } });
    expect(result.record.labels?.deciderId).toBe('override');
    expect(readdirSync(cacheRoot)).toEqual(['chosen-labels']);
    expect(readdirSync(directory)).toHaveLength(4);
  });
});
