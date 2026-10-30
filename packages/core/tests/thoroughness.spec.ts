import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  LABEL_KINDS, THOROUGHNESS, laneBend, memory, pick, pickFromSources,
  type CandidateSource, type MemoryCandidate, type PickAnswer, type PickBatch, type PickCache, type PickDecide,
  type Thoroughness,
} from '../src/index.js';

function candidate(overrides: Partial<MemoryCandidate> & Pick<MemoryCandidate, 'sourceId' | 'id'>): MemoryCandidate {
  return {
    role: 'reference',
    title: overrides.id,
    text: `text of ${overrides.sourceId}/${overrides.id}`,
    signals: { score: 0 },
    ...overrides,
  };
}

function answered(probability: number): PickAnswer {
  return { status: 'answered', probability };
}

function stubDecide(
  handler: (batch: PickBatch, call: number) => Record<string, PickAnswer>,
): { decide: PickDecide; calls: PickBatch[] } {
  const calls: PickBatch[] = [];
  return {
    calls,
    decide: async (batch) => {
      calls.push(batch);
      return handler(batch, calls.length);
    },
  };
}

function allAnswered(batch: PickBatch, probability: number): Record<string, PickAnswer> {
  return Object.fromEntries(batch.questions.map((question) => [question.key, answered(probability)]));
}

/** `count` parts ranked 0..count-1 in a single keyword lane: every part
 *  is a fused-order member, best first. */
const ranked = (sourceId: string, count: number): MemoryCandidate[] =>
  Array.from({ length: count }, (_, i) => candidate({ sourceId, id: `p${i}`, searchRanks: [i] }));

const directories: string[] = [];
function store(): string {
  const directory = mkdtempSync(join(tmpdir(), 'curate-thoroughness-'));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

const askedPartIds = (calls: readonly PickBatch[]) =>
  new Set(calls.flatMap((batch) => batch.questions.filter((q) => q.sourceId !== 'labels').map((q) => q.id)));

describe('thoroughness', () => {
  it.each(['quick', 'deep'] as const)('parts outside the order grow the history, not the send list: %s', async (level) => {
    const depth = THOROUGHNESS[level];
    // The real read path: a reader that keyword-scores its parts like a
    // production reader, and a stand-in embed that puts every added
    // part far from the task, so only a faulty meaning position could
    // bring one into the feed.
    const related = Array.from({ length: depth + 20 }, (_, i) => candidate({
      sourceId: 'notes', id: `p${i}`, text: `the plan note ${i}` }));
    const unrelated = Array.from({ length: depth }, (_, i) => candidate({
      sourceId: 'notes', id: `u${i}`, text: `unrelated filler ${i}` }));
    const keywordScore = (task: string, part: MemoryCandidate) => {
      const terms = new Set(task.toLowerCase().match(/[a-z]{3,}/g) ?? []);
      const haystack = `${part.title} ${part.text}`.toLowerCase();
      return [...terms].filter((term) => haystack.includes(term)).length;
    };
    const history = (parts: MemoryCandidate[]): CandidateSource => ({
      id: 'notes', role: 'reference',
      read: async (request) => {
        if (request.meaningLane !== undefined) {
          return { status: 'read', complete: true, candidates: [] };
        }
        if (request.wholeLanes === true) {
          return { status: 'read', complete: true, candidates: parts };
        }
        const matched = parts.map((part) => ({ part, hits: keywordScore(request.task, part) }))
          .filter(({ hits }) => hits > 0)
          .sort((a, b) => b.hits - a.hits || a.part.id.localeCompare(b.part.id));
        return { status: 'read', complete: true, laneCutApplied: true,
          candidates: matched.map(({ part, hits }) =>
            ({ ...part, signals: { keyword: hits }, laneScore: hits })) };
      },
    });
    const embed = async (texts: readonly string[]) =>
      texts.map((text) => (text.startsWith('unrelated') ? [0, 1] : [1, 0]));
    const request = { task: 'recall the plan', meaning: { embed } };

    const first = stubDecide((batch) => allAnswered(batch, 0.9));
    const bare = await pickFromSources([history(related)], request,
      { task: 'recall the plan', decide: first.decide, thoroughness: level });
    expect(bare.record.pick).toMatchObject({ n: depth + 20, sent: depth, questions: depth, kept: depth,
      thoroughness: { level, depth }, ranking: 'fusion' });

    const second = stubDecide((batch) => allAnswered(batch, 0.9));
    const crowded = await pickFromSources([history([...related, ...unrelated])], request,
      { task: 'recall the plan', decide: second.decide, thoroughness: level });
    expect(crowded.record.pick).toMatchObject({
      n: 2 * depth + 20, sent: bare.record.pick!.sent, questions: bare.record.pick!.questions, kept: depth });
    expect(askedPartIds(second.calls)).toEqual(askedPartIds(first.calls));
    const off = crowded.record.candidates.filter((entry) => entry.id.startsWith('u'));
    expect(off).toHaveLength(depth);
    expect(off.every((entry) => entry.status === 'unassessed' && entry.reason === 'thoroughness')).toBe(true);
  });

  it('never sends past the depth, however the rare-word round or the label lane reaches', async () => {
    const depth = THOROUGHNESS.quick;
    const parts = ranked('notes', depth + 20);
    // A word only the top part and one below the depth share: the rare
    // round pulls it, but the depth is already spent, so it is not asked.
    const below = `p${depth + 10}`;
    parts[0] = { ...parts[0]!, text: `${parts[0]!.text} zebra` };
    parts[depth + 10] = { ...parts[depth + 10]!, text: `${parts[depth + 10]!.text} zebra` };
    const { decide, calls } = stubDecide((batch) => allAnswered(batch, 0.9));

    const picked = await pick(parts, {
      task: 'recall the plan', decide, thoroughness: 'quick', rare: true,
      labels: { directory: store(), deciderId: 'test-decider' },
      labelKindsBySource: { notes: LABEL_KINDS },
    });
    const inside = new Set(Array.from({ length: depth }, (_, i) => `p${i}`));
    expect(askedPartIds(calls)).toEqual(inside);
    expect(picked.record.pick!.sent).toBe(depth);
    expect(picked.record.pick!.questions).toBe(depth);
    // The round pulled the part on the shared rare word; the depth's room was spent.
    const rare = picked.record.pick!.rare!;
    expect(rare.pulled.map((entry) => entry.id)).toContain(below);
    expect(rare.asked).toBe(0);
    expect(rare.added).toBe(0);
    expect(picked.record.candidates.find((entry) => entry.id === below))
      .toMatchObject({ status: 'unassessed', reason: 'thoroughness' });
  });

  it('the rare-word round finds no free room when shared texts answered the depth', async () => {
    const depth = THOROUGHNESS.quick;
    const parts = ranked('notes', depth + 20);
    // Every part past the first shares one text, so two port sends
    // answer the whole short list; counting sends alone would leave
    // the depth looking nearly empty.
    for (let i = 1; i < depth; i += 1) {
      parts[i] = { ...parts[i]!, text: 'one shared text' };
    }
    // A word only the top part and one below the depth share: the
    // round pulls it, but the depth is already spent.
    const below = `p${depth + 10}`;
    parts[0] = { ...parts[0]!, text: `${parts[0]!.text} zebra` };
    parts[depth + 10] = { ...parts[depth + 10]!, text: `${parts[depth + 10]!.text} zebra` };
    const { decide, calls } = stubDecide((batch) => allAnswered(batch, 0.9));

    const picked = await pick(parts, {
      task: 'recall the plan', decide, thoroughness: 'quick', rare: true });
    expect(picked.record.pick!.sent).toBe(2);
    expect(askedPartIds(calls)).toEqual(new Set(['p0', 'p1']));
    const rare = picked.record.pick!.rare!;
    expect(rare.pulled.map((entry) => entry.id)).toContain(below);
    expect(rare.asked).toBe(0);
    expect(rare.added).toBe(0);
    expect(picked.record.candidates.find((entry) => entry.id === below))
      .toMatchObject({ status: 'unassessed', reason: 'thoroughness' });
  });

  it('the rare-word round finds no free room when the cache answered the depth', async () => {
    const depth = THOROUGHNESS.quick;
    const parts = ranked('notes', depth + 20);
    const below = `p${depth + 10}`;
    parts[0] = { ...parts[0]!, text: `${parts[0]!.text} zebra` };
    parts[depth + 10] = { ...parts[depth + 10]!, text: `${parts[depth + 10]!.text} zebra` };
    const backing = new Map<string, unknown>();
    const cache: PickCache = {
      store: {
        get: async (key) => backing.get(key),
        set: async (key, value) => { backing.set(key, value); },
      },
      deciderId: 'test-decider',
    };

    // The first call fills the store with the depth already spent, so
    // the round asked nothing.
    const first = stubDecide((batch) => allAnswered(batch, 0.9));
    const filled = await pick(parts, {
      task: 'recall the plan', decide: first.decide, thoroughness: 'quick', rare: true, cache });
    expect(filled.record.pick!.sent).toBe(depth);

    // The repeat call's first pass answers wholly from the store:
    // counting port sends alone would leave the depth looking empty.
    const second = stubDecide((batch) => allAnswered(batch, 0.9));
    const picked = await pick(parts, {
      task: 'recall the plan', decide: second.decide, thoroughness: 'quick', rare: true, cache });
    expect(second.calls).toHaveLength(0);
    expect(picked.record.pick!.sent).toBe(0);
    const rare = picked.record.pick!.rare!;
    expect(rare.pulled.map((entry) => entry.id)).toContain(below);
    expect(rare.asked).toBe(0);
    expect(rare.added).toBe(0);
    expect(picked.record.candidates.find((entry) => entry.id === below))
      .toMatchObject({ status: 'unassessed', reason: 'thoroughness' });
  });

  it("the rare-word round asks into the depth's free room: a 100-part history at deep", async () => {
    const parts = ranked('notes', 100);
    parts[0] = { ...parts[0]!, text: `${parts[0]!.text} zephyr` };
    // A pool member no lane ranked, sharing a rare word with the
    // selected top part: the round pulls it and the depth has room.
    const pooled = candidate({ sourceId: 'notes', id: 'pool', poolOnly: true, text: 'a zephyr note' });
    const { decide, calls } = stubDecide((batch) => allAnswered(batch, 0.9));

    const picked = await pick([...parts, pooled], {
      task: 'recall the plan', decide, rare: { share: 0.5 } });
    expect(picked.record.pick!.sent).toBe(101);
    expect(askedPartIds(calls)).toContain('pool');
    expect(picked.record.pick!.rare).toMatchObject({ asked: 1, added: 1 });
    expect(picked.record.candidates.find((entry) => entry.id === 'pool'))
      .toMatchObject({ status: 'selected', asked: true });
  });

  it('the fused order decides who is in, not a part from each source in turn', async () => {
    // lane 0: b0, b1, b2 (length 3). lane 1: a0, a1 (length 2). Shares:
    // a0 and b0 both 1, then b1 2/3, a1 1/2, b2 1/3. The fused top three
    // are a0, b0, b1; one-from-each-source would send b2 for a0.
    const parts = [
      candidate({ sourceId: 'a', id: 'a0', searchRanks: [null, 0] }),
      candidate({ sourceId: 'a', id: 'a1', searchRanks: [null, 1] }),
      candidate({ sourceId: 'b', id: 'b0', searchRanks: [0] }),
      candidate({ sourceId: 'b', id: 'b1', searchRanks: [1] }),
      candidate({ sourceId: 'b', id: 'b2', searchRanks: [2] }),
    ];
    const level: Thoroughness = 'quick';
    const keep = THOROUGHNESS[level];
    THOROUGHNESS[level] = 3;
    try {
      const { decide, calls } = stubDecide((batch) => allAnswered(batch, 0.9));
      const picked = await pick(parts, { task: 'recall the plan', decide, thoroughness: level });
      expect(askedPartIds(calls)).toEqual(new Set(['a0', 'b0', 'b1']));
      expect(picked.selected.map((item) => item.id)).toEqual(['a0', 'b0', 'b1']);
      expect(picked.record.candidates.filter((entry) =>
        entry.status === 'unassessed' && entry.reason === 'thoroughness').map((entry) => entry.id))
        .toEqual(['a1', 'b2']);
    } finally {
      THOROUGHNESS[level] = keep;
    }
  });

  it('the reader path and the scored path give a part the same meaning position', async () => {
    // q0's bend keeps p3, q1's cuts it — but q1 is p3's best similarity,
    // so its meaning position .41 ranks it above p2's .4. A read path
    // that scores a part only over the lanes that kept it places p2.
    const level: Thoroughness = 'quick';
    const restore = THOROUGHNESS[level];
    THOROUGHNESS[level] = 3;
    try {
      const unit = (x: number, y: number) => [x, y, Math.sqrt(1 - x * x - y * y)];
      // Each part vector's first two components are its exact cosine
      // similarities to q0 = [1,0,0] and q1 = [0,1,0].
      const vectors: Record<string, number[]> = {
        q0: [1, 0, 0], q1: [0, 1, 0],
        p1: unit(0.45, 0.45), p2: unit(0.4, 0.4), p3: unit(0.35, 0.41),
        p4: unit(0.1, 0.425), p5: unit(0.05, 0.405),
      };
      const embed = async (texts: readonly string[]) => texts.map((text) => vectors[text.slice(-2)]!);
      const cosine = (a: ArrayLike<number>, b: ArrayLike<number>) => {
        let dot = 0, sa = 0, sb = 0;
        for (let i = 0; i < a.length; i += 1) { dot += a[i]! * b[i]!; sa += a[i]! ** 2; sb += b[i]! ** 2; }
        return dot / Math.sqrt(sa * sb);
      };
      const parts = ['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => candidate({ sourceId: 'notes', id }));
      // A streaming reader's meaning lane: sims inside the read, the
      // bend kept or marked, never the keyword scorer's union.
      const streaming: CandidateSource = {
        id: 'notes', role: 'reference',
        read: async (request) => {
          if (request.meaningLane === undefined) {
            return { status: 'read', complete: true,
              candidates: request.wholeLanes === true ? parts : [] };
          }
          const [query] = await request.meaningLane.embed([request.task]);
          const scored = await Promise.all(parts.map(async (part) => ({
            part, sim: cosine(query!, (await request.meaningLane!.embed([part.text]))[0]!),
          })));
          scored.sort((a, b) => b.sim - a.sim || a.part.id.localeCompare(b.part.id));
          const matched = scored.some(({ sim }) => sim > 0);
          const bend = laneBend(scored.map(({ sim }) => sim));
          const passes = (sim: number) => bend === undefined ? matched : sim > bend;
          const kept = request.wholeLanes === false ? scored.filter(({ sim }) => passes(sim)) : scored;
          return { status: 'read', complete: true, meaningLane: true, matched: parts.length,
            ...(request.wholeLanes === false ? { laneCutApplied: true } : {}),
            candidates: kept.map(({ part, sim }) => ({ ...part,
              signals: { similarity: sim }, laneScore: sim,
              ...(request.wholeLanes === true && !passes(sim) ? { pastLaneCut: true as const } : {}) })) };
        },
      };
      // A reader that answers every read as a keyword read leaves the
      // pool to the pick's own scorer.
      const plain: CandidateSource = {
        id: 'notes', role: 'reference',
        read: async (request) => ({ status: 'read', complete: true,
          candidates: request.wholeLanes === true ? parts : [] }),
      };
      const request = { task: 'q0', searchLines: ['q1'], meaning: { embed } };
      const first = stubDecide((batch) => allAnswered(batch, 0.9));
      const second = stubDecide((batch) => allAnswered(batch, 0.9));
      const readerPath = await pickFromSources([streaming], request,
        { task: 'q0', decide: first.decide, thoroughness: level });
      const scoredPath = await pickFromSources([plain], request,
        { task: 'q0', decide: second.decide, thoroughness: level });
      const scores = (result: typeof readerPath) => new Map(
        (result.reads[0]?.status === 'read' ? result.reads[0].candidates : [])
          .map((part) => [part.id, part.meaningScore]));
      expect(scores(readerPath)).toEqual(scores(scoredPath));
      expect(scores(scoredPath).get('p3')).toBeCloseTo(0.41);
      expect(askedPartIds(first.calls)).toEqual(askedPartIds(second.calls));
      expect([...askedPartIds(second.calls)].sort()).toEqual(['p1', 'p3', 'p4']);
    } finally {
      THOROUGHNESS[level] = restore;
    }
  });

  it('a pool member is not decided on just because every lane matched nothing', async () => {
    // Keyword reads match nothing, so every pool member stays poolOnly:
    // the fused order holds nothing, and the decide feed must not fall
    // back to the pool itself.
    const parts = ['p1', 'p2', 'p3'].map((id) => candidate({ sourceId: 'notes', id }));
    const source: CandidateSource = {
      id: 'notes', role: 'reference',
      read: async (request) => ({ status: 'read', complete: true,
        candidates: request.wholeLanes === true ? parts : [] }),
    };
    const { decide, calls } = stubDecide((batch) => allAnswered(batch, 0.9));
    const picked = await pickFromSources([source], { task: 'recall the plan' },
      { task: 'recall the plan', decide });
    expect(askedPartIds(calls)).toEqual(new Set());
    expect(picked.record.pick!.sent).toBe(0);
    expect(picked.record.candidates.every((entry) =>
      entry.status === 'unassessed' && entry.reason === 'thoroughness')).toBe(true);
  });

  it('each lane keeps its candidate limit before the depth cut, and the cut parts keep reason limits', async () => {
    const { decide, calls } = stubDecide((batch) => allAnswered(batch, 0.9));
    const picked = await pick(ranked('notes', 3), {
      task: 'recall the plan', decide, limits: { maxCandidates: 1 } });
    expect(askedPartIds(calls)).toEqual(new Set(['p0']));
    expect(picked.record.pick!.sent).toBe(1);
    // The lane's own limit, not the depth, is why p1 and p2 were never
    // asked: the same reason they carry under the everyRanked feed.
    expect(picked.record.candidates.filter((entry) =>
      entry.status === 'unassessed' && entry.reason === 'limits').map((entry) => entry.id))
      .toEqual(['p1', 'p2']);
  });

  it('limits each meaning lane before the union, then cuts the union at the depth', async () => {
    // Two meaning lanes: 'alpha' holds nearTask, 'beta' holds nearLine.
    // maxCandidates: 1 slices each lane to its own top part, so the
    // union feeds both; a combined best-similarity ranking cut at one
    // would feed only nearTask. 'shared' is each lane's second part:
    // no lane's slice permitted it, so the lane limit is why it was
    // never asked: 'limits', not 'thoroughness'.
    const vectors: Record<string, number[]> = {
      alpha: [1, 0], beta: [0, 1],
      nearTask: [1, 0], nearLine: [0, 1], shared: [0.6, 0.8],
    };
    const embed = async (texts: readonly string[]) =>
      texts.map((text) => vectors[text] ?? [0, 0]);
    const parts = ['nearTask', 'nearLine', 'shared'].map((id) =>
      candidate({ sourceId: 'notes', id, text: id }));
    const source: CandidateSource = {
      id: 'notes', role: 'reference',
      read: async (request) => {
        if (request.meaningLane !== undefined) {
          return { status: 'read', complete: true, candidates: [] };
        }
        return { status: 'read', complete: true, laneCutApplied: true,
          candidates: request.wholeLanes === true ? parts : [] };
      },
    };
    const { decide, calls } = stubDecide((batch) => allAnswered(batch, 0.9));
    const picked = await pickFromSources([source],
      { task: 'alpha', searchLines: ['beta'], meaning: { embed } },
      { task: 'alpha', decide, limits: { maxCandidates: 1 } });
    expect(askedPartIds(calls)).toEqual(new Set(['nearTask', 'nearLine']));
    expect(picked.record.pick!.sent).toBe(2);
    expect(picked.record.candidates.find((entry) => entry.id === 'shared'))
      .toMatchObject({ status: 'unassessed', reason: 'limits' });
  });

  it('is the default, at deep', async () => {
    const { decide } = stubDecide((batch) => allAnswered(batch, 0.9));
    const picked = await pick(ranked('notes', 3), { task: 'recall the plan', decide });
    expect(picked.record.levers.thoroughness).toBe('deep');
    expect(picked.record.levers).not.toHaveProperty('everyRanked');
    expect(picked.record.pick).toMatchObject({
      n: 3, sent: 3, questions: 3, kept: 3,
      thoroughness: { level: 'deep', depth: THOROUGHNESS.deep }, ranking: 'fusion' });
  });

  it('cannot combine with everyRanked, checked before any decide call or read', async () => {
    const { decide, calls } = stubDecide((batch) => allAnswered(batch, 0.9));
    const parts = ranked('notes', 3);
    await expect(pick(parts, { task: 't', decide, everyRanked: { c: 0.5 }, thoroughness: 'deep' }))
      .rejects.toThrow(TypeError);
    await expect(pick(parts, { task: 't', decide, everyRanked: true, thoroughness: 'quick' }))
      .rejects.toThrow(/everyRanked and thoroughness/);
    await expect(pick(parts, { task: 't', decide, thoroughness: 'thorough' as never }))
      .rejects.toThrow(/'quick', 'normal' or 'deep'/);
    expect(calls).toHaveLength(0);

    let reads = 0;
    const source: CandidateSource = {
      id: 'notes', role: 'reference',
      read: async () => {
        reads += 1;
        return { status: 'read', complete: true, laneCutApplied: true, candidates: parts };
      },
    };
    await expect(pickFromSources([source], { task: 't' },
      { task: 't', decide, everyRanked: { c: 0.5 }, thoroughness: 'deep' }))
      .rejects.toThrow(/everyRanked and thoroughness/);
    expect(reads).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('memory() finishes when only the depth left parts unasked, and still throws when a stop did', async () => {
    const level: Thoroughness = 'quick';
    const keep = THOROUGHNESS[level];
    THOROUGHNESS[level] = 2;
    const source = (candidates: MemoryCandidate[]): CandidateSource => ({
      id: 'notes', role: 'reference',
      read: async () => ({ status: 'read', complete: true, laneCutApplied: true, candidates }),
    });
    const decide: PickDecide = async ({ questions }) =>
      Object.fromEntries(questions.map((q) => [q.key, { status: 'answered' as const, probability: 0.9 }]));
    const write = async () => '[2026-01-12] The plan (said 2026-01-12; E1)';
    try {
      const done = memory({ sources: [source(ranked('notes', 5))], decide, write,
        pick: { thoroughness: level } });
      const recalled = await done.recall('recall the plan');
      expect(recalled.picked.record.candidates.filter((entry) =>
        entry.status === 'unassessed' && entry.reason === 'thoroughness')).toHaveLength(3);
      expect(recalled.log).toBe('[2026-01-12] The plan (said 2026-01-12; p0)');

      const stopped = memory({ sources: [source(ranked('notes', 5))], decide, write,
        pick: { thoroughness: level, limits: { maxBatches: 1, maxPerBatch: 1 } } });
      await expect(stopped.recall('recall the plan')).rejects.toThrow('did not finish');

      // A lane's candidate limit is a stop too: the parts it cut record
      // 'limits', not 'thoroughness', so the collection stays incomplete.
      const limited = memory({ sources: [source(ranked('notes', 5))], decide, write,
        pick: { thoroughness: level, limits: { maxCandidates: 1 } } });
      await expect(limited.recall('recall the plan')).rejects.toThrow('did not finish');
    } finally {
      THOROUGHNESS[level] = keep;
    }
  });
});
