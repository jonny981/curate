import { describe, expect, it } from 'vitest';

import { curate, type CuratePrompt, type CurateWrite, type MemoryCandidate, type PickResult } from '../src/index.js';

const uncutPick = { everyRanked: true, everyScored: true, rare: false } as const;

const candidate = (id: string): MemoryCandidate => ({
  sourceId: 'notes', id, title: id, text: `Text ${id}`, role: 'reference', signals: {},
});

function picked(items: MemoryCandidate[]): PickResult {
  return {
    selected: items,
    record: {
      questionVersion: 'test', limits: {},
      thresholds: { linkedPathBar: 0 }, rulesCoverage: 'complete',
      levers: { everyRanked: true, everyScored: true, route: false, rare: false, sources: {} },
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

  it('keeps a cited original when the corrected log is still malformed', async () => {
    const { calls, write } = writer([WRITTEN_RANGE, WRITTEN_RANGE]);
    const result = await curate('task', picked([candidate('a')]), { write });
    expect(result.log).toBe(RANGE);
    expect(result.record.formatRecovery).toEqual({ keptAsWritten: [WRITTEN_RANGE], dropped: [] });
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

  it.each(['said 2023-05-26 and 2023-02-30; E1', 'said 2023-05-26 and not-a-date; E1', 'said 2023-05-26 and ; E1'])('repairs an unreadable said date, then records the cited line as kept: %j', async (citation) => {
    const line = `[2023-05-01] Bought chicken (${citation})`;
    const { calls, write } = writer([line, line]);
    const result = await curate('task', picked(ITEMS.map(candidate)), { write });
    expect(calls).toHaveLength(2);
    expect(result.log).toBe(line.replace('E1', 'i1'));
    expect(result.record.formatRecovery).toEqual({ keptAsWritten: [line], dropped: [] });
  });
});

describe('the format error', () => {
  it('names the line that failed in the repair request and recovery record', async () => {
    const good = '[2023-05-01] Bought chicken (said 2023-05-26; E1)';
    const { calls, write } = writer([`${good}\n${WRITTEN_RANGE}`, `${good}\n${WRITTEN_RANGE}`]);
    const result = await curate('task', picked([candidate('a')]), { write });
    expect(result.log).toBe(`${good.replace('E1', 'a')}\n${RANGE}`);
    expect(result.record.formatRecovery).toEqual({ keptAsWritten: [WRITTEN_RANGE], dropped: [] });
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

// LongMemEval question 71017277: a low-effort plan curator given 237
// items replied with nothing, though the answer was among them.
const EMPTY_RETRY = 'Your previous reply to this task held no observation lines. Check the evidence items again and rewrite any evidence that bears on the task as observation lines. If none does, return an empty reply again.';

describe('an empty reply to a curator given items', () => {
  it('is asked once more with one added line, and a log in the second reply is used', async () => {
    const { calls, write } = writer(['', WRITTEN_FIXED]);
    const result = await curate('task', picked([candidate('a')]), { write });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ instructions: `${calls[0]!.instructions}\n${EMPTY_RETRY}`, body: calls[0]!.body });
    expect(result.log).toBe(FIXED);
    expect(result.record.emptyRetries).toBe(1);
    expect(result.record).not.toHaveProperty('empty');
    expect(result.record).not.toHaveProperty('repairs');
  });

  it.each(['', ' \n\t '])('stays an empty log, without an error, when the second reply is empty too: %j', async (reply) => {
    const { calls, write } = writer([reply, reply]);
    const result = await curate('task', picked([candidate('a')]), { write });
    expect(calls).toHaveLength(2);
    expect(result.log).toBe('');
    expect(result.record).toMatchObject({ empty: true, emptyRetries: 1 });
  });

  it('stays an empty log when the second reply says nothing was found in a sentence', async () => {
    const { calls, write } = writer(['', NOTHING]);
    const result = await curate('task', picked([candidate('a')]), { write });
    expect(calls).toHaveLength(2);
    expect(result.log).toBe('');
    expect(result.record).toMatchObject({ empty: true, emptyRetries: 1, formatRecovery: { keptAsWritten: [], dropped: [NOTHING] } });
  });

  it('keeps a cited second reply that fails the format check, without a repair call', async () => {
    const { calls, write } = writer(['', WRITTEN_RANGE]);
    const result = await curate('task', picked([candidate('a')]), { write });
    expect(calls).toHaveLength(2);
    expect(result.log).toBe(RANGE);
    expect(result.record).toMatchObject({ emptyRetries: 1, formatRecovery: { keptAsWritten: [WRITTEN_RANGE], dropped: [] } });
    expect(result.record).not.toHaveProperty('repairs');
  });

  it('is not asked again after a format repair came back empty', async () => {
    const { calls, write } = writer([NOTHING, '']);
    const result = await curate('task', picked([candidate('a')]), { write });
    expect(calls).toHaveLength(2);
    expect(result.record).toMatchObject({ empty: true, repairs: 1 });
    expect(result.record).not.toHaveProperty('emptyRetries');
  });

  it('makes one call for a reply with an observation, with no retry line, and returns it as before', async () => {
    const { calls, write } = writer([WRITTEN_FIXED, WRITTEN_FIXED]);
    const result = await curate('task', picked([candidate('a')]), { write });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.instructions).not.toContain(EMPTY_RETRY);
    expect(result.log).toBe(FIXED);
    expect(result.record).not.toHaveProperty('emptyRetries');
  });
});


const BOOK_PURCHASES = [
  '[2023-05-15] During 2023-05-15–2023-05-21, made an impulse purchase during a sale at their favorite bookstore, paying $24 for the book after a discount (said 2023-05-23; E2; said 2023-05-27; E3).',
  '[2023-05-15] During 2023-05-15–2023-05-21, made an impulse buy during a sale at their favorite bookstore, paying $24 after a discount (said 2023-05-23 and 2023-05-27; E2, E3).',
];

describe('a format slip keeps usable evidence', () => {
  it.each(BOOK_PURCHASES)('accepts multiple citations with a final full stop: %j', async (line) => {
    const { calls, write } = writer([line, line]);
    const result = await curate('task', picked(['a', 'b', 'c'].map(candidate)), { write });
    expect(calls).toHaveLength(1);
    expect(result.log).toBe(line.replace('E2', 'b').replace('E3', 'c'));
    expect(result.record.items.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(result.record).not.toHaveProperty('repairs');
    expect(result.record).not.toHaveProperty('formatRecovery');
  });

  it('keeps good lines and cited malformed lines, and records only unsupported lines as dropped', async () => {
    const unsupported = 'A guess without a source (E99)';
    const raw = `${WRITTEN_FIXED}\n${WRITTEN_RANGE}\n${unsupported}`;
    const { calls, write } = writer([raw, raw]);
    const result = await curate('task', picked([candidate('a')]), { write });
    expect(calls).toHaveLength(2);
    expect(result.log).toBe(`${FIXED}\n${RANGE}`);
    expect(result.record).toMatchObject({ repairs: 1, formatRecovery: {
      keptAsWritten: [WRITTEN_RANGE], dropped: [unsupported],
    } });
    expect(result.record).not.toHaveProperty('empty');
  });

  it('keeps good lines when the malformed line has no real citation', async () => {
    const raw = `${WRITTEN_FIXED}\n${NOTHING}`;
    const result = await curate('task', picked([candidate('a')]), { write: writer([raw, raw]).write });
    expect(result.log).toBe(FIXED);
    expect(result.record).toMatchObject({ formatRecovery: { keptAsWritten: [], dropped: [NOTHING] } });
  });

  it('keeps a cited line when no observation passes, and restores clashing item ids', async () => {
    const raw = 'A dated range was lost; sources E1 and E2';
    const items = [candidate('same'), { ...candidate('same'), sourceId: 'other' }];
    const result = await curate('task', picked(items), { write: writer([raw, raw]).write });
    expect(result.log).toBe('A dated range was lost; sources ["notes","same"] and ["other","same"]');
    expect(result.record).toMatchObject({ formatRecovery: { keptAsWritten: [raw], dropped: [] } });
  });

  it.each(['', NOTHING])('keeps the original usable lines when the repair loses them: %j', async (repaired) => {
    const raw = `${WRITTEN_FIXED}\n${WRITTEN_RANGE}`;
    const result = await curate('task', picked([candidate('a')]), { write: writer([raw, repaired]).write });
    expect(result.log).toBe(`${FIXED}\n${RANGE}`);
    expect(result.record).not.toHaveProperty('empty');
  });

  it('uses usable repaired lines when the original contains none', async () => {
    const repaired = `${WRITTEN_FIXED}\n${NOTHING}`;
    const result = await curate('task', picked([candidate('a')]), { write: writer([NOTHING, repaired]).write });
    expect(result.log).toBe(FIXED);
    expect(result.record).toMatchObject({ formatRecovery: { dropped: [NOTHING] } });
  });

  it('throws when neither reply has usable evidence', async () => {
    await expect(curate('task', picked([candidate('a')]), {
      write: writer([NOTHING, 'Unknown source E10']).write,
    })).rejects.toThrow('curate: malformed log');
  });

  it('keeps a valid log byte for byte apart from existing outer trim and id restoration', async () => {
    const raw = `  ${WRITTEN_FIXED}\n\n  Advice preferences: Likes $& books in E1 (E1).\n\n## Working (the curator's; check it against the log):\n  1. A purchase [E1].  `;
    const { calls, write } = writer([raw]);
    const result = await curate('task', picked([candidate('a')]), { write, preferenceAdvice: true, working: true });
    expect(result.log).toBe(`${FIXED}\n\n  Advice preferences: Likes $& books in E1 (a).\n\n## Working (the curator's; check it against the log):\n  1. A purchase [a].`);
    expect(calls).toHaveLength(1);
    expect(result.record).not.toHaveProperty('formatRecovery');
  });

  it('preserves a kept malformed line through later batches and records its stable id', async () => {
    const good = '[2023-05-01] Another fact (said 2023-05-23; E2)';
    const final = '[2023-05-02] Last fact (said 2023-05-23; E3)';
    const { calls, write } = writer([WRITTEN_RANGE, WRITTEN_RANGE, good, final]);
    const result = await curate('task', picked(['a', 'b', 'c'].map(candidate)), { write, batchTokens: 1 });
    expect(result.log).toContain(`L1 ${RANGE}`);
    expect(result.log).toContain('L2 [2023-05-01] Another fact');
    expect(result.log).toContain('L3 [2023-05-02] Last fact');
    expect(calls[2]!.body).toContain(`L1 ${WRITTEN_RANGE}`);
    expect(calls[3]!.body).toContain(`L1 ${WRITTEN_RANGE}`);
    expect(result.record.batches?.[0]?.added).toEqual([{ id: 'L1', line: `L1 ${RANGE}` }]);
  });

  it.each([0, 1])('keeps usable batches when batch %i has only unsupported lines', async (failed) => {
    const good = '[2023-05-01] Another fact (said 2023-05-23; E1)';
    const logs = failed === 0 ? [NOTHING, NOTHING, good.replace('E1', 'E2')] : [good, NOTHING, NOTHING];
    const result = await curate('task', picked(['a', 'b'].map(candidate)), { write: writer(logs).write, batchTokens: 1 });
    expect(result.log).toBe(`L1 ${good.replace('E1', failed === 0 ? 'b' : 'a')}`);
    expect(result.record).toMatchObject({ formatRecovery: { dropped: [NOTHING] } });
  });

  it('leaves a kept malformed replacement line intact across later batches', async () => {
    const good = '[2023-05-01] First fact (said 2023-05-23; E1)';
    const malformed = '[2023-04-01–2023-04-30] Bought book (said 2023-05-23; E2) (replaces L99: book)';
    const last = '[2023-05-03] Last fact (said 2023-05-23; E3)';
    const result = await curate('task', picked(['a', 'b', 'c'].map(candidate)), {
      write: writer([good, malformed, malformed, last]).write, batchTokens: 1,
    });
    expect(result.log).toContain(`L2 ${malformed.replace('E2', 'b')}`);
    expect(result.record.batches?.[1]?.added).toEqual([{ id: 'L2', line: `L2 ${malformed.replace('E2', 'b')}` }]);
    expect(result.record.batches?.[1]?.marks).toEqual([]);
  });

  it('does not rewrite a kept malformed first batch or honour its replacement mark', async () => {
    const malformed = '[2023-02-30] Bought book (said 2023-05-23; E1) (replaces L99: book)';
    const last = '[2023-05-03] Last fact (said 2023-05-23; E2)';
    const result = await curate('task', picked(['a', 'b'].map(candidate)), {
      write: writer([malformed, malformed, last]).write, batchTokens: 1,
    });
    expect(result.log).toContain(`L1 ${malformed.replace('E1', 'a')}`);
    expect(result.record.batches?.[0]?.marks).toEqual([]);
  });

  it('does not keep a malformed citation to evidence a later batch has not supplied', async () => {
    const future = 'Not dated (E2)';
    const good = '[2023-05-01] Another fact (said 2023-05-23; E2)';
    const result = await curate('task', picked(['a', 'b'].map(candidate)), {
      write: writer([future, future, good]).write, batchTokens: 1,
    });
    expect(result.log).toBe(`L1 ${good.replace('E2', 'b')}`);
    expect(result.record).toMatchObject({ formatRecovery: { keptAsWritten: [], dropped: [future] } });
  });

  it('keeps both citations and strips an invalid replacement marker ending in a full stop', async () => {
    const initial = '[2023-05-01] A fact (said 2023-05-23; E1).';
    const added = `${BOOK_PURCHASES[0]!.slice(0, -1)} (replaces L99: a correction).`;
    const result = await curate('task', picked(['a', 'b', 'c'].map(candidate)), {
      write: writer([initial, added, '']).write, batchTokens: 1,
    });
    expect(result.log).toBe(`L1 ${initial.replace('E1', 'a')}\nL2 ${BOOK_PURCHASES[0]!.replace('E2', 'b').replace('E3', 'c')}`);
    expect(result.record.batches?.[1]?.marks).toEqual([]);
    expect(result.record.batches?.[1]?.added).toEqual([{ id: 'L2', line: `L2 ${BOOK_PURCHASES[0]!.replace('E2', 'b').replace('E3', 'c')}` }]);
  });

  it.each(['', NOTHING])('keeps the original log when shortening leaves nothing usable: %j', async (condensed) => {
    const { calls, write } = writer([WRITTEN_FIXED, condensed]);
    const result = await curate('task', picked([candidate('a')]), { write, contextLimit: 1 });
    expect(result.log).toBe(FIXED);
    expect(calls).toHaveLength(2);
    expect(result.record.overContextLimit).toBe(true);
  });

  it('keeps usable lines when shortening produces a format slip', async () => {
    const condensed = `${WRITTEN_RANGE}\n${NOTHING}`;
    const result = await curate('task', picked([candidate('a')]), {
      write: writer([WRITTEN_FIXED, condensed]).write, contextLimit: 1,
    });
    expect(result.log).toBe(RANGE);
    expect(result.record).toMatchObject({ formatRecovery: { keptAsWritten: [WRITTEN_RANGE], dropped: [NOTHING] } });
  });
});
