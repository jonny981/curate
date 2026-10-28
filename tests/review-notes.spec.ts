import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { reviewNotes } from '@curatejs/markdown';
import type { PickBatch, PickDecide, PickQuestion } from '@curatejs/core';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** Note A: two stale parts. Note B: one lasting part. Note C: marked superseded. Note D: one stale part, one not. */
async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'curate-review-'));
  directories.push(directory);
  await writeFile(join(directory, 'a.md'), '---\ndate: 2023-01-01\n---\n## Plan\nShip the beta in March.\n## Owners\nSam runs the beta.\n');
  await writeFile(join(directory, 'b.md'), '---\ndate: 2024-01-01\n---\n## Rule\nEvery deploy needs two approvals.\n## Meeting\nWe met on Tuesday.\n');
  await writeFile(join(directory, 'c.md'), '---\ndate: 2022-01-01\nstatus: superseded\n---\n## Old\nUse the old queue.\n');
  await writeFile(join(directory, 'd.md'), '---\ndate: 2024-06-01\n---\n## Done\nMigrate the cache.\n## Still\nThe cache lives in Redis.\n');
  return directory;
}

/** The answers by note file and section: `stale` and `lasting`. */
const ANSWERS: Record<string, { stale: number; lasting: number }> = {
  'a.md#1': { stale: 0.9, lasting: 0.1 }, 'a.md#2': { stale: 0.9, lasting: 0.1 },
  'b.md#1': { stale: 0.1, lasting: 0.8 }, 'b.md#2': { stale: 0.1, lasting: 0.1 },
  'c.md#1': { stale: 0.9, lasting: 0.1 },
  'd.md#1': { stale: 0.9, lasting: 0.1 }, 'd.md#2': { stale: 0.1, lasting: 0.1 },
};
const part = (id: string) => id.slice(id.lastIndexOf('/') + 1);

function stub() {
  const batches: PickBatch[] = [];
  const decide: PickDecide = Object.assign(async (batch: PickBatch) => {
    batches.push(batch);
    return Object.fromEntries(batch.questions.map((q: PickQuestion) =>
      [q.key, { status: 'answered' as const, probability: ANSWERS[part(q.id)]![q.questionKey as 'stale' | 'lasting'] }]));
  }, { deciderId: 'stub-review' });
  return { decide, batches, questions: () => batches.flatMap((batch) => batch.questions) };
}

async function snapshot(directory: string) {
  const names = (await readdir(directory)).sort();
  return Promise.all(names.map(async (name) => ({
    name, bytes: (await readFile(join(directory, name))).toString('base64'), mtime: (await stat(join(directory, name))).mtimeMs,
  })));
}

describe('reviewNotes proposes and never edits', () => {
  it('proposes a retire for an all-stale note and a promote for a lasting part', async () => {
    const directory = await fixture();
    const before = await snapshot(directory);
    const { decide, batches, questions } = stub();
    const { proposals, record } = await reviewNotes({ paths: [directory], kind: 'knowledge', decide,
      taskDate: '2025-06-02', timeZone: 'UTC' });

    expect(proposals.map((p) => [part(p.path), p.action])).toEqual([['a.md', 'retire'], ['b.md', 'promote']]);
    const [retire, promote] = proposals;
    expect(retire).toMatchObject({ edit: 'status: deprecated', date: { value: '2023-01-01', meaning: 'recorded' } });
    expect(retire!.parts.map((p) => [part(p.id), p.probability])).toEqual([['a.md#1', 0.9], ['a.md#2', 0.9]]);
    expect(promote!.edit).toBeUndefined();
    expect(promote!.parts.map((p) => [part(p.id), p.probability])).toEqual([['b.md#1', 0.8]]);

    // Note C is marked replaced, so it is asked only `lasting`; note D has one part that is not stale.
    expect(questions().filter((q) => part(q.id) === 'c.md#1').map((q) => q.questionKey)).toEqual(['lasting']);
    expect(proposals.some((p) => part(p.path) === 'c.md' || part(p.path) === 'd.md')).toBe(false);

    // Each question carries the part's date and the as-of date, and so does the batch's task text.
    for (const q of questions()) {
      expect(q.date?.value).toMatch(/^202\d-\d\d-01$/);
      expect(q.question).toContain('2025-06-02');
    }
    expect(batches.every((batch) => batch.task.includes('2025-06-02'))).toBe(true);
    expect(record).toMatchObject({ notes: 4, parts: 7, questions: 13, deciderId: 'stub-review', bar: 0.5, unanswered: [] });
    expect(record.asOf).toBe('2025-06-02T23:59:59.999+00:00');

    expect(await snapshot(directory)).toEqual(before);
  });

  it('proposes nothing below the bar', async () => {
    const { decide } = stub();
    const { proposals, record } = await reviewNotes({ paths: [await fixture()], kind: 'knowledge', decide,
      taskDate: '2025-06-02', timeZone: 'UTC', bar: 0.95 });
    expect(proposals).toEqual([]);
    expect(record.bar).toBe(0.95);
  });

  it('asks a rules source no lasting question', async () => {
    const { decide, questions } = stub();
    await reviewNotes({ paths: [await fixture()], kind: 'rules', decide, taskDate: '2025-06-02', timeZone: 'UTC' });
    expect(new Set(questions().map((q) => q.questionKey))).toEqual(new Set(['stale']));
  });

  it('records the parts a stop left unanswered', async () => {
    const controller = new AbortController();
    const decide: PickDecide = async () => { throw new Error('unused'); };
    controller.abort();
    const directory = await fixture();
    await expect(reviewNotes({ paths: [directory], kind: 'knowledge', decide, signal: controller.signal }))
      .rejects.toThrow('cancelled');
    const failed: PickDecide = async () => { throw new Error('the model is down'); };
    const { proposals, record } = await reviewNotes({ paths: [directory], kind: 'knowledge', decide: failed,
      taskDate: '2025-06-02', timeZone: 'UTC' });
    expect(proposals).toEqual([]);
    expect(record.unanswered).toHaveLength(13);
    expect(record.unanswered[0]).toMatchObject({ reason: 'error', detail: 'the model is down' });
  });
});
