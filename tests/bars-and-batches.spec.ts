import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chatSettings } from '@curatejs/chat';
import { historySource, type PickSourcesResult } from '@curatejs/core';
import { chatSource, fixturePick, pickFields, PICK_RUNS } from './fixtures/bars-and-batches.js';
import { fixtureSource, parts } from './fixtures/source-settings.js';

// What the build before these settings made on these fixtures: for each pick run, the selected ids and the
// SHA-256 of `pickFields`.
interface Baseline {
  readonly picks: Readonly<Record<string, { readonly selected: readonly string[]; readonly sha256: string }>>;
}
const baseline: Baseline = JSON.parse(readFileSync(join(__dirname, 'fixtures/bars-and-batches-baseline.json'), 'utf8'));

let cache: string;
beforeEach(() => { cache = mkdtempSync(join(tmpdir(), 'curate-bars-and-batches-')); vi.stubEnv('XDG_CACHE_HOME', cache); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(cache, { recursive: true, force: true }); });
/** A fresh label store, so a second pick in one test asks its labels again. */
const freshStore = () => {
  rmSync(cache, { recursive: true, force: true });
  cache = mkdtempSync(join(tmpdir(), 'curate-bars-and-batches-'));
  vi.stubEnv('XDG_CACHE_HOME', cache);
};

/** One source's record entries: id, status and probability. */
const entriesOf = (picked: PickSourcesResult, sourceId: string) => picked.record.candidates
  .filter((c) => c.sourceId === sourceId)
  .map((c) => [c.id, c.status, 'probability' in c ? c.probability ?? null : null]);

describe('labelBar on a source', () => {
  it.each(Object.keys(PICK_RUNS))('every source at the default bar reproduces the baseline: %s', async (name) => {
    const { picked, requests } = await fixturePick(PICK_RUNS[name]!());
    expect(pickFields(picked, requests)).toEqual(baseline.picks[name]);
  });

  it('labelBar 0.5 reproduces the baseline chat labels pick', async () => {
    const { picked, requests } = await fixturePick([chatSource('chat', { labelBar: 0.5 })]);
    expect(pickFields(picked, requests)).toEqual(baseline.picks['chat labels']);
    expect(picked.record.levers.sources.chat?.labelBar).toBe(0.5);
  });

  it('a higher bar admits fewer parts and is recorded', async () => {
    const at5 = await fixturePick([chatSource()]);
    freshStore();
    const at9 = await fixturePick([chatSource('chat', { labelBar: 0.9 })]);
    expect(at9.picked.record.labels!.gate).toBeLessThan(at5.picked.record.labels!.gate);
    expect(at9.picked.record.levers.sources.chat?.labelBar).toBe(0.9);
    const labels = at9.picked.record.effects.find((e) => e.setting === 'labels' && e.source === 'chat');
    expect(labels?.summary).toContain('label bar 0.9');
  });

  it('acts on its own source only', async () => {
    const alone = async (id: string, labelBar: number) => {
      freshStore();
      return entriesOf((await fixturePick([chatSource(id, { labelBar })])).picked, id);
    };
    const aAlone = await alone('chat-a', 0.5);
    freshStore();
    const { picked } = await fixturePick([chatSource('chat-a', { labelBar: 0.5 }), chatSource('chat-b', { labelBar: 0.9 })]);
    expect(entriesOf(picked, 'chat-a')).toEqual(aAlone);
    expect(picked.record.levers.sources['chat-a']?.labelBar).toBe(0.5);
    expect(picked.record.levers.sources['chat-b']?.labelBar).toBe(0.9);
    const summary = (id: string) => picked.record.effects.find((e) => e.setting === 'labels' && e.source === id)?.summary;
    expect(summary('chat-a')).toContain('label bar 0.5');
    expect(summary('chat-b')).toContain('label bar 0.9');
  });

  it.each([1.5, Number.NaN, -0.1])('historySource refuses labelBar %s', (labelBar) => {
    expect(() => historySource({ reader: fixtureSource('chat', parts('chat', 'chatword'), { rare: false }),
      ...chatSettings, labelBar })).toThrow(TypeError);
  });
});
