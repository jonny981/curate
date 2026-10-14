import { describe, expect, it } from 'vitest';

import {
  curate,
  type CuratePrompt,
  type CurateWrite,
  type MemoryCandidate,
  type PickRecordEntry,
  type PickResult,
} from '../src/index.js';

const candidate = (id: string, overrides: Partial<MemoryCandidate> = {}): MemoryCandidate => ({
  sourceId: 'notes', id, title: id, text: `Text ${id}`, role: 'reference', signals: {}, ...overrides,
});

const dated = (id: string, date: string): MemoryCandidate =>
  candidate(id, { date: { value: date, meaning: 'recorded' } });

const sized = (id: string, characters: number): MemoryCandidate =>
  candidate(id, { text: 'x'.repeat(characters) });

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

describe('token batches in a chained write', () => {
  it('writes one call when batchTokens is omitted', async () => {
    const { calls, write } = writer(['[2023-01-01] A happened (said 2023-01-01; a)']);
    const result = await curate('task', picked([candidate('a'), candidate('b')], [0.9, 0.4]), { write });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toContain('### a');
    expect(calls[0]!.body).toContain('### b');
    expect(result.record).not.toHaveProperty('batches');
    expect(result.record).not.toHaveProperty('batchTokens');
  });

  it('cuts items into batches by the token budget, strongest first', async () => {
    const { calls, write } = writer([
      '[2023-01-01] A happened (said 2023-01-01; a)\n[2023-01-02] B happened (said 2023-01-02; b)',
      'L1 [2023-01-01] A happened (said 2023-01-01; a)\nL2 [2023-01-02] B happened (said 2023-01-02; b)\n[2023-01-03] C happened (said 2023-01-03; c)',
    ]);
    // Each item costs about 105 estimated tokens, so two fit the
    // budget and the third starts its own batch.
    const result = await curate('task', picked(
      [sized('c', 400), sized('a', 400), sized('b', 400)], [0.5, 0.9, 0.7],
    ), { write, batchTokens: 220 });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toContain('### a');
    expect(calls[0]!.body).toContain('### b');
    expect(calls[0]!.body).not.toContain('### c');
    expect(calls[0]!.body.indexOf('### a')).toBeLessThan(calls[0]!.body.indexOf('### b'));
    expect(calls[1]!.body).toContain('### c');
    expect(calls[1]!.body).toContain('LOG SO FAR');
    expect(calls[1]!.body).toContain('L1 [2023-01-01] A happened');
    expect(result.record.batchTokens).toBe(220);
    expect(result.record.batches?.map((batch) => batch.items)).toEqual([2, 1]);
    expect(result.log).toContain('L3 [2023-01-03] C happened');
  });

  it('orders equal weights by newer date first', async () => {
    const { calls, write } = writer(['[2023-01-01] A happened (said 2023-01-01; new)']);
    await curate('task', picked(
      [dated('old', '2023-01-01'), dated('new', '2023-03-01'), dated('mid', '2023-02-01')],
      [0.9, 0.9, 0.9],
    ), { write, batchTokens: 10_000 });
    expect(calls).toHaveLength(1);
    const body = calls[0]!.body;
    expect(body.indexOf('### new')).toBeLessThan(body.indexOf('### mid'));
    expect(body.indexOf('### mid')).toBeLessThan(body.indexOf('### old'));
  });

  it('keeps items whole and gives an item larger than the budget its own batch', async () => {
    const { calls, write } = writer([
      '[2023-01-01] Huge happened (said 2023-01-01; huge)',
      'L1 [2023-01-01] Huge happened (said 2023-01-01; huge)\n[2023-01-02] Small happened (said 2023-01-02; small)\n[2023-01-03] Other happened (said 2023-01-03; other)',
    ]);
    // The huge item alone costs more than 150 estimated tokens; the
    // two small items share the second batch.
    const result = await curate('task', picked(
      [sized('huge', 800), sized('small', 200), sized('other', 200)], [0.9, 0.5, 0.4],
    ), { write, batchTokens: 150 });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toContain('### huge');
    expect(calls[0]!.body).not.toContain('### small');
    expect(calls[0]!.body).not.toContain('### other');
    expect(calls[1]!.body).toContain('### small');
    expect(calls[1]!.body).toContain('### other');
    expect(result.record.batches?.map((batch) => batch.items)).toEqual([1, 2]);
  });

  it('rejects a bad batchTokens and refuses batchTokens with contextLimit', async () => {
    for (const batchTokens of [0, -2, 1.5, Number.NaN]) {
      await expect(curate('task', picked([candidate('a')], [0.9]), {
        write: writer(['x']).write, batchTokens,
      })).rejects.toThrow('batchTokens');
    }
    const { calls, write } = writer(['x']);
    await expect(curate('task', picked([candidate('a')], [0.9]), {
      write, batchTokens: 200, contextLimit: 100,
    })).rejects.toThrow('contextLimit');
    expect(calls).toHaveLength(0);
  });
});

describe('earlier lines are never deleted', () => {
  it('restores an earlier line a later batch rewords', async () => {
    const { calls, write } = writer([
      '[2023-01-01] The old plan stands (said 2023-01-01; a)',
      'L1 [2023-01-01] The old plan softened (said 2023-01-01; a)\n[2023-02-01] Something new (said 2023-02-01; b)',
    ]);
    const result = await curate('task', picked(
      [candidate('a'), candidate('b')], [0.9, 0.6],
    ), { write, batchTokens: 1 });
    expect(calls).toHaveLength(2);
    expect(result.log).toContain('L1 [2023-01-01] The old plan stands (said 2023-01-01; a)');
    expect(result.log).not.toContain('softened');
    expect(result.log).toContain('L2 [2023-02-01] Something new');
  });

  it('restores an earlier line a later batch drops', async () => {
    const { write } = writer([
      '[2023-01-01] The old plan stands (said 2023-01-01; a)',
      '[2023-02-01] Something new (said 2023-02-01; b)',
    ]);
    const result = await curate('task', picked(
      [candidate('a'), candidate('b')], [0.9, 0.6],
    ), { write, batchTokens: 1 });
    expect(result.log).toContain('L1 [2023-01-01] The old plan stands (said 2023-01-01; a)');
    expect(result.log).toContain('L2 [2023-02-01] Something new');
  });

  it('keeps both Atlas facts when a newer correction marks the region line', async () => {
    const region = '[2023-01-01] The region for Atlas deployment is Europe (said 2023-01-01; a)';
    const schedule = '[2023-02-01] The schedule for Atlas deployment is weekly (said 2023-02-01; b) (replaces L1: Atlas deployment)';
    const { write } = writer([region, `L1 ${region}\n${schedule}`]);
    const result = await curate('task', picked(
      [candidate('a'), candidate('b')], [0.9, 0.6],
      { a: tags('fact', 'relevant'), b: tags('correction', 'important') },
    ), { write, batchTokens: 1 });
    // The mark tells the reader the new line is newer; the line it
    // names stays beside it. Two facts about one entity both remain.
    expect(result.log).toContain('L1 [2023-01-01] The region for Atlas deployment is Europe');
    expect(result.log).toContain('L2 [2023-02-01] The schedule for Atlas deployment is weekly');
    expect(result.record.batches?.[1]?.marks).toEqual([{ id: 'L2', target: 'L1' }]);
  });

  it('keeps a retained earlier line beside the new line that marks it', async () => {
    const first = '[2023-01-01] The old plan stands (said 2023-01-01; a)';
    const added = '[2023-02-01] The new plan stands (said 2023-02-01; b) (replaces L1: the plan changed)';
    const { write } = writer([first, `L1 ${first}\n${added}`]);
    const result = await curate('task', picked(
      [candidate('a'), candidate('b')], [0.9, 0.6],
      { a: tags('fact', 'relevant'), b: tags('correction', 'important') },
    ), { write, batchTokens: 1 });
    expect(result.log).toBe(`L1 ${first}\nL2 ${added}`);
    expect(result.record.batches?.[1]?.added).toEqual([{ id: 'L2', line: `L2 ${added}` }]);
    expect(result.record.batches?.[1]?.marks).toEqual([{ id: 'L2', target: 'L1' }]);
  });

  it('strips a date-based mark a later batch adds and keeps both lines', async () => {
    const { write } = writer([
      '[2023-01-01] The old plan stands (said 2023-01-01; a)',
      'L1 [2023-01-01] The old plan stands (said 2023-01-01; a)\n[2023-02-01] The new plan stands (said 2023-02-01; b) (replaces [2023-01-01])',
    ]);
    const result = await curate('task', picked(
      [candidate('a'), candidate('b')], [0.9, 0.6],
      { a: tags('fact', 'relevant'), b: tags('correction', 'important') },
    ), { write, batchTokens: 1 });
    // Only a stable line id may mark a replacement; a date is never
    // honoured, so the mark drops off the line and both lines stay.
    expect(result.log).toContain('L1 [2023-01-01] The old plan stands');
    expect(result.log).toContain('L2 [2023-02-01] The new plan stands (said 2023-02-01; b)');
    expect(result.log).not.toContain('replaces');
    expect(result.record.batches?.[1]?.added).toEqual([
      { id: 'L2', line: 'L2 [2023-02-01] The new plan stands (said 2023-02-01; b)' },
    ]);
    expect(result.record.batches?.[1]?.marks).toEqual([]);
  });

  it('strips a mark that names an id the log does not hold', async () => {
    const { write } = writer([
      '[2023-01-01] The old plan stands (said 2023-01-01; a)',
      'L1 [2023-01-01] The old plan stands (said 2023-01-01; a)\n[2023-02-01] The new plan stands (said 2023-02-01; b) (replaces L9: the plan changed)',
    ]);
    const result = await curate('task', picked(
      [candidate('a'), candidate('b')], [0.9, 0.6],
      { a: tags('fact', 'relevant'), b: tags('correction', 'important') },
    ), { write, batchTokens: 1 });
    // L9 is no line of this log: the mark is dropped from the line and
    // no mark is recorded.
    expect(result.log).toContain('L2 [2023-02-01] The new plan stands (said 2023-02-01; b)');
    expect(result.log).not.toContain('replaces');
    expect(result.record.batches?.[1]?.marks).toEqual([]);
  });

  it('strips a mark the first batch carries anyway', async () => {
    const { calls, write } = writer([
      '[2023-01-01] A happened (said 2023-01-01; a) (replaces [2022-12-01])',
    ]);
    const result = await curate('task', picked([candidate('a')], [0.9]), { write, batchTokens: 1 });
    expect(calls[0]!.instructions).toContain('write no replacement marker');
    expect(result.log).toBe('L1 [2023-01-01] A happened (said 2023-01-01; a)');
    expect(result.record.batches?.[0]?.added).toEqual([
      { id: 'L1', line: 'L1 [2023-01-01] A happened (said 2023-01-01; a)' },
    ]);
    expect(result.record.batches?.[0]?.marks).toEqual([]);
  });

  it('tells a later batch to mark only a newer correction or decision about the same subject', async () => {
    const { calls, write } = writer([
      '[2023-01-01] A happened (said 2023-01-01; a)',
      'L1 [2023-01-01] A happened (said 2023-01-01; a)\n[2023-02-01] B happened (said 2023-02-01; b)',
    ]);
    await curate('task', picked([candidate('a'), candidate('b')], [0.9, 0.6]), { write, batchTokens: 1 });
    const instructions = calls[1]!.instructions;
    expect(instructions).toContain('(replaces L3: the subject it corrects)');
    expect(instructions).toContain('newer correction or decision about the same subject');
    expect(instructions).toContain('at least as important');
    expect(instructions).toContain('Keep each existing line exactly as it stands');
    expect(instructions).toContain('Layer in only the facts the log does not already state');
  });
});

describe('item headers', () => {
  it('names the source kind in the item header when the record entry carries one', async () => {
    const base = picked([dated('a', '2023-05-30')], [0.9], { a: tags('correction', 'important') });
    const input: PickResult = { ...base, record: { ...base.record,
      candidates: base.record.candidates.map((entry) => ({ ...entry, sourceKind: 'chat' as const })) } };
    const { calls, write } = writer(['[2023-05-13] A happened (said 2023-05-30; a)']);
    await curate('task', input, { write });
    expect(calls[0]!.body).toContain(
      '### a (2023-05-30, chat, 0.9, intent: correction, importance: important): a');
  });

  it('leaves the kind out of the header when the record entry has none', async () => {
    const { calls, write } = writer(['[2023-05-13] A happened (said 2023-05-30; a)']);
    await curate('task', picked([dated('a', '2023-05-30')], [0.9]), { write });
    expect(calls[0]!.body).toContain('### a (2023-05-30, 0.9): a');
  });
});
