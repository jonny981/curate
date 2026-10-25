import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CHAT_CASCADE, chatSettings } from '@curatejs/chat';
import { GIT_HISTORY_CASCADE, gitSettings } from '@curatejs/git';
import { markdownSettings } from '@curatejs/markdown';
import {
  historySource, memory, pick, pickFromSources, type CandidateSource, type PickCascade, type PickDecide,
  type PickQuestion,
} from '@curatejs/core';
import { decide, fixtureSource, parts, task } from './fixtures/source-settings.js';

// The picks the build before questions moved to the sources made on this fixture, asked with
// `cascadesByKind` holding the three presets' sets, one run per entry: the selected ids in
// order, and the SHA-256 of the run's canonical record,
// `JSON.stringify([selected, candidates, labels, requests])`.
interface Baseline {
  readonly selected: readonly string[];
  readonly sha256: string;
}
const baseline: Record<string, Baseline> = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/source-questions-baseline.json'), 'utf8'));

let cache: string;
beforeEach(() => { cache = mkdtempSync(join(tmpdir(), 'curate-questions-per-source-')); vi.stubEnv('XDG_CACHE_HOME', cache); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(cache, { recursive: true, force: true }); });

/** The fixture's decide, keeping every request it was sent. */
function recording() {
  const requests: { readonly task: string; readonly questions: readonly PickQuestion[] }[] = [];
  const how: PickDecide = Object.assign(async (batch: Parameters<PickDecide>[0], signal: AbortSignal) => {
    requests.push(batch);
    return decide(batch, signal);
  }, { deciderId: 'fixture' });
  return { requests, how };
}

const chat = (labels: boolean) =>
  historySource({ reader: fixtureSource('chat', parts('chat', 'chatword'), { rare: false }), ...chatSettings, labels });
const git = () => historySource({ reader: fixtureSource('git', parts('git', 'gitword'), { rare: true }), ...gitSettings });
const markdown = () =>
  historySource({ reader: fixtureSource('markdown', parts('markdown', 'noteword'), { rare: false }), ...markdownSettings });

describe('the presets reproduce the picks made with each kind\'s set passed in', () => {
  it.each([
    ['defaults chat', () => [chat(false)]],
    ['defaults git', () => [git()]],
    ['defaults markdown', () => [markdown()]],
    ['defaults all', () => [chat(false), git(), markdown()]],
    ['chat labels', () => [chat(true)]],
    ['chat labels all', () => [chat(true), git(), markdown()]],
  ] as const)('%s', async (name, sources) => {
    const want = baseline[name]!;
    const { requests, how } = recording();
    const picked = await pickFromSources(sources(), { task }, { task, decide: how });
    const selected = picked.selected.map((c) => c.id);
    const candidates = picked.record.candidates.map((c) => [c.sourceId, c.id, c.status,
      'probability' in c ? c.probability ?? null : null, 'reason' in c ? c.reason ?? null : null]);
    const record = picked.record.labels;
    const labels = record === undefined ? null : [record.asked, record.reused, record.gate];
    const asked = requests.map((r) => r.questions.map((q) => [q.key, q.questionKey ?? null, q.question]));
    expect(selected).toEqual(want.selected);
    const canonical = JSON.stringify([selected, candidates, labels, asked]);
    expect(createHash('sha256').update(canonical).digest('hex'), `${name}: the selections match, `
      + 'but the record entries, label counts or decide requests differ').toBe(want.sha256);
  });
});

/** The decision questions the pick asked about one source's parts. */
const decisionQuestions = (requests: ReturnType<typeof recording>['requests'], sourceId: string) =>
  requests.filter((r) => r.task === task).flatMap((r) => r.questions).filter((q) => q.sourceId === sourceId);

describe('pickFromSources asks each source its own set', () => {
  it('asks a git source the git set with no question option', async () => {
    const { requests, how } = recording();
    const picked = await pickFromSources([git()], { task }, { task, decide: how });
    const asked = decisionQuestions(requests, 'git').filter((q) => q.role === 'reference');
    expect(asked.length).toBeGreaterThan(0);
    for (const q of asked) expect(['current', 'needed', 'when', 'offtopic']).toContain(q.questionKey);
    expect(picked.record.levers.sources.git?.questions).toEqual(GIT_HISTORY_CASCADE);
  });

  it('keeps two sources of one kind on their own sets', async () => {
    const ONE: PickCascade = { bias: 0, questions: [{ key: 'only', instructions: 'Is this part about the task?',
      true: 'It is about the task', false: 'It is not', weight: 1 }] };
    const reader = (id: string, word: string) => ({ ...fixtureSource('chat', parts(id, word), { rare: false }), id });
    const a = historySource({ reader: reader('chat-a', 'aword'), ...chatSettings, labels: false });
    const b = historySource({ reader: reader('chat-b', 'bword'), ...chatSettings, labels: false, questions: ONE });
    const { requests, how } = recording();
    const picked = await pickFromSources([a, b], { task }, { task, decide: how });
    const askedA = decisionQuestions(requests, 'chat-a');
    const askedB = decisionQuestions(requests, 'chat-b');
    expect(askedA.length).toBeGreaterThan(0);
    expect(askedB.length).toBeGreaterThan(0);
    for (const q of askedA) expect(['relevant', 'own', 'needed']).toContain(q.questionKey);
    for (const q of askedB) expect(q.questionKey).toBe('only');
    expect(picked.record.levers.sources['chat-a']?.questions).toEqual(CHAT_CASCADE);
    expect(picked.record.levers.sources['chat-b']?.questions).toEqual(ONE);
  });

  it('asks a source without a set the built-in question', async () => {
    const custom = historySource({ reader: { ...fixtureSource('markdown', parts('custom', 'cword'), { rare: false }), id: 'custom' },
      rare: false, labels: false, names: false, bar: 0.0146 });
    const { requests, how } = recording();
    const picked = await pickFromSources([custom], { task }, { task, decide: how });
    const asked = decisionQuestions(requests, 'custom');
    expect(asked.length).toBeGreaterThan(0);
    for (const q of asked) {
      expect(q.question).toBe('Does this item supply useful evidence, a constraint or a decision for this task?');
      expect(q).not.toHaveProperty('questionKey');
    }
    expect(picked.record.levers.sources.custom).not.toHaveProperty('questions');
  });
});

describe('nothing else sets questions', () => {
  const sources = (): CandidateSource[] => [chat(false)];

  it('pick refuses cascade', async () => {
    await expect(pick(parts('chat', 'chatword'), { task, decide, cascade: CHAT_CASCADE } as never))
      .rejects.toThrow(TypeError);
    await expect(pick(parts('chat', 'chatword'), { task, decide, cascade: CHAT_CASCADE } as never))
      .rejects.toThrow(/`cascade` is not an option/);
  });

  it('pickFromSources refuses cascadesByKind', async () => {
    const call = () => pickFromSources(sources(), { task },
      { task, decide, cascadesByKind: { chat: CHAT_CASCADE } } as never);
    await expect(call()).rejects.toThrow(TypeError);
    await expect(call()).rejects.toThrow(/`cascadesByKind` is not an option/);
  });

  it('memory refuses cascadesByKind before any read', async () => {
    const read = vi.fn(async () => ({ status: 'read' as const, complete: true, candidates: [] }));
    const source: CandidateSource = { ...chat(false), read };
    const write = vi.fn(async () => '');
    const recall = () => memory({ sources: [source], decide, write,
      pick: { cascadesByKind: { chat: CHAT_CASCADE } } as never }).recall(task);
    await expect(recall()).rejects.toThrow(TypeError);
    await expect(recall()).rejects.toThrow(/`cascadesByKind` is not an option/);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
