import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  historySource, pickFromSources, type CandidateSource, type HistorySettings, type MemoryCandidate,
  type PickDecide, type PickSourcesResult,
} from '../src/index.js';
import { decide, fixtureSource, parts, task } from './fixtures/source-settings.js';

// The picks the build before settings moved to the sources made on this fixture, one run per entry.
interface Baseline {
  readonly selected: readonly string[];
  readonly candidates: readonly unknown[][];
  readonly everyRanked: unknown;
  readonly route: boolean;
  readonly wholeLanes: unknown;
  readonly rare: false | { readonly share: number; readonly bar: number };
  readonly labels: { readonly asked: number; readonly gate: number } | null;
}
const baseline: Record<string, Baseline> = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/source-settings-baseline.json'), 'utf8'));

// The presets' settings without their question sets, as the baseline ran them: it was recorded with the
// built-in decision question.
const chatSettings: HistorySettings = { rare: false, labels: true, bar: 0.0146 };
const gitSettings: HistorySettings = { rare: true, labels: false, bar: 0.0146 };
const markdownSettings: HistorySettings = { rare: true, labels: false, bar: 0.0146 };

const sharedWords = (word: string) => Array.from({ length: 20 }, (_, i) => `${word}${i * 10}`).join(' ');
const chat = (settings: Partial<HistorySettings> = {}, pool = parts('chat', 'chatword')) =>
  historySource({ reader: fixtureSource('chat', pool, { rare: false }), ...chatSettings, ...settings });
const git = (settings: Partial<HistorySettings> = {}, pool = parts('git', 'gitword')) =>
  historySource({ reader: fixtureSource('git', pool, { rare: false }), ...gitSettings, ...settings });
const markdown = (settings: Partial<HistorySettings> = {}, pool = parts('markdown', 'noteword')) =>
  historySource({ reader: fixtureSource('markdown', pool, { rare: false }), ...markdownSettings, ...settings });

let cache: string;
beforeEach(() => { cache = mkdtempSync(join(tmpdir(), 'curate-source-settings-')); vi.stubEnv('XDG_CACHE_HOME', cache); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(cache, { recursive: true, force: true }); });

const run = (sources: readonly CandidateSource[], how: PickDecide = decide) =>
  pickFromSources(sources, { task }, { task, decide: how });

async function expectBaseline(sources: readonly CandidateSource[], name: string) {
  const want = baseline[name]!;
  const picked = await run(sources);
  expect(picked.selected.map((c) => c.id)).toEqual(want.selected);
  expect(picked.record.candidates.map((c) => [c.sourceId, c.id, c.status,
    'probability' in c ? c.probability ?? null : null, 'reason' in c ? c.reason ?? null : null])).toEqual(want.candidates);
  const labels = picked.record.labels;
  expect(labels === undefined ? null : { asked: labels.asked, gate: labels.gate })
    .toEqual(want.labels === null ? null : { asked: want.labels.asked, gate: want.labels.gate });
  const { everyRanked, route, wholeLanes, rare } = picked.record.levers;
  expect({ everyRanked, route, wholeLanes }).toEqual({ everyRanked: want.everyRanked, route: want.route, wholeLanes: want.wholeLanes });
  expect(rare).toEqual(want.rare === false ? false : { share: want.rare.share, bar: want.rare.bar });
  expect(picked.record.levers).not.toHaveProperty('everyScored');
  return picked;
}

const presetSettings = {
  chat: { kind: 'chat', labels: true, labelBar: 0.5, rare: false, bar: 0.0146 },
  git: { kind: 'git-history', labels: false, rare: true, bar: 0.0146 },
  markdown: { kind: 'markdown', labels: false, rare: true, bar: 0.0146 },
} as const;

describe('the presets reproduce the picks made before settings moved to the sources', () => {
  it.each([
    ['chat labels', () => [chat()]],
    ['defaults git', () => [git()]],
    ['defaults markdown', () => [markdown()]],
    ['chat labels all', () => [chat(), git(), markdown()]],
  ] as const)('%s', async (name, sources) => {
    const read = sources();
    const picked = await expectBaseline(read, name);
    expect(picked.record.levers.sources).toEqual(Object.fromEntries(read.map((s) => [s.id, presetSettings[s.id as keyof typeof presetSettings]])));
  });

  it.each([
    ['defaults chat', () => [chat({ labels: false })]],
    ['defaults all', () => [chat({ labels: false }), git(), markdown()]],
  ] as const)('%s, with chat read through historySource and labels off', async (name, sources) => {
    const picked = await expectBaseline(sources(), name);
    expect(picked.record.levers.sources.chat).toEqual({ kind: 'chat', labels: false, rare: false, bar: 0.0146 });
  });

  it('names the kind of a source that returns no parts', async () => {
    const picked = await run([chat({}, []), git({}, []), markdown({}, [])]);
    expect(picked.selected).toEqual([]);
    expect(picked.record.levers.sources).toEqual(presetSettings);
  });
});

/** One source's parts in the record and the selection: ids, statuses and probabilities. */
function view(picked: PickSourcesResult, sourceId: string) {
  return {
    record: picked.record.candidates.filter((c) => c.sourceId === sourceId)
      .map((c) => [c.id, c.status, 'probability' in c ? c.probability ?? null : null]),
    selected: picked.selected.filter((c) => c.sourceId === sourceId).map((c) => c.id),
  };
}

describe('a setting on one source never changes another source\'s pick', () => {
  it('chat labels leave git and Markdown unchanged', async () => {
    const off = await run([chat({ labels: false }), git(), markdown()]);
    const on = await run([chat(), git(), markdown()]);
    expect(view(on, 'chat')).not.toEqual(view(off, 'chat'));
    for (const id of ['git', 'markdown']) expect(view(on, id)).toEqual(view(off, id));
  });

  it('git\'s rare-word round leaves chat and Markdown unchanged when Markdown\'s rare words are common in git', async () => {
    const pool = parts('git', 'gitword', sharedWords('noteword'));
    const on = await run([chat(), git({}, pool), markdown()]);
    const off = await run([chat(), git({ rare: false }, pool), markdown()]);
    expect(view(on, 'git')).not.toEqual(view(off, 'git'));
    for (const id of ['chat', 'markdown']) expect(view(on, id)).toEqual(view(off, id));
  });

  it('Markdown\'s rare-word round leaves chat and git unchanged when git\'s rare words are common in Markdown', async () => {
    const pool = parts('markdown', 'noteword', sharedWords('gitword'));
    const on = await run([chat(), git(), markdown({}, pool)]);
    const off = await run([chat(), git(), markdown({ rare: false }, pool)]);
    expect(view(on, 'markdown')).not.toEqual(view(off, 'markdown'));
    for (const id of ['chat', 'git']) expect(view(on, id)).toEqual(view(off, id));
  });

  it.each(['chat', 'git', 'markdown'] as const)('a higher %s bar leaves the other two unchanged', async (changed) => {
    const sources = (bar: number) => [chat(changed === 'chat' ? { bar } : {}),
      git(changed === 'git' ? { bar } : {}), markdown(changed === 'markdown' ? { bar } : {})];
    const low = await run(sources(0.0146));
    const high = await run(sources(0.5));
    expect(high.record.levers.sources[changed]?.bar).toBe(0.5);
    expect(view(high, changed)).not.toEqual(view(low, changed));
    for (const id of ['chat', 'git', 'markdown'].filter((id) => id !== changed)) expect(view(high, id)).toEqual(view(low, id));
  });

  it('moves a Markdown note only through a commit that changed it', async () => {
    const part = (sourceId: string, id: string, fields: Partial<MemoryCandidate>): MemoryCandidate => ({
      sourceId, id, title: id, text: `deploy billing ${id}`, role: 'reference', signals: { keyword: 1 },
      repository: 'repo-1', ...fields,
    });
    const reader = (id: string, candidates: readonly MemoryCandidate[]): CandidateSource => ({
      id, role: 'reference', read: async () => ({ status: 'read', complete: true, candidates }) });
    const commits = reader('git', [part('git', 'commit', { changedPaths: ['docs/ops.md'] })]);
    const notes = historySource({ reader: reader('markdown', [part('markdown', 'ops', { path: 'docs/ops.md' }),
      part('markdown', 'other', { path: 'docs/other.md' })]), ...markdownSettings, bar: 0.6 });
    const answers: Record<string, number> = { commit: 0.9, ops: 0.45, other: 0.45 };
    const fixed: PickDecide = async ({ questions }) =>
      Object.fromEntries(questions.map((q) => [q.key, { status: 'answered', probability: answers[q.id]! }]));
    const entry = (picked: PickSourcesResult, id: string) => picked.record.candidates.find((c) => c.id === id);

    const carried = await run([historySource({ reader: commits, ...gitSettings }), notes], fixed);
    expect(entry(carried, 'commit')).toMatchObject({ status: 'selected', probability: 0.9 });
    expect(entry(carried, 'ops')).toMatchObject({ status: 'selected', probability: 0.45, link: { sourceId: 'git', id: 'commit' } });
    expect(entry(carried, 'other')).toMatchObject({ status: 'rejected', probability: 0.45 });

    const dropped = await run([historySource({ reader: commits, ...gitSettings, bar: 0.95 }), notes], fixed);
    expect(entry(dropped, 'commit')).toMatchObject({ status: 'rejected', probability: 0.9 });
    expect(entry(dropped, 'ops')).toMatchObject({ status: 'rejected', probability: 0.45 });
    expect(entry(dropped, 'ops')).not.toHaveProperty('link');
    const others = (picked: PickSourcesResult) => view(picked, 'markdown').record.filter(([id]) => id !== 'ops');
    expect(others(dropped)).toEqual(others(carried));
  });
});
