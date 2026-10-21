import { describe, expect, it } from 'vitest';

import { curate, type CuratePrompt, type CurateWrite, type MemoryCandidate, type PickResult } from '../src/index.js';

const candidate = (id: string): MemoryCandidate => ({
  sourceId: 'notes', id, title: id, text: `Text ${id}`, role: 'reference', signals: {},
});

function picked(items: MemoryCandidate[]): PickResult {
  return {
    selected: items,
    record: {
      questionVersion: 'test', limits: {},
      thresholds: { reference: 0, rule: 0, linkedPathBar: 0 }, rulesCoverage: 'complete',
      levers: { preset: 'performance', everyRanked: true, everyScored: true, labels: false, route: false, rare: false },
      candidates: items.map((item, index) => ({
        sourceId: item.sourceId, id: item.id, role: item.role, priority: index,
        signals: item.signals, status: 'selected' as const, asked: true, probability: 0.9,
      })),
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

// The reply a plan curator gave on a LongMemEval question: an event known
// only to its month, written as a date range. The writer cites the item's
// short `En` id; the returned log carries the full id again.
const RANGE = '[2023-04-01–2023-04-30] Bought a designer handbag for $800 (said 2023-05-23; a)';
const FIXED = '[2023-04-01] Bought a designer handbag for $800 sometime in April (said 2023-05-23; a)';
const WRITTEN_RANGE = RANGE.replace('; a)', '; E1)');
const WRITTEN_FIXED = FIXED.replace('; a)', '; E1)');

describe('a log that fails the format check', () => {
  it('is sent back once with the reason and the rejected log, and the corrected log is used', async () => {
    const { calls, write } = writer([WRITTEN_RANGE, WRITTEN_FIXED]);
    const result = await curate('task', picked([candidate('a')]), { write });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.instructions).toContain('rejected for its format');
    expect(calls[1]!.body).toContain(WRITTEN_RANGE);
    expect(calls[1]!.body).toContain('each observation needs an event date');
    expect(result.log).toBe(FIXED);
    expect(result.record.repairs).toBe(1);
  });

  it('fails when the corrected log is still malformed', async () => {
    const { calls, write } = writer([WRITTEN_RANGE, WRITTEN_RANGE]);
    await expect(curate('task', picked([candidate('a')]), { write })).rejects.toThrow('curate: malformed log');
    expect(calls).toHaveLength(2);
  });

  it('makes one call and records no repair for a well-formed log', async () => {
    const { calls, write } = writer([WRITTEN_FIXED]);
    const result = await curate('task', picked([candidate('a')]), { write });
    expect(calls).toHaveLength(1);
    expect(result.log).toBe(FIXED);
    expect(result.record).not.toHaveProperty('repairs');
  });
});

// Lines plan curators wrote on LongMemEval questions (gpt4_2ba83207 and
// d23cf73b): one observation told by several items, with each item's
// said date joined by "and". The first was still written so after the
// repair, so the curation failed.
const ITEMS = ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7'];
const THRIVE = '[2023-04-01] During 2023-04-01–2023-04-30, placed an online order with Thrive Market, spending around $150 on organic and sustainable products and getting great deals. (said 2023-05-26 and 2023-05-29; E3, E4, E5)';
const WORKSHOP = '[2023-05-29] Attended a fermentation workshop and made kimchi; described the workshop as being at a local food co-op and also learning to make sauerkraut (when not stated) (said 2023-05-29 and 2023-05-30; E7, E6)';

describe('several said dates in one citation', () => {
  it.each([THRIVE, WORKSHOP])('accepts them joined by "and" in one call: %j', async (line) => {
    const { calls, write } = writer([line, line]);
    const result = await curate('task', picked(ITEMS.map(candidate)), { write });
    expect(calls).toHaveLength(1);
    expect(result.log).toBe(line.replace(/\bE(\d)\b/g, 'i$1'));
  });

  it('accepts them joined by a comma', async () => {
    const line = '[2023-05-01] Bought chicken (said 2023-05-26, 2023-05-29; E1, E2)';
    const { calls, write } = writer([line]);
    expect((await curate('task', picked(ITEMS.map(candidate)), { write })).log).toBe(line.replace('E1, E2', 'i1, i2'));
    expect(calls).toHaveLength(1);
  });

  it.each(['said 2023-05-26 and 2023-02-30; E1', 'said 2023-05-26 and not-a-date; E1', 'said 2023-05-26 and ; E1'])('still rejects an unreadable said date: %j', async (citation) => {
    const line = `[2023-05-01] Bought chicken (${citation})`;
    const { write } = writer([line, line]);
    await expect(curate('task', picked(ITEMS.map(candidate)), { write })).rejects.toThrow('curate: malformed log');
  });
});

describe('the format error', () => {
  it('names the line that failed, in the error and in the repair request', async () => {
    const good = '[2023-05-01] Bought chicken (said 2023-05-26; E1)';
    const { calls, write } = writer([`${good}\n${WRITTEN_RANGE}`, `${good}\n${WRITTEN_RANGE}`]);
    await expect(curate('task', picked([candidate('a')]), { write })).rejects.toThrow(`line: ${WRITTEN_RANGE}`);
    expect(calls[1]!.body).toContain(`REJECTED LOG (each observation needs an event date, a said date, and an item id; line: ${WRITTEN_RANGE})`);
  });
});

// The reply a plan curator gave twice on LongMemEval question
// 0862e8bf_abs, whose answer is not in the history.
const NOTHING = 'No relevant observations in the supplied evidence.';

describe('evidence that does not bear on the task', () => {
  it('tells the writer to return an empty reply', async () => {
    const { calls, write } = writer(['']);
    await curate('task', picked([candidate('a')]), { write });
    expect(calls[0]!.instructions).toContain('If no evidence bears on the task, return an empty reply');
  });

  it('still fails the check when the writer says so in a sentence', async () => {
    const { calls, write } = writer([NOTHING, NOTHING]);
    await expect(curate('task', picked([candidate('a')]), { write })).rejects.toThrow(`line: ${NOTHING}`);
    expect(calls).toHaveLength(2);
  });

  it('leads the repair to the empty reply, which returns an empty log marked in the record', async () => {
    const { calls, write } = writer([NOTHING, '']);
    const result = await curate('task', picked([candidate('a')]), { write });
    expect(calls[1]!.instructions).toContain('If no evidence bears on the task, return an empty reply instead.');
    expect(calls[1]!.body).toContain(`REJECTED LOG (each observation needs an event date, a said date, and an item id; line: ${NOTHING})`);
    expect(result.log).toBe('');
    expect(result.record).toMatchObject({ empty: true, repairs: 1 });
  });
});
