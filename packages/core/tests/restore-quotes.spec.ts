import { describe, expect, it } from 'vitest';

import {
  curate, type CurateWrite, type MemoryCandidate, type PickDecide, type PickResult,
} from '../src/index.js';
import { restoreQuotes, type CurateRow } from '../src/markup.js';

function part(sourceId: string, id: string, date: string | undefined, text: string,
  chat?: 'user' | 'assistant' | 'tool-call' | 'tool-result'): MemoryCandidate {
  return {
    sourceId, id, title: `Title ${id}`, text, role: 'reference', signals: {},
    ...(date === undefined ? {} : { date: { value: date, meaning: 'recorded' as const } }),
    ...(chat === undefined ? {} : { chat: { provider: 'claude-code' as const, sessionId: 's1', role: chat } }),
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

const row = (fields: Record<string, unknown>): CurateRow =>
  ({ who: 'you', what: 'an event', status: 'done', date: '', said: '', amount: '', quantity: '', source: [], quote: '', ...fields });

/** Restore over hand-built parts: `parts` are the references in selected
 *  order and by default every one gets a markup item `E1`, `E2`, ... in
 *  that order. */
function restore(input: {
  readonly rows: readonly CurateRow[];
  readonly parts: readonly MemoryCandidate[];
  readonly sections: readonly string[];
  readonly items?: readonly { e: string; id: string; candidate: MemoryCandidate }[];
}) {
  return restoreQuotes({
    rows: input.rows,
    parts: input.parts.map((candidate) => ({ id: `id/${candidate.id}`, candidate })),
    items: input.items
      ?? input.parts.map((candidate, index) => ({ e: `E${index + 1}`, id: `id/${candidate.id}`, candidate })),
    sections: input.sections,
  });
}

describe('restoreQuotes', () => {
  it('appends a dropped quote under its section, with the speaker the part shows', () => {
    const source = part('chat', 'a.md#1', '2024-03-02', 'user: I planted the quince row last spring.\nassistant: A fine tree.');
    const section = '## E1 (said 2024-03-02)\nuser: <event who="you" status="done">planted a quince</event>';
    const out = restore({ rows: [row({ source: ['E1'], quote: 'I planted the quince row last spring.' })], parts: [source], sections: [section] });
    expect(out.sections).toEqual([`${section}\nuser: I planted the quince row last spring.`]);
    expect(out.restored).toEqual([{ row: 1, e: 'E1', speaker: 'user', span: 'I planted the quince row last spring.' }]);
    expect(out.restoreSkipped).toEqual([]);
  });

  it('skips a quote whose words the section already holds, however the tags wrap them', () => {
    const source = part('chat', 'a.md#1', '2024-03-02', 'user: I bought a green bike.');
    const section = '## E1 (said 2024-03-02)\nuser: <event who="you">I bought a <pref feeling="likes" strength="mild">green</pref> bike.</event>';
    const out = restore({ rows: [row({ source: ['E1'], quote: 'I bought a green bike.' })], parts: [source], sections: [section] });
    expect(out.sections).toEqual([section]);
    expect(out.restored).toEqual([]);
    expect(out.restoreSkipped).toEqual([]);
  });

  it('records a quote the part text does not hold exactly, including one that would extend a word', () => {
    const source = part('chat', 'a.md#1', '2024-03-02', 'user: I replanted the quince row.');
    const section = '## E1 (said 2024-03-02)\nuser: quince work';
    const out = restore({ rows: [
      row({ source: ['E1'], quote: 'I planted the quince row.' }),
      row({ source: ['E1'], quote: 'planted the quince' }),
    ], parts: [source], sections: [section] });
    expect(out.sections).toEqual([section]);
    expect(out.restored).toEqual([]);
    expect(out.restoreSkipped).toEqual([
      { row: 1, part: 'id/a.md#1', reason: 'quote not in part' },
      { row: 2, part: 'id/a.md#1', reason: 'quote not in part' }]);
  });

  it('never uses a match whose span crosses a turn line', () => {
    const source = part('chat', 'a.md#1', '2024-03-02', 'user: I bought a bike.\nassistant: I sold mine last week.');
    const section = '## E1 (said 2024-03-02)\nuser: bikes';
    const out = restore({ rows: [row({ source: ['E1'], quote: 'I bought a bike.\nassistant: I sold mine last week.' })], parts: [source], sections: [section] });
    expect(out.sections).toEqual([section]);
    expect(out.restored).toEqual([]);
    expect(out.restoreSkipped).toEqual([{ row: 1, part: 'id/a.md#1', reason: 'speaker unclear' }]);
  });

  it('records a quote that matches twice under different speakers', () => {
    const source = part('chat', 'a.md#1', '2024-03-02', 'user: I run daily.\nassistant: I run daily.');
    const section = '## E1 (said 2024-03-02)\nuser: running';
    const out = restore({ rows: [row({ source: ['E1'], quote: 'I run daily.' })], parts: [source], sections: [section] });
    expect(out.sections).toEqual([section]);
    expect(out.restored).toEqual([]);
    expect(out.restoreSkipped).toEqual([{ row: 1, part: 'id/a.md#1', reason: 'speaker unclear' }]);
  });

  it('uses the chat role when a chat part has no turn line, and no speaker for a Markdown part', () => {
    const text = 'I keep bees in spring.';
    const chatPart = part('chat', 'a.md#1', '2024-03-02', text, 'user');
    const note = part('notes', 'b.md', '2024-03-03', text);
    const tool = part('chat', 'c.md#2', '2024-03-04', text, 'tool-call');
    const sections = [
      '## E1 (said 2024-03-02)\nuser: beekeeping',
      '## E2 (said 2024-03-03)\nuser: beekeeping',
      '## E3 (said 2024-03-04)\nuser: beekeeping'];
    const out = restore({ rows: [1, 2, 3].map((n) => row({ source: [`E${n}`], quote: text })),
      parts: [chatPart, note, tool], sections });
    expect(out.sections).toEqual([
      `${sections[0]}\nuser: ${text}`,
      `${sections[1]}\n${text}`,
      `${sections[2]}\n${text}`]);
    expect(out.restored).toEqual([
      { row: 1, e: 'E1', speaker: 'user', span: text },
      { row: 2, e: 'E2', span: text },
      { row: 3, e: 'E3', span: text }]);
  });

  it('orders restored lines by their offset in the part text, not by row order', () => {
    const source = part('chat', 'a.md#1', '2024-03-02', 'user: Bought bread at noon.\nuser: Bought milk at dusk.');
    const section = '## E1 (said 2024-03-02)\nuser: errands';
    const out = restore({ rows: [
      row({ source: ['E1'], quote: 'Bought milk at dusk.' }),
      row({ source: ['E1'], quote: 'Bought bread at noon.' }),
    ], parts: [source], sections: [section] });
    expect(out.sections).toEqual([`${section}\nuser: Bought bread at noon.\nuser: Bought milk at dusk.`]);
    expect(out.restored).toEqual([
      { row: 2, e: 'E1', speaker: 'user', span: 'Bought bread at noon.' },
      { row: 1, e: 'E1', speaker: 'user', span: 'Bought milk at dusk.' }]);
  });

  it('adds nothing the second time', () => {
    const source = part('chat', 'a.md#1', '2024-03-02', 'user: I keep bees.');
    const args = { rows: [row({ source: ['E1'], quote: 'I keep bees.' })], parts: [source], sections: ['## E1 (said 2024-03-02)\nuser: bees'] };
    const once = restore(args);
    expect(once.restored).toHaveLength(1);
    const twice = restore({ ...args, sections: once.sections });
    expect(twice.sections).toEqual(once.sections);
    expect(twice.restored).toEqual([]);
    expect(twice.restoreSkipped).toEqual([]);
  });

  it('matches a quote with non-ASCII letters exactly and compares it by words', () => {
    const chat = part('chat', 'a.md#1', '2024-03-02', 'user: Je préfère le café crème le matin.');
    const other = part('chat', 'b.md#1', '2024-03-02', 'user: anything');
    const sections = [
      '## E1 (said 2024-03-02)\nuser: goûts',
      '## E2 (said 2024-03-02)\nuser: <pref feeling="likes">café crème</pref>'];
    const out = restore({ rows: [
      row({ source: ['E1'], quote: 'café crème' }),
      row({ source: ['E2'], quote: 'café crème' }),
    ], parts: [chat, other], sections });
    expect(out.sections).toEqual([`${sections[0]}\nuser: café crème`, sections[1]]);
    expect(out.restored).toEqual([{ row: 1, e: 'E1', speaker: 'user', span: 'café crème' }]);
    expect(out.restoreSkipped).toEqual([]);
  });

  it('records citations outside the references and parts the markup did not write', () => {
    const marked = part('chat', 'a.md#1', '2024-03-02', 'user: I keep bees.');
    const unmarked = part('chat', 'b.md#1', '2024-03-02', 'user: I planted quince.');
    const section = '## E1 (said 2024-03-02)\nuser: bees';
    const out = restore({ rows: [
      row({ source: ['E9'], quote: 'no such part' }),
      row({ source: ['E2'], quote: 'I planted quince.' }),
      row({ source: ['E1'], quote: 'I keep bees.' }),
    ], parts: [marked, unmarked], sections: [section],
      items: [{ e: 'E1', id: 'id/a.md#1', candidate: marked }] });
    expect(out.sections).toEqual([`${section}\nuser: I keep bees.`]);
    expect(out.restored).toEqual([{ row: 3, e: 'E1', speaker: 'user', span: 'I keep bees.' }]);
    expect(out.restoreSkipped).toEqual([
      { row: 1, reason: 'invalid citation' },
      { row: 2, part: 'id/b.md#1', reason: 'invalid citation' }]);
  });

  it("restores an uncounted row's quote like a counted row's and leaves the figures byte-identical", async () => {
    const koi = part('pond', 'note#1', '2024-03-02', 'user: I netted the koi pond.\nassistant: A calm hour.');
    const write: CurateWrite = async (prompt) => prompt.step === 'extract'
      ? JSON.stringify({ rows: [
          row({ source: ['E1'], quote: 'I netted the koi pond.' }),
          row({ source: ['E1'], quote: 'A calm hour.' })] })
      : '## E1 (said 2024-03-02)\nuser: <event>netted koi</event>';
    const decide: PickDecide = async (batch) => Object.fromEntries(batch.questions.map((question, index) =>
      [question.key, { status: 'answered' as const, probability: [0.9, 0.1][index]! }]));
    const result = await curate('What did I do in the garden?', picked([koi]), { compression: 'low', decide, write });
    expect(result.log.split('### marked-up log')[0]).toBe([
      '### computed by code from extracted rows the decision model counted',
      '',
      'Figures over the 1 rows counted (of 2 rows extracted):',
      '- Rows counted: 1',
      '',
      'Counted rows, by date:',
      '1. [no date] who: you | what: an event | status: done | date: not stated (said ) | amount: - | quantity: - | source: E1 "I netted the koi pond."',
      '',
      '',
    ].join('\n'));
    expect(result.log).toContain('## E1 (said 2024-03-02)\nuser: <event>netted koi</event>\nuser: I netted the koi pond.\nassistant: A calm hour.');
    expect(result.record.restored).toEqual([
      { row: 1, e: 'E1', speaker: 'user', span: 'I netted the koi pond.' },
      { row: 2, e: 'E1', speaker: 'assistant', span: 'A calm hour.' }]);
    expect(result.record.restoreSkipped).toEqual([]);
  });
});
