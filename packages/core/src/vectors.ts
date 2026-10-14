import type { EmbeddingFunction } from './meaning.js';

/** Unit-normalize one embedding; throws on a missing, mismatched,
 *  non-finite or zero vector. */
export function normalize(vector: ArrayLike<number>, dimensions?: number): Float64Array {
  if (!vector.length || (dimensions !== undefined && vector.length !== dimensions)) {
    throw new TypeError('Embeddings must have the same nonzero dimension.');
  }
  const values = Float64Array.from(vector);
  let squared = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) throw new TypeError('Embeddings must contain finite numbers.');
    squared += value * value;
  }
  if (!squared || !Number.isFinite(squared)) throw new TypeError('Embeddings must have a finite nonzero length.');
  const length = Math.sqrt(squared);
  return values.map((value) => value / length);
}

/** Cosine similarity of two already normalized vectors. */
export function similarity(left: ArrayLike<number>, right: ArrayLike<number>): number {
  let score = 0;
  for (let dimension = 0; dimension < left.length; dimension += 1) {
    score += left[dimension]! * right[dimension]!;
  }
  return score;
}

/** Embed one query text into its normalized vector. */
export async function embedQuery(
  embed: EmbeddingFunction,
  text: string,
  signal?: AbortSignal,
): Promise<Float64Array> {
  const vectors = await embed([text], signal);
  if (vectors.length !== 1) throw new TypeError('embed must return one vector per input text.');
  return normalize(vectors[0]!);
}

/** Embed one batch of texts and return each text's similarity to the
 *  query vector, aligned to the input order. The batch's vectors are
 *  discarded as soon as the scores return. */
export async function embedSimilarities(
  embed: EmbeddingFunction,
  query: ArrayLike<number>,
  texts: readonly string[],
  signal?: AbortSignal,
): Promise<Float64Array> {
  const vectors = await embed(texts, signal);
  if (vectors.length !== texts.length) throw new TypeError('embed must return one vector per input text.');
  const scores = new Float64Array(texts.length);
  vectors.forEach((vector, index) => {
    scores[index] = similarity(query, normalize(vector, query.length));
  });
  return scores;
}
