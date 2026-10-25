import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { chatSettings } from '@curatejs/chat';
import { historySource, pickFromSources, type PickBatch, type PickDecide } from '@curatejs/core';
import { decide, fixtureSource, parts, task } from './fixtures/source-settings.js';

const pool = parts('chat', 'chatword');
const source = () => historySource({ reader: fixtureSource('chat', pool, { rare: false }), ...chatSettings });

let folder: string;
beforeEach(() => { folder = mkdtempSync(join(tmpdir(), 'curate-labels-in-flight-')); });
afterEach(() => { rmSync(folder, { recursive: true, force: true }); });

/** The fixture's decide, 50 ms late, counting the label questions it was asked about each chat part.
 *  `fail` rejects a part-label batch instead of answering it; `hold` delays the task-label batch. */
function counting(fail?: () => Promise<void>, hold?: () => Promise<unknown>) {
  const asked = new Map<string, number>();
  let called!: () => void;
  const first = new Promise<void>((resolve) => { called = resolve; });
  const how: PickDecide = Object.assign(async (batch: PickBatch, signal: AbortSignal) => {
    called();
    const labels = batch.task !== task && batch.questions.some((q) => q.sourceId === 'chat');
    const taskLabels = batch.task !== task && batch.questions.some((q) => q.sourceId === 'labels');
    for (const q of batch.questions) if (labels && q.sourceId === 'chat') asked.set(q.id, (asked.get(q.id) ?? 0) + 1);
    if (taskLabels && hold) await hold();
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (labels && fail) {
      await fail();
      throw new Error('label batch rejected');
    }
    return decide(batch, signal);
  }, { deciderId: 'fixture' });
  return { asked, how, first };
}

const run = (how: PickDecide, directory: string) =>
  pickFromSources([source()], { task }, { task, decide: how, labels: { directory } });

describe('picks running together share label work in flight', () => {
  it('asks each part once across two picks on one label directory, and both use the same labels', async () => {
    const one = counting();
    const two = counting();
    const directory = join(folder, 'labels');
    const picked = await Promise.all([run(one.how, directory), run(two.how, directory)]);

    for (const part of pool) {
      expect((one.asked.get(part.id) ?? 0) + (two.asked.get(part.id) ?? 0), part.id).toBe(7);
    }
    expect(picked[0].selected.map((c) => c.id)).toEqual(picked[1].selected.map((c) => c.id));
    expect(picked[0].record.candidates).toEqual(picked[1].record.candidates);
    const [asker, waiter] = one.asked.size >= two.asked.size ? [0, 1] : [1, 0];
    const waiterAsked = [one, two][waiter]!.asked.size;
    expect(picked[asker]!.record.labels!.waited).toBeUndefined();
    expect(picked[waiter]!.record.labels!.waited).toBe(pool.length - waiterAsked);
    expect(picked[waiter]!.record.labels!.waited).toBeGreaterThan(0);
  });

  it('lets the second pick ask the parts itself when the first pick\'s label batch fails', async () => {
    const two = counting();
    const one = counting(async () => {
      await two.first;
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    const directory = join(folder, 'labels');
    const first = run(one.how, directory);
    const failed = expect(first).rejects.toThrow('label batch rejected');
    while (one.asked.size === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await run(two.how, directory);
    await failed;

    for (const part of pool) expect(two.asked.get(part.id), part.id).toBe(7);
    expect(second.record.labels!.waited).toBeUndefined();
    expect(second.record.labels!.asked).toBe(pool.length + 1);
    const alone = await run(counting().how, join(folder, 'alone'));
    expect(second.record.candidates).toEqual(alone.record.candidates);
  });

  it('lets the second pick ask the parts itself when the first pick is cancelled and its decide call never returns', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const one = counting(() => held);
    const two = counting();
    const directory = join(folder, 'labels');
    const cancel = new AbortController();
    const first = pickFromSources([source()], { task },
      { task, decide: one.how, labels: { directory }, signal: cancel.signal });
    while (one.asked.size === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const second = run(two.how, directory);
    await two.first;
    cancel.abort();
    const picked = await second;
    release();
    await first.catch(() => undefined);

    for (const part of pool) expect(two.asked.get(part.id), part.id).toBe(7);
    expect(picked.record.labels!.waited).toBeUndefined();
  });

  it('asks each part once when one pick\'s task labels return after the other pick has finished', async () => {
    const one = counting();
    let done!: Promise<unknown>;
    const two = counting(undefined, () => done);
    const directory = join(folder, 'labels');
    const first = run(one.how, directory);
    done = first;
    const picked = await Promise.all([first, run(two.how, directory)]);

    for (const part of pool) {
      expect((one.asked.get(part.id) ?? 0) + (two.asked.get(part.id) ?? 0), part.id).toBe(7);
    }
    expect(picked[0].record.candidates).toEqual(picked[1].record.candidates);
  });

  it('lets one of two waiters ask again after the first pick fails, and the other wait for it', async () => {
    const two = counting();
    const three = counting();
    const one = counting(async () => {
      await Promise.all([two.first, three.first]);
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    const directory = join(folder, 'labels');
    const first = run(one.how, directory);
    const failed = expect(first).rejects.toThrow('label batch rejected');
    while (one.asked.size === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const picked = await Promise.all([run(two.how, directory), run(three.how, directory)]);
    await failed;

    for (const part of pool) {
      expect((two.asked.get(part.id) ?? 0) + (three.asked.get(part.id) ?? 0), part.id).toBe(7);
    }
    expect(picked[0].record.candidates).toEqual(picked[1].record.candidates);
    const waits = picked.map(({ record }) => record.labels!.waited ?? 0).sort((a, b) => a - b);
    expect(waits).toEqual([0, pool.length]);
  });

  it('never shares between picks on different label directories', async () => {
    const one = counting();
    const two = counting();
    const picked = await Promise.all([run(one.how, join(folder, 'one')), run(two.how, join(folder, 'two'))]);

    for (const part of pool) {
      expect(one.asked.get(part.id), part.id).toBe(7);
      expect(two.asked.get(part.id), part.id).toBe(7);
    }
    for (const { record } of picked) expect(record.labels!.waited).toBeUndefined();
  });
});
