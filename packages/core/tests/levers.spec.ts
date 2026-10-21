import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  curate,
  economy,
  performance,
  pick,
  pickFromSources,
  ROUTE_QUESTIONS,
  type CandidateSource,
  type CuratePrompt,
  type MemoryCandidate,
  type PickAnswer,
  type PickBatch,
  type PickDecide,
} from '../src/index.js';

function candidate(overrides: Partial<MemoryCandidate> & Pick<MemoryCandidate, 'sourceId' | 'id'>): MemoryCandidate {
  return {
    role: 'reference',
    title: overrides.id,
    text: 'plain',
    signals: { score: 0 },
    ...overrides,
  };
}

const answered = (probability: number): PickAnswer => ({ status: 'answered', probability });

function stubDecide(
  handler: (question: PickBatch['questions'][number]) => PickAnswer,
): { decide: PickDecide; calls: PickBatch[] } {
  const calls: PickBatch[] = [];
  return {
    calls,
    decide: async (batch) => {
      calls.push(batch);
      return Object.fromEntries(batch.questions.map((question) => [question.key, handler(question)]));
    },
  };
}

// The distinct parts the decider was asked to decide on. Label and
// route asks carry a `questionKey`; only decide questions lack one, so
// a part's own label questions never count as a decide read.
const decidedIds = (calls: PickBatch[]) => [...new Set(calls.flatMap((batch) => batch.questions)
  .filter((question) => question.questionKey === undefined).map((question) => question.id))];

// A source whose ranked lane carries a clear score curve: one strong
// part, then a tail the curve drops. With `wholeLanes` off the read
// keeps the head only; on keeps them all.
function laneSource(): CandidateSource {
  return {
    id: 'notes', role: 'reference',
    async read(request) {
      const lane = [6, 3, 2, 1, 1, 1].map((score, index) => candidate({
        sourceId: 'notes', id: `p${index}`, laneScore: score,
      }));
      return {
        status: 'read' as const, complete: true,
        candidates: request.wholeLanes === false ? lane.slice(0, 1) : lane,
        ...(request.wholeLanes === false ? { laneCutApplied: true as const } : {}),
      };
    },
  };
}

function writer(text = '[2023-05-13] Visited York (said 2023-05-20; E1)') {
  const calls: CuratePrompt[] = [];
  return {
    calls,
    write: async (prompt: CuratePrompt) => {
      calls.push(prompt);
      return text;
    },
  };
}

const directories: string[] = [];
function store(): string {
  const directory = mkdtempSync(join(tmpdir(), 'curate-levers-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe('levers and presets', () => {
  it('leaves the pick and the curate identical under the performance preset and under no preset', async () => {
    const candidates = [0.9, 0.5, 0.1].map((probability, index) =>
      candidate({ sourceId: 'notes', id: `p${index}`, signals: { score: 1 } }));
    const decide = async (batch: PickBatch) => Object.fromEntries(
      batch.questions.map((question) => [question.key, answered(0.8)]));
    const plain = await pick(candidates, { task: 'Recall the plan', decide });
    const preset = await pick(candidates, { task: 'Recall the plan', decide, ...performance.pick });
    expect(preset.record).toEqual(plain.record);
    expect(preset.selected).toEqual(plain.selected);
    expect(plain.record.levers).toEqual({
      preset: 'performance',
      everyRanked: true,
      everyScored: true,
      labels: false,
      route: false,
      rare: false,
    });

    const readPlain = await pickFromSources([laneSource()], { task: 'task' }, { task: 'task', decide });
    const readPreset = await pickFromSources([laneSource()], { task: 'task', ...performance.read },
      { task: 'task', decide, ...performance.pick });
    expect(readPreset.record).toEqual(readPlain.record);
    expect(readPlain.record.levers).toEqual({
      preset: 'performance', wholeLanes: false,
      everyRanked: true, everyScored: true, labels: false, route: false, rare: false,
    });
  });

  it('reproduces the economic setting under the economy preset', async () => {
    const candidates = [0.9, 0.05, 0.01].map((probability, index) =>
      candidate({ sourceId: 'notes', id: `p${index}`, signals: { score: 1 }, text: `part ${probability}` }));
    const decide = async (batch: PickBatch) => Object.fromEntries(batch.questions.map((question) =>
      [question.key, answered(Number(question.id.slice(1)) === 0 ? 0.9 : Number(question.id.slice(1)) === 1 ? 0.05 : 0.01)]));
    const preset = await pick(candidates, { task: 'Recall the plan', decide, ...economy.pick });
    const literal = await pick(candidates, {
      task: 'Recall the plan', decide, everyScored: { bar: 0.0146 },
    });
    expect(preset.record).toEqual(literal.record);
    expect(preset.selected).toEqual(literal.selected);
    // The economic setting cut references below 0.0146.
    expect(preset.record.thresholds.reference).toBe(0.0146);
    expect(preset.selected.map((item) => item.id)).toEqual(['p0', 'p1']);
    expect(preset.record.levers).toEqual({
      preset: 'economy',
      everyRanked: true,
      everyScored: { bar: 0.0146 },
      labels: false,
      route: false,
      rare: false,
    });

    const read = await pickFromSources([laneSource()], { task: 'task', ...economy.read },
      { task: 'task', decide, ...economy.pick });
    // The lane cut stays on: the curve keeps the head only.
    expect(read.reads[0]?.status === 'read' && read.reads[0].candidates).toHaveLength(1);
    expect(read.record.levers).toEqual({
      preset: 'economy', wholeLanes: false,
      everyRanked: true, everyScored: { bar: 0.0146 }, labels: false, route: false, rare: false,
    });

    const plain = await curate('Recall the plan', preset, { write: writer().write });
    const routed = await curate('Recall the plan', preset, { write: writer().write, ...economy.curate });
    expect(routed.record.working).toBe(plain.record.working);
    expect(plain.record.route).toBeUndefined();
    expect(plain.record.levers.route).toEqual({ asked: false, applied: false });
  });

  it('changes only the flipped lever when a preset is spread and one lever flipped', async () => {
    const parts = Array.from({ length: 100 }, (_, index) =>
      candidate({ sourceId: 'notes', id: `p${index}`, searchRanks: [index], signals: { score: 1 } }));
    const counter = stubDecide(() => answered(0.9));
    const result = await pick(parts, {
      task: 'Recall the plan', decide: counter.decide,
      ...economy.pick, everyRanked: { c: 0.68 },
    });
    // Only everyRanked changed: the decide step read the top 27, the
    // 0.0146 bar still stood, and the record names the mode custom.
    expect(decidedIds(counter.calls)).toHaveLength(27);
    expect(result.record.pick).toEqual({ n: 100, c: 0.68, kept: 27, ranking: 'keyword' });
    expect(result.record.levers).toEqual({
      preset: 'custom',
      everyRanked: { c: 0.68 },
      everyScored: { bar: 0.0146 },
      labels: false,
      route: false,
      rare: false,
    });
    expect(result.record.thresholds.reference).toBe(0.0146);

    const read = await pickFromSources([laneSource()],
      { task: 'task', ...performance.read, wholeLanes: true },
      { task: 'task', decide: stubDecide(() => answered(0.9)).decide, ...performance.pick });
    expect(read.reads[0]?.status === 'read' && read.reads[0].candidates).toHaveLength(6);
    expect(read.record.levers).toEqual({
      preset: 'custom', wholeLanes: true,
      everyRanked: true, everyScored: true, labels: false, route: false, rare: false,
    });
  });

  it('records a keyword–meaning wholeLanes split in both override directions', async () => {
    const embed = async (texts: readonly string[]) => texts.map(() => [1, 0]);
    const decide = stubDecide(() => answered(0.9)).decide;

    // Unset, the meaning lanes follow the keyword lanes' state.
    const followed = await pickFromSources([laneSource()],
      { task: 'task', ...performance.read, meaning: { embed } },
      { task: 'task', decide, ...performance.pick });
    expect(followed.record.levers).toEqual({
      preset: 'performance', wholeLanes: false,
      everyRanked: true, everyScored: true, labels: false, route: false, rare: false,
    });

    // A meaning override that disagrees with the keyword lanes records
    // both resolved states, and no preset holds the split.
    const meaningWhole = await pickFromSources([laneSource()],
      { task: 'task', ...performance.read, meaning: { embed, wholeLanes: true } },
      { task: 'task', decide, ...performance.pick });
    expect(meaningWhole.record.levers.wholeLanes).toEqual({ keyword: false, meaning: true });
    expect(meaningWhole.record.levers.preset).toBe('custom');

    const keywordWhole = await pickFromSources([laneSource()],
      { task: 'task', wholeLanes: true, meaning: { embed, wholeLanes: false } },
      { task: 'task', decide, ...performance.pick });
    expect(keywordWhole.record.levers.wholeLanes).toEqual({ keyword: true, meaning: false });
    expect(keywordWhole.record.levers.preset).toBe('custom');
  });

  it('adds labels to a preset with a caller-supplied store and deciderId', async () => {
    const parts = [
      candidate({ sourceId: 'notes', id: 'lane', searchRanks: [0], signals: { score: 1 } }),
      candidate({ sourceId: 'notes', id: 'pool', poolOnly: true, signals: { score: 0 } }),
    ];
    const counter = stubDecide(() => answered(0.9));
    const result = await pick(parts, {
      task: 'Recall the plan', decide: counter.decide,
      ...performance.pick, labels: { directory: store(), deciderId: 'levers-test' },
    });
    // The label lane admitted the pool part the keyword lane never held.
    expect(decidedIds(counter.calls)).toEqual(expect.arrayContaining(['lane', 'pool']));
    expect(result.record.levers).toEqual({
      preset: 'custom',
      everyRanked: true,
      everyScored: true,
      labels: true,
      route: false,
      rare: false,
    });
  });

  describe("every lever's off state reads no more than its on state", () => {
    it('wholeLanes: off cuts each lane, on reads the whole ranked list', async () => {
      const off = stubDecide(() => answered(0.9));
      const on = stubDecide(() => answered(0.9));
      await pickFromSources([laneSource()], { task: 'task', wholeLanes: false },
        { task: 'task', decide: off.decide });
      const whole = await pickFromSources([laneSource()], { task: 'task', wholeLanes: true },
        { task: 'task', decide: on.decide });
      expect(decidedIds(off.calls)).toEqual(['p0']);
      expect(decidedIds(on.calls)).toHaveLength(6);
      expect(whole.record.levers.wholeLanes).toBe(true);
    });

    it('everyRanked: off keeps the top c × N^0.8, on reads every ranked part', async () => {
      const parts = Array.from({ length: 100 }, (_, index) =>
        candidate({ sourceId: 'notes', id: `p${index}`, searchRanks: [index], signals: { score: 1 } }));
      const off = stubDecide(() => answered(0.9));
      const on = stubDecide(() => answered(0.9));
      await pick(parts, { task: 'task', decide: off.decide, everyRanked: { c: 0.68 } });
      await pick(parts, { task: 'task', decide: on.decide });
      expect(decidedIds(off.calls)).toHaveLength(27);
      expect(decidedIds(on.calls)).toHaveLength(100);
    });

    it('everyScored: off keeps parts at the bar, on keeps every scored part', async () => {
      const parts = [0.9, 0.5, 0.1].map((probability, index) =>
        candidate({ sourceId: 'notes', id: `p${index}`, signals: { score: 1 } }));
      const decide = async (batch: PickBatch) => Object.fromEntries(batch.questions.map((question) =>
        [question.key, answered([0.9, 0.5, 0.1][Number(question.id.slice(1))]!)]));
      const off = await pick(parts, { task: 'task', decide, everyScored: { bar: 0.6 } });
      const on = await pick(parts, { task: 'task', decide });
      expect(off.selected.map((item) => item.id)).toEqual(['p0']);
      expect(on.selected.map((item) => item.id)).toEqual(['p0', 'p1', 'p2']);
    });

    it('labels: off reads only the lanes, on adds the label lane', async () => {
      const parts = [
        candidate({ sourceId: 'notes', id: 'lane', searchRanks: [0], signals: { score: 1 } }),
        candidate({ sourceId: 'notes', id: 'pool', poolOnly: true, signals: { score: 0 } }),
      ];
      const off = stubDecide(() => answered(0.9));
      const on = stubDecide(() => answered(0.9));
      await pick(parts, { task: 'Recall the plan', decide: off.decide });
      await pick(parts, {
        task: 'Recall the plan', decide: on.decide,
        labels: { directory: store(), deciderId: 'levers-test' },
      });
      expect(decidedIds(off.calls)).toEqual(['lane']);
      expect(decidedIds(on.calls)).toEqual(expect.arrayContaining(['lane', 'pool']));
    });

    it('route: off asks no route questions, on asks the four of the task', async () => {
      const parts = [candidate({ sourceId: 'notes', id: 'p0', signals: { score: 1 } })];
      const off = stubDecide(() => answered(0.9));
      const on = stubDecide(() => answered(0.9));
      await pick(parts, { task: 'task', decide: off.decide });
      const routed = await pick(parts, { task: 'task', decide: on.decide, route: 'jev' });
      const questionKeys = (calls: PickBatch[]) => calls.flatMap((batch) => batch.questions)
        .map((question) => question.questionKey).filter(Boolean);
      expect(questionKeys(off.calls)).toHaveLength(0);
      expect(questionKeys(on.calls)).toEqual(ROUTE_QUESTIONS.map((route) => route.key));
      // The decide feed is unchanged: the same part is asked in both.
      expect(decidedIds(off.calls)).toEqual(decidedIds(on.calls));
      expect(routed.record.levers.route).toBe(true);

      // The curate side: off writes no working section, on applies the
      // route answers and adds the working guidance.
      const plain = writer();
      const applied = writer();
      const unrouted = await curate('task', routed, { write: plain.write });
      const routedCurate = await curate('task', routed, { write: applied.write, route: 'jev' });
      expect(unrouted.record.working).toBe(false);
      expect(routedCurate.record.working).toBe(true);
      expect(applied.calls[0]!.instructions).toContain("Working (the curator's");
      expect(plain.calls[0]!.instructions).not.toContain("Working (the curator's");
      // The pick record kept 'asked'; the curate record keeps both
      // route states — the questions asked and the answers applied —
      // and asked alone already spent the questions, so its preset
      // names no preset.
      expect(unrouted.record.levers).toEqual({
        preset: 'custom',
        everyRanked: true, everyScored: true, labels: false,
        route: { asked: true, applied: false }, rare: false,
      });
      expect(routedCurate.record.levers).toEqual({
        preset: 'custom',
        everyRanked: true, everyScored: true, labels: false,
        route: { asked: true, applied: true }, rare: false,
      });
    });

    it('rare: off ends at the selection pass, on pulls rare-word parts in', async () => {
      // 'zephyr' is rare at share 0.5: p0 selects, p7 sits below the
      // top-k keep count and shares it.
      const parts = Array.from({ length: 10 }, (_, index) => candidate({
        sourceId: 'notes', id: `p${index}`, searchRanks: [index], signals: { score: 1 },
        text: index === 0 || index === 7 ? 'plain zephyr' : 'plain',
      }));
      const probabilities = (question: PickBatch['questions'][number]) =>
        answered(question.id === 'p3' ? 0.1 : 0.9);
      const off = stubDecide(probabilities);
      const on = stubDecide(probabilities);
      await pick(parts, { task: 'task', decide: off.decide, everyRanked: { c: 0.68 } });
      const result = await pick(parts, {
        task: 'task', decide: on.decide, everyRanked: { c: 0.68 }, rare: { share: 0.5 },
      });
      expect(decidedIds(off.calls)).toEqual(['p0', 'p1', 'p2', 'p3']);
      expect(decidedIds(on.calls)).toEqual(['p0', 'p1', 'p2', 'p3', 'p7']);
      expect(result.record.pick?.rare?.pulled).toEqual([{ sourceId: 'notes', id: 'p7' }]);
      expect(result.record.levers.rare).toEqual({ share: 0.5, bar: 0.0146 });
    });
  });

  describe('unknown option keys', () => {
    const part = candidate({ sourceId: 'notes', id: 'p0' });
    const decide = () => stubDecide(() => answered(0.9)).decide;

    it('rejects each renamed key with a pointer to its new name', async () => {
      await expect(pick([part], { task: 'task', decide: decide(),
        thresholds: { reference: 0.5 } as never }))
        .rejects.toThrow('`thresholds.reference` is not an option; use `everyScored` (see the README\'s Levers section)');
      await expect(pick([part], { task: 'task', decide: decide(),
        thresholds: { referenceBySize: [[10, 0.5]] } as never }))
        .rejects.toThrow('`thresholds.referenceBySize` is not an option; use `everyScored.bySize`');
      await expect(pick([part], { task: 'task', decide: decide(), pick: { c: 2 } } as never))
        .rejects.toThrow('`pick` is not an option; use `everyRanked`');
      await expect(pickFromSources([laneSource()], { task: 'task', laneCut: true } as never,
        { task: 'task', decide: decide() }))
        .rejects.toThrow('`laneCut` is not an option; use `wholeLanes`');
      const embed = async (texts: readonly string[]) => texts.map(() => [1, 0]);
      await expect(pickFromSources([laneSource()],
        { task: 'task', meaning: { embed, laneCut: true } as never },
        { task: 'task', decide: decide() }))
        .rejects.toThrow('`meaning.laneCut` is not an option; use `meaning.wholeLanes`');
    });

    it('rejects an unknown nested key, naming its path and the keys that level allows', async () => {
      await expect(pick([part], { task: 'task', decide: decide(),
        limits: { maxWidth: 10 } as never }))
        .rejects.toThrow('`limits.maxWidth` is not an option; allowed keys are `maxPerBatch`');
      await expect(pick([part], { task: 'task', decide: decide(),
        everyScored: { braz: 0.5 } as never }))
        .rejects.toThrow('`everyScored.braz` is not an option; allowed keys are `bar`, `bySize`');
      await expect(pickFromSources([laneSource()], { task: 'task', wideLanes: true } as never,
        { task: 'task', decide: decide() }))
        .rejects.toThrow('`wideLanes` is not an option');
      const picked = await pick([part], { task: 'task', decide: decide() });
      await expect(curate('task', picked, { write: writer().write, batching: 4 } as never))
        .rejects.toThrow('`batching` is not an option; allowed keys are `write`');
    });

    it('rejects an unknown key in a kind-keyed map or its settings, before any decide call', async () => {
      const counter = stubDecide(() => answered(0.9));
      const fitted = { bias: 0, questions: [{ key: 'q', instructions: 'i', true: 't', false: 'f', weight: 1 }] };
      await expect(pick([part], { task: 'task', decide: counter.decide,
        cascadesByKind: { markdwon: fitted } as never }))
        .rejects.toThrow('`cascadesByKind.markdwon` is not an option; allowed keys are `chat`, `git-history`, `markdown`');
      await expect(pick([part], { task: 'task', decide: counter.decide,
        tagsByKind: { markdwn: [] } as never }))
        .rejects.toThrow('`tagsByKind.markdwn` is not an option; allowed keys are `chat`, `git-history`, `markdown`');
      await expect(pick([part], { task: 'task', decide: counter.decide,
        ranking: { knwledge: { score: 2 } } as never }))
        .rejects.toThrow('`ranking.knwledge` is not an option; allowed keys are `knowledge`, `docs`, `rules`, `instructions`');
      await expect(pick([part], { task: 'task', decide: counter.decide,
        cascadesByKind: { markdown: { ...fitted, firstonly: { bias: 0, weight: 1 } } } as never }))
        .rejects.toThrow('`cascadesByKind.markdown.firstonly` is not an option; allowed keys are `bias`, `questions`, `first`, `band`, `firstOnly`');
      await expect(pick([part], { task: 'task', decide: counter.decide,
        sourceKinds: { notes: 'markdwon' } as never }))
        .rejects.toThrow("`sourceKinds.notes` names a kind that is not 'chat', 'git-history' or 'markdown'.");
      expect(counter.calls).toHaveLength(0);
    });

    it('rejects an unknown key inside a cascade or tag-set question, before any read or decide call', async () => {
      const counter = stubDecide(() => answered(0.9));
      const fitted = { bias: 0, questions: [{ key: 'q', instructions: 'i', true: 't', false: 'f', weight: 1 }] };
      const tagSet = { key: 'importance', questions: [{ key: 'high', instructions: 'i', true: 't', false: 'f' }] };
      const reads: string[] = [];
      const source: CandidateSource = {
        id: 'notes', role: 'reference', kind: 'markdown',
        read: async (request) => {
          reads.push(request.task);
          return { status: 'read' as const, complete: true, candidates: [part] };
        },
      };
      await expect(pick([part], { task: 'task', decide: counter.decide,
        cascade: { ...fitted, questions: [{ ...fitted.questions[0]!, wieght: 2 }] } } as never))
        .rejects.toThrow('`cascade.questions[0].wieght` is not an option; allowed keys are `key`, `instructions`, `true`, `false`, `weight`');
      await expect(pick([part], { task: 'task', decide: counter.decide,
        cascade: { ...fitted, first: 'q', band: [0.4, 0.6], firstOnly: { bias: 0, wieght: 1 } } } as never))
        .rejects.toThrow('`cascade.firstOnly.wieght` is not an option; allowed keys are `bias`, `weight`');
      await expect(pickFromSources([source], { task: 'task' },
        { task: 'task', decide: counter.decide,
          cascadesByKind: { markdown: { ...fitted, questions: [{ ...fitted.questions[0]!, wieght: 2 }] } } } as never))
        .rejects.toThrow('`cascadesByKind.markdown.questions[0].wieght` is not an option');
      await expect(pick([part], { task: 'task', decide: counter.decide,
        tags: [{ ...tagSet, questions: [{ ...tagSet.questions[0]!, wieght: 2 }] }] } as never))
        .rejects.toThrow('`tags[0].questions[0].wieght` is not an option; allowed keys are `key`, `instructions`, `true`, `false`');
      await expect(pick([part], { task: 'task', decide: counter.decide,
        tagsByKind: { markdown: [{ ...tagSet, questions: [{ ...tagSet.questions[0]!, wieght: 2 }] }] } } as never))
        .rejects.toThrow('`tagsByKind.markdown[0].questions[0].wieght` is not an option');
      expect(reads).toHaveLength(0);
      expect(counter.calls).toHaveLength(0);
    });

    it('lets a preset spread take added known keys', async () => {
      const counter = stubDecide(() => answered(0.9));
      const picked = await pick([part], { task: 'task', decide: counter.decide,
        ...economy.pick, keepTop: 1 });
      expect(picked.record.levers.everyScored).toEqual({ bar: 0.0146 });
      const read = await pickFromSources([laneSource()],
        { task: 'task', ...economy.read, limit: 5 },
        { task: 'task', decide: counter.decide, ...economy.pick });
      expect(read.reads[0]?.status).toBe('read');
      const written = writer();
      const result = await curate('task', picked,
        { write: written.write, ...economy.curate, working: true });
      expect(result.record.working).toBe(true);
    });

    it('throws before any source read, decide call or write', async () => {
      const counter = stubDecide(() => answered(0.9));
      const reads: string[] = [];
      const source: CandidateSource = {
        id: 'notes', role: 'reference',
        read: async (request) => {
          reads.push(request.task);
          return { status: 'read' as const, complete: true, candidates: [part] };
        },
      };
      await expect(pick([part], { task: 'task', decide: counter.decide, bogus: 1 } as never))
        .rejects.toThrow(TypeError);
      await expect(pickFromSources([source], { task: 'task', bogus: 1 } as never,
        { task: 'task', decide: counter.decide }))
        .rejects.toThrow(TypeError);
      await expect(pickFromSources([source], { task: 'task' },
        { task: 'task', decide: counter.decide, bogus: 1 } as never))
        .rejects.toThrow(TypeError);
      const picked = await pick([part], { task: 'task', decide: stubDecide(() => answered(0.9)).decide });
      const written = writer();
      await expect(curate('task', picked, { write: written.write, bogus: 1 } as never))
        .rejects.toThrow(TypeError);
      expect(reads).toHaveLength(0);
      expect(counter.calls).toHaveLength(0);
      expect(written.calls).toHaveLength(0);
    });
  });
});
