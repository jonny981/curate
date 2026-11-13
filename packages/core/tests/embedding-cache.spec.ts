import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { cachedEmbeddings } from '../src/meaning.js';
import { openIndexFile } from '../src/stored-index.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

it('persists each complete unique input across runs and separates model identities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'curate-embeddings-'));
  directories.push(directory);
  const calls: string[][] = [];
  const embed = async (texts: readonly string[]) => {
    calls.push([...texts]);
    return texts.map((text) => [text.includes('previous') ? 1 : 0, 1]);
  };
  const first = cachedEmbeddings(embed, { directory, modelId: 'model-a' });
  const initial = await first(['reply', 'reply', 'previous\nreply']);
  expect(calls).toEqual([['reply', 'previous\nreply']]);
  expect(initial[0]).toEqual(initial[1]);
  expect(initial[0]).not.toEqual(initial[2]);
  const resumed = cachedEmbeddings(embed, { directory, modelId: 'model-a' });
  expect(await resumed(['previous\nreply', 'reply'])).toEqual([initial[2], initial[0]]);
  expect(calls).toHaveLength(1);
  await resumed(['reply', 'edited reply']);
  expect(calls).toEqual([['reply', 'previous\nreply'], ['edited reply']]);
  const other = cachedEmbeddings(embed, { directory, modelId: 'model-b' });
  await other(['reply']);
  expect(calls).toEqual([['reply', 'previous\nreply'], ['edited reply'], ['reply']]);
  const models = (await readdir(directory)).filter((name) => name.endsWith('.vectors.keys.sqlite'));
  expect(models).toHaveLength(2);
  const counts = [];
  for (const model of models) {
    const database = await openIndexFile(join(directory, model), directory);
    try {
      counts.push((database.prepare('SELECT COUNT(*) AS n FROM keys').get() as { n: number }).n);
    } finally {
      database.close();
    }
  }
  expect(counts.sort()).toEqual([1, 3]);
});

it('migrates a vector left in the per-text JSON folder into the model\'s vector store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'curate-embeddings-'));
  directories.push(directory);
  const modelHash = createHash('sha256').update('model-a').digest('hex');
  const legacy = join(directory, modelHash);
  await mkdir(legacy, { recursive: true });
  const key = createHash('sha256').update('kept text').digest('hex');
  await writeFile(join(legacy, `${key}.json`), JSON.stringify([3, 4]));
  const calls: string[][] = [];
  const cached = cachedEmbeddings(async (texts) => {
    calls.push([...texts]);
    return texts.map(() => [9, 9]);
  }, { directory, modelId: 'model-a' });
  const [vector] = await cached(['kept text']);
  expect(calls).toEqual([]);
  expect(Array.from(vector!)).toEqual([0.6, 0.8]);
  const database = await openIndexFile(join(directory, `${modelHash}.vectors.keys.sqlite`), directory);
  try {
    expect(database.prepare('SELECT COUNT(*) AS n FROM keys').get()).toEqual({ n: 1 });
  } finally {
    database.close();
  }
});

it('embeds a shared text once when source reads overlap', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'curate-embeddings-'));
  directories.push(directory);
  const calls: string[][] = [];
  const cached = cachedEmbeddings(async (texts) => {
    calls.push([...texts]);
    return texts.map(() => [1, 0]);
  }, { directory, modelId: 'same-model' });
  const results = await Promise.all([cached(['shared', 'first']), cached(['shared', 'second'])]);
  expect(calls).toEqual([['shared', 'first'], ['second']]);
  expect(results[0]![0]).toEqual(results[1]![0]);
});
