import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLocalEmbedder } from '@curatejs/core/local-embeddings';

// @ts-expect-error The standalone JavaScript command has no type declarations.
import { run } from '../skills/curate/run.mjs';

const dispose = vi.fn(async () => {});
const embedder = async () => ({
  embed: async (texts: readonly string[]) => texts.map((text) => /orchard|fruit|tree/i.test(text) ? [1, 0] : [0, 1]),
  dispose,
});
vi.mock('@curatejs/core/local-embeddings', () => ({ createLocalEmbedder: vi.fn() }));
// The mocked embedding model stands in for a model file, so a .gguf path counts as present.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn((path: string) => path.endsWith('.gguf') || actual.existsSync(path)) };
});
vi.mocked(createLocalEmbedder).mockImplementation(embedder as never);

const directories: string[] = [];
// A call reads the project its working folder sits in, and this file sits
// in one, so each test starts outside any repository.
const startingFolder = process.cwd();
beforeEach(() => process.chdir(tmpdir()));
afterEach(async () => {
  process.chdir(startingFolder);
  vi.clearAllMocks();
  // A queued one-off failure must not reach the next test.
  vi.mocked(createLocalEmbedder).mockReset().mockImplementation(embedder as never);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const lines = () => Object.fromEntries(['chat', 'git-history', 'markdown'].map((kind) => [
  kind, { keywords: ['orchard', 'orchard trees'], answers: ['The orchard has trees.', 'Fruit trees grow here.'] },
]));
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

/** A chat folder, a notes folder and a small repository, each about an orchard. */
async function threeKinds(settings: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'curate-prepare-'));
  directories.push(directory);
  const at = (name: string) => join(directory, name);
  for (const name of ['home', 'claude', 'notes', 'repo', 'tmp']) await mkdir(at(name));
  const said = (session: string, days: number) => [
    JSON.stringify({ type: 'user', sessionId: session, timestamp: daysAgo(days), message: { content: `What grows in the orchard, ${session}?` } }),
    JSON.stringify({ type: 'assistant', sessionId: session, timestamp: daysAgo(days), message: { content: [{ type: 'text', text: 'Fruit trees grow in the orchard.' }] } }),
  ].join('\n');
  await writeFile(join(at('claude'), 'recent.jsonl'), said('recent', 2));
  await writeFile(join(at('notes'), 'orchard.md'), '# Orchard\n\nThe orchard has trees. Fruit trees grow here.\n');
  await writeFile(join(at('notes'), 'pond.md'), '# Pond\n\nThe pond has koi. Lilies grow here.\n');
  await writeFile(join(at('repo'), 'note.md'), 'orchard note\n');
  const git = (args: string[]) => execFileSync('git', ['-C', at('repo'), '-c', 'core.hooksPath=/dev/null',
    '-c', 'commit.gpgsign=false', '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { stdio: 'pipe' });
  git(['init', '-q', '-b', 'main']);
  git(['add', '-A']);
  git(['commit', '-qm', 'plant the orchard']);
  const sourcesFile = at('sources.json');
  await writeFile(sourcesFile, JSON.stringify({ sources: [{ type: 'claude-code', path: at('claude') },
    { type: 'markdown', path: at('notes') }, { type: 'git', path: at('repo') }], ...settings }));
  // One fixed clock reading, so two calls date and rank alike. Timers stay real.
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
  vi.stubEnv('HOME', at('home'));
  vi.stubEnv('TMPDIR', at('tmp'));
  vi.stubEnv('XDG_CACHE_HOME', at('cache'));
  vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => new Response(JSON.stringify({
    usage: null,
    answers: Object.fromEntries(Object.keys(JSON.parse(String(init.body)).questions).map((key) => [key, { noul: 0.8 }])),
  }))));
  return { sourcesFile, at };
}

type Call = (prompt: string, folder: string, label: string,
  record: { subscription: { label: string; attempt: number; code: number }[] }, save: () => Promise<void>) => Promise<string>;

/** A stand-in for the search-lines model: it runs `during` while its reply is "being written". */
function searchLinesCall(reply: unknown, during: () => Promise<void> = async () => {}): Call {
  return async (_prompt, folder, label, record, save) => {
    record.subscription.push({ label, attempt: 1, code: 0 });
    await during();
    writeFileSync(join(folder, `${label}-1.txt`), JSON.stringify(reply));
    await save();
    return JSON.stringify(reply);
  };
}

/** A record with elapsed times taken out, and its reads in a fixed order: reads of different sources finish in any order. */
function settled(record: Record<string, unknown>) {
  // `embedding` names the cache folder, which each compared call gets fresh.
  const { timings: _timings, embedding: _embedding, ...rest } = JSON.parse(JSON.stringify(record, (key, value) => key === 'ms' ? undefined : value));
  const order = (read: { source: string; task: string; lane?: string }) => `${read.source}|${read.task}|${read.lane ?? ''}`;
  return { ...rest, reads: [...rest.reads].sort((left, right) => order(left).localeCompare(order(right))) };
}

// The stored index files alone: their lock and write-ahead files come and go.
const indexFiles = (cache: string) => existsSync(join(cache, 'curate/index'))
  ? readdirSync(join(cache, 'curate/index')).filter((name) => name.endsWith('.sqlite')) : [];

describe('preparing the sources while the search lines are written', () => {
  it('loads the model and brings every source up to date before the search lines come back', async () => {
    const { sourcesFile, at } = await threeKinds();
    const seen = { model: 0, indexes: 0 };
    const call = searchLinesCall(lines(), async () => {
      // The reply waits long enough for the preparation to finish; nothing else can run it.
      for (let waited = 0; waited < 3_000 && (vi.mocked(createLocalEmbedder).mock.calls.length === 0 || indexFiles(at('cache')).length < 3); waited += 20) {
        await new Promise((done) => { setTimeout(done, 20); });
      }
      seen.model = vi.mocked(createLocalEmbedder).mock.calls.length;
      seen.indexes = indexFiles(at('cache')).length;
    });
    const { record } = await run(['--sources', sourcesFile, 'What grows in the orchard?'], call);
    expect(seen.model).toBe(1);
    expect(seen.indexes).toBe(3);
    expect(record.sourcesRead).toHaveLength(3);
    expect(vi.mocked(createLocalEmbedder)).toHaveBeenCalledTimes(1);
  });

  it('gives the same record and memory as a call that prepares nothing early', async () => {
    const { sourcesFile, at } = await threeKinds();
    const task = 'What grows in the orchard?';
    const late = await run(['--sources', sourcesFile, task], searchLinesCall(lines()), { prepare: false });
    vi.stubEnv('XDG_CACHE_HOME', at('cache-again'));
    const early = await run(['--sources', sourcesFile, task], searchLinesCall(lines()));
    expect(early.memory).toBe(late.memory);
    expect(late.memory).toContain('orchard');
    expect(settled(early.record)).toEqual(settled(late.record));
    // On a warm cache too.
    const warm = await run(['--sources', sourcesFile, task], searchLinesCall(lines()));
    expect(warm.memory).toBe(late.memory);
    const decided = (record: { pick: { candidates: { sourceId: string; id: string; status: string; probability?: number }[] } }) =>
      record.pick.candidates.map((entry) => [entry.sourceId, entry.id, entry.status, entry.probability]);
    expect(decided(warm.record)).toEqual(decided(late.record));
  });

  it('fails with the search-lines error alone, and leaves nothing behind, when the search lines fail', async () => {
    const { sourcesFile, at } = await threeKinds();
    vi.mocked(createLocalEmbedder).mockRejectedValueOnce(new Error('no model here'));
    const call: Call = async () => { throw new Error('the lines did not come'); };
    await expect(run(['--sources', sourcesFile, 'What grows in the orchard?'], call)).rejects.toThrow('the lines did not come');
    expect(await readdir(at('tmp'))).toEqual([]);
    expect(existsSync(join(at('home'), '.curate'))).toBe(false);
  });

  it('releases the model it loaded early when the search lines fail', async () => {
    const { sourcesFile } = await threeKinds();
    const call: Call = async () => {
      for (let waited = 0; waited < 3_000 && vi.mocked(createLocalEmbedder).mock.results.length === 0; waited += 20) {
        await new Promise((done) => { setTimeout(done, 20); });
      }
      throw new Error('the lines did not come');
    };
    await expect(run(['--sources', sourcesFile, 'What grows in the orchard?'], call)).rejects.toThrow('the lines did not come');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('raises a model failure where the call would have raised it, after the search lines', async () => {
    const { sourcesFile } = await threeKinds();
    vi.mocked(createLocalEmbedder).mockRejectedValueOnce(new Error('no model here'));
    const order: string[] = [];
    const call = searchLinesCall(lines(), async () => { order.push('lines'); });
    await expect(run(['--sources', sourcesFile, 'What grows in the orchard?'], call).catch((error: Error) => {
      order.push(error.message);
      throw error;
    })).rejects.toThrow('no model here');
    expect(order).toEqual(['lines', 'no model here']);
  });

  it('takes no parts from a source the scope leaves out, though it was prepared', async () => {
    const { sourcesFile } = await threeKinds();
    const call = searchLinesCall({ ...lines(), scope: { kinds: ['markdown'], since: 'none' } });
    const { record, memory } = await run(['--sources', sourcesFile, 'What do my notes say about the orchard?'], call);
    expect(record.scope).toMatchObject({ kinds: ['markdown'], since: 'none' });
    expect(record.sourcesRead.map((entry: { source: string }) => entry.source.split(':')[0])).toEqual(['knowledge-base']);
    expect(record.pick.candidates.every((entry: { sourceId: string }) => entry.sourceId.startsWith('knowledge-base:'))).toBe(true);
    expect(record.reads.every((entry: { source: string }) => entry.source.startsWith('knowledge-base:'))).toBe(true);
    expect(memory).toContain('orchard');
  });

  describe('with a Codex sessions folder, records on', () => {
    async function withCodex() {
      const { sourcesFile, at } = await threeKinds();
      const sessions = join(at('codex'), '2026', '01');
      await mkdir(sessions, { recursive: true });
      await writeFile(join(sessions, 'one.jsonl'), [
        JSON.stringify({ type: 'session_meta', payload: { id: 'session', cwd: at('repo') } }),
        JSON.stringify({ type: 'response_item', timestamp: daysAgo(3),
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'The orchard needs pruning.' }] } }),
      ].join('\n'));
      await writeFile(sourcesFile, JSON.stringify({ records: true, sources: [
        { type: 'codex', path: at('codex'), allowedCwd: at('repo') }, { type: 'markdown', path: at('notes') }] }));
      return { sourcesFile, at };
    }

    it('keeps the copy of the sessions it made early when the source is searched', async () => {
      const { sourcesFile } = await withCodex();
      const { record, folder } = await run(['--sources', sourcesFile, 'What grows in the orchard?'], searchLinesCall(lines()));
      expect(record.sessions).toHaveLength(1);
      expect(record.sessions[0].snapshot).toBe(join(folder, 'codex-1'));
      expect(readdirSync(folder)).toContain('codex-1');
      expect(record.sourcesRead).toHaveLength(2);
    });

    it('removes that copy, and records no session, when the scope leaves the source out', async () => {
      const { sourcesFile } = await withCodex();
      const call = searchLinesCall({ ...lines(), scope: { kinds: ['markdown'], since: 'none' } });
      const { record, folder } = await run(['--sources', sourcesFile, 'What do my notes say about the orchard?'], call);
      expect(record.sessions).toEqual([]);
      expect(readdirSync(folder).filter((name) => name.startsWith('codex-'))).toEqual([]);
      expect(record.sourcesRead).toHaveLength(1);
    });
  });

  it('reads with the window a scope sets, as a call that prepares nothing early does', async () => {
    const { sourcesFile, at } = await threeKinds();
    const reply = { ...lines(), scope: { kinds: ['chat'], since: '28 days' } };
    const task = 'What did we say about the orchard in a session last week?';
    const late = await run(['--sources', sourcesFile, task], searchLinesCall(reply), { prepare: false });
    vi.stubEnv('XDG_CACHE_HOME', at('cache-again'));
    const early = await run(['--sources', sourcesFile, task], searchLinesCall(reply));
    expect(settled(early.record)).toEqual(settled(late.record));
    expect(early.record.sourcesRead).toHaveLength(1);
  });
});
