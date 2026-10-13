import { readSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { curate, pickFromSources, type CandidateReadRequest, type CandidateSource, type MemoryCandidate } from '@curatejs/core';
// @ts-expect-error The standalone JavaScript command has no type declarations.
import { allowedSession, curationEvidence, decisionAnswers, parseArgs, parseSearches, parseSources, searchSource, sessionHeader, snapshotCodex } from '../skills/curate/run.mjs';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, copyFile: vi.fn(actual.copyFile), readFile: vi.fn(actual.readFile) };
});

const directories: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
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
      ], threshold: 0, maxCandidates: 1,
    })).toEqual({
      sources: [
        { type: 'codex', path: resolve('sessions'), allowedCwd: resolve('projects') },
        { type: 'claude-code', path: resolve('transcripts') },
        { type: 'git', path: resolve('repository') },
        { type: 'markdown', path: resolve('documents') },
      ], threshold: 0, maxCandidates: 1,
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

  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects candidate limit %s', (maxCandidates) => {
    expect(() => parseSources({ sources: [{ type: 'markdown', path: 'documents' }], maxCandidates })).toThrow();
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
    expect(vi.mocked(readFile).mock.calls.map((call) => call[0])).toEqual([
      await realpath(join(snapshot, '2026', '01', 'allowed.jsonl')),
      await realpath(join(snapshot, '2026', '01', 'allowed.jsonl')),
    ]);
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
  }], { task: 'orchard evidence' }, {
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
    expect(prompt.body).toContain('### dated (2026-01-01, 0.9):');
    expect(prompt.body).toContain('### undated (2026-02-01, 0.7):');
    expect(prompt.body).toContain('UNDATED SOURCE collected 2026-02-01.');
    expect(prompt.body).toContain('When the text supplies no statement date, the original statement date is unknown.');
    return log;
  } });
  expect(result.log).toBe(log);
  expect(result.record.items.map((item) => [item.id, item.weight])).toEqual([['dated', 0.9], ['undated', 0.7]]);
});
