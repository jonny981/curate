import { describe, expect, it } from 'vitest';

import {
  curate,
  pick,
  type CuratePrompt,
  type CurateWrite,
  type MemoryCandidate,
  type PickResult,
} from '../src/index.js';

const LOG = '[2023-05-13] Visited York (said 2023-05-20; notes#2)';

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
      thresholds: { reference: 0, rule: 0, linkedPathBar: 0 }, rulesCoverage: 'complete',
      candidates: items.map((item, index) => ({
        sourceId: item.sourceId, id: item.id, role: item.role, priority: index,
        signals: item.signals, status: 'selected', asked: true, probability: weights[index]!,
      })),
    },
  };
}

function writer(text = LOG): { write: CurateWrite; calls: CuratePrompt[]; signals: AbortSignal[] } {
  const calls: CuratePrompt[] = [];
  const signals: AbortSignal[] = [];
  return {
    calls, signals,
    write: async (prompt, signal) => { calls.push(prompt); signals.push(signal); return text; },
  };
}

describe('curate', () => {
  it('sends v4 instructions and all three weight tiers in one write call', async () => {
    const { write, calls } = writer();
    const result = await curate('Where did I go?', picked(), { write });
    expect(calls).toHaveLength(1);
    const instructions = calls[0]!.instructions;
    expect(instructions).toContain('[YYYY-MM-DD the event happened]');
    expect(instructions).toContain('said YYYY-MM-DD; the full item id from its header');
    expect(instructions).toContain('Never shift a date that is already absolute.');
    expect(instructions).toContain('always end the later line with "(replaces [the earlier date])"');
    expect(instructions).toContain('Make sure every observation from items weighted 0.6 or more is in the log.');
    expect(instructions).toContain('Items weighted from 0.1 to 0.6 are less direct');
    expect(instructions).toContain('Items weighted below 0.1 rarely matter');
    expect(instructions).toContain('At most 3500 characters.');
    expect(instructions).not.toContain('Working (the curator');
    expect(result.log).toBe(LOG);
    expect(result.record).toMatchObject({ promptVersion: 'v4', weights: 'tiers', working: false });
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
      + '### notes#2 (2023-05-20, 0.88): Title notes#2\n\nText notes#2\n\n'
      + '### notes#1 (2023-04-01, 0.05): Title notes#1\n\nText notes#1');
    expect(result.record.items).toEqual([
      { id: 'notes#2', candidate: items[0], weight: 0.876 },
      { id: 'notes#1', candidate: items[1], weight: 0.05 },
    ]);
  });

  it('does not invent a missing header date', async () => {
    const { write, calls } = writer();
    await curate('Recall', picked([candidate('notes#2')]), { write });
    expect(calls[0]!.body).toContain('### notes#2 (0.90):');
  });

  it('adds optional worked notes for instances, gaps, and latest values', async () => {
    const working = "\n\nWorking (the curator's; check it against the log):\n1. 2023-05-13 notes#2; 7 days before the said date.";
    const { write, calls } = writer(LOG + working);
    const result = await curate('How many visits last week?', picked(), { write, working: true });
    expect(calls[0]!.instructions).toContain('In the log itself, do not judge');
    expect(calls[0]!.instructions).not.toContain('- Do not answer the task, do not count');
    expect(calls[0]!.instructions).toContain('number each distinct instance that falls inside the period');
    expect(calls[0]!.instructions).toContain('the computed difference or order');
    expect(calls[0]!.instructions).toContain('the latest value and its date');
    expect(result.log).toBe(LOG + working);
    expect(result.record.working).toBe(true);
  });

  it('keeps selected rules outside the writer and retains their picker record', async () => {
    const rule: MemoryCandidate = { ...candidate('rule'), role: 'rule', applies: 'always', text: 'Follow this rule exactly' };
    const input = await pick([rule, candidate('notes#2')], {
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
    const { write, calls } = writer('[2023-05-13] Visited York (said 2023-05-20; ["notes","same"])');
    const result = await curate('Recall', picked(items, [0.9, 0.3]), { write });
    expect(calls[0]!.body).toContain('### ["notes","same"] (0.90):');
    expect(calls[0]!.body).toContain('### ["other","same"] (0.30):');
    expect(result.record.items.map((item) => [item.id, item.weight])).toEqual([
      ['["notes","same"]', 0.9], ['["other","same"]', 0.3],
    ]);
  });

  it.each(['', ' \n\t '])('rejects empty output %j', async (text) => {
    const { write, calls } = writer(text);
    await expect(curate('Recall', picked(), { write })).rejects.toThrow('curate: empty log');
    expect(calls).toHaveLength(1);
  });

  it('rejects oversized output instead of cutting it or returning raw items', async () => {
    const { write, calls } = writer(`[2023-05-13] ${'x'.repeat(3500)} (said 2023-05-20; notes#2)`);
    await expect(curate('Recall', picked(), { write })).rejects.toThrow('curate: oversized log');
    expect(calls).toHaveLength(1);
  });

  it.each([
    'Here is the answer: York.',
    '[2023-05-13] Visited York (notes#2)',
    '[2023-05-13 the event happened] Visited York (said 2023-05-20; notes#2)',
    '[2023-02-30] Visited York (said 2023-05-20; notes#2)',
    '[2023-05-13] Visited York (said 2023-13-20; notes#2)',
    '[2023-05-13] Visited York (said 2023-05-20; )',
    '[2023-05-13]   (said 2023-05-20; notes#2)',
    '[2023-05-13] Visited York (said 2023-05-20; ) (when not stated)',
    '[2023-05-13] Visited York (said 2023-05-20; notes#2) trailing prose',
    '[2023-05-13] Visited York (said 2023-05-20; notes#2) (replaces [not-a-date])',
    '[2023-05-13] Visited York (said 2023-05-20; notes#2) (replaces [2023-02-30])',
    '[2023-05-13] Visited York (said 2023-05-20; shortened-id)',
    `${LOG}\nA line without dates`,
    `${LOG}\nWorking (the curator's; check it against the log):\n1. A visit.`,
  ])('rejects malformed output %j', async (text) => {
    await expect(curate('Recall', picked(), { write: writer(text).write })).rejects.toThrow('curate: malformed log');
  });

  it('rejects non-text output at the caller boundary', async () => {
    const write = (async () => null) as unknown as CurateWrite;
    await expect(curate('Recall', picked(), { write })).rejects.toThrow('write must return text');
  });

  it.each([
    "Working (the curator's; check it against the log):\n1. A visit.",
    `${LOG}\nWorking (the curator's; check it against the log):`,
  ])('rejects an empty log or working section with working enabled %j', async (text) => {
    await expect(curate('Recall', picked(), { write: writer(text).write, working: true }))
      .rejects.toThrow('curate: malformed log');
  });

  it('accepts merged observations and replacements without dropping either date', async () => {
    const text = '[2023-05-13] Visited York (said 2023-05-20; notes#2, notes#3)\n[2023-05-21] Moved to Leeds (said 2023-05-22; notes#4) (replaces [2023-05-13])';
    const input = picked([candidate('notes#2'), candidate('notes#3'), candidate('notes#4')], [0.9, 0.9, 0.9]);
    const result = await curate('Recall', input, { write: writer(` \n${text}\n `).write });
    expect(result.log).toBe(text);
  });

  it('accepts a date that was not stated and full ids containing punctuation', async () => {
    const id = 'notes (copy)[1].md#2';
    const text = `[2023-05-20] Visited York (said 2023-05-20; ${id}) (when not stated)`;
    expect((await curate('Recall', picked([candidate(id)]), { write: writer(text).write })).log).toBe(text);
  });

  it.each([', ', ',', '; ', ' and ', ' & ', ', and '])('accepts merged source ids separated by %j', async (separator) => {
    const text = `[2023-05-13] Visited York (said 2023-05-20; notes#2${separator}notes#3)`;
    const input = picked([candidate('notes#2'), candidate('notes#3')], [0.9, 0.9]);
    expect((await curate('Recall', input, { write: writer(text).write })).log).toBe(text);
  });

  it('accepts exactly 3500 characters', async () => {
    const text = `[2023-05-13] ${'x'.repeat(3500 - LOG.length + 'Visited York'.length)} (said 2023-05-20; notes#2)`;
    expect(text).toHaveLength(3500);
    expect((await curate('Recall', picked(), { write: writer(text).write })).log).toBe(text);
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

  it('passes cancellation to write and rejects a result returned after cancellation', async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    await expect(curate('Recall', picked(), {
      signal: controller.signal,
      write: async (_prompt, signal) => { received = signal; controller.abort(); return LOG; },
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
});
