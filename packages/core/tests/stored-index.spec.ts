import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { indexFilePath, indexVersion, openIndexFile, removeEarlierFormats, STORED_INDEX_FORMAT, updateIndex } from '../src/stored-index.js';

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

it('counts the updates that changed the file, and no other', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'curate-stored-index-'));
  directories.push(directory);
  const path = join(directory, 'one.sqlite');
  const database = await openIndexFile(path, directory);
  try {
    database.exec('CREATE TABLE rows (n INTEGER)');
    expect(indexVersion(database)).toBe(0);
    await updateIndex(path, database, async () => { database.prepare('INSERT INTO rows VALUES (1)').run(); });
    expect(indexVersion(database)).toBe(1);
    // An update that reads, or writes nothing, leaves the count.
    await updateIndex(path, database, async () => { database.prepare('SELECT COUNT(*) FROM rows').get(); });
    await updateIndex(path, database, async () => { database.prepare('DELETE FROM rows WHERE n = 2').run(); });
    expect(indexVersion(database)).toBe(1);
    await updateIndex(path, database, async () => { database.prepare('UPDATE rows SET n = 3').run(); });
    expect(indexVersion(database)).toBe(2);
    // A failed update changes nothing, its count included.
    await expect(updateIndex(path, database, async () => {
      database.prepare('INSERT INTO rows VALUES (4)').run();
      throw new Error('stopped');
    })).rejects.toThrow('stopped');
    expect(indexVersion(database)).toBe(2);
  } finally {
    database.close();
  }
});
