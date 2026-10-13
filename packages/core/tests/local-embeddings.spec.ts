import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { createLocalEmbedder } from '../src/local-embeddings.js';
import { addMeaningRanks, type MemoryCandidate } from '../src/index.js';

const modelPath = process.env['CURATE_TEST_EMBED_MODEL'];
const dot = (left: ArrayLike<number>, right: ArrayLike<number>) => {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += left[index]! * right[index]!;
  return sum;
};

describe.skipIf(!modelPath)('local MiniLM embeddings with a real model', () => {
  let local: Awaited<ReturnType<typeof createLocalEmbedder>>;
  beforeAll(async () => {
    const { createLocalEmbedder } = await import('../src/local-embeddings.js');
    local = await createLocalEmbedder({ modelPath: modelPath! });
  }, 60_000);
  afterAll(async () => { await local?.dispose(); });

  it('ranks a related sentence above an unrelated sentence', async () => {
    const [dog, puppy, invoice] = await local.embed([
      'A dog plays fetch outside.', 'A puppy retrieves a ball outdoors.', 'The invoice is payable Friday.',
    ]);
    expect(dog!.length).toBe(384);
    expect(dot(dog!, puppy!)).toBeGreaterThan(dot(dog!, invoice!));
    expect(dot(dog!, dog!)).toBeCloseTo(1, 8);
  });

  it('includes text beyond the model window in the resulting vector', async () => {
    const prefix = 'A dog plays fetch outside. '.repeat(300);
    const [dogs, mixed] = await local.embed([prefix, prefix + 'The invoice is payable Friday. '.repeat(300)]);
    // Discarding the later text would produce identical normalized vectors.
    expect(dot(dogs!, mixed!)).not.toBeCloseTo(1, 6);
    expect(dot(mixed!, mixed!)).toBeCloseTo(1, 8);
  });

  it('finds parts with empty or invisible bodies by the meaning of their titles', async () => {
    const candidates: MemoryCandidate[] = [
      { sourceId: 'git', id: 'dog', role: 'reference', title: 'A puppy retrieves a ball outdoors.', text: '\u200b', signals: {} },
      { sourceId: 'git', id: 'invoice', role: 'reference', title: 'The invoice is payable Friday.', text: '', signals: {} },
    ];
    const ranked = await addMeaningRanks(candidates, 'A dog plays fetch outside.', { embed: local.embed });
    expect(ranked.find((candidate) => candidate.id === 'dog')!.searchRanks![1]).toBe(0);
    expect(ranked.map((candidate) => candidate.text)).toEqual(['\u200b', '']);
  });

  it('rejects a signal aborted before embedding', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(local.embed(['A dog plays fetch.'], controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects a missing local model path', async () => {
    const { createLocalEmbedder } = await import('../src/local-embeddings.js');
    await expect(createLocalEmbedder({ modelPath: modelPath! + '.missing' })).rejects.toThrow();
    // Failure to create another adapter must leave this adapter usable.
    expect((await local.embed(['A dog plays fetch.']))[0]!.length).toBe(384);
  }, 60_000);
});
