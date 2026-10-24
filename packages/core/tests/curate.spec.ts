import { describe, expect, it } from 'vitest';

import {
  curate,
  pick,
  type CuratePrompt,
  type CurateWrite,
  type MemoryCandidate,
  type PickResult,
} from '../src/index.js';

const uncutPick = { everyRanked: true, everyScored: true, rare: false } as const;

const LOG = '[2023-05-13] Visited York (said 2023-05-20; notes#2)';
const LONG_LOG = `[2023-05-13] ${'Travel notes. '.repeat(400)} (said 2023-05-20; notes#2)`;
// The writer sees and cites each item's short `En` id; the returned
// log carries the full ids again, so expectations keep citing notes#N.
const SHORT_LOG = LOG.replace('notes#2', 'E1');
const LONG_SHORT_LOG = LONG_LOG.replace('notes#2', 'E1');

function candidate(id: string, date?: string): MemoryCandidate {
  return {
    sourceId: 'notes', id, title: `Title ${id}`, text: `Text ${id}`,
    role: 'reference', signals: {},
    ...(date === undefined ? {} : { date: { value: date, meaning: 'recorded' } }),
  };
}

function picked(items = [candidate('notes#2', '2023-05-20')], weights = [0.9]): PickResult {
  return {
    selected: items,
    record: {
      questionVersion: 'test', limits: {},
      thresholds: { linkedPathBar: 0 }, rulesCoverage: 'complete',
      levers: { everyRanked: true, everyScored: true, route: false, rare: false, sources: {} },
      effects: [],
      candidates: items.map((item, index) => ({
        sourceId: item.sourceId, id: item.id, role: item.role, priority: index,
        signals: item.signals, status: 'selected', asked: true, probability: weights[index]!,
      })),
    },
  };
}

function writer(text: string | readonly string[] = SHORT_LOG): { write: CurateWrite; calls: CuratePrompt[]; signals: AbortSignal[] } {
  const calls: CuratePrompt[] = [];
  const signals: AbortSignal[] = [];
  return {
    calls, signals,
    write: async (prompt, signal) => {
      calls.push(prompt);
      signals.push(signal);
      return typeof text === 'string' ? text : text[calls.length - 1]!;
    },
  };
}

describe('curate', () => {

  it('keeps context guidance opt-in and carries it through condensation', async () => {
    const base = writer();
    await curate('Recall', picked(), { write: base.write });
    const { write, calls } = writer([LONG_SHORT_LOG, SHORT_LOG]);
    const result = await curate('Recall', picked(), { write, context: true, contextLimit: 100 });
    const context = calls[0]!.instructions.slice(base.calls[0]!.instructions.length);
    expect(context).toContain('each observation names who, where and which item');
    expect(context).toContain('Resolve pronouns only when that session states the link');
    expect(calls[1]!.instructions.endsWith(context)).toBe(true);
    expect(result.record.context).toBe(true);
    expect(base.calls[0]!.instructions).not.toContain('Carry these links');
  });

  it('routes counts and dates while retaining every supplied session', async () => {
    const { write, calls } = writer();
    const result = await curate('List every trip before June.', picked(), { write, routeByTask: true, context: true });
    expect(result.record).toMatchObject({ working: true, preferenceAdvice: false, context: true, taskKinds: ['count', 'date'] });
    expect(calls[0]!.instructions).toContain('every instance across the supplied sessions');
    expect(calls[0]!.instructions).toContain('number each distinct instance');
    expect(calls[0]!.body).toContain('Text notes#2');
  });

  it('routes advice without adding working notes and respects explicit switches', async () => {
    const advice = writer();
    const result = await curate('What should I cook?', picked(), { write: advice.write, routeByTask: true });
    expect(result.record).toMatchObject({ working: false, preferenceAdvice: true, taskKinds: ['advice'] });
    const explicit = writer();
    const overridden = await curate('What should I cook?', picked(), {
      write: explicit.write, routeByTask: true, working: true, preferenceAdvice: false,
    });
    expect(overridden.record).toMatchObject({ working: true, preferenceAdvice: false });
    expect(explicit.calls[0]!.instructions).not.toContain('Advice preferences:');
  });

  it('adds the task date to both writer calls and records it', async () => {
    const { write, calls } = writer([LONG_SHORT_LOG, SHORT_LOG]);
    const result = await curate('Recall', picked(), { write, taskDate: '2023-05-22', contextLimit: 100 });
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.body).toMatch(/^TASK:\nRecall \(asked 2023-05-22\)\n/);
    expect(result.record.taskDate).toBe('2023-05-22');
  });

  it('keeps the dataset date label exactly as supplied', async () => {
    const { write, calls } = writer(SHORT_LOG);
    const taskDate = '2023/05/30 (Tue) 23:40';
    await curate('Recall', picked(), { write, taskDate });
    expect(calls[0]!.body).toMatch(/^TASK:\nRecall \(asked 2023\/05\/30 \(Tue\) 23:40\)\n/);
  });

  it('accepts source ids before the preference guidance', async () => {
    const text = SHORT_LOG + '\nAdvice preferences: Walks (E1). Apply these to related requests.';
    const expected = LOG + '\nAdvice preferences: Walks (notes#2). Apply these to related requests.';
    expect((await curate('Recall', picked(), { write: writer(text).write, preferenceAdvice: true })).log).toBe(expected);
  });

  it('repairs and drops an unsupported preference below the working section without losing the log', async () => {
    const working = "\nWorking (the curator's; check it against the log):\n1. York.";
    const line = 'Advice preferences: Walks (E9)';
    const { write, calls } = writer(SHORT_LOG + working + '\n' + line);
    const result = await curate('Recall', picked(), { write, working: true, preferenceAdvice: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toContain('preference lines need text and source');
    expect(result.log).toBe(LOG + working);
    expect(result.record).toMatchObject({ repairs: 1, formatRecovery: { keptAsWritten: [], dropped: [line] } });
  });

  it.each(['', '  '])('rejects empty task date %j before writing', async (taskDate) => {
    const { write, calls } = writer();
    await expect(curate('Recall', picked(), { write, taskDate })).rejects.toThrow('taskDate must be a nonempty');
    expect(calls).toHaveLength(0);
  });

  it('adds exact prototype preference instructions after worked notes in both calls', async () => {
    const base = writer();
    await curate('Advice', picked(), { write: base.write, working: true });
    const advice = '\nIf the task asks for advice, suggestions or recommendations (including whether something is a good idea): end the log with one or two short lines starting "Advice preferences:" naming the user\'s stated tastes, relevant experiences and constraints, with source ids. Tell the reader these apply to related requests even when this exact activity was never discussed. Do not invent preferences or confirmed event dates; absent schedules do not prevent suggesting suitable event types and ways to find them. Otherwise add no advice line.';
    const change = '\nAdd one or two short lines starting "Changed preference:" only when the user states a change of taste or an exclusion relevant to the task. Name what they moved away from, what the user wants instead and any stated exclusions, with source ids. Tell the reader: Do not suggest the old taste for this request to move beyond it. Do not infer a permanent dislike or a change from an assistant suggestion. If no such change or exclusion is stated, add no change line.';
    const shared = '\nKeep each added kind to one or two short lines. When merging or shortening, combine repeated preference lines and put them at the end.';
    const preferences = '\nAdvice preferences: Likes history (notes#2)\nChanged preference: Wants quieter trips [notes#2]';
    const written = '\nAdvice preferences: Likes history (E1)\nChanged preference: Wants quieter trips [E1]';
    const { write, calls } = writer([LONG_SHORT_LOG + written, SHORT_LOG + written]);
    const result = await curate('Advice', picked(), {
      write, working: true, preferenceAdvice: true, preferenceChange: true, contextLimit: 200,
    });
    expect(calls[0]!.instructions).toBe(base.calls[0]!.instructions + advice + change + shared);
    expect(calls[1]!.instructions.endsWith(advice + change + shared)).toBe(true);
    expect(result.log).toBe(LOG + preferences);
    expect(result.record).toMatchObject({ preferenceAdvice: true, preferenceChange: true });
  });

  it.each([
    'Advice preferences: Likes history (E9)',
    'Advice preferences: Likes history',
    'Changed preference: Wants quiet trips [E9]',
  ])('drops a preference with no supplied source after repair: %j', async (line) => {
    const { write, calls } = writer(SHORT_LOG + '\n' + line);
    const result = await curate('Advice', picked(), { write, preferenceAdvice: true, preferenceChange: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toContain('preference lines need text and source');
    expect(result.log).toBe(LOG);
    expect(result.record).toMatchObject({ repairs: 1, formatRecovery: { keptAsWritten: [], dropped: [line] } });
  });

  it.each([
    'Advice preferences: Likes history (E1, E9)',
    'Changed preference: (E1)',
  ])('keeps a malformed preference naming a supplied source after repair: %j', async (line) => {
    const { write, calls } = writer(SHORT_LOG + '\n' + line);
    const result = await curate('Advice', picked(), { write, preferenceAdvice: true, preferenceChange: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toContain('preference lines need text and source');
    expect(result.log).toBe(LOG + '\n' + line.replace('E1', 'notes#2'));
    expect(result.record).toMatchObject({ repairs: 1, formatRecovery: { keptAsWritten: [line], dropped: [] } });
  });

  it('asks for a dated observation before recovering a cited preference alone', async () => {
    const { write, calls } = writer('Advice preferences: Likes history (E1)');
    const result = await curate('Advice', picked(), { write, preferenceAdvice: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toContain('at least one dated observation');
    expect(result.log).toBe('Advice preferences: Likes history (notes#2)');
    expect(result.record.repairs).toBe(1);
    expect(result.record.formatRecovery).toEqual({ keptAsWritten: [], dropped: [] });
  });

  it.each([
    [SHORT_LOG.replace('2023-05-13', '2023-02-30'), 'each observation needs an event date'],
    [SHORT_LOG + '\nChanged preference: Wants quiet trips (E1)', 'unexpected preference line'],
  ])('keeps format checks active with preferences enabled: %j', async (text, reason) => {
    const { write, calls } = writer([text, SHORT_LOG]);
    const result = await curate('Advice', picked(), { write, preferenceAdvice: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toContain(reason);
    expect(result.log).toBe(LOG);
    expect(result.record.repairs).toBe(1);
    expect(result.record).not.toHaveProperty('formatRecovery');
  });

  it('sends v4 instructions and all three weight tiers in one write call', async () => {
    const { write, calls } = writer();
    const result = await curate('Where did I go?', picked(), { write });
    expect(calls).toHaveLength(1);
    const instructions = calls[0]!.instructions;
    expect(instructions).toContain('[YYYY-MM-DD the event happened]');
    expect(instructions).toContain('said YYYY-MM-DD; the item id from its header');
    expect(instructions).toContain('Never shift a date that is already absolute.');
    expect(instructions).toContain('always end the later line with "(replaces [the earlier date])"');
    expect(instructions).toContain('Make sure every observation from items weighted 0.6 or more is in the log.');
    expect(instructions).toContain('Items weighted from 0.1 to 0.6 are less direct');
    expect(instructions).toContain('Items weighted below 0.1 rarely matter');
    expect(instructions).not.toContain('3500');
    expect(instructions).not.toContain('Working (the curator');
    expect(result.log).toBe(LOG);
    expect(result.record).toMatchObject({ promptVersion: 'v4', weights: 'tiers', working: false });
    expect(result.record).not.toHaveProperty('formatRecovery');
    expect(result).not.toHaveProperty('blocks');
  });

  it('keeps header dates, exact text, and selected item order', async () => {
    const items = [candidate('notes#2', '2023-05-20'), candidate('notes#1', '2023-04-01')];
    const input = picked(items, [0.876, 0.05]);
    // The picker record may be in a different order than selected.
    const reversed = { ...input, record: { ...input.record, candidates: [...input.record.candidates].reverse() } };
    const { write, calls } = writer();
    const result = await curate('Where did I go?', reversed, { write });
    expect(calls[0]!.body).toBe('TASK:\nWhere did I go?\n\nEVIDENCE:\n\n'
      + '### E1 (2023-05-20, 0.876): Title notes#2\n\nText notes#2\n\n'
      + '### E2 (2023-04-01, 0.05): Title notes#1\n\nText notes#1');
    expect(result.record.items).toEqual([
      { id: 'notes#2', candidate: items[0], weight: 0.876 },
      { id: 'notes#1', candidate: items[1], weight: 0.05 },
    ]);
  });

  it('does not invent a missing header date', async () => {
    const { write, calls } = writer();
    await curate('Recall', picked([candidate('notes#2')]), { write });
    expect(calls[0]!.body).toContain('### E1 (0.9):');
  });

  it('adds optional worked notes for instances, gaps, and latest values', async () => {
    const working = "\n\nWorking (the curator's; check it against the log):\n1. 2023-05-13 (notes#2); 7 days before the said date.";
    const { write, calls } = writer(SHORT_LOG + working.replace('notes#2', 'E1'));
    const result = await curate('How many visits last week?', picked(), { write, working: true });
    expect(calls[0]!.instructions).toContain('In the log itself, do not judge');
    expect(calls[0]!.instructions).not.toContain('- Do not answer the task, do not count');
    expect(calls[0]!.instructions).toContain('number each distinct instance that falls inside the period');
    expect(calls[0]!.instructions).toContain('the computed difference or order');
    expect(calls[0]!.instructions).toContain('the latest value and its date');
    expect(calls[0]!.instructions).not.toContain('3500');
    expect(result.log).toBe(LOG + working);
    expect(result.record.working).toBe(true);
  });

  it.each([1, 2, 3, 4, 5, 6])('accepts a level %i Markdown working heading and repairs it when working is disabled', async (level) => {
    const heading = `${'#'.repeat(level)} Working (the curator's; check it against the log):`;
    const text = `${SHORT_LOG}\n\n${heading}\n1. One visit.`;
    expect((await curate('How many visits?', picked(), { write: writer(text).write, working: true })).log)
      .toBe(text.replace(SHORT_LOG, LOG));
    const { write, calls } = writer(text);
    const result = await curate('Recall', picked(), { write });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toContain('unexpected or empty working section');
    expect(result.log).toBe(LOG);
    expect(result.record).toMatchObject({ repairs: 1,
      formatRecovery: { keptAsWritten: [], dropped: [heading, '1. One visit.'] } });
  });

  it('keeps selected rules outside the writer and retains their picker record', async () => {
    const rule: MemoryCandidate = { ...candidate('rule'), role: 'rule', applies: 'always', text: 'Follow this rule exactly' };
    const input = await pick([rule, candidate('notes#2')], { ...uncutPick,
      task: 'Recall', decide: async (batch) => Object.fromEntries(batch.questions.map((q) =>
        [q.key, { status: 'answered', probability: 0.9 }])),
    });
    const { write, calls } = writer();
    const result = await curate('Recall', input, { write });
    expect(calls[0]!.body).not.toContain(rule.text);
    expect(result.record.items.map((item) => item.candidate.id)).toEqual(['notes#2']);
    expect(input.selected).toContain(rule);
    expect(input.record.rulesCoverage).toBe('complete');
  });

  it('uses source and id together for weights and labels when ids clash', async () => {
    const items = [candidate('same'), { ...candidate('same'), sourceId: 'other' }];
    const { write, calls } = writer('[2023-05-13] Visited York (said 2023-05-20; E1)');
    const result = await curate('Recall', picked(items, [0.9, 0.3]), { write });
    expect(calls[0]!.body).toContain('### E1 (0.9):');
    expect(calls[0]!.body).toContain('### E2 (0.3):');
    expect(result.record.items.map((item) => [item.id, item.weight])).toEqual([
      ['["notes","same"]', 0.9], ['["other","same"]', 0.3],
    ]);
  });

  it.each(['', ' \n\t '])('returns an empty log, marked in the record, for empty output %j', async (text) => {
    const { write, calls } = writer(text);
    const result = await curate('Recall', picked(), { write });
    expect(calls).toHaveLength(2);
    expect(result.log).toBe('');
    expect(result.record).toMatchObject({ empty: true, emptyRetries: 1, logLength: 0, condensed: false });
    expect(result.record).not.toHaveProperty('repairs');
  });

  it('leaves the empty mark off a log with observations', async () => {
    const result = await curate('Recall', picked(), { write: writer('[2023-05-13] Visited York (said 2023-05-20; E1)').write });
    expect(result.record).not.toHaveProperty('empty');
  });

  it('returns a long log unchanged with one write call when no context limit is given', async () => {
    const { write, calls } = writer(LONG_SHORT_LOG);
    const result = await curate('Recall', picked(), { write });
    expect(LONG_LOG.length).toBeGreaterThan(3500);
    expect(result.log).toBe(LONG_LOG);
    expect(calls).toHaveLength(1);
    expect(result.record).toMatchObject({ logLength: LONG_LOG.length, condensed: false, overContextLimit: false });
    expect(result.record).not.toHaveProperty('condensedLength');
    expect(result.record).not.toHaveProperty('contextLimit');
  });

  it.each([LOG.length, LOG.length + 1])('does not condense a log within a context limit of %i', async (contextLimit) => {
    const { write, calls } = writer(` \n${SHORT_LOG}\n `);
    const result = await curate('Recall', picked(), { write, contextLimit });
    expect(result.log).toBe(LOG);
    expect(calls).toHaveLength(1);
    expect(result.record).toMatchObject({ logLength: LOG.length, condensed: false, contextLimit, overContextLimit: false });
    expect(result.record).not.toHaveProperty('condensedLength');
  });

  it('condenses once through write, dropping the weakest tiers first and keeping the top tier whole', async () => {
    const medium = '[2023-05-14] Checked trains (said 2023-05-20; notes#3)';
    const weak = LONG_LOG.replace('notes#2', 'notes#4');
    const original = `${LOG}\n${medium}\n${weak}`;
    const written = `${SHORT_LOG}\n${medium.replace('notes#3', 'E2')}\n${weak.replace('notes#4', 'E3')}`;
    const input = picked([candidate('notes#2'), candidate('notes#3'), candidate('notes#4')], [0.6, 0.1, 0.05]);
    const controller = new AbortController();
    const { write, calls, signals } = writer([written, SHORT_LOG]);
    const result = await curate('Where did I go?', input, { write, contextLimit: LOG.length, signal: controller.signal });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.instructions).not.toContain('3500');
    const prompt = calls[1]!;
    // The stated budget is the caller's limit scaled to the short-id
    // characters the writer sees.
    expect(prompt.instructions).toContain(
      `Condense the log for the task to at most ${Math.floor(LOG.length * written.length / original.length)} characters`);
    expect(prompt.instructions).toMatch(/First: merge or drop observations from items weighted below 0\.1\.[\s\S]*Next: merge or drop observations from items weighted from 0\.1 to below 0\.6\.[\s\S]*Keep observations from items weighted 0\.6 or more whole/);
    expect(prompt.instructions).toContain('event date, said date, source item ids, and replacement dates');
    expect(prompt.instructions).toContain('Never truncate text.');
    expect(prompt.body).toContain('TASK:\nWhere did I go?');
    expect(prompt.body).toContain('ITEM WEIGHTS:\nE1: 0.6\nE2: 0.1\nE3: 0.05');
    expect(prompt.body).toContain(`LOG:\n${written}`);
    expect(signals).toEqual([controller.signal, controller.signal]);
    expect(result.log).toBe(LOG);
    expect(result.record).toMatchObject({
      logLength: original.length, condensed: true, condensedLength: LOG.length,
      contextLimit: LOG.length, overContextLimit: false,
    });
  });

  it.each([LOG, LONG_LOG].map((text) => ({ text, written: text.replace('notes#2', 'E1'), length: text.length })))('returns a condensed log of $length characters still over the context limit with a record entry and no further call', async ({ text: condensed, written }) => {
    const { write, calls } = writer([LONG_SHORT_LOG, written]);
    const result = await curate('Recall', picked(), { write, contextLimit: 10 });
    expect(result.log).toBe(condensed);
    expect(calls).toHaveLength(2);
    expect(result.record).toMatchObject({
      logLength: LONG_LOG.length, condensed: true, condensedLength: condensed.length,
      contextLimit: 10, overContextLimit: true,
    });
  });

  it.each(['', 'undated summary', '[2023-05-13] Visited York (said 2023-05-20; E9)'])('keeps the original log when condensed output has no usable evidence: %j', async (text) => {
    const { write, calls } = writer([LONG_SHORT_LOG, text]);
    const result = await curate('Recall', picked(), { write, contextLimit: 100 });
    expect(calls).toHaveLength(2);
    expect(result.log).toBe(LONG_LOG);
    expect(result.record).toMatchObject({ condensed: true, condensedLength: LONG_LOG.length, overContextLimit: true,
      formatRecovery: { keptAsWritten: [], dropped: text === '' ? [] : [text] } });
    expect(result.record).not.toHaveProperty('repairs');
  });

  it('rejects a malformed first log after one format repair, before attempting to condense', async () => {
    const { write, calls } = writer('undated summary');
    await expect(curate('Recall', picked(), { write, contextLimit: 1 })).rejects.toThrow('curate: malformed log');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.instructions).toContain('rejected for its format');
    expect(calls.some((call) => call.instructions.includes('Condense the log'))).toBe(false);
  });

  it.each([0, -1, 1.5, NaN, Infinity])('rejects an invalid context limit of %s before writing', async (contextLimit) => {
    const { write, calls } = writer();
    await expect(curate('Recall', picked(), { write, contextLimit })).rejects.toThrow('contextLimit must be a positive integer');
    expect(calls).toHaveLength(0);
  });

  it.each([
    'Here is the answer: York.',
    '[2023-05-13] Visited York (said 2023-05-20; )',
    '[2023-05-13] Visited York (said 2023-05-20; ) (when not stated)',
    '[2023-05-13] Visited York (said 2023-05-20; E9)',
  ])('rejects output with no supplied source after repair: %j', async (text) => {
    const { write, calls } = writer(text);
    await expect(curate('Recall', picked(), { write })).rejects.toThrow('curate: malformed log');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toContain(text);
  });

  it.each([
    '[2023-05-13] Visited York (E1)',
    '[2023-05-13 the event happened] Visited York (said 2023-05-20; E1)',
    '[2023-02-30] Visited York (said 2023-05-20; E1)',
    '[2023-05-13] Visited York (said 2023-13-20; E1)',
    '[2023-05-13]   (said 2023-05-20; E1)',
    '[2023-05-13] Visited York (said 2023-05-20; E1) trailing prose',
    '[2023-05-13] Visited York (said 2023-05-20; E1) (replaces [not-a-date])',
    '[2023-05-13] Visited York (said 2023-05-20; E1) (replaces [2023-02-30])',
  ])('keeps a malformed observation naming a supplied source after repair: %j', async (text) => {
    const { write, calls } = writer(text);
    const result = await curate('Recall', picked(), { write });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toContain(text);
    expect(result.log).toBe(text.replace('E1', 'notes#2'));
    expect(result.record).toMatchObject({ repairs: 1, formatRecovery: { keptAsWritten: [text], dropped: [] } });
  });

  it.each([
    ['A line without dates'],
    ["Working (the curator's; check it against the log):", '1. A visit.'],
  ])('keeps valid observations and drops unsupported extra lines after repair: %j', async (...lines) => {
    const { write, calls } = writer([SHORT_LOG, ...lines].join('\n'));
    const result = await curate('Recall', picked(), { write });
    expect(calls).toHaveLength(2);
    expect(result.log).toBe(LOG);
    expect(result.record).toMatchObject({ repairs: 1, formatRecovery: { keptAsWritten: [], dropped: lines } });
  });

  it('rejects non-text output at the caller boundary', async () => {
    const write = (async () => null) as unknown as CurateWrite;
    await expect(curate('Recall', picked(), { write })).rejects.toThrow('write must return text');
  });

  it('rejects a working section with no cited evidence after repair', async () => {
    const { write, calls } = writer("Working (the curator's; check it against the log):\n1. A visit.");
    await expect(curate('Recall', picked(), { write, working: true }))
      .rejects.toThrow('curate: malformed log');
    expect(calls).toHaveLength(2);
  });

  it('drops an empty working heading after repair without losing observations', async () => {
    const heading = "Working (the curator's; check it against the log):";
    const { write, calls } = writer(`${SHORT_LOG}\n${heading}`);
    const result = await curate('Recall', picked(), { write, working: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toContain('unexpected or empty working section');
    expect(result.log).toBe(LOG);
    expect(result.record).toMatchObject({ repairs: 1, formatRecovery: { keptAsWritten: [], dropped: [heading] } });
  });

  it('accepts merged observations and replacements without dropping either date', async () => {
    const text = '[2023-05-13] Visited York (said 2023-05-20; notes#2, notes#3)\n[2023-05-21] Moved to Leeds (said 2023-05-22; notes#4) (replaces [2023-05-13])';
    const written = '[2023-05-13] Visited York (said 2023-05-20; E1, E2)\n[2023-05-21] Moved to Leeds (said 2023-05-22; E3) (replaces [2023-05-13])';
    const input = picked([candidate('notes#2'), candidate('notes#3'), candidate('notes#4')], [0.9, 0.9, 0.9]);
    const result = await curate('Recall', input, { write: writer(` \n${written}\n `).write });
    expect(result.log).toBe(text);
  });

  it.each([
    ['said 2023-05-20; E1; said 2023-05-21; E2', 'said 2023-05-20; notes#2; said 2023-05-21; notes#3'],
    ['said 2023-05-20; E1, E2; said 2023-05-21; E3; said 2023-05-22; E4) (when not stated',
     'said 2023-05-20; notes#2, notes#3; said 2023-05-21; notes#4; said 2023-05-22; notes#5) (when not stated'],
    ['said 2023-05-20; E1; said 2023-05-21; E2) (replaces [2023-04-01]',
     'said 2023-05-20; notes#2; said 2023-05-21; notes#3) (replaces [2023-04-01]'],
  ])('keeps each source date when several sources describe one event: %j', async (citations, restored) => {
    const written = `[2023-05-13] Planted an orchard (${citations})`;
    const input = picked(['notes#2', 'notes#3', 'notes#4', 'notes#5'].map((id) => candidate(id)), [0.9, 0.8, 0.7, 0.6]);
    expect((await curate('Recall', input, { write: writer(written).write })).log)
      .toBe(`[2023-05-13] Planted an orchard (${restored})`);
  });

  it.each([
    'said 2023-02-30; E2',
    'said 2023-13-01; E2',
    'said not-a-date; E2',
    'said 2023-05-21; E2; said 2023-02-30; E3',
  ])('repairs an invalid later citation date and retains the cited line if repair fails: %j', async (citation) => {
    const input = picked(['notes#2', 'notes#3', 'notes#4'].map((id) => candidate(id)), [0.9, 0.8, 0.7]);
    const text = `[2023-05-13] Planted an orchard (said 2023-05-20; E1; ${citation})`;
    const { write, calls } = writer(text);
    const result = await curate('Recall', input, { write });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toContain(text);
    expect(result.log).toBe(text.replace(/E([1-3])/g, (_, id: string) => `notes#${Number(id) + 1}`));
    expect(result.record).toMatchObject({ repairs: 1, formatRecovery: { keptAsWritten: [text], dropped: [] } });
  });

  it.each(['E9', 'E2, E9'])('repairs an unknown later source without losing the supplied source if repair fails: %j', async (sources) => {
    const input = picked([candidate('notes#2'), candidate('notes#3')], [0.9, 0.8]);
    const text = `[2023-05-13] Planted an orchard (said 2023-05-20; E1; said 2023-05-21; ${sources})`;
    const { write, calls } = writer(text);
    const result = await curate('Recall', input, { write });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toContain(text);
    expect(result.log).toBe(text.replace('E1', 'notes#2').replace('E2', 'notes#3'));
    expect(result.record).toMatchObject({ repairs: 1, formatRecovery: { keptAsWritten: [text], dropped: [] } });
  });

  it('accepts a date that was not stated and full ids containing punctuation', async () => {
    const id = 'notes (copy)[1].md#2';
    const text = `[2023-05-20] Visited York (said 2023-05-20; ${id}) (when not stated)`;
    const written = '[2023-05-20] Visited York (said 2023-05-20; E1) (when not stated)';
    expect((await curate('Recall', picked([candidate(id)]), { write: writer(written).write })).log).toBe(text);
  });

  it.each([', ', ',', '; ', ' and ', ' & ', ', and '])('accepts merged source ids separated by %j', async (separator) => {
    const text = `[2023-05-13] Visited York (said 2023-05-20; notes#2${separator}notes#3)`;
    const written = `[2023-05-13] Visited York (said 2023-05-20; E1${separator}E2)`;
    const input = picked([candidate('notes#2'), candidate('notes#3')], [0.9, 0.9]);
    expect((await curate('Recall', input, { write: writer(written).write })).log).toBe(text);
  });

  it('accepts exactly 3500 characters', async () => {
    const text = `[2023-05-13] ${'x'.repeat(3500 - LOG.length + 'Visited York'.length)} (said 2023-05-20; notes#2)`;
    expect(text).toHaveLength(3500);
    expect((await curate('Recall', picked(), { write: writer(text.replace('notes#2', 'E1')).write })).log).toBe(text);
  });

  it('fails before calling write when there are no reference items', async () => {
    const { write, calls } = writer();
    await expect(curate('Recall', picked([]), { write })).rejects.toThrow('no selected reference items');
    expect(calls).toHaveLength(0);
  });

  it('fails before calling write when a reference has no selected weight', async () => {
    const input = picked();
    const { write, calls } = writer();
    await expect(curate('Recall', { ...input, record: { ...input.record, candidates: [] } }, { write }))
      .rejects.toThrow('selected record entry');
    expect(calls).toHaveLength(0);
  });

  it('propagates write failures without retries or another model route', async () => {
    let calls = 0;
    const error = new Error('plan route failed');
    await expect(curate('Recall', picked(), { write: async () => { calls += 1; throw error; } }))
      .rejects.toBe(error);
    expect(calls).toBe(1);
  });

  it('propagates condense failures without retries or another model route', async () => {
    let calls = 0;
    const error = new Error('plan route failed');
    await expect(curate('Recall', picked(), {
      contextLimit: 100,
      write: async () => { calls += 1; if (calls === 1) return LONG_SHORT_LOG; throw error; },
    })).rejects.toBe(error);
    expect(calls).toBe(2);
  });

  it('rejects a condensed result returned after cancellation', async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(curate('Recall', picked(), {
      contextLimit: 100,
      signal: controller.signal,
      write: async () => {
        calls += 1;
        if (calls === 1) return LONG_SHORT_LOG;
        controller.abort();
        return SHORT_LOG;
      },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(2);
  });

  it('keeps optional working notes when condensing a long log', async () => {
    const notes = "\n\nWorking (the curator's; check it against the log):\n1. 2023-05-13 (notes#2).";
    const written = notes.replace('notes#2', 'E1');
    const { write, calls } = writer([LONG_SHORT_LOG + written, SHORT_LOG + written]);
    const result = await curate('How many visits?', picked(), { write, working: true, contextLimit: 200 });
    expect(result.log).toBe(LOG + notes);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.instructions).toContain('including any working section');
    expect(result.record).toMatchObject({
      working: true, logLength: (LONG_LOG + notes).length,
      condensed: true, condensedLength: (LOG + notes).length, overContextLimit: false,
    });
  });

  it('passes cancellation to write and rejects a result returned after cancellation', async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    await expect(curate('Recall', picked(), {
      signal: controller.signal,
      write: async (_prompt, signal) => { received = signal; controller.abort(); return SHORT_LOG; },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(received).toBe(controller.signal);
  });

  it('does not call write when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const { write, calls } = writer();
    await expect(curate('Recall', picked(), { write, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(0);
  });

  it('shows each item a short En id in the prompt and returns full ids in the log and record', async () => {
    const id = 'tmp/sessions-whole/question/answer_9398da02.md#1.7';
    const item = { ...candidate(id, '2023-05-20'), title: 'A trip note', text: 'Went to York.' };
    const written = '[2023-05-13] Visited York (said 2023-05-20; E1)';
    const { write, calls } = writer(written);
    const result = await curate('Where did I go?', picked([item]), { write });
    expect(calls[0]!.body).toContain('### E1 (2023-05-20, 0.9): A trip note');
    expect(calls[0]!.body).not.toContain('tmp/sessions-whole');
    expect(calls[0]!.instructions).toContain('the item id from its header');
    expect(calls[0]!.instructions).not.toContain('full item id');
    expect(result.log).toBe(`[2023-05-13] Visited York (said 2023-05-20; ${id})`);
    expect(result.record.items.map((entry) => entry.id)).toEqual([id]);
  });

  it('fails the check on an unknown short id and sends it through the one repair', async () => {
    const { write, calls } = writer(['[2023-05-13] Visited York (said 2023-05-20; E9)', SHORT_LOG]);
    const result = await curate('Recall', picked(), { write });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.instructions).toContain('rejected for its format');
    expect(calls[1]!.body).toContain('(said 2023-05-20; E9)');
    expect(result.log).toBe(LOG);
    expect(result.record.repairs).toBe(1);
  });

  it.each([
    '\nAdvice preferences: Likes walks (E1), dislikes crowds (E9)',
    "\nWorking (the curator's; check it against the log):\n1. Visit (2023-05-13; E9)",
  ])('fails the check on an unknown short id in a preference or working line and sends it through the one repair: %j', async (extra) => {
    const { write, calls } = writer([SHORT_LOG + extra, SHORT_LOG]);
    const result = await curate('Recall', picked(), { write, working: true, preferenceAdvice: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.instructions).toContain('rejected for its format');
    expect(calls[1]!.body).toContain('E9');
    expect(result.log).toBe(LOG);
    expect(result.record.repairs).toBe(1);
  });

  it('translates only citations, leaving an En written as ordinary text', async () => {
    const written = SHORT_LOG
      + '\nAdvice preferences: Likes walks in E1 (E1)';
    const expected = LOG
      + '\nAdvice preferences: Likes walks in E1 (notes#2)';
    const result = await curate('How many visits?', picked(), {
      write: writer(written).write, preferenceAdvice: true,
    });
    expect(result.log).toBe(expected);
  });

  it('translates bracketed En in a working note and leaves bare words alone', async () => {
    const written = SHORT_LOG
      + "\nWorking (the curator's; check it against the log):\n1. Visit (2023-05-13, E1); 7 days before the said date.\n2. The E1 road came up once, says E1.\n3. Flat in E14 (2023-05-13; E1).";
    const expected = LOG
      + "\nWorking (the curator's; check it against the log):\n1. Visit (2023-05-13, notes#2); 7 days before the said date.\n2. The E1 road came up once, says E1.\n3. Flat in E14 (2023-05-13; notes#2).";
    const result = await curate('How many visits?', picked(), {
      write: writer(written).write, working: true,
    });
    expect(result.log).toBe(expected);
  });

  it('leaves an En outside brackets on a preference line as ordinary text', async () => {
    const written = SHORT_LOG
      + '\nAdvice preferences: Avoids E621 additives (E1)';
    const expected = LOG
      + '\nAdvice preferences: Avoids E621 additives (notes#2)';
    const result = await curate('What should I cook?', picked(), {
      write: writer(written).write, preferenceAdvice: true,
    });
    expect(result.log).toBe(expected);
  });

  it('keeps $-sequences in observation text literal when restoring ids', async () => {
    const written = '[2023-05-13] Used $& and $$ as shorthand (said 2023-05-20; E1)';
    const result = await curate('Recall', picked(), { write: writer(written).write });
    expect(result.log).toBe('[2023-05-13] Used $& and $$ as shorthand (said 2023-05-20; notes#2)');
  });

  it('states the condense budget as the limit scaled to short-id characters', async () => {
    const id = 'tmp/sessions-whole/question/answer_9398da02.md#1.7';
    const written = `[2023-05-13] ${'x'.repeat(100)} (said 2023-05-20; E1)`;
    const reply = '[2023-05-13] Short note (said 2023-05-20; E1)';
    const { write, calls } = writer([written, reply]);
    const result = await curate('Recall', picked([candidate(id, '2023-05-20')]), { write, contextLimit: 100 });
    // The writer's log is 135 characters, 183 restored; the stated
    // budget estimates the caller's 100 in short-id characters as
    // floor(100 * 135 / 183) = 73. The 45-character reply restores
    // to 93, inside the caller's 100.
    expect(calls[1]!.instructions).toContain('at most 73 characters');
    expect(result.log).toBe(`[2023-05-13] Short note (said 2023-05-20; ${id})`);
    expect(result.log.length).toBeLessThanOrEqual(100);
    expect(result.record).toMatchObject({ condensed: true, overContextLimit: false });
  });

  it('restores a condensed reply inside the stated budget to over the limit when its id share is larger', async () => {
    const id = 'tmp/sessions-whole/question/answer_9398da02.md#1.7';
    const written = `[2023-05-13] ${'x'.repeat(100)} (said 2023-05-20; E1)`;
    // 73 characters meets the stated budget; the scaled budget is an
    // estimate, and this reply's larger share of one long id restores
    // to 121, over the caller's 100.
    const reply = `[2023-05-13] ${'x'.repeat(38)} (said 2023-05-20; E1)`;
    const { write } = writer([written, reply]);
    const result = await curate('Recall', picked([candidate(id, '2023-05-20')]), { write, contextLimit: 100 });
    expect(reply).toHaveLength(73);
    expect(result.log).toBe(reply.replace('E1', id));
    expect(result.log).toHaveLength(121);
    expect(result.record).toMatchObject({ condensed: true, overContextLimit: true });
  });
});
