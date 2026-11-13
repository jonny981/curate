import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

import {
  curate, pickFromSources, type CandidateSource, type MemoryCandidate, type PickBatch, type PickOptions, type PickRecordEntry,
} from '@curatejs/core';
import { poolSizing } from '@curatejs/core/internal';
import { chat } from '@curatejs/chat';
import { git } from '@curatejs/git';
import { knowledgeBase } from '@curatejs/markdown';

const folders: string[] = [];
afterEach(async () => {
  poolSizing.on = true;
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});
async function folder(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), 'curate-pool-sizing-'));
  folders.push(made);
  return made;
}

let seed = 9;
const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const words = ['orchard', 'quince', 'pump', 'filter', 'ledger', 'sync', 'lease', 'quorum', 'replica', 'the', 'a', 'of', 'we', 'said'];
const say = (count: number) => Array.from({ length: count }, () => words[Math.floor(random() * words.length)]).join(' ');

/** A chat history, a knowledge base, a repository, and a folder of notes
 *  no lane can keep: none of its words is searched and its vectors sit
 *  apart from every query. */
async function histories() {
  const root = await folder();
  const chats = join(root, 'chats', '2026', '10', '02');
  await mkdir(chats, { recursive: true });
  // More parts than the 'quick' depth, so the depth cuts the fused order.
  for (let file = 0; file < 30; file += 1) {
    const lines = [{ type: 'session_meta', timestamp: '2026-09-01T00:00:00Z', payload: { id: `s${file}` } },
      ...Array.from({ length: 30 }, (_, turn) => ({ type: 'response_item', timestamp: `2026-10-0${1 + (turn % 8)}T10:00:00Z`,
        payload: { type: 'message', role: turn % 2 === 0 ? 'user' : 'assistant',
          content: [{ type: turn % 2 === 0 ? 'input_text' : 'output_text', text: turn % 7 === 0 ? 'The same line.' : say(10) }] } }))];
    // One message with no time, which a read skips and reports.
    const undated = file === 0 ? [{ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: say(10) }] } }] : [];
    await writeFile(join(chats, `s${file}.jsonl`), `${[...lines, ...undated].map((line) => JSON.stringify(line)).join('\n')}\n`);
  }
  const notes = join(root, 'notes');
  const apart = join(root, 'apart');
  await mkdir(notes);
  await mkdir(apart);
  for (let note = 0; note < 12; note += 1) {
    await writeFile(join(notes, `n${note}.md`), `# ${say(2)}\n\n## ${say(2)}\n\n${say(20)}\n\n## ${say(2)}\n\n${say(20)}\n`);
    // Half the notes are dated before a look-back by their modified time.
    if (note % 2 === 1) await utimes(join(notes, `n${note}.md`), new Date('2025-06-01T10:00:00Z'), new Date('2025-06-01T10:00:00Z'));
    await writeFile(join(apart, `a${note}.md`), `# Zebra ${note}\n\n## Giraffe\n\nZebra giraffe okapi ${note}.\n`);
  }
  const repo = join(root, 'repo');
  await mkdir(repo);
  const env = (at: number) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_AUTHOR_DATE: `2026-09-${String(1 + at).padStart(2, '0')}T10:00:00Z`, GIT_COMMITTER_DATE: `2026-09-${String(1 + at).padStart(2, '0')}T10:00:00Z` });
  const run = (args: string[], at = 0) => execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    { env: env(at), stdio: 'pipe' });
  run(['init', '-q', '-b', 'main']);
  for (let at = 0; at < 20; at += 1) {
    await writeFile(join(repo, `file-${at % 4}.ts`), say(8));
    run(['add', '-A'], at);
    run(['commit', '-q', '-m', say(4), '-m', say(12)], at);
  }
  return { root, chats: join(root, 'chats'), notes, apart, repo };
}

const task = 'Why did we drop the quorum lease for the ledger sync?';
const embed = async (texts: readonly string[]) => texts.map((text) => /zebra|giraffe/i.test(text) ? [0, 0, 1]
  : [/lease|quorum/.test(text) ? 1 : 0.2, /ledger|sync/.test(text) ? 1 : 0.3, 0]);
const decide = async (batch: PickBatch) => Object.fromEntries(batch.questions.map((question) => {
  let hash = 7;
  for (const char of `${question.sourceId}|${question.id}|${question.questionKey ?? question.key}`) hash = (hash * 31 + char.charCodeAt(0)) % 1000003;
  return [question.key, { status: 'answered' as const, probability: (hash % 1000) / 1000 }];
}));
// Few warm parts, so the stop ends the read at the first batch the order
// fills with cold ones.
const sparse = async (batch: PickBatch) => Object.fromEntries(Object.entries(await decide(batch))
  .map(([key, answer]) => [key, { ...answer, probability: answer.probability > 0.97 ? 0.9 : 0.01 }]));

async function call(paths: Awaited<ReturnType<typeof histories>>, cache: string, task: string, sizing: boolean, filtered = false,
  options: Partial<PickOptions> = {}) {
  poolSizing.on = sizing;
  const index = { directory: cache };
  const sources: CandidateSource[] = [
    chat({ providers: ['codex'], paths: [paths.chats], index, ...(filtered ? { since: '2026-10-05' } : {}) }),
    knowledgeBase(paths.notes, { index, ...(filtered ? { since: '2026-01-01', exclude: ['n2.md'] } : {}) }),
    git(paths.repo, { index }), knowledgeBase(paths.apart, { index }),
  // The folder no lane keeps a part of has its own bar, which the record names.
  ].map((source, at) => ({ ...source, labelKinds: [], rare: false, ...(at === 3 ? { bar: 0.42 } : {}) }));
  const picked = await pickFromSources(sources, {
    task, taskDate: '2026-10-28T12:00:00Z', searchLines: ['ledger sync lease', 'replica quorum'], meaning: { embed },
  }, { task, decide: options.stopWhenCold === undefined ? decide : sparse, cache: false, ...options });
  const { log } = await curate(task, picked, { sentenceCutoff: false });
  return { picked, log };
}

it.each<[string, boolean, Partial<PickOptions>]>([
  ['', false, {}],
  [' with a look-back and an exclusion', true, {}],
  // The order decides where the stop falls and what a feed size keeps.
  [' with the stop set', false, { stopWhenCold: {}, limits: { maxPerBatch: 8 } }],
  [' with a feed size', false, { feed: { order: 'combsum', size: 300 } }],
])('keeps the selected parts, their order, the text and every record entry a lane kept when the fused order only sizes the history%s', { timeout: 120_000 }, async (_name, filtered, options) => {
  const paths = await histories();
  const cache = await folder();
  // The first call builds the stored index, which the record reports.
  await call(paths, cache, task, false, filtered, options);
  const merged = await call(paths, cache, task, false, filtered, options);
  const sized = await call(paths, cache, task, true, filtered, options);
  expect(sized.picked.selected.map((part) => [part.sourceId, part.id])).toEqual(merged.picked.selected.map((part) => [part.sourceId, part.id]));
  expect(sized.picked.selected).toEqual(merged.picked.selected);
  expect(sized.log).toBe(merged.log);
  if (options.stopWhenCold !== undefined) expect(merged.picked.record.pick?.stopWhenCold?.ended).toBe('cold');
  const byKey = (entries: readonly PickRecordEntry[]) =>
    Object.fromEntries(entries.map((entry) => [JSON.stringify([entry.sourceId, entry.id]), entry]));
  const pooled = merged.picked.record.candidates.filter((entry) => entry.poolOnly === true);
  expect(byKey(sized.picked.record.candidates)).toEqual(byKey(merged.picked.record.candidates.filter((entry) => entry.poolOnly !== true)));
  // Every part no lane kept is counted, by source, and none was ever asked.
  const counted: Record<string, number> = {};
  for (const entry of pooled) counted[entry.sourceId] = (counted[entry.sourceId] ?? 0) + 1;
  expect(Object.fromEntries(Object.entries(sized.picked.record.unheld!).filter(([, count]) => count > 0))).toEqual(counted);
  expect(pooled.every((entry) => entry.status === 'unassessed' && entry.reason === 'feed')).toBe(true);
  // Every other record field matches, the index timings aside.
  const untimed = (index: typeof merged.picked.record.index) => index === undefined ? undefined
    : Object.fromEntries(Object.entries(index).map(([id, { ms: _ms, ...rest }]) => [id, rest]));
  const { candidates: _a, unheld: _b, index: sizedIndex, ...sizedRest } = sized.picked.record;
  const { candidates: _c, index: mergedIndex, ...mergedRest } = merged.picked.record;
  expect(sizedRest).toEqual(mergedRest);
  expect(untimed(sizedIndex)).toEqual(untimed(mergedIndex));
  const bare = (reads: typeof merged.picked.reads) => reads.map((read) => {
    if (read.status !== 'read') return read;
    const { ms: _ms, ...index } = read.index ?? { ms: 0 };
    return { ...read, candidates: [], index };
  });
  expect(bare(sized.picked.reads)).toEqual(bare(merged.picked.reads));
  // The fixture exercises what it says: parts no lane kept in the chat
  // history, and a source of which no lane kept any part.
  expect(Object.keys(counted).filter((id) => /chat|apart/.test(id)).length).toBe(2);
  expect(sized.picked.record.candidates.some((entry) => entry.sourceId.includes('apart'))).toBe(false);
  expect(Object.entries(sized.picked.record.unheld!).some(([id, count]) => id.includes('apart') && count > 0)).toBe(true);
  expect(sized.picked.record.candidates.length).toBeLessThan(merged.picked.record.candidates.length);
});

it('keeps every part of the history in the record when the task names a period', { timeout: 120_000 }, async () => {
  // A part the period brings in that no lane kept is ordered among the
  // parts no lane kept, so the history is merged as before.
  const periodTask = 'Why did we drop the quorum lease for the ledger sync on 2026-10-03?';
  const paths = await histories();
  const cache = await folder();
  await call(paths, cache, periodTask, false);
  const merged = await call(paths, cache, periodTask, false);
  const sized = await call(paths, cache, periodTask, true);
  expect(sized.log).toBe(merged.log);
  const untimed = (record: typeof merged.picked.record) => ({ ...record, index: Object.fromEntries(
    Object.entries(record.index ?? {}).map(([id, { ms: _ms, ...rest }]) => [id, rest])) });
  expect(untimed(sized.picked.record)).toEqual(untimed(merged.picked.record));
  expect(sized.picked.record.unheld).toBeUndefined();
  expect(merged.picked.record.candidates.some((entry) => entry.poolOnly === true && entry.dateWindow === 'task-period')).toBe(true);
});

it.each([['', false], [', and scores meaning over the whole history for a reader that does not', true]] as const)('sizes a history by the source ID its parts carry, lane parts the whole read does not return included%s', async (_name, meaning) => {
  const part = (sourceId: string, id: string, text: string): MemoryCandidate =>
    ({ sourceId, id, role: 'reference', title: id, text, signals: { score: 0 } });
  // A source whose whole read holds 30 parts of its own, 3 under
  // another ID and 2 under a third ID no lane keeps, and whose lanes also
  // keep 2 parts the whole read misses.
  const pool = [...Array.from({ length: 30 }, (_, at) => part('stand-in', `p${at}`, at < 6 ? `quorum lease ${at}` : `filler ${at}`)),
    ...Array.from({ length: 3 }, (_, at) => part('stand-in/linked', `q${at}`, at === 0 ? 'quorum lease linked' : `linked filler ${at}`)),
    ...Array.from({ length: 2 }, (_, at) => part('stand-in/apart', `r${at}`, `apart filler ${at}`))];
  const laneOnly = [part('stand-in', 'lane-only', 'quorum lease kept by a lane only'), part('stand-in/linked', 'q-lane', 'quorum lease linked lane')];
  let reads = 0;
  const source: CandidateSource = { id: 'stand-in', role: 'reference', labelKinds: [], rare: false, bar: 0.3,
    read: async (request) => (reads += 1) && request.wholeLanes === true ? { status: 'read', complete: true, candidates: pool }
      : { status: 'read', complete: true, laneCutApplied: true,
        candidates: [...pool, ...laneOnly].filter((candidate) => /quorum/.test(candidate.text) && /quorum/.test(request.task))
          .map((candidate) => ({ ...candidate, signals: { keyword: 1 }, laneScore: 1 })) } };
  const task = 'Why did we drop the quorum lease?';
  const run = async (sizing: boolean) => {
    poolSizing.on = sizing;
    return pickFromSources([source], { task, taskDate: '2026-10-28T12:00:00Z', searchLines: ['quorum lease'],
      ...(meaning ? { meaning: { embed: async (texts: readonly string[]) => texts.map((text) => [/filler 1/.test(text) ? 1 : 0.1, 0.5]) } } : {}) },
    { task, decide, cache: false });
  };
  const merged = await run(false);
  const mergedReads = reads;
  const sized = await run(true);
  // A reader that ignores `poolIds` is not read for its whole history twice.
  expect(reads - mergedReads).toBe(mergedReads);
  expect(sized.selected).toEqual(merged.selected);
  expect(merged.record.pick?.n).toBe(37);
  const { candidates: _a, unheld, ...sizedRest } = sized.record;
  const { candidates: _b, ...mergedRest } = merged.record;
  expect(sizedRest).toEqual(mergedRest);
  const counted: Record<string, number> = {};
  for (const entry of merged.record.candidates) if (entry.poolOnly === true) counted[entry.sourceId] = (counted[entry.sourceId] ?? 0) + 1;
  expect(Object.fromEntries(Object.entries(unheld!).filter(([, count]) => count > 0))).toEqual(counted);
  if (!meaning) expect(unheld).toEqual({ 'stand-in': 24, 'stand-in/linked': 2, 'stand-in/apart': 2 });
  // The same entries; a part only a meaning lane kept can sit elsewhere in the list.
  const byKey = (entries: readonly PickRecordEntry[]) =>
    Object.fromEntries(entries.map((entry) => [JSON.stringify([entry.sourceId, entry.id]), entry]));
  expect(byKey(sized.record.candidates)).toEqual(byKey(merged.record.candidates.filter((entry) => entry.poolOnly !== true)));
  expect(sized.record.candidates).toHaveLength(merged.record.candidates.filter((entry) => entry.poolOnly !== true).length);
});
