import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cachedEmbeddings, type CandidateReadContext, type CandidateSource } from '@curatejs/core';
import { createLocalEmbedder } from '@curatejs/core/local-embeddings';
import { chat } from '@curatejs/chat';
import { git } from '@curatejs/git';
import { knowledgeBase } from '@curatejs/markdown';

// @ts-expect-error The standalone JavaScript command has no type declarations.
import { prepareReport, run } from '../skills/curate/run.mjs';

vi.mock('@curatejs/core/local-embeddings', () => ({ createLocalEmbedder: vi.fn() }));
// The mocked embedding model stands in for a model file, so a .gguf path counts as present.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn((path: string) => path.endsWith('.gguf') || actual.existsSync(path)) };
});

const directories: string[] = [];
// A call reads the project its working folder sits in, and this file sits
// in one, so each test starts outside any repository.
const startingFolder = process.cwd();
beforeEach(() => process.chdir(tmpdir()));
afterEach(async () => {
  process.chdir(startingFolder);
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
// The transcripts' default set asks the kind of task in the same call.
const lines = () => ({ ...Object.fromEntries(['chat', 'git-history', 'markdown'].map((kind) => [
  kind, { keywords: ['orchard', 'orchard trees'], answers: ['The orchard has trees.', 'Fruit trees grow here.'] },
])), wanted: 'one decision' });

type Call = (prompt: string, folder: string, label: string,
  record: { subscription: { label: string; attempt: number; code: number }[] }, save: () => Promise<void>) => Promise<string>;
const searchLinesCall = (reply: unknown): Call => async (_prompt, folder, label, record, save) => {
  record.subscription.push({ label, attempt: 1, code: 0 });
  writeFileSync(join(folder, `${label}-1.txt`), JSON.stringify(reply));
  await save();
  return JSON.stringify(reply);
};

/** A chat history of `messages` messages, each cut into eight parts, a
 *  folder of Codex sessions, a notes folder and a small repository, all
 *  about an orchard. */
async function history(messages: number, kinds: readonly string[] = ['claude-code', 'markdown', 'git'], settings: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'curate-prepare-progress-'));
  directories.push(directory);
  const at = (...names: string[]) => join(directory, ...names);
  for (const name of ['home', 'claude', 'codex', 'notes', 'repo', 'tmp']) await mkdir(at(name));
  // Eight lines of 600 characters: the reader cuts each message at its line ends into eight parts.
  const message = (index: number) => Array.from({ length: 8 }, (_, line) =>
    `Message ${index} line ${line}: the orchard ${'trees grow fruit and '.repeat(28)}`.slice(0, 600)).join('\n');
  await writeFile(at('claude', 'orchard.jsonl'), Array.from({ length: messages }, (_, index) => JSON.stringify(index % 2 === 0
    ? { type: 'user', sessionId: 'orchard', timestamp: daysAgo(3), message: { content: message(index) } }
    : { type: 'assistant', sessionId: 'orchard', timestamp: daysAgo(3), message: { content: [{ type: 'text', text: message(index) }] } }))
    .join('\n'));
  // Forty sessions of ten messages each, every message one part.
  for (let session = 0; session < 40; session += 1) {
    await writeFile(at('codex', `session-${session}.jsonl`), [
      JSON.stringify({ type: 'session_meta', payload: { id: `codex-${session}`, cwd: at('repo') } }),
      ...Array.from({ length: 10 }, (_, turn) => JSON.stringify({ type: 'response_item', timestamp: daysAgo(4),
        payload: { type: 'message', role: turn % 2 ? 'assistant' : 'user',
          content: [{ type: turn % 2 ? 'output_text' : 'input_text', text: `Codex ${session} turn ${turn}: the orchard needs pruning ${'and watering '.repeat(30)}` }] } })),
    ].join('\n'));
  }
  await writeFile(at('notes', 'orchard.md'), '# Orchard\n\nThe orchard has trees. Fruit trees grow here.\n');
  await writeFile(at('repo', 'note.md'), 'orchard note\n');
  const gitIn = (args: string[]) => execFileSync('git', ['-C', at('repo'), '-c', 'core.hooksPath=/dev/null',
    '-c', 'commit.gpgsign=false', '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { stdio: 'pipe' });
  gitIn(['init', '-q', '-b', 'main']);
  gitIn(['add', '-A']);
  gitIn(['commit', '-qm', 'plant the orchard']);
  const sources = { 'claude-code': { type: 'claude-code', path: at('claude') }, markdown: { type: 'markdown', path: at('notes') },
    git: { type: 'git', path: at('repo') }, codex: { type: 'codex', path: at('codex'), allowedCwd: at('repo') } } as Record<string, unknown>;
  const sourcesFile = at('sources.json');
  await writeFile(sourcesFile, JSON.stringify({ sources: kinds.map((kind) => sources[kind]), ...settings }));
  // The clock runs, and each batch the stand-in model embeds moves it on a second more.
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now(), shouldAdvanceTime: true });
  vi.stubEnv('HOME', at('home'));
  vi.stubEnv('TMPDIR', at('tmp'));
  vi.stubEnv('XDG_CACHE_HOME', at('cache'));
  vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
  // The first decision request of each read rates its parts high and every
  // later one low, so the rating stop ends the ranked read early, and the chat
  // read, which reads the transcripts at the same time, ends on its own stop.
  const requests = { chat: 0, ranked: 0 };
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    const read = /(claude-code|codex):/.test(String(init.body)) ? 'chat' : 'ranked';
    const noul = requests[read]++ === 0 ? 0.8 : 0.01;
    return new Response(JSON.stringify({ usage: null,
      answers: Object.fromEntries(Object.keys(JSON.parse(String(init.body)).questions).map((key) => [key, { noul }])) }));
  }));
  // The stand-in model behind the real vector store: it counts each text it embeds.
  const embedded: string[] = [];
  const model = async (texts: readonly string[]) => {
    embedded.push(...texts);
    vi.setSystemTime(Date.now() + 1000);
    return texts.map((text) => /orchard|fruit|tree/i.test(text) ? [1, 0.1] : [0.1, 1]);
  };
  const store = cachedEmbeddings(model, { directory: at('cache', 'vectors'), modelId: 'stand-in' });
  vi.mocked(createLocalEmbedder).mockImplementation((async () => ({ embed: store, dispose: async () => {} })) as never);
  return { sourcesFile, at, embedded };
}

/** One call, with what it printed on each stream. */
async function call(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => { out.push(String(line)); });
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => { err.push(String(line)); });
  try {
    return { ...await run(args, searchLinesCall(lines())), out, err };
  } finally {
    vi.mocked(console.log).mockRestore();
    vi.mocked(console.error).mockRestore();
  }
}

const progress = (line: string) => /^(Embedding|Embedded|Building the stored index|Built the stored index|Indexed)/.test(line);
const TASK = 'What grows in the orchard?';

// Each call reads, indexes and embeds a few thousand parts: more than the default five seconds on a busy machine.
describe('a call that has slow preparing to do', { timeout: 60_000 }, () => {
  it('says on standard error what it embeds, how far it has got and when it ends, and prints only the text on standard output', async () => {
    const { sourcesFile, at } = await history(320, ['claude-code']);
    const { out, err, memory } = await call(['--sources', sourcesFile, TASK]);
    expect(out).toEqual([memory]);
    const said = err.filter(progress);
    const name = `the Claude Code chats in ${at('claude')}`;
    expect(said[0]).toMatch(new RegExp(`^Embedding 2,5\\d\\d parts of ${name} that have no stored vector yet\\. `
      + 'Each part is embedded once; later calls reuse its vector\\.$'));
    const steps = said.slice(1, -1);
    expect(steps.length).toBeGreaterThan(2);
    for (const line of steps) expect(line).toMatch(new RegExp(`^Embedded [\\d,]+ of 2,5\\d\\d parts of ${name}, about \\d+ (seconds|minutes?) left\\.$`));
    expect(said.at(-1)).toMatch(new RegExp(`^Embedded 2,5\\d\\d parts of ${name} in \\d+ (seconds|minutes)\\.$`));
    // The clock moves a second a batch, so ten seconds pass between two progress lines.
    expect(steps.length).toBeLessThanOrEqual(Math.ceil(2600 / 32 / 10));
  });

  it('records the time it waited on preparing, and per source what it indexed and embedded', async () => {
    const { sourcesFile, at, embedded } = await history(320);
    const first = await call(['--sources', sourcesFile, TASK]);
    const timings = first.record.timings;
    expect(timings.prepareMs).toBeGreaterThan(60_000);
    // Each step's time is its own: together they come to the call's whole time.
    const steps = timings.searchesMs + timings.filterMs + timings.embeddingLoadMs + timings.prepareMs + timings.rankAndDecideMs + timings.curateMs;
    expect(timings.totalMs - steps).toBeGreaterThanOrEqual(0);
    expect(timings.totalMs - steps).toBeLessThan(2000);
    const chats = `chat:claude-code:${at('claude')}`;
    expect(first.record.prepared.map((entry: { source: string }) => entry.source).sort())
      .toEqual([chats, `git:${at('repo')}`, `knowledge-base:${at('notes')}`].sort());
    const prepared = Object.fromEntries(first.record.prepared.map((entry: { source: string }) => [entry.source, entry]));
    expect(prepared[chats]).toMatchObject({ firstIndex: true, embedded: expect.any(Number), index: { parts: 2560, added: 2560 } });
    // Every text the model embedded is counted under the source that asked for it, the task and search lines included.
    expect(first.record.prepared.reduce((sum: number, entry: { embedded: number }) => sum + entry.embedded, 0)).toBe(embedded.length);
    expect(prepared[chats].embedded).toBeGreaterThan(2500);
    expect(prepared[chats].embedMs).toBeGreaterThan(60_000);
    expect(prepared[`git:${at('repo')}`]).toMatchObject({ firstIndex: true, index: { parts: 1 } });

    const second = await call(['--sources', sourcesFile, TASK]);
    for (const entry of second.record.prepared) expect(entry).toMatchObject({ firstIndex: false, embedded: 0 });
    expect(second.record.timings.prepareMs).toBeLessThan(60_000);
  });

  it('embeds nothing on a second call over the same sources, and says nothing', async () => {
    const { sourcesFile, embedded } = await history(320);
    await call(['--sources', sourcesFile, TASK]);
    const before = embedded.length;
    const second = await call(['--sources', sourcesFile, TASK]);
    expect(embedded.length - before).toBe(0);
    expect(second.err.filter(progress)).toEqual([]);
    expect(second.out).toEqual([second.memory]);
  });

  it('says nothing on a first call over a small history', async () => {
    const { sourcesFile } = await history(40);
    const { err, out, memory } = await call(['--sources', sourcesFile, TASK]);
    expect(err.filter(progress)).toEqual([]);
    expect(out).toEqual([memory]);
  });

  it('says the same on standard error for prepare, and prints only its own line on standard output', async () => {
    const { sourcesFile, at } = await history(320, ['claude-code']);
    const { out, err, record } = await call(['--sources', sourcesFile, '--prepare']);
    expect(out).toEqual(['Prepared 1 source.']);
    expect(err.filter(progress)[0]).toMatch(/^Embedding 2,5\d\d parts of /);
    expect(err.filter(progress).at(-1)).toMatch(/^Embedded 2,5\d\d parts of .* in \d+ (seconds|minutes)\.$/);
    expect(record.timings.prepareMs).toBeGreaterThan(60_000);
    expect(record.prepared).toEqual([expect.objectContaining({ source: `chat:claude-code:${at('claude')}`, firstIndex: true })]);
  });
});

describe('what standard error says while preparing', () => {
  const clock = () => {
    let now = 0;
    return { now: () => now, at: (ms: number) => { now = ms; } };
  };
  const labels = new Map([['chat:one', "this project's Claude Code chats"]]);

  it('says nothing of an embedding of 2,000 parts or fewer, and still counts it', () => {
    const time = clock();
    const said: string[] = [];
    const report = prepareReport(labels, (line: string) => said.push(line), time.now);
    report.embedded('chat:one', 0, 2000);
    time.at(60_000);
    report.embedded('chat:one', 2000, 2000);
    expect(said).toEqual([]);
    expect(report.entry('chat:one')).toEqual({ source: 'chat:one', firstIndex: false, embedded: 2000, embedMs: 60_000 });
  });

  it('says why a larger one starts, how far it has got at most every ten seconds, and when it ends', () => {
    const time = clock();
    const said: string[] = [];
    const report = prepareReport(labels, (line: string) => said.push(line), time.now);
    report.embedded('chat:one', 0, 41_000);
    for (let done = 32; done < 41_000; done += 32) {
      time.at(done * 20);
      report.embedded('chat:one', done, 41_000);
    }
    time.at(820_000);
    report.embedded('chat:one', 41_000, 41_000);
    expect(said[0]).toBe("Embedding 41,000 parts of this project's Claude Code chats that have no stored vector yet. Each part is embedded once; later calls reuse its vector.");
    expect(said[1]).toBe("Embedded 512 of 41,000 parts of this project's Claude Code chats, about 13 minutes left.");
    expect(said.at(-2)).toBe("Embedded 40,960 of 41,000 parts of this project's Claude Code chats, about 1 second left.");
    expect(said.at(-1)).toBe("Embedded 41,000 parts of this project's Claude Code chats in 14 minutes.");
    expect(said).toHaveLength(2 + 80);
  });

  it('says a stored index is being built from nothing only once it has taken five seconds, and then when it ends', () => {
    const time = clock();
    const said: string[] = [];
    const report = prepareReport(labels, (line: string) => said.push(line), time.now);
    report.index('chat:one', 0, 3, 'transcripts');
    time.at(1000);
    report.index('chat:one', 3, 3, 'transcripts');
    expect(said).toEqual([]);
    expect(report.entry('chat:one').firstIndex).toBe(true);

    report.index('chat:one', 0, 1200, 'transcripts');
    for (let done = 1; done <= 1200; done += 1) {
      time.at(1000 + done * 150);
      report.index('chat:one', done, 1200, 'transcripts');
    }
    expect(said[0]).toBe("Building the stored index of this project's Claude Code chats from scratch: 34 of 1,200 transcripts read, about 3 minutes left. "
      + "This happens on a source's first call, and again when an update or a change to the source's settings starts a new index.");
    expect(said[1]).toBe("Indexed 101 of 1,200 transcripts of this project's Claude Code chats, about 3 minutes left.");
    expect(said.at(-1)).toBe("Built the stored index of this project's Claude Code chats in 3 minutes: 1,200 transcripts read.");
  });

  it('says one start line when another call stores some parts first, and counts only what this call embedded', () => {
    const time = clock();
    const said: string[] = [];
    const report = prepareReport(labels, (line: string) => said.push(line), time.now);
    report.embedded('chat:one', 0, 5000);
    // A batch another call had already stored: nothing embedded, one fewer batch to do.
    report.embedded('chat:one', 0, 4968);
    time.at(1000);
    report.embedded('chat:one', 32, 4968);
    // The other call stored the far half.
    time.at(80_000);
    report.embedded('chat:one', 2500, 2500);
    expect(said).toEqual([
      "Embedding 5,000 parts of this project's Claude Code chats that have no stored vector yet. Each part is embedded once; later calls reuse its vector.",
      "Embedded 2,500 parts of this project's Claude Code chats in 80 seconds.",
    ]);
    expect(report.entry('chat:one')).toMatchObject({ embedded: 2500, embedMs: 80_000 });
  });

  it('names a source it has no name for by its id', () => {
    const said: string[] = [];
    const report = prepareReport(new Map(), (line: string) => said.push(line), () => 0);
    report.embedded('git:/somewhere', 0, 5000);
    expect(said[0]).toMatch(/^Embedding 5,000 parts of git:\/somewhere that/);
  });
});

describe('a reader building its stored index from nothing', () => {
  async function sources() {
    const directory = await mkdtemp(join(tmpdir(), 'curate-first-index-'));
    directories.push(directory);
    const at = (...names: string[]) => join(directory, ...names);
    for (const name of ['claude', 'notes', 'repo']) await mkdir(at(name));
    for (const session of ['one', 'two', 'three']) {
      await writeFile(at('claude', `${session}.jsonl`), JSON.stringify({ type: 'user', sessionId: session, timestamp: daysAgo(1),
        message: { content: `The orchard in session ${session}.` } }));
    }
    await writeFile(at('notes', 'a.md'), '# A\n\nThe orchard.\n');
    await writeFile(at('notes', 'b.md'), '# B\n\nThe pond.\n');
    await writeFile(at('repo', 'note.md'), 'orchard\n');
    const gitIn = (args: string[]) => execFileSync('git', ['-C', at('repo'), '-c', 'core.hooksPath=/dev/null',
      '-c', 'commit.gpgsign=false', '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { stdio: 'pipe' });
    gitIn(['init', '-q', '-b', 'main']);
    gitIn(['add', '-A']);
    gitIn(['commit', '-qm', 'plant the orchard']);
    writeFileSync(at('repo', 'note.md'), 'orchard and pond\n');
    gitIn(['commit', '-qam', 'dig the pond']);
    const index = { directory: at('index') };
    return {
      chats: chat({ id: 'chat:fixture', providers: ['claude-code'], paths: [at('claude')], index }),
      notes: knowledgeBase(at('notes'), { index }),
      commits: git(at('repo'), { index }),
    };
  }
  const read = async (source: CandidateSource) => {
    const events: [string, number, number, string][] = [];
    const context: CandidateReadContext = { files: new Map(), shared: new Map(),
      onFirstIndex: (id, done, total, unit) => { events.push([id, done, total, unit]); } };
    const result = await source.read({ task: 'orchard' }, context);
    expect(result.status).toBe('read');
    return events;
  };

  it('tells the read context how far it has got, from nothing to every item, and says nothing once the index holds them', async () => {
    const { chats, notes, commits } = await sources();
    expect(await read(chats)).toEqual([0, 1, 2, 3].map((done) => ['chat:fixture', done, 3, 'transcripts']));
    expect(await read(notes)).toEqual([0, 1, 2].map((done) => [notes.id, done, 2, 'files']));
    expect(await read(commits)).toEqual([0, 2].map((done) => [commits.id, done, 2, 'commits']));
    for (const source of [chats, notes, commits]) expect(await read(source)).toEqual([]);
  });
});

/** Every file under `folder`, by its path inside it, with its text. */
async function filesUnder(folder: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (path: string) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(join(path, entry.name));
      else files.set(relative(folder, join(path, entry.name)), await readFile(join(path, entry.name), 'utf8'));
    }
  };
  await walk(folder);
  return files;
}

// Every part of the fixture's chats and sessions starts with its own mark.
const MARKS = [
  ...Array.from({ length: 320 }, (_, index) => Array.from({ length: 8 }, (_, line) => `Message ${index} line ${line}:`)).flat(),
  ...Array.from({ length: 40 }, (_, session) => Array.from({ length: 10 }, (_, turn) => `Codex ${session} turn ${turn}:`)).flat(),
];
const KINDS = ['claude-code', 'codex', 'markdown', 'git'];

describe('a saved record', { timeout: 60_000 }, () => {
  it('holds what explains the call, never the text of a part the call did not keep, and no copy of the sessions', async () => {
    const { sourcesFile, at } = await history(320, KINDS, { records: true });
    const { folder, record } = await call(['--sources', sourcesFile, TASK]);
    const files = await filesUnder(folder);
    expect([...files.keys()].filter((name) => !/^(read-\d+\.json|record\.json|selection\.json|log\.md|kept\.json|searches-1\.(txt|jsonl|stderr))$/.test(name))).toEqual([]);
    expect(await readdir(at('tmp'))).toEqual([]);

    const kept: { sourceId: string; id: string; text: string }[] = JSON.parse(files.get('selection.json')!).selected;
    const keptText = kept.map((part) => part.text).join('\n');
    const unkept = MARKS.filter((mark) => !keptText.includes(mark));
    expect(unkept.length).toBeGreaterThan(2500);
    const saved = [...files.values()].join('\n');
    expect(unkept.filter((mark) => saved.includes(mark))).toEqual([]);

    // Each read file is the read's report: how many parts it returned, never the parts.
    for (const entry of record.reads) {
      const read = JSON.parse(files.get(entry.file)!);
      expect(read.status).toBe(entry.status);
      expect(read.candidates).toBeUndefined();
      expect(read.meaningScores).toBeUndefined();
      expect(read.poolIds).toBeUndefined();
    }
    // Each part the pick ranked is in the record once, with its id, source,
    // ranks, scores and status, and the kept ones are the selected ones.
    const ranked: { sourceId: string; id: string; status: string; searchRanks?: unknown[]; signals: object }[] = record.pick.candidates;
    expect(ranked.filter((part) => part.status === 'selected').map((part) => `${part.sourceId}\0${part.id}`).sort())
      .toEqual(kept.map((part) => `${part.sourceId}\0${part.id}`).sort());
    expect(ranked.every((part) => typeof part.signals === 'object' && Array.isArray(part.searchRanks))).toBe(true);
    // The parts the rating stop left unread keep only their id and their
    // place in the fused order: per source, in that order, with a count.
    expect(ranked.some((part) => part.status === 'unassessed' && (part as { reason?: string }).reason === 'stopWhenCold')).toBe(false);
    // A chat read's unread parts are kept the same way.
    expect(ranked.some((part) => part.status === 'unassessed' && (part as { reason?: string }).reason === 'chatRead')).toBe(false);
    const unread: Record<string, { count: number; prefix: string; ids: string[]; places: number[] }> = record.pick.unread;
    const unreadCount = Object.values(unread).reduce((sum, list) => sum + list.count, 0);
    expect(unreadCount).toBe(record.pick.pick.stopWhenCold.unread
      + Object.values(record.pick.pick.chatRead ?? {}).reduce((sum: number, read) => sum + (read as { unread: number }).unread, 0));
    expect(unreadCount).toBeGreaterThan(2500);
    const places = Object.values(unread).flatMap((list) => {
      expect(list.ids).toHaveLength(list.count);
      expect(list.places).toEqual([...list.places].sort((one, other) => one - other));
      return list.places;
    });
    expect(new Set(places).size).toBe(unreadCount);
    const chats = `chat:claude-code:${at('claude')}`;
    expect(unread[chats]!.ids.every((id) => `${unread[chats]!.prefix}${id}`.startsWith('claude-code:'))).toBe(true);

    // What that costs: the kept text four times (log.md, kept.json,
    // selection.json and the layout's record in record.json), at most 2 KB for each part
    // listed in full (its entry in record.json and, for a kept part, its
    // metadata in selection.json and the layout's record; the ids here
    // name long temporary folders), at most 40 bytes for each unread part
    // (the end of its id and its place, each on a line of its own), at
    // most 2 KB for each read's report, and 150 KB for the rest (settings,
    // question sets, decision requests).
    const size = [...files.values()].reduce((sum, text) => sum + Buffer.byteLength(text), 0);
    process.stdout.write(`RECORD-SIZE ${size} bytes (record.json ${Buffer.byteLength(files.get('record.json')!)}): ${ranked.length} parts in full, ${unreadCount} unread, ${record.reads.length} reads, ${Buffer.byteLength(keptText)} bytes of kept text\n`);
    expect(size).toBeLessThan(4 * Buffer.byteLength(keptText) + 2000 * ranked.length + 40 * unreadCount + 2000 * record.reads.length + 150_000);
  });

  it('removes its copy of the Codex sessions when a call that keeps its record fails', async () => {
    const { sourcesFile, at } = await history(40, ['codex', 'markdown'], { records: true });
    const codexIndexed = () => existsSync(join(at('cache'), 'curate/index'))
      && readdirSync(join(at('cache'), 'curate/index')).some((name) => name.startsWith('chat-codex'));
    // The search lines fail once the sessions are copied and being read.
    const failing: Call = async () => {
      for (let waited = 0; waited < 5000 && !codexIndexed(); waited += 20) await new Promise((done) => { setTimeout(done, 20); });
      throw new Error('the lines did not come');
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(run(['--sources', sourcesFile, TASK], failing)).rejects.toThrow('the lines did not come');
    expect(codexIndexed()).toBe(true);
    const [kept] = await readdir(at('home', '.curate', 'runs'));
    const folder = at('home', '.curate', 'runs', kept!);
    expect(JSON.parse(await readFile(join(folder, 'record.json'), 'utf8')).status).toBe('failed');
    expect((await readdir(folder)).filter((name) => name.startsWith('codex-'))).toEqual([]);
    expect(await readdir(at('tmp'))).toEqual([]);
  });
});
