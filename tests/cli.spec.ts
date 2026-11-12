import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error The command has no type declarations.
import { route } from '../packages/cli/src/curate.mjs';
// @ts-expect-error The command has no type declarations.
import { setup } from '../packages/cli/src/setup.mjs';

// A model file stands in for a loadable model; without one the load fails
// as it does for a missing file.
vi.mock('@curatejs/core/local-embeddings', async () => {
  const { existsSync: exists } = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    createLocalEmbedder: vi.fn(async ({ modelPath }: { modelPath: string }) => {
      if (!exists(modelPath)) throw new Error(`no model at ${modelPath}`);
      return { embed: async (texts: readonly string[]) => texts.map(() => [1, 0]), gpu: 'metal', dispose: async () => {} };
    }),
  };
});

const cli = join(__dirname, '../packages/cli/src/curate.mjs');
const MODEL = join('curate', 'models', 'embeddinggemma-300M-Q8_0.gguf');
const startingFolder = process.cwd();
const directories: string[] = [];
let home = '', cache = '', work = '', printed: string[] = [];

beforeEach(async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'curate-cli-')));
  directories.push(directory);
  [home, cache, work] = [join(directory, 'home'), join(directory, 'cache'), join(directory, 'work')];
  for (const folder of [home, cache, work]) await mkdir(folder);
  // An empty folder outside any project, with no login CLI on PATH.
  process.chdir(work);
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CACHE_HOME', cache);
  vi.stubEnv('PATH', dirname(process.execPath));
  vi.stubEnv('TYPESAFE_API_KEY', '');
  printed = [];
  const keep = (...words: unknown[]) => { printed.push(words.map(String).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(keep);
  vi.spyOn(console, 'error').mockImplementation(keep);
});
afterEach(async () => {
  process.chdir(startingFolder);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

// Answers in order; every question past the list is answered no.
const answering = (...answers: string[]) => vi.fn(async (_question: string) => answers.shift() ?? 'n');
const filesUnder = async (folder: string): Promise<string[]> => (await readdir(folder, { recursive: true })).sort();

describe('curate command words', () => {
  it.each([
    [['check'], { args: ['--check'] }],
    [['prepare'], { args: ['--prepare'] }],
    [['setup'], { setup: true }],
    [['check the retry decision before changing it'], { args: ['check the retry decision before changing it'] }],
    [['check', 'the', 'retries'], { args: ['check', 'the', 'retries'] }],
    [['--sources', 'settings.json', '--check'], { args: ['--sources', 'settings.json', '--check'] }],
    [['What did we decide about retries?'], { args: ['What did we decide about retries?'] }],
    [['--version'], { version: true }],
    [['--help'], { help: true }],
    [[], { help: true }],
  ])('maps %j', (args, expected) => {
    expect(route(args)).toEqual(expected);
  });
});

describe('curate setup', () => {
  it('in a shell with no terminal prints the fixes, writes no file, fetches nothing and exits 3', async () => {
    const fetch = vi.fn();
    const ask = answering('y', 'y', 'y');
    expect(await setup({ interactive: false, ask, fetch })).toBe(3);
    expect(ask).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(await filesUnder(home)).toEqual([]);
    expect(await filesUnder(cache)).toEqual([]);
    const output = printed.join('\n');
    expect(output).toContain(`missing  An embedding model file: no file at ${join(cache, MODEL)}.`);
    expect(output).toContain('Fix: Get a key from TypeSafe (https://typesafe.ai)');
    expect(output).toContain('npx skills add jonny981/curate -g -a claude-code -a codex -y');
  });

  it('downloads the model through a .part file on yes, and fetches nothing on no', async () => {
    const fetch = vi.fn(async () => new Response('model bytes'));
    expect(await setup({ interactive: true, ask: answering('n'), fetch })).toBe(3);
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(join(cache, MODEL))).toBe(false);

    const ask = answering('y');
    expect(await setup({ interactive: true, ask, fetch })).toBe(3);
    expect(ask.mock.calls[0]![0]).toContain(`about 330 MB) to ${join(cache, MODEL)}?`);
    expect(fetch).toHaveBeenCalledWith('https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf');
    expect(await readFile(join(cache, MODEL), 'utf8')).toBe('model bytes');
    expect(await readdir(join(cache, 'curate', 'models'))).toEqual(['embeddinggemma-300M-Q8_0.gguf']);
    expect(printed.join('\n')).toContain(`ready    An embedding model file: ${join(cache, MODEL)}`);
  });

  it('on yes creates the settings file and a private, empty credentials file', async () => {
    expect(await setup({ interactive: true, ask: answering('n', 'y'), fetch: vi.fn() })).toBe(3);
    expect(JSON.parse(await readFile(join(home, '.curate', 'sources.json'), 'utf8'))).toEqual({ envFile: '~/.curate/credentials.env' });
    const credentials = join(home, '.curate', 'credentials.env');
    expect(statSync(credentials).mode & 0o777).toBe(0o600);
    expect((await readFile(credentials, 'utf8')).split('\n').filter(Boolean).every((line) => line.startsWith('#'))).toBe(true);
    expect(printed.join('\n')).toContain('https://typesafe.ai');
  });

  it('leaves an existing settings file byte for byte, whatever the answers', async () => {
    await mkdir(join(home, '.curate'));
    const existing = '{"sources":[],  "answerTokens": 3000}\n';
    await writeFile(join(home, '.curate', 'sources.json'), existing);
    await setup({ interactive: true, ask: answering('y', 'y', 'y', 'y'), fetch: vi.fn(async () => new Response('model bytes')) });
    expect(await readFile(join(home, '.curate', 'sources.json'), 'utf8')).toBe(existing);
    expect(existsSync(join(home, '.curate', 'credentials.env'))).toBe(false);
  });

  it('leaves an existing credentials file byte for byte when it creates the settings file', async () => {
    await mkdir(join(home, '.curate'));
    const existing = 'OTHER=1\n';
    await writeFile(join(home, '.curate', 'credentials.env'), existing);
    await setup({ interactive: true, ask: answering('n', 'y'), fetch: vi.fn() });
    expect(existsSync(join(home, '.curate', 'sources.json'))).toBe(true);
    expect(await readFile(join(home, '.curate', 'credentials.env'), 'utf8')).toBe(existing);
  });

  it('never prints the decision key', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key-value-7f3a9c');
    expect(await setup({ interactive: true, ask: answering(), fetch: vi.fn() })).toBe(3);
    await mkdir(join(home, '.curate'));
    await writeFile(join(home, '.curate', 'credentials.env'), 'TYPESAFE_API_KEY=file-key-value-51d2e8\n');
    await writeFile(join(home, '.curate', 'sources.json'), JSON.stringify({ envFile: '~/.curate/credentials.env' }));
    vi.stubEnv('TYPESAFE_API_KEY', undefined);
    expect(await setup({ interactive: true, ask: answering(), fetch: vi.fn() })).toBe(3);
    const output = printed.join('\n');
    expect(output).toContain('ready    The decision key (`TYPESAFE_API_KEY`): set in the environment');
    expect(output).toContain(`ready    The decision key (\`TYPESAFE_API_KEY\`): set in ${join(home, '.curate', 'credentials.env')}`);
    expect(output).not.toContain('test-key-value-7f3a9c');
    expect(output).not.toContain('file-key-value-51d2e8');
  });
});

describe('the curate command', () => {
  it('ships a byte-identical copy of the skill script', () => {
    expect(readFileSync(join(__dirname, '../packages/cli/dist/run.mjs'), 'utf8'))
      .toBe(readFileSync(join(__dirname, '../skills/curate/run.mjs'), 'utf8'));
  });

  it('`curate check` in an empty folder exits 3 and names the missing model file', () => {
    const result = spawnSync(process.execPath, [cli, 'check'], { cwd: work, encoding: 'utf8',
      env: { HOME: home, XDG_CACHE_HOME: cache, PATH: dirname(process.execPath) } });
    expect(result.status).toBe(3);
    expect(result.stdout).toContain(`missing  An embedding model file: no file at ${join(cache, MODEL)}.`);
    expect(result.stdout).toContain('ready    Node.js 22.20 or later:');
  });
});
