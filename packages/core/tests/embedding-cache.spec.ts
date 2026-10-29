import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { cachedEmbeddings } from '../src/meaning.js';

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
  const models = await readdir(directory);
  expect(models).toHaveLength(2);
  expect((await Promise.all(models.map((model) => readdir(join(directory, model))))).flat()).toHaveLength(4);
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
