import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chatSettings } from '@curatejs/chat';
import { curate, DEFAULT_BATCH_TOKENS, historySource, type PickSourcesResult } from '@curatejs/core';
import {
  chatSource, CURATE_WAYS, curatePick, curatePrompts, fixturePick, pickFields, PICK_RUNS, recordingWriter, sha256,
} from './fixtures/bars-and-batches.js';
import { fixtureSource, parts, task } from './fixtures/source-settings.js';

// What the build before these settings made on these fixtures: for each pick run, the selected ids and the
// SHA-256 of `pickFields`; for each curate way, the SHA-256 of every prompt it wrote.
interface Baseline {
  readonly picks: Readonly<Record<string, { readonly selected: readonly string[]; readonly sha256: string }>>;
  readonly prompts: Readonly<Record<string, string>>;
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

describe('weightBands on curate', () => {
  it('builds the weight instruction and the condense steps from the two numbers', async () => {
    const { prompts } = await curatePrompts({ contextLimit: 40, weightBands: [0.2, 0.7] });
    const [write, condense] = prompts.map((p) => p.instructions);
    for (const text of ['weighted 0.7 or more', 'from 0.2 to 0.7', 'below 0.2']) expect(write).toContain(text);
    expect(write).not.toMatch(/0\.6|0\.1\b/);
    expect(condense).toContain('items weighted below 0.2.');
    expect(condense).toContain('items weighted from 0.2 to below 0.7.');
    expect(condense).toContain('items weighted 0.7 or more whole');
  });

  it.each(Object.keys(CURATE_WAYS))('with the option absent the prompts equal the baseline: %s', async (name) => {
    const { prompts } = await curatePrompts(CURATE_WAYS[name]!);
    expect(sha256(prompts)).toBe(baseline.prompts[name]);
  });

  it('records the bands and says what they did when they differ', async () => {
    const plain = await curatePrompts({});
    expect(plain.result.record.weightBands).toEqual([0.1, 0.6]);
    expect(plain.result.record.effects.find((e) => e.setting === 'weightBands')).toBeUndefined();
    const set = await curatePrompts({ weightBands: [0.2, 0.7] });
    expect(set.result.record.weightBands).toEqual([0.2, 0.7]);
    expect(set.result.record.effects.find((e) => e.setting === 'weightBands')).toEqual({ setting: 'weightBands', lines: null,
      summary: "weightBands: the curator's weight instructions used 0.2 and 0.7. One call cannot count which lines that changed." });
  });

  it.each([[[0.6, 0.1]], [[0, 0.5]], [[0.5, 1]], [[0.2, Number.NaN]]])('curate refuses %j', async (weightBands) => {
    await expect(curatePrompts({ weightBands: weightBands as unknown as readonly [number, number] }))
      .rejects.toThrow(TypeError);
  });
});

describe('the default batch size', () => {
  it('is 150,000 estimated tokens', () => {
    expect(DEFAULT_BATCH_TOKENS).toBe(150_000);
  });

  it('writes evidence over the default in layered batches', async () => {
    const { prompts, result } = await curatePrompts({}, curatePick(160, 4000));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.body).toContain('LOG SO FAR:');
    expect(result.record.batches).toHaveLength(2);
    expect(result.record.batchTokens).toBe(150_000);
    expect(result.record.batchDefault).toBe(true);
    const effect = result.record.effects.find((e) => e.setting === 'batchTokens');
    expect(effect?.lines).toBeNull();
    expect(effect?.summary).toMatch(/^batchTokens: the evidence was about [\d,]+ estimated tokens, over 150,000, so the log was written in 2 layered batches\.$/);
  });

  it('writes evidence within the default in one call, as with no batch size', async () => {
    const { prompts, result } = await curatePrompts({});
    expect(prompts).toHaveLength(1);
    expect(sha256(prompts)).toBe(baseline.prompts['no options']);
    expect(result.record).not.toHaveProperty('batchTokens');
    expect(result.record).not.toHaveProperty('batchDefault');
    const effect = result.record.effects.find((e) => e.setting === 'batchTokens');
    expect(effect?.lines).toBeNull();
    expect(effect?.summary).toMatch(/^batchTokens: the evidence was about [\d,]+ estimated tokens, within one batch of 150,000, so the log was written in one call, as with no batch size\.$/);
  });

  it('leaves contextLimit as it was: one write, then the condense call', async () => {
    const { prompts, result } = await curatePrompts(CURATE_WAYS.contextLimit!);
    expect(prompts).toHaveLength(2);
    expect(sha256(prompts)).toBe(baseline.prompts.contextLimit);
    expect(result.record.condensed).toBe(true);
    expect(result.record).not.toHaveProperty('batchDefault');
    expect(result.record.effects.find((e) => e.setting === 'batchTokens')).toBeUndefined();
  });

  it('leaves an explicit batchTokens as it was', async () => {
    const { prompts, result } = await curatePrompts(CURATE_WAYS.batchTokens!);
    expect(result.record.batches).toHaveLength(3);
    expect(sha256(prompts)).toBe(baseline.prompts.batchTokens);
    expect(result.record).not.toHaveProperty('batchDefault');
    expect(result.record.effects.find((e) => e.setting === 'batchTokens')).toBeUndefined();
  });

  it('still writes a layered log when one explicit batch holds everything', async () => {
    const writer = recordingWriter();
    const result = await curate(task, curatePick(), { write: writer.write, batchTokens: DEFAULT_BATCH_TOKENS });
    expect(writer.prompts).toHaveLength(1);
    expect(result.record.batches).toHaveLength(1);
    expect(result.record.batchTokens).toBe(DEFAULT_BATCH_TOKENS);
  });
});
