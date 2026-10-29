import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const { getLlama } = vi.hoisted(() => ({ getLlama: vi.fn() }));
vi.mock('node-llama-cpp', () => ({ getLlama }));
import { createLocalEmbedder } from '../src/local-embeddings.js';

const directories: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it('rejects an explicit Metal backend when the runtime silently uses CPU', async () => {
  const loadModel = vi.fn();
  const dispose = vi.fn();
  getLlama.mockResolvedValue({ gpu: false, loadModel, dispose });
  await expect(createLocalEmbedder({ modelPath: 'model.gguf', gpu: 'metal' })).rejects.toThrow('metal embedding backend is unavailable');
  expect(loadModel).not.toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledOnce();
});

it('reuses persisted text vectors and recomputes when the model file changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'curate-local-embedding-'));
  directories.push(directory);
  const modelPath = join(directory, 'model.gguf');
  await writeFile(modelPath, 'first model');
  const getEmbeddingFor = vi.fn(async () => ({ vector: [1, 1] }));
  const model = { trainContextSize: 8, embeddingVectorSize: 2, tokenize: () => [1, 2],
    createEmbeddingContext: async () => ({ getEmbeddingFor, dispose: vi.fn() }), dispose: vi.fn() };
  const loadModel = vi.fn(async () => model);
  getLlama.mockResolvedValue({ gpu: 'metal', loadModel, dispose: vi.fn() });
  const options = { modelPath, cacheDirectory: join(directory, 'cache'), gpu: 'metal' as const };
  const first = await createLocalEmbedder(options);
  await first.embed(['a sentence', 'a sentence']);
  await first.dispose();
  expect(getEmbeddingFor).toHaveBeenCalledOnce();
  const resumed = await createLocalEmbedder(options);
  await resumed.embed(['a sentence']);
  await resumed.dispose();
  expect(getEmbeddingFor).toHaveBeenCalledOnce();
  await writeFile(modelPath, 'second model');
  const replaced = await createLocalEmbedder(options);
  await replaced.embed(['a sentence']);
  await replaced.dispose();
  expect(getEmbeddingFor).toHaveBeenCalledTimes(2);
  expect(loadModel).toHaveBeenCalledWith({ modelPath, gpuLayers: 'max' });
});
