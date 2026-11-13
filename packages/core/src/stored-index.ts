import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, open, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where a reader keeps its stored index: one local file per source. */
export interface StoredIndexOptions {
  /** The folder the file lives in. Absent means
   *  `$XDG_CACHE_HOME/curate/index`, or `~/.cache/curate/index` when
   *  XDG_CACHE_HOME is unset. */
  readonly directory?: string;
}

/** What bringing one source's stored index up to date did in this call. */
export interface StoredIndexReport {
  /** Parts in the file after the update. */
  readonly parts: number;
  /** Parts written this call: new parts, and parts read again from a
   *  changed file. */
  readonly added: number;
  /** Parts deleted this call: the parts of a removed or changed file,
   *  including the old copies of parts read again. */
  readonly removed: number;
  /** True when the file was emptied and every part read again. */
  readonly rebuilt: boolean;
  /** Milliseconds the update took. */
  readonly ms: number;
}

/** The stored layout's version. A file of another version is never
 *  opened: its name differs, so the source is indexed again. */
export const STORED_INDEX_FORMAT = 6;

/** Checks a reader's `index` option: a settings object or false. */
export function checkIndexOption(option: unknown): void {
  if (option === undefined || option === false) return;
  if (typeof option !== 'object' || option === null || Array.isArray(option)) {
    throw new TypeError('index must be { directory } or false.');
  }
  const { directory, ...rest } = option as Record<string, unknown>;
  if (Object.keys(rest).length > 0) throw new TypeError('index takes only directory.');
  if (directory !== undefined && (typeof directory !== 'string' || directory.trim() === '')) {
    throw new TypeError('index.directory must be a non-empty string.');
  }
}

/** The folder a reader's index lives in, or undefined when it is off.
 *  Read when the file is opened, so the environment of that call decides. */
export function indexDirectory(option: StoredIndexOptions | false | undefined): string | undefined {
  if (option === false) return undefined;
  return option?.directory
    ?? join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'curate', 'index');
}

/** The parts of `node:sqlite` the index uses. */
export interface IndexDatabase {
  exec(sql: string): void;
  prepare(sql: string): IndexStatement;
  close(): void;
}
export interface IndexStatement {
  run(...values: unknown[]): { readonly changes: number | bigint; readonly lastInsertRowid: number | bigint };
  all(...values: unknown[]): unknown[];
  get(...values: unknown[]): unknown;
  /** The rows one at a time, never all held. */
  iterate(...values: unknown[]): IterableIterator<unknown>;
}

/** The file for one source: its name comes from the source id, the
 *  settings that decide which parts exist (`key`) and the format
 *  version. A change to any of them names a new file. */
export function indexFilePath(directory: string, sourceId: string, key: unknown, format = STORED_INDEX_FORMAT): string {
  const hash = createHash('sha256').update(JSON.stringify([sourceId, key, format])).digest('hex').slice(0, 24);
  const readable = sourceId.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return join(directory, `${readable === '' ? 'source' : readable}-${hash}.v${format}.sqlite`);
}

/** Removes the files earlier formats wrote for the same source and
 *  settings, and returns the paths it removed: each is the name
 *  `indexFilePath` gives them under an earlier format number, which every
 *  format has named the same way, and holds only what the source gives
 *  again. A name says which files are this source's, not that no older
 *  reader still has one open, so only a run between calls asks for it
 *  (a read context's `removed`), never an ordinary read. */
export async function removeEarlierFormats(directory: string, sourceId: string, key: unknown): Promise<string[]> {
  const removed: string[] = [];
  for (let format = 1; format < STORED_INDEX_FORMAT; format += 1) {
    const path = indexFilePath(directory, sourceId, key, format);
    for (const file of ['', '-wal', '-shm', '-journal'].map((end) => `${path}${end}`)) {
      if (!existsSync(file)) continue;
      await rm(file, { force: true });
      removed.push(file);
    }
  }
  return removed;
}

/** Opens (creating when absent) one source's index file with mode 0600,
 *  inside a folder made with mode 0700. `node:sqlite` loads here, on
 *  the first open, so a process that never indexes never loads it. Node
 *  22 prints an ExperimentalWarning when it loads. */
export async function openIndexFile(path: string, directory: string): Promise<IndexDatabase> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // The file holds the history's text: create it private before SQLite
  // opens it. SQLite gives the files it makes beside it the same mode.
  await (await open(path, 'a', 0o600)).close();
  await chmod(path, 0o600);
  const sqlite = process.getBuiltinModule('node:sqlite') as unknown as {
    DatabaseSync: new (path: string) => IndexDatabase;
  } | undefined;
  if (sqlite === undefined) {
    throw new Error('The stored index needs node:sqlite, which this Node does not provide. '
      + 'Node 22 from 22.20 and Node 24 have it; or pass index: false to read the source directly.');
  }
  const database = new sqlite.DatabaseSync(path);
  // Two updates of one file from two processes take turns: the second
  // waits for the first to commit rather than fail. The wait drops
  // nothing.
  database.exec('PRAGMA busy_timeout = 600000');
  // A lane reads while another process writes, and the reverse, without
  // waiting on each other. The exclusive lock this pragma needs skips
  // the busy handler, so two opens of one file can race it and the loser
  // fails at once rather than waiting; retry inside the same window the
  // timeout grants a write.
  const deadline = Date.now() + 600_000;
  for (;;) {
    try {
      database.exec('PRAGMA journal_mode = WAL');
      break;
    } catch (error) {
      if ((error as { errcode?: number }).errcode !== 5 || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  return database;
}

const updating = new Map<string, Promise<unknown>>();

/** How many updates have changed the file, as `updateIndex` counts them.
 *  A call that holds parts read from the file uses the file's own lookups
 *  only while the count is the one it read with those parts. */
export function indexVersion(database: IndexDatabase): number {
  return (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

/** Runs `work` on one file after every earlier update of that file in
 *  this process has finished, inside one write transaction: either every
 *  change lands or none does. SQLite's own lock makes other processes
 *  wait, but a wait inside one process would stop the update it waits on.
 *  An update that changed a row adds one to `indexVersion`. */
export function updateIndex<T>(path: string, database: IndexDatabase, work: () => Promise<T>): Promise<T> {
  const before = updating.get(path) ?? Promise.resolve();
  const changes = () => (database.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  const run = before.catch(() => undefined).then(async () => {
    database.exec('BEGIN IMMEDIATE');
    try {
      const unchanged = changes();
      const result = await work();
      if (changes() !== unchanged) database.exec(`PRAGMA user_version = ${indexVersion(database) + 1}`);
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  });
  const settled = run.catch(() => undefined);
  updating.set(path, settled);
  void settled.then(() => { if (updating.get(path) === settled) updating.delete(path); });
  return run;
}

/** A part's words and how often each occurs, as one string: ` word:count`
 *  per distinct word, with a trailing space. It needs no word list shared
 *  across parts, so the file and the memory a read uses never grow with
 *  the history's vocabulary. Words must hold no space or colon. */
export function wordBag(words: Iterable<string>): string {
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  const entries: string[] = [''];
  for (const [word, count] of counts) entries.push(`${word}:${count}`);
  entries.push('');
  return entries.join(' ');
}

/** How often `word` occurs in a `wordBag` string: 0 when it does not. */
export function bagCount(bag: string, word: string): number {
  const at = bag.indexOf(` ${word}:`);
  if (at === -1) return 0;
  const start = at + word.length + 2;
  return Number(bag.slice(start, bag.indexOf(' ', start)));
}

/** The distinct words a `wordBag` string holds, in its own order. */
export function bagWords(bag: string): readonly string[] {
  return bag.trim() === '' ? [] : bag.trim().split(' ').map((entry) => entry.slice(0, entry.lastIndexOf(':')));
}

/** The `word:count` pairs a `wordBag` string holds, in its own order. */
export function* bagEntries(bag: string): Generator<readonly [string, number]> {
  for (const entry of bag.trim().split(' ')) {
    if (entry === '') continue;
    const at = entry.lastIndexOf(':');
    yield [entry.slice(0, at), Number(entry.slice(at + 1))];
  }
}
