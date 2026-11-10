import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error The standalone JavaScript command has no type declarations.
import { parseSources, run, sandboxAvailable } from '../skills/curate/run.mjs';

vi.mock('@curatejs/core/local-embeddings', () => ({
  createLocalEmbedder: vi.fn(async () => ({
    embed: async (texts: readonly string[]) => texts.map((text) => /orchard|fruit|tree/i.test(text) ? [1, 0] : [0, 1]),
    dispose: vi.fn(async () => {}),
  })),
}));
// The notes folder stands in for a source whose parts carry no date, the
// case the curator's collection-date wording exists for.
vi.mock('@curatejs/markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@curatejs/markdown')>();
  return { ...actual, knowledgeBase: (path: string, options: Parameters<typeof actual.knowledgeBase>[1]) => {
    const source = actual.knowledgeBase(path, options);
    if (basename(path) !== 'notes') return source;
    return { ...source, read: async (request: Parameters<typeof source.read>[0], context: Parameters<typeof source.read>[1]) => {
      const read = await source.read(request, context);
      return read.status !== 'read' ? read : { ...read, candidates: read.candidates.map(({ date: _date, ...candidate }) => candidate) };
    } };
  } };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const realSpawn = vi.mocked(spawn).getMockImplementation()!;
const startingFolder = process.cwd();
const roots: string[] = [];
afterEach(async () => {
  process.chdir(startingFolder);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(spawn).mockImplementation(realSpawn);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// A minute before midnight UTC, in a zone where the local date is already
// the next day: a collection date taken from local time would differ.
const NOW = '2026-03-04T23:59:30.000Z';
const ZONE = 'Pacific/Auckland';
const SENTENCE = 'Fruit trees grow here.';
const OLD = new Date('2026-01-02T10:00:00Z');

const searchLines = { keywords: ['orchard', 'orchard trees'], answers: ['The orchard has trees.', SENTENCE] };
const allSearches = { chat: searchLines, 'git-history': searchLines, markdown: searchLines };

type Settings = { records?: boolean; readAudit?: boolean; compression?: 'high' | 'low' };
type Fixture = Awaited<ReturnType<typeof makeFixture>>;
type Child = { command: string; args: string[]; env: NodeJS.ProcessEnv; folderDuring: string[]; label: string };

function gitIn(repo: string, ...args: string[]) {
  execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T12:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T12:00:00Z' },
  });
}

async function makeFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'curate-no-trace-')));
  roots.push(root);
  const at = (...parts: string[]) => join(root, ...parts);
  for (const name of ['home', 'codex-home', 'tmp', 'cwd', 'notes', 'wiki', 'repo', 'transcripts', 'sessions']) await mkdir(at(name));
  await writeFile(at('codex-home', 'AGENTS.md'), 'Global instructions.\n');
  await writeFile(at('cwd', 'keep.txt'), 'kept\n');
  await writeFile(at('notes', 'orchard.md'), `# Orchard\n\nThe orchard has trees. ${SENTENCE}\n`);
  await utimes(at('notes', 'orchard.md'), OLD, OLD);

  // A tracked file whose modification time no longer matches the index:
  // an ordinary `git status` rewrites the index to record the new time.
  await writeFile(at('wiki', 'grove.md'), `# Grove\n\nThe orchard grove has trees. ${SENTENCE}\n`);
  gitIn(at('wiki'), 'init', '-q', '-b', 'main');
  gitIn(at('wiki'), 'add', 'grove.md');
  gitIn(at('wiki'), 'commit', '-q', '-m', 'add the grove');
  await utimes(at('wiki', 'grove.md'), OLD, OLD);

  await writeFile(at('repo', 'orchard.ts'), 'export const orchard = 1;\n');
  gitIn(at('repo'), 'init', '-q', '-b', 'main');
  gitIn(at('repo'), 'add', 'orchard.ts');
  gitIn(at('repo'), 'commit', '-q', '-m', `plant the orchard. ${SENTENCE}`);

  await writeFile(at('transcripts', 'session.jsonl'), [
    JSON.stringify({ type: 'user', sessionId: 's1', timestamp: '2026-01-01T12:00:00Z', message: { content: `What grows in the orchard? ${SENTENCE}` } }),
    JSON.stringify({ type: 'assistant', sessionId: 's1', timestamp: '2026-01-01T12:01:00Z', message: { content: [{ type: 'text', text: `Orchard answer. ${SENTENCE}` }] } }),
  ].join('\n'));
  await writeFile(at('sessions', 'open.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { id: 'session', cwd: at('cwd') } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-01-01T12:00:00Z',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Codex orchard. ${SENTENCE}` }] } }),
  ].join('\n'));
  await utimes(at('sessions', 'open.jsonl'), OLD, OLD);

  return { root, at, sourcesFile: at('sources.json'), sources: [
    { type: 'markdown', path: at('notes') },
    { type: 'markdown', path: at('wiki') },
    { type: 'git', path: at('repo') },
    { type: 'claude-code', path: at('transcripts') },
    { type: 'codex', path: at('sessions'), allowedCwd: at('cwd') },
  ] };
}

// Every path under the root except the cache folder, with a hash of each
// file's bytes, so a created, changed or deleted path all show.
async function inventory(fixture: Fixture) {
  const found = new Map<string, { hash: string; size: number }>();
  const walk = async (path: string) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (file === fixture.at('cache')) continue;
      const name = relative(fixture.root, file);
      if (entry.isDirectory()) {
        found.set(`${name}/`, { hash: 'folder', size: 0 });
        await walk(file);
      } else {
        const bytes = entry.isFile() ? await readFile(file) : Buffer.from(String((await lstat(file)).mode));
        found.set(name, { hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
      }
    }
  };
  await walk(fixture.root);
  return found;
}

function changes(before: Map<string, { hash: string; size: number }>, after: Map<string, { hash: string; size: number }>) {
  const created = [...after.keys()].filter((name) => !before.has(name));
  const changed = [...after.keys()].filter((name) => before.has(name) && before.get(name)!.hash !== after.get(name)!.hash);
  const deleted = [...before.keys()].filter((name) => !after.has(name));
  const files = [...created, ...changed].filter((name) => !name.endsWith('/'));
  return { created, changed, deleted, files: files.length, bytes: files.reduce((sum, name) => sum + after.get(name)!.size, 0) };
}

// What a model would reply, computed from the prompt alone.
function standInReply(label: string, prompt: string) {
  if (label === 'searches') return JSON.stringify(allSearches);
  const items = [...prompt.matchAll(/^### (\S+) \(/gm)].map((match) => match[1]!);
  if (label === 'extract') {
    return JSON.stringify({ rows: items.map((item) => ({ who: 'you', what: 'grew fruit trees', status: 'done', date: '',
      said: '2026-01-01', amount: '', quantity: '', source: [item], quote: SENTENCE })) });
  }
  if (label === 'markup') {
    const sections = prompt.split(/^### /m).slice(1);
    return sections.map((section) => {
      const sentence = /^\[(\d+)\] .*Fruit trees grow here\.$/m.exec(section)?.[1];
      return `${section.split(' ')[0]}\nS${sentence} event(who=you,status=done)="${SENTENCE}"`;
    }).join('\n');
  }
  return items.map((item) => `[2026-01-01] Evidence ${item} (said 2026-01-01; ${item})`).join('\n');
}

type Fail = { label: string; malformed?: boolean };

function standInCodex(fail?: Fail) {
  const children: Child[] = [];
  const prompts: { label: string; prompt: string }[] = [];
  vi.mocked(spawn).mockImplementation(((command: string, argv: string[], options: { env: NodeJS.ProcessEnv }) => {
    const args = argv.slice(argv.indexOf('exec'));
    const output = args[args.indexOf('-o') + 1]!;
    const label = basename(output).replace(/-\d+\.txt$/, '');
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter; stderr: EventEmitter; kill: () => void; stdin: { on: () => void; end: (text: string) => void };
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = { on: () => {}, end: (text: string) => {
      prompts.push({ label, prompt: text });
      void readdir(args[args.indexOf('-C') + 1]!).then((folderDuring) => {
        children.push({ command, args: [...argv], env: { ...options.env }, folderDuring, label });
        if (fail?.malformed && fail.label === label) {
          writeFileSync(output, 'not JSON');
          child.emit('close', 0);
          return;
        }
        if (fail?.label === label) {
          child.stderr.emit('data', 'route down for the test');
          child.emit('close', 1);
          return;
        }
        writeFileSync(output, standInReply(label, text));
        child.stdout.emit('data', `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })}\n`);
        child.stderr.emit('data', 'stand-in codex\n');
        child.emit('close', 0);
      });
    } };
    return child;
  }) as unknown as typeof spawn);
  return { children, prompts };
}

async function call(fixture: Fixture, settings: Settings, fail?: Fail) {
  await writeFile(fixture.sourcesFile, JSON.stringify({ sources: fixture.sources, searchModel: 'sol', ...settings }));
  vi.stubEnv('HOME', fixture.at('home'));
  vi.stubEnv('CODEX_HOME', fixture.at('codex-home'));
  vi.stubEnv('TMPDIR', fixture.at('tmp'));
  vi.stubEnv('XDG_CACHE_HOME', fixture.at('cache'));
  vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  vi.stubEnv('TZ', ZONE);
  process.chdir(fixture.at('cwd'));
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    requests.push(String(init.body));
    return Response.json({ usage: null, answers: Object.fromEntries(
      Object.keys(JSON.parse(String(init.body)).questions).map((key) => [key, { noul: 0.8 }])) });
  }));
  const { children, prompts } = standInCodex(fail);
  const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warned = vi.spyOn(console, 'error').mockImplementation(() => {});
  const before = await inventory(fixture);
  const outcome = await run(['--sources', fixture.sourcesFile, 'orchard']).then(
    (value: unknown) => ({ value, error: undefined }), (error: Error) => ({ value: undefined, error }));
  const after = await inventory(fixture);
  return { outcome, requests, children, prompts, printed: printed.mock.calls.map(([line]) => String(line)),
    warnings: warned.mock.calls.map(([line]) => String(line)), delta: changes(before, after) };
}

type Done = Awaited<ReturnType<typeof call>>;

const READ_FILE = /^read-\d+\.json$/;

// Key paths of a JSON value, one entry per distinct path.
function keyPaths(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => keyPaths(item, `${path}[]`));
  if (value === null || typeof value !== 'object') return [path];
  return Object.entries(value).flatMap(([key, item]) => keyPaths(item, `${path}.${key}`));
}

async function fileShape(folder: string, fixture: Fixture) {
  const names: string[] = [];
  const walk = async (path: string) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(join(path, entry.name));
      else names.push(relative(folder, join(path, entry.name)));
    }
  };
  await walk(folder);
  // Reads run at once, so which read takes which number varies. Every read
  // file is compared as one entry: how many there are and their keys.
  const reads = names.filter((name) => READ_FILE.test(name));
  const shape: Record<string, string[] | number | 'file'> = {};
  if (reads.length) shape['read files'] = reads.length;
  const keys = async (name: string) => keyPaths(JSON.parse(await readFile(join(folder, name), 'utf8')))
    .map((path) => path.replaceAll(fixture.root, '<root>'));
  if (reads.length) shape['read file keys'] = [...new Set((await Promise.all(reads.map(keys))).flat())].sort();
  for (const name of names.filter((entry) => !READ_FILE.test(entry)).sort()) {
    shape[name] = name.endsWith('.json') ? [...new Set(await keys(name))].sort() : 'file';
  }
  return shape;
}

// The evidence a call produced, with the only permitted difference (where
// its files are) normalised: everything a model or a reader would see.
function observed(done: Done, record: { reads: { source: string }[]; pick: { candidates: { id: string; status: string }[] } }, fixture: Fixture) {
  const folderOf = (child: Child) => child.args[child.args.indexOf('-C') + 1]!;
  const place = (text: string, folder: string) => text.replaceAll(folder, '<folder>').replaceAll(fixture.root, '<root>');
  const folder = done.children.length ? folderOf(done.children[0]!) : '';
  const readCounts: Record<string, number> = {};
  for (const read of record.reads) {
    const source = place(read.source, folder);
    readCounts[source] = (readCounts[source] ?? 0) + 1;
  }
  return {
    prompts: done.prompts.map(({ label, prompt }) => `${label}\n${place(prompt, folder)}`).sort(),
    decisionRequests: done.requests.map((request) => place(request, folder)).sort(),
    readCounts: Object.fromEntries(Object.entries(readCounts).sort(([a], [b]) => a.localeCompare(b))),
    selected: record.pick.candidates.filter((entry) => entry.status === 'selected').map((entry) => place(entry.id, folder)).sort(),
    memory: done.printed.map((line) => place(line, folder)),
    childArgs: done.children.map((child) => child.args.slice(child.args.indexOf('exec')).map((arg) => place(arg, folder))).sort(),
  };
}

const TEMPORARY = /^(log_dir|sqlite_home)=|^features\.plugins=false$/;
const withoutTemporarySettings = (args: string[]) => args.filter((arg, index) => !TEMPORARY.test(arg) && !TEMPORARY.test(args[index + 1] ?? ''));

const basePath = (compression: string) => join(__dirname, 'fixtures', `no-trace-base-${compression}.json`);
const compressions = ['high', 'low'] as const;

describe('the base a records-on call must match', () => {
  it.each(compressions)('records on, read files on, %s compression matches today\'s call', async (compression) => {
    const fixture = await makeFixture();
    const done = await call(fixture, { records: true, readAudit: true, compression });
    expect(done.outcome.error).toBeUndefined();
    const folder = (done.outcome.value as { folder: string }).folder;
    const record = JSON.parse(await readFile(join(folder, 'record.json'), 'utf8'));
    console.info(`indicator ${compression} records on: files=${done.delta.files} bytes=${done.delta.bytes}`);
    const facts = { observed: observed(done, record, fixture), files: await fileShape(folder, fixture) };
    vi.useRealTimers();
    expect(facts.observed.prompts.some((prompt) => prompt.includes('UNDATED SOURCE collected 2026-03-04'))).toBe(true);
    await expect(`${JSON.stringify(facts, null, 1)}\n`).toMatchFileSnapshot(basePath(compression));
  });
});

async function base(compression: string) {
  return JSON.parse(await readFile(basePath(compression), 'utf8')) as {
    observed: Record<string, unknown>; files: Record<string, unknown>;
  };
}

describe('a records-off call', () => {
  it.each([
    ['high', undefined], ['high', true], ['high', false], ['low', undefined], ['low', true], ['low', false],
  ] as const)('%s compression, readAudit %s: curates the same and leaves nothing', async (compression, readAudit) => {
    const fixture = await makeFixture();
    const done = await call(fixture, { compression, ...(readAudit === undefined ? {} : { readAudit }) });
    expect(done.outcome.error).toBeUndefined();
    const result = done.outcome.value as { memory: string; record: Parameters<typeof observed>[1]; folder: string | null };
    expect(result.folder).toBeNull();
    expect(done.printed).toEqual([result.memory]);
    expect(done.warnings).toEqual([]);

    const facts = observed(done, result.record, fixture);
    const expected = (await base(compression)).observed;
    expect({ ...facts, childArgs: facts.childArgs.map(withoutTemporarySettings) }).toEqual(expected);

    console.info(`indicator ${compression} records off, readAudit ${readAudit}: files=${done.delta.files} bytes=${done.delta.bytes}`);
    expect(done.delta).toEqual({ created: [], changed: [], deleted: [], files: 0, bytes: 0 });
    expect(await readdir(fixture.at('tmp'))).toEqual([]);
    expect(existsSync(fixture.at('home', '.curate'))).toBe(false);
  });

  it('warns on standard error about a missing source and a partly read source, and still leaves nothing', async () => {
    const fixture = await makeFixture();
    await mkdir(fixture.at('linked'));
    await writeFile(fixture.at('linked', 'orchard.md'), `# Linked orchard\n\nThe orchard has trees. ${SENTENCE}\n`);
    await symlink(fixture.at('notes', 'orchard.md'), fixture.at('linked', 'link.md'));
    fixture.sources.push({ type: 'markdown', path: fixture.at('linked') }, { type: 'markdown', path: fixture.at('gone') });
    const done = await call(fixture, {});
    expect(done.outcome.error).toBeUndefined();
    expect(done.printed).toHaveLength(1);
    expect(done.warnings).toHaveLength(2);
    expect(done.warnings.find((line) => line.includes(fixture.at('linked')))).toMatch(/^Source only partly read: .*linked: .*symbolic-link/);
    expect(done.warnings.find((line) => line.includes(fixture.at('gone')))).toMatch(/^Source missing: .*gone: \S/);
    expect(done.delta).toEqual({ created: [], changed: [], deleted: [], files: 0, bytes: 0 });
    expect(await readdir(fixture.at('tmp'))).toEqual([]);
  });

  it('never writes per-read files, even to the temporary folder', async () => {
    const fixture = await makeFixture();
    const done = await call(fixture, { readAudit: true });
    expect(done.children.length).toBeGreaterThan(1);
    expect(done.children.at(-1)!.folderDuring.some((name) => /^read-\d+\.json$/.test(name))).toBe(false);
    expect(done.children.at(-1)!.folderDuring).toEqual(expect.arrayContaining(['searches-1.txt', 'codex-1']));
  });

  it('hands every Codex destination to the temporary folder, keeps its login and removes the rest', async () => {
    const fixture = await makeFixture();
    const done = await call(fixture, {});
    expect(done.children.length).toBeGreaterThan(1);
    for (const child of done.children) {
      const argument = (flag: string) => child.args[child.args.indexOf(flag) + 1]!;
      const folder = argument('-C');
      expect(relative(fixture.at('tmp'), folder).startsWith('..')).toBe(false);
      expect(basename(folder)).toMatch(/^curate-work-/);
      expect(existsSync(folder)).toBe(false);
      expect(relative(folder, argument('-o')).startsWith('..')).toBe(false);
      for (const flag of ['--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--json']) expect(child.args).toContain(flag);
      expect(argument('-s')).toBe('read-only');
      const setting = (name: string) => child.args.find((arg) => arg.startsWith(`${name}=`))!;
      for (const [name, leaf] of [['log_dir', 'log'], ['sqlite_home', 'state']] as const) {
        expect(setting(name)).toBe(`${name}=${JSON.stringify(join(folder, `${basename(argument('-o'), '.txt')}-codex`, leaf))}`);
      }
      expect(child.args).toContain('features.plugins=false');
      expect(child.env.CODEX_HOME).toBe(fixture.at('codex-home'));
      expect(child.env.HOME).toBe(fixture.at('home'));
      expect(child.env.TYPESAFE_API_KEY).toBeUndefined();
      expect(child.env.OPENAI_API_KEY).toBeUndefined();
      if (sandboxAvailable()) {
        expect(child.command).toBe('/usr/bin/sandbox-exec');
        expect(child.args[1]).toContain(JSON.stringify(fixture.at('codex-home', 'AGENTS.md')));
      }
    }
  });

  it.each(compressions)('leaves nothing when a %s call fails after files and a child have started', async (compression) => {
    const fixture = await makeFixture();
    const label = compression === 'high' ? 'curator' : 'extract';
    const done = await call(fixture, { compression }, { label });
    expect(done.outcome.error?.message).toContain('route down for the test');
    expect(done.outcome.error?.message).not.toMatch(/\.stderr/);
    const failing = done.children.find((child) => child.label === label)!;
    expect(failing.folderDuring).toEqual(expect.arrayContaining(['searches-1.txt', 'searches-1.stderr', 'codex-1']));
    expect(done.delta).toEqual({ created: [], changed: [], deleted: [], files: 0, bytes: 0 });
    expect(await readdir(fixture.at('tmp'))).toEqual([]);
  });

  it('names no saved file when the search lines fail twice', async () => {
    const fixture = await makeFixture();
    const done = await call(fixture, {}, { label: 'searches', malformed: true });
    expect(done.outcome.error?.message).toContain('Search lines failed to parse twice');
    expect(done.outcome.error?.message).not.toContain('Both replies are in');
    expect(done.children).toHaveLength(2);
    expect(done.delta).toEqual({ created: [], changed: [], deleted: [], files: 0, bytes: 0 });
    expect(await readdir(fixture.at('tmp'))).toEqual([]);
  });

  it('dates undated notes by the UTC date at call start in any time zone', async () => {
    const fixture = await makeFixture();
    const done = await call(fixture, {});
    const prompt = done.prompts.find(({ label }) => label === 'curator')!.prompt;
    expect(new Date(NOW).toLocaleDateString('en-CA', { timeZone: ZONE })).toBe('2026-03-05');
    expect(prompt).toContain('UNDATED SOURCE collected 2026-03-04');
    expect(prompt).not.toContain('collected 2026-03-05');
  });
});

describe('a records-on call', () => {
  it.each(compressions)('with read files off keeps every file but the read files, %s compression', async (compression) => {
    const fixture = await makeFixture();
    const done = await call(fixture, { records: true, readAudit: false, compression });
    expect(done.outcome.error).toBeUndefined();
    const result = done.outcome.value as { folder: string };
    expect(result.folder.startsWith(fixture.at('home', '.curate', 'runs'))).toBe(true);
    const shape = await fileShape(result.folder, fixture);
    const expected = (await base(compression)).files;
    const { 'read files': readFiles, 'read file keys': readFileKeys, ...others } = expected;
    expect(readFiles).toBeGreaterThan(0);
    expect(readFileKeys).toBeDefined();
    expect(Object.keys(shape)).toEqual(Object.keys(others));
    const record = JSON.parse(await readFile(join(result.folder, 'record.json'), 'utf8'));
    expect(record.reads.every((entry: { file?: string }) => entry.file === undefined)).toBe(true);
    const facts = observed(done, record, fixture);
    expect(facts).toEqual((await base(compression)).observed);
  });
});

describe('the records setting', () => {
  it('takes a boolean only and defaults to off', () => {
    const sources = [{ type: 'markdown', path: 'documents' }];
    expect(() => parseSources({ sources, records: 'yes' })).toThrow('records must be a boolean.');
    expect(parseSources({ sources, records: true }).records).toBe(true);
    expect(parseSources({ sources }).records).toBeUndefined();
  });
});

describe('a stopped command', () => {
  it.each([['SIGTERM', 143], ['SIGINT', 130]] as const)('removes its temporary folder on %s', async (signal, code) => {
    const fixture = await makeFixture();
    await mkdir(fixture.at('bin'));
    await writeFile(fixture.sourcesFile, JSON.stringify({ sources: fixture.sources, searchModel: 'sol' }));
    const marker = fixture.at('started');
    // Stands in for Codex, leaves a file in the working folder and ends by itself; only the command is signalled.
    await writeFile(fixture.at('bin', 'codex'), `#!/bin/sh\nwhile [ "$1" != "-C" ]; do shift; done\n: > "$2/partial"\n: > "${marker}"\nsleep 5\nexit 1\n`, { mode: 0o755 });
    const script = join(__dirname, '../skills/curate/run.mjs');
    const child = realSpawn(process.execPath, [script, '--sources', fixture.sourcesFile, 'orchard'], {
      cwd: fixture.at('cwd'), stdio: 'ignore',
      env: { ...process.env, HOME: fixture.at('home'), CODEX_HOME: fixture.at('codex-home'), TMPDIR: fixture.at('tmp'),
        XDG_CACHE_HOME: fixture.at('cache'), TYPESAFE_API_KEY: 'test-key', PATH: `${fixture.at('bin')}:${process.env.PATH}` },
    });
    const closed = new Promise<number | null>((done) => child.on('close', (exit) => done(exit)));
    while (!existsSync(marker)) await new Promise((done) => setTimeout(done, 20));
    const [working] = await readdir(fixture.at('tmp'));
    expect(working).toMatch(/^curate-work-/);
    expect(await readdir(fixture.at('tmp', working!))).toContain('partial');
    child.kill(signal);
    expect(await closed).toBe(code);
    expect(await readdir(fixture.at('tmp'))).toEqual([]);
    expect(existsSync(fixture.at('home', '.curate'))).toBe(false);
  });

  it('stops the search-lines call and the git it started early', async () => {
    const fixture = await makeFixture();
    await mkdir(fixture.at('bin'));
    await writeFile(fixture.sourcesFile, JSON.stringify({ sources: fixture.sources, searchModel: 'sol' }));
    // Each stand-in records its process id and stays alive far longer than the test.
    const standIn = (name: string) => writeFile(fixture.at('bin', name),
      `#!/bin/sh\necho $$ >> "${fixture.at(`${name}.pids`)}"\nexec sleep 30\n`, { mode: 0o755 });
    await standIn('codex');
    await standIn('git');
    const pids = async () => (await Promise.all(['codex', 'git'].map(async (name) =>
      existsSync(fixture.at(`${name}.pids`)) ? (await readFile(fixture.at(`${name}.pids`), 'utf8')).split('\n').filter(Boolean).map(Number) : [])));
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const script = join(__dirname, '../skills/curate/run.mjs');
    const child = realSpawn(process.execPath, [script, '--sources', fixture.sourcesFile, 'orchard'], {
      cwd: fixture.at('cwd'), stdio: 'ignore',
      env: { ...process.env, HOME: fixture.at('home'), CODEX_HOME: fixture.at('codex-home'), TMPDIR: fixture.at('tmp'),
        XDG_CACHE_HOME: fixture.at('cache'), TYPESAFE_API_KEY: 'test-key', PATH: `${fixture.at('bin')}:${process.env.PATH}` },
    });
    const closed = new Promise<number | null>((done) => child.on('close', (exit) => done(exit)));
    try {
      while ((await pids()).some((list) => list.length === 0)) await new Promise((done) => setTimeout(done, 20));
      child.kill('SIGTERM');
      expect(await closed).toBe(143);
      const started = (await pids()).flat();
      for (let waited = 0; waited < 2_000 && started.some(alive); waited += 20) await new Promise((done) => setTimeout(done, 20));
      expect(started.filter(alive)).toEqual([]);
      expect(await readdir(fixture.at('tmp'))).toEqual([]);
    } finally {
      child.kill('SIGKILL');
      for (const pid of (await pids()).flat()) if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  });
});
