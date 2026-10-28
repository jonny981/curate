import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  curate,
  type CurateOptions,
  type CuratePrompt,
  type MemoryCandidate,
  type PickRecordEntry,
  type PickResult,
} from '../src/index.js';

const LOG = '[2023-05-13] Visited York (said 2023-05-20; E1)';
const LONG_LOG = `[2023-05-13] ${'Travel notes. '.repeat(400)} (said 2023-05-20; E1)`;
const PERSON_RULE = 'Words quoted as the person\'s must come from an item marked \'by the person\'. An item by an agent may report what the person wants: say it is the agent\'s account, and do not quote it as the person\'s words.';
const SUMMARY_RULE = 'When an item by the person and a later item by an agent say the same thing, cite the person\'s item and keep the person\'s words.';

type Chat = NonNullable<MemoryCandidate['chat']>;
const item = (id: string, date: string, chat?: Chat): MemoryCandidate => ({
  sourceId: 'notes', id, title: `Title ${id}`, text: `Text ${id}`, role: 'reference', signals: {},
  date: { value: date, meaning: 'recorded' }, ...(chat === undefined ? {} : { chat }),
});

function picked(items: MemoryCandidate[], weights: number[], tags: Record<string, PickRecordEntry['tags']> = {}): PickResult {
  return {
    selected: items,
    record: {
      questionVersion: 'test', limits: {},
      thresholds: { linkedPathBar: 0 }, rulesCoverage: 'complete',
      levers: { everyRanked: true, everyScored: true, route: false, rare: false, sources: {} },
      effects: [],
      candidates: items.map((entry, index) => ({
        sourceId: entry.sourceId, id: entry.id, role: entry.role, priority: index,
        signals: entry.signals, status: 'selected' as const, asked: true, probability: weights[index]!,
        ...(tags[entry.id] === undefined ? {} : { tags: tags[entry.id] }),
      })),
    },
  };
}

async function prompts(task: string, pick: PickResult, logs: readonly string[], options: Omit<CurateOptions, 'write'> = {}) {
  const calls: CuratePrompt[] = [];
  await curate(task, pick, { ...options, write: async (prompt) => { calls.push(prompt); return logs[calls.length - 1] ?? ''; } });
  return calls;
}

const chatPart = (role: Chat['role'], author?: Chat['author'], authorName?: string): Chat => ({
  provider: 'claude-code', sessionId: 'session', role,
  ...(author === undefined ? {} : { author }), ...(authorName === undefined ? {} : { authorName }),
});
const three = () => [item('notes#1', '2023-05-20'), item('notes#2', '2023-05-21'), item('notes#3', '2023-05-22')];
const intent = { intent: { value: 'decision', answers: [{ key: 'decision', status: 'answered' as const, probability: 0.9 }] } };

// Curate calls whose items carry no author mark, built on the curate
// tests' fixtures. Each must send the prompts it sent before authors
// existed: their SHA-256 below was recorded on the build before them.
const UNMARKED: Record<string, () => Promise<CuratePrompt[]>> = {
  'one note': () => prompts('Recall', picked([item('notes#2', '2023-05-20')], [0.9]), [LOG]),
  'chat parts with no author': () => prompts('Recall', picked([
    item('chat#1', '2023-05-20', chatPart('user')), item('chat#2', '2023-05-21', chatPart('assistant')),
  ], [0.9, 0.3]), [LOG]),
  'every addition': () => prompts('Recall trips', picked(three(), [0.9, 0.5, 0.1]), [LOG],
    { working: true, context: true, preferenceAdvice: true, preferenceChange: true, taskDate: '2023-06-01' }),
  'count route': () => prompts('List every trip before June.', picked(three(), [0.9, 0.5, 0.1]), [LOG], { routeByTask: true }),
  'tags': () => prompts('Recall', picked(three(), [0.9, 0.5, 0.1], { 'notes#1': intent }), [LOG]),
  'chained': () => prompts('Recall', picked(three(), [0.9, 0.5, 0.1]), [LOG, '', ''], { batchTokens: 1 }),
  'condensed': () => prompts('Recall', picked([item('notes#2', '2023-05-20')], [0.9]), [LONG_LOG, LOG], { contextLimit: 100 }),
  'repair': () => prompts('Recall', picked([item('notes#2', '2023-05-20')], [0.9]), ['not a log', LOG]),
};
const sha256 = (calls: readonly CuratePrompt[]) => createHash('sha256').update(JSON.stringify(calls)).digest('hex');
const baseline: Record<string, string> = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/curate-unmarked-baseline.json'), 'utf8'));

describe('curate prompts with no author marks', () => {
  it('send the same bytes as before authors existed', async () => {
    const hashes = Object.fromEntries(await Promise.all(Object.entries(UNMARKED)
      .map(async ([name, run]) => [name, sha256(await run())] as const)));
    expect(hashes).toEqual(baseline);
  });

  it('treat an unmarked author as no mark', async () => {
    const run = (author?: Chat['author']) => prompts('Recall', picked([item('chat#1', '2023-05-20', chatPart('user', author))], [0.9]), [LOG]);
    expect(await run('unmarked')).toEqual(await run());
  });
});

describe('curate prompts with author marks', () => {
  it('name each chat part\'s author in its header and add the two rules', async () => {
    const calls = await prompts('What did the person decide?', picked([
      item('chat#1', '2023-05-20', chatPart('user', 'person')),
      item('chat#2', '2023-05-21', chatPart('user', 'agent', 'team-lead')),
      item('chat#3', '2023-05-22', chatPart('tool-result', 'tool')),
      item('chat#4', '2023-05-23', chatPart('user', 'system')),
      item('chat#5', '2023-05-24', chatPart('user', 'agent')),
      item('chat#6', '2023-05-25', chatPart('user', 'unmarked')),
    ], [0.9, 0.8, 0.7, 0.6, 0.5, 0.4]), [LOG]);
    expect(calls[0]!.body).toContain('### E1 (2023-05-20, 0.9, by the person): Title chat#1');
    expect(calls[0]!.body).toContain('### E2 (2023-05-21, 0.8, by agent team-lead): Title chat#2');
    expect(calls[0]!.body).toContain('### E3 (2023-05-22, 0.7, by a tool): Title chat#3');
    expect(calls[0]!.body).toContain('### E4 (2023-05-23, 0.6, system): Title chat#4');
    expect(calls[0]!.body).toContain('### E5 (2023-05-24, 0.5, by an agent): Title chat#5');
    expect(calls[0]!.body).toContain('### E6 (2023-05-25, 0.4): Title chat#6');
    expect(calls[0]!.instructions).toContain(PERSON_RULE);
    expect(calls[0]!.instructions).toContain(SUMMARY_RULE);
  });

  it('keep the rules in every pass of a chained write', async () => {
    const calls = await prompts('Recall', picked([
      item('chat#1', '2023-05-20', chatPart('user', 'person')), item('notes#2', '2023-05-21'), item('notes#3', '2023-05-22'),
    ], [0.9, 0.5, 0.1]), [LOG, '', ''], { batchTokens: 1 });
    expect(calls.length).toBe(3);
    expect(calls.every((call) => call.instructions.includes(PERSON_RULE) && call.instructions.includes(SUMMARY_RULE))).toBe(true);
  });
});
