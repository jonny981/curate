import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LABEL_KINDS, curate, memory, pick, pickFromSources,
  type CandidateSource, type MemoryCandidate, type PickDecide, type PickQuestion } from '../src/index.js';

const task = 'Recall the constraint';
const part = (sourceId: string, id: string, text = 'plain'): MemoryCandidate => ({
  sourceId, id, text, title: id, role: 'reference', signals: { score: 1 },
  date: { value: '2026-01-12', meaning: 'recorded' },
});
function source(id: string, rare = false, size = 400): CandidateSource {
  const pool = Array.from({ length: size }, (_, i) => part(id, `p${i}`,
    i === 0 || i === size - 1 ? 'plain zephyr' : 'plain'));
  return { id, role: 'reference', rare, ...(id === 'chat' ? { labelKinds: LABEL_KINDS } : {}),
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

describe('modes by use case', () => {
  it('uses rare words for enabled sources and no labels in the default mode', async () => {
    const git = source('git', true);
    const chat = source('chat');
    const calls = recorder();
    const result = await pickFromSources([git, chat], { task }, { task, decide: calls.decide });
    expect(result.record.levers).toMatchObject({ preset: 'default', everyRanked: true,
      everyScored: { bar: 0.0146 }, labels: false, route: false,
      rare: { share: 5 / 850, bar: 0.0146, sources: ['git'] } });
    expect(result.selected.map((c) => `${c.sourceId}/${c.id}`).sort()).toEqual(['chat/p0', 'git/p0', 'git/p399']);
    expect(calls.questions.every((q) => q.questionKey === undefined)).toBe(true);
    expect(git.read).toHaveBeenCalledTimes(2);
    expect(chat.read).toHaveBeenCalledTimes(1);
    expect(result.record.labels).toBeUndefined();
    const written = await curate(task, result, { write: async () => '[2026-01-12] A constraint (said 2026-01-12; E1)' });
    expect(written.record.levers.preset).toBe('default');
  });

  it('enables only declared source labels in conversation-recall', async () => {
    const calls = recorder();
    const recalled = await memory({ sources: [source('git', true, 2), source('chat', false, 2)],
      preset: 'conversation-recall', decide: calls.decide,
      write: async () => '[2026-01-12] A constraint (said 2026-01-12; E1)' }).recall(task);
    expect(recalled.picked.record.levers).toMatchObject({ preset: 'conversation-recall', labels: true });
    expect(recalled.result.record.levers.preset).toBe('conversation-recall');
    expect(calls.questions.some((q) => q.sourceId === 'chat' && q.questionKey === 'personal')).toBe(true);
    expect(calls.questions.filter((q) => q.sourceId === 'git').every((q) => q.questionKey === undefined)).toBe(true);
  });

  it.each(['performance', 'economy', 'unknown'])('rejects unknown preset %s before reading', (preset) => {
    const reader = source('git', true);
    expect(() => memory({ sources: [reader], preset: preset as never, decide: recorder().decide,
      write: async () => '' })).toThrow(/unknown preset/i);
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('matches source defaults by effect and records changed overrides as custom', async () => {
    const run = (sources: CandidateSource[], rare?: boolean) => pickFromSources(sources, { task }, {
      task, decide: recorder().decide, ...(rare === undefined ? {} : { rare }),
    });
    expect((await run([source('git', true, 2)], true)).record.levers.preset).toBe('default');
    expect((await run([source('chat', false, 2)], false)).record.levers.preset).toBe('default');
    for (const rare of [false, true]) {
      const result = await run([source('git', true, 2), source('chat', false, 2)], rare);
      expect(result.record.levers.preset).toBe('custom');
      const written = await curate(task, result, { write: async () => '[2026-01-12] A constraint (said 2026-01-12; E1)' });
      expect(written.record.levers.preset).toBe('custom');
    }
    const disabled = { ...source('git', true, 2), rare: false };
    expect((await run([disabled])).record.levers).toMatchObject({ preset: 'default', rare: false });
    expect(disabled.read).toHaveBeenCalledTimes(1);
  });

  it('does not count or seed disabled sources in the rare-word round', async () => {
    const git = [part('git', 'seed', 'plain zephyr'), { ...part('git', 'extra', 'plain zephyr'), poolOnly: true }];
    const chat = Array.from({ length: 400 }, (_, i) => part('chat', `c${i}`, 'plain'));
    const result = await pick([...git, ...chat], { task, decide: recorder().decide, rareBySource: { git: true, chat: false } });
    expect(result.selected.some((c) => c.id === 'extra')).toBe(false);
    expect(result.record.pick?.rare?.words).not.toContain('zephyr');
    const seedOnlyInChat = await pick([
      part('chat', 'seed', 'plain zephyr'),
      ...Array.from({ length: 400 }, (_, i) => ({ ...part('git', `g${i}`, i === 399 ? 'plain zephyr' : 'plain'), poolOnly: true })),
    ], { task, decide: recorder().decide, rareBySource: { git: true, chat: false } });
    expect(seedOnlyInChat.selected.map((c) => c.id)).toEqual(['seed']);
  });

  it('retains shared rare words across enabled sources and records empty readers', async () => {
    const candidates = Array.from({ length: 400 }, (_, i) => ({
      ...part(i < 200 ? 'git' : 'notes', `p${i}`, i === 0 || i === 399 ? 'plain zephyr' : 'plain'),
      ...(i === 0 ? {} : { poolOnly: true }),
    }));
    const result = await pick(candidates, { task, decide: recorder().decide, rareBySource: { git: true, notes: true } });
    expect(result.selected.map((c) => c.id)).toEqual(['p0', 'p399']);
    const empty: CandidateSource = { id: 'empty', role: 'reference', rare: true,
      read: async () => ({ status: 'read', complete: true, candidates: [] }) };
    const differentId: CandidateSource = { id: 'reader', role: 'reference', rare: true,
      read: async () => ({ status: 'read', complete: true, candidates: [part('returned', 'p0')] }) };
    const read = await pickFromSources([empty, differentId], { task }, { task, decide: recorder().decide });
    expect(read.record.levers.rare).toMatchObject({ sources: ['empty', 'reader', 'returned'] });
    expect(read.record.levers.preset).toBe('default');
  });

  it('rejects invalid per-source defaults before reading', async () => {
    const reader = { ...source('git'), rare: 'yes' as never };
    await expect(pickFromSources([reader], { task }, { task, decide: recorder().decide })).rejects.toThrow(/rareBySource/);
    expect(reader.read).not.toHaveBeenCalled();
  });
});
