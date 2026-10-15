import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { curate, pickFromSources, type CandidateReadRequest, type CandidateSource, type MemoryCandidate } from '@curatejs/core';
import { chat } from '@curatejs/chat';
import { gitHistory } from '@curatejs/git';
// @ts-expect-error The standalone JavaScript command has no type declarations.
import { allowedSession, curationEvidence, decisionAnswers, jevRequest, pickFullSources, rankMatches, parseArgs, parseSearches, parseSources, run, searchSource, sessionHeader, snapshotCodex } from '../skills/curate/run.mjs';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, copyFile: vi.fn(actual.copyFile), readFile: vi.fn(actual.readFile) };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const realSpawn = vi.mocked(spawn).getMockImplementation()!;
const directories: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  vi.mocked(spawn).mockImplementation(realSpawn);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function folder() {
  const directory = await mkdtemp(join(tmpdir(), 'curate-skill-'));
  directories.push(directory);
  return directory;
}
const metadata = (cwd: unknown) => ({ type: 'session_meta', payload: { id: 'session', cwd } });
const message = {
  type: 'response_item', timestamp: '2026-01-01T12:00:00Z',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Useful orchard evidence.' }] },
};

describe('curate command input', () => {
  it('joins task words and resolves an explicit sources file', () => {
    expect(parseArgs(['find', '--sources', 'sources.json', 'orchards'])).toEqual({
      sources: resolve('sources.json'), task: 'find orchards',
    });
    expect(parseArgs(['  find orchards  ']).task).toBe('find orchards');
    expect(parseArgs(['--sources', '~/sources.json', 'find orchards']).sources).toBe(join(homedir(), 'sources.json'));
  });

  it.each([[], ['  '], ['--sources'], ['--sources', '--unknown', 'task'], ['--unknown', 'task']].map((args) => ({ args })))('rejects invalid arguments $args', ({ args }) => {
    expect(() => parseArgs(args)).toThrow();
  });

  it('keeps source settings and resolves each explicit path', () => {
    expect(parseSources({
      sources: [
        { type: 'codex', path: 'sessions', allowedCwd: 'projects' },
        { type: 'claude-code', path: 'transcripts' },
        { type: 'git', path: 'repository' },
        { type: 'markdown', path: 'documents' },
      ], threshold: 0,
    })).toEqual({
      sources: [
        { type: 'codex', path: resolve('sessions'), allowedCwd: resolve('projects') },
        { type: 'claude-code', path: resolve('transcripts') },
        { type: 'git', path: resolve('repository') },
        { type: 'markdown', path: resolve('documents') },
      ], threshold: 0,
    });
  });

  it.each([
    null, {}, { sources: [] }, { sources: [null] },
    { sources: [{ type: 'unknown', path: 'sessions' }] },
    { sources: [{ type: 'markdown', path: ' ' }] },
    { sources: [{ type: 'codex', path: 'sessions' }] },
    { sources: [{ type: 'codex', path: 'sessions', allowedCwd: ' ' }] },
    { sources: [{ type: 'codex', path: 'sessions', allowedCwd: 1 }] },
  ])('rejects invalid source settings %j', (value) => {
    expect(() => parseSources(value)).toThrow();
  });

  it.each([-1, 1.1, NaN, Infinity, '0.5'])('rejects threshold %s', (threshold) => {
    expect(() => parseSources({ sources: [{ type: 'markdown', path: 'documents' }], threshold })).toThrow();
  });

  it.each(['maxCandidates', 'userMaxCandidates'])('rejects an old feed limit in %s', (key) => {
    expect(() => parseSources({ sources: [{ type: 'markdown', path: 'documents' }], [key]: 150 })).toThrow('no count limit');
  });

  it.each(['userFirst', 'recentFirst'])('requires a boolean for %s', (key) => {
    expect(() => parseSources({ sources: [{ type: 'markdown', path: 'documents' }], [key]: 'true' })).toThrow();
    expect(parseSources({ sources: [{ type: 'markdown', path: 'documents' }], [key]: false })[key]).toBe(false);
  });
});

describe('Codex session folder restrictions', () => {
  it('admits only real folders strictly inside the allowed root', async () => {
    const directory = await folder();
    const root = join(directory, 'projects');
    const child = join(root, 'project');
    const sibling = join(directory, 'projects-other');
    const outside = join(directory, 'outside');
    await Promise.all([child, sibling, outside].map((path) => mkdir(path, { recursive: true })));
    await symlink(outside, join(root, 'escape'));
    await symlink(child, join(directory, 'alias'));

    expect(await allowedSession(metadata(child), root)).toBe(true);
    expect(await allowedSession(metadata(join(directory, 'alias')), root)).toBe(true);
    for (const cwd of [root, sibling, outside, join(root, 'escape'), join(root, 'missing')]) {
      expect(await allowedSession(metadata(cwd), root), cwd).toBe(false);
    }
  });

  it.each([
    null, {}, [], { type: 'response_item', payload: { cwd: '/project' } },
    { type: 'session_meta' }, { type: 'session_meta', payload: null },
    metadata(null), metadata(1), metadata(''), metadata('project'),
  ])('rejects missing or invalid metadata %j', async (header) => {
    expect(await allowedSession(header, await folder())).toBe(false);
  });

  it('reads exactly the header bytes and newline despite an invalid body', async () => {
    const directory = await folder();
    const file = join(directory, 'session.jsonl');
    const header = metadata(join(directory, 'project'));
    const line = JSON.stringify(header);
    await writeFile(file, `${line}\nFORBIDDEN BODY is not JSON\n`);

    expect(sessionHeader(file)).toEqual(header);
    const reads = vi.mocked(readSync).mock.calls;
    expect(reads).toHaveLength(Buffer.byteLength(line) + 1);
    expect(reads.every((call) => (call as unknown[])[3] === 1)).toBe(true);
  });

  it('does not look for valid metadata after an invalid first line', async () => {
    const directory = await folder();
    const file = join(directory, 'session.jsonl');
    await writeFile(file, `invalid\n${JSON.stringify(metadata(directory))}\n`);
    expect(sessionHeader(file)).toBeNull();
    expect(vi.mocked(readSync).mock.calls).toHaveLength('invalid\n'.length);
  });

  it('reads only admitted snapshot copies despite new sessions and changed originals', async () => {
    const directory = await folder();
    const root = join(directory, 'projects');
    const child = join(root, 'project');
    const sessions = join(directory, 'sessions');
    const nested = join(sessions, '2026', '01');
    const sibling = join(directory, 'projects-other');
    await Promise.all([child, nested, sibling].map((path) => mkdir(path, { recursive: true })));
    await symlink(sibling, join(root, 'escape'));
    const allowed = join(nested, 'allowed.jsonl');
    await writeFile(allowed, `${JSON.stringify(metadata(child))}\n${JSON.stringify(message)}\n`);
    const rejected = [
      ['sibling', metadata(sibling)], ['root', metadata(root)], ['escape', metadata(join(root, 'escape'))],
      ['missing', {}], ['invalid', null],
    ].map(([name, header]) => ({ file: join(nested, `${name}.jsonl`), header }));
    for (const { file, header } of rejected) {
      await writeFile(file, `${JSON.stringify(header)}\nFORBIDDEN BODY is not JSON\n`);
    }
    const linkedFile = join(sessions, 'linked.jsonl');
    const linkedFolder = join(sessions, 'linked-folder');
    await symlink(allowed, linkedFile);
    await symlink(nested, linkedFolder);
    await writeFile(join(sessions, 'ignored.txt'), 'not a session');

    const snapshot = join(directory, 'snapshot');
    const { filter, source }: { filter: { admitted: string[]; excluded: string[] }; source: CandidateSource } =
      await snapshotCodex({ type: 'codex', path: sessions, allowedCwd: root }, snapshot);
    expect(filter.admitted).toEqual([allowed]);
    expect(filter.excluded.sort()).toEqual(rejected.map(({ file }) => file).sort());
    expect(vi.mocked(copyFile).mock.calls.map((call) => call.slice(0, 2))).toEqual([
      [allowed, join(snapshot, '2026', '01', 'allowed.jsonl')],
    ]);
    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
    await writeFile(join(nested, 'late-excluded.jsonl'), `${JSON.stringify(metadata(sibling))}\nFORBIDDEN BODY is not JSON\n`);
    await writeFile(join(nested, 'late-allowed.jsonl'), `${JSON.stringify(metadata(child))}\n${JSON.stringify(message)}\n`);
    await writeFile(allowed, `${JSON.stringify(metadata(sibling))}\nCHANGED BODY is not JSON\n`);

    const result = await source.read({ task: 'orchard evidence' });
    expect(result.status).toBe('read');
    if (result.status !== 'read') throw new Error('Expected an admitted session to be read.');
    expect(result.complete).toBe(true);
    expect(result.candidates.map((candidate) => candidate.text)).toEqual(['Useful orchard evidence.']);
    expect(result.candidates[0]?.chat).toMatchObject({ provider: 'codex', sessionId: 'session', role: 'user' });
    expect(result.candidates[0]?.sourceId).toBe(`chat:codex:${sessions}`);
    expect(result.candidates[0]?.id).toBe(`codex:${await realpath(sessions)}:2026/01/allowed.jsonl:2:1:1`);

    await writeFile(allowed, `${JSON.stringify(metadata(child))}\n`);
    await rm(join(nested, 'late-allowed.jsonl'));
    expect(await source.read({ task: 'orchard evidence' })).toEqual(result);
    // The read passes over the admitted copy more than once; the set of
    // opened paths is what proves nothing outside it was touched.
    expect(new Set(vi.mocked(readFile).mock.calls.map((call) => call[0]))).toEqual(
      new Set([await realpath(join(snapshot, '2026', '01', 'allowed.jsonl'))]),
    );
  });
});

describe('search output', () => {
  const searches = () => Object.fromEntries(['chat', 'git-history', 'markdown'].map((kind) => [
    kind, { keywords: ['orchard', 'fruit trees'], answers: ['The orchard has trees.', 'Fruit trees grow here.'] },
  ]));

  it('retains valid search lines for all three source kinds', () => {
    const value = searches();
    expect(parseSearches(value)).toBe(value);
  });

  it.each(['chat', 'git-history', 'markdown'])('requires both sets of search lines for %s', (kind) => {
    for (const group of [undefined, {}, { keywords: ['a'], answers: ['a', 'b'] },
      { keywords: ['a', 'b'], answers: ['a'] }, { keywords: ['a', ' '], answers: ['a', 'b'] },
      { keywords: ['a', 'b'], answers: ['a', 1] }, { keywords: 'a b', answers: ['a', 'b'] }]) {
      expect(() => parseSearches({ ...searches(), [kind]: group })).toThrow();
    }
    expect(() => parseSearches(null)).toThrow();
  });
});

it('keeps the original task and each source register while core interleaves all scores', async () => {
  const directory = await folder();
  const kinds = ['chat', 'git-history', 'markdown'] as const;
  const searches = Object.fromEntries(kinds.map((kind) => [kind, {
    keywords: [`${kind} keyword one`, `${kind} keyword two`],
    answers: [`${kind} answer one`, `${kind} answer two`, ...(kind === 'markdown' ? ['markdown answer three'] : [])],
  }]));
  const calls = new Map<string, CandidateReadRequest[]>();
  const audit: { source: string; task: string; parts: number; file: string }[] = [];
  const sources = kinds.map((kind): CandidateSource => {
    const requests: CandidateReadRequest[] = [];
    calls.set(kind, requests);
    return {
      id: kind, kind, role: 'reference',
      async read(request) {
        requests.push(request);
        return { status: 'read', complete: true, candidates: [1, 0].map((score) => ({
          id: `${request.task}:${score}`, sourceId: kind, role: 'reference', title: request.task,
          text: `Evidence for ${request.task}`, signals: { keyword: score },
        })) };
      },
    };
  });
  const asked: string[] = [];
  const result = await pickFromSources(sources.map((source) => searchSource(source, searches, audit, directory)), {
    task: 'original task', searchLines: Array.from({ length: 5 }, (_, index) => `curate-search:${index}`),
    paths: ['hint'], exclude: ['private'],
  }, {
    task: 'original task', limits: { maxCandidates: 6 },
    decide: async (batch) => {
      expect(batch.task).toBe('original task');
      asked.push(...batch.questions.map((question) => question.sourceId));
      return Object.fromEntries(batch.questions.map((question) => [question.key, { status: 'answered', probability: 1 }]));
    },
  });

  for (const kind of kinds) {
    expect(calls.get(kind)?.map((request) => request.task)).toEqual([
      'original task', ...searches[kind]!.keywords, ...searches[kind]!.answers,
    ]);
    expect(calls.get(kind)?.every((request) => request.paths?.[0] === 'hint' && request.exclude?.[0] === 'private')).toBe(true);
  }
  expect(asked.slice(0, 30)).toEqual(Array.from({ length: 10 }, () => [...kinds]).flat());
  expect(result.selected).toHaveLength(32);
  expect(result.selected.filter((candidate) => candidate.signals.keyword === 0)).toHaveLength(16);
  expect(audit).toHaveLength(16);
  expect(new Set(audit.map((entry) => entry.file)).size).toBe(16);
  for (const entry of audit) {
    const saved = JSON.parse(await readFile(join(directory, entry.file), 'utf8'));
    expect(entry.parts).toBe(2);
    expect(saved.candidates.map((candidate: { signals: { keyword: number } }) => candidate.signals.keyword)).toEqual([1, 0]);
  }
});

it('sends every matching part to decisions, including short-word corrections below rank 150', async () => {
  const directory = await folder();
  const rows = Array.from({ length: 301 }, (_, index) => JSON.stringify({
    type: index === 300 ? 'user' : 'assistant', sessionId: 'matched', timestamp: '2026-01-01T12:00:00Z',
    message: { content: index === 300 ? 'We need to keep everything.' : `We described orchard evidence ${index}.` },
  }));
  rows.push(JSON.stringify({ type: 'user', sessionId: 'unmatched', timestamp: '2026-01-01T12:00:00Z',
    message: { content: 'Breakfast pancakes.' } }));
  await writeFile(join(directory, 'session.jsonl'), rows.join('\n'));
  const source = chat({ providers: ['claude-code'], paths: [directory] });
  const searches = { chat: { keywords: ['orchard', 'We asked for orchard'], answers: ['fruit trees', 'planted trees'] } };
  const asked: string[] = [];
  const picked = await pickFullSources([searchSource(source, searches, [], directory)], {
    task: 'We need orchard evidence', searchLines: ['curate-search:0', 'curate-search:1'], laneCut: false,
  }, { task: 'We need orchard evidence', decide: async (batch: { questions: { key: string; text: string }[] }) => {
    asked.push(...batch.questions.map((question) => question.text));
    return Object.fromEntries(batch.questions.map((question) => [question.key, { status: 'answered', probability: 0.8 }]));
  } });
  expect(asked).toHaveLength(301);
  expect(asked).toContain('We need to keep everything.');
  expect((await searchSource(source, searches, [], directory).read({ task: 'We need orchard evidence', laneCut: false })).candidates[0].text)
    .toBe('We need to keep everything.');
  expect(asked).not.toContain('Breakfast pancakes.');
  expect(new Set(asked).size).toBe(301);
  expect(picked.selected).toHaveLength(301);
  expect(picked.record.candidates.every((entry: { status: string }) => entry.status === 'selected')).toBe(true);
  expect(picked.record.limits.maxCandidates).toBeUndefined();
});

it('asks sources to cut search lanes inside the reads it caches, unless the cut is off', async () => {
  const directory = await folder();
  const seen: (boolean | undefined)[] = [];
  const source: CandidateSource = { id: 'notes', kind: 'markdown', role: 'reference',
    read: async (request) => {
      seen.push(request.laneCut);
      return { status: 'read', complete: true, candidates: [{
        sourceId: 'notes', id: 'one', role: 'reference', title: 'Orchard', text: 'Orchard notes.', signals: { bm25: 1 },
      }] };
    } };
  const searches = { markdown: { keywords: ['orchard'], answers: ['trees'] } };
  const decide = async (batch: { questions: { key: string }[] }) =>
    Object.fromEntries(batch.questions.map((question) => [question.key, { status: 'answered', probability: 0.8 }]));

  await pickFullSources([searchSource(source, searches, [], directory)], {
    task: 'orchard', searchLines: ['curate-search:0'],
  }, { task: 'orchard', decide });
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((flag) => flag === true)).toBe(true);

  seen.length = 0;
  await pickFullSources([searchSource(source, searches, [], directory)], {
    task: 'orchard', laneCut: false,
  }, { task: 'orchard', decide });
  expect(seen.every((flag) => flag === false)).toBe(true);
});

it('passes caller decision limits such as maxBatchChars through to the pick', async () => {
  const directory = await folder();
  const source: CandidateSource = { id: 'notes', kind: 'markdown', role: 'reference',
    read: async () => ({ status: 'read', complete: true, candidates: [
      { sourceId: 'notes', id: 'one', role: 'reference', title: 'Orchard', text: 'Orchard notes.', signals: { bm25: 1 } },
    ] }) };

  const picked = await pickFullSources([source], { task: 'orchard' }, {
    task: 'orchard', limits: { maxBatchChars: 40 },
    decide: async (batch: { questions: { key: string }[] }) =>
      Object.fromEntries(batch.questions.map((question) => [question.key, { status: 'answered', probability: 0.8 }])),
  });

  expect(picked.record.limits.maxBatchChars).toBe(40);
});

it('sends each item’s evidence in the Jev state once and names the item in each question', () => {
  const question = (key: string, id: string, text: string, wording: string) => ({
    key, sourceId: 'commits', id, title: `title of ${id}`, text,
    date: { value: '2026-01-01', meaning: 'recorded' }, role: 'reference',
    question: wording, trueCriterion: 'yes', falseCriterion: 'no',
  });
  const batch = {
    task: 'task text',
    questions: [
      question('one.gate', 'commit one', 'FIRST BODY', 'Is it useful?'),
      question('one.rest', 'commit one', 'FIRST BODY', 'Does it say when?'),
      question('two.gate', 'commit two', 'SECOND BODY', 'Is it useful?'),
    ],
  };

  const payload = jevRequest(batch);
  const serialized = JSON.stringify(payload);
  // The item's body is on the wire once, however many of its questions
  // the batch holds: a wide cascade cannot multiply the request past
  // the batch's counted size.
  expect(serialized.match(/FIRST BODY/g)).toHaveLength(1);
  expect(serialized.match(/SECOND BODY/g)).toHaveLength(1);
  expect(payload.state).toContain('task text');
  expect(payload.state).toContain('Item 1: commit one (recorded 2026-01-01)');
  expect(payload.state).toContain('Item 2: commit two (recorded 2026-01-01)');
  expect(payload.questions).toEqual({
    q0: { type: 'noul', instructions: 'Is it useful?\n\nItem 1', criteria: { true: 'yes', false: 'no' } },
    q1: { type: 'noul', instructions: 'Does it say when?\n\nItem 1', criteria: { true: 'yes', false: 'no' } },
    q2: { type: 'noul', instructions: 'Is it useful?\n\nItem 2', criteria: { true: 'yes', false: 'no' } },
  });
});

it('sends the full long commit text rather than cutting it at the default part size', async () => {
  const directory = await folder();
  const text = 'Orchard evidence. '.repeat(100) + 'Keep the final constraint.';
  const source: CandidateSource = { id: 'commits', kind: 'git-history', role: 'reference',
    read: async () => ({ status: 'read', complete: true, candidates: [{
      sourceId: 'commits', id: 'commit abc', role: 'reference', title: 'Orchard', text, signals: { shared_words: 1 },
    }] }),
  };
  const searches = { 'git-history': { keywords: ['orchard'], answers: ['orchard trees'] } };
  await pickFullSources([searchSource(source, searches, [], directory)], { task: 'orchard' }, {
    task: 'orchard', decide: async (batch: { questions: { key: string; text: string }[] }) => {
      expect(batch.questions[0]?.text).toBe(text);
      return { [batch.questions[0]!.key]: { status: 'answered', probability: 0.8 } };
    },
  });
});

it('pins later git searches to the first read even when a new commit lands during reading', async () => {
  const directory = await folder();
  const git = (...args: string[]) => execFileSync('git', ['-C', directory,
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args]);
  git('init', '--initial-branch=main');
  await writeFile(join(directory, 'orchard.txt'), 'Trees.');
  git('add', 'orchard.txt');
  git('commit', '-m', 'Plant orchard');
  const original = git('rev-parse', 'HEAD').toString().trim();
  const source = gitHistory(directory);
  let first = true;
  const changingSource: CandidateSource = { ...source, read: async (request) => {
    const result = await source.read(request);
    if (first) {
      first = false;
      git('commit', '--allow-empty', '-m', 'Add orchard constraint');
    }
    return result;
  } };
  const searches = { 'git-history': { keywords: ['orchard'], answers: ['orchard constraint'] } };
  const picked = await pickFullSources([searchSource(changingSource, searches, [], directory)], {
    task: 'orchard', searchLines: ['curate-search:0', 'curate-search:1'],
  }, { task: 'orchard', decide: async (batch: { questions: { key: string }[] }) =>
    Object.fromEntries(batch.questions.map((question) => [question.key, { status: 'answered', probability: 0.8 }])) });
  expect(git('rev-parse', 'HEAD').toString().trim()).not.toBe(original);
  expect(picked.selected).toHaveLength(1);
  expect(picked.selected[0]?.sourceRevision).toBe(original);
  expect(picked.selected[0]?.title).toBe('Plant orchard');
  expect(picked.selected[0]?.searchRanks).toEqual([0, 0, 0]);
});

it('does not admit unrelated items just because recency or inbound links are positive', async () => {
  const directory = await folder();
  const source: CandidateSource = { id: 'notes', kind: 'markdown', role: 'reference',
    read: async () => ({ status: 'read', complete: true, candidates: [{
      sourceId: 'notes', id: 'unrelated', role: 'reference', title: 'Breakfast', text: 'Pancakes.',
      signals: { recency: 1, 'inbound-links': 2, bm25: 0 },
    }] }),
  };
  const searches = { markdown: { keywords: ['orchard'], answers: ['trees'] } };
  expect((await searchSource(source, searches, [], directory).read({ task: 'orchard' })).candidates).toEqual([]);
});

it('orders user messages first, then keyword score, then newer matching sessions at equal scores', () => {
  const candidate = (id: string, role: 'user' | 'assistant', sessionId: string, date: string, score: number): MemoryCandidate => ({
    sourceId: 'chat', id, role: 'reference', title: '', text: '',
    chat: { provider: 'claude-code', role, sessionId }, date: { value: date, meaning: 'recorded' }, signals: { keyword: score },
  });
  const items = [
    candidate('assistant', 'assistant', 'old', '2026-01-01', 10),
    candidate('a-old-user', 'user', 'old', '2026-01-01', 0),
    candidate('z-new-user', 'user', 'new', '2026-01-02', 0),
    candidate('strong-user', 'user', 'old', '2026-01-01', 1),
  ];
  expect(rankMatches(items).map((item: MemoryCandidate) => item.id)).toEqual([
    'strong-user', 'z-new-user', 'a-old-user', 'assistant',
  ]);
  expect(rankMatches(items, { recentFirst: false }).map((item: MemoryCandidate) => item.id)).toEqual([
    'strong-user', 'a-old-user', 'z-new-user', 'assistant',
  ]);
  expect(rankMatches(items, { userFirst: false }).map((item: MemoryCandidate) => item.id)).toEqual([
    'assistant', 'strong-user', 'z-new-user', 'a-old-user',
  ]);
  expect(items.every((item) => !('rankOrder' in item.signals))).toBe(true);
});

describe('decision answers', () => {
  const batch = { questions: [{ key: 'first' }, { key: 'second' }, { key: 'third' }] };

  it('maps numbered answers to question keys and preserves zero and one', () => {
    expect(decisionAnswers(batch, {
      q0: { noul: 0, probability: 0.9 }, q1: { probability: 1 }, q2: { noul: null, probability: 0.25 },
      q3: { noul: 1 },
    })).toEqual({
      first: { status: 'answered', probability: 0 }, second: { status: 'answered', probability: 1 },
      third: { status: 'answered', probability: 0.25 },
    });
  });

  it.each([undefined, null, {}, { noul: '0.5' }, { noul: -0.1 }, { noul: 1.1 },
    { noul: NaN }, { noul: Infinity }, { probability: false }])('marks unusable answers as missing: %j', (answer) => {
    expect(decisionAnswers(batch, { q0: answer })).toEqual({
      first: { status: 'missing' }, second: { status: 'missing' }, third: { status: 'missing' },
    });
  });
});

it('labels collection dates for undated evidence without changing weights or order', async () => {
  const dated: MemoryCandidate = {
    id: 'dated', sourceId: 'documents', role: 'reference', title: 'Dated evidence',
    text: 'An orchard was planted.', date: { value: '2026-01-01', meaning: 'recorded' }, signals: { keyword: 2 },
  };
  const undated: MemoryCandidate = {
    id: 'undated', sourceId: 'documents', role: 'reference', title: 'Undated evidence',
    text: 'The person prefers fruit trees.', signals: { keyword: 0 },
  };
  const picked = await pickFromSources([{
    id: 'documents', kind: 'markdown', role: 'reference',
    read: async () => ({ status: 'read', complete: true, candidates: [dated, undated] }),
  }], { task: 'orchard evidence', laneCut: false }, {
    task: 'orchard evidence', decide: async (batch) => Object.fromEntries(batch.questions.map((question) => [
      question.key, { status: 'answered', probability: question.id === 'dated' ? 0.9 : 0.7 },
    ])),
  });
  const original = structuredClone(picked);
  const evidence: typeof picked = curationEvidence(picked, '2026-02-01');
  expect(picked).toEqual(original);
  expect(evidence.record).toBe(picked.record);
  expect(evidence.selected[0]).toBe(picked.selected[0]);
  expect(evidence.selected.map((candidate) => [candidate.id, candidate.signals])).toEqual(
    picked.selected.map((candidate) => [candidate.id, candidate.signals]),
  );
  expect(evidence.selected[1]?.date).toEqual({ value: '2026-02-01', meaning: 'recorded' });
  expect(evidence.selected[1]?.text).toContain('When the text supplies no statement date, the original statement date is unknown.');
  expect(evidence.selected[1]?.text).toContain('This header date is collection only, not when the person acted or spoke.');
  expect(evidence.selected[1]?.text).toContain(undated.text);

  const log = '[2026-01-01] An orchard was planted (said 2026-01-01; dated)\n'
    + '[2026-02-01] The collected note says the person prefers fruit trees; the original statement date is unknown (said 2026-02-01; undated) (when not stated)';
  const result = await curate('orchard evidence', evidence, { write: async (prompt) => {
    expect(prompt.body).toContain('### dated (2026-01-01, markdown, 0.9):');
    expect(prompt.body).toContain('### undated (2026-02-01, markdown, 0.7):');
    expect(prompt.body).toContain('UNDATED SOURCE collected 2026-02-01.');
    expect(prompt.body).toContain('When the text supplies no statement date, the original statement date is unknown.');
    return log;
  } });
  expect(result.log).toBe(log);
  expect(result.record.items.map((item) => [item.id, item.weight])).toEqual([['dated', 0.9], ['undated', 0.7]]);
});

it('saves the pick record naming the rejected batch when the decision service fails', async () => {
  const directory = await folder();
  const home = join(directory, 'home');
  const notes = join(directory, 'notes');
  await mkdir(home);
  await mkdir(notes);
  await writeFile(join(notes, 'orchard.md'), '# Orchard\n\nThe orchard has trees. Fruit trees grow here.\n');
  const sourcesFile = join(directory, 'sources.json');
  await writeFile(sourcesFile, JSON.stringify({ sources: [{ type: 'markdown', path: notes }] }));
  const searches = Object.fromEntries(['chat', 'git-history', 'markdown'].map((kind) => [
    kind, { keywords: ['orchard', 'orchard trees'], answers: ['The orchard has trees.', 'Fruit trees grow here.'] },
  ]));
  vi.stubEnv('HOME', home);
  vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('rejected', { status: 400 })));
  const realSpawn = vi.mocked(spawn).getMockImplementation()!;
  // The subscription search call reads the output file the spawned
  // process was asked to write; this fake writes the search lines there.
  vi.mocked(spawn).mockImplementation(((_command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { on: () => void; end: (text: string) => void };
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      on: () => {},
      end: () => {
        writeFileSync(args[args.indexOf('-o') + 1]!, JSON.stringify(searches));
        queueMicrotask(() => child.emit('close', 0));
      },
    };
    return child;
  }) as unknown as typeof spawn);
  try {
    await expect(run(['--sources', sourcesFile, 'orchard'])).rejects.toThrow('The decide call failed');
  } finally {
    vi.mocked(spawn).mockImplementation(realSpawn);
  }
  const folders = await readdir(join(home, '.curate', 'runs'));
  expect(folders).toHaveLength(1);
  const saved = JSON.parse(await readFile(join(home, '.curate', 'runs', folders[0]!, 'record.json'), 'utf8'));
  expect(saved.status).toBe('failed');
  expect(saved.error).toContain('Decision service returned HTTP 400.');
  expect(saved.pick?.decideError?.message).toBe('Decision service returned HTTP 400.');
  expect(saved.pick?.decideError?.candidates?.length).toBeGreaterThan(0);
  const ids = new Set<string>((saved.pick?.candidates ?? []).map((entry: { id: string }) => entry.id));
  expect(saved.pick?.decideError?.candidates?.every((id: string) => ids.has(id))).toBe(true);
});

describe('search line repair', () => {
  const searches = () => Object.fromEntries(['chat', 'git-history', 'markdown'].map((kind) => [
    kind, { keywords: ['orchard', 'orchard trees'], answers: ['The orchard has trees.', 'Fruit trees grow here.'] },
  ]));
  const trailingComma = () => JSON.stringify(searches(), null, 2).replace(/(\n *)\]/, ',$1]');
  const missingKind = () => {
    const value: Record<string, unknown> = searches();
    delete value['git-history'];
    return JSON.stringify(value);
  };

  // The subscription model is the injected call; as the helper does, each
  // reply is saved as <label>-<n>.txt in the run folder and recorded. The
  // decide fetch is stubbed, so neither Codex nor Jev is contacted.
  async function harness(replies: string[]) {
    const directory = await folder();
    const home = join(directory, 'home');
    const notes = join(directory, 'notes');
    await mkdir(home);
    await mkdir(notes);
    await writeFile(join(notes, 'orchard.md'), '# Orchard\n\nThe orchard has trees. Fruit trees grow here.\n');
    const sourcesFile = join(directory, 'sources.json');
    await writeFile(sourcesFile, JSON.stringify({ sources: [{ type: 'markdown', path: notes }] }));
    vi.stubEnv('HOME', home);
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => new Response(JSON.stringify({
      usage: null,
      answers: Object.fromEntries(Object.keys(JSON.parse(String(init.body)).questions).map((key) => [key, { noul: 0.8 }])),
    }))));
    // A guard for the injection: the real helper would spawn Codex.
    vi.mocked(spawn).mockImplementation((() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: { on: () => void; end: () => void };
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { on: () => {}, end: () => queueMicrotask(() => child.emit('close', 1)) };
      return child;
    }) as unknown as typeof spawn);
    const calls: { label: string; prompt: string }[] = [];
    let runFolder = '';
    const callSubscription = async (prompt: string, folder: string, label: string,
      record: { subscription: { label: string; attempt: number; code: number }[] }, save: () => Promise<void>) => {
      calls.push({ label, prompt });
      runFolder = folder;
      const number = record.subscription.filter((call) => call.label === label).length + 1;
      record.subscription.push({ label, attempt: number, code: 0 });
      const reply = label === 'searches' ? replies.shift()!
        : [...prompt.matchAll(/^### (.+) \([^)]*\):/gm)]
          .map((match) => `[2026-01-01] Orchard evidence ${match[1]} (said 2026-01-01; ${match[1]})`)
          .join('\n');
      writeFileSync(join(folder, `${label}-${number}.txt`), reply);
      await save();
      return reply;
    };
    const saved = async () => JSON.parse(await readFile(join(runFolder, 'record.json'), 'utf8'));
    return { sourcesFile, calls, callSubscription, saved, folder: () => runFolder };
  }

  it('repairs a trailing-comma reply once and records one repair', async () => {
    const bad = trailingComma();
    const { sourcesFile, calls, callSubscription, saved, folder: runFolder } = await harness([bad, JSON.stringify(searches())]);
    expect(await run(['--sources', sourcesFile, 'orchard'], callSubscription)).toBe(runFolder());
    expect(calls.map((call) => call.label)).toEqual(['searches', 'searches', 'curator']);
    expect(calls[1]?.prompt).toContain('TASK: orchard');
    expect(calls[1]?.prompt).toContain(bad);
    expect(calls[1]?.prompt).toContain('Unexpected token');
    expect(calls[1]?.prompt).toContain('corrected and nothing else');
    const record = await saved();
    expect(record.status).toBe('complete');
    expect(record.searchRepairs).toBe(1);
    expect(record.searches).toEqual(searches());
    expect(await readFile(join(runFolder(), 'searches-1.txt'), 'utf8')).toBe(bad);
    expect(JSON.parse(await readFile(join(runFolder(), 'searches-2.txt'), 'utf8'))).toEqual(searches());
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it('repairs a reply whose JSON parses but is missing a source kind', async () => {
    const bad = missingKind();
    const { sourcesFile, calls, callSubscription, saved } = await harness([bad, JSON.stringify(searches())]);
    await run(['--sources', sourcesFile, 'orchard'], callSubscription);
    expect(calls.map((call) => call.label)).toEqual(['searches', 'searches', 'curator']);
    expect(calls[1]?.prompt).toContain(bad);
    expect(calls[1]?.prompt).toContain('keyword and hypothetical-answer');
    const record = await saved();
    expect(record.status).toBe('complete');
    expect(record.searchRepairs).toBe(1);
    expect(record.searches).toEqual(searches());
  });

  it('stops the run when the repair reply also fails, naming both failures', async () => {
    const { sourcesFile, callSubscription, saved, folder: runFolder } = await harness([trailingComma(), missingKind()]);
    const error = await run(['--sources', sourcesFile, 'orchard'], callSubscription).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Unexpected token');
    expect(error.message).toContain('keyword and hypothetical-answer');
    expect(error.message).toContain('searches-1.txt');
    expect(error.message).toContain('searches-2.txt');
    const record = await saved();
    expect(record.status).toBe('failed');
    expect(record.searchRepairs).toBe(1);
    expect(await readFile(join(runFolder(), 'searches-1.txt'), 'utf8')).toBe(trailingComma());
    expect(await readFile(join(runFolder(), 'searches-2.txt'), 'utf8')).toBe(missingKind());
  });

  // The real helper under a faked spawn: a capacity close on attempt 1
  // is retried as attempt 2, so the two rejected replies hold later file
  // numbers and the error must name those, not searches-1.txt. Only
  // setTimeout is faked, for the 60-second capacity wait.
  it('names the reply files a capacity attempt moved off searches-1.txt', async () => {
    const directory = await folder();
    const home = join(directory, 'home');
    const notes = join(directory, 'notes');
    await mkdir(home);
    await mkdir(notes);
    await writeFile(join(notes, 'orchard.md'), '# Orchard\n\nThe orchard has trees. Fruit trees grow here.\n');
    const sourcesFile = join(directory, 'sources.json');
    await writeFile(sourcesFile, JSON.stringify({ sources: [{ type: 'markdown', path: notes }] }));
    vi.stubEnv('HOME', home);
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    let spawned = 0;
    const replies = [trailingComma(), missingKind()];
    vi.mocked(spawn).mockImplementation(((_command: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: { on: () => void; end: () => void };
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      spawned += 1;
      const call = spawned;
      child.stdin = { on: () => {}, end: () => queueMicrotask(() => {
        if (call === 1) {
          child.stderr.emit('data', 'Codex is at capacity.');
          child.emit('close', 1);
        } else {
          writeFileSync(args[args.indexOf('-o') + 1]!, replies.shift()!);
          child.emit('close', 0);
        }
      }) };
      return child;
    }) as unknown as typeof spawn);
    try {
      let settled = false;
      const outcome = run(['--sources', sourcesFile, 'orchard'])
        .then(() => null, (error: Error) => error)
        .then((error: Error | null) => { settled = true; return error; });
      while (!settled && vi.getTimerCount() === 0) await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(60_000);
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('Unexpected token');
      expect(error.message).toContain('keyword and hypothetical-answer');
      expect(error.message).toContain('searches-2.txt');
      expect(error.message).toContain('searches-3.txt');
      expect(error.message).not.toContain('searches-1.txt');
      const runs = join(home, '.curate', 'runs');
      const runFolder = join(runs, (await readdir(runs))[0]!);
      expect(await readFile(join(runFolder, 'searches-2.txt'), 'utf8')).toBe(trailingComma());
      expect(await readFile(join(runFolder, 'searches-3.txt'), 'utf8')).toBe(missingKind());
      expect(await readdir(runFolder)).not.toContain('searches-1.txt');
      expect(await readFile(join(runFolder, 'searches-1.stderr'), 'utf8')).toContain('capacity');
      const record = JSON.parse(await readFile(join(runFolder, 'record.json'), 'utf8'));
      expect(record.status).toBe('failed');
      expect(record.searchRepairs).toBe(1);
      expect(record.subscription.map((call: { label: string; attempt: number; code: number }) =>
        [call.label, call.attempt, call.code])).toEqual([['searches', 1, 1], ['searches', 2, 0], ['searches', 3, 0]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('makes no repair call when the first reply is valid', async () => {
    const { sourcesFile, calls, callSubscription, saved } = await harness([JSON.stringify(searches())]);
    await run(['--sources', sourcesFile, 'orchard'], callSubscription);
    expect(calls.map((call) => call.label)).toEqual(['searches', 'curator']);
    const record = await saved();
    expect(record.status).toBe('complete');
    expect(record.searchRepairs).toBeUndefined();
    expect(record.searches).toEqual(searches());
  });
});
