import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { indexFilePath, removeEarlierFormats, STORED_INDEX_FORMAT } from '../src/stored-index.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

it('removes the files earlier formats wrote for the same source and settings, and no other file, and lists them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'curate-stored-index-'));
  directories.push(directory);
  // Two sources whose ids share the first 48 characters the names show,
  // and one source at two part sizes: every name before `.v<N>` differs.
  const source = `chat:codex:${'/a/long/folder/path/that/fills/the/readable/part'}/one`;
  const twin = `chat:codex:${'/a/long/folder/path/that/fills/the/readable/part'}/two`;
  const key = { includeTools: false, size: 700, exclude: [], stem: true };
  const other = { ...key, size: 300 };
  const write = (path: string) => writeFile(path, 'x');
  const earlier = Array.from({ length: STORED_INDEX_FORMAT - 1 }, (_, at) => indexFilePath(directory, source, key, at + 1));
  const kept = [
    indexFilePath(directory, source, key),
    indexFilePath(directory, source, key, STORED_INDEX_FORMAT + 1),
    ...Array.from({ length: STORED_INDEX_FORMAT }, (_, at) => indexFilePath(directory, source, other, at + 1)),
    ...Array.from({ length: STORED_INDEX_FORMAT }, (_, at) => indexFilePath(directory, twin, key, at + 1)),
  ];
  for (const path of earlier) for (const end of ['', '-wal', '-shm', '-journal']) await write(`${path}${end}`);
  for (const path of kept) await write(path);
  expect(new Set(kept.map((path) => basename(path).split('-').slice(0, -1).join('-'))).size).toBe(1);
  const removed = await removeEarlierFormats(directory, source, key);
  expect((await readdir(directory)).sort()).toEqual(kept.map((path) => basename(path)).sort());
  expect([...removed].sort()).toEqual(earlier.flatMap((path) => ['', '-wal', '-shm', '-journal'].map((end) => `${path}${end}`)).sort());
  expect(await removeEarlierFormats(directory, source, key)).toEqual([]);
});
