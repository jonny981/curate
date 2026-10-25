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
function source(id: string, rare = false, size = 400, labels = false): CandidateSource {
  const pool = Array.from({ length: size }, (_, i) => part(id, `p${i}`,
    i === 0 || i === size - 1 ? 'plain zephyr' : 'plain'));
  return { id, role: 'reference', rare, ...(labels ? { labelKinds: LABEL_KINDS } : {}),
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
  it('runs the rare-word round on the sources that enable it and asks no labels when none carries kinds', async () => {
    const git = source('git', true);
    const chat = source('chat');
    const calls = recorder();
    const result = await pickFromSources([git, chat], { task }, { task, decide: calls.decide });
    expect(result.record.levers).toMatchObject({ everyRanked: true, route: false,
      rare: { share: 5 / 850, bar: 0.0146 },
      sources: { git: { labels: false, rare: true, bar: 0.0146 }, chat: { labels: false, rare: false, bar: 0.0146 } } });
    expect(result.selected.map((c) => `${c.sourceId}/${c.id}`).sort()).toEqual(['chat/p0', 'git/p0', 'git/p399']);
    expect(calls.questions.every((q) => q.questionKey === undefined)).toBe(true);
    expect(git.read).toHaveBeenCalledTimes(2);
    expect(chat.read).toHaveBeenCalledTimes(1);
    expect(result.record.labels).toBeUndefined();
    const written = await curate(task, result, { write: async () => '[2026-01-12] A constraint (said 2026-01-12; E1)' });
    expect(written.record.levers.sources).toEqual(result.record.levers.sources);
  });

  it('asks labels only of the source that carries label kinds', async () => {
    const calls = recorder();
    const recalled = await memory({ sources: [source('git', true, 2), source('chat', false, 2, true)], decide: calls.decide,
      write: async () => '[2026-01-12] A constraint (said 2026-01-12; E1)' }).recall(task);
    expect(recalled.picked.record.levers.sources).toEqual({ git: { labels: false, rare: true, bar: 0.0146 }, chat: { labels: true, labelBar: 0.5, rare: false, bar: 0.0146 } });
    expect(recalled.result.record.levers.sources).toEqual(recalled.picked.record.levers.sources);
    expect(calls.questions.some((q) => q.sourceId === 'chat' && q.questionKey === 'personal')).toBe(true);
    expect(calls.questions.filter((q) => q.sourceId === 'git').every((q) => q.questionKey === undefined)).toBe(true);
  });

  it('records a call\'s rare override on every source it changed', async () => {
    const run = (sources: CandidateSource[], rare?: boolean) => pickFromSources(sources, { task }, {
      task, decide: recorder().decide, ...(rare === undefined ? {} : { rare }),
    });
    for (const rare of [false, true]) {
      const result = await run([source('git', true, 2), source('chat', false, 2)], rare);
      expect(result.record.levers.sources).toEqual({ git: { labels: false, rare, bar: 0.0146 }, chat: { labels: false, rare, bar: 0.0146 } });
      const written = await curate(task, result, { write: async () => '[2026-01-12] A constraint (said 2026-01-12; E1)' });
      expect(written.record.levers.sources).toEqual(result.record.levers.sources);
    }
    const disabled = { ...source('git', true, 2), rare: false };
    expect((await run([disabled])).record.levers).toMatchObject({ rare: false, sources: { git: { labels: false, rare: false, bar: 0.0146 } } });
    expect(disabled.read).toHaveBeenCalledTimes(1);
  });

  it('does not count or seed disabled sources in the rare-word round', async () => {
    const git = [part('git', 'seed', 'plain zephyr'), { ...part('git', 'extra', 'plain zephyr'), poolOnly: true }];
    const chat = Array.from({ length: 400 }, (_, i) => part('chat', `c${i}`, 'plain'));
    const result = await pick([...git, ...chat], { task, decide: recorder().decide, rareBySource: { git: true, chat: false } });
    expect(result.selected.some((c) => c.id === 'extra')).toBe(false);
    expect(result.record.pick?.rare?.sources.git?.words).not.toContain('zephyr');
    const seedOnlyInChat = await pick([
      part('chat', 'seed', 'plain zephyr'),
      ...Array.from({ length: 400 }, (_, i) => ({ ...part('git', `g${i}`, i === 399 ? 'plain zephyr' : 'plain'), poolOnly: true })),
    ], { task, decide: recorder().decide, rareBySource: { git: true, chat: false } });
    expect(seedOnlyInChat.selected.map((c) => c.id)).toEqual(['seed']);
  });

  it('keeps each source\'s rare-word round to its own parts and records empty readers', async () => {
    const candidates = Array.from({ length: 400 }, (_, i) => ({
      ...part(i < 200 ? 'git' : 'notes', `p${i}`, i === 0 || i === 399 ? 'plain zephyr' : 'plain'),
      ...(i === 0 ? {} : { poolOnly: true }),
    }));
    const result = await pick(candidates, { task, decide: recorder().decide, rareBySource: { git: true, notes: true } });
    // git's p0 seeds 'zephyr', which notes' p399 shares; a source's round
    // never pulls another source's parts.
    expect(result.selected.map((c) => c.id)).toEqual(['p0']);
    expect(result.record.pick?.rare?.sources).toEqual({ git: { n: 200, words: ['zephyr'] }, notes: { n: 200, words: [] } });
    const empty: CandidateSource = { id: 'empty', role: 'reference', rare: true,
      read: async () => ({ status: 'read', complete: true, candidates: [] }) };
    const differentId: CandidateSource = { id: 'reader', role: 'reference', rare: true,
      read: async () => ({ status: 'read', complete: true, candidates: [part('returned', 'p0')] }) };
    const read = await pickFromSources([empty, differentId], { task }, { task, decide: recorder().decide });
    expect(read.record.levers.sources).toEqual({ empty: { labels: false, rare: true, bar: 0.0146 }, reader: { labels: false, rare: true, bar: 0.0146 },
      returned: { labels: false, rare: true, bar: 0.0146 } });
  });

  it('rejects invalid per-source defaults before reading', async () => {
    const reader = { ...source('git'), rare: 'yes' as never };
    await expect(pickFromSources([reader], { task }, { task, decide: recorder().decide })).rejects.toThrow(/rareBySource/);
    expect(reader.read).not.toHaveBeenCalled();
  });
});
