import { describe, expect, it } from 'vitest';

import {
  curate,
  DECISION_TAGS,
  pick,
  type CuratePrompt,
  type CurateWrite,
  type MemoryCandidate,
  type PickRecordEntry,
  type PickResult,
} from '../src/index.js';

const candidate = (id: string): MemoryCandidate => ({
  sourceId: 'notes', id, title: id, text: `Text ${id}`, role: 'reference', signals: {},
});

type Tags = PickRecordEntry['tags'];
const tags = (intent?: string, importance?: string): Tags => ({
  ...(intent === undefined ? {} : { intent: { value: intent, answers: [{ key: intent, status: 'answered' as const, probability: 0.9 }] } }),
  ...(importance === undefined ? {} : { importance: { value: importance, answers: [{ key: importance, status: 'answered' as const, probability: 0.9 }] } }),
});

function picked(
  items: MemoryCandidate[],
  weights: number[],
  tagMap: Record<string, Tags> = {},
): PickResult {
  return {
    selected: items,
    record: {
      questionVersion: 'test', limits: {},
      thresholds: { reference: 0, rule: 0, linkedPathBar: 0 }, rulesCoverage: 'complete',
      candidates: items.map((item, index) => {
        const itemTags = tagMap[`${item.sourceId}/${item.id}`] ?? tagMap[item.id];
        return {
          sourceId: item.sourceId, id: item.id, role: item.role, priority: index,
          signals: item.signals, status: 'selected' as const, asked: true, probability: weights[index]!,
          ...(itemTags === undefined ? {} : { tags: itemTags }),
        };
      }),
    },
  };
}

function writer(logs: readonly string[]) {
  const calls: CuratePrompt[] = [];
  const write: CurateWrite = async (prompt) => {
    calls.push(prompt);
    return logs[calls.length - 1]!;
  };
  return { calls, write };
}

const BANDS = [
  { above: 0.5, detail: 'whole' as const },
  { above: 0.1, detail: 'compressed' as const },
  { above: 0, detail: 'heavy' as const },
];

describe('score bands and chained curation', () => {
  it('writes the log in band order, strongest first, and records each layer', async () => {
    const { calls, write } = writer([
      '[2023-01-01] A happened (said 2023-01-01; a)',
      'L1 [2023-01-01] A happened (said 2023-01-01; a)\n[2023-01-02] B happened (said 2023-01-02; b)',
      'L1 [2023-01-01] A happened (said 2023-01-01; a)\nL2 [2023-01-02] B happened (said 2023-01-02; b)\n[2023-01-03] C happened (said 2023-01-03; c)',
    ]);
    const result = await curate('task', picked(
      [candidate('a'), candidate('b'), candidate('c')], [0.9, 0.4, 0.05],
    ), { write, bands: BANDS });
    expect(calls).toHaveLength(3);
    expect(calls[0]!.body).toContain('### a');
    expect(calls[0]!.body).not.toContain('### b');
    expect(calls[1]!.body).toContain('LOG SO FAR');
    expect(calls[1]!.body).toContain('L1 [2023-01-01] A happened (said 2023-01-01; a)');
    expect(calls[1]!.body).toContain('### b');
    expect(calls[1]!.body).not.toContain('### c');
    expect(calls[1]!.instructions).toContain('Compress this band');
    expect(calls[2]!.body).toContain('### c');
    expect(calls[0]!.instructions).toContain('Write each relevant fact from this band in full');
    expect(calls[2]!.instructions).toContain('Keep only the facts in this band the task plainly needs');
    expect(result.record.bands).toEqual(BANDS);
    expect(result.record.layers).toHaveLength(3);
    expect(result.record.layers?.map((layer) => [layer.band, layer.items])).toEqual([[0, 1], [1, 1], [2, 1]]);
    expect(result.record.layers?.[1]?.added).toEqual([
      { id: 'L2', line: 'L2 [2023-01-02] B happened (said 2023-01-02; b)' },
    ]);
    expect(result.record.layers?.[1]?.displaced).toEqual([]);
    expect(result.log).toContain('L3 [2023-01-03] C happened');
  });

  it('keeps the single-call shape when bands are omitted and skips empty bands', async () => {
    const { calls, write } = writer(['[2023-01-01] A happened (said 2023-01-01; a)']);
    const plain = await curate('task', picked([candidate('a')], [0.9]), { write });
    expect(calls).toHaveLength(1);
    expect(plain.record).not.toHaveProperty('bands');
    expect(plain.record).not.toHaveProperty('layers');

    const sparse = writer(['[2023-01-01] A happened (said 2023-01-01; a)']);
    const result = await curate('task', picked([candidate('a')], [0.9]), {
      write: sparse.write, bands: BANDS,
    });
    expect(sparse.calls).toHaveLength(1);
    expect(result.record.layers).toHaveLength(1);
    expect(result.record.layers?.[0]?.band).toBe(0);
  });

  it('rejects malformed band specs', async () => {
    for (const bands of [
      [], [{ above: 0.5, detail: 'whole' }, { above: 0.5, detail: 'light' }],
      [{ above: 2, detail: 'whole' }], [{ above: -0.1, detail: 'whole' }],
      [{ above: 0.5, detail: 'none' }], [{ above: Number.NaN, detail: 'whole' }],
    ] as const) {
      await expect(curate('task', picked([candidate('a')], [0.9]), {
        write: writer(['x']).write, bands: bands as never,
      })).rejects.toThrow('band');
    }
  });

  it('gives a lower band the base rules plus the layering rules', async () => {
    const { calls, write } = writer([
      '[2023-01-01] A visit happened (said 2023-01-01; a)',
      'L1 [2023-01-01] A visit happened (said 2023-01-01; a)\n[2023-01-02] A second visit happened (said 2023-01-02; b)',
    ]);
    const result = await curate('how many visits were there', picked(
      [candidate('a'), candidate('b')], [0.9, 0.4],
    ), { write, routeByTask: true, bands: [{ above: 0.5, detail: 'whole' }, { above: 0, detail: 'compressed' }] });
    const layer = calls[1]!.instructions;
    // The base rules a single-pass write gets still apply to the layer.
    expect(layer).toContain('This task needs a count or a list');
    expect(layer).toContain('last Saturday');
    expect(layer).toContain('Never shift a date that is already absolute');
    expect(layer).toContain('working section');
    expect(layer).toContain('Layer in only the facts the log does not already state');
    expect(layer).toContain('(replaces L3: the subject it corrects)');
    expect(layer).toContain("Compress this band's facts");
    expect(result.record.layers).toHaveLength(2);
  });

  it('writes the first pass at its band detail when the strongest nonempty band is compressed', async () => {
    const { calls, write } = writer(['[2023-01-03] C happened (said 2023-01-03; c)']);
    const result = await curate('task', picked([candidate('c')], [0.05]), {
      write, bands: [{ above: 0.5, detail: 'whole' }, { above: 0, detail: 'compressed' }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.instructions).toContain("Compress this band's facts");
    expect(calls[0]!.instructions).not.toContain('Keep only the facts in this band the task plainly needs');
    expect(result.record.layers?.[0]?.detail).toBe('compressed');
  });

  it('refuses bands with contextLimit before any writer call', async () => {
    const { calls, write } = writer(['x']);
    await expect(curate('task', picked([candidate('a')], [0.9]), {
      write, bands: BANDS, contextLimit: 100,
    })).rejects.toThrow('contextLimit');
    expect(calls).toHaveLength(0);
  });
});

describe('sized batches in a chained write', () => {
  it('cuts a band into batches by decision weight, strongest first', async () => {
    const { calls, write } = writer([
      '[2023-01-01] B happened (said 2023-01-01; b)',
      'L1 [2023-01-01] B happened (said 2023-01-01; b)\n[2023-01-02] A happened (said 2023-01-02; a)',
      'L1 [2023-01-01] B happened (said 2023-01-01; b)\nL2 [2023-01-02] A happened (said 2023-01-02; a)\n[2023-01-03] C happened (said 2023-01-03; c)',
    ]);
    const result = await curate('task', picked(
      [candidate('a'), candidate('b'), candidate('c')], [0.7, 0.9, 0.5],
    ), { write, bands: [{ above: 0, detail: 'whole' }], batchSize: 1 });
    expect(calls).toHaveLength(3);
    // One item per call, in weight order: b (0.9), a (0.7), c (0.5).
    expect(calls[0]!.body).toContain('### b');
    expect(calls[0]!.body).not.toContain('### a');
    expect(calls[0]!.body).not.toContain('### c');
    expect(calls[1]!.body).toContain('### a');
    expect(calls[1]!.body).toContain('LOG SO FAR');
    expect(calls[1]!.body).toContain('L1 [2023-01-01] B happened');
    expect(calls[1]!.body).not.toContain('### c');
    expect(calls[2]!.body).toContain('### c');
    expect(result.record.batchSize).toBe(1);
    expect(result.record.layers?.map((layer) => [layer.band, layer.items])).toEqual([[0, 1], [0, 1], [0, 1]]);
    expect(result.log).toContain('L3 [2023-01-03] C happened');
  });

  it('chains a single whole band when batchSize is set without bands', async () => {
    const { calls, write } = writer([
      '[2023-01-01] A happened (said 2023-01-01; a)\n[2023-01-02] C happened (said 2023-01-02; c)',
      'L1 [2023-01-01] A happened (said 2023-01-01; a)\nL2 [2023-01-02] C happened (said 2023-01-02; c)\n[2023-01-03] B happened (said 2023-01-03; b)',
    ]);
    const result = await curate('task', picked(
      [candidate('a'), candidate('b'), candidate('c')], [0.9, 0.5, 0.7],
    ), { write, batchSize: 2 });
    expect(calls).toHaveLength(2);
    // The first call sees the two strongest weights, the second the
    // rest over the log so far.
    expect(calls[0]!.body).toContain('### a');
    expect(calls[0]!.body).toContain('### c');
    expect(calls[0]!.body).not.toContain('### b');
    expect(calls[1]!.body).toContain('### b');
    expect(calls[1]!.body).toContain('LOG SO FAR');
    expect(result.record.bands).toEqual([{ above: 0, detail: 'whole' }]);
    expect(result.record.layers).toHaveLength(2);
  });

  it('lets a correction in a later batch displace a line an earlier batch wrote', async () => {
    const { calls, write } = writer([
      '[2023-01-01] The old plan stands (said 2023-01-01; a)',
      'L1 [2023-01-01] The old plan stands (said 2023-01-01; a)\n[2023-02-01] The new plan stands (said 2023-02-01; b) (replaces L1: the plan changed)',
    ]);
    const result = await curate('task', picked(
      [candidate('a'), candidate('b')], [0.9, 0.6],
      { a: tags('fact', 'relevant'), b: tags('correction', 'important') },
    ), { write, batchSize: 1 });
    // Both items share one implicit band, so each is its own pass; the
    // correction's batch displaces under the same rules as a band's.
    expect(calls).toHaveLength(2);
    expect(result.record.layers?.[1]?.displaced?.map((entry) => entry.id)).toEqual(['L1']);
    expect(result.log).not.toContain('The old plan stands');
  });

  it('rejects a bad batchSize and refuses batchSize with contextLimit', async () => {
    for (const batchSize of [0, -2, 1.5, Number.NaN]) {
      await expect(curate('task', picked([candidate('a')], [0.9]), {
        write: writer(['x']).write, batchSize,
      })).rejects.toThrow('batchSize');
    }
    const { calls, write } = writer(['x']);
    await expect(curate('task', picked([candidate('a')], [0.9]), {
      write, batchSize: 2, contextLimit: 100,
    })).rejects.toThrow('contextLimit');
    expect(calls).toHaveLength(0);
  });
});

describe('displacement between bands', () => {
  const first = '[2023-01-01] The old plan stands (said 2023-01-01; a)';
  const setup = (tagMap: Record<string, Tags>) => picked(
    [candidate('a'), candidate('b')], [0.9, 0.4], tagMap,
  );
  const layered = async (tagMap: Record<string, Tags>, second: string) => {
    const { calls, write } = writer([first, second]);
    const result = await curate('task', setup(tagMap), {
      write, bands: [{ above: 0.5, detail: 'whole' }, { above: 0, detail: 'compressed' }],
    });
    expect(calls).toHaveLength(2);
    return result;
  };

  it('lets a newer correction naming the line id displace exactly that line', async () => {
    const result = await layered(
      { a: tags('fact', 'relevant'), b: tags('correction', 'important') },
      '[2023-02-01] The new plan stands (said 2023-02-01; b) (replaces L1: the plan changed)',
    );
    expect(result.log).toBe('L2 [2023-02-01] The new plan stands (said 2023-02-01; b) (replaces L1: the plan changed)');
    expect(result.record.layers?.[1]?.displaced).toEqual([{
      id: 'L1', line: `L1 ${first}`, byId: 'L2',
      byLine: 'L2 [2023-02-01] The new plan stands (said 2023-02-01; b) (replaces L1: the plan changed)',
      reason: 'a newer correction or decision about the same subject; the writer stated: the plan changed',
    }]);
    expect(result.record.layers?.[1]?.refused).toEqual([]);
  });

  it('displaces exactly one of two lines sharing a date and a citation', async () => {
    const twin = '[2023-01-01] The plan discussed twice (said 2023-01-01; a)';
    const { write } = writer([
      `${first}\n${twin}`,
      '[2023-02-01] The plan discussed a third time (said 2023-02-01; b) (replaces L2: the plan changed)',
    ]);
    const result = await curate('task', setup({ a: tags('fact', 'relevant'), b: tags('correction', 'important') }), {
      write, bands: [{ above: 0.5, detail: 'whole' }, { above: 0, detail: 'compressed' }],
    });
    expect(result.record.layers?.[1]?.displaced?.map((entry) => entry.id)).toEqual(['L2']);
    expect(result.log).toContain('L1 [2023-01-01] The old plan stands');
    expect(result.log).not.toContain('The plan discussed twice');
    expect(result.record.layers?.[1]?.refused?.[0]?.id).toBe('L1');
  });

  it('keeps both when the claiming line is not newer', async () => {
    const earlier = '[2022-12-01] The plan that came before (said 2022-12-01; b) (replaces L1: the plan changed)';
    const result = await layered({ a: tags('fact', 'relevant'), b: tags('correction', 'critical') }, earlier);
    expect(result.log).toContain('The old plan stands');
    expect(result.log).toContain('The plan that came before');
    expect(result.record.layers?.[1]?.displaced).toEqual([]);
    expect(result.record.layers?.[1]?.refused?.[0]?.reason).toContain('not newer');
  });

  it('keeps both when the claiming item is less important than the line', async () => {
    const result = await layered(
      { a: tags('fact', 'critical'), b: tags('correction', 'passing') },
      '[2023-02-01] The new plan stands (said 2023-02-01; b) (replaces L1: the plan changed)',
    );
    expect(result.log).toContain('The old plan stands');
    expect(result.log).toContain('The new plan stands');
    expect(result.record.layers?.[1]?.displaced).toEqual([]);
    expect(result.record.layers?.[1]?.refused?.[0]?.reason).toContain('both lines kept');
  });

  it('keeps both when the claiming correction and the line are both passing', async () => {
    const result = await layered(
      { a: tags('fact', 'passing'), b: tags('correction', 'passing') },
      '[2023-02-01] The new plan stands (said 2023-02-01; b) (replaces L1: the plan changed)',
    );
    // A 'passing' item is a low-importance aside: it only adds, even
    // against a line recorded at the same importance.
    expect(result.log).toContain('The old plan stands');
    expect(result.log).toContain('The new plan stands');
    expect(result.record.layers?.[1]?.displaced).toEqual([]);
    expect(result.record.layers?.[1]?.refused?.[0]?.reason).toContain('both lines kept');
  });

  it('lets ideas and questions only add, never displace', async () => {
    const result = await layered(
      { a: tags('fact', 'relevant'), b: tags('idea', 'important') },
      '[2023-02-01] A newer idea about the plan (said 2023-02-01; b) (replaces L1: the plan changed)',
    );
    expect(result.log).toContain('The old plan stands');
    expect(result.log).toContain('A newer idea about the plan');
    expect(result.record.layers?.[1]?.displaced).toEqual([]);
  });

  it('displaces on a correction answer even when the recorded intent is instruction', async () => {
    const instructive: Tags = {
      intent: {
        value: 'instruction',
        answers: [
          { key: 'instruction', status: 'answered' as const, probability: 0.9 },
          { key: 'correction', status: 'answered' as const, probability: 0.95 },
        ],
      },
      importance: { value: 'important', answers: [{ key: 'important', status: 'answered' as const, probability: 0.9 }] },
    };
    const result = await layered(
      { a: tags('fact', 'relevant'), b: instructive },
      '[2023-02-01] The new plan stands (said 2023-02-01; b) (replaces L1: the plan changed)',
    );
    expect(result.record.layers?.[1]?.displaced.map((entry) => entry.id)).toEqual(['L1']);
    expect(result.log).not.toContain('The old plan stands');
  });

  it('displaces on a "corrects something earlier" yes with no displacing intent', async () => {
    const correctsOnly: Tags = {
      intent: { value: 'fact', answers: [{ key: 'fact', status: 'answered' as const, probability: 0.9 }] },
      corrects: { value: 'yes', answers: [{ key: 'yes', status: 'answered' as const, probability: 0.9 }] },
      importance: { value: 'important', answers: [{ key: 'important', status: 'answered' as const, probability: 0.9 }] },
    };
    const result = await layered(
      { a: tags('fact', 'relevant'), b: correctsOnly },
      '[2023-02-01] The new plan stands (said 2023-02-01; b) (replaces L1: the plan changed)',
    );
    expect(result.record.layers?.[1]?.displaced.map((entry) => entry.id)).toEqual(['L1']);
    expect(result.log).not.toContain('The old plan stands');
  });

  it('records correction precedence and displaces through DECISION_TAGS', async () => {
    const decided = await pick([candidate('a'), candidate('b')], {
      task: 'task', tags: DECISION_TAGS,
      decide: async (batch) => Object.fromEntries(batch.questions.map((q) => [q.key, {
        status: 'answered' as const,
        probability: q.tagSet === undefined
          ? (q.id === 'a' ? 0.9 : 0.4)
          : q.tagSet === 'corrects' ? (q.id === 'b' ? 0.9 : 0.1)
            : q.questionKey === 'intent.correction' ? (q.id === 'b' ? 0.95 : 0.1)
              : q.questionKey === 'intent.instruction' ? (q.id === 'b' ? 0.9 : 0.1)
                : q.questionKey === 'intent.fact' ? (q.id === 'a' ? 0.9 : 0.2)
                  : q.questionKey === 'importance.important' ? (q.id === 'b' ? 0.9 : 0.1)
                    : q.questionKey === 'importance.relevant' ? 0.9
                      : q.questionKey === 'emphasis.neutral' ? 0.9 : 0.1,
      }])),
    });
    // A corrective instruction answers instruction and correction yes;
    // correction is recorded first, and it displaces either way.
    expect(decided.record.candidates.find((item) => item.id === 'b')?.tags?.intent?.value).toBe('correction');
    const { write } = writer([
      '[2023-01-01] The old plan stands (said 2023-01-01; a)',
      '[2023-02-01] The new plan stands (said 2023-02-01; b) (replaces L1: the plan changed)',
    ]);
    const result = await curate('task', decided, {
      write, bands: [{ above: 0.5, detail: 'whole' }, { above: 0, detail: 'compressed' }],
    });
    expect(result.record.layers?.[1]?.displaced.map((entry) => entry.id)).toEqual(['L1']);
    expect(result.log).not.toContain('The old plan stands');
  });

  it('keeps both when the claim states no reason', async () => {
    const result = await layered(
      { a: tags('fact', 'relevant'), b: tags('correction', 'important') },
      '[2023-02-01] The new plan stands (said 2023-02-01; b) (replaces L1)',
    );
    expect(result.log).toContain('The old plan stands');
    expect(result.log).toContain('The new plan stands');
    expect(result.record.layers?.[1]?.displaced).toEqual([]);
    expect(result.record.layers?.[1]?.refused?.[0]?.reason).toContain('no claiming line states a reason');
  });

  it('keeps both when the claim is about an unrelated subject', async () => {
    const result = await layered(
      { a: tags('fact', 'relevant'), b: tags('correction', 'important') },
      '[2023-02-01] The billing cycle is quarterly (said 2023-02-01; b) (replaces L1: billing schedule)',
    );
    expect(result.log).toContain('L1 [2023-01-01] The old plan stands');
    expect(result.log).toContain('The billing cycle is quarterly');
    expect(result.record.layers?.[1]?.displaced).toEqual([]);
    expect(result.record.layers?.[1]?.refused?.[0]?.reason).toContain('no claiming line names a subject both lines state');
  });

  it('restores a line no new line names, keeping both with their dates', async () => {
    const result = await layered(
      { a: tags('fact', 'relevant'), b: tags('correction', 'critical') },
      '[2023-02-01] The plan as now stated (said 2023-02-01; b)',
    );
    expect(result.log).toContain('The old plan stands');
    expect(result.log).toContain('The plan as now stated');
    expect(result.record.layers?.[1]?.displaced).toEqual([]);
    expect(result.record.layers?.[1]?.refused?.[0]?.reason).toContain('no line names its id');
  });

  it('restores a reworded higher-band line instead of the new wording', async () => {
    const result = await layered(
      { a: tags('fact', 'relevant'), b: tags('correction', 'critical') },
      'L1 [2023-01-01] The old plan softened (said 2023-01-01; a)\n[2023-02-01] An unrelated fact (said 2023-02-01; b)',
    );
    expect(result.log).toContain('L1 [2023-01-01] The old plan stands (said 2023-01-01; a)');
    expect(result.log).not.toContain('softened');
    expect(result.record.layers?.[1]?.refused?.[0]).toMatchObject({
      id: 'L1', reason: 'an existing line may not be reworded; the original is restored',
    });
  });

  it('refuses a displacement claimed by rewording an existing line', async () => {
    // The second pass rewords L2 into a correction naming L1 and drops
    // L1: only a newly added line may displace, so both originals stay.
    const { write } = writer([
      '[2023-01-01] The old plan stands (said 2023-01-01; a)\n[2023-01-02] The team meets weekly (said 2023-01-02; b)',
      'L2 [2023-02-01] The new plan stands (said 2023-02-01; c) (replaces L1: the plan changed)',
    ]);
    const result = await curate('task', picked(
      [candidate('a'), candidate('b'), candidate('c')], [0.9, 0.9, 0.4],
      { a: tags('fact', 'relevant'), b: tags('fact', 'relevant'), c: tags('correction', 'critical') },
    ), { write, bands: [{ above: 0.5, detail: 'whole' }, { above: 0, detail: 'compressed' }] });
    expect(result.log).toContain('L1 [2023-01-01] The old plan stands (said 2023-01-01; a)');
    expect(result.log).toContain('L2 [2023-01-02] The team meets weekly (said 2023-01-02; b)');
    expect(result.log).not.toContain('The new plan stands');
    expect(result.record.layers?.[1]?.displaced).toEqual([]);
    expect(result.record.layers?.[1]?.refused?.map((entry) => entry.id)).toEqual(['L2', 'L1']);
  });

  it('keeps both when one shared word spans two different facts', async () => {
    const { write } = writer([
      '[2023-01-01] The billing address is 12 Oak Street (said 2023-01-01; a)',
      '[2023-02-01] The billing cycle is quarterly (said 2023-02-01; b) (replaces L1: the billing cycle)',
    ]);
    const result = await curate('task', setup({ a: tags('fact', 'relevant'), b: tags('correction', 'important') }), {
      write, bands: [{ above: 0.5, detail: 'whole' }, { above: 0, detail: 'compressed' }],
    });
    expect(result.log).toContain('L1 [2023-01-01] The billing address is 12 Oak Street');
    expect(result.log).toContain('The billing cycle is quarterly');
    expect(result.record.layers?.[1]?.displaced).toEqual([]);
    expect(result.record.layers?.[1]?.refused?.[0]?.reason).toContain('no claiming line names a subject both lines state');
  });

  it('keeps both when the stated subject is one broad shared word', async () => {
    const { write } = writer([
      '[2023-01-01] The billing address is 12 Oak Street (said 2023-01-01; a)',
      '[2023-02-01] The billing cycle is quarterly (said 2023-02-01; b) (replaces L1: billing)',
    ]);
    const result = await curate('task', setup({ a: tags('fact', 'relevant'), b: tags('correction', 'important') }), {
      write, bands: [{ above: 0.5, detail: 'whole' }, { above: 0, detail: 'compressed' }],
    });
    expect(result.log).toContain('L1 [2023-01-01] The billing address is 12 Oak Street');
    expect(result.log).toContain('The billing cycle is quarterly');
    expect(result.record.layers?.[1]?.displaced).toEqual([]);
    expect(result.record.layers?.[1]?.refused?.[0]?.reason).toContain('no claiming line names a subject both lines state');
  });

  it('keeps both when the shared words name only the entity, not which fact changed', async () => {
    const { write } = writer([
      '[2023-01-01] Atlas deployment region is Europe (said 2023-01-01; a)',
      '[2023-02-01] Atlas deployment schedule is weekly (said 2023-02-01; b) (replaces L1: Atlas deployment)',
    ]);
    const result = await curate('task', setup({ a: tags('fact', 'relevant'), b: tags('correction', 'important') }), {
      write, bands: [{ above: 0.5, detail: 'whole' }, { above: 0, detail: 'compressed' }],
    });
    // 'Atlas deployment' names the thing, not the fact: region and
    // schedule are different facts about it, so both stay.
    expect(result.log).toContain('L1 [2023-01-01] Atlas deployment region is Europe');
    expect(result.log).toContain('Atlas deployment schedule is weekly');
    expect(result.record.layers?.[1]?.displaced).toEqual([]);
    expect(result.record.layers?.[1]?.refused?.[0]?.reason).toContain('no claiming line names a subject both lines state');
  });

  it('displaces when the lines differ only in the value of the subject the reason names', async () => {
    const { write } = writer([
      '[2023-01-01] Atlas deployment mode is manual (said 2023-01-01; a)',
      '[2023-02-01] Atlas deployment mode is automatic (said 2023-02-01; b) (replaces L1: deployment mode)',
    ]);
    const result = await curate('task', setup({ a: tags('fact', 'relevant'), b: tags('correction', 'important') }), {
      write, bands: [{ above: 0.5, detail: 'whole' }, { above: 0, detail: 'compressed' }],
    });
    // 'manual' and 'automatic' are each line's value for the same
    // subject: 'is' separates them from the 'deployment mode' both
    // lines state, unlike 'region' and 'schedule' above.
    expect(result.record.layers?.[1]?.displaced?.map((entry) => entry.id)).toEqual(['L1']);
    expect(result.log).toContain('Atlas deployment mode is automatic');
    expect(result.log).not.toContain('is manual');
  });

  it('writes no replacement marker in the first pass and drops one a reply carries anyway', async () => {
    const { calls, write } = writer([
      '[2023-02-01] The new plan stands (said 2023-02-01; a) (replaces [2023-01-01])',
    ]);
    const result = await curate('task', picked([candidate('a')], [0.9]), {
      write, bands: [{ above: 0.5, detail: 'whole' }],
    });
    // The first pass has no earlier lines, so its instructions never
    // ask for a marker; one left in the reply is dropped and recorded.
    expect(calls[0]!.instructions).toContain('write no replacement marker');
    expect(calls[0]!.instructions).not.toContain('(replaces [the earlier date])');
    expect(result.log).toBe('L1 [2023-02-01] The new plan stands (said 2023-02-01; a)');
    expect(result.record.layers?.[0]?.refused).toEqual([{
      id: 'L1',
      line: 'L1 [2023-02-01] The new plan stands (said 2023-02-01; a)',
      reason: 'a first pass has no earlier lines to replace; the marker is dropped',
    }]);
  });

  it('drops a date-based replacement marker in a later pass and keeps both lines', async () => {
    const result = await layered(
      { a: tags('fact', 'relevant'), b: tags('correction', 'critical') },
      '[2023-02-01] The new plan stands (said 2023-02-01; b) (replaces [2023-01-01])',
    );
    // Only a stable line id may name a replacement; a date is never
    // honoured, so the marker is dropped and both lines stay.
    expect(result.log).toContain('L1 [2023-01-01] The old plan stands');
    expect(result.log).toContain('L2 [2023-02-01] The new plan stands (said 2023-02-01; b)');
    expect(result.log).not.toContain('(replaces');
    expect(result.record.layers?.[1]?.displaced).toEqual([]);
    expect(result.record.layers?.[1]?.refused?.map((entry) => entry.id)).toEqual(['L1', 'L2']);
    expect(result.record.layers?.[1]?.refused?.[1]?.reason).toContain('never by a date');
  });

  it('lets a terse reason displace when the lines share the subject it names', async () => {
    const { write } = writer([
      '[2023-01-01] The billing address is 12 Oak Street (said 2023-01-01; a)',
      '[2023-02-01] The billing address moved to 5 Elm Road (said 2023-02-01; b) (replaces L1: billing)',
    ]);
    const result = await curate('task', setup({ a: tags('fact', 'relevant'), b: tags('correction', 'important') }), {
      write, bands: [{ above: 0.5, detail: 'whole' }, { above: 0, detail: 'compressed' }],
    });
    expect(result.record.layers?.[1]?.displaced?.map((entry) => entry.id)).toEqual(['L1']);
    expect(result.log).not.toContain('12 Oak Street');
  });

  it('refuses displacement when either side has no recorded importance', async () => {
    const intent = (value: string) =>
      ({ value, answers: [{ key: value, status: 'answered' as const, probability: 0.9 }] });
    for (const status of ['error', 'unassessed'] as const) {
      const noImportance: Tags = { importance: { answers: [{ key: 'critical', status }] } };
      const claiming = await layered(
        { a: tags('fact', 'relevant'), b: { ...noImportance, intent: intent('correction') } },
        '[2023-02-01] The new plan stands (said 2023-02-01; b) (replaces L1: the plan changed)',
      );
      expect(claiming.record.layers?.[1]?.displaced).toEqual([]);
      expect(claiming.log).toContain('The old plan stands');
      expect(claiming.record.layers?.[1]?.refused?.[0]?.reason).toContain('recorded importance');
      const guarded = await layered(
        { a: { ...noImportance, intent: intent('fact') }, b: tags('correction', 'critical') },
        '[2023-02-01] The new plan stands (said 2023-02-01; b) (replaces L1: the plan changed)',
      );
      expect(guarded.record.layers?.[1]?.displaced).toEqual([]);
      expect(guarded.log).toContain('The old plan stands');
      expect(guarded.record.layers?.[1]?.refused?.[0]?.reason).toContain('recorded importance');
    }
  });

  it('displaces a line the writer kept when a valid newer correction names its id', async () => {
    // The writer is told to keep every line, so a reply can hold the
    // kept L1 and the new line that replaces it; code removes the named
    // line only because the claim passes the displacement rules.
    const result = await layered(
      { a: tags('fact', 'relevant'), b: tags('correction', 'important') },
      `L1 ${first}\n[2023-02-01] The new plan stands (said 2023-02-01; b) (replaces L1: the plan changed)`,
    );
    expect(result.log).not.toContain('The old plan stands');
    expect(result.log).toBe('L2 [2023-02-01] The new plan stands (said 2023-02-01; b) (replaces L1: the plan changed)');
    expect(result.record.layers?.[1]?.displaced).toEqual([{
      id: 'L1', line: `L1 ${first}`, byId: 'L2',
      byLine: 'L2 [2023-02-01] The new plan stands (said 2023-02-01; b) (replaces L1: the plan changed)',
      reason: 'a newer correction or decision about the same subject; the writer stated: the plan changed',
    }]);
    expect(result.record.layers?.[1]?.refused).toEqual([]);
    expect(result.record.layers?.[1]?.added).toEqual([
      { id: 'L2', line: 'L2 [2023-02-01] The new plan stands (said 2023-02-01; b) (replaces L1: the plan changed)' },
    ]);
  });

  it('keeps a retained line when the claim against it fails the rules', async () => {
    const result = await layered(
      { a: tags('fact', 'relevant'), b: tags('correction', 'important') },
      `L1 ${first}\n[2023-02-01] The billing cycle is quarterly (said 2023-02-01; b) (replaces L1: billing schedule)`,
    );
    expect(result.log).toContain(`L1 ${first}`);
    expect(result.log).toContain('The billing cycle is quarterly');
    expect(result.log).not.toContain('(replaces');
    expect(result.record.layers?.[1]?.displaced).toEqual([]);
    expect(result.record.layers?.[1]?.refused).toEqual([{
      id: 'L1', line: `L1 ${first}`,
      byId: 'L2', byLine: 'L2 [2023-02-01] The billing cycle is quarterly (said 2023-02-01; b) (replaces L1: billing schedule)',
      reason: 'the named line stays; the marker is dropped',
    }]);
  });

  it('displaces through source-qualified ids when item ids clash across sources', async () => {
    const note = candidate('same');
    const commit = { ...candidate('same'), sourceId: 'commits' };
    const notesId = '["notes","same"]';
    const commitsId = '["commits","same"]';
    const tagMap = {
      'notes/same': tags('fact', 'relevant'),
      'commits/same': tags('correction', 'important'),
    };
    const { calls, write } = writer([
      `[2023-01-01] The old plan stands (said 2023-01-01; ${notesId})`,
      `[2023-02-01] The new plan stands (said 2023-02-01; ${commitsId}) (replaces L1: the plan changed)`,
    ]);
    const result = await curate('task', picked([note, commit], [0.9, 0.4], tagMap), {
      write, bands: [{ above: 0.5, detail: 'whole' }, { above: 0, detail: 'compressed' }],
    });
    expect(calls[1]!.body).toContain(notesId);
    expect(result.record.layers?.[1]?.displaced.map((entry) => entry.id)).toEqual(['L1']);
    expect(result.log).not.toContain('The old plan stands');

    const critical = writer([
      `[2023-01-01] The old plan stands (said 2023-01-01; ${notesId})`,
      `[2023-02-01] The new plan stands (said 2023-02-01; ${commitsId}) (replaces L1: the plan changed)`,
    ]);
    const kept = await curate('task', picked([note, commit], [0.9, 0.4], {
      'notes/same': tags('fact', 'critical'),
      'commits/same': tags('correction', 'important'),
    }), { write: critical.write, bands: [{ above: 0.5, detail: 'whole' }, { above: 0, detail: 'compressed' }] });
    expect(kept.record.layers?.[1]?.displaced).toEqual([]);
    expect(kept.log).toContain('The old plan stands');
  });
});
