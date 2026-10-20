import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { curate, pickFromSources, SourceReadError, stripSearchInstructions, type CandidateReadRequest, type CandidateReadResult, type CandidateSource, type MemoryCandidate, type PickDecide } from '@curatejs/core';
import { chat } from '@curatejs/chat';
import { gitHistory } from '@curatejs/git';
import { knowledgeBase, rules } from '@curatejs/markdown';
import { DEFAULT_MAX_QUESTION_TEXT } from '@curatejs/core';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function folder() {
  const directory = await mkdtemp(join(tmpdir(), 'curate-search-'));
  directories.push(directory);
  return directory;
}
const candidate = (id: string, score = 1, sourceId = 'notes'): MemoryCandidate => ({
  id, sourceId, role: 'reference', title: id, text: `Evidence for ${id}`, signals: { score },
});
const readResult = (candidates: readonly MemoryCandidate[], extra = {}): CandidateReadResult => ({
  status: 'read', candidates, complete: true, ...extra,
});
const yes: PickDecide = async ({ questions }) => Object.fromEntries(
  questions.map((question) => [question.key, { status: 'answered', probability: 0.9 }]),
);
function source(read: CandidateSource['read'], extra: Partial<CandidateSource> = {}): CandidateSource {
  return { id: 'reader', role: 'reference', read, ...extra };
}
function pickSource(reader: CandidateSource, request: CandidateReadRequest, decide = yes) {
  return pickFromSources([reader], request, { task: request.task, decide });
}

describe('extra source searches', () => {
  it('reads once per unique task and unions unique candidate source/id pairs', async () => {
    const calls: CandidateReadRequest[] = [];
    const reader = source(async (request) => {
      calls.push(request);
      return request.task === 'original'
        ? readResult([candidate('b', 1), candidate('a', 1), candidate('a', 0), candidate('a', 3, 'other')])
        : readResult([candidate('b', 3), candidate('new', 2), candidate('a', 1)]);
    });
    const result = await pickSource(reader, {
      task: 'original', searchLines: [' extra ', '', 'original', 'extra', '  '],
      paths: ['guide.md'], exclude: ['private.md'], limit: 3,
    });
    expect(calls.map((call) => call.task)).toEqual(['original', 'extra']);
    expect(calls.every((call) => call.limit === 3 && call.maxQuestionText === DEFAULT_MAX_QUESTION_TEXT
      && call.paths?.[0] === 'guide.md' && call.exclude?.[0] === 'private.md')).toBe(true);
    const read = result.reads[0]!;
    expect(read.status).toBe('read');
    if (read.status !== 'read') return;
    expect(read.candidates.map((item) => [item.sourceId, item.id, item.searchRanks])).toEqual([
      ['notes', 'a', [0, 2]], ['notes', 'b', [1, 0]], ['other', 'a', [0, null]], ['notes', 'new', [null, 1]],
    ]);
    expect(read.candidates.find((item) => item.id === 'b')?.signals).toEqual({ score: 3 });
  });

  it('keeps exact single-read results without supplied extras or with an empty list', async () => {
    const read = readResult([candidate('b'), candidate('a')], { revision: 'fixed' });
    const reader = source(async () => read);
    const baseline = await pickSource(reader, { task: 'original', wholeLanes: true });
    for (const searchLines of [[], ['', 'original', 'original']]) {
      const disabled = await pickSource(reader, { task: 'original', searchLines, stripSearchInstructions: false, wholeLanes: true });
      expect(disabled).toEqual(baseline);
      expect(disabled.reads[0]).toEqual({
        ...read, lanes: [{ task: 'original', lane: 'search', read: 2, kept: 2 }],
      });
      expect(disabled.selected.every((item) => !('searchRanks' in item))).toBe(true);
    }
  });

  it('keeps the original lane and takes the candidate data from its best rank', async () => {
    const reader = source(async ({ task }) => task === 'original'
      ? readResult([candidate('first', 50), { ...candidate('shared', 40), text: 'Original data' }])
      : readResult([{ ...candidate('shared', 2), text: 'Extra data' }, candidate('new', 1)]));
    const result = await pickFromSources([reader], { task: 'original', searchLines: ['extra'] }, {
      task: 'original', decide: yes, limits: { maxCandidates: 1 },
    });
    expect(result.selected.map((item) => item.id).sort()).toEqual(['first', 'shared']);
    expect(result.selected.find((item) => item.id === 'shared')?.text).toBe('Extra data');
    expect(result.record.candidates.find((item) => item.id === 'new')?.status).toBe('unassessed');
  });

  it('keeps read limits per lane instead of truncating the union', async () => {
    const limits: (number | undefined)[] = [];
    const reader = source(async ({ task, limit }) => {
      limits.push(limit);
      return readResult([candidate(task)], { complete: false, partial: 'the limit kept 1 of 2 candidates' });
    });
    const result = await pickSource(reader, { task: 'original', searchLines: ['extra'], limit: 1 });
    expect(limits).toEqual([1, 1]);
    expect(result.selected).toHaveLength(2);
    expect(result.reads[0]).toMatchObject({ complete: false, partial: 'the limit kept 1 of 2 candidates' });
  });

  it('unions overlapping readers globally with best data, merged ranks and one decision per item', async () => {
    const always: MemoryCandidate = { ...candidate('always', 10, 'policy'), role: 'rule', applies: 'always' };
    const readers = [
      source(async ({ task }) => readResult(task === 'original'
        ? [candidate('first', 3), { ...candidate('shared', 2), text: 'First reader data' }, always]
        : [{ ...candidate('shared', 1), text: 'First reader extra data' }, candidate('another', 2), always])),
      source(async ({ task }) => readResult(task === 'original'
        ? [{ ...candidate('shared', 3), text: 'Best reader data' }, candidate('first', 1), always]
        : [candidate('another', 3), { ...candidate('shared', 2), text: 'Second reader extra data' }, always])),
    ];
    const asked: string[] = [];
    const result = await pickFromSources(readers, { task: 'original', searchLines: ['extra'] }, {
      task: 'original', decide: async (batch, signal) => {
        asked.push(...batch.questions.map((question) => question.id));
        return yes(batch, signal);
      },
    });
    expect(asked.sort()).toEqual(['another', 'first', 'shared']);
    expect(result.selected).toHaveLength(4);
    expect(result.record.candidates).toHaveLength(4);
    expect(result.selected.filter((item) => item.id === 'always')).toHaveLength(1);
    expect(result.selected.find((item) => item.id === 'shared')).toMatchObject({
      text: 'Best reader data', searchRanks: [0, 1],
    });
    expect(result.selected.find((item) => item.id === 'first')?.searchRanks).toEqual([0, null]);
    expect(result.selected.find((item) => item.id === 'another')?.searchRanks).toEqual([null, 0]);
  });

  it('keeps duplicate readers unchanged without active extras', async () => {
    const reader = source(async () => readResult([candidate('same')]));
    const baseline = await pickFromSources([reader, reader], { task: 'original' }, { task: 'original', decide: yes });
    const disabled = await pickFromSources([reader, reader], { task: 'original', searchLines: [] }, { task: 'original', decide: yes });
    expect(disabled).toEqual(baseline);
    expect(disabled.selected).toHaveLength(2);
    expect(disabled.record.candidates).toHaveLength(2);
    const asked: string[] = [];
    const expanded = await pickFromSources([reader, reader], { task: 'original', searchLines: ['extra'] }, {
      task: 'original', decide: async (batch, signal) => {
        asked.push(...batch.questions.map((question) => question.id));
        return yes(batch, signal);
      },
    });
    expect(asked).toEqual(['same']);
    expect(expanded.selected).toHaveLength(1);
    expect(expanded.selected[0]?.searchRanks).toEqual([0, 0]);
  });

  it('pins later reads to the first resolved revision and copies candidate revisions', async () => {
    const revisions: (string | undefined)[] = [];
    const reader = source(async ({ task, revision }) => {
      revisions.push(revision);
      return readResult([candidate(task)], { revision: revision ?? 'resolved' });
    });
    const result = await pickSource(reader, { task: 'original', searchLines: ['extra', 'another'] });
    expect(revisions).toEqual([undefined, 'resolved', 'resolved']);
    expect(result.reads[0]).toMatchObject({ revision: 'resolved' });
    expect(result.selected.every((item) => item.sourceRevision === 'resolved')).toBe(true);
  });

  it('resolves an explicit revision once and preserves an explicit candidate revision', async () => {
    const revisions: (string | undefined)[] = [];
    const reader = source(async ({ task, revision }) => {
      revisions.push(revision);
      return readResult([{ ...candidate(task), sourceRevision: 'item-revision' }], { revision: 'resolved' });
    });
    const result = await pickSource(reader, { task: 'original', revision: 'HEAD', searchLines: ['extra'] });
    expect(revisions).toEqual(['HEAD', 'resolved']);
    expect(result.selected.every((item) => item.sourceRevision === 'item-revision')).toBe(true);
  });

  it('does not add revision requests to working-tree rule readers', async () => {
    const revisions: (string | undefined)[] = [];
    const reader = source(async ({ task, revision }) => {
      revisions.push(revision);
      return readResult([{ ...candidate(task), role: 'rule' }], { revision: 'metadata-only' });
    }, { kind: 'markdown', role: 'rule' });
    await pickSource(reader, { task: 'original', searchLines: ['extra'] });
    expect(revisions).toEqual([undefined, undefined]);
  });

  it('combines absence and partial notes without claiming complete rule coverage', async () => {
    const reader = source(async ({ task }) => task === 'original'
      ? { status: 'absent', reason: 'missing original' }
      : readResult([{ ...candidate('rule'), role: 'rule' }], { complete: false, partial: 'skipped a file' }),
    { role: 'rule' });
    const result = await pickSource(reader, { task: 'original', searchLines: ['extra'] });
    expect(result.selected.map((item) => item.id)).toEqual(['rule']);
    expect(result.selected[0]?.searchRanks).toEqual([null, 0]);
    expect(result.reads[0]).toMatchObject({
      status: 'read', complete: false, partial: 'search 1 absent: missing original; skipped a file',
    });
    expect(result.record.rulesCoverage).toBe('incomplete');
  });

  it('preserves all absent reasons and propagates later failures and cancellation', async () => {
    const absent = await pickSource(source(async ({ task }) => ({ status: 'absent', reason: `missing ${task}` })), {
      task: 'original', searchLines: ['extra'],
    });
    expect(absent.reads).toEqual([{ status: 'absent', reason: 'missing original; missing extra' }]);
    for (const code of ['failed', 'cancelled'] as const) {
      const error = new SourceReadError(code, 'later search stopped');
      const reader = source(async ({ task }) => {
        if (task === 'extra') throw error;
        return readResult([candidate('original')]);
      });
      await expect(pickSource(reader, { task: 'original', searchLines: ['extra'] })).rejects.toBe(error);
    }
  });

  it('strips search instructions only when enabled and keeps the full decision task', async () => {
    const task = 'How many events occurred after 2025? Say which is newer. Answer in one line. Cite both.';
    const calls: string[] = [];
    const reader = source(async (request) => {
      calls.push(request.task);
      return readResult([candidate('evidence')]);
    });
    const decide: PickDecide = async (batch, signal) => {
      expect(batch.task).toBe(task);
      return yes(batch, signal);
    };
    await pickSource(reader, { task }, decide);
    const picked = await pickSource(reader, { task, stripSearchInstructions: true, searchLines: ['events, return JSON'] }, decide);
    expect(calls).toEqual([task, 'How many events occurred after 2025? Say which is newer.', 'events']);
    const writerTasks: string[] = [];
    await curate(task, picked, {
      contextLimit: 1,
      write: async (prompt) => {
        writerTasks.push(prompt.body.split('\n\n')[0]!);
        return '[2026-01-01] Event recorded (said 2026-01-01; E1)';
      },
    });
    expect(writerTasks).toEqual([`TASK:\n${task}`, `TASK:\n${task}`]);
  });
});

describe('search instruction removal', () => {
  it.each([
    ['What happened? Answer in one line. Cite your sources.', 'What happened?'],
    ['Return JSON. Which event came later?', 'Which event came later?'],
    ['Count all events, include citations', 'Count all events'],
    ['Compare the dates; do not include citations.', 'Compare the dates'],
    ['Who won? Respond using a table.', 'Who won?'],
  ])('removes explicit format/citation clauses from %s', (task, expected) => {
    expect(stripSearchInstructions(task)).toBe(expected);
  });
  it.each([
    'How many times did this happen? Say which is newer.',
    'Find the note that says answer in one line.',
    'Find documents that cite sources.',
    'List events by date and compare the latest ones.',
    'Explain the answer in one line from the old transcript.',
    'Count 3.5 days between events.',
  ])('preserves subject needs and uncertain wording: %s', (task) => {
    expect(stripSearchInstructions(task)).toBe(task);
  });
});

describe('extra searches with built-in readers', () => {
  it('keeps explicit HEAD on its first resolved commit when HEAD moves between searches', async () => {
    const directory = await folder();
    const git = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', directory, ...args], {
      env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' },
      encoding: 'utf8',
    });
    git(['init', '-b', 'main']);
    await writeFile(join(directory, 'fruit.txt'), 'apple');
    git(['add', '.']);
    git(['commit', '-m', 'Apple orchard', '-m', 'Apple orchard evidence.']);
    const firstRevision = git(['rev-parse', 'HEAD']).trim();
    const reader = gitHistory(directory);
    const revisions: (string | undefined)[] = [];
    const moving = source(async (request) => {
      revisions.push(request.revision);
      const read = await reader.read(request);
      if (revisions.length === 1) {
        await writeFile(join(directory, 'fruit.txt'), 'banana');
        git(['add', '.']);
        git(['commit', '-m', 'Banana harvest', '-m', 'Banana harvest evidence.']);
      }
      return read;
    }, { kind: 'git-history' });
    const result = await pickSource(moving, { task: 'apple orchard', revision: 'HEAD', searchLines: ['banana harvest'] });
    expect(git(['rev-parse', 'HEAD']).trim()).not.toBe(firstRevision);
    expect(revisions).toEqual(['HEAD', firstRevision]);
    expect(result.reads[0]).toMatchObject({ revision: firstRevision });
    expect(result.selected.map((item) => item.title)).toEqual(['Apple orchard']);
    expect(result.selected[0]).toMatchObject({ sourceRevision: firstRevision, searchRanks: [0, 0] });
  });

  it.each(['notes', 'rules'] as const)('recovers another %s match beyond its per-read limit', async (kind) => {
    const directory = await folder();
    await writeFile(join(directory, 'apple.md'), 'Apple orchard apple orchard.');
    await writeFile(join(directory, 'banana.md'), 'Banana harvest banana harvest.');
    const reader = kind === 'notes' ? knowledgeBase(directory) : rules(directory);
    const original = await pickSource(reader, { task: 'apple orchard', limit: 1 });
    const expanded = await pickSource(reader, { task: 'apple orchard', searchLines: ['banana harvest'], limit: 1 });
    expect(original.selected).toHaveLength(1);
    expect(original.selected[0]?.text).toContain('Apple');
    expect(expanded.selected).toHaveLength(2);
    expect(expanded.selected.some((item) => item.text.includes('Banana') && item.searchRanks?.[1] === 0)).toBe(true);
    const fed = await pickFromSources([reader], { task: 'apple orchard', searchLines: ['banana harvest'] }, {
      task: 'apple orchard', decide: yes, limits: { maxCandidates: 1 },
    });
    expect(fed.selected).toHaveLength(2);
    expect(fed.selected.some((item) => item.text.includes('Apple'))).toBe(true);
    expect(fed.selected.some((item) => item.text.includes('Banana'))).toBe(true);
  });

  it('recovers another chat match beyond its per-read limit', async () => {
    const directory = await folder();
    await mkdir(join(directory, 'project'));
    const records = ['Apple orchard apple orchard.', 'Banana harvest banana harvest.'].map((text) => ({
      type: 'user', sessionId: 'fixture', timestamp: '2026-10-01T00:00:00Z', message: { content: text },
    }));
    await writeFile(join(directory, 'project', 'fixture.jsonl'), records.map((record) => JSON.stringify(record)).join('\n'));
    const reader = chat({ providers: ['claude-code'], paths: [directory] });
    const original = await pickSource(reader, { task: 'apple orchard', limit: 1 });
    const expanded = await pickSource(reader, { task: 'apple orchard', searchLines: ['banana harvest'], limit: 1 });
    expect(original.selected).toHaveLength(1);
    expect(original.selected[0]?.text).toContain('Apple');
    expect(expanded.selected).toHaveLength(2);
    expect(expanded.selected.some((item) => item.text.includes('Banana') && item.searchRanks?.[1] === 0)).toBe(true);
    const fed = await pickFromSources([reader], { task: 'apple orchard', searchLines: ['banana harvest'] }, {
      task: 'apple orchard', decide: yes, limits: { maxCandidates: 1 },
    });
    expect(fed.selected).toHaveLength(2);
    expect(fed.selected.some((item) => item.text.includes('Apple'))).toBe(true);
    expect(fed.selected.some((item) => item.text.includes('Banana'))).toBe(true);
  });

  it('ranks another commit first without changing latest-commit enumeration limits', async () => {
    const directory = await folder();
    const git = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', directory, ...args], {
      env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' },
      encoding: 'utf8',
    });
    git(['init', '-b', 'main']);
    await writeFile(join(directory, 'fruit.txt'), 'apple');
    git(['add', '.']);
    git(['commit', '-m', 'Apple orchard', '-m', 'Apple orchard evidence.']);
    await writeFile(join(directory, 'fruit.txt'), 'banana');
    git(['add', '.']);
    git(['commit', '-m', 'Banana harvest', '-m', 'Banana harvest evidence.']);
    const reader = gitHistory(directory);
    const expanded = await pickFromSources([reader], { task: 'apple orchard', searchLines: ['banana harvest'] }, {
      task: 'apple orchard', decide: yes, limits: { maxCandidates: 1 },
    });
    expect(expanded.selected.map((item) => item.title).sort()).toEqual(['Apple orchard', 'Banana harvest']);
    expect(expanded.selected.find((item) => item.title === 'Apple orchard')?.searchRanks?.[0]).toBe(0);
    expect(expanded.selected.find((item) => item.title === 'Banana harvest')?.searchRanks?.[1]).toBe(0);
    const limited = await pickSource(reader, { task: 'apple orchard', searchLines: ['banana harvest'], limit: 1 });
    expect(limited.selected.map((item) => item.title)).toEqual(['Banana harvest']);
    expect(limited.reads[0]).toMatchObject({ complete: false });
  });
});


describe('phrase searches with built-in readers', () => {
  it.each(['chat', 'markdown', 'git'] as const)('recovers signed vinyl through the real %s reader', async (kind) => {
    const directory = await folder();
    await writeFile(join(directory, 'a.md'), 'Albums albums albums albums on a shelf.');
    await writeFile(join(directory, 'b.md'), 'I even got my vinyl signed.');
    const git = (...args: string[]) => execFileSync('git', ['-C', directory, '-c', 'core.hooksPath=/dev/null', ...args], {
      env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' }, stdio: 'pipe',
    });
    git('init', '-b', 'main');
    git('add', 'b.md');
    git('-c', 'commit.gpgsign=false', 'commit', '-m', 'I even got my vinyl signed');
    git('add', 'a.md');
    git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Albums albums albums albums on a shelf');
    await writeFile(join(directory, 'session.jsonl'), ['Albums albums albums albums on a shelf.', 'I even got my vinyl signed.'].map((text) => JSON.stringify({
      type: 'response_item', timestamp: '2026-01-01T00:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    })).join('\n'));
    const reader = kind === 'chat' ? chat({ paths: [directory], providers: ['codex'] })
      : kind === 'markdown' ? knowledgeBase(directory) : gitHistory(directory);
    const task = 'How many albums did I buy?';
    const baseline = await pickFromSources([reader], { task }, { task, decide: yes, limits: { maxCandidates: 1 } });
    const expanded = await pickFromSources([reader], { task, searchPhrases: ['got my'], limit: 1 }, { task, decide: yes, limits: { maxCandidates: 1 } });
    expect(baseline.selected.some((item) => `${item.title} ${item.text}`.includes('got my vinyl signed'))).toBe(false);
    expect(expanded.selected.some((item) => `${item.title} ${item.text}`.includes('got my vinyl signed'))).toBe(true);
    expect(expanded.selected).toHaveLength(2);
    const excluded = await pickFromSources([reader], { task, searchPhrases: ['got my'], exclude: ['b.md', 'session.jsonl'] }, { task, decide: yes });
    if (kind !== 'git') expect(excluded.selected.some((item) => `${item.title} ${item.text}`.includes('got my vinyl signed'))).toBe(false);
  });
});
