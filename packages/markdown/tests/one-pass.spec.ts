import { mkdir, mkdtemp, readdir, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cachedEmbeddings, type CandidateReadRequest, type CandidateSource } from '@curatejs/core';
import { knowledgeBase, markdown } from '../src/index.js';
import { onePass } from '../src/markdown.js';

// The per-read path is the oracle: every read of a call must come back
// the same from the one-pass path, whatever changed on disk before it.

const folders: string[] = [];
afterEach(async () => {
  onePass.on = true;
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function folder(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), 'curate-one-pass-'));
  folders.push(made);
  return made;
}

async function write(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), text);
  }
}

// Most parts share a vector, so ties are ordered by id.
const embed = async (texts: readonly string[]) =>
  texts.map((text) => [text.includes('backup') ? 1 : 0, text.includes('battery') ? 1 : 0.5, text.includes('snapshots') ? 2 : 0]);
const task = 'Where does the battery backup run?';
const queries = [task, 'retention policy for snapshots'];
const lanes = [
  { task },
  { task, wholeLanes: false },
  { task: 'retention policy for snapshots', wholeLanes: false },
  { task, wholeLanes: true },
  { task, wholeLanes: false, limit: 2 },
  { task: 'exact phrase', phraseLane: true },
  { task: 'Alice', phraseLane: true },
  { task: 'backup', phraseLane: true, limit: 1 },
  { task: 'backup', phraseLane: true, topic: task, wholeLanes: false },
  { task: 'backup', phraseLane: true, topic: task, wholeLanes: true, limit: 1 },
  { task, wholeLanes: false, meaningLane: { embed }, meaningQueries: queries },
  { task: queries[1]!, wholeLanes: true, keptBodiesOnly: true, meaningLane: { embed }, meaningQueries: queries },
  { task, wholeLanes: true, meaningLane: { embed }, limit: 3 },
  // The call's query list again, after a lane with a list of its own:
  // the parts are scored from the vectors the call already holds.
  { task: queries[1]!, wholeLanes: false, meaningLane: { embed }, meaningQueries: queries },
  { task, wholeLanes: true, exclude: ['notes/alice.md'] },
  // These take the per-read path on both sides and must still agree.
  { task, wholeLanes: true, paths: ['src/backup.ts'] },
  { task, wholeLanes: true, decayHalfLife: 30 },
  { task, wholeLanes: false, taskPeriod: { from: '2026-10-01T00:00:00Z', to: '2026-10-15T00:00:00Z' } },
].map((lane): CandidateReadRequest => ({ ...lane, taskDate: '2026-10-28T12:00:00Z' }));
/** How many of the lanes above the one-pass path serves. */
const SERVED = 15;

const notes = {
  'notes/battery.md': '---\ntitle: Battery\nupdated: 2026-10-10\n---\n# Battery\n\n## Backup\n\nThe battery backup runs nightly from src/backup.ts. See [[retention]].\n\n## Checks\n\nBackup checks run weekly. See [the log](../log.md).\n',
  'notes/retention.md': '---\ntype: policy\nupdated: 2026-10-03\nstatus: superseded\n---\n## Policy\n\nRetention policy for snapshots keeps thirty days.\n',
  'notes/stale.md': '---\nupdated: 2026-09-01\nstale_after: 2026-10-20\n---\n## Battery plan\n\nAn old battery backup plan.\n',
  'notes/alice.md': `## People\n\nAlice keeps the exact phrase here. ${'More words about storage and power. '.repeat(30)}\n`,
  'notes/twin-a.md': '## Same\n\nA line about power.\n',
  'notes/twin-b.md': '## Same\n\nA line about power.\n',
  'notes/index.md': '- [[battery]]\n- [[retention]]\n',
  'log.md': '## [2026-10-05] update | Battery\n\nThe battery backup failed twice.\n\n## [2026-09-20] ingest | Old\n\nAn old backup note.\n',
};

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

/** The per-read path first, then the one-pass path in order and all at
 *  once, on the same files and index. */
async function agree(source: () => CandidateSource, list = lanes) {
  const oracle = await call(source, false, false, list);
  expect(oracle.served).toBe(0);
  const inOrder = await call(source, true, false, list);
  expect(inOrder.served).toBe(SERVED);
  expect(inOrder.results).toEqual(oracle.results);
  const together = await call(source, true, true, list);
  expect(together.served).toBe(SERVED);
  expect(together.results).toEqual(oracle.results);
  return oracle.results;
}

const kinds: [string, (root: string, cache: string) => CandidateSource][] = [
  ['a knowledge base', (root, cache) => knowledgeBase(root, { index: { directory: cache } })],
  ['a knowledge base with a look-back', (root, cache) => knowledgeBase(root, { index: { directory: cache }, since: '2026-10-01' })],
  ['docs', (root, cache) => markdown({ paths: [root], kind: 'docs', index: { directory: cache } })],
  ['docs from two paths', (root, cache) => markdown({ paths: [join(root, 'notes'), join(root, 'log.md')], kind: 'docs', index: { directory: cache } })],
];

describe('one-pass phrase lanes on generated notes', () => {
  // The per-read path counts every part; the one-pass path counts only
  // the parts the phrase index names.
  let seed = 5;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const words = ['battery', 'backup', 'Alice', 'retention', 'café', 'cafe\u0301', 'İstanbul', 'Москва', 'x\uE000y', 'ΣΟΦΟΣ',
    '漢字', 'the', 'a', 'of', 'v2', 'id_9', 'runs', 'nightly'];
  const say = (count: number) => Array.from({ length: count }, () => words[Math.floor(random() * words.length)]).join(' ');
  const generated = Object.fromEntries(Array.from({ length: 30 }, (_, note) => [`notes/note-${note}.md`,
    `---\ntitle: ${say(2)}\n---\n${Array.from({ length: 4 }, () => `## ${say(2)}\n\n${say(15)}\n`).join('\n')}`]));
  const phraseLanes = ['battery backup', 'Alice', 'café', 'İstanbul', 'москва', 'x y', 'σοφος', '漢字', 'cafe', 'id 9',
    'nightly runs', 'no such words'].map((task): CandidateReadRequest => ({ task, phraseLane: true, taskDate: '2026-10-28T12:00:00Z' }))
    .concat([{ task: 'backup', phraseLane: true, topic: 'battery retention', wholeLanes: false, taskDate: '2026-10-28T12:00:00Z' }]);
  it.each(kinds)('gives every phrase lane the per-read path gives, with %s', { timeout: 60_000 }, async (_name, make) => {
    const root = await folder();
    const cache = await folder();
    await write(root, generated);
    const oracle = await call(() => make(root, cache), false, false, phraseLanes);
    const indexed = await call(() => make(root, cache), true, false, phraseLanes);
    expect(indexed.served).toBe(phraseLanes.length);
    indexed.results.forEach((result, index) => expect(result, JSON.stringify(phraseLanes[index])).toEqual(oracle.results[index]));
    expect(oracle.results.filter((result) => result.candidates.length > 0).length).toBeGreaterThan(8);
  });
});

describe('one-pass read with a vector store', () => {
  // The one-pass meaning lanes find each part's vector by the key the
  // stored note holds; the per-read path hashes the text it embeds. With
  // the per-read path run first, every text's vector is stored, so a
  // one-pass run that embeds anything used a key that is not its text's.
  const stored = (directory: string) => {
    const texts: string[] = [];
    const embedder = cachedEmbeddings(async (list) => { texts.push(...list); return embed(list); }, { directory, modelId: 'test' });
    return { texts, lanes: lanes.map((lane) => lane.meaningLane === undefined ? lane : { ...lane, meaningLane: { embed: embedder } }) };
  };
  it.each(kinds)('gives the lanes the per-read path gives, and embeds nothing the store holds, with %s', { timeout: 60_000 }, async (_name, make) => {
    const root = await folder();
    const cache = await folder();
    const vectors = await folder();
    await write(root, notes);
    await call(() => make(root, cache), false, false, stored(vectors).lanes);
    const again = stored(vectors);
    const results = await agree(() => make(root, cache), again.lanes);
    expect(again.texts).toEqual([]);
    expect(results[10]!.candidates.length).toBeGreaterThan(0);
    await write(root, { 'notes/new.md': '## Backup window\n\nThe battery backup window is two hours.\n' });
    await call(() => make(root, cache), false, false, stored(vectors).lanes);
    const added = stored(vectors);
    await agree(() => make(root, cache), added.lanes);
    expect(added.texts).toEqual([]);
  });
});

describe.each(kinds)('one-pass read of %s', (_name, make) => {
  const signalOf = (results: ReturnType<typeof bare>[], id: RegExp, signal: string) =>
    results[3]!.candidates.find((candidate) => id.test(candidate.id))?.signals[signal];

  it('gives every lane the per-read path gives, on a first call and with nothing changed', { timeout: 60_000 }, async () => {
    const root = await folder();
    const cache = await folder();
    await write(root, notes);
    const first = await agree(() => make(root, cache));
    expect(first[3]!.candidates.length).toBeGreaterThan(5);
    expect(await agree(() => make(root, cache))).toEqual(first);
  });

  it('stays the same after a file is edited, a part is inserted mid-file, and files are added and deleted', { timeout: 60_000 }, async () => {
    const root = await folder();
    const cache = await folder();
    await write(root, notes);
    const source = () => make(root, cache);
    const first = await agree(source);

    await write(root, { 'notes/alice.md': `${notes['notes/alice.md']}\n## Later\n\nAlice added a battery backup note.\n` });
    const edited = await agree(source);
    expect(edited).not.toEqual(first);

    // A section in the middle moves every later part of the file down one.
    await write(root, { 'notes/battery.md': notes['notes/battery.md'].replace('## Checks', '## Middle\n\nA battery backup line in the middle.\n\n## Checks') });
    const inserted = await agree(source);
    expect(inserted).not.toEqual(edited);

    await write(root, { 'notes/new.md': '## Backup window\n\nThe battery backup window is two hours.\n' });
    const added = await agree(source);
    expect(added).not.toEqual(inserted);

    await unlink(join(root, 'notes/retention.md'));
    await unlink(join(root, 'notes/twin-b.md'));
    const deleted = await agree(source);
    expect(deleted).not.toEqual(added);
  });

  it('follows a link change into another note\'s score', { timeout: 60_000 }, async () => {
    const root = await folder();
    const cache = await folder();
    await write(root, notes);
    const source = () => make(root, cache);
    const before = signalOf(await agree(source), /retention/, 'inbound-links');
    // Alice's note changes; the retention note it now links to does not.
    await write(root, { 'notes/alice.md': `${notes['notes/alice.md']}\nSee [[retention]].\n` });
    const linked = signalOf(await agree(source), /retention/, 'inbound-links');
    expect(linked).toBeGreaterThan(before ?? 0);
    await write(root, { 'notes/alice.md': notes['notes/alice.md'], 'notes/battery.md': notes['notes/battery.md'].replace(' See [[retention]].', '') });
    const unlinked = signalOf(await agree(source), /retention/, 'inbound-links');
    expect(unlinked ?? 0).toBeLessThan(linked!);
  });

  it('keeps a phrase lane to the parts the call holds when another call indexes an edit between its lanes', { timeout: 60_000 }, async () => {
    const root = await folder();
    const cache = await folder();
    await write(root, { 'notes/note.md': 'The orchard grows quince.\n', 'log.md': 'Nothing here.\n' });
    const source = () => make(root, cache);
    const held = source();
    const context = { files: new Map<string, Promise<string>>(), shared: new Map<object, unknown>() };
    await held.read({ task: 'orchard', wholeLanes: true }, context);
    // A call that finds nothing changed leaves the index's count of updates.
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const count = async () => Promise.all((await readdir(cache)).filter((name) => name.endsWith('.sqlite')).map((name) => {
      const database = new DatabaseSync(join(cache, name), { readOnly: true });
      try {
        return (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      } finally {
        database.close();
      }
    }));
    const before = await count();
    await source().read({ task: 'apples' }, { files: new Map(), shared: new Map() });
    expect(await count()).toEqual(before);
    // Another call indexes an edit while this call holds the old text.
    await write(root, { 'notes/note.md': 'The orchard grows apples and pears instead.\n' });
    await source().read({ task: 'apples' }, { files: new Map(), shared: new Map() });
    for (const [phrase, found] of [['quince', 1], ['apples', 0]] as const) {
      const read = await held.read({ task: phrase, phraseLane: true }, context);
      const texts = read.status === 'read' ? read.candidates.map((candidate) => candidate.text) : [];
      expect(texts, phrase).toHaveLength(found);
      expect(texts.every((text) => text.includes('quince')), phrase).toBe(true);
    }
  });

  it('reads what the stored index holds when a file changes with its size and modified time unchanged', { timeout: 60_000 }, async () => {
    const root = await folder();
    const cache = await folder();
    await write(root, notes);
    const file = join(root, 'notes/twin-a.md');
    const moment = new Date('2026-10-01T00:00:00Z');
    await utimes(file, moment, moment);
    const source = () => make(root, cache);
    const first = await agree(source);
    await writeFile(file, notes['notes/twin-a.md'].replace('power', 'water'));
    await utimes(file, moment, moment);
    // The stored index keys a note on its size and modified time, so
    // neither path sees this edit; both still read the stored note.
    expect(await agree(source)).toEqual(first);
  });
});
