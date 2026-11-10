import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it } from 'vitest';
import { addMeaningRanks, cachedEmbeddings, type MemoryCandidate } from '../src/index.js';
import { openIndexFile } from '../src/stored-index.js';
import { FOLD_AT, KEEP_DAYS, markVectorsUsed, readVectorFile, today, writeVectorFile } from '../src/vector-file.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function folder() {
  const directory = await mkdtemp(join(tmpdir(), 'curate-vector-file-'));
  directories.push(directory);
  return directory;
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const bytes = (...numbers: number[]) => new Uint8Array(Float64Array.from(numbers).buffer);
const MODEL = 'model-a';
const names = (directory: string) => ({
  flat: join(directory, `${sha(MODEL)}.vectors.flat`),
  waiting: join(directory, `${sha(MODEL)}.vectors.waiting.sqlite`),
  earlier: join(directory, `${sha(MODEL)}.vectors.sqlite`),
});
type Rows = readonly (readonly [string, Uint8Array])[];
async function store(file: string, directory: string, rows: Rows) {
  const database = await openIndexFile(file, directory);
  database.exec('CREATE TABLE IF NOT EXISTS vectors (key TEXT PRIMARY KEY, vector BLOB NOT NULL) WITHOUT ROWID');
  const put = database.prepare('INSERT OR REPLACE INTO vectors (key, vector) VALUES (?, ?)');
  database.exec('BEGIN');
  for (const [text, vector] of rows) put.run(sha(text), vector);
  database.exec('COMMIT');
  database.close();
}
/** The store the code before the vector file kept: one row per text. */
const earlierStore = (directory: string, rows: Rows) => store(names(directory).earlier, directory, rows);
/** Vectors waiting to be folded into the vector file. */
const waitingStore = (directory: string, rows: Rows) => store(names(directory).waiting, directory, rows);
/** A vector as the code before the vector file reads it: by key, from its own store. */
async function earlierRead(directory: string, text: string) {
  const database = await openIndexFile(names(directory).earlier, directory);
  try {
    return (database.prepare('SELECT vector FROM vectors WHERE key = ?').get(sha(text)) as { vector: Uint8Array } | undefined)?.vector;
  } finally {
    database.close();
  }
}
async function waiting(directory: string) {
  const database = await openIndexFile(names(directory).waiting, directory);
  try {
    return (database.prepare('SELECT COUNT(*) AS n FROM vectors').get() as { n: number }).n;
  } finally {
    database.close();
  }
}
const filler = (count: number) => Array.from({ length: count }, (_, at) => [`filler ${at}`, bytes(0.6, 0.8)] as const);
const never = async (): Promise<never> => { throw new Error('embedded a text the store already holds'); };

it('reads back exactly the keys, vectors and days it wrote', async () => {
  const { flat } = names(await folder());
  const third = 1 / 3;
  writeVectorFile(flat, 3, [
    { key: sha('one'), vector: bytes(third, -0, 5e-324), day: 20_000 },
    { key: sha('two'), vector: bytes(1, 2, 3), day: 20_001 },
  ]);
  const file = readVectorFile(flat)!;
  expect([file.dimensions, file.count, [...file.days]]).toEqual([3, 2, [20_000, 20_001]]);
  const one = file.vector(file.index.get(sha('one'))!);
  expect(Object.is(one[0], third) && Object.is(one[1], -0) && one[2] === 5e-324).toBe(true);
  expect([...file.vector(file.index.get(sha('two'))!)]).toEqual([1, 2, 3]);
  expect(file.record(1)).toEqual({ key: sha('two'), vector: Buffer.from(bytes(1, 2, 3)) });
  expect(readVectorFile(`${flat}.absent`)).toBeUndefined();
});

it('never reads a cut or foreign file, and a stopped write leaves the old file whole', async () => {
  const directory = await folder();
  const { flat } = names(directory);
  writeVectorFile(flat, 2, [{ key: sha('kept'), vector: bytes(0.6, 0.8), day: today() }]);
  const whole = await readFile(flat);
  // A write that stops part-way: the rows run out with an error.
  expect(() => writeVectorFile(flat, 2, (function* rows() {
    yield { key: sha('new'), vector: bytes(1, 0), day: today() };
    throw new Error('stopped');
  })())).toThrow('stopped');
  expect(await readFile(flat)).toEqual(whole);
  expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  expect(() => writeVectorFile(flat, 2, [{ key: 'short', vector: bytes(1, 0), day: 1 }])).toThrow('SHA-256');
  expect(() => writeVectorFile(flat, 2, [{ key: sha('long'), vector: bytes(1, 0, 0), day: 1 }])).toThrow('dimensions');
  for (const cut of [whole.length - 1, whole.length - 4, 40, 31, 0]) {
    await truncate(flat, cut);
    expect(readVectorFile(flat)).toBeUndefined();
    await writeFile(flat, whole);
  }
  await writeFile(flat, Buffer.concat([whole, Buffer.alloc(8)]));
  expect(readVectorFile(flat)).toBeUndefined();
  await writeFile(flat, Buffer.concat([Buffer.from('NOTCURV\n'), whole.subarray(8)]));
  expect(readVectorFile(flat)).toBeUndefined();
});

it('embeds again rather than read a cut vector file', async () => {
  const directory = await folder();
  const { flat } = names(directory);
  writeVectorFile(flat, 2, [{ key: sha('kept'), vector: bytes(0.6, 0.8), day: today() }]);
  await truncate(flat, (await readFile(flat)).length - 3);
  const calls: string[][] = [];
  const cached = cachedEmbeddings(async (texts) => { calls.push([...texts]); return texts.map(() => [0, 2]); }, { directory, modelId: MODEL });
  expect((await cached(['kept'])).map((vector) => Array.from(vector))).toEqual([[0, 1]]);
  expect(calls).toEqual([['kept']]);
});

it('builds the vector file from the earlier store once, and never changes that store', async () => {
  const directory = await folder();
  const odd = bytes(1 / 3, 2 / 3);
  await earlierStore(directory, [...filler(5), ['odd', odd]]);
  const untouched = await readFile(names(directory).earlier);
  const cached = cachedEmbeddings(never, { directory, modelId: MODEL });
  const [vector, first] = await cached(['odd', 'filler 0']);
  expect(new Uint8Array(Float64Array.from(vector!).buffer)).toEqual(odd);
  expect(Array.from(first!)).toEqual([0.6, 0.8]);
  const file = readVectorFile(names(directory).flat)!;
  expect([file.count, file.dimensions]).toEqual([6, 2]);
  expect([...file.days].every((day) => day === today())).toBe(true);
  expect(await waiting(directory)).toBe(0);
  expect(await readFile(names(directory).earlier)).toEqual(untouched);
  // A second process reads the vector file and asks the model for nothing.
  expect((await cachedEmbeddings(never, { directory, modelId: MODEL })(['filler 3', 'odd'])).map((v) => Array.from(v)))
    .toEqual([[0.6, 0.8], [1 / 3, 2 / 3]]);
  // A fold later, the earlier store is still as it was, and code that reads it by key still finds its vectors.
  await waitingStore(directory, Array.from({ length: FOLD_AT }, (_, at) => [`later ${at}`, bytes(1, 0)] as const));
  await cachedEmbeddings(never, { directory, modelId: MODEL })(['later 5', 'odd']);
  expect(readVectorFile(names(directory).flat)!.count).toBe(FOLD_AT + 6);
  expect(await waiting(directory)).toBe(0);
  expect(await readFile(names(directory).earlier)).toEqual(untouched);
  expect(await earlierRead(directory, 'odd')).toEqual(odd);
  expect(await earlierRead(directory, 'later 5')).toBeUndefined();
});

it('does not read the earlier store again once the vector file exists', async () => {
  const directory = await folder();
  await earlierStore(directory, filler(3));
  await cachedEmbeddings(never, { directory, modelId: MODEL })(['filler 0']);
  // Code from before the vector file adds a vector to its own store.
  await earlierStore(directory, [['added by earlier code', bytes(1, 0)]]);
  const calls: string[][] = [];
  const cached = cachedEmbeddings(async (texts) => { calls.push([...texts]); return texts.map(() => [0, 5]); }, { directory, modelId: MODEL });
  expect((await cached(['added by earlier code'])).map((v) => Array.from(v))).toEqual([[0, 1]]);
  expect(calls).toEqual([['added by earlier code']]);
  expect(readVectorFile(names(directory).flat)!.count).toBe(3);
});

it('keeps a new part\'s vector in the waiting file until enough wait, then folds them in', async () => {
  const directory = await folder();
  await earlierStore(directory, filler(4));
  const calls: string[][] = [];
  const embed = async (texts: readonly string[]) => { calls.push([...texts]); return texts.map(() => [3, 4]); };
  await cachedEmbeddings(embed, { directory, modelId: MODEL })(['filler 1', 'a new part']);
  expect(calls).toEqual([['a new part']]);
  expect(await waiting(directory)).toBe(1);
  expect(readVectorFile(names(directory).flat)!.count).toBe(4);
  expect(await earlierRead(directory, 'a new part')).toBeUndefined();
  // The next process finds it waiting and does not embed it again.
  expect((await cachedEmbeddings(never, { directory, modelId: MODEL })(['a new part'])).map((v) => Array.from(v))).toEqual([[0.6, 0.8]]);
  await waitingStore(directory, Array.from({ length: FOLD_AT }, (_, at) => [`later ${at}`, bytes(1, 0)] as const));
  await cachedEmbeddings(never, { directory, modelId: MODEL })(['a new part', 'later 5']);
  expect(readVectorFile(names(directory).flat)!.count).toBe(FOLD_AT + 5);
  expect(await waiting(directory)).toBe(0);
});

it('drops the vector of a changed part once it has gone unused, and keeps one in use', async () => {
  const directory = await folder();
  const { flat } = names(directory);
  const stale = today() - KEEP_DAYS - 1;
  writeVectorFile(flat, 2, [
    { key: sha('the part as it was'), vector: bytes(1, 0), day: stale },
    { key: sha('a part still read'), vector: bytes(0, 1), day: stale },
    { key: sha('a part read last week'), vector: bytes(0.6, 0.8), day: today() - 7 },
  ]);
  const cached = cachedEmbeddings(never, { directory, modelId: MODEL });
  await cached(['a part still read']);
  cached.flush();
  expect([...readVectorFile(flat)!.days]).toEqual([stale, today(), today() - 7]);
  // The part changed: its new text is new to the store, and enough new vectors now wait for a fold.
  await waitingStore(directory, [...filler(FOLD_AT), ['the part as it is', bytes(0, 1)]]);
  await cachedEmbeddings(never, { directory, modelId: MODEL })(['the part as it is']);
  const file = readVectorFile(flat)!;
  expect(file.count).toBe(FOLD_AT + 3);
  expect(file.index.has(sha('the part as it was'))).toBe(false);
  expect(['a part still read', 'a part read last week', 'the part as it is'].every((text) => file.index.has(sha(text)))).toBe(true);
});

it('still reads and writes waiting vectors after a garbage collection', async () => {
  const directory = await folder();
  const cached = cachedEmbeddings(async (texts) => texts.map(() => [3, 4]), { directory, modelId: MODEL });
  await cached(['first']);
  setFlagsFromString('--expose-gc');
  const collect = runInNewContext('gc') as () => void;
  for (let round = 0; round < 3; round += 1) {
    collect();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect((await cached(['second', 'first'])).map((vector) => Array.from(vector))).toEqual([[0.6, 0.8], [0.6, 0.8]]);
  expect(await waiting(directory)).toBe(2);
});

it('keeps both last-used days when two readers of the same file record their use', async () => {
  const directory = await folder();
  const { flat } = names(directory);
  const stale = today() - KEEP_DAYS - 1;
  writeVectorFile(flat, 2, [
    { key: sha('A'), vector: bytes(1, 0), day: stale },
    { key: sha('B'), vector: bytes(0, 1), day: stale },
  ]);
  const one = cachedEmbeddings(never, { directory, modelId: MODEL });
  const two = cachedEmbeddings(never, { directory, modelId: MODEL });
  await one(['A']);
  await two(['B']);
  one.flush();
  two.flush();
  expect([...readVectorFile(flat)!.days]).toEqual([today(), today()]);
  // The next fold keeps both: neither is embedded again.
  await waitingStore(directory, filler(FOLD_AT));
  await cachedEmbeddings(never, { directory, modelId: MODEL })(['A', 'B']);
  expect(readVectorFile(flat)!.count).toBe(FOLD_AT + 2);
});

it('records a use in the file a fold wrote since this reader loaded the one before it', async () => {
  const directory = await folder();
  const { flat } = names(directory);
  writeVectorFile(flat, 2, [
    { key: sha('gone'), vector: bytes(1, 0), day: today() - KEEP_DAYS - 1 },
    { key: sha('A'), vector: bytes(0, 1), day: today() - 7 },
    { key: sha('B'), vector: bytes(0.6, 0.8), day: today() - 3 },
  ]);
  const reader = cachedEmbeddings(never, { directory, modelId: MODEL });
  await reader(['A']);
  // Another process folds: the file is replaced, and A is now its first record.
  await waitingStore(directory, filler(FOLD_AT));
  await cachedEmbeddings(never, { directory, modelId: MODEL })(['B']);
  const folded = readVectorFile(flat)!;
  expect([folded.count, folded.index.get(sha('A')), folded.days[0]]).toEqual([FOLD_AT + 2, 0, today() - 7]);
  reader.flush();
  const after = readVectorFile(flat)!;
  expect([after.days[after.index.get(sha('A'))!], after.days[after.index.get(sha('B'))!]]).toEqual([today(), today() - 3]);
});

it('only ever moves a last-used day later', async () => {
  const { flat } = names(await folder());
  writeVectorFile(flat, 2, [
    { key: sha('one'), vector: bytes(1, 0), day: 9 },
    { key: sha('two'), vector: bytes(0, 1), day: 5 },
  ]);
  const read = readVectorFile(flat)!;
  markVectorsUsed(flat, read, Uint8Array.of(1, 1), 7);
  expect([...readVectorFile(flat)!.days]).toEqual([9, 7]);
});

it('ranks the same from the vector file as from the store before it', async () => {
  const directory = await folder();
  const texts = Array.from({ length: 40 }, (_, at) => `part ${at}`);
  const vectorOf = (text: string) => {
    const seed = [...sha(text)].map((character) => character.charCodeAt(0));
    const raw = Float64Array.from({ length: 8 }, (_, at) => Math.sin(seed[at]! * (at + 1)));
    const length = Math.hypot(...raw);
    return raw.map((value) => value / length);
  };
  const candidates: MemoryCandidate[] = texts.map((text, at) => ({
    sourceId: 'notes', id: `n${at}`, title: text, text, role: 'reference', signals: {},
  }));
  const embed = async (list: readonly string[]) => list.map(vectorOf);
  const ranked = async () => (await addMeaningRanks(candidates, 'part 3', {
    embed: cachedEmbeddings(embed, { directory, modelId: MODEL }), searchLines: ['part 17'], wholeLanes: true,
  })).map((candidate) => [candidate.id, candidate.searchRanks, candidate.meaningScore]);
  const before = await ranked();
  expect(readVectorFile(names(directory).flat)).toBeUndefined();
  await waitingStore(directory, Array.from({ length: FOLD_AT }, (_, at) => [`pad ${at}`, new Uint8Array(vectorOf(`pad ${at}`).buffer)] as const));
  const after = await ranked();
  expect(readVectorFile(names(directory).flat)!.count).toBe(FOLD_AT + texts.length);
  expect(after).toEqual(before);
});
