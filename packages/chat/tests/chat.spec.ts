import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { pickFromSources, type CandidateReadRequest, type PickDecide } from '@curatejs/core';
import { chat, type ChatProvider } from '../src/index.js';
import { CHAT_KEYWORD_SETTINGS, rankChat } from '../src/chat-rank.js';
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
    const result = await pickFromSources([chat({ paths: [directory], providers: ['codex'] })], { task: 'hello', wholeLanes: true }, {
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

  it('records no search match and keeps nothing when no part scores', async () => {
    const directory = await transcript('codex', [
      message('codex', 'user', 'my dog is Rex'),
      message('codex', 'assistant', 'noted, Rex is a good name'),
    ]);
    const seen: string[] = [];
    const result = await pickFromSources([chat({ paths: [directory], providers: ['codex'] })], { task: "What's my dog's name?" }, {
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
    const picked = await pickFromSources([chat({ paths: [directory], providers: ['codex'] })], {
      task: 'S3 backup recovery', searchLines: ['zxq unmatched words'],
    }, { task: 'S3 backup recovery', decide });
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
      result = await pickFromSources([chat({ providers: ['codex'], paths: [directory] })],
        { task: 'qxzwv no such terms anywhere' },
        { task: 'qxzwv no such terms anywhere', decide });
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
