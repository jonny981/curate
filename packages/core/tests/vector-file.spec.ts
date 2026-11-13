import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { addMeaningRanks, cachedEmbeddings, type MemoryCandidate } from '../src/index.js';
import { normalize } from '../src/vectors.js';
import { openIndexFile } from '../src/stored-index.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function folder() {
  const directory = await mkdtemp(join(tmpdir(), 'curate-vector-store-'));
  directories.push(directory);
  return directory;
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const bytes = (...numbers: number[]) => new Uint8Array(Float64Array.from(numbers).buffer);
const MODEL = 'model-a';
const names = (directory: string) => ({
  keys: join(directory, `${sha(MODEL)}.vectors.keys.sqlite`),
  data: join(directory, `${sha(MODEL)}.vectors.data`),
  flat: join(directory, `${sha(MODEL)}.vectors.flat`),
  waiting: join(directory, `${sha(MODEL)}.vectors.waiting.sqlite`),
  earlier: join(directory, `${sha(MODEL)}.vectors.sqlite`),
});
type Rows = readonly (readonly [string, Uint8Array])[];

/** The whole-file vector file earlier code wrote: a header, then each
 *  text's SHA-256 and 64-bit numbers, then a last-used day per record. */
async function vectorFile(path: string, dimensions: number, rows: Rows) {
  const head = Buffer.alloc(32);
  Buffer.from('CURVEC1\n').copy(head);
  Buffer.from(Uint32Array.of(0x01020304, dimensions, rows.length).buffer).copy(head, 8);
  const records = rows.flatMap(([text, vector]) => [Buffer.from(sha(text), 'hex'), Buffer.from(vector)]);
  await writeFile(path, Buffer.concat([head, ...records, Buffer.from(Uint32Array.from(rows, () => 20_000).buffer)]));
}
/** A SQLite store earlier code kept: one row per text. */
async function sqliteStore(file: string, directory: string, rows: Rows) {
  const database = await openIndexFile(file, directory);
  database.exec('CREATE TABLE IF NOT EXISTS vectors (key TEXT PRIMARY KEY, vector BLOB NOT NULL) WITHOUT ROWID');
  const put = database.prepare('INSERT OR REPLACE INTO vectors (key, vector) VALUES (?, ?)');
  for (const [text, vector] of rows) put.run(sha(text), vector);
  database.close();
}
async function storedRows(directory: string) {
  const database = await openIndexFile(names(directory).keys, directory);
  try {
    return database.prepare('SELECT key, record FROM keys ORDER BY record').all() as { key: string; record: number }[];
  } finally {
    database.close();
  }
}
const never = async (): Promise<never> => { throw new Error('embedded a text the store already holds'); };
const counting = (vector: number[]) => {
  const calls: string[][] = [];
  return { calls, embed: async (texts: readonly string[]) => { calls.push([...texts]); return texts.map(() => vector); } };
};
const as = (vectors: readonly ArrayLike<number>[]) => vectors.map((vector) => Array.from(vector));

it('takes in every vector the earlier files kept, once and bit for bit, and removes the vector file and its waiting store only when asked', async () => {
  const directory = await folder();
  const { flat, waiting, earlier } = names(directory);
  const odd = bytes(1 / 3, -0, 5e-324);
  await vectorFile(flat, 3, [['odd', odd], ['shared', bytes(1, 0, 0)]]);
  // The vector file's copy of a text wins over the one waiting to join it.
  await sqliteStore(waiting, directory, [['shared', bytes(0, 1, 0)], ['waiting', bytes(0, 0, 1)]]);
  // With a vector file present, the store before it built nothing.
  await sqliteStore(earlier, directory, [['only earlier', bytes(0.6, 0.8, 0)]]);
  const untouched = await readFile(earlier);
  const written = vi.spyOn(process.stderr, 'write');
  const [got, shared, wait] = await cachedEmbeddings(never, { directory, modelId: MODEL })(['odd', 'shared', 'waiting']);
  expect(new Uint8Array(Float64Array.from(got!).buffer)).toEqual(odd);
  expect(Object.is(got![1], -0)).toBe(true);
  expect(as([shared!, wait!])).toEqual([[1, 0, 0], [0, 0, 1]]);
  const { calls, embed } = counting([0, 3, 4]);
  expect(as(await cachedEmbeddings(embed, { directory, modelId: MODEL })(['only earlier']))).toEqual([[0, 0.6, 0.8]]);
  expect(calls).toEqual([['only earlier']]);
  // Using the store removes nothing: an older process can still have the files open.
  expect(await Promise.all([flat, waiting].map((file) => stat(file).then(() => true)))).toEqual([true, true]);
  // Every vector was found again, so asking removes the vector file and
  // the waiting store, and names them; the store before them is never changed.
  const removed = await cachedEmbeddings(never, { directory, modelId: MODEL }).removeEarlierFiles();
  expect(removed).toContain(flat);
  expect(removed).toContain(waiting);
  expect((await readdir(directory)).filter((name) => /\.vectors\.(?:flat|waiting)/.test(name))).toEqual([]);
  expect(await readFile(earlier)).toEqual(untouched);
  expect(written).not.toHaveBeenCalled();
  expect(await cachedEmbeddings(never, { directory, modelId: MODEL }).removeEarlierFiles()).toEqual([]);
});

it('keeps the waiting store an older store still writes to across a newer store\'s take-in, and then keeps it on asking', async () => {
  const directory = await folder();
  const { waiting } = names(directory);
  await sqliteStore(waiting, directory, [['kept', bytes(0.6, 0.8)]]);
  // An older process's store, open on its waiting store.
  const older = await openIndexFile(waiting, directory);
  expect(as(await cachedEmbeddings(never, { directory, modelId: MODEL })(['kept']))).toEqual([[0.6, 0.8]]);
  // The older store writes on, to the file that is still there.
  older.prepare('INSERT INTO vectors (key, vector) VALUES (?, ?)').run(sha('later'), bytes(0.8, 0.6));
  older.close();
  const reopened = await openIndexFile(waiting, directory);
  expect(reopened.prepare('SELECT COUNT(*) AS n FROM vectors').get()).toEqual({ n: 2 });
  reopened.close();
  // Its later vector is not in the newer store, so asking keeps both files and says so.
  const written = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  expect(await cachedEmbeddings(never, { directory, modelId: MODEL }).removeEarlierFiles()).toEqual([]);
  expect(String(written.mock.calls[0]![0])).toMatch(/left .*vectors\.waiting\.sqlite in place/);
  expect((await stat(waiting)).isFile()).toBe(true);
});

it('leaves the vector file and its waiting store, and says so, when their vectors cannot all be checked', async () => {
  const directory = await folder();
  const { flat, waiting } = names(directory);
  await vectorFile(flat, 2, [['kept', bytes(0.6, 0.8)], ['other', bytes(0.8, 0.6)]]);
  // A cut vector file: it cannot be read, so its vectors cannot be checked.
  await writeFile(flat, (await readFile(flat)).subarray(0, 50));
  await sqliteStore(waiting, directory, [['waiting', bytes(1, 0)]]);
  const before = await Promise.all([flat, waiting].map((file) => readFile(file)));
  const written = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const store = cachedEmbeddings(never, { directory, modelId: MODEL });
  expect(as(await store(['waiting']))).toEqual([[1, 0]]);
  expect(written).not.toHaveBeenCalled();
  expect(await store.removeEarlierFiles()).toEqual([]);
  expect(await Promise.all([flat, waiting].map((file) => readFile(file)))).toEqual(before);
  expect(written).toHaveBeenCalledTimes(1);
  expect(String(written.mock.calls[0]![0])).toMatch(/left .*vectors\.flat and .*vectors\.waiting\.sqlite in place/);
  // The take-in is done; a later store does not try it again.
  await cachedEmbeddings(never, { directory, modelId: MODEL })(['waiting']);
  expect(written).toHaveBeenCalledTimes(1);
});

it('takes in the store before the vector file where there is no vector file', async () => {
  const directory = await folder();
  await sqliteStore(names(directory).earlier, directory, [['old', bytes(0.6, 0.8)]]);
  await sqliteStore(names(directory).waiting, directory, [['new', bytes(0.8, 0.6)]]);
  expect(as(await cachedEmbeddings(never, { directory, modelId: MODEL })(['old', 'new']))).toEqual([[0.6, 0.8], [0.8, 0.6]]);
});

it('never reads a cut or foreign vector file', async () => {
  const directory = await folder();
  const { flat } = names(directory);
  await vectorFile(flat, 2, [['kept', bytes(0.6, 0.8)]]);
  const whole = await readFile(flat);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  for (const file of [whole.subarray(0, whole.length - 3), Buffer.concat([Buffer.from('NOTCURV\n'), whole.subarray(8)])]) {
    const fresh = await folder();
    await writeFile(names(fresh).flat, file);
    const { calls, embed } = counting([0, 2]);
    expect(as(await cachedEmbeddings(embed, { directory: fresh, modelId: MODEL })(['kept']))).toEqual([[0, 1]]);
    expect(calls).toEqual([['kept']]);
  }
});

it('takes the earlier files in once, however many stores open at once', async () => {
  const directory = await folder();
  await vectorFile(names(directory).flat, 2, [['kept', bytes(0.6, 0.8)]]);
  const stores = [0, 1, 2].map(() => cachedEmbeddings(never, { directory, modelId: MODEL }));
  expect((await Promise.all(stores.map((store) => store(['kept'])))).map(as)).toEqual([[[0.6, 0.8]], [[0.6, 0.8]], [[0.6, 0.8]]]);
  // Earlier code adds a vector to its own file later: the store has moved on.
  await sqliteStore(names(directory).waiting, directory, [['added later', bytes(1, 0)]]);
  const { calls, embed } = counting([0, 5]);
  await cachedEmbeddings(embed, { directory, modelId: MODEL })(['added later']);
  expect(calls).toEqual([['added later']]);
  expect((await storedRows(directory)).map((row) => row.key).sort()).toEqual([sha('added later'), sha('kept')].sort());
});

it('appends each new vector after the last, rewriting nothing and writing no other file', async () => {
  const directory = await folder();
  const { embed } = counting([3, 4]);
  await cachedEmbeddings(embed, { directory, modelId: MODEL })(['first', 'second']);
  const before = await storedRows(directory);
  const bytes = await readFile(names(directory).data);
  const inode = (await stat(names(directory).data)).ino;
  for (let round = 0; round < 3; round += 1) {
    await cachedEmbeddings(embed, { directory, modelId: MODEL })(Array.from({ length: 50 }, (_, at) => `round ${round} part ${at}`));
  }
  const after = await storedRows(directory);
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after.map((row) => row.record)).toEqual(Array.from({ length: 152 }, (_, at) => at));
  expect((await readFile(names(directory).data)).subarray(0, bytes.length)).toEqual(bytes);
  expect((await stat(names(directory).data)).ino).toBe(inode);
  expect((await readdir(directory)).filter((name) => /\.vectors\.(?:flat|waiting\.sqlite)$/.test(name))).toEqual([]);
});

it('never uses a record a stopped write left cut, and keeps a vector of another length apart', async () => {
  const directory = await folder();
  await cachedEmbeddings(async (texts) => texts.map((text) => text === 'odd' ? [1, 1, 1, 1] : [3, 4]), { directory, modelId: MODEL })(['whole', 'cut', 'odd']);
  const { data } = names(directory);
  await writeFile(data, (await readFile(data)).subarray(0, (32 + 16) * 2 - 5));
  const { calls, embed } = counting([0, 7]);
  const vectors = await cachedEmbeddings(embed, { directory, modelId: MODEL })(['whole', 'cut', 'odd']);
  expect(as(vectors)).toEqual([[0.6, 0.8], [0, 1], [0.5, 0.5, 0.5, 0.5]]);
  expect(calls).toEqual([['cut']]);
  // The cut record was written again after the last whole one.
  expect(as(await cachedEmbeddings(never, { directory, modelId: MODEL })(['cut']))).toEqual([[0, 1]]);
});

it('keeps a vector however long it goes unused', async () => {
  const directory = await folder();
  await cachedEmbeddings(async (texts) => texts.map(() => [3, 4]), { directory, modelId: MODEL })(['a part read once']);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 400 * 86_400_000);
  expect(as(await cachedEmbeddings(never, { directory, modelId: MODEL })(['a part read once']))).toEqual([[0.6, 0.8]]);
});

it('hands out each key\'s vector by a pass over the file or a lookup per key, the same either way, and asks for the text of a missing key only', async () => {
  const directory = await folder();
  const vectorOf = (at: number) => [Math.cos(at), Math.sin(at)];
  const texts = Array.from({ length: 10 }, (_, at) => `part ${at}`);
  await cachedEmbeddings(async (list) => list.map((text) => vectorOf(Number(text.split(' ')[1]))), { directory, modelId: MODEL })(texts);
  const asked: number[] = [];
  const read = async (keys: readonly string[]) => {
    const handed: [number, number[]][] = [];
    await cachedEmbeddings(async (list) => list.map(() => [1, 0]), { directory, modelId: MODEL })
      .eachVector(keys, (index) => { asked.push(index); return `missing ${index}`; }, (index, vector) => handed.push([index, Array.from(vector)]));
    return handed.sort((left, right) => left[0] - right[0]);
  };
  // Nine keys of ten: one pass over the file. Two keys: a lookup each.
  const many = await read([...texts.slice(0, 8), texts[3]!].map(sha));
  const few = await read([texts[3]!, sha('not stored')].map((key, at) => at === 0 ? sha(key) : key));
  expect(many.map(([index, vector]) => [index, vector.map((value) => Number(value.toFixed(12)))]))
    .toEqual([0, 1, 2, 3, 4, 5, 6, 7, 3].map((at, index) => [index, vectorOf(at).map((value) => Number(value.toFixed(12)))]));
  expect(few[0]).toEqual([0, many[3]![1]]);
  expect(few[1]).toEqual([1, [1, 0]]);
  expect(asked).toEqual([1]);
});

it('still reads and writes vectors after a garbage collection', async () => {
  const directory = await folder();
  const cached = cachedEmbeddings(async (texts) => texts.map(() => [3, 4]), { directory, modelId: MODEL });
  await cached(['first']);
  setFlagsFromString('--expose-gc');
  const collect = runInNewContext('gc') as () => void;
  for (let round = 0; round < 3; round += 1) {
    collect();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(as(await cached(['second', 'first']))).toEqual([[0.6, 0.8], [0.6, 0.8]]);
  expect(await storedRows(directory)).toHaveLength(2);
});

it('ranks the same from vectors taken in from the earlier file as from vectors embedded afresh', async () => {
  const texts = Array.from({ length: 40 }, (_, at) => `part ${at}`);
  const vectorOf = (text: string) => {
    const seed = [...sha(text)].map((character) => character.charCodeAt(0));
    return Float64Array.from({ length: 8 }, (_, at) => Math.sin(seed[at]! * (at + 1)));
  };
  const candidates: MemoryCandidate[] = texts.map((text, at) => ({
    sourceId: 'notes', id: `n${at}`, title: text, text, role: 'reference', signals: {},
  }));
  const ranked = async (directory: string, embed: (list: readonly string[]) => Promise<Float64Array[]>) =>
    (await addMeaningRanks(candidates, 'part 3', {
      embed: cachedEmbeddings(embed, { directory, modelId: MODEL }), searchLines: ['part 17'], wholeLanes: true,
    })).map((candidate) => [candidate.id, candidate.searchRanks, candidate.meaningScore]);
  const fresh = await ranked(await folder(), async (list) => list.map(vectorOf));
  // The earlier file held each vector as the earlier store wrote it.
  const moved = await folder();
  await vectorFile(names(moved).flat, 8, ['part 3', 'part 17', ...texts]
    .map((text) => [text, new Uint8Array(normalize(normalize(vectorOf(text))).buffer)] as const)
    .filter(([text], at, all) => all.findIndex(([other]) => other === text) === at));
  expect(await ranked(moved, never)).toEqual(fresh);
});
