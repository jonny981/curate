import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { knowledgeBase } from '@curatejs/markdown';
import type { MemoryCandidate } from '@curatejs/core';
// @ts-expect-error The standalone command has no type declarations.
import { pickFullSources, searchSource } from '../skills/curate/run.mjs';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

it('keeps a meaning-only match through the skill cache and embeds source search lines', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'curate-funnel-'));
  folders.push(folder);
  for (const [name, text] of [['mail', 'Retire the mail queue.'], ['messages', 'Archive message backlog.'],
    ['bread', 'Bake sourdough bread.'], ['paint', 'Paint kitchen cupboards.']]) {
    await writeFile(join(folder, `${name}.md`), `# Notes\n\n${text}\n`);
  }
  const inputs: string[] = [];
  const embed = async (texts: readonly string[]) => {
    inputs.push(...texts);
    return texts.map((text) => /retire|archive|message|backlog|correspondence/i.test(text) ? [1, 0] : [0, 1]);
  };
  const searches = { markdown: { keywords: ['archive message'], answers: ['discard old correspondence'] } };
  const source = { ...knowledgeBase(folder), labelKinds: [], rare: false, names: false };
  const evaluate = async (meaning: boolean) => {
    const asked = new Set<string>();
    const calls: { task: string; meaningLane: boolean; pickRead: boolean }[] = [];
    const searched = searchSource(source, searches, [], folder);
    const counting = { ...searched, async read(request: { task: string; meaningLane?: unknown }, context?: unknown) {
      calls.push({ task: request.task, meaningLane: request.meaningLane !== undefined, pickRead: context !== undefined });
      return searched.read(request);
    } };
    const result = await pickFullSources([counting], {
      task: 'archive message backlog', searchLines: ['curate-search:0', 'curate-search:1', 'curate-search:2'],
      ...(meaning ? { meaning: { embed } } : {}),
    }, { task: 'archive message backlog', everyScored: true,
      decide: async (batch: { questions: { key: string; text: string }[] }) => Object.fromEntries(batch.questions.map((question) => {
        asked.add(question.text);
        return [question.key, { status: 'answered', probability: 0.8 }];
      })),
    });
    return { asked, result, calls };
  };
  const keyword = await evaluate(false);
  expect([...keyword.asked].some((text) => text.includes('Retire the mail queue.'))).toBe(false);
  const meaning = await evaluate(true);
  expect([...meaning.asked].some((text) => text.includes('Retire the mail queue.'))).toBe(true);
  // The pick's four meaning reads all came from pickFullSources' cache:
  // the wrapped source saw each meaning lane read once, in the pre-reads,
  // and no read of the same lane inside the pick. A read the pick issues
  // carries its read context; a pre-read carries none, so a meaning read
  // with a context is one the cache did not hold.
  expect(meaning.calls.filter((read) => read.meaningLane).map((read) => read.task))
    .toEqual(['archive message backlog', 'curate-search:0', 'curate-search:1', 'curate-search:2']);
  expect(meaning.calls.some((read) => read.meaningLane && read.pickRead)).toBe(false);
  expect(inputs).toContain('discard old correspondence');
  expect(inputs.some((text) => text.startsWith('curate-search:'))).toBe(false);
  expect(meaning.result.record.candidates.filter((part: { status: string }) => part.status === 'selected')).toHaveLength(2);
  expect(meaning.result.selected.map((part: MemoryCandidate) => part.text).join('\n')).not.toContain('Bake sourdough');
  const audit = JSON.parse(await readFile(join(folder, 'read-1.json'), 'utf8'));
  expect(audit.status).toBe('read');
}, 60_000);

it('shows the complete text of a name match found after the cached reads', async () => {
  const text = `Ada decided to preserve the queue. ${'Detailed evidence. '.repeat(200)}`;
  const source = { id: 'notes', kind: 'markdown', role: 'reference', names: true, rare: false, labelKinds: [],
    async read(request: { phraseLane?: boolean }) {
      return { status: 'read', complete: true, candidates: [{
        sourceId: 'notes', id: request.phraseLane ? 'name-match' : 'short-match', role: 'reference',
        title: 'Ada', text: request.phraseLane ? text : 'Ada decided.', signals: { keyword: 1 },
      }] };
    },
  };
  const asked = new Map<string, string>();
  await pickFullSources([source], { task: 'What did Ada decide?' }, {
    task: 'What did Ada decide?', everyScored: true, findNames: async () => ['Ada'],
    decide: async ({ questions }: { questions: { key: string; id: string; text: string }[] }) =>
      Object.fromEntries(questions.map((question) => {
        asked.set(question.id, question.text);
        return [question.key, { status: 'answered', probability: 0.8 }];
      })),
  });
  expect(asked.get('name-match')).toBe(text);
}, 60_000);
