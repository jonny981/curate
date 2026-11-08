import { describe, expect, it } from 'vitest';

import {
  curate, CurateError, DEFAULT_BATCH_TOKENS, MARKUP_CALLS_AT_ONCE, memory,
  type CuratePrompt, type CurateWrite, type MemoryCandidate, type PickBatch, type PickDecide, type PickResult,
} from '../src/index.js';
import { EXTRACT, MARKUP, ROW_FALSE, ROW_QUESTION, ROW_TRUE } from '../src/markup.js';

function part(sourceId: string, id: string, date: string | undefined, text: string, role: 'reference' | 'rule' = 'reference'): MemoryCandidate {
  return {
    sourceId, id, title: `Title ${id}`, text, role, signals: {},
    ...(date === undefined ? {} : { date: { value: date, meaning: 'recorded' as const } }),
  };
}

function picked(items: readonly MemoryCandidate[]): PickResult {
  return {
    selected: items,
    record: {
      questionVersion: 'test', limits: {},
      thresholds: { linkedPathBar: 0 }, rulesCoverage: 'complete',
      levers: { everyRanked: true, everyScored: true, route: false, rare: false, sources: {} },
      effects: [],
      candidates: items.map((item, index) => ({
        sourceId: item.sourceId, id: item.id, role: item.role, priority: index,
        signals: item.signals, status: 'selected', asked: true, probability: 0.9,
      })),
    },
  };
}

interface Row { who?: string; what?: string; status?: string; date?: string; said?: string; amount?: string; quantity?: string; source?: string[]; quote?: string }
const row = (fields: Row) => ({ who: 'you', what: 'an event', status: 'done', date: '', said: '', amount: '', quantity: '', source: [], quote: 'words', ...fields });
const rowsReply = (rows: readonly Row[]) => JSON.stringify({ rows: rows.map(row) });

/** A stand-in markup model: one section per heading it was sent, in order. */
function markupReply(body: string): string {
  return [...body.matchAll(/^### (E\d+) \(said ([^)]*)\): [^\n]*\n\n([^\n]*)/gm)]
    .map(([, e, said, text]) => `## ${e} (said ${said})\nuser: <event who="you" status="done">${text}</event>`).join('\n\n');
}

function model(rows: readonly Row[] | string, markup: (prompt: CuratePrompt) => Promise<string> | string = (prompt) => markupReply(prompt.body)) {
  const calls: CuratePrompt[] = [];
  const write: CurateWrite = async (prompt) => {
    calls.push(prompt);
    if (prompt.step === 'extract') return typeof rows === 'string' ? rows : rowsReply(rows);
    return markup(prompt);
  };
  return { calls, write, markups: () => calls.filter((call) => call.step === 'markup') };
}

function decider(probability: number | ((index: number) => number) = 0.9) {
  const batches: PickBatch[] = [];
  const decide: PickDecide = async (batch) => {
    batches.push(batch);
    return Object.fromEntries(batch.questions.map((question, index) => [question.key,
      { status: 'answered' as const, probability: typeof probability === 'number' ? probability : probability(index) }]));
  };
  return { batches, decide };
}

// Selected order: quince (latest), a rule, koi (earliest), medlar.
// The quince and koi parts share the local id note#1 in two sources.
const QUINCE = part('orchard', 'note#1', '2024-03-09', 'Planted the quince row.');
const RULE = part('orchard', 'rule#1', '2024-03-01', 'Always water at dawn.', 'rule');
const KOI = part('pond', 'note#1', '2024-03-02', 'Netted the koi pond.');
const MEDLAR = part('orchard', 'note#2', '2024-03-05', 'Pruned the medlar.');
const GARDEN = picked([QUINCE, RULE, KOI, MEDLAR]);
const TASK = 'What did I do in the garden?';

describe("compression: 'low'", () => {
  it('sends extraction the log body under its own prompt, and asks one row question per row', async () => {
    const { calls, write } = model([row({ source: ['E1'] })]);
    const { batches, decide } = decider();
    await curate(TASK, GARDEN, { compression: 'low', decide, write, taskDate: '2024/03/16 (Sat) 09:00' });
    const logCalls: CuratePrompt[] = [];
    await curate(TASK, GARDEN, { taskDate: '2024/03/16 (Sat) 09:00',
      write: async (prompt) => { logCalls.push(prompt); return '[2024-03-09] Planted (said 2024-03-09; E1)'; } });
    expect(calls[0]).toEqual({ instructions: EXTRACT, body: logCalls[0]!.body, step: 'extract' });
    expect(batches).toEqual([{ task: `${TASK} (asked 2024/03/16 (Sat) 09:00)`, questions: [expect.objectContaining({
      id: 'row-1', title: 'Row 1', role: 'reference', question: ROW_QUESTION, trueCriterion: ROW_TRUE, falseCriterion: ROW_FALSE,
      text: 'who: you | what: an event | status: done | date: not stated (said ) | amount: - | quantity: - | source: E1 "words"',
    })] }]);
  });

  it('marks up only the parts a row cites, resolving extraction ids before markup ids', async () => {
    // Extraction E2 is the koi part; markup numbers it E1, the earliest said date.
    const { write, markups } = model([row({ source: ['E1'] }), row({ source: ['E2'] })]);
    const result = await curate(TASK, GARDEN, { compression: 'low', decide: decider().decide, write });
    expect(markups()).toHaveLength(1);
    expect(markups()[0]).toEqual({ instructions: MARKUP, step: 'markup', body: 'EVIDENCE:\n\n'
      + '### E1 (said 2024-03-02): Title note#1\n\nNetted the koi pond.\n\n'
      + '### E3 (said 2024-03-09): Title note#1\n\nPlanted the quince row.' });
    expect(result.record.marked).toEqual([
      { e: 'E1', id: '["pond","note#1"]', said: '2024-03-02' },
      { e: 'E3', id: '["orchard","note#1"]', said: '2024-03-09' },
    ]);
    expect(result.log).not.toContain('medlar');
    expect(result.log).not.toContain('dawn');
  });

  it('keeps a part apart from another source\'s part with the same local id', async () => {
    const { write, markups } = model([row({ source: ['E1'] })]);
    await curate(TASK, GARDEN, { compression: 'low', decide: decider().decide, write });
    expect(markups()[0]!.body).toContain('quince');
    expect(markups()[0]!.body).not.toContain('koi');
  });

  it('counts a row at 0.5 and not at 0.49', async () => {
    const { write } = model([row({ what: 'counted', source: ['E1'] }), row({ what: 'left out', source: ['E1'] })]);
    const result = await curate(TASK, GARDEN, { compression: 'low', write, decide: decider((index) => [0.5, 0.49][index]!).decide });
    expect(result.record.counted).toBe(1);
    expect(result.record.probabilities).toEqual([0.5, 0.49]);
    expect(result.log).toContain('Figures over the 1 rows counted (of 2 rows extracted):\n- Rows counted: 1');
    expect(result.log).toContain('what: counted');
    expect(result.log).not.toContain('what: left out');
  });

  it('computes counts, sums and the day span, and lists counted rows by date', async () => {
    const { write } = model([
      row({ what: 'bought seed', date: '2024-03-09', said: '2024-03-09', amount: '$38', quantity: '35 minutes', source: ['E1'] }),
      row({ what: 'bought netting', date: '', said: '2024-03-02', amount: '$12.50', quantity: '2 hours', source: ['E3'] }),
    ]);
    const result = await curate(TASK, GARDEN, { compression: 'low', decide: decider().decide, write, taskDate: '2024-03-16' });
    expect(result.log.split('\n### marked-up log')[0]).toBe([
      '### computed by code from extracted rows the decision model counted',
      '',
      'Figures over the 2 rows counted (of 2 rows extracted):',
      '- Rows counted: 2',
      '- Sum of amounts: $50.5 (38 + 12.5)',
      '- Sum of quantities: 155 minutes (2.58 hours) (35 + 120)',
      '- Days from the earliest to the latest counted row: 7 (1 weeks), 2024-03-02 to 2024-03-09',
      '',
      'Counted rows, by date:',
      '1. [2024-03-02, said, 14 days before the question date] who: you | what: bought netting | status: done | date: not stated (said 2024-03-02) | amount: $12.50 | quantity: 2 hours | source: E3 "words"',
      '2. [2024-03-09, 7 days before the question date] who: you | what: bought seed | status: done | date: 2024-03-09 (said 2024-03-09) | amount: $38 | quantity: 35 minutes | source: E1 "words"',
      '',
    ].join('\n'));
  });

  it('lists an uncounted row that carries an amount or quantity under the figures, leaving it out of them', async () => {
    // Extraction E1, E2, E3 are quince, koi, medlar; markup numbers them E3, E1, E2.
    const { write } = model([
      row({ what: 'bought seed', date: '2024-03-09', said: '2024-03-09', amount: '$38', source: ['E1'], quote: 'bought seed' }),
      row({ what: 'bought twine', date: '2024-03-02', said: '2024-03-02', amount: '$12', source: ['E1', 'E2'], quote: 'bought twine' }),
      row({ what: 'wished for shears', status: 'wished', said: '2024-03-05', quantity: '2 shears', source: ['E3'], quote: 'wished for shears' }),
      row({ what: 'watered the rows', date: '2024-03-09', said: '2024-03-09', source: ['E1'], quote: 'watered' }),
    ]);
    const result = await curate(TASK, GARDEN, { compression: 'low',
      decide: decider((index) => [0.9, 0.3, 0.2, 0.1][index]!).decide, write, taskDate: '2024-03-16' });
    expect(result.log).toBe([
      '### computed by code from extracted rows the decision model counted',
      '',
      'Figures over the 1 rows counted (of 4 rows extracted):',
      '- Rows counted: 1',
      '- Sum of amounts: $38 (38)',
      '',
      'Uncounted rows with an amount or quantity:',
      'The figures above omit every row listed here: they are not included in the row count, sums or date calculations.',
      '2. [probability 0.3] who: you | what: bought twine | status: done | date: 2024-03-02 (said 2024-03-02) | amount: $12 | quantity: - | log sections: E3, E1 "bought twine"',
      '3. [probability 0.2] who: you | what: wished for shears | status: wished | date: not stated (said 2024-03-05) | amount: - | quantity: 2 shears | log sections: E2 "wished for shears"',
      '',
      'Counted rows, by date:',
      '1. [2024-03-09, 7 days before the question date] who: you | what: bought seed | status: done | date: 2024-03-09 (said 2024-03-09) | amount: $38 | quantity: - | source: E1 "bought seed"',
      '',
      '### marked-up log, the parts the rows cite',
      '',
      '## E1 (said 2024-03-02)',
      'user: <event who="you" status="done">Netted the koi pond.</event>',
      '',
      '## E2 (said 2024-03-05)',
      'user: <event who="you" status="done">Pruned the medlar.</event>',
      '',
      '## E3 (said 2024-03-09)',
      'user: <event who="you" status="done">Planted the quince row.</event>',
      '',
      '',
      '',
    ].join('\n'));
    expect(result.record.uncountedListed).toBe(2);
  });

  it('keeps duplicate uncounted rows in extraction order', async () => {
    const { write } = model([
      row({ what: 'bought seed', amount: '$38', source: ['E1'] }),
      row({ what: 'bought twine', amount: '$12', source: ['E2'], quote: 'twine' }),
      row({ what: 'bought twine', amount: '$12', source: ['E2'], quote: 'twine' }),
    ]);
    const result = await curate(TASK, GARDEN, { compression: 'low',
      decide: decider((index) => [0.9, 0.4, 0.4][index]!).decide, write });
    const block = result.log.slice(result.log.indexOf('Uncounted rows'), result.log.indexOf('Counted rows'));
    expect(block).toBe('Uncounted rows with an amount or quantity:\n'
      + 'The figures above omit every row listed here: they are not included in the row count, sums or date calculations.\n'
      + '2. [probability 0.4] who: you | what: bought twine | status: done | date: not stated (said ) | amount: $12 | quantity: - | log sections: E1 "twine"\n'
      + '3. [probability 0.4] who: you | what: bought twine | status: done | date: not stated (said ) | amount: $12 | quantity: - | log sections: E1 "twine"\n\n');
    expect(result.record.uncountedListed).toBe(2);
  });

  it('leaves a citation to no marked-up part out of the list, and shows - for a row left with none', async () => {
    const { write } = model([
      row({ what: 'bought seed', amount: '$38', source: ['E1'] }),
      row({ what: 'bought twine', amount: '$12', source: ['E2', 'E9'], quote: 'twine' }),
      row({ what: 'bought pots', amount: '$5', source: ['E9'], quote: 'pots' }),
      row({ what: 'swept the path', quantity: '3 passes', source: [], quote: 'swept' }),
    ]);
    const result = await curate(TASK, GARDEN, { compression: 'low',
      decide: decider((index) => [0.9, 0.3, 0.3, 0.3][index]!).decide, write });
    expect(result.log).toContain('2. [probability 0.3] who: you | what: bought twine | status: done | date: not stated (said ) | amount: $12 | quantity: - | log sections: E1 "twine"');
    expect(result.log).toContain('3. [probability 0.3] who: you | what: bought pots | status: done | date: not stated (said ) | amount: $5 | quantity: - | log sections: - "pots"');
    expect(result.log).toContain('4. [probability 0.3] who: you | what: swept the path | status: done | date: not stated (said ) | amount: - | quantity: 3 passes | log sections: - "swept"');
    expect(result.record.uncountedListed).toBe(3);
  });

  it('leaves the head byte-identical when no uncounted row carries an amount or quantity', async () => {
    const { write } = model([
      row({ what: 'bought seed', date: '2024-03-09', said: '2024-03-09', amount: '$38', source: ['E1'], quote: 'bought seed' }),
      row({ what: 'watered the rows', date: '2024-03-09', said: '2024-03-09', source: ['E1'], quote: 'watered' }),
      row({ what: 'wished for rain', status: 'wished', said: '2024-03-09', amount: '  ', source: ['E1'], quote: 'rain' }),
    ]);
    const result = await curate(TASK, GARDEN, { compression: 'low',
      decide: decider((index) => [0.9, 0.1, 0.2][index]!).decide, write, taskDate: '2024-03-16' });
    expect(result.log.split('\n### marked-up log')[0]).toBe([
      '### computed by code from extracted rows the decision model counted',
      '',
      'Figures over the 1 rows counted (of 3 rows extracted):',
      '- Rows counted: 1',
      '- Sum of amounts: $38 (38)',
      '',
      'Counted rows, by date:',
      '1. [2024-03-09, 7 days before the question date] who: you | what: bought seed | status: done | date: 2024-03-09 (said 2024-03-09) | amount: $38 | quantity: - | source: E1 "bought seed"',
      '',
    ].join('\n'));
    expect(result.record.uncountedListed).toBe(0);
  });

  it('puts the figures first, then the cited sections in markup order', async () => {
    const { write } = model([row({ source: ['E1'] }), row({ source: ['E2'] })]);
    const result = await curate(TASK, GARDEN, { compression: 'low', decide: decider().decide, write });
    const below = result.log.slice(result.log.indexOf('### marked-up log'));
    expect(below).toBe('### marked-up log, the parts the rows cite\n\n'
      + '## E1 (said 2024-03-02)\nuser: <event who="you" status="done">Netted the koi pond.</event>\n\n'
      + '## E3 (said 2024-03-09)\nuser: <event who="you" status="done">Planted the quince row.</event>\n\n\n');
    expect(result.log.indexOf('Counted rows, by date:')).toBeLessThan(result.log.indexOf('### marked-up log'));
  });

  it('with no rows, asks no decision and no markup and writes the empty figures', async () => {
    const { calls, write } = model([]);
    const { batches, decide } = decider();
    const result = await curate(TASK, GARDEN, { compression: 'low', decide, write });
    expect(calls.map((call) => call.step)).toEqual(['extract']);
    expect(batches).toHaveLength(0);
    expect(result.log).toBe('### computed by code from extracted rows the decision model counted\n\n'
      + 'Figures over the 0 rows counted (of 0 rows extracted):\n- Rows counted: 0\n\nCounted rows, by date:\n(none)\n\n');
  });

  it('with rows that cite no part, decides them and marks up nothing', async () => {
    const { calls, write } = model([row({ source: [] }), row({ source: ['E9'] })]);
    const { batches, decide } = decider();
    const result = await curate(TASK, GARDEN, { compression: 'low', decide, write });
    expect(calls.map((call) => call.step)).toEqual(['extract']);
    expect(batches[0]!.questions).toHaveLength(2);
    expect(result.log).toContain('- Rows counted: 2');
    expect(result.log).not.toContain('### marked-up log');
    expect(result.log.endsWith('\n\n')).toBe(true);
  });

  it('with nothing counted, still marks up the parts the extracted rows cite', async () => {
    const { write } = model([row({ source: ['E2'] })]);
    const result = await curate(TASK, GARDEN, { compression: 'low', decide: decider(0.1).decide, write });
    expect(result.log).toContain('Figures over the 0 rows counted (of 1 rows extracted):\n- Rows counted: 0\n\nCounted rows, by date:\n(none)\n\n### marked-up log');
    expect(result.log).toContain('koi');
  });

  it('reads benchmark labels, ISO dates, timestamps and undated parts as said dates across sources', async () => {
    const items = [
      part('notes', 'a', '2024-03-05', 'Iso day.'),
      part('chat', 'b', 'dated 2024/03/02 (Sat) 10:00', 'Label day.'),
      part('git', 'c', '2024-03-04T23:30:00+00:00', 'Timestamp day.'),
      part('notes', 'd', undefined, 'No day.'),
    ];
    const { write, markups } = model([1, 2, 3, 4].map((n) => row({ source: [`E${n}`] })));
    const result = await curate(TASK, picked(items), { compression: 'low', decide: decider().decide, write, taskDate: '2024-03-16T08:00:00Z' });
    expect([...markups()[0]!.body.matchAll(/^### (E\d+) \(said ([^)]*)\): Title (\w)/gm)].map((match) => match.slice(1).join(' ')))
      .toEqual(['E1 unknown d', 'E2 2024-03-02 b', 'E3 2024-03-04 c', 'E4 2024-03-05 a']);
    expect(result.log).toContain('## E1 (said unknown)');
  });

  it('runs markup chunks at once within the bound, keeps chunk order however calls finish, and records each call', async () => {
    const big = (n: number) => part('notes', `p${n}`, `2024-03-1${n}`, `Chunk ${n} ${'x'.repeat(25_000)}`);
    const items = [0, 1, 2, 3, 4, 5].map(big);
    let open = 0;
    let most = 0;
    const { write } = model(items.map((_, n) => row({ source: [`E${n + 1}`] })), async (prompt) => {
      open += 1;
      most = Math.max(most, open);
      const n = Number(/Chunk (\d)/.exec(prompt.body)![1]);
      await new Promise((done) => setTimeout(done, 5 * (6 - n)));
      open -= 1;
      // The last chunk, which finishes first, also repeats the first part's
      // heading: in chunk order the first part's own section comes first.
      return markupReply(prompt.body) + (n === 5 ? '\n\n## E1 (said 2024-03-10)\nuser: a stray copy' : '');
    });
    const result = await curate(TASK, picked(items), { compression: 'low', decide: decider().decide, write });
    expect(result.record.chunks).toBe(6);
    expect(most).toBe(MARKUP_CALLS_AT_ONCE);
    expect([...result.log.matchAll(/Chunk (\d)/g)].map((match) => match[1])).toEqual(['0', '1', '2', '3', '4', '5']);
    expect(result.log).not.toContain('a stray copy');
    const markupCalls = result.record.calls.filter((call) => call.step === 'markup');
    expect(markupCalls.map((call) => call.chunk).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(markupCalls.map((call) => call.chunk)).not.toEqual([1, 2, 3, 4, 5, 6]);
    expect(markupCalls.every((call) => call.status === 'done' && call.ms >= 0)).toBe(true);
    expect(Object.keys(result.record.ms)).toEqual(['extract', 'decide', 'markup', 'total']);
  });

  it('extracts evidence over the log\'s batch size in batches, numbering parts across the whole selection', async () => {
    const huge = (n: number) => part('notes', `h${n}`, `2024-04-0${n + 1}`, `Batch part ${n} ${'y'.repeat(250_000)}`);
    const items = [0, 1, 2].map(huge);
    const extracts: CuratePrompt[] = [];
    const ids = (prompt: CuratePrompt) => [...prompt.body.matchAll(/^### (E\d+) /gm)].map((match) => match[1]!);
    const write: CurateWrite = async (prompt) => {
      if (prompt.step !== 'extract') return markupReply(prompt.body);
      extracts.push(prompt);
      // Each batch cites its own last part by its number in the whole selection.
      const last = ids(prompt).at(-1)!;
      return rowsReply([row({ what: `event in ${last}`, source: [last] })]);
    };
    const result = await curate(TASK, picked(items), { compression: 'low', decide: decider().decide, write });
    expect(extracts.map(ids)).toEqual([['E1', 'E2'], ['E3']]);
    expect(extracts.every((prompt) => prompt.body.length < 4 * DEFAULT_BATCH_TOKENS)).toBe(true);
    expect(extracts.every((prompt) => prompt.instructions === EXTRACT && prompt.body.startsWith(`TASK:\n${TASK}`))).toBe(true);
    expect(result.record.rows.map((extracted) => extracted.what)).toEqual(['event in E2', 'event in E3']);
    expect(result.record.marked.map((marked) => marked.id)).toEqual(['h1', 'h2']);
    expect(result.record.calls.filter((call) => call.step === 'extract').map((call) => call.chunk).sort()).toEqual([1, 2]);
  });

  it('a failed markup call cancels the others and fails the whole call with each call recorded', async () => {
    const big = (n: number) => part('notes', `p${n}`, `2024-03-1${n}`, `Chunk ${n} ${'x'.repeat(25_000)}`);
    const items = [0, 1, 2, 3].map(big);
    const { write } = model(items.map((_, n) => row({ source: [`E${n + 1}`] })), (prompt) => new Promise((done, fail) => {
      if (/Chunk 1/.test(prompt.body)) setTimeout(() => fail(new Error('route down')), 5);
    }));
    const signalled: AbortSignal[] = [];
    const watching: CurateWrite = (prompt, signal) => {
      signalled.push(signal);
      const reply = write(prompt, signal);
      return prompt.step === 'markup'
        ? Promise.race([reply, new Promise<string>((_, fail) => signal.addEventListener('abort', () => fail(signal.reason)))])
        : reply;
    };
    const error = await curate(TASK, picked(items), { compression: 'low', decide: decider().decide, write: watching })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CurateError);
    expect((error as CurateError).step).toBe('markup');
    expect((error as CurateError).message).toContain('route down');
    const statuses = (error as CurateError).calls.filter((call) => call.step === 'markup').map((call) => [call.chunk, call.status]);
    expect(statuses).toContainEqual([2, 'failed']);
    expect(statuses.filter(([, status]) => status === 'cancelled')).toHaveLength(3);
  });
});

describe("compression: 'low' never returns failed work as an empty memory", () => {
  const fails = async (run: Promise<unknown>, step: string, message: RegExp) => {
    const error = await run.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CurateError);
    expect((error as CurateError).step).toBe(step);
    expect((error as CurateError).message).toMatch(message);
    expect((error as CurateError).calls.length).toBeGreaterThan(0);
    return error as CurateError;
  };

  it('asks extraction again for JSON rows, and fails after three calls', async () => {
    const { calls, write } = model('Here are the rows: none.');
    const error = await fails(curate(TASK, GARDEN, { compression: 'low', decide: decider().decide, write }), 'extract', /JSON rows after 3 calls/);
    expect(calls).toHaveLength(3);
    expect(error.calls.map((call) => [call.step, call.attempt, call.status])).toEqual([
      ['extract', 1, 'done'], ['extract', 2, 'done'], ['extract', 3, 'done']]);
  });

  it('asks extraction again when a row is not an object, and fails after three calls', async () => {
    const { calls, write } = model('{"rows": [null, 42, "bad"]}');
    const { batches, decide } = decider();
    const error = await fails(curate(TASK, GARDEN, { compression: 'low', decide, write }), 'extract', /JSON rows after 3 calls: row 1 is not an object/);
    expect(calls).toHaveLength(3);
    expect(batches).toHaveLength(0);
    expect(error.calls.map((call) => call.step)).toEqual(['extract', 'extract', 'extract']);
  });

  it('fails when one extraction batch never returns JSON rows', async () => {
    const huge = (n: number) => part('notes', `h${n}`, `2024-04-0${n + 1}`, `Batch part ${n} ${'y'.repeat(250_000)}`);
    const write: CurateWrite = async (prompt) => prompt.step === 'extract' && prompt.body.includes('Batch part 2')
      ? 'no rows here' : rowsReply([row({ source: ['E1'] })]);
    const error = await fails(curate(TASK, picked([0, 1, 2].map(huge)), { compression: 'low', decide: decider().decide, write }),
      'extract', /batch 2 of 2: no reply held JSON rows after 3 calls/);
    expect(error.calls.filter((call) => call.step === 'extract' && call.chunk === 2)).toHaveLength(3);
  });

  it('takes rows from a second extraction reply when the first is not JSON', async () => {
    let n = 0;
    const write: CurateWrite = async (prompt) => prompt.step === 'extract'
      ? (n++ === 0 ? 'no json here' : '```json\n{"rows": []}\n```') : '';
    const result = await curate(TASK, GARDEN, { compression: 'low', decide: decider().decide, write });
    expect(result.record.calls.map((call) => call.attempt)).toEqual([1, 2]);
  });

  it('fails when a row has no answer or a refused one, or the decision call throws', async () => {
    const { write } = model([row({ source: ['E1'] }), row({ source: ['E1'] })]);
    const missing: PickDecide = async ({ questions }) => ({ [questions[0]!.key]: { status: 'answered', probability: 0.9 } });
    await fails(curate(TASK, GARDEN, { compression: 'low', decide: missing, write }), 'decide', /1 of 2 rows unanswered \(row-2: missing\)/);
    const refused: PickDecide = async ({ questions }) => Object.fromEntries(questions.map((q) => [q.key, { status: 'refused' as const }]));
    await fails(curate(TASK, GARDEN, { compression: 'low', decide: refused, write }), 'decide', /row-1: refused, row-2: refused/);
    const broken: PickDecide = async () => { throw new Error('HTTP 503'); };
    const error = await fails(curate(TASK, GARDEN, { compression: 'low', decide: broken, write }), 'decide', /HTTP 503/);
    expect(error.calls.at(-1)).toMatchObject({ step: 'decide', status: 'failed', error: 'HTTP 503' });
  });

  it('asks markup again while it is empty, and fails after three empty replies', async () => {
    const { write, markups } = model([row({ source: ['E1'] })], () => '   ');
    await fails(curate(TASK, GARDEN, { compression: 'low', decide: decider().decide, write }), 'markup', /chunk 1 of 1 came back empty after 3 calls/);
    expect(markups()).toHaveLength(3);
  });

  it('fails when the markup holds no heading of any cited part', async () => {
    const { write } = model([row({ source: ['E1'] })], () => 'user: planted the quince row');
    await fails(curate(TASK, GARDEN, { compression: 'low', decide: decider().decide, write }), 'markup', /left out E3 \(\["orchard","note#1"\]\)/);
  });

  // The stand-in markup without the koi part's section.
  const withoutKoi = (prompt: CuratePrompt) => markupReply(prompt.body).split('\n\n').filter((section) => !section.includes('koi')).join('\n\n');

  it('asks markup again when it leaves out a part it was sent, and keeps the complete reply', async () => {
    let n = 0;
    const { write, markups } = model([row({ source: ['E1'] }), row({ source: ['E2'] })],
      (prompt) => n++ === 0 ? withoutKoi(prompt) : markupReply(prompt.body));
    const result = await curate(TASK, GARDEN, { compression: 'low', decide: decider(0.2).decide, write });
    expect(markups()).toHaveLength(2);
    expect(result.log).toContain('Netted the koi pond.');
    expect(result.log).toContain('Planted the quince row.');
  });

  it('fails when markup still leaves out a cited part after three calls, though no row counts', async () => {
    const { write, markups } = model([row({ source: ['E1'] }), row({ source: ['E2'] })], withoutKoi);
    const error = await fails(curate(TASK, GARDEN, { compression: 'low', decide: decider(0.2).decide, write }),
      'markup', /chunk 1 of 1 left out E1 \(\["pond","note#1"\]\) after 3 calls/);
    expect(markups()).toHaveLength(3);
    expect(error.calls.filter((call) => call.step === 'markup')).toHaveLength(3);
  });

  it('fails when one chunk of several leaves out its part', async () => {
    const big = (n: number) => part('notes', `p${n}`, `2024-03-1${n}`, `Chunk ${n} ${'x'.repeat(25_000)}`);
    const items = [0, 1, 2].map(big);
    const { write } = model(items.map((_, n) => row({ source: [`E${n + 1}`] })),
      (prompt) => /Chunk 1/.test(prompt.body) ? 'user: the second chunk, with no heading' : markupReply(prompt.body));
    await fails(curate(TASK, picked(items), { compression: 'low', decide: decider().decide, write }),
      'markup', /chunk 2 of 3 left out E2 \(p1\) after 3 calls/);
  });

  it('fails with a cancelled call when the caller aborts', async () => {
    const controller = new AbortController();
    const write: CurateWrite = (_prompt, signal) => new Promise((_, fail) => {
      signal.addEventListener('abort', () => fail(signal.reason));
      controller.abort(new Error('stopped by the caller'));
    });
    const error = await fails(curate(TASK, GARDEN, { compression: 'low', decide: decider().decide, write, signal: controller.signal }),
      'extract', /stopped by the caller/);
    expect(error.calls).toMatchObject([{ step: 'extract', status: 'cancelled' }]);
  });
});

describe('the compression option', () => {
  const never: CurateWrite = async () => { throw new Error('no call expected'); };
  const { decide } = decider();

  it.each([
    [{ working: true }, 'working'], [{ context: true }, 'context'], [{ routeByTask: true }, 'routeByTask'],
    [{ preferenceAdvice: true }, 'preferenceAdvice'], [{ preferenceChange: true }, 'preferenceChange'],
    [{ route: 'jev' }, 'route'], [{ contextLimit: 100 }, 'contextLimit'], [{ batchTokens: 100 }, 'batchTokens'],
    [{ weightBands: [0.2, 0.7] }, 'weightBands'],
  ])('rejects %o under low before any call', async (extra, name) => {
    await expect(curate(TASK, GARDEN, { compression: 'low', decide, write: never, ...extra } as never))
      .rejects.toThrow(new RegExp(`compression: 'low' writes no dated log, so it cannot take ${name}`));
  });

  it('needs decide for low, rejects it for high, and rejects an unknown value', async () => {
    await expect(curate(TASK, GARDEN, { compression: 'low', write: never } as never)).rejects.toThrow(/needs decide/);
    await expect(curate(TASK, GARDEN, { write: never, decide } as never)).rejects.toThrow(/decide is read only with compression: 'low'/);
    await expect(curate(TASK, GARDEN, { compression: 'medium', write: never } as never)).rejects.toThrow(/'high' or 'low'/);
  });

  it('memory rejects an unsupported low option before any read or decision call', async () => {
    let reads = 0;
    let decisions = 0;
    const source = { id: 'notes', role: 'mixed' as const, read: async () => {
      reads++;
      return { status: 'read' as const, complete: true, candidates: [part('notes', 'n1', '2024-03-02', 'Netted the koi pond.')] };
    } };
    const counting: PickDecide = async (batch) => {
      decisions++;
      return decide(batch, new AbortController().signal);
    };
    await expect(memory({ sources: [source], decide: counting, write: never, curate: { compression: 'low', working: true } as never }).recall(TASK))
      .rejects.toThrow(/cannot take working/);
    await expect(memory({ sources: [source], decide: counting, write: never, curate: { compression: 'medium' } as never }).recall(TASK))
      .rejects.toThrow(/'high' or 'low'/);
    expect([reads, decisions]).toEqual([0, 0]);
  });

  it('memory passes its decision function to the row question', async () => {
    const asked: string[] = [];
    const decideAll: PickDecide = async (batch) => {
      asked.push(...batch.questions.map((question) => question.question));
      return Object.fromEntries(batch.questions.map((question) => [question.key, { status: 'answered' as const, probability: 0.9 }]));
    };
    const { write } = model([row({ source: ['E1'] })]);
    const source = { id: 'notes', role: 'mixed' as const,
      read: async () => ({ status: 'read' as const, complete: true, candidates: [part('notes', 'n1', '2024-03-02', 'Netted the koi pond.')] }) };
    const recalled = await memory({ sources: [source], decide: decideAll, write, curate: { compression: 'low' } }).recall(TASK);
    expect(asked).toContain(ROW_QUESTION);
    expect(recalled.result.record.compression).toBe('low');
    expect(recalled.log).toContain('koi');
  });
});
