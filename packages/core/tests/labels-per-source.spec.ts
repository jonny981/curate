import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LABEL_KINDS, ROUTE_QUESTIONS, memory, pick, pickFromSources,
  type CandidateSource, type LabelKind, type MemoryCandidate, type PickDecide, type PickQuestion } from '../src/index.js';

const task = 'Which constraint applies?';
const custom: readonly LabelKind[] = [{ key: 'constraint', name: 'a system constraint',
  part: { true: 'The excerpt states a system constraint.', false: 'The excerpt states no system constraint.' } }];
const part = (sourceId: string, id = 'hit', poolOnly = false): MemoryCandidate => ({
  sourceId, id, role: 'reference', title: id, text: `Evidence ${id}.`, signals: { keyword: 1 },
  ...(poolOnly ? { poolOnly: true } : {}),
});
function source(id: string, labelKinds?: readonly LabelKind[]): CandidateSource {
  return { id, role: 'reference', labelKinds, read: vi.fn(async (request) => ({
    status: 'read' as const, complete: true, laneCutApplied: true,
    candidates: request.wholeLanes ? [part(id), part(id, 'extra')] : [part(id)],
  })) };
}
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'curate-source-labels-'));
  vi.stubEnv('XDG_CACHE_HOME', directory);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
const recorder = (probability: (q: PickQuestion) => number = () => 0.9) => {
  const questions: PickQuestion[] = [];
  const decide: PickDecide = async (batch) => {
    questions.push(...batch.questions);
    return Object.fromEntries(batch.questions.map((q) => [q.key, { status: 'answered', probability: probability(q) }]));
  };
  return { questions, decide };
};

describe('label kinds per source', () => {
  it('labels chat parts, leaves git parts on keyword decisions, and records both sets', async () => {
    const chat = source('chat', LABEL_KINDS);
    const git = source('git');
    const calls = recorder((q) => q.questionKey === undefined ? 0.9 : 0);
    const result = await pickFromSources([chat, git], { task }, { task, decide: calls.decide, everyRanked: true });
    // Identical texts share one keyword decision; the representative may
    // sit on either source, so the git part's check is its selection.
    expect(calls.questions.filter((q) => q.questionKey === undefined)).toHaveLength(1);
    expect(calls.questions.filter((q) => q.sourceId === 'chat' && q.questionKey)).toHaveLength(14);
    expect(result.selected.map((c) => `${c.sourceId}/${c.id}`).sort()).toEqual(['chat/hit', 'git/hit']);
    expect(git.read).toHaveBeenCalledTimes(1);
    expect(chat.read).toHaveBeenCalledTimes(2);
    expect(result.record.labelKindsBySource).toEqual({ chat: LABEL_KINDS, git: [] });
  });

  it('does no label work when direct candidates have no declared kinds', async () => {
    const calls = recorder();
    const result = await pick([part('git')], { task, decide: calls.decide });
    expect(calls.questions).toHaveLength(1);
    expect(calls.questions[0]?.questionKey).toBeUndefined();
    expect(readdirSync(directory)).toEqual([]);
    expect(result.record.labelKindsBySource).toEqual({ git: [] });
  });

  it('keeps different kind definitions out of each other\'s saved labels', async () => {
    const calls = recorder();
    const other = [{ ...custom[0]!, part: { ...custom[0]!.part, true: 'The excerpt states a different constraint.' } }];
    const run = (kinds: readonly LabelKind[]) => pick([part('notes')], {
      task, decide: calls.decide, labelKindsBySource: { notes: kinds },
    });
    await run(custom);
    const changed = await run(other);
    expect(changed.record.labels).toMatchObject({ asked: 2, reused: 0 });
    expect((await run(custom)).record.labels).toMatchObject({ asked: 0, reused: 2 });
    expect(readdirSync(join(directory, 'curate', 'labels'))).toHaveLength(4);
  });

  it('asks task needs once for equal kind definitions on different sources', async () => {
    const calls = recorder();
    const reordered = [{ part: { false: custom[0]!.part.false, true: custom[0]!.part.true },
      name: custom[0]!.name, key: custom[0]!.key }];
    const result = await pickFromSources([source('one', custom), source('two', reordered)], { task },
      { task, decide: calls.decide, everyRanked: true });
    expect(calls.questions.filter((q) => q.sourceId === 'labels')).toHaveLength(1);
    expect(result.selected).toHaveLength(4);
    expect(calls.questions.filter((q) => q.questionKey === 'constraint').every((q) =>
      !q.trueCriterion.includes('past conversations'))).toBe(true);
  });

  it('asks routes once across kind sets, without a custom key replacing a route answer', async () => {
    const taste = [{ ...custom[0]!, key: 'taste' }];
    const calls = recorder((q) => ROUTE_QUESTIONS.some((route) => route.question === q.question) ? 0 : 0.9);
    const run = () => pickFromSources([source('one', custom), source('two', taste)], { task }, {
      task, decide: calls.decide, everyRanked: true, route: 'jev',
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      calls.questions.length = 0;
      const result = await run();
      expect(result.record.route?.answers).toHaveLength(4);
      expect(result.record.route?.on).toEqual([]);
      expect(calls.questions.filter((q) => ROUTE_QUESTIONS.some((route) => route.question === q.question))).toHaveLength(4);
      expect(result.selected).toHaveLength(4);
    }
  });

  it('does not use one task set to hide missing answers in another', async () => {
    const other = [{ ...custom[0]!, key: 'other' }];
    const decide: PickDecide = async ({ questions }) => Object.fromEntries(questions.map((q) => [q.key,
      q.sourceId === 'labels' && q.questionKey === 'other' ? { status: 'missing' }
        : { status: 'answered', probability: q.questionKey === undefined ? 0.9 : 0 },
    ]));
    const write = vi.fn(async () => '[2026-01-12] A constraint (said 2026-01-12; E1)');
    await expect(memory({ sources: [source('one', custom), source('two', other)], decide, write,
      pick: { everyRanked: true } }).recall(task))
      .rejects.toMatchObject({ cause: { record: { candidates: expect.arrayContaining([
        expect.objectContaining({ sourceId: 'two', id: 'extra', status: 'unassessed', reason: 'limits' }),
      ]) } } });
    expect(write).not.toHaveBeenCalled();
  });

  it('records empty readers and actual candidate source IDs, and no kinds for a reader that carries none', async () => {
    const reader: CandidateSource = { id: 'reader', role: 'reference', labelKinds: custom,
      read: async () => ({ status: 'read', complete: true, candidates: [part('returned')] }) };
    const empty: CandidateSource = { id: 'empty', role: 'reference', read: async () => ({ status: 'read', complete: true, candidates: [] }) };
    const calls = recorder();
    const enabled = await pickFromSources([reader, empty], { task }, { task, decide: calls.decide });
    expect(enabled.record.labelKindsBySource).toEqual({ reader: custom, returned: custom, empty: [] });
    const { labelKinds: _kinds, ...plain } = reader;
    const disabled = await pickFromSources([plain, empty], { task }, { task, decide: calls.decide });
    expect(disabled.record.labelKindsBySource).toEqual({ reader: [], returned: [], empty: [] });
  });

  it('rejects duplicate kind keys before reading a source or deciding', async () => {
    const reader = source('notes', [custom[0]!, custom[0]!]);
    const calls = recorder();
    await expect(pickFromSources([reader], { task }, { task, decide: calls.decide })).rejects.toThrow(/unique/);
    expect(reader.read).not.toHaveBeenCalled();
    expect(calls.questions).toEqual([]);
  });
});
