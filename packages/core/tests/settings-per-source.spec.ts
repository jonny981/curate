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
    const shared = { ...source('git'), mode: { name: 'commits', read: rankedRead, textShare: 1.5 } };
    await expect(pickFromSources([shared], { task }, { task, decide: recorder().decide })).rejects.toThrow(/modesBySource\.git\.textShare/);
  });

  it('records the text share a source\'s mode sets, and the text keeps only the parts within it', async () => {
    const decide: PickDecide = async (batch) => Object.fromEntries(batch.questions.map((q) =>
      [q.key, { status: 'answered', probability: q.id === 'p0' ? 0.9 : 0.05 }]));
    const chat = { ...source('chat', 4), mode: { name: 'messages', read: rankedRead, textShare: 0.1 } };
    const result = await pickFromSources([chat, source('git', 4)], { task, wholeLanes: true }, { task, decide, everyRanked: true });
    expect(result.record.levers.sources.chat).toMatchObject({ mode: 'messages', textShare: 0.1 });
    expect(result.record.levers.sources.git?.textShare).toBeUndefined();
    // The chat parts at 0.05 are under 0.1 of 0.9 and leave the text; git sets no share, so its parts at 0.05 stay.
    const written = await curate(task, result);
    expect(written.record.items.filter((item) => item.candidate.sourceId === 'chat').map((item) => item.candidate.id)).toEqual(['p0']);
    // The chat part with p0's text takes p0's answer, so only the two plain ones weigh 0.05.
    const under = result.record.candidates.filter((entry) => entry.sourceId === 'chat' && entry.status === 'selected'
      && 'probability' in entry && entry.probability === 0.05).length;
    expect(under).toBe(2);
    expect(written.record.underShare).toBe(under);
    expect(written.record.items.some((item) => item.candidate.sourceId === 'git' && item.weight === 0.05)).toBe(true);
    // A share of 0 turns the rule off: the text is the one the fixed budget alone gives.
    const off = await pickFromSources([{ ...chat, mode: { ...chat.mode, textShare: 0 } }, source('git', 4)], { task, wholeLanes: true },
      { task, decide, everyRanked: true });
    const plain = await pickFromSources([{ ...chat, mode: { name: 'messages', read: rankedRead } }, source('git', 4)], { task, wholeLanes: true },
      { task, decide, everyRanked: true });
    const [offText, plainText] = await Promise.all([curate(task, off), curate(task, plain)]);
    expect(offText.log).toBe(plainText.log);
    expect(offText.record.underShare).toBe(0);
    expect(offText.log).not.toBe(written.log);
  });
});
