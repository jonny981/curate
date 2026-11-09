import { describe, expect, it } from 'vitest';

import { curate, type MemoryCandidate, type PickResult } from '../src/index.js';

function part(sourceId: string, id: string, date: string | undefined, text: string, role: 'reference' | 'rule' = 'reference'): MemoryCandidate {
  return {
    sourceId, id, title: `Title ${id}`, text, role, signals: {},
    ...(date === undefined ? {} : { date: { value: date, meaning: 'recorded' as const } }),
  };
}

/** Each entry is a candidate, its decision weight and its lowest search rank.
 *  `selected` keeps the order given, as a real pick keeps equal weights in the fused order. */
function picked(items: readonly (readonly [MemoryCandidate, number, number])[]): PickResult {
  return {
    selected: items.map(([item]) => item),
    record: {
      questionVersion: 'test', limits: {},
      thresholds: { linkedPathBar: 0 }, rulesCoverage: 'complete',
      levers: { everyRanked: true, everyScored: true, route: false, rare: false, sources: {} },
      effects: [],
      candidates: items.map(([item, probability, priority]) => ({
        sourceId: item.sourceId, id: item.id, role: item.role, priority,
        signals: item.signals, status: 'selected', asked: true, probability,
      })),
    },
  };
}

const TASK = 'What did I do in the garden?';

const QUINCE = part('orchard', 'a', '2024-03-09T10:00:00Z', 'Planted the quince row.');
const KOI = part('pond', 'b', 'dated 2024/03/02 (Sat) 09:30', 'Netted the koi pond.');
const MEDLAR = part('orchard', 'c', '2024-03-05', 'Pruned the medlar.');
const FIG = part('orchard', 'd', '2024-03-05', 'Wrapped the fig.');
const LILY = part('pond', 'e', '2024-03-05', 'Thinned the lilies.');
const NOTE = part('notes', 'f', undefined, 'Soil looks acid.');
const RULE = part('orchard', 'g', '2024-03-01', 'Always water at dawn.', 'rule');

// KOI comes before QUINCE in the fused order, though QUINCE has the better search rank.
const GARDEN = picked([
  [KOI, 0.9, 1], [QUINCE, 0.9, 0], [MEDLAR, 0.3, 0], [FIG, 0.5, 0], [LILY, 0.2, 0], [NOTE, 0.1, 0],
]);

const LAID_OUT = [
  '### Most likely answer\n\n',
  '#### pond (said 2024-03-02)\n\nNetted the koi pond.\n\n',
  '#### orchard (said 2024-03-09)\n\nPlanted the quince row.\n\n\n',
  '### orchard (said 2024-03-05)\n\nWrapped the fig.\n\nPruned the medlar.\n\n',
  '### pond (said 2024-03-05)\n\nThinned the lilies.\n\n',
  '### notes (said unknown)\n\nSoil looks acid.',
].join('');

describe("compression: 'none'", () => {
  it('lays out the top two, then the rest by said date and source, oldest first', async () => {
    const { log } = await curate(TASK, GARDEN, { compression: 'none' });
    expect(log).toBe(LAID_OUT);
  });

  it('breaks a weight tie by the fused order', async () => {
    const { record } = await curate(TASK, GARDEN, { compression: 'none' });
    expect(record.items.map((item) => item.candidate.id)).toEqual(['b', 'a', 'd', 'c', 'e', 'f']);
  });

  it('records the items taken, the estimated tokens and the budget', async () => {
    const { log, record } = await curate(TASK, GARDEN, { compression: 'none', answerTokens: 500 });
    expect(record.compression).toBe('none');
    expect(record.answerTokens).toBe(500);
    expect(record.estimatedTokens).toBe(Math.ceil(log.length / 4));
    expect(record.items.map((item) => item.weight)).toEqual([0.9, 0.9, 0.5, 0.3, 0.2, 0.1]);
    expect(record.levers.route).toEqual({ asked: false, applied: false });
  });

  it('budgets 2,250 estimated tokens by default', async () => {
    const big = part('orchard', 'big', '2024-03-01', 'x'.repeat(8_900));
    const after = part('orchard', 'after', '2024-03-01', 'y'.repeat(400));
    const { log, record } = await curate(TASK, picked([[big, 0.9, 0], [after, 0.8, 1]]), { compression: 'none' });
    expect(record.answerTokens).toBe(2_250);
    expect(record.items.map((item) => item.candidate.id)).toEqual(['big']);
    expect(Math.ceil(log.length / 4)).toBeLessThanOrEqual(2_250);
  });

  it('stops at the first item that would take the whole text over the budget', async () => {
    const first = part('orchard', 'first', '2024-03-01', 'a'.repeat(100));
    const wide = part('orchard', 'wide', '2024-03-01', 'b'.repeat(800));
    const small = part('orchard', 'small', '2024-03-01', 'small');
    const items = picked([[first, 0.9, 0], [wide, 0.8, 1], [small, 0.7, 2]]);
    const alone = await curate(TASK, picked([[first, 0.9, 0]]), { compression: 'none' });
    const { log, record } = await curate(TASK, items, { compression: 'none', answerTokens: alone.record.estimatedTokens + 50 });
    expect(record.items.map((item) => item.candidate.id)).toEqual(['first']);
    expect(log).toBe(alone.log);
  });

  it('counts the headings against the budget, re-rendering after each addition', async () => {
    const first = part('orchard', 'first', '2024-03-01', 'first');
    const third = part('far-away-source', 'third', '2024-03-02', 'third');
    const second = part('orchard', 'second', '2024-03-01', 'second');
    const all = picked([[first, 0.9, 0], [second, 0.8, 1], [third, 0.7, 2]]);
    const whole = await curate(TASK, all, { compression: 'none' });
    expect(whole.record.items).toHaveLength(3);
    const cut = await curate(TASK, all, { compression: 'none', answerTokens: whole.record.estimatedTokens - 1 });
    expect(cut.record.items.map((item) => item.candidate.id)).toEqual(['first', 'second']);
    expect(cut.record.estimatedTokens).toBeLessThan(whole.record.estimatedTokens);
  });

  it('keeps the strongest item whole when it alone is over the budget, and takes no more', async () => {
    const big = part('orchard', 'big', '2024-03-01', 'x'.repeat(1_000));
    const next = part('orchard', 'next', '2024-03-01', 'y');
    const { log, record } = await curate(TASK, picked([[big, 0.9, 0], [next, 0.8, 1]]), { compression: 'none', answerTokens: 10 });
    expect(log).toContain('x'.repeat(1_000));
    expect(record.items.map((item) => item.candidate.id)).toEqual(['big']);
    expect(record.estimatedTokens).toBeGreaterThan(10);
  });

  it('never says "said" for a date that is only the file\'s last change', async () => {
    const changed = { ...part('orchard', 'h', '2024-03-05', 'Mulched the pears.'), date: { value: '2024-03-05', meaning: 'modified' as const } };
    const { log } = await curate(TASK, picked([[changed, 0.9, 0]]), { compression: 'none' });
    expect(log).toContain('#### orchard (file changed 2024-03-05)');
    expect(log).not.toContain('said 2024-03-05');
  });

  it('shows the title of an item with no text', async () => {
    const commit = part('repo', 'c1', '2024-03-05', '');
    const { log } = await curate(TASK, picked([[commit, 0.9, 0]]), { compression: 'none' });
    expect(log).toContain('#### repo (said 2024-03-05)\n\nTitle c1');
  });

  it('holds one item under the answer heading alone', async () => {
    const { log } = await curate(TASK, picked([[MEDLAR, 0.4, 0]]), { compression: 'none' });
    expect(log).toBe('### Most likely answer\n\n#### orchard (said 2024-03-05)\n\nPruned the medlar.\n');
  });

  it('leaves rules out of the text', async () => {
    const { log } = await curate(TASK, picked([[RULE, 1, 0], [MEDLAR, 0.4, 1]]), { compression: 'none' });
    expect(log).not.toContain('dawn');
  });

  it('puts none of the curator instructions in the text', async () => {
    const { log } = await curate(TASK, GARDEN, { compression: 'none' });
    expect(log).not.toMatch(/observation|decision model|TASK:|weight/i);
  });

  it.each([
    ['write', { write: async () => '' }],
    ['decide', { decide: async () => ({}) }],
    ['working', { working: true }],
    ['context', { context: true }],
    ['routeByTask', { routeByTask: true }],
    ['preferenceAdvice', { preferenceAdvice: true }],
    ['preferenceChange', { preferenceChange: true }],
    ['route', { route: 'jev' }],
    ['contextLimit', { contextLimit: 100 }],
    ['batchTokens', { batchTokens: 100 }],
    ['weightBands', { weightBands: [0.1, 0.6] }],
    ['taskDate', { taskDate: '2024-03-16' }],
    ['answerHint', { answerHint: true }],
  ])('rejects %s, which it would not read', async (name, extra) => {
    await expect(curate(TASK, GARDEN, { compression: 'none', ...extra } as never)).rejects.toThrow(name);
  });

  it.each([0, -1, 1.5, Number.NaN, '2000'])('rejects answerTokens %s', async (answerTokens) => {
    await expect(curate(TASK, GARDEN, { compression: 'none', answerTokens } as never))
      .rejects.toThrow('answerTokens must be a positive integer');
  });

  it('rejects answerTokens under the other compressions', async () => {
    await expect(curate(TASK, GARDEN, { write: async () => '', answerTokens: 100 } as never))
      .rejects.toThrow("answerTokens is read only with compression: 'none'");
  });
});
