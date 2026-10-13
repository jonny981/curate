import { getLlama } from 'node-llama-cpp';
import type { EmbeddingFunction } from './meaning.js';

/** Load a local sentence embedding model that takes plain text, such as MiniLM. */
export async function createLocalEmbedder(options: { readonly modelPath: string }): Promise<{
  readonly embed: EmbeddingFunction;
  dispose(): Promise<void>;
}> {
  const llama = await getLlama({ build: 'never', skipDownload: true });
  try {
    const model = await llama.loadModel({ modelPath: options.modelPath });
    const context = await model.createEmbeddingContext({ contextSize: model.trainContextSize });
    // The runtime adds beginning and ending tokens to each window.
    const windowSize = model.trainContextSize - 2;
    const embed: EmbeddingFunction = async (texts, signal) => {
      const vectors: Float64Array[] = [];
      for (const text of texts) {
        signal?.throwIfAborted();
        const tokens = model.tokenize(text);
        if (!tokens.length) throw new TypeError('Embedding inputs must contain text.');
        const combined = new Float64Array(model.embeddingVectorSize);
        for (let start = 0; start < tokens.length; start += windowSize) {
          signal?.throwIfAborted();
          const window = tokens.slice(start, start + windowSize);
          const weight = window.length;
          const { vector } = await context.getEmbeddingFor(window);
          const length = Math.hypot(...vector);
          // Weight each window by the amount of text it represents.
          for (let dimension = 0; dimension < combined.length; dimension += 1) {
            combined[dimension] = combined[dimension]! + vector[dimension]! * weight / length;
          }
        }
        const length = Math.hypot(...combined);
        vectors.push(combined.map((value) => value / length));
      }
      signal?.throwIfAborted();
      return vectors;
    };
    return {
      embed,
      async dispose() {
        await context.dispose();
        await model.dispose();
        await llama.dispose();
      },
    };
  } catch (error) {
    await llama.dispose();
    throw error;
  }
}
