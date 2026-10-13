import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { pickFromSources, type CandidateReadRequest } from '@curatejs/core';
import { chat, type ChatProvider } from '../src/index.js';
import { rankChat } from '../src/chat-rank.js';
import { porterStem } from '../src/porter.js';

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
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

  it('preserves message parts, roles, session ids and dates', async () => {
    const directory = await transcript(provider, [message(provider, 'user', 'A user request'), message(provider, 'assistant', 'An assistant reply')]);
    const result = await read(provider, directory);
    expect(result.complete).toBe(true);
    expect(result.candidates.map((candidate) => candidate.chat?.role).sort()).toEqual(['assistant', 'user']);
    for (const candidate of result.candidates) {
      expect(candidate.chat).toMatchObject({ provider, sessionId: 'session-one' });
      expect(candidate.role).toBe('reference');
      expect(candidate.date).toEqual({ value: '2026-10-02T12:00:00.000Z', meaning: 'recorded' });
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

  it('passes every part to the picker within its text budget', async () => {
    const text = 'hello world\n'.repeat(20);
    const directory = await transcript('codex', [message('codex', 'user', text)]);
    const seen: string[] = [];
    const result = await pickFromSources([chat({ paths: [directory], providers: ['codex'] })], { task: 'hello' }, {
      task: 'hello', limits: { maxQuestionText: 50 },
      decide: async (batch) => {
        seen.push(...batch.questions.map((question) => question.text));
        return Object.fromEntries(batch.questions.map((question) => [question.key, { status: 'answered', probability: 1 }]));
      },
    });
    expect(result.selected.length).toBeGreaterThan(1);
    expect(seen.every((part) => part.length <= 50)).toBe(true);
    expect(seen.join('')).toBe(text);
    expect(result.record.candidates.every((candidate) => !candidate.truncated)).toBe(true);
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

it('allows keyword overrides without changing the chat defaults', () => {
  const parts = () => [{ id: 'a', title: '', text: 'run', heading: '', name: '', front: '', score: 0 }];
  const normal = parts();
  const overridden = parts();
  rankChat(normal, 'running');
  rankChat(overridden, 'running', { stem: false });
  expect(normal[0]!.score).toBeGreaterThan(0);
  expect(overridden[0]!.score).toBe(0);
});
