import { describe, expect, it } from 'vitest';

import { curate, type MemoryCandidate, type PickBatch, type PickDecide, type PickResult } from '../src/index.js';

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
    expect(record.estimatedTokens).toBeGreaterThan(0);
    expect(record.estimatedTokens).toBeLessThanOrEqual(500);
    expect(log.length).toBeGreaterThan(0);
    expect(record.items.map((item) => item.weight)).toEqual([0.9, 0.9, 0.5, 0.3, 0.2, 0.1]);
    expect(record.levers.route).toEqual({ asked: false, applied: false });
  });

  it('budgets 2,000 estimated tokens by default', async () => {
    const big = part('orchard', 'big', '2024-03-01', 'pear '.repeat(1_900));
    const after = part('orchard', 'after', '2024-03-01', 'plum '.repeat(200));
    const { record } = await curate(TASK, picked([[big, 0.9, 0], [after, 0.8, 1]]), { compression: 'none' });
    expect(record.answerTokens).toBe(2_000);
    expect(record.items.map((item) => item.candidate.id)).toEqual(['big']);
    expect(record.estimatedTokens).toBeLessThanOrEqual(2_000);
    expect(record.estimatedTokens).toBeGreaterThan(1_900);
  });

  it('estimates tokens from words, numbers, punctuation and lines, set a little high', async () => {
    const one = async (text: string) =>
      (await curate(TASK, picked([[part('orchard', 'one', '2024-03-05', text), 0.9, 0]]), { compression: 'none' })).record.estimatedTokens;
    // Eight more words and one more full stop: about nine tokens.
    expect(await one('Pear. The medlar was pruned hard before the frost.') - await one('Pear.')).toBe(9);
    // Characters alone would call these two the same size.
    const prose = 'the pear tree by the pond '.repeat(16);
    const dense = '4,812.07|3,950.11|77,204.9;'.repeat(16).slice(0, prose.length);
    expect(dense.length).toBe(prose.length);
    expect(await one(dense)).toBeGreaterThan(2 * await one(prose));
  });

  it('counts a long run of letters that is no word by its length', async () => {
    const one = async (text: string) =>
      (await curate(TASK, picked([[part('orchard', 'one', '2024-03-05', text), 0.9, 0]]), { compression: 'none' })).record.estimatedTokens;
    expect(await one('k'.repeat(900)) - await one('k')).toBeGreaterThanOrEqual(300);
  });

  it('keeps fewer dense items than prose items inside one budget', async () => {
    // The id ends each text, so no item is a copy of another.
    const prose = (id: string) => part('orchard', id, '2024-03-01', `${'the pear tree by the pond '.repeat(16)}${id}`);
    const dense = (id: string) => part('orchard', id, '2024-03-01', `${'4,812.07|3,950.11|77,204.9;'.repeat(16).slice(0, 416)}${id}`);
    const four = (make: (id: string) => MemoryCandidate) => picked([[make('a'), 0.9, 0], [make('b'), 0.8, 1], [make('c'), 0.7, 2], [make('d'), 0.6, 3]]);
    const kept = async (make: (id: string) => MemoryCandidate) =>
      (await curate(TASK, four(make), { compression: 'none', answerTokens: 450 })).record.items.length;
    expect(await kept(prose)).toBe(4);
    expect(await kept(dense)).toBeLessThan(4);
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

  it('names the file inside the source, and keeps two files of one day apart', async () => {
    const first = { ...part('notes', 'p1', '2024-03-05', 'Mulched the pears.'), path: 'garden/pears.md' };
    const second = { ...part('notes', 'p2', '2024-03-05', 'Fed the hens.'), path: 'garden/hens.md' };
    const third = { ...part('notes', 'p3', '2024-03-05', 'Cleaned the coop.'), path: 'garden/hens.md' };
    const fourth = { ...part('notes', 'p4', '2024-03-05', 'Thinned the pears.'), path: 'garden/pears.md' };
    const { log } = await curate(TASK, picked([[first, 0.9, 0], [second, 0.8, 0], [third, 0.7, 0], [fourth, 0.6, 0]]), { compression: 'none' });
    expect(log).toContain('#### garden/pears.md (said 2024-03-05)\n\nMulched the pears.');
    expect(log).toContain('### garden/hens.md (said 2024-03-05)\n\nCleaned the coop.');
    expect(log).toContain('### garden/pears.md (said 2024-03-05)\n\nThinned the pears.');
    expect(log).not.toContain('notes (said');
  });

  describe('copies', () => {
    const count = (log: string, text: string) => log.split(text).length - 1;
    const ROW = 'Planted the quince row along the south wall, six trees a metre apart, each one staked.';
    const RAKED = 'Then I raked the gravel path, cut back the willow by the bridge and fed the koi their spring pellets.';

    it('takes an exact copy in another file once, and names both files', async () => {
      const kept = { ...part('notes', 'q1', '2024-03-09', ROW), path: 'garden/orchard.md' };
      const copy = { ...part('notes', 'q2', '2024-03-09', `\n  ${ROW}\n`), path: 'garden/diary.md' };
      const { log, record } = await curate(TASK, picked([[kept, 0.9, 0], [copy, 0.9, 1], [KOI, 0.5, 2]]), { compression: 'none' });
      expect(count(log, ROW)).toBe(1);
      expect(log).toContain(`#### garden/orchard.md (said 2024-03-09), also garden/diary.md (said 2024-03-09)\n\n${ROW}`);
      expect(record.items.map((item) => item.candidate.id)).toEqual(['q1', 'b']);
    });

    it('keeps a text that only sits inside a stronger item, with its own place and date', async () => {
      const diary = part('pond', 'p1', '2024-03-02', `Rejected plan: "${RAKED}" Not this month.`);
      const inside = part('orchard', 'p2', '2024-03-09', RAKED);
      const { log, record } = await curate(TASK, picked([[diary, 0.9, 0], [inside, 0.7, 1]]), { compression: 'none' });
      expect(count(log, RAKED)).toBe(2);
      expect(log).toContain(`#### orchard (said 2024-03-09)\n\n${RAKED}`);
      expect(log).not.toContain('also');
      expect(record.collapsed).toBe(0);
    });

    it('keeps two items that share only a header line', async () => {
      const header = '# Garden log, March';
      const medlar = part('orchard', 'h1', '2024-03-05', `${header}\nPruned the medlar back to three buds on every spur.`);
      const lilies = part('pond', 'h2', '2024-03-06', `${header}\nThinned the lilies so the koi have open water again.`);
      const { log, record } = await curate(TASK, picked([[medlar, 0.9, 0], [lilies, 0.8, 1]]), { compression: 'none' });
      expect(record.items.map((item) => item.candidate.id)).toEqual(['h1', 'h2']);
      expect(record.collapsed).toBe(0);
      expect(count(log, header)).toBe(2);
      expect(log).not.toContain('also');
    });

    it('takes a line found inside a stronger item again, but not its exact copy', async () => {
      const diary = part('pond', 's1', '2024-03-02', 'Netted the koi pond. Fed the hens and swept the yard before the rain came in.');
      const line = part('orchard', 's2', '2024-03-03', 'Netted the koi pond.');
      const same = part('notes', 's3', '2024-03-04', 'Netted the koi pond.');
      const { record } = await curate(TASK, picked([[diary, 0.9, 0], [line, 0.8, 1], [same, 0.7, 2]]), { compression: 'none' });
      expect(record.items.map((item) => item.candidate.id)).toEqual(['s1', 's2']);
      expect(record.collapsed).toBe(1);
    });

    it('names every other place and date a copy was said, each once, under the kept heading', async () => {
      const quince = part('orchard', 'k1', '2024-03-09', 'Planted the quince row.');
      const koi = part('pond', 'k2', '2024-03-02', 'Netted the koi pond.');
      const fig = part('orchard', 'k3', '2024-03-05', 'Wrapped the fig.');
      const medlar = part('orchard', 'k4', '2024-03-05', 'Pruned the medlar.');
      const { log, record } = await curate(TASK, picked([
        [quince, 0.9, 0], [koi, 0.8, 1], [fig, 0.6, 2], [medlar, 0.5, 3],
        [part('pond', 'k5', '2024-03-06', 'Pruned the medlar.'), 0.4, 4],
        [part('pond', 'k6', '2024-03-01', 'Planted the quince row.'), 0.3, 5],
        [part('notes', 'k7', undefined, 'Planted the quince row.'), 0.3, 6],
        [part('orchard', 'k8', '2024-03-09', 'Planted the quince row.'), 0.2, 7],
        [part('pond', 'k9', '2024-03-01', 'Planted the quince row.'), 0.2, 8],
      ]), { compression: 'none' });
      expect(log).toBe([
        '### Most likely answer\n\n',
        '#### orchard (said 2024-03-09), also pond (said 2024-03-01) and notes (said unknown)\n\nPlanted the quince row.\n\n',
        '#### pond (said 2024-03-02)\n\nNetted the koi pond.\n\n\n',
        '### orchard (said 2024-03-05)\n\nWrapped the fig.\n\n',
        '### orchard (said 2024-03-05), also pond (said 2024-03-06)\n\nPruned the medlar.',
      ].join(''));
      expect(record.collapsed).toBe(5);
    });

    it('gives the room a copy would take to the next item', async () => {
      const long = part('orchard', 'l1', '2024-03-05', `${ROW} ${RAKED}`);
      const copy = part('orchard', 'l2', '2024-03-05', `${ROW} ${RAKED}`);
      const next = part('orchard', 'l3', '2024-03-05', 'Fed the koi.');
      const without = await curate(TASK, picked([[long, 0.9, 0], [next, 0.7, 1]]), { compression: 'none' });
      const { log, record } = await curate(TASK, picked([[long, 0.9, 0], [copy, 0.8, 1], [next, 0.7, 2]]),
        { compression: 'none', answerTokens: without.record.estimatedTokens });
      expect(record.items.map((item) => item.candidate.id)).toEqual(['l1', 'l3']);
      expect(log).toBe(without.log);
      expect(record.collapsed).toBe(1);
    });

    it('records no collapsed items when nothing repeats', async () => {
      const { record } = await curate(TASK, GARDEN, { compression: 'none' });
      expect(record.collapsed).toBe(0);
    });
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

describe('what the budget left out', () => {
  it('records how many selected items were not taken, the strongest weight among them and how many are at 0.5 or more', async () => {
    const first = part('orchard', 'first', '2024-03-01', 'a'.repeat(100));
    const wide = part('orchard', 'wide', '2024-03-01', 'b'.repeat(800));
    const small = part('orchard', 'small', '2024-03-01', 'small');
    const faint = part('orchard', 'faint', '2024-03-01', 'faint');
    const alone = await curate(TASK, picked([[first, 0.9, 0]]), { compression: 'none' });
    const { record } = await curate(TASK, picked([[first, 0.9, 0], [wide, 0.8, 1], [small, 0.5, 2], [faint, 0.3, 3]]),
      { compression: 'none', answerTokens: alone.record.estimatedTokens + 50 });
    expect(record.leftOut).toEqual({ count: 3, strongestWeight: 0.8, atHalfOrMore: 2 });
  });

  it('records none left out when every selected item was taken', async () => {
    const { record } = await curate(TASK, GARDEN, { compression: 'none' });
    expect(record.leftOut).toEqual({ count: 0, atHalfOrMore: 0 });
  });

  it('does not count a copy as left out', async () => {
    const copy = part('pond', 'copy', '2024-03-20', KOI.text);
    const { record } = await curate(TASK, picked([[KOI, 0.9, 0], [copy, 0.8, 1]]), { compression: 'none' });
    expect(record.collapsed).toBe(1);
    expect(record.leftOut.count).toBe(0);
  });
});

describe('sentenceCutoff', () => {
  const DIARY = part('orchard', 'h', '2024-03-12', 'Planted the quince row. The weather was grey.\n\nBought string at the market. Staked the young quinces.');
  const SHED = part('shed', 'j', '2024-03-14', 'Painted the shed door. Oiled the hinges.');
  const TALK = part('pond', 'k', '2024-03-13', 'user: The koi are fat. Should I net the pond?\nassistant: Nets help. Herons took two fish last spring.');
  const WORK = picked([[DIARY, 0.9, 0], [SHED, 0.6, 1]]);

  /** A stand-in decision function: 0.2 for a sentence holding one of `low`, 0.8 for every other. */
  const judge = (low: readonly string[], seen: PickBatch[] = [], weak = 0.2): PickDecide => async (batch) => {
    seen.push(batch);
    return Object.fromEntries(batch.questions.map((question) =>
      [question.key, { status: 'answered' as const, probability: low.some((word) => question.text.includes(word)) ? weak : 0.8 }]));
  };

  it('keeps the sentences at or over the cutoff, in order, under the same headings, with a mark where text is left out', async () => {
    const { log } = await curate(TASK, WORK, { compression: 'none', sentenceCutoff: 0.5, decide: judge(['weather', 'string', 'hinges']) });
    expect(log).toBe([
      '### Most likely answer\n\n',
      '#### orchard (said 2024-03-12)\n\nPlanted the quince row.\n… Staked the young quinces.\n\n',
      '#### shed (said 2024-03-14)\n\nPainted the shed door. …\n',
    ].join(''));
  });

  it('keeps a sentence rated exactly at the cutoff and drops it under a higher one', async () => {
    const at = await curate(TASK, WORK, { compression: 'none', sentenceCutoff: 0.2, decide: judge(['hinges']) });
    expect(at.log).toContain('Painted the shed door. Oiled the hinges.');
    const over = await curate(TASK, WORK, { compression: 'none', sentenceCutoff: 0.21, decide: judge(['hinges']) });
    expect(over.log).toContain('Painted the shed door. …');
    expect(over.log).not.toContain('hinges');
  });

  it('keeps the speaker of a kept sentence when the line that named the speaker lost its first sentence', async () => {
    const { log } = await curate(TASK, picked([[TALK, 0.9, 0]]), { compression: 'none', sentenceCutoff: 0.5, decide: judge(['fat', 'Nets']) });
    expect(log).toBe('### Most likely answer\n\n#### pond (said 2024-03-13)\n\n… user: Should I net the pond?\n… assistant: Herons took two fish last spring.\n');
  });

  it('judges the strongest item like any other, and leaves out and counts an item with no sentence kept', async () => {
    const { log, record } = await curate(TASK, picked([[SHED, 0.9, 0], [DIARY, 0.6, 1], [FIG, 0.5, 2]]),
      { compression: 'none', sentenceCutoff: 0.5, decide: judge(['shed', 'hinges']) });
    expect(log).not.toContain('shed');
    expect(log).toContain('#### orchard (said 2024-03-12)\n\nPlanted the quince row. The weather was grey.\nBought string at the market. Staked the young quinces.');
    expect(log).toContain('#### orchard (said 2024-03-05)\n\nWrapped the fig.');
    expect(record.items.map((item) => item.candidate.id)).toEqual(['h', 'd']);
    expect(record.sentences).toMatchObject({ itemsLeftOut: 1, itemsTrimmed: 0, kept: 5, of: 7 });
  });

  it('returns no text when no sentence reaches the cutoff', async () => {
    const { log, record } = await curate(TASK, WORK, { compression: 'none', sentenceCutoff: 0.9, decide: judge([]) });
    expect(log).toBe('');
    expect(record.items).toEqual([]);
    expect(record.sentences).toMatchObject({ itemsLeftOut: 2, kept: 0, of: 6 });
    expect(record.estimatedTokens).toBe(0);
  });

  it('asks in one request: each sentence alone, its speaker on a line\'s first sentence, the item\'s date on its first', async () => {
    const seen: PickBatch[] = [];
    await curate(TASK, picked([[DIARY, 0.9, 0], [TALK, 0.6, 1]]), { compression: 'none', sentenceCutoff: 0.5, decide: judge([], seen) });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.task).toBe(TASK);
    expect(seen[0]!.questions.map((question) => [question.key, question.text])).toEqual([
      ['p0u0', 'Planted the quince row.'], ['p0u1', 'The weather was grey.'],
      ['p0u2', 'Bought string at the market.'], ['p0u3', 'Staked the young quinces.'],
      ['p1u0', 'user: The koi are fat.'], ['p1u1', 'Should I net the pond?'],
      ['p1u2', 'assistant: Nets help.'], ['p1u3', 'Herons took two fish last spring.'],
    ]);
    expect(seen[0]!.questions[0]).toEqual({
      key: 'p0u0', sourceId: 'p0', id: 'u0', role: 'reference', title: '', anonymous: true, text: 'Planted the quince row.',
      date: { value: '2024-03-12', meaning: 'recorded' },
      question: 'Does this sentence supply evidence, a constraint or a decision for this task?',
      trueCriterion: 'It helps with this task, or is needed to understand a sentence that does.',
      falseCriterion: 'It gives nothing that helps with this task.',
    });
    expect(seen[0]!.questions[1]).not.toHaveProperty('date');
  });

  it('judges only the items the budget took', async () => {
    const seen: PickBatch[] = [];
    const alone = await curate(TASK, picked([[DIARY, 0.9, 0]]), { compression: 'none' });
    const { record } = await curate(TASK, WORK, { compression: 'none', answerTokens: alone.record.estimatedTokens, sentenceCutoff: 0.5, decide: judge([], seen) });
    expect(seen[0]!.questions).toHaveLength(4);
    expect(record.leftOut).toEqual({ count: 1, strongestWeight: 0.6, atHalfOrMore: 1 });
  });

  it('records the cutoff, the sentences kept of how many, the items that lost sentences and the estimate before and after', async () => {
    const whole = await curate(TASK, WORK, { compression: 'none' });
    const { record } = await curate(TASK, WORK, { compression: 'none', sentenceCutoff: 0.5, decide: judge(['weather', 'string', 'hinges']) });
    expect(record.sentences).toEqual({
      cutoff: 0.5, kept: 3, of: 6, unanswered: 0, itemsTrimmed: 2, itemsLeftOut: 0, estimatedTokensBefore: whole.record.estimatedTokens,
    });
    expect(record.estimatedTokens).toBeLessThan(whole.record.estimatedTokens);
    expect(record.items.map((item) => item.candidate.text)).toEqual(['Planted the quince row.\n… Staked the young quinces.', 'Painted the shed door. …']);
  });

  it('keeps and counts a sentence the decision function left unanswered', async () => {
    const decide: PickDecide = async (batch) => Object.fromEntries(batch.questions.map((question) =>
      [question.key, question.text.includes('hinges') ? { status: 'refused' as const } : { status: 'answered' as const, probability: 0.1 }]));
    const { log, record } = await curate(TASK, WORK, { compression: 'none', sentenceCutoff: 0.5, decide });
    expect(log).toBe('### Most likely answer\n\n#### shed (said 2024-03-14)\n\n… Oiled the hinges.\n');
    expect(record.sentences).toMatchObject({ kept: 1, of: 6, unanswered: 1 });
  });

  it('returns the untrimmed text and says so in the record when the decision request fails', async () => {
    const whole = await curate(TASK, WORK, { compression: 'none' });
    const { log, record } = await curate(TASK, WORK, { compression: 'none', sentenceCutoff: 0.5, decide: async () => { throw new Error('service down'); } });
    expect(log).toBe(whole.log);
    expect(record.items).toEqual(whole.record.items);
    expect(record.estimatedTokens).toBe(whole.record.estimatedTokens);
    expect(record.sentences).toEqual({
      cutoff: 0.5, kept: 6, of: 6, unanswered: 6, itemsTrimmed: 0, itemsLeftOut: 0, failed: 'service down', estimatedTokensBefore: whole.record.estimatedTokens,
    });
  });

  it('stops, without a text, when the caller ends the run during the decision request', async () => {
    const stop = new AbortController();
    await expect(curate(TASK, WORK, { compression: 'none', sentenceCutoff: 0.5, signal: stop.signal,
      decide: async () => { stop.abort(); throw new Error('stopped'); } })).rejects.toThrow();
  });

  it('changes nothing when it is not set', async () => {
    const { log, record } = await curate(TASK, GARDEN, { compression: 'none' });
    expect(log).toBe(LAID_OUT);
    expect(record).not.toHaveProperty('sentences');
  });

  it('keeps the place and date of a copy on the trimmed item\'s heading', async () => {
    const copy = part('notes', 'copy', '2024-03-20', DIARY.text);
    const { log } = await curate(TASK, picked([[DIARY, 0.9, 0], [copy, 0.8, 1]]), { compression: 'none', sentenceCutoff: 0.5, decide: judge(['weather']) });
    expect(log).toContain('#### orchard (said 2024-03-12), also notes (said 2024-03-20)\n\nPlanted the quince row.\n… Bought string');
  });

  it.each([-0.1, 1.5, Number.NaN, '0.5'])('rejects sentenceCutoff %s', async (sentenceCutoff) => {
    await expect(curate(TASK, GARDEN, { compression: 'none', sentenceCutoff, decide: judge([]) } as never))
      .rejects.toThrow('sentenceCutoff must be a number between 0 and 1');
  });

  it('rejects sentenceCutoff with no decision function', async () => {
    await expect(curate(TASK, GARDEN, { compression: 'none', sentenceCutoff: 0.5 } as never))
      .rejects.toThrow('sentenceCutoff needs decide, the decision function that judges each sentence');
  });

  it('rejects sentenceCutoff under the other compressions', async () => {
    await expect(curate(TASK, GARDEN, { write: async () => '', sentenceCutoff: 0.5 } as never))
      .rejects.toThrow("sentenceCutoff is read only with compression: 'none'");
  });
});
