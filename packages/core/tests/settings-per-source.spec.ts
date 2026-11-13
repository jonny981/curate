import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LABEL_KINDS, curate, memory, pickFromSources, rankedRead,
  type CandidateSource, type MemoryCandidate, type PickDecide, type PickQuestion } from '../src/index.js';

const task = 'Recall the constraint';
const part = (sourceId: string, id: string, text = 'plain'): MemoryCandidate => ({
  sourceId, id, text, title: id, role: 'reference', signals: { score: 1 },
  date: { value: '2026-01-12', meaning: 'recorded' },
});
function source(id: string, size = 400, labels = false): CandidateSource {
  const pool = Array.from({ length: size }, (_, i) => part(id, `p${i}`,
    i === 0 || i === size - 1 ? 'plain zephyr' : 'plain'));
  return { id, role: 'reference', ...(labels ? { labelKinds: LABEL_KINDS } : {}),
    read: vi.fn(async (request) => ({ status: 'read' as const, complete: true, laneCutApplied: true,
      candidates: request.wholeLanes ? pool : [pool[0]!] })) };
}
function recorder() {
  const questions: PickQuestion[] = [];
  const decide: PickDecide = async (batch) => {
    questions.push(...batch.questions);
    return Object.fromEntries(batch.questions.map((q) => [q.key, { status: 'answered', probability: 0.9 }]));
  };
  return { decide, questions };
}
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'curate-use-case-'));
  vi.stubEnv('XDG_CACHE_HOME', directory);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

describe('settings per source', () => {
  it('asks no labels when no source carries kinds', async () => {
    const git = source('git');
    const chat = source('chat');
    const calls = recorder();
    const result = await pickFromSources([git, chat], { task }, { task, decide: calls.decide, everyRanked: true });
    expect(result.record.levers).toMatchObject({ everyRanked: true, route: false,
      sources: { git: { labels: false, bar: 0.0146 }, chat: { labels: false, bar: 0.0146 } } });
    expect(result.selected.map((c) => `${c.sourceId}/${c.id}`).sort()).toEqual(['chat/p0', 'git/p0']);
    expect(calls.questions.every((q) => q.questionKey === undefined)).toBe(true);
    expect(git.read).toHaveBeenCalledTimes(1);
    expect(chat.read).toHaveBeenCalledTimes(1);
    expect(result.record.labels).toBeUndefined();
    const written = await curate(task, result);
    expect(written.record.levers.sources).toEqual(result.record.levers.sources);
  });

  it('asks labels only of the source that carries label kinds', async () => {
    const calls = recorder();
    const recalled = await memory({ sources: [source('git', 2), source('chat', 2, true)], decide: calls.decide,
      pick: { everyRanked: true } }).recall(task);
    expect(recalled.picked.record.levers.sources).toEqual({ git: { labels: false, bar: 0.0146 }, chat: { labels: true, labelBar: 0.5, bar: 0.0146 } });
    expect(recalled.result.record.levers.sources).toEqual(recalled.picked.record.levers.sources);
    expect(calls.questions.some((q) => q.sourceId === 'chat' && q.questionKey === 'personal')).toBe(true);
    expect(calls.questions.filter((q) => q.sourceId === 'git').every((q) => q.questionKey === undefined)).toBe(true);
  });

  it('records the settings of readers that return no part or parts under another id', async () => {
    const empty: CandidateSource = { id: 'empty', role: 'reference',
      read: async () => ({ status: 'read', complete: true, candidates: [] }) };
    const differentId: CandidateSource = { id: 'reader', role: 'reference',
      read: async () => ({ status: 'read', complete: true, candidates: [part('returned', 'p0')] }) };
    const read = await pickFromSources([empty, differentId], { task }, { task, decide: recorder().decide });
    expect(read.record.levers.sources).toEqual({ empty: { labels: false, bar: 0.0146 }, reader: { labels: false, bar: 0.0146 },
      returned: { labels: false, bar: 0.0146 } });
  });

  it('rejects invalid per-source defaults before reading', async () => {
    const reader = { ...source('git'), mode: { name: 'commits', bar: 2, read: rankedRead } };
    await expect(pickFromSources([reader], { task }, { task, decide: recorder().decide })).rejects.toThrow(/modesBySource\.git\.bar/);
    expect(reader.read).not.toHaveBeenCalled();
  });
});
