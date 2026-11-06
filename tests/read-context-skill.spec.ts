import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { cachedEmbeddings, type CandidateReadRequest, type MemoryCandidate } from '@curatejs/core';
import { knowledgeBase } from '@curatejs/markdown';
// @ts-expect-error The standalone command has no type declarations.
import { holdVectors, pickFullSources, searchSource } from '../skills/curate/run.mjs';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function folder() {
  const path = await mkdtemp(join(tmpdir(), 'curate-context-'));
  folders.push(path);
  return path;
}

const decide = async ({ questions }: { questions: { key: string }[] }) =>
  Object.fromEntries(questions.map((question) => [question.key, { status: 'answered', probability: 0.8 }]));

async function notes() {
  const directory = await folder();
  await writeFile(join(directory, 'orchard.md'), '# Orchard\n\nAda planted apple trees.\n\n## Pears\n\nThe pears ripen late.\n');
  await writeFile(join(directory, 'barn.md'), '# Barn\n\nThe barn roof leaks after rain.\n');
  return directory;
}

const searches = { markdown: { keywords: ['orchard trees', 'apple'], answers: ['Ada planted the trees', 'pears ripen late'] } };

// Every file read under a vector store's folder. The store reads files
// through node:fs/promises, so the count wraps that module's readFile.
const realReadFile = fs.promises.readFile;
const vectorFolders: string[] = [];
const vectorReads: string[] = [];
beforeEach(() => {
  fs.promises.readFile = ((path: unknown, ...rest: unknown[]) => {
    if (typeof path === 'string' && vectorFolders.some((root) => path.startsWith(root + sep))) vectorReads.push(path);
    return (realReadFile as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof realReadFile;
  syncBuiltinESMExports();
});
afterEach(() => {
  fs.promises.readFile = realReadFile;
  syncBuiltinESMExports();
  vectorFolders.length = 0;
  vectorReads.length = 0;
});

/** A vector store on disk. It keeps one file per text, named by the
 *  text's hash. */
async function vectorStore() {
  const directory = await folder();
  vectorFolders.push(directory);
  const embed = cachedEmbeddings(async (texts) => texts.map((text) => [text.length % 7 + 1, 1]),
    { directory, modelId: 'fixture-model' });
  return { embed };
}
const vectorFile = (text: string) => `${createHash('sha256').update(text).digest('hex')}.json`;
const fileName = (path: string) => path.slice(path.lastIndexOf(sep) + 1);

it('shares one read context across every read of one call, and makes a new one for the next call', async () => {
  const reads: { context: unknown; nameLane: boolean }[] = [];
  const source = { id: 'notes', kind: 'markdown', role: 'reference', names: true, rare: false, labelKinds: [],
    async read(request: CandidateReadRequest, context?: unknown) {
      reads.push({ context, nameLane: request.phraseLane === true });
      const part: MemoryCandidate = { sourceId: 'notes', id: 'note', role: 'reference', title: 'Ada', text: 'Ada decided.',
        signals: { keyword: 1 } };
      return { status: 'read', complete: true, candidates: [part] };
    },
  };
  const call = () => pickFullSources([source], { task: 'What did Ada decide?', searchLines: ['the decision'] },
    { task: 'What did Ada decide?', everyScored: true, findNames: async () => ['Ada'], decide });
  await call();
  const first = reads.splice(0);
  await call();
  // The pre-reads and the name lane the pick reads itself.
  expect(first.some((read) => read.nameLane)).toBe(true);
  expect(first.some((read) => !read.nameLane)).toBe(true);
  expect(first[0]!.context).toBeDefined();
  expect(new Set(first.map((read) => read.context)).size).toBe(1);
  expect(new Set(reads.map((read) => read.context)).size).toBe(1);
  expect(reads[0]!.context).not.toBe(first[0]!.context);
});

it('reads each vector file once per call, so a later meaning lane over embedded texts reads none', async () => {
  const directory = await notes();
  const { embed } = await vectorStore();
  // Two search lines with the same words: the second meaning lane asks
  // for the same query and parts as the first.
  const same = { markdown: { keywords: ['orchard trees', 'orchard trees'], answers: ['pears ripen late'] } };
  const searched = searchSource({ ...knowledgeBase(directory), labelKinds: [], rare: false }, same, [], directory);
  // Each meaning lane: the texts it asks for and the vector files read while it runs.
  const lanes: { task: string; asked: string[]; reads: string[] }[] = [];
  const source = { ...searched, async read(request: CandidateReadRequest, context: unknown) {
    const meaning = request.meaningLane;
    if (meaning === undefined) return searched.read(request, context);
    const lane = { task: request.task, asked: [] as string[], reads: [] as string[] };
    const before = vectorReads.length;
    const result = await searched.read({ ...request, meaningLane: { ...meaning, embed: (texts: readonly string[], signal?: AbortSignal) => {
      lane.asked.push(...texts);
      return meaning.embed(texts, signal);
    } } }, context);
    lane.reads = vectorReads.slice(before).map(fileName);
    lanes.push(lane);
    return result;
  } };
  const call = () => pickFullSources([source],
    { task: 'orchard', searchLines: ['curate-search:0', 'curate-search:1', 'curate-search:2'], meaning: { embed } },
    { task: 'orchard', decide });
  await call();
  const first = { reads: vectorReads.splice(0).map(fileName), lanes: lanes.splice(0) };
  expect(first.lanes.map((lane) => lane.task)).toEqual(['orchard', 'curate-search:0', 'curate-search:1', 'curate-search:2']);
  const asked = first.lanes.flatMap((lane) => lane.asked);
  // Each distinct text's vector file is read once, and no other file is read.
  expect(asked).toContain('# Barn\n\nThe barn roof leaks after rain.\n');
  expect([...first.reads].sort()).toEqual([...new Set(asked)].map(vectorFile).sort());
  // The repeated lane asks only for texts an earlier lane embedded, and reads no vector file.
  const earlier = new Set(first.lanes.slice(0, 2).flatMap((lane) => lane.asked));
  const repeated = first.lanes[2]!;
  expect(repeated.asked).toContain('# Barn\n\nThe barn roof leaks after rain.\n');
  expect(repeated.asked.every((text) => earlier.has(text))).toBe(true);
  expect(first.lanes[1]!.reads.length).toBeGreaterThan(0);
  expect(repeated.reads).toEqual([]);
  // The next call holds nothing from this one, so it reads every file again.
  await call();
  expect(vectorReads.map(fileName).sort()).toEqual([...first.reads].sort());
}, 60_000);

it('returns the vectors the store gave, unchanged', async () => {
  const given: number[][] = [];
  const held = holdVectors(async (texts: readonly string[]) => texts.map((text) => {
    const vector = [Math.PI / text.length, 1 / 3];
    given.push(vector);
    return vector;
  }));
  const first = await held(['apple', 'pear']);
  const second = await held(['pear', 'apple', 'plum']);
  expect(first).toEqual([given[0], given[1]]);
  expect(second[0]).toBe(given[1]);
  expect(second[1]).toBe(given[0]);
  expect(second[2]).toBe(given[2]);
  expect(given).toHaveLength(3);
});

it('stops a call cancelled during a read and keeps nothing for the next call', async () => {
  const directory = await notes();
  const { embed } = await vectorStore();
  const contexts: unknown[] = [];
  let controller = new AbortController();
  let stop = true;
  const stopping = async (texts: readonly string[], signal?: AbortSignal) => {
    const vectors = await embed(texts, signal);
    if (stop && texts.length > 1) controller.abort();
    return vectors;
  };
  const searched = searchSource({ ...knowledgeBase(directory), labelKinds: [], rare: false }, searches, [], directory);
  const source = { ...searched, read: (request: CandidateReadRequest, context: unknown) => {
    contexts.push(context);
    return searched.read(request, context);
  } };
  const call = () => pickFullSources([source], { task: 'orchard', searchLines: ['curate-search:0', 'curate-search:1'],
    meaning: { embed: stopping }, signal: controller.signal }, { task: 'orchard', decide });
  await expect(call()).rejects.toThrow(/cancel/i);
  const cancelled = { reads: vectorReads.splice(0), contexts: contexts.splice(0) };
  expect(cancelled.reads.map(fileName)).toContain(vectorFile('# Barn\n\nThe barn roof leaks after rain.\n'));
  controller = new AbortController();
  stop = false;
  await call();
  // Every vector file the cancelled call read is read again.
  expect(vectorReads).toEqual(expect.arrayContaining(cancelled.reads));
  expect(contexts.some((context) => cancelled.contexts.includes(context))).toBe(false);
}, 60_000);
