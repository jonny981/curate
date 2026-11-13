import { appendFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { historySource, LABEL_KINDS, pickFromSources, type CandidateReadRequest, type CandidateSource, type PickDecide, type PickQuestion } from '@curatejs/core';
import { chat, chatSettings, type ChatProvider } from '../src/index.js';
import { CHAT_KEYWORD_SETTINGS, rankChat } from '../src/chat-rank.js';
import { porterStem } from '../src/porter.js';

// Every transcript file the reader opens, so a spec can see an excluded
// file was never read, and every byte it reads from an opened file, so a
// spec can count what reading part of a file cost.
const fileReads: string[] = [];
const rangeReads: { file: string; bytes: number }[] = [];
// Every folder the reader lists, so a spec can count its walks.
const folderReads: string[] = [];
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (file: unknown, options?: unknown) => {
      fileReads.push(String(file));
      return (actual.readFile as (f: unknown, o?: unknown) => Promise<unknown>)(file, options);
    },
    readdir: (folder: unknown, options?: unknown) => {
      folderReads.push(String(folder));
      return (actual.readdir as (f: unknown, o?: unknown) => Promise<unknown>)(folder, options);
    },
    open: async (...call: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...call);
      const read = handle.read.bind(handle) as (...args: unknown[]) => Promise<{ bytesRead: number }>;
      (handle as { read: unknown }).read = async (...args: unknown[]) => {
        const result = await read(...args);
        rangeReads.push({ file: String(call[0]), bytes: result.bytesRead });
        return result;
      };
      return handle;
    },
  };
});

const uncutPick = { everyRanked: true, everyScored: true, rare: false } as const;

const directories: string[] = [];
// Chat asks label questions by default; keep their saved answers out of the real cache.
beforeEach(async () => { vi.stubEnv('XDG_CACHE_HOME', await folder()); });
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function folder(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'curate-chat-'));
  directories.push(directory);
  return directory;
}

const OLD = '2026-09-01T12:00:00Z';
const CUT = '2026-10-01T12:00:00Z';
const NEW = '2026-10-02T12:00:00Z';
function message(provider: ChatProvider, role: 'user' | 'assistant', text: string, timestamp = NEW): unknown {
  return provider === 'claude-code'
    ? { type: role, timestamp, sessionId: 'session-one', message: { content: [{ type: 'text', text }] } }
    : { type: 'response_item', timestamp, payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } };
}
function tools(provider: ChatProvider, text: string): unknown[] {
  return provider === 'claude-code'
    ? [
        { type: 'assistant', timestamp: NEW, sessionId: 'session-one', message: { content: [{ type: 'tool_use', name: 'shell', input: { command: text } }] } },
        { type: 'user', timestamp: NEW, sessionId: 'session-one', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text }] }] } },
      ]
    : [
        { type: 'response_item', timestamp: NEW, payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: text }) } },
        { type: 'response_item', timestamp: NEW, payload: { type: 'function_call_output', output: text } },
      ];
}
async function transcript(provider: ChatProvider, records: unknown[], root?: string, name = 'session-one'): Promise<string> {
  root ??= await folder();
  const directory = join(root, provider === 'codex' ? '2026/10/02' : 'project');
  await mkdir(directory, { recursive: true });
  const metadata = provider === 'codex' ? [{ type: 'session_meta', timestamp: OLD, payload: { id: name } }] : [];
  await writeFile(join(directory, `${name}.jsonl`), [...metadata, ...records].map((record) => JSON.stringify(record)).join('\n') + '\n');
  return root;
}
async function read(provider: ChatProvider, directory: string, options: Parameters<typeof chat>[0] = {}, request: CandidateReadRequest = { task: 'find useful evidence' }) {
  const result = await chat({ providers: [provider], paths: [directory], ...options }).read(request);
  expect(result.status).toBe('read');
  if (result.status !== 'read') throw new Error('Expected a read');
  return result;
}
// Chat with labels off, so only the keyword search chooses parts.
const keywordChat = (options: Parameters<typeof chat>[0]) =>
  historySource({ reader: chat(options), ...chatSettings, labels: false });

// Hand-written fake credentials, assembled at runtime. No real transcripts.
function fakeSecrets(): string[] {
  return [
    `-----BEGIN RSA PRIVATE KEY-----\n${'FakeKey'.repeat(8)}\n-----END RSA PRIVATE KEY-----`,
    ...['sk', 'sk-ant', 'xai', 'pk', 'rk'].map((prefix) => `${prefix}-${'Ab3'.repeat(8)}`),
    ...['p', 'o', 'u', 's', 'r'].map((kind) => `gh${kind}_${'Kd7'.repeat(8)}`),
    `github_pat_${'Kd7_'.repeat(8)}`,
    ...['AKIA', 'ASIA'].map((prefix) => `${prefix}${'QWERTY12'.repeat(2)}`),
    'aws_secret_access_key=shortAwsFake',
    ...['a', 'b', 'e', 'o', 'p', 'r', 's'].map((kind) => `xox${kind}-${'1a2b-'.repeat(4)}`),
    `hooks.slack.com/services/${'ABC123/DEF456/ghi789'}`,
    ...['c', 'x'].map((kind) => `ph${kind}_${'Ab3'.repeat(8)}`),
    `eyJ${'ab1'.repeat(4)}.${'Cd2'.repeat(4)}.${'Ef3'.repeat(4)}`,
    `Bearer ${'tok3n'.repeat(5)}`,
    '9f'.repeat(16), '9f'.repeat(24), `Ab1${'xY7z'.repeat(12)}`,
    'password="tiny fake phrase"', "passwd='tinyPass'", 'pwd=tinyPwd',
    'secret=tinySecret', 'access_token: tinyToken', 'API_KEY=tinyKey',
    'access-key=tinyAccess', 'Authorization=BasicFake',
    'https://fakeUser:fakePassword@example.invalid/path',
  ];
}

describe.each(['claude-code', 'codex'] as const)('chat %s', (provider) => {
  it('keeps each text block separate and ignores thinking blocks', async () => {
    const blocks = [
      { type: provider === 'codex' ? 'output_text' : 'text', text: 'first part' },
      { type: 'thinking', text: 'PRIVATE THINKING' },
      { type: provider === 'codex' ? 'output_text' : 'text', text: 'second part' },
    ];
    const record = provider === 'codex'
      ? { type: 'response_item', timestamp: NEW, payload: { type: 'message', role: 'assistant', content: blocks } }
      : { type: 'assistant', timestamp: NEW, sessionId: 'session-one', message: { content: blocks } };
    const user = provider === 'claude-code'
      ? { type: 'user', timestamp: NEW, sessionId: 'session-one', message: { content: 'plain user text' } }
      : message(provider, 'user', 'plain user text');
    const result = await read(provider, await transcript(provider, [user, record]));
    expect(result.candidates.map((candidate) => candidate.text).sort()).toEqual(['first part', 'plain user text', 'second part']);
    expect(new Set(result.candidates.map((candidate) => candidate.id)).size).toBe(3);
  });

  it('gives each part its own id in a folder whose name holds a credential word', async () => {
    for (const name of ['token-service', 'secrets', 'pwd-notes']) {
      const root = join(await folder(), name);
      await transcript(provider, [message(provider, 'user', 'first part'), message(provider, 'assistant', 'second part')], root);
      const result = await read(provider, root);
      expect(result.candidates.map((candidate) => candidate.text).sort(), name).toEqual(['first part', 'second part']);
      expect(new Set(result.candidates.map((candidate) => candidate.id)).size, name).toBe(2);
      expect(result.candidates.every((candidate) => candidate.id.includes(`${name}:`)), name).toBe(true);
    }
  });

  it('masks a folder that looks like a secret in each id and keeps the rest of the id', async () => {
    for (const name of [`sk-${'Ab3'.repeat(8)}`, 'api_key=Kd7Kd7Kd7', 'api_key:Kd7Kd7Kd7', 'password:tinyFakePwd']) {
      const root = join(await folder(), name);
      await transcript(provider, [message(provider, 'user', 'first part'), message(provider, 'assistant', 'second part')], root);
      // Read from the stored index and straight from the files.
      for (const options of [{}, { index: false as const }]) {
        const ids = (await read(provider, root, options)).candidates.map((candidate) => candidate.id);
        expect(new Set(ids).size, name).toBe(2);
        for (const id of ids) {
          expect(id.includes(name), name).toBe(false);
          expect(id, name).toMatch(new RegExp(`/\\[redacted\\]:${provider === 'codex' ? '2026/10/02' : 'project'}/session-one\\.jsonl:\\d+:\\d+:\\d+$`));
        }
      }
    }
  });

  it('preserves message parts, roles, session ids and dates', async () => {
    const directory = await transcript(provider, [message(provider, 'user', 'A user request'), message(provider, 'assistant', 'An assistant reply')]);
    const result = await read(provider, directory, {}, { task: 'find useful evidence', timeZone: 'UTC' });
    expect(result.complete).toBe(true);
    expect(result.candidates.map((candidate) => candidate.chat?.role).sort()).toEqual(['assistant', 'user']);
    for (const candidate of result.candidates) {
      expect(candidate.chat).toMatchObject({ provider, sessionId: 'session-one' });
      expect(candidate.role).toBe('reference');
      expect(candidate.date).toEqual({ value: '2026-10-02T12:00:00.000+00:00', meaning: 'recorded' });
    }
    expect(result.candidates.map((candidate) => candidate.text).sort()).toEqual(['A user request', 'An assistant reply']);
  });

  it('excludes messages and entire sessions before the cut-off but keeps the boundary', async () => {
    const directory = await transcript(provider, [message(provider, 'user', 'old message', OLD), message(provider, 'user', 'boundary message', CUT), message(provider, 'assistant', 'new message')]);
    await transcript(provider, [message(provider, 'user', 'old session', OLD)], directory, 'old-session');
    const result = await read(provider, directory, { since: CUT });
    expect(result.candidates.map((candidate) => candidate.text).sort()).toEqual(['boundary message', 'new message']);
  });

  it('accepts a duration relative to read start', async () => {
    const directory = await transcript(provider, [message(provider, 'user', 'old message', OLD), message(provider, 'user', 'boundary message', CUT), message(provider, 'assistant', 'new message')]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
    const result = await read(provider, directory, { since: '14 days' });
    expect(result.candidates.map((candidate) => candidate.text).sort()).toEqual(['boundary message', 'new message']);
  });

  it('leaves a transcript its own exclude names unopened while another source reads it', async () => {
    const directory = await transcript(provider, [message(provider, 'user', 'open message')]);
    const sessions = join(directory, provider === 'codex' ? '2026/10/02' : 'project');
    const metadata = provider === 'codex' ? [{ type: 'session_meta', timestamp: OLD, payload: { id: 'blocked' } }] : [];
    const blocked = join(sessions, 'blocked.jsonl');
    await writeFile(blocked, [...metadata, message(provider, 'user', 'hidden message')]
      .map((record) => JSON.stringify(record)).join('\n') + '\n');

    // A direct read with the exclusion never opens the file.
    fileReads.length = 0;
    const own = await read(provider, directory, { exclude: [blocked] });
    expect(own.candidates.map((candidate) => candidate.text)).toEqual(['open message']);
    expect(fileReads.some((file) => file.endsWith('blocked.jsonl'))).toBe(false);

    // Another chat source on the same directory still reads it.
    const picked = await pickFromSources(
      [
        chat({ id: 'chat:a', providers: [provider], paths: [directory], exclude: [blocked] }),
        chat({ id: 'chat:b', providers: [provider], paths: [directory] }),
      ],
      { task: 'find useful evidence' },
      {
        ...uncutPick,
        task: 'find useful evidence',
        decide: async (batch) => Object.fromEntries(
          batch.questions.map((question) => [question.key, { status: 'answered' as const, probability: 0.9 }])),
      },
    );
    expect(picked.reads[0]!.status).toBe('read');
    if (picked.reads[0]!.status !== 'read') return;
    expect(picked.reads[0]!.candidates.map((candidate) => candidate.text)).toEqual(['open message']);
    expect(picked.reads[1]!.status).toBe('read');
    if (picked.reads[1]!.status !== 'read') return;
    expect(picked.reads[1]!.candidates.map((candidate) => candidate.text).sort()).toEqual(['hidden message', 'open message']);
    expect(picked.record.levers.sources['chat:a']).toMatchObject({ exclude: [blocked] });
  });

  it('splits at line ends and hard-cuts long lines without losing text', async () => {
    const text = 'g'.repeat(400) + '\n' + 'h'.repeat(400) + '\n' + 'j'.repeat(1_450);
    const result = await read(provider, await transcript(provider, [message(provider, 'user', text)]));
    const parts = [...result.candidates].sort((a, b) => a.id.localeCompare(b.id)).map((candidate) => candidate.text);
    expect(parts[0]).toBe('g'.repeat(400) + '\n');
    expect(parts.every((part) => part.length <= 700)).toBe(true);
    expect(parts.join('')).toBe(text);
    expect(new Set(result.candidates.map((candidate) => candidate.id)).size).toBe(parts.length);
  });

  it('leaves tool calls and tool results out by default', async () => {
    const directory = await transcript(provider, [message(provider, 'assistant', 'useful reply'), ...tools(provider, 'TOOL NOISE')]);
    const result = await read(provider, directory);
    expect(result.candidates.map((candidate) => candidate.text)).toEqual(['useful reply']);
  });

  it('includes tool calls and tool results when requested', async () => {
    const result = await read(provider, await transcript(provider, tools(provider, 'TOOL OUTPUT')), { includeTools: true });
    expect(result.candidates.map((candidate) => candidate.chat?.role).sort()).toEqual(['tool-call', 'tool-result']);
    expect(result.candidates.every((candidate) => candidate.text.includes('TOOL OUTPUT'))).toBe(true);
  });

  it('reports its missing folder as absent', async () => {
    const directory = join(await folder(), 'missing');
    await expect(chat({ providers: [provider], paths: [directory] }).read({ task: 'test' })).resolves.toEqual({ status: 'absent', reason: 'no-chat-folders' });
  });

  it('scrubs every fake secret shape before any candidate leaves the reader', async () => {
    const secrets = fakeSecrets();
    const result = await read(provider, await transcript(provider, [message(provider, 'user', secrets.join('\n')), message(provider, 'assistant', secrets.join('\n')), ...tools(provider, secrets.join('\n'))]), { includeTools: true });
    expect(result.candidates.length).toBeGreaterThan(3);
    const output = result.candidates.map((candidate) => candidate.text).join('');
    for (const [index, secret] of secrets.entries()) {
      expect(output.includes(secret), `fake secret shape ${index} survived`).toBe(false);
    }
    for (const value of ['tiny fake phrase', 'tinyPass', 'tinyPwd', 'tinySecret', 'tinyToken', 'tinyKey', 'tinyAccess', 'BasicFake', 'fakePassword']) {
      expect(output.includes(value), `fake named credential survived`).toBe(false);
    }
    expect(output).toContain('[redacted]');
  });

  it('scrubs a secret across a split boundary but preserves commit ids', async () => {
    const commit = 'abcdef12'.repeat(5);
    const secret = `sk-${'Ab3'.repeat(10)}`;
    const result = await read(provider, await transcript(provider, [message(provider, 'user', 'safe '.repeat(137) + secret + '\n' + commit)]));
    const output = [...result.candidates].sort((a, b) => a.id.localeCompare(b.id)).map((candidate) => candidate.text).join('');
    expect(output).not.toContain(secret);
    expect(output).toContain('[redacted]');
    expect(output).toContain(commit);
  });
});

describe('chat source contract', () => {
  it('reads Codex custom tool calls and outputs only when requested', async () => {
    const directory = await transcript('codex', [
      { type: 'response_item', timestamp: NEW, payload: { type: 'custom_tool_call', name: 'patch', input: 'custom input' } },
      { type: 'response_item', timestamp: NEW, payload: { type: 'custom_tool_call_output', output: 'custom output' } },
    ]);
    expect((await read('codex', directory)).candidates).toEqual([]);
    const result = await read('codex', directory, { includeTools: true });
    expect(result.candidates.map((candidate) => candidate.chat?.role).sort()).toEqual(['tool-call', 'tool-result']);
    expect(result.candidates.map((candidate) => candidate.text).sort()).toEqual(['custom output', 'patch\ncustom input']);
  });

  it('reports an absent folder without throwing', async () => {
    const directory = await folder();
    await expect(chat({ paths: [join(directory, 'missing')] }).read({ task: 'test' })).resolves.toEqual({ status: 'absent', reason: 'no-chat-folders' });
  });

  it('reads both providers in one source without duplicating messages', async () => {
    const directory = await folder();
    await transcript('claude-code', [message('claude-code', 'user', 'Claude request')], directory, 'claude-session');
    await transcript('codex', [message('codex', 'assistant', 'Codex answer'), { type: 'event_msg', timestamp: NEW, payload: { type: 'agent_message', message: 'Codex answer' } }], directory, 'codex-session');
    const result = await chat({ paths: [directory] }).read({ task: 'test' });
    if (result.status !== 'read') throw new Error('Expected a read');
    expect(result.candidates.map((candidate) => candidate.text).sort()).toEqual(['Claude request', 'Codex answer']);
    expect(result.complete).toBe(true);
  });

  it('honours exclusions before opening an invalid transcript', async () => {
    const directory = await transcript('codex', [message('codex', 'user', 'allowed')]);
    await writeFile(join(directory, 'blocked.jsonl'), 'not JSON');
    const result = await read('codex', directory, {}, { task: 'test', exclude: ['blocked.jsonl'] });
    expect(result.candidates.map((candidate) => candidate.text)).toEqual(['allowed']);
    const all = await read('codex', directory, {}, { task: 'test', exclude: ['.'] });
    expect(all.candidates).toEqual([]);
  });

  it('honours absolute exclusions when a parent path uses a symlink', async () => {
    const directory = await transcript('codex', [message('codex', 'user', 'allowed')]);
    await writeFile(join(directory, 'blocked.jsonl'), 'not JSON');
    const parent = await folder();
    await symlink(directory, join(parent, 'alias'));
    const result = await read('codex', directory, {}, { task: 'test', exclude: [join(parent, 'alias', 'blocked.jsonl')] });
    expect(result.candidates.map((candidate) => candidate.text)).toEqual(['allowed']);
  });

  it('reports skipped symbolic links and undated messages as incomplete', async () => {
    const directory = await transcript('codex', [message('codex', 'user', 'allowed'), message('codex', 'assistant', 'bad date', 'invalid')]);
    await symlink(join(directory, '2026'), join(directory, 'linked'));
    const result = await read('codex', directory);
    expect(result.complete).toBe(false);
    expect(result.partial).toContain('skipped 2');
    expect(result.candidates).toHaveLength(1);
  });

  it('reports truncation after ranking rather than limiting file enumeration', async () => {
    const directory = await transcript('codex', [message('codex', 'user', 'Unrelated breakfast'), message('codex', 'assistant', 'S3 backup recovery')]);
    const result = await read('codex', directory, {}, { task: 'S3 backup recovery', limit: 1 });
    expect(result.candidates[0]?.text).toBe('S3 backup recovery');
    expect(result.complete).toBe(false);
    expect(result.partial).toBe('the limit kept 1 of 2 candidates');
  });

  it('preserves every part within the picker text budget', async () => {
    const text = 'hello world\n'.repeat(20);
    const directory = await transcript('codex', [message('codex', 'user', text)]);
    const seen: string[] = [];
    const result = await pickFromSources([keywordChat({ paths: [directory], providers: ['codex'] })], { task: 'hello', wholeLanes: true }, {
      ...uncutPick,
      task: 'hello', limits: { maxQuestionText: 50 },
      decide: async (batch) => {
        seen.push(...batch.questions.map((question) => question.text));
        return Object.fromEntries(batch.questions.map((question) => [question.key, { status: 'answered', probability: 1 }]));
      },
    });
    expect(result.selected.length).toBeGreaterThan(1);
    expect(seen.every((part) => part.length <= 50)).toBe(true);
    expect(result.selected.map((candidate) => candidate.text).join('')).toBe(text);
    expect(result.record.candidates.every((candidate) => !candidate.truncated)).toBe(true);
  });

  it('records no search match and keeps nothing when no part scores', async () => {
    const directory = await transcript('codex', [
      message('codex', 'user', 'my dog is Rex'),
      message('codex', 'assistant', 'noted, Rex is a good name'),
    ]);
    const seen: string[] = [];
    const result = await pickFromSources([keywordChat({ paths: [directory], providers: ['codex'] })], { task: "What's my dog's name?" }, {
      ...uncutPick,
      task: "What's my dog's name?",
      decide: async (batch) => {
        seen.push(...batch.questions.map((question) => question.text));
        return Object.fromEntries(batch.questions.map((question) => [question.key, { status: 'answered' as const, probability: 0.9 }]));
      },
    });
    expect(result.selected).toEqual([]);
    expect(seen).toEqual([]);
    const laneRead = result.reads[0]!;
    if (laneRead.status !== 'read') throw new Error('read failed');
    expect(laneRead.candidates).toEqual([]);
    expect(laneRead.noSearchMatch).toBe(true);
  });

  it('fails on corrupt JSON without putting transcript contents in the error', async () => {
    const directory = await folder();
    await writeFile(join(directory, 'broken.jsonl'), 'PRIVATE TRANSCRIPT invalid JSON');
    await expect(chat({ paths: [directory] }).read({ task: 'test' })).rejects.toMatchObject({ name: 'SourceReadError', code: 'failed', message: 'Invalid JSON in a chat transcript.' });
  });

  it('propagates cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(chat({ paths: [await folder()] }).read({ task: 'test', signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('reports an unsupported revision pin as absent', async () => {
    await expect(chat({ paths: [await folder()] }).read({ task: 'test', revision: 'HEAD' })).resolves.toEqual({ status: 'absent', reason: 'chat-does-not-support-revisions' });
  });

  it('rejects invalid options and limits', async () => {
    expect(() => chat({ since: 'yesterday' })).toThrow(TypeError);
    expect(() => chat({ providers: [] })).toThrow(TypeError);
    expect(() => chat({ paths: [] })).toThrow(TypeError);
    expect(() => chat({ maxQuestionText: 0 })).toThrow(TypeError);
    await expect(chat().read({ task: 'test', limit: 0 })).rejects.toThrow(TypeError);
  });
});

describe('chat keyword ranking', () => {
  it('matches the LongMemEval calculation for stems, short ids, noun weights and merged queries', () => {
    const candidates = ['Alice runs beside the river with S3 backups.', 'Alice prefers walking beside the lake.', 'Bob manages S3 and EC2 backups.'].map((text, index) => ({ id: String(index), title: '', text, heading: '', name: '', front: '', score: 0 }));
    rankChat(candidates, 'Where does Alice enjoy running with S3?');
    expect(candidates.map((candidate) => candidate.score)).toEqual([0.11557377049180328, 0.08451612903225807, 0.06761904761904762]);
  });

  it('retains zero scores when no query matches', () => {
    const candidates = [{ id: '0', title: '', text: 'Breakfast pancakes', heading: '', name: '', front: '', score: 0 }];
    rankChat(candidates, 'S3 backup recovery');
    expect(candidates[0]?.score).toBe(0);
  });

  it('can use the full-query score without merged ranks', () => {
    const candidates = ['Alice runs beside the river.', 'Alice prefers walking.', 'Bob handles backups.']
      .map((text, index) => ({ id: String(index), title: '', text, heading: '', name: '', front: '', score: 0 }));
    rankChat(candidates, 'Where does Alice enjoy running?', { rrf: false });
    expect(candidates[0]!.score).toBe(3);
    expect(candidates[1]!.score).toBeGreaterThan(0);
    expect(candidates[1]!.score).toBeLessThan(3);
    expect(candidates[2]!.score).toBe(0);
  });

  it('stems word forms and retains short and long tokens', () => {
    const examples = { caresses: 'caress', ponies: 'poni', relational: 'relat', hopping: 'hop', running: 'run', agreed: 'agre', filing: 'file', happy: 'happi', sky: 'sky', triplicate: 'triplic', goodness: 'good', adoption: 'adopt', probate: 'probat', controll: 'control', roll: 'roll', possibly: 'possibl', analogies: 'analog', '401': '401', '4x4s': '4x4', as: 'as' };
    for (const [word, stem] of Object.entries(examples)) expect(porterStem(word)).toBe(stem);
    expect(porterStem('a'.repeat(62) + 'ies')).toBe('a'.repeat(62) + 'ies');
  });
});

describe('chat labels', () => {
  async function pickWithLabels(source: (directory: string) => CandidateSource) {
    const directory = await transcript('codex', [message('codex', 'user', 'I adopted a dog called Rex')]);
    const store = await folder();
    const questions: PickQuestion[] = [];
    const reader = source(directory);
    const result = await pickFromSources([reader], { task: 'adopted dog' }, {
      task: 'adopted dog', labels: { directory: store, deciderId: 'chat-labels-test' },
      decide: async (batch) => {
        // Label batches only: decision batches carry the pick's own task and ask chat's question set.
        if (batch.task !== 'adopted dog') questions.push(...batch.questions);
        return Object.fromEntries(batch.questions.map((question) => [question.key, { status: 'answered', probability: 0.9 }]));
      },
    });
    const kinds = (sourceId: string) => questions.filter((question) => question.sourceId === sourceId && question.questionKey)
      .map((question) => question.questionKey).sort();
    return { settings: result.record.levers.sources[reader.id], task: kinds('labels'), parts: kinds(reader.id) };
  }

  it('asks the seven label kinds for the task and the parts out of the box', async () => {
    const asked = await pickWithLabels((directory) => chat({ paths: [directory], providers: ['codex'] }));
    const every = LABEL_KINDS.map((kind) => kind.key).sort();
    expect(asked.settings?.labels).toBe(true);
    expect(asked.task).toEqual(every);
    expect(asked.parts).toEqual(every);
  });

  it('asks no label question when one chat source turns labels off', async () => {
    const asked = await pickWithLabels((directory) =>
      historySource({ reader: chat({ paths: [directory], providers: ['codex'] }), ...chatSettings, labels: false }));
    expect(asked.settings?.labels).toBe(false);
    expect(asked.task).toEqual([]);
    expect(asked.parts).toEqual([]);
  });
});

it('allows keyword overrides without changing the chat defaults', () => {
  const parts = () => [{ id: 'a', title: '', text: 'run', heading: '', name: '', front: '', score: 0 }];
  const normal = parts();
  const overridden = parts();
  rankChat(normal, 'running');
  rankChat(overridden, 'running', { stem: false });
  expect(normal[0]!.score).toBeGreaterThan(0);
  expect(overridden[0]!.score).toBe(0);
});

// The previous reader's rank calculation, frozen verbatim: the streaming
// reader must agree with it part for part. Comparing the read against
// today's shared implementation would only prove the two passes line
// up, never that the result still matches what the old reader emitted.
const OLD_STOP = new Set('about after agent answers before change context every into only question should that their there these this what when where which with would'.split(' '));
const OLD_COMMON = new Set('a an and are as at be been being but by can could did do does for from had has have how i if in is it its me my of on or our so than the them then they to was we were who why will you your asked am also get got tell please many much'.split(' '));
const OLD_VERBS = new Set('ask asked buy bought count describe determine find give go going know like list make mention need prefer recommend say said suggest take tell think use want went work'.split(' '));
function oldKeywords(task: string, short = false, stop = 'baseline') {
  const ids = short ? task.split(/(?<=[.?!:])\s+/).flatMap(s => s.split(/[^A-Za-z0-9]+/).filter(Boolean).filter((w,i) => /\d/.test(w) || (i > 0 && /[A-Z]/.test(w)))).map(w => w.toLowerCase()) : [];
  const words = stop === 'baseline' ? task.toLowerCase().split(/[^a-z0-9-]+/).filter(w => w.length > 4 && !OLD_STOP.has(w)) : task.toLowerCase().split(/[^a-z0-9-]+/).filter(w => w.length > 4 && (stop === 'none' || (!OLD_COMMON.has(w) && !OLD_STOP.has(w))));
  return [...new Set([...ids, ...(task.match(/[@\w./-]*[./@][\w./-]+|[a-z]+[A-Z]\w+|`[^`]+`/g) ?? []).map(w => w.replace(/`/g,'')), ...words].map(w => w.toLowerCase()))];
}
interface FrozenPart { id: string; title: string; text: string; heading: string; name: string; front: string }
function oldScore(candidates: readonly FrozenPart[], task: string, stems: Record<string, string>, queryText: string | null = null) {
  const config = CHAT_KEYWORD_SETTINGS;
  const shortIds = new Set(config.short ? oldKeywords(task,true).filter(w => w.length <= 2) : []);
  const tok = (t: string) => t.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 || shortIds.has(w)).map(w => stems[w] ?? w);
  const query = [...new Set(queryText === null ? oldKeywords(task,config.short,config.stop).flatMap(tok) : tok(queryText))];
  const docs = candidates.map(c => tok(`${c.title} ${c.text}`));
  const avg = docs.reduce((n,d) => n+d.length,0)/Math.max(1,docs.length);
  const df = new Map<string, number>(); for (const d of docs) for (const w of new Set(d)) df.set(w,(df.get(w)??0)+1);
  const named = new Set(tok((task.match(/\b[A-Z][\w]*\b/g) ?? []).join(' ')));
  const k1 = config.k1 ?? 1.2, b = config.b ?? .75;
  return docs.map(d => {
    const tf = new Map<string, number>(); for (const w of d) tf.set(w,(tf.get(w)??0)+1);
    return query.reduce((sum,q) => {
      const f = tf.get(q)??0; if (!f) return sum;
      const weight = config.nouns ? named.has(q) ? 2 : OLD_VERBS.has(q) || /(?:ing|ed)$/.test(q) ? .5 : 1 : 1;
      return sum + weight*Math.log(1+(docs.length-df.get(q)!+.5)/(df.get(q)!+.5))*f*(k1+1)/(f+k1*(1-b+b*d.length/avg));
    },0);
  });
}
/** Returns the merged score and the lane's own base score per part. */
function frozenRank(parts: readonly FrozenPart[], task: string) {
  const config = CHAT_KEYWORD_SETTINGS;
  const words = [...new Set([task, ...parts.map(c => `${c.title} ${c.text}`)].join(' ').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2))];
  const stems = Object.fromEntries(words.map(w => [w, porterStem(w)]));
  const raw = oldScore(parts, task, stems);
  const top = Math.max(...raw, 1e-9);
  const keywords = oldKeywords(task, config.short, config.stop);
  const hits = (text: string) => keywords.filter(k => text.toLowerCase().includes(k)).length;
  const base = raw.map((s, i) => 3 * s / top + Math.min(2, hits(parts[i]!.heading) * 2) + Math.min(1, hits(`${parts[i]!.name} ${parts[i]!.front}`)));
  const sorted = (scores: number[]) => parts.map((p, i) => ({ p, s: scores[i]! })).sort((a, b) => b.s - a.s || a.p.id.localeCompare(b.p.id));
  const content = oldKeywords(task, false, 'content').filter(w => !OLD_VERBS.has(w) && !/(?:ing|ed)$/.test(w)).join(' ');
  const names = (task.match(/\b[A-Z][\w]*\b/g) ?? []).filter(w => !OLD_COMMON.has(w.toLowerCase()) && !OLD_STOP.has(w.toLowerCase())).join(' ');
  const fusion = new Map(parts.map(p => [p.id, 0]));
  const bonus = new Map<string, number>();
  [sorted(base), ...[content, names].filter(Boolean).map(q => sorted(oldScore(parts, task, stems, q)))].forEach((list, j) => {
    list.forEach(({ p, s }, r) => {
      if (s <= 0) return;
      fusion.set(p.id, fusion.get(p.id)! + (j === 0 ? 2 : 1) / (60 + r + 1));
      bonus.set(p.id, Math.max(bonus.get(p.id) ?? 0, r === 0 ? 0.05 : r < 3 ? 0.02 : 0));
    });
  });
  return parts.map((p, i) => ({ id: p.id, merged: fusion.get(p.id)! + (bonus.get(p.id) ?? 0), base: base[i]! }));
}

describe('streaming read', () => {
  it('keeps the previous reader\'s parts, scores and order on a small fixture', async () => {
    const texts = [
      'Alice runs beside the river with S3 backups.',
      'Alice prefers walking beside the lake.',
      'Bob manages S3 and EC2 backups.',
      'unrelated breakfast notes',
      'the S3 runbook says snapshot first',
    ];
    const directory = await transcript('codex', texts.map((text, index) =>
      message('codex', index % 2 === 0 ? 'user' : 'assistant', text)));
    const task = 'Where does Alice run her S3 backups?';
    const result = await read('codex', directory, {}, { task });
    // The whole fixture must arrive: each message is one part.
    expect(result.candidates.map((candidate) => candidate.text).sort())
      .toEqual([...texts].sort());
    const expected = new Map(frozenRank(
      result.candidates.map((candidate) => ({
        id: candidate.id, title: candidate.title, text: candidate.text,
        heading: '', name: '', front: '',
      })),
      task,
    ).map((entry) => [entry.id, entry]));
    const order = [...expected.values()]
      .sort((a, b) => b.merged - a.merged || a.id.localeCompare(b.id))
      .map((entry) => entry.id);
    expect(result.candidates.map((candidate) => candidate.id)).toEqual(order);
    for (const candidate of result.candidates) {
      const want = expected.get(candidate.id)!;
      expect(candidate.signals['keyword']).toBe(want.merged);
      expect(candidate.laneScore).toBe(want.base);
    }
  });

  it('narrows inside the read only when the pick resolves wholeLanes off', async () => {
    const directory = await transcript('codex', [
      message('codex', 'user', 'battery backup schedule decided'),
      message('codex', 'assistant', 'unrelated breakfast'),
      message('codex', 'user', 'battery cells degrade'),
      message('codex', 'assistant', 'a fourth note'),
    ]);
    const uncut = await read('codex', directory, {}, { task: 'battery' });
    expect(uncut.laneCutApplied).toBeUndefined();
    expect(uncut.candidates).toHaveLength(4);
    const cut = await read('codex', directory, {}, { task: 'battery', wholeLanes: false });
    expect(cut.laneCutApplied).toBe(true);
    expect(cut.matched).toBe(4);
    // Two parts carry the task term and score above the bend; the two
    // zero-scored parts are dropped, so the cut provably removed some.
    expect(cut.candidates).toHaveLength(2);
    expect(cut.candidates.map((candidate) => candidate.text).sort())
      .toEqual(['battery backup schedule decided', 'battery cells degrade']);
    expect(cut.candidates.every((candidate) => candidate.laneScore !== undefined)).toBe(true);
  });

  it('scores the same parts from the index postings as a full rescan', async () => {
    const directory = await transcript('codex', [
      message('codex', 'user', 'battery backup schedule decided'),
      message('codex', 'assistant', 'unrelated breakfast'),
      message('codex', 'user', 'battery cells degrade over winter'),
      message('codex', 'assistant', 'a fourth note about nothing'),
    ]);
    // 'session-one' hits every part's title, 'battery' only some texts:
    // the postings path must score exactly the parts the rescan scores.
    const request = { task: 'battery session-one' };
    const dense = await chat({ providers: ['codex'], paths: [directory], index: false }).read(request);
    const sparse = await chat({ providers: ['codex'], paths: [directory] }).read(request);
    if (dense.status !== 'read' || sparse.status !== 'read') throw new Error('Expected reads');
    const shape = (result: typeof dense) => result.candidates.map((candidate) =>
      [candidate.id, candidate.laneScore, candidate.signals] as const);
    expect(shape(sparse)).toEqual(shape(dense));
  });

  it('marks the parts the cut would drop when a read keeps whole lanes', async () => {
    const directory = await transcript('codex', [
      message('codex', 'user', 'we said battery backup schedule decided'),
      message('codex', 'assistant', 'we said unrelated breakfast'),
      message('codex', 'user', 'we said battery cells degrade'),
      message('codex', 'assistant', 'we said a fourth note'),
    ]);
    // Score the current part so this test keeps its two-level curve
    // when the embedder also receives the previous part as context.
    const embed = async (texts: readonly string[]) => texts.map((text) => (text.split('\n').at(-1)!.includes('battery') ? [1, 0] : [0, 1]));
    const source = chat({ providers: ['codex'], paths: [directory] });
    const lanes: CandidateReadRequest[] = [
      { task: 'battery' },
      { task: 'we said', phraseLane: true, topic: 'battery' },
      { task: 'battery', meaningLane: { embed } },
    ];
    for (const lane of lanes) {
      const [bare, cut, whole] = await Promise.all([undefined, false, true].map((wholeLanes) =>
        source.read({ ...lane, ...(wholeLanes === undefined ? {} : { wholeLanes }) })));
      if (bare?.status !== 'read' || cut?.status !== 'read' || whole?.status !== 'read') throw new Error('Expected a read');
      // The same parts as a plain read, with the parts a cut read leaves out marked.
      expect(whole.candidates.map((candidate) => candidate.id)).toEqual(bare.candidates.map((candidate) => candidate.id));
      expect(bare.candidates.filter((candidate) => candidate.pastLaneCut !== undefined)).toEqual([]);
      const kept = new Set(cut.candidates.map((candidate) => candidate.id));
      expect(kept.size).toBeGreaterThan(0);
      expect(kept.size).toBeLessThan(whole.candidates.length);
      expect(whole.candidates.filter((candidate) => candidate.pastLaneCut === true).map((candidate) => candidate.id))
        .toEqual(whole.candidates.filter((candidate) => !kept.has(candidate.id)).map((candidate) => candidate.id));
      if ('meaningLane' in lane) {
        // A caller that uses whole candidates only inside the bend gets those alone, with every score still listed.
        const lean = await source.read({ ...lane, wholeLanes: true, keptBodiesOnly: true });
        if (lean.status !== 'read') throw new Error('Expected a read');
        expect(lean.meaningScores).toEqual(whole.meaningScores);
        expect(lean.candidates).toEqual(whole.candidates.filter((candidate) => candidate.pastLaneCut !== true));
        expect([lean.matched, lean.complete]).toEqual([whole.matched, whole.complete]);
      }
    }
  });

  it('embeds a reply with the previous part in its file and preserves its own decision text', async () => {
    const directory = await transcript('codex', [
      message('codex', 'assistant', 'Did you choose the red bicycle?'),
      message('codex', 'user', 'Yes, that one.'),
    ], undefined, 'a-first');
    await transcript('codex', [message('codex', 'user', 'unrelated breakfast')], directory, 'b-next');
    const embedded: string[] = [];
    const embed = async (texts: readonly string[]) => texts.map((text) => {
      embedded.push(text);
      return text === 'bicycle purchase' || text === 'Did you choose the red bicycle?\nYes, that one.' ? [1, 0] : [0, 1];
    });
    const source = chat({ providers: ['codex'], paths: [directory] });
    const result = await source.read({ task: 'bicycle purchase', wholeLanes: false, meaningLane: { embed } });
    if (result.status !== 'read') throw new Error('Expected a read');
    expect(embedded).toEqual(['bicycle purchase', 'Did you choose the red bicycle?', 'Did you choose the red bicycle?\nYes, that one.', 'unrelated breakfast']);
    expect(result.candidates.map((candidate) => candidate.text)).toEqual(['Yes, that one.']);
    const keywords = await source.read({ task: 'bicycle purchase', wholeLanes: false });
    if (keywords.status !== 'read') throw new Error('Expected a read');
    expect(keywords.candidates.some((candidate) => candidate.text === 'Yes, that one.')).toBe(false);
  });

  it('serves a phrase lane by matching the exact phrase without scoring', async () => {
    const directory = await transcript('codex', [
      message('codex', 'user', 'we need to ship Friday'),
      message('codex', 'assistant', 'we need to ship Friday and we need to rest'),
      message('codex', 'user', 'the phrase is absent here'),
    ]);
    const result = await read('codex', directory, {}, { task: 'we need to', phraseLane: true });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((candidate) => candidate.laneScore)).toEqual([2, 1]);
    expect(result.candidates.every((candidate) => Object.keys(candidate.signals).join(',') === 'phrase')).toBe(true);
  });

  it('keeps heap roughly flat over a generated history of 75,500 messages', { timeout: 300_000 }, async () => {
    const directory = await folder();
    const sessions = join(directory, '2026/10/02');
    await mkdir(sessions, { recursive: true });
    const perFile = 500;
    const files = 151;
    // Every message mixes the 'filler words' anchor with generated words
    // no other message shares, so the corpus vocabulary (over 13 million
    // distinct words) far exceeds what the stem cache retains: a cache
    // that grew with the vocabulary would show in the heap samples. The
    // anchor recurs every ~38 words, inside any 700-character part, so
    // the kind lane still matches every part.
    const padding = (index: number) => {
      const words: string[] = [];
      for (let chunk = 0; chunk < 5; chunk += 1) {
        words.push('filler', 'words');
        for (let word = 0; word < 36; word += 1) {
          words.push(`vocab${index * 180 + chunk * 36 + word}`);
        }
      }
      return words.join(' ');
    };
    for (let file = 0; file < files; file += 1) {
      const lines: string[] = [];
      for (let row = 0; row < perFile; row += 1) {
        const index = file * perFile + row;
        const text = row % 100 === 0 ? `battery backup note ${file}-${row}` : `routine note ${file}-${row}`;
        lines.push(JSON.stringify(message('codex', row % 2 === 0 ? 'user' : 'assistant', `${text} ${padding(index)}`)));
      }
      await writeFile(join(sessions, `session-${String(file).padStart(4, '0')}.jsonl`), `${lines.join('\n')}\n`);
    }
    const embed = async (texts: readonly string[]) =>
      texts.map((text) => (text.includes('battery backup') ? [1, 0] : [0, 1]));
    const source = chat({ providers: ['codex'], paths: [directory] });
    const samples: number[] = [];
    const timer = setInterval(() => samples.push(process.memoryUsage().heapUsed), 5);
    let result: Awaited<ReturnType<ReturnType<typeof chat>['read']>>;
    let kindResult: typeof result;
    let meaningResult: typeof result;
    try {
      result = await source.read({ task: 'battery backup', wholeLanes: false });
      // A kind lane matches 'filler words' in every part and must rank
      // the matches by the topic, never buffer every matched body; the
      // meaning lane likewise scores and releases each batch.
      kindResult = await source.read({
        task: 'filler words', phraseLane: true, topic: 'battery backup', wholeLanes: false,
      });
      meaningResult = await source.read({
        task: 'battery backup', wholeLanes: false, meaningLane: { embed },
      });
    } finally {
      clearInterval(timer);
    }
    samples.push(process.memoryUsage().heapUsed);
    for (const lane of [result, kindResult, meaningResult]) {
      expect(lane.status).toBe('read');
      if (lane.status !== 'read') throw new Error('Expected a read');
      expect(lane.laneCutApplied).toBe(true);
    }
    if (result.status !== 'read' || kindResult.status !== 'read'
      || meaningResult.status !== 'read') return;
    // Every message holds about 2 KB, so the split cap turns the
    // 75,500 messages into more candidate parts; the counts prove the
    // whole history was scored before the lane cuts.
    expect(result.matched).toBeGreaterThanOrEqual(perFile * files);
    expect(kindResult.matched).toBeGreaterThanOrEqual(perFile * files);
    expect(kindResult.candidates.every((candidate) =>
      (candidate.signals['phrase'] ?? 0) > 0 && (candidate.signals['keyword'] ?? 0) > 0)).toBe(true);
    expect(meaningResult.meaningLane).toBe(true);
    expect(meaningResult.matched).toBeGreaterThanOrEqual(perFile * files);
    expect(meaningResult.candidates.length).toBeGreaterThan(0);
    expect(meaningResult.candidates.every((candidate) => candidate.signals['similarity'] === 1)).toBe(true);
    const peak = Math.max(...samples);
    expect(peak).toBeLessThan(1024 * 1024 * 1024);
  });

  it('emits nothing for a lane that scores zero beside a lane that scored', async () => {
    const directory = await transcript('codex', [
      message('codex', 'user', 'S3 backup recovery steps'),
      message('codex', 'assistant', 'unrelated breakfast chatter'),
    ]);
    const cut = await read('codex', directory, {}, { task: 'zxq unmatched words', wholeLanes: false });
    // A zero-score lane keeps no candidates at all: no part's body is
    // read back or held.
    expect(cut.candidates).toEqual([]);
    expect(cut.matched).toBe(2);
    expect(cut.laneCutApplied).toBe(true);

    const decide: PickDecide = async (batch) => Object.fromEntries(
      batch.questions.map((q) => [q.key, { status: 'answered' as const, probability: 0.9 }]));
    const picked = await pickFromSources([keywordChat({ paths: [directory], providers: ['codex'] })], {
      task: 'S3 backup recovery', searchLines: ['zxq unmatched words'],
    }, { ...uncutPick, task: 'S3 backup recovery', decide });
    const laneRead = picked.reads[0]!;
    if (laneRead.status !== 'read') throw new Error('read failed');
    expect(laneRead.lanes).toEqual([
      { task: 'S3 backup recovery', lane: 'search', read: 2, kept: 1 },
      { task: 'zxq unmatched words', lane: 'search', read: 2, kept: 0 },
    ]);
    // The zero lane's parts hold no place in the union at all.
    expect(laneRead.candidates.map((candidate) => candidate.text)).toEqual(['S3 backup recovery steps']);
    expect(laneRead.noSearchMatch).toBeUndefined();
  });

  it('keeps nothing and records no search match on a 75,000-part history that matches nothing', { timeout: 300_000 }, async () => {
    const directory = await folder();
    const sessions = join(directory, '2026/10/02');
    await mkdir(sessions, { recursive: true });
    // 1,500 messages of about 900 characters in each file: two parts
    // each, 75,000 parts over 25 files.
    const text = `routine note ${'filler words only '.repeat(50)}`;
    const lines: string[] = [];
    for (let row = 0; row < 1500; row += 1) {
      lines.push(JSON.stringify(message('codex', 'user', `${text} ${row}`)));
    }
    const body = `${lines.join('\n')}\n`;
    for (let file = 0; file < 25; file += 1) {
      await writeFile(join(sessions, `session-${String(file).padStart(4, '0')}.jsonl`), body);
    }
    const decide: PickDecide = async (batch) => Object.fromEntries(
      batch.questions.map((q) => [q.key, { status: 'answered' as const, probability: 0.9 }]));
    let peak = process.memoryUsage().heapUsed;
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 10);
    let result;
    try {
      result = await pickFromSources([keywordChat({ providers: ['codex'], paths: [directory] })],
        { task: 'qxzwv no such terms anywhere' },
        { ...uncutPick, task: 'qxzwv no such terms anywhere', decide });
    } finally {
      clearInterval(timer);
    }
    expect(peak).toBeLessThan(1024 * 1024 * 1024);
    const laneRead = result.reads[0]!;
    if (laneRead.status !== 'read') throw new Error('read failed');
    expect(laneRead.matched).toBe(75_000);
    expect(laneRead.candidates).toEqual([]);
    expect(laneRead.noSearchMatch).toBe(true);
    expect(laneRead.lanes).toEqual([{ task: 'qxzwv no such terms anywhere', lane: 'search', read: 75_000, kept: 0 }]);
    expect(result.selected).toEqual([]);
  });
});

describe('stored index', () => {
  const embed = async (texts: readonly string[]) =>
    texts.map((text) => (text.includes('backup') ? [1, 0] : [0, 1]));
  const task = 'Where did Alice run the S3 backup?';
  // Every lane a pick sends a reader: the task and a search line, the
  // uncut pool, a limit, a phrase and a name, a kind, the task period, a
  // meaning query, and a time zone that changes every part's title.
  const lanes: CandidateReadRequest[] = [
    { task, wholeLanes: false },
    { task: 'battery storage notes', wholeLanes: false },
    { task, wholeLanes: true },
    { task, wholeLanes: false, limit: 2 },
    { task: 'exact phrase', phraseLane: true },
    { task: 'Alice', phraseLane: true },
    { task: 'backup', phraseLane: true, topic: task, wholeLanes: false },
    { task, wholeLanes: false, taskPeriod: { from: '2026-10-01T00:00:00Z', to: '2026-10-03T00:00:00Z' } },
    { task, wholeLanes: false, meaningLane: { embed } },
    { task, wholeLanes: true, timeZone: 'Pacific/Auckland' },
  ];
  async function history(): Promise<string> {
    const directory = await folder();
    await transcript('codex', [
      message('codex', 'user', 'The S3 backup runs nightly; running backups takes an hour.'),
      message('codex', 'assistant', 'Alice restored the backup from S3 yesterday.', OLD),
      message('codex', 'user', `Battery storage notes: the exact phrase here matters. ${'Long notes about storage. '.repeat(40)}`),
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'no date' }] } },
    ], directory, 'first');
    await transcript('codex', [
      message('codex', 'user', 'Unrelated breakfast pancakes.'),
      message('codex', 'assistant', 'Battery storage notes again, and an S3 bucket.'),
    ], directory, 'second');
    await transcript('claude-code', [message('claude-code', 'user', 'Alice runs the backup by hand on Fridays.')], directory, 'third');
    return directory;
  }
  const withoutReport = (result: Awaited<ReturnType<CandidateSource['read']>>) => {
    if (result.status !== 'read') throw new Error('Expected a read');
    const { index: _index, ...rest } = result;
    return rest;
  };

  it('returns the same candidates and ranks from the stored index as from the transcripts, for every lane, on the first call and the second', { timeout: 60_000 }, async () => {
    const directory = await history();
    for (const lane of lanes) {
      const cache = await folder();
      const direct = withoutReport(await chat({ paths: [directory], index: false }).read(lane));
      expect(direct.candidates.length, JSON.stringify(lane.task)).toBeGreaterThan(0);
      const first = await chat({ paths: [directory], index: { directory: cache } }).read(lane);
      const second = await chat({ paths: [directory], index: { directory: cache } }).read(lane);
      expect(withoutReport(first), JSON.stringify(lane)).toEqual(direct);
      expect(withoutReport(second), JSON.stringify(lane)).toEqual(direct);
      if (first.status !== 'read' || second.status !== 'read') throw new Error('Expected a read');
      expect(first.index).toMatchObject({ parts: 7, added: 7, removed: 0, rebuilt: false });
      expect(second.index).toMatchObject({ parts: 7, added: 0, removed: 0, rebuilt: false });
    }
  });

  it('reads kept parts back by their own rows: every lane matches the direct read when a date window cuts into long transcripts', { timeout: 60_000 }, async () => {
    // Old turns sit between new ones, so a kept part's place in the
    // window is not its row in the stored transcript.
    const directory = await folder();
    const turn = (index: number) => [
      message('codex', 'user', `The orchard row ${index} was pruned early.`, index % 3 === 0 ? OLD : NEW),
      message('codex', 'assistant', index % 7 === 0 ? `We said the pond pump ${index} needs a filter.` : `Noted item ${index}.`,
        index % 4 === 0 ? OLD : NEW),
    ];
    await transcript('codex', Array.from({ length: 60 }, (_, index) => turn(index)).flat(), directory, 'orchard');
    await transcript('codex', Array.from({ length: 40 }, (_, index) => turn(index + 100)).flat(), directory, 'pond');
    await transcript('claude-code', [message('claude-code', 'user', 'The pond pump was replaced on Friday.')], directory, 'third');
    const embed = async (texts: readonly string[]) =>
      texts.map((text) => (text.split('\n').at(-1)!.includes('pump') ? [1, 0] : [0, 1]));
    const lanes: CandidateReadRequest[] = [
      { task: 'pond pump filter', wholeLanes: false },
      { task: 'pond pump filter', wholeLanes: true },
      { task: 'orchard pruned', wholeLanes: false, limit: 5 },
      { task: 'we said', phraseLane: true, topic: 'pond pump', wholeLanes: false },
      { task: 'we said', phraseLane: true, topic: 'pond pump', wholeLanes: true },
      { task: 'pond pump', wholeLanes: false, meaningLane: { embed } },
      { task: 'pond pump', wholeLanes: true, meaningLane: { embed } },
      { task: 'pond pump', wholeLanes: true, keptBodiesOnly: true, meaningLane: { embed } },
    ];
    const cache = await folder();
    const options = { paths: [directory], since: '2026-09-15T00:00:00Z' };
    // One shared context for the indexed lanes, as a pick gives its readers.
    const context = { files: new Map(), shared: new Map() };
    const indexed = chat({ ...options, index: { directory: cache } });
    for (const lane of lanes) {
      const direct = withoutReport(await chat({ ...options, index: false }).read(lane));
      expect(direct.candidates.length, JSON.stringify(lane)).toBeGreaterThan(0);
      expect(direct.candidates.every((candidate) => candidate.text.length > 0)).toBe(true);
      expect(withoutReport(await indexed.read(lane, context)), JSON.stringify(lane)).toEqual(direct);
      expect(withoutReport(await chat({ ...options, index: { directory: cache } }).read(lane)), JSON.stringify(lane)).toEqual(direct);
    }
  });

  it('reads only the new bytes of a transcript that grew, and reads an edited one again whole', async () => {
    const directory = await folder();
    const cache = await folder();
    const file = join(directory, '2026/10/02/grown.jsonl');
    const filler = (index: number) => `background message ${index} ${'about nothing in particular '.repeat(20)}`;
    await transcript('codex', Array.from({ length: 20 }, (_, index) => message('codex', 'user', filler(index))), directory, 'grown');
    const source = () => chat({ providers: ['codex'], paths: [directory], index: { directory: cache } });
    const before = await source().read({ task: 'orchard harvest', wholeLanes: false });
    if (before.status !== 'read') throw new Error('Expected a read');
    expect(before.index).toMatchObject({ added: 20 });
    const size = (await stat(file)).size;

    fileReads.length = 0;
    rangeReads.length = 0;
    const line = `${JSON.stringify(message('codex', 'user', 'The orchard harvest starts on Monday.'))}\n`;
    await appendFile(file, line);
    const grown = await source().read({ task: 'orchard harvest', wholeLanes: false });
    if (grown.status !== 'read') throw new Error('Expected a read');
    expect(grown.candidates.map((candidate) => candidate.text)).toEqual(['The orchard harvest starts on Monday.']);
    expect(grown.index).toMatchObject({ parts: 21, added: 1, removed: 0 });
    // The transcript was never read whole: its first and last indexed
    // kilobyte, checked unchanged, and the appended line are all it read.
    const grownFile = (path: string) => path.endsWith('/2026/10/02/grown.jsonl');
    expect(fileReads.filter(grownFile)).toEqual([]);
    const read = rangeReads.filter((entry) => grownFile(entry.file)).reduce((sum, entry) => sum + entry.bytes, 0);
    expect(read).toBe(1024 + 1024 + Buffer.byteLength(line));
    expect(read).toBeLessThan(size);

    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace('background message 3 ', 'background message 3 orchard '));
    fileReads.length = 0;
    const edited = await source().read({ task: 'orchard harvest', wholeLanes: false });
    if (edited.status !== 'read') throw new Error('Expected a read');
    expect(fileReads.filter(grownFile)).toHaveLength(1);
    expect(edited.index).toMatchObject({ parts: 21, added: 21, removed: 21 });
    expect(edited.candidates.map((candidate) => candidate.text)).toContain('The orchard harvest starts on Monday.');
  });

  it('drops a removed transcript and reads a new one', async () => {
    const directory = await folder();
    const cache = await folder();
    await transcript('codex', [message('codex', 'user', 'orchard one')], directory, 'one');
    await transcript('codex', [message('codex', 'user', 'orchard two')], directory, 'two');
    const source = () => chat({ providers: ['codex'], paths: [directory], index: { directory: cache } });
    await source().read({ task: 'orchard' });
    await rm(join(directory, '2026/10/02/one.jsonl'));
    await transcript('codex', [message('codex', 'user', 'orchard three')], directory, 'three');
    const after = await source().read({ task: 'orchard' });
    if (after.status !== 'read') throw new Error('Expected a read');
    expect(after.candidates.map((candidate) => candidate.text).sort()).toEqual(['orchard three', 'orchard two']);
    expect(after.index).toMatchObject({ parts: 2, added: 1, removed: 1 });
  });

  it('never returns a path the request excludes and never writes one its own exclude names', async () => {
    const directory = await folder();
    const cache = await folder();
    await transcript('codex', [message('codex', 'user', 'orchard kept')], directory, 'kept');
    await transcript('codex', [message('codex', 'user', 'orchard hidden')], directory, 'hidden');
    await transcript('codex', [message('codex', 'user', 'orchard asked away')], directory, 'asked');
    fileReads.length = 0;
    const result = await chat({
      providers: ['codex'], paths: [directory], exclude: ['2026/10/02/hidden.jsonl'], index: { directory: cache },
    }).read({ task: 'orchard', exclude: ['2026/10/02/asked.jsonl'] });
    if (result.status !== 'read') throw new Error('Expected a read');
    expect(result.candidates.map((candidate) => candidate.text)).toEqual(['orchard kept']);
    // Neither excluded transcript was opened, and the file holds neither.
    expect(fileReads.filter((file) => /(?:hidden|asked)\.jsonl$/.test(file))).toEqual([]);
    const [name] = (await readdir(cache)).filter((entry) => entry.endsWith('.sqlite'));
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const database = new DatabaseSync(join(cache, name!));
    try {
      expect((database.prepare('SELECT path FROM transcripts').all() as { path: string }[]).map((row) => row.path)).toEqual(['2026/10/02/kept.jsonl']);
      expect(database.prepare("SELECT COUNT(*) AS n FROM parts WHERE text LIKE '%hidden%' OR text LIKE '%asked%'").get())
        .toEqual({ n: 0 });
    } finally {
      database.close();
    }
  });

  it('reports what each update did in the pick record, by source id', async () => {
    const directory = await history();
    const cache = await folder();
    const decide: PickDecide = async (batch) => Object.fromEntries(
      batch.questions.map((q) => [q.key, { status: 'answered' as const, probability: 0.9 }]));
    const pick = () => pickFromSources([keywordChat({ id: 'chat:fixture', paths: [directory], index: { directory: cache } })],
      { task, searchLines: ['battery storage notes'] }, { ...uncutPick, task, decide });
    const first = await pick();
    expect(first.record.index?.['chat:fixture']).toMatchObject({ parts: 7, added: 7, removed: 0, rebuilt: false });
    const second = await pick();
    expect(second.record.index?.['chat:fixture']).toMatchObject({ parts: 7, added: 0, removed: 0, rebuilt: false });
    expect(second.selected.map((part) => part.id)).toEqual(first.selected.map((part) => part.id));
  });

  it('walks the transcript folders once for every read of one call that shares a read context, at every part size', async () => {
    const directory = await history();
    const cache = await folder();
    const root = await realpath(directory);
    const source = chat({ providers: ['codex'], paths: [directory], index: { directory: cache } });
    const sized = [700, 300].flatMap((maxQuestionText) => lanes.map((lane) => ({ ...lane, maxQuestionText })));
    const walks = async (context?: { files: Map<string, Promise<string>> }) => {
      folderReads.length = 0;
      const results = [];
      // Each update of the index makes its own report.
      const updates = new Set<unknown>();
      for (const lane of sized) {
        const result = await source.read(lane, context);
        if (result.status === 'read') updates.add(result.index);
        results.push(withoutReport(result));
      }
      return { results, walks: folderReads.filter((path) => path === root).length, updates: updates.size };
    };
    const shared = await walks({ files: new Map() });
    expect(shared.walks).toBe(1);
    // One update for each part size.
    expect(shared.updates).toBe(2);
    // Each part size keeps its own index file.
    expect((await readdir(cache)).filter((name) => name.endsWith('.sqlite'))).toHaveLength(2);
    // Without a context each read brings the index up to date alone.
    const alone = await walks();
    expect(alone.walks).toBe(sized.length);
    expect(alone.updates).toBe(sized.length);
    expect(shared.results).toEqual(alone.results);
    // The sizes cut the long message differently.
    expect(shared.results[lanes.length + 2]).not.toEqual(shared.results[2]);
  });

  it('writes no file with index false', async () => {
    const directory = await history();
    const cache = await folder();
    const result = await chat({ paths: [directory], index: false }).read({ task });
    if (result.status !== 'read') throw new Error('Expected a read');
    expect(result.index).toBeUndefined();
    expect(await readdir(cache)).toEqual([]);
  });
});
