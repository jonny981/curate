import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cachedEmbeddings, type CandidateReadRequest, type CandidateSource } from '@curatejs/core';
import { chat, type ChatProvider } from '../src/index.js';
import { onePass } from '../src/chat.js';

// The per-lane path is the oracle: every read of a call must come back
// the same from the one-pass path, whatever the transcripts hold.

const folders: string[] = [];
afterEach(async () => {
  onePass.on = true;
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});
async function folder(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), 'curate-chat-one-pass-'));
  folders.push(made);
  return made;
}

const OLD = '2026-09-01T12:00:00Z';
const NEW = '2026-10-02T12:00:00Z';
const LATER = '2026-10-05T09:30:00Z';
function message(provider: ChatProvider, role: 'user' | 'assistant', text: string, timestamp = NEW): unknown {
  return provider === 'claude-code'
    ? { type: role, timestamp, sessionId: 'session-one', message: { content: [{ type: 'text', text }] } }
    : { type: 'response_item', timestamp, payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } };
}
async function transcript(provider: ChatProvider, records: unknown[], root: string, name: string): Promise<string> {
  const directory = join(root, provider === 'codex' ? '2026/10/02' : 'project');
  await mkdir(directory, { recursive: true });
  const metadata = provider === 'codex' ? [{ type: 'session_meta', timestamp: OLD, payload: { id: name } }] : [];
  const file = join(directory, `${name}.jsonl`);
  await writeFile(file, [...metadata, ...records].map((record) => JSON.stringify(record)).join('\n') + '\n');
  return file;
}

// Most parts share a vector, so ties are ordered by id. A part embeds
// with the part before it, so only its own last line decides.
const embed = async (texts: readonly string[]) => texts.map((text) => {
  const own = text.split('\n').at(-1)!;
  return [own.includes('pump') ? 1 : 0, own.includes('orchard') ? 1 : 0.5, own.includes('quince') ? 2 : 0];
});
const task = 'Where did we put the pond pump filter?';
const queries = [task, 'orchard pruning in the quince row', 'a line nothing holds'];
const lanes = [
  { task },
  { task, wholeLanes: false },
  { task: queries[1]!, wholeLanes: false },
  { task: 'pond pump', wholeLanes: false },
  { task, wholeLanes: true },
  { task, wholeLanes: false, limit: 2 },
  { task: 'zzzz qqqq', wholeLanes: false },
  { task: 'we said', phraseLane: true },
  { task: 'Quince', phraseLane: true },
  { task: 'no such phrase', phraseLane: true },
  { task: 'orchard', phraseLane: true, limit: 2 },
  { task: 'we said', phraseLane: true, topic: task, wholeLanes: false },
  { task: 'we said', phraseLane: true, topic: task, wholeLanes: true, limit: 1 },
  { task: 'we said', phraseLane: true, topic: task, wholeLanes: true, speakerOnly: true },
  { task, wholeLanes: false, meaningLane: { embed }, meaningQueries: queries },
  { task: queries[1]!, wholeLanes: true, keptBodiesOnly: true, meaningLane: { embed }, meaningQueries: queries },
  { task: queries[2]!, wholeLanes: true, meaningLane: { embed }, meaningQueries: queries },
  { task, wholeLanes: true, meaningLane: { embed }, limit: 3 },
  // A query list of its own, then the call's list again.
  { task: 'pond pump', wholeLanes: false, meaningLane: { embed } },
  { task, wholeLanes: true, keptBodiesOnly: true, meaningLane: { embed }, meaningQueries: queries },
  { task, wholeLanes: true, timeZone: 'Pacific/Auckland' },
  { task, wholeLanes: false, taskPeriod: { from: '2026-10-01T00:00:00Z', to: '2026-10-03T00:00:00Z' } },
  // A three-letter word that only a title holds: the session's name.
  { task: 'fig orchard', wholeLanes: false },
].map((lane): CandidateReadRequest => ({ ...lane, taskDate: '2026-10-28T12:00:00Z' }));

/** A history with long and short transcripts, old turns between new
 *  ones, twin texts, an undated record and two providers. */
async function history(root: string): Promise<void> {
  const turn = (index: number) => [
    message('codex', 'user', `The orchard row ${index} was pruned early.`, index % 3 === 0 ? OLD : NEW),
    message('codex', 'assistant', index % 7 === 0 ? `We said the pond pump ${index} needs a filter.` : `Noted item ${index}.`,
      index % 4 === 0 ? OLD : LATER),
  ];
  await transcript('codex', Array.from({ length: 30 }, (_, index) => turn(index)).flat(), root, 'orchard');
  await transcript('codex', [
    message('codex', 'user', 'We said the Quince row gets the pond pump filter on Friday.'),
    message('codex', 'assistant', 'The same line twice.'),
    message('codex', 'user', 'The same line twice.'),
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'no date' }] } },
    message('codex', 'assistant', `We said this at length. ${'Long notes about the orchard and its quince. '.repeat(40)}`),
  ], root, 'pond');
  await transcript('codex', [message('codex', 'user', 'One part alone about breakfast.')], root, 'single');
  await transcript('codex', [message('codex', 'user', 'A short note about a tree.'), message('codex', 'assistant', 'Noted.')], root, 'fig');
  await transcript('claude-code', [
    message('claude-code', 'user', 'The pond pump was replaced on Friday.'),
    message('claude-code', 'assistant', 'We said the filter goes in the shed.'),
  ], root, 'third');
}

type Read = Awaited<ReturnType<CandidateSource['read']>>;
const bare = (result: Read) => {
  if (result.status !== 'read') throw new Error(`Expected a read, got ${result.status}`);
  const { index: _index, ...rest } = result;
  return rest;
};

/** Every lane of one call, in order or all at once. */
async function call(source: () => CandidateSource, on: boolean, atOnce = false, list = lanes) {
  onePass.on = on;
  onePass.served = 0;
  const reader = source();
  const shared = { files: new Map<string, Promise<string>>(), shared: new Map<object, unknown>() };
  const results: Read[] = [];
  if (atOnce) results.push(...await Promise.all(list.map((lane) => reader.read(lane, shared))));
  else for (const lane of list) results.push(await reader.read(lane, shared));
  return { results: results.map(bare), served: onePass.served };
}

/** A lane with the call's own window and time zone: the one-pass path
 *  serves it. The others take the per-lane path on both sides. */
const walked = (lane: CandidateReadRequest) => lane.timeZone === undefined && lane.taskPeriod === undefined;

/** The per-lane path first, then the one-pass path, on the same
 *  transcripts and index. */
async function agree(source: () => CandidateSource, list = lanes, served = list.filter(walked).length) {
  const oracle = await call(source, false, false, list);
  expect(oracle.served).toBe(0);
  const inOrder = await call(source, true, false, list);
  expect(inOrder.served).toBe(served);
  inOrder.results.forEach((result, index) => expect(result, JSON.stringify(list[index])).toEqual(oracle.results[index]));
  return oracle.results;
}

const kinds: [string, (root: string, cache: string) => CandidateSource][] = [
  ['both providers', (root, cache) => chat({ paths: [root], index: { directory: cache } })],
  ['a look-back', (root, cache) => chat({ paths: [root], index: { directory: cache }, since: '2026-09-15' })],
  ['one provider', (root, cache) => chat({ providers: ['codex'], paths: [root], index: { directory: cache } })],
  // The default settings ignore a part's length; these weigh it.
  ['length-weighted keywords', (root, cache) => chat({ paths: [root], index: { directory: cache }, keyword: { b: 0.75 } })],
];

describe.each(kinds)('one-pass chat read with %s', (_name, make) => {
  it('gives every lane the per-lane path gives, on a first call and with nothing changed', { timeout: 60_000 }, async () => {
    const root = await folder();
    const cache = await folder();
    await history(root);
    const first = await agree(() => make(root, cache));
    // The fixture exercises what it says: matches, an empty lane, ties and skips.
    expect(first[4]!.candidates.length).toBeGreaterThan(20);
    expect(first[6]!.candidates).toEqual([]);
    expect(first[9]!.candidates).toEqual([]);
    expect(first[11]!.candidates.length).toBeGreaterThan(1);
    expect(first[14]!.candidates.length).toBeGreaterThan(1);
    expect(first[15]!.meaningScores!.length).toBeGreaterThan(20);
    expect(first[0]!.partial).toMatch(/skipped 1 symbolic links or undated messages/);
    expect(await agree(() => make(root, cache))).toEqual(first);
  });

  it('gives the same lanes when they are read all at once', { timeout: 60_000 }, async () => {
    const root = await folder();
    const cache = await folder();
    await history(root);
    // Lanes with one query list, so which lane scores first cannot matter.
    const list = lanes.filter((lane) => lane.meaningLane === undefined || lane.meaningQueries !== undefined);
    const oracle = await call(() => make(root, cache), false, false, list);
    const together = await call(() => make(root, cache), true, true, list);
    expect(together.served).toBe(list.filter(walked).length);
    // Which meaning lane reports the skipped record depends on which scores first.
    const settled = (result: ReturnType<typeof bare>) => {
      const { partial: _partial, complete: _complete, ...rest } = result;
      return rest;
    };
    together.results.forEach((result, index) => expect(list[index]!.meaningLane === undefined ? result : settled(result), JSON.stringify(list[index]))
      .toEqual(list[index]!.meaningLane === undefined ? oracle.results[index] : settled(oracle.results[index]!)));
  });

  it('stays the same after parts are added between calls', { timeout: 60_000 }, async () => {
    const root = await folder();
    const cache = await folder();
    await history(root);
    const first = await agree(() => make(root, cache));
    await appendFile(join(root, '2026/10/02', 'single.jsonl'),
      `${JSON.stringify(message('codex', 'assistant', 'We said the pond pump filter moved to the orchard.', LATER))}\n`);
    await transcript('codex', [message('codex', 'user', 'A new quince note about the pump.', LATER)], root, 'added');
    const second = await agree(() => make(root, cache));
    expect(second[4]!.candidates.length).toBe(first[4]!.candidates.length + 2);
  });
});

describe('one-pass keyword lanes on a generated history', () => {
  // The direct read scores every part and sorts them all: the oracle for
  // lanes that order only the parts a posting or title names.
  let seed = 7;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const words = ['orchard', 'quince', 'pump', 'filter', 'S3', 'bucket', 'Alice', 'we', 'said', 'the', 'pond', 'runs', 'codex',
    'user', 'assistant', 'noted', 'v2', 'id', 'a', 'of', 'backups', 'nightly', '2026'];
  async function generated(root: string) {
    for (let file = 0; file < 12; file += 1) {
      const provider: ChatProvider = file % 3 === 0 ? 'claude-code' : 'codex';
      const records = Array.from({ length: 30 }, (_, turn) => {
        // Repeated texts make ties; some parts hold no task word at all.
        const text = turn % 9 === 0 ? 'The same line again.'
          : Array.from({ length: 3 + Math.floor(random() * 9) }, () => words[Math.floor(random() * words.length)]).join(' ');
        const day = `2026-${String(9 + (turn % 2)).padStart(2, '0')}-${String(1 + ((file + turn) % 27)).padStart(2, '0')}T10:00:00Z`;
        return message(provider, turn % 2 === 0 ? 'user' : 'assistant', text, day);
      });
      await transcript(provider, records, root, `generated-${file}`);
    }
  }
  const tasks = ['Where is the S3 bucket Alice named for nightly backups?', 'codex user assistant 2026 orchard',
    'pond pump filter', 'a v2 id of the quince', 'zzzz qqqq'];
  const generatedLanes = tasks.flatMap((task) => [
    { task }, { task, wholeLanes: false }, { task, wholeLanes: true },
    { task, wholeLanes: false, limit: 1 }, { task, wholeLanes: false, limit: 7 }, { task, wholeLanes: true, limit: 40 },
    { task, wholeLanes: false, limit: 5_000 },
  ]).map((lane): CandidateReadRequest => ({ ...lane, taskDate: '2026-10-28T12:00:00Z' }));
  it.each<[string, Parameters<typeof chat>[0]]>([
    ['the default settings', {}],
    ['no rank merge', { keyword: { rrf: false } }],
    ['length-weighted keywords', { keyword: { b: 0.75 } }],
    ['a look-back', { since: '2026-09-20' }],
  ])('gives every keyword lane the direct read gives, with %s', { timeout: 60_000 }, async (_name, settings) => {
    const root = await folder();
    const cache = await folder();
    await generated(root);
    const direct: ReturnType<typeof bare>[] = [];
    for (const lane of generatedLanes) direct.push(bare(await chat({ paths: [root], index: false, ...settings }).read(lane)));
    const onePassed = await call(() => chat({ paths: [root], index: { directory: cache }, ...settings }), true, false, generatedLanes);
    expect(onePassed.served).toBe(generatedLanes.length);
    onePassed.results.forEach((result, index) => expect(result, JSON.stringify(generatedLanes[index])).toEqual(direct[index]));
    // The fixture exercises what it says: a cut that keeps some, a miss, and limits on both sides of the scored parts.
    expect(direct[1]!.candidates.length).toBeGreaterThan(1);
    expect(direct[2]!.candidates.length).toBeGreaterThan(direct[1]!.candidates.length);
    expect(direct[29]!.candidates).toEqual([]);
  });
});

describe('one-pass chat read with a vector store', () => {
  // The one-pass meaning lanes find each part's vector by the key its row
  // stores; the per-lane path hashes the text it embeds. With the per-lane
  // path run first, every true text's vector is stored, so a one-pass run
  // that embeds anything used a key that is not its text's.
  const stored = (directory: string) => {
    const texts: string[] = [];
    const embedder = cachedEmbeddings(async (list) => { texts.push(...list); return embed(list); }, { directory, modelId: 'test' });
    return { texts, lanes: lanes.map((lane) => lane.meaningLane === undefined ? lane : { ...lane, meaningLane: { embed: embedder } }) };
  };
  it.each(kinds)('gives the lanes the per-lane path gives, and embeds nothing the store holds, with %s', { timeout: 60_000 }, async (_name, make) => {
    const root = await folder();
    const cache = await folder();
    const vectors = await folder();
    await history(root);
    // A part with only an invisible character embeds its title.
    await transcript('codex', [message('codex', 'user', 'Before the mark.'), message('codex', 'user', '​'),
      message('codex', 'assistant', 'After the mark, the pond pump.')], root, 'marks');
    const first = stored(vectors);
    await call(() => make(root, cache), false, false, first.lanes);
    expect(first.texts.length).toBeGreaterThan(30);
    const second = stored(vectors);
    const together = await agree(() => make(root, cache), second.lanes);
    expect(second.texts).toEqual([]);
    expect(together[14]!.candidates.length).toBeGreaterThan(1);
    // New parts: an appended part embeds with the stored part before it.
    await appendFile(join(root, '2026/10/02', 'orchard.jsonl'),
      `${JSON.stringify(message('codex', 'assistant', 'The pond pump filter moved to the orchard.', LATER))}\n`);
    await call(() => make(root, cache), false, false, stored(vectors).lanes);
    const third = stored(vectors);
    await agree(() => make(root, cache), third.lanes);
    expect(third.texts).toEqual([]);
  });
});

describe('one-pass chat read', () => {
  // The per-lane path shares a call's first keyword enumeration and its
  // meaning scores with every later lane, whatever that lane's own
  // window or time zone. The one-pass path must leave the same behind,
  // and step aside when a per-lane read got there first.
  const at = (lane: Partial<CandidateReadRequest>): CandidateReadRequest => ({ task, taskDate: '2026-10-28T12:00:00Z', ...lane });
  const period = { taskPeriod: { from: '2026-10-01T00:00:00Z', to: '2026-10-03T00:00:00Z' } };
  const zoned = { timeZone: 'Pacific/Auckland' };
  const meaning = { meaningLane: { embed }, meaningQueries: queries };
  it.each<[string, CandidateReadRequest[], number]>([
    ['a period read after the call\'s lanes', [at({ wholeLanes: false }), at({ wholeLanes: true, ...period }), at({ wholeLanes: true })], 2],
    ['a period read before them', [at({ wholeLanes: true, ...period }), at({ wholeLanes: false }), at({ wholeLanes: true })], 1],
    ['a phrase lane, then a period read, then a keyword lane',
      [at({ task: 'we said', phraseLane: true }), at({ wholeLanes: true, ...period }), at({ wholeLanes: false }), at({ task: 'we said', phraseLane: true })], 2],
    ['meaning lanes in two time zones',
      [at({ wholeLanes: true, ...meaning }), at({ wholeLanes: true, ...zoned, ...meaning }), at({ task: queries[1]!, wholeLanes: false, ...meaning })], 2],
    ['a zoned meaning lane with a list of its own between the call\'s',
      [at({ wholeLanes: false, ...meaning }), at({ wholeLanes: true, ...zoned, meaningLane: { embed } }), at({ wholeLanes: true, ...meaning }),
        at({ task: queries[1]!, wholeLanes: true, keptBodiesOnly: true, ...meaning })], 1],
    ['a zoned keyword lane first', [at({ wholeLanes: false, ...zoned }), at({ wholeLanes: false }), at({ task: 'we said', phraseLane: true, topic: task, wholeLanes: false })], 1],
  ])('leaves a later per-lane read what the per-lane path would: %s', { timeout: 60_000 }, async (_name, list, served) => {
    const root = await folder();
    const cache = await folder();
    await history(root);
    await agree(() => chat({ paths: [root], index: { directory: cache } }), list, served);
  });

  it('serves a history with one part', { timeout: 60_000 }, async () => {
    const root = await folder();
    const cache = await folder();
    await transcript('codex', [message('codex', 'user', 'We said the pond pump filter is in the shed.')], root, 'only');
    const results = await agree(() => chat({ providers: ['codex'], paths: [root], index: { directory: cache } }));
    expect(results[4]!.candidates).toHaveLength(1);
  });

  it('leaves a read with no stored index or no shared context on the per-lane path', { timeout: 60_000 }, async () => {
    const root = await folder();
    const cache = await folder();
    await history(root);
    onePass.served = 0;
    const context = { files: new Map<string, Promise<string>>(), shared: new Map<object, unknown>() };
    await chat({ paths: [root], index: false }).read(lanes[1]!, context);
    await chat({ paths: [root], index: { directory: cache } }).read(lanes[1]!);
    expect(onePass.served).toBe(0);
  });
});
