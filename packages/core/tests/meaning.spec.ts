import { describe, expect, it } from 'vitest';
import { addMeaningRanks, pick, pickFromSources, type EmbeddingFunction, type MemoryCandidate } from '../src/index.js';

const item = (id: string, text: string, score = 0): MemoryCandidate => ({
  id, sourceId: 'notes', role: 'reference', title: id, text, signals: { keyword: score },
});
const vectors: Record<string, number[]> = {
  pets: [1, 0], finance: [0, 1], puppy: [10, 0], invoice: [0, 1], mixed: [1, 1],
};
const embed: EmbeddingFunction = async (texts) => texts.map((text) => vectors[text]!);
const decide = async ({ questions }: Parameters<Parameters<typeof pick>[1]['decide']>[0]) =>
  Object.fromEntries(questions.map((question) => [question.key, { status: 'answered' as const, probability: 1 }]));

describe('local meaning search', () => {
  it('adds semantic matches once while preserving the entire keyword feed', async () => {
    const candidates = [item('bill', 'invoice', 9), item('dog', 'puppy'), item('both', 'mixed')];
    const baseline = await pick(candidates, { task: 'pets', decide, limits: { maxCandidates: 1 } });
    const ranked = await addMeaningRanks([...candidates, candidates[1]!], 'pets', { embed });
    const result = await pick(ranked, { task: 'pets', decide, limits: { maxCandidates: 1 } });
    expect(result.selected.map((candidate) => candidate.id).sort()).toEqual(['bill', 'dog']);
    expect(baseline.selected.every((candidate) => result.selected.some((value) => value.id === candidate.id))).toBe(true);
    expect(result.record.candidates.filter((entry) => entry.status === 'selected' && entry.asked)).toHaveLength(2);
    expect(ranked.find((candidate) => candidate.id === 'dog')!.signals).toEqual(candidates[1]!.signals);
    expect(candidates.every((candidate) => candidate.searchRanks === undefined)).toBe(true);
  });

  it('embeds each distinct task and line and preserves existing keyword lanes', async () => {
    const calls: string[][] = [];
    const ranked = await addMeaningRanks([
      { ...item('bill', 'invoice'), searchRanks: [0, 2] },
      { ...item('dog', 'puppy'), searchRanks: [1, 0] },
    ], 'pets', {
      embed: async (texts) => { calls.push([...texts]); return embed(texts); },
      searchLines: ['finance', ' finance ', 'pets', ''],
    });
    expect(calls[0]).toEqual(['pets', 'finance']);
    expect(ranked.map((candidate) => candidate.searchRanks)).toEqual([[0, 2, 1, 0], [1, 0, 0, 1]]);
  });

  it('uses cosine similarity, not vector length, and ranks each source separately', async () => {
    const ranked = await addMeaningRanks([
      item('both', 'mixed'), item('dog', 'puppy'), { ...item('other', 'mixed'), sourceId: 'other' },
    ], 'finance', { embed, nearest: 1 });
    expect(ranked.map((candidate) => candidate.searchRanks!.at(-1))).toEqual([0, null, 0]);
  });

  it.each(['', '   ', '\u200b'])('uses the title when the body %j has no visible text', async (body) => {
    const ranked = await addMeaningRanks([
      { ...item('commit', body), title: 'invoice' }, item('dog', 'puppy', 9),
    ], 'finance', { embed, nearest: 1 });
    expect(ranked[0]).toMatchObject({ text: body, title: 'invoice', searchRanks: [1, 0] });
    expect(ranked[1]!.searchRanks).toEqual([0, null]);
  });

  it('enumerates beyond a keyword read limit without displacing its original hit', async () => {
    const candidates = [item('bill', 'invoice', 9), item('dog', 'puppy'), item('both', 'mixed')];
    const limits: (number | undefined)[] = [];
    const result = await pickFromSources([{
      id: 'notes', role: 'reference',
      read: async (request) => {
        limits.push(request.limit);
        return { status: 'read', complete: request.limit === undefined, candidates: candidates.slice(0, request.limit) };
      },
    }], { task: 'pets', limit: 1, meaning: { embed, nearest: 1 } }, { task: 'pets', decide });
    expect(limits).toEqual([1, undefined]);
    expect(result.selected.map((candidate) => candidate.id).sort()).toEqual(['bill', 'dog']);
    expect(result.reads[0]).toMatchObject({ complete: false });
  });

  it('combines keyword, phrase and meaning matches without dropping a lane', async () => {
    const candidates = [
      item('bill', 'invoice', 9),
      item('dog', 'puppy'),
      item('phrase', 'got my record'),
    ];
    const queries: string[][] = [];
    const reads: { task: string; limit?: number }[] = [];
    const asked: string[] = [];
    const result = await pickFromSources([{
      id: 'notes', role: 'reference',
      read: async (request) => {
        reads.push({ task: request.task, ...(request.limit === undefined ? {} : { limit: request.limit }) });
        return { status: 'read', complete: request.limit === undefined, candidates: candidates.slice(0, request.limit) };
      },
    }], { task: 'pets', searchPhrases: ['got my'], limit: 1, meaning: {
      nearest: 1,
      embed: async (texts) => {
        queries.push([...texts]);
        return texts.map((text) => text === 'pets' || text === 'puppy' ? [1, 0] : [0, 1]);
      },
    } }, { task: 'pets', limits: { maxCandidates: 1 }, decide: async (batch) => {
      asked.push(...batch.questions.map((question) => question.id));
      return decide(batch);
    } });
    expect(reads).toEqual([{ task: 'pets', limit: 1 }, { task: 'got my' }, { task: 'pets' }]);
    expect(queries[0]).toEqual(['pets', 'got my']);
    expect(result.selected.map((candidate) => candidate.id).sort()).toEqual(['bill', 'dog', 'phrase']);
    expect(asked.sort()).toEqual(['bill', 'dog', 'phrase']);
    expect(result.selected.find((candidate) => candidate.id === 'phrase')!.searchRanks![1]).toBe(0);
    expect(result.selected.find((candidate) => candidate.id === 'dog')!.searchRanks![2]).toBe(0);
  });

  it('preserves full decision text and zero-score selection with meaning search', async () => {
    const text = 'Complete evidence. '.repeat(100) + 'Final instruction.';
    let observed = '';
    const result = await pickFromSources([{
      id: 'notes', role: 'reference',
      read: async () => ({ status: 'read', complete: true, candidates: [item('long', text)] }),
    }], { task: 'pets', meaning: { embed: async (texts) => texts.map(() => [1, 0]) } }, {
      task: 'pets', decide: async ({ questions }) => {
        observed = questions[0]!.text;
        return Object.fromEntries(questions.map(({ key }) => [key, { status: 'answered' as const, probability: 0 }]));
      },
    });
    expect(observed).toBe(text);
    expect(result.selected.map((candidate) => candidate.id)).toEqual(['long']);
    expect(result.record.thresholds.reference).toBe(0);
  });

  it('never calls embeddings when the option is omitted', async () => {
    const result = await pickFromSources([{
      id: 'notes', role: 'reference',
      read: async () => ({ status: 'read', complete: true, candidates: [item('bill', 'invoice', 9)] }),
    }], { task: 'pets' }, { task: 'pets', decide });
    expect(result.selected[0]).not.toHaveProperty('searchRanks');
  });

  it('checks cancellation and propagates local model failure before decisions', async () => {
    const signal = AbortSignal.abort();
    await expect(addMeaningRanks([item('dog', 'puppy')], 'pets', { embed, signal })).rejects.toMatchObject({ name: 'AbortError' });
    const failure = new Error('local model unavailable');
    await expect(addMeaningRanks([item('dog', 'puppy')], 'pets', { embed: async () => { throw failure; } })).rejects.toBe(failure);
  });

  it.each([[], [0, 0], [NaN, 1], [1]].map((vector) => ({ vector })))('rejects malformed candidate vector $vector', async ({ vector }) => {
    await expect(addMeaningRanks([item('dog', 'puppy')], 'pets', {
      embed: async (texts) => texts.map((text) => text === 'pets' ? [1, 0] : vector),
    })).rejects.toThrow('Embeddings');
  });
});
