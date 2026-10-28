import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chat, chatSettings } from '@curatejs/chat';
import { knowledgeBase, markdownSettings } from '@curatejs/markdown';
import { historySource, pickFromSources, type CandidateReadResult, type MemoryCandidate, type PickDecide } from '@curatejs/core';

const directories: string[] = [];
async function folder(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'curate-decay-'));
  directories.push(directory);
  return directory;
}
beforeEach(async () => { vi.stubEnv('XDG_CACHE_HOME', await folder()); });
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** A notes folder: each note's file name, front-matter date line and body. */
async function notes(files: Readonly<Record<string, { readonly date: string; readonly body: string }>>): Promise<string> {
  const directory = await folder();
  for (const [name, { date, body }] of Object.entries(files)) await writeFile(join(directory, name), `---\n${date}\n---\n${body}\n`);
  return directory;
}

const decide: PickDecide = Object.assign(async ({ questions }: { questions: readonly { key: string }[] }) =>
  Object.fromEntries(questions.map((q) => [q.key, { status: 'answered' as const, probability: 0.5 }])), { deciderId: 'stub' });

function candidates(read: CandidateReadResult | undefined): readonly MemoryCandidate[] {
  if (read?.status !== 'read') throw new Error('Expected a read.');
  return read.candidates;
}
/** The parts the read's lane kept, without the uncut pool the rare-word round counts. */
const laneKept = (read: CandidateReadResult | undefined) => candidates(read).filter((c) => c.poolOnly !== true).map((c) => c.id);

const same = 'The deploy freeze holds for the billing service.';
const task = 'deploy freeze for billing';
const options = { task, decide, taskDate: '2025-06-02', timeZone: 'UTC' };

describe('decay ranks a note lower by its age at the task date', () => {
  it('ranks the older of two equal notes lower', async () => {
    const directory = await notes({
      '2020.md': { date: 'date: 2020-01-01', body: same },
      '2025.md': { date: 'date: 2025-06-01', body: same },
    });
    const source = historySource({ reader: knowledgeBase(directory), ...markdownSettings, decay: { halfLife: '365 days' } });
    const { reads, record } = await pickFromSources([source], { task }, options);
    const read = candidates(reads[0]);
    expect(read.map((c) => c.id)).toEqual(['2025.md#1', '2020.md#1']);
    // Ages from the start of each note's day to the end of the task date, in days: 1,981 and 2.
    const decay = (from: string) => -2 * (1 - 2 ** (-((Date.parse('2025-06-02T23:59:59.999Z') - Date.parse(from)) / 86_400_000) / 365));
    expect(read[1]!.signals['decay']).toBeCloseTo(decay('2020-01-01T00:00:00Z'), 10);
    expect(read[1]!.signals['decay']).toBeCloseTo(-1.953, 3);
    expect(read[0]!.signals['decay']).toBeCloseTo(-0.0076, 4);
    expect(record.levers.sources[source.id]?.decay).toEqual({ halfLife: '365 days' });
  });

  it('leaves every part without a decay signal under markdownSettings as it comes', async () => {
    const directory = await notes({
      '2020.md': { date: 'date: 2020-01-01', body: same },
      '2025.md': { date: 'date: 2025-06-01', body: same },
    });
    const source = knowledgeBase(directory);
    const { reads, record } = await pickFromSources([source], { task }, options);
    expect(candidates(reads[0]).length).toBe(2);
    expect(candidates(reads[0]).every((c) => c.signals['decay'] === undefined)).toBe(true);
    expect(record.levers.sources[source.id]?.decay).toBeUndefined();
    expect(record.effects.some((effect) => effect.setting === 'decay')).toBe(false);
  });

  it('gives no decay to a note dated after the task date', async () => {
    const directory = await notes({
      'future.md': { date: 'effective: 2025-07-01', body: same },
      '2025.md': { date: 'date: 2025-06-01', body: same },
    });
    const source = historySource({ reader: knowledgeBase(directory), ...markdownSettings, decay: { halfLife: '365 days' } });
    const read = candidates((await pickFromSources([source], { task }, options)).reads[0]);
    expect(read.find((c) => c.id === 'future.md#1')!.signals['decay']).toBeUndefined();
    expect(read.find((c) => c.id === '2025.md#1')!.signals['decay']).toBeLessThan(0);
  });

  it('is a Markdown setting with a duration', () => {
    const reader = chat({ providers: ['claude-code'], paths: ['transcripts'] });
    expect(() => historySource({ reader, ...chatSettings, decay: { halfLife: '365 days' } }))
      .toThrow('decay applies to Markdown sources only.');
    expect(() => historySource({ reader: knowledgeBase('notes'), ...markdownSettings, decay: { halfLife: 'a year' } }))
      .toThrow('decay.halfLife must be a duration such as "365 days".');
    expect(historySource({ reader, ...chatSettings, decay: false })).not.toHaveProperty('decay');
  });
});

describe("decay's effects entry counts the lane cut", () => {
  // The task's words three times in one note, twice in two notes and in the old note, and one of them in four more.
  const fixture = () => notes({
    'a.md': { date: 'date: 2025-06-01', body: 'deploy freeze billing. deploy freeze billing. deploy freeze billing.' },
    ...Object.fromEntries(['b', 'c'].map((name) =>
      [`${name}.md`, { date: 'date: 2025-06-01', body: `deploy freeze billing ${name}. deploy freeze billing.` }])),
    'old.md': { date: 'date: 2020-01-01', body: 'deploy freeze billing old. deploy freeze billing.' },
    ...Object.fromEntries(['f', 'g', 'h', 'i'].map((name) =>
      [`${name}.md`, { date: 'date: 2025-06-01', body: `deploy note ${name}.` }])),
  });

  it('keeps the 2020 note without decay', async () => {
    const source = knowledgeBase(await fixture());
    expect(laneKept((await pickFromSources([source], { task }, options)).reads[0])).toContain('old.md#1');
  });

  it('leaves the 2020 note out with decay and says so', async () => {
    const source = historySource({ reader: knowledgeBase(await fixture()), ...markdownSettings, decay: { halfLife: '365 days' } });
    const { reads, record } = await pickFromSources([source], { task }, options);
    expect(laneKept(reads[0])).not.toContain('old.md#1');
    const effect = record.effects.find((entry) => entry.setting === 'decay');
    expect(effect).toMatchObject({ source: source.id, actedOn: 8, added: 0, dropped: 1 });
    expect(effect!.summary).toContain('left out of the read only because decay ranked it lower by its age');
  });

  it('counts no drop when a phrase lane keeps the 2020 note', async () => {
    const source = historySource({ reader: knowledgeBase(await fixture()), ...markdownSettings, decay: { halfLife: '365 days' } });
    const { reads, record } = await pickFromSources([source], { task, searchPhrases: ['billing old'] }, options);
    expect(laneKept(reads[0])).toContain('old.md#1');
    expect(record.effects.find((entry) => entry.setting === 'decay')).toMatchObject({ added: 0, dropped: 0 });
  });

  it("counts a swap the kind lane's limit makes only because of decay", async () => {
    // The task lane keeps a.md; the kind lane's limit keeps one decision note, the old one by its words, the new one by age.
    const directory = await notes({
      'a.md': { date: 'date: 2025-06-01', body: 'deploy freeze billing. deploy freeze billing. deploy freeze billing.' },
      'old.md': { date: 'date: 2020-01-01', body: 'decision: deploy freeze billing. deploy freeze.' },
      'new.md': { date: 'date: 2025-06-01', body: 'decision: deploy.' },
    });
    const request = { task, limit: 1, wholeLanes: true, kindLanes: { markdown: ['decision'] } };
    const plain = await pickFromSources([knowledgeBase(directory)], request, options);
    expect(laneKept(plain.reads[0]).sort()).toEqual(['a.md#1', 'old.md#1']);
    const source = historySource({ reader: knowledgeBase(directory), ...markdownSettings, decay: { halfLife: '365 days' } });
    const { reads, record } = await pickFromSources([source], request, options);
    expect(laneKept(reads[0]).sort()).toEqual(['a.md#1', 'new.md#1']);
    const effect = record.effects.find((entry) => entry.setting === 'decay');
    expect(effect).toMatchObject({ added: 1, dropped: 1 });
    expect(effect!.summary).toContain('left out of the read only because decay ranked it lower by its age');
  });

  it('counts no drop when a meaning lane keeps the 2020 note', async () => {
    // The task and the old note point one way, every other note the other.
    const embed = async (texts: readonly string[]) =>
      texts.map((text) => (text === task || text.includes('old') ? [1, 0] : [0, 1]));
    const source = historySource({ reader: knowledgeBase(await fixture()), ...markdownSettings, decay: { halfLife: '365 days' } });
    const { reads, record } = await pickFromSources([source], { task, meaning: { embed } }, options);
    expect(laneKept(reads[0])).toContain('old.md#1');
    expect(record.effects.find((entry) => entry.setting === 'decay')).toMatchObject({ added: 0, dropped: 0 });
  });
});
