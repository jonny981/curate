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
