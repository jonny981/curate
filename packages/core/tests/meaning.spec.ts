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
    // The lane cut drops zero-similarity ranks; wholeLanes: true keeps them.
    expect(ranked.map((candidate) => candidate.searchRanks)).toEqual([[0, 2, null, 0], [1, 0, 0, null]]);
    const uncut = await addMeaningRanks([
      { ...item('bill', 'invoice'), searchRanks: [0, 2] },
      { ...item('dog', 'puppy'), searchRanks: [1, 0] },
    ], 'pets', { embed, searchLines: ['finance'], wholeLanes: true });
    expect(uncut.map((candidate) => candidate.searchRanks)).toEqual([[0, 2, 1, 0], [1, 0, 0, 1]]);
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
    // The middle read asks the source to serve the meaning lane itself;
    // this source ignores the flag, so the fallback re-reads the pool.
    expect(limits).toEqual([1, 1, undefined]);
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
    // The third read asks the source to serve the 'pets' meaning lane
    // itself; this source ignores the flag and answers a keyword read,
    // so the fourth is the fallback's full-pool re-read.
    expect(reads).toEqual([
      { task: 'pets', limit: 1 },
      { task: 'got my' },
      { task: 'pets', limit: 1 },
      { task: 'pets' },
    ]);
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

  it('serves meaning lanes inside a streaming source with no corpus fallback', async () => {
    const seen: { task: string; meaning: boolean; limit?: number }[] = [];
    const result = await pickFromSources([{
      id: 'notes', role: 'reference',
      read: async (request) => {
        seen.push({
          task: request.task,
          meaning: request.meaningLane !== undefined,
          ...(request.limit === undefined ? {} : { limit: request.limit }),
        });
        if (request.meaningLane === undefined) {
          return {
            status: 'read' as const, complete: true,
            candidates: [item('bill', 'invoice', 9), item('dog', 'puppy')],
          };
        }
        // A streaming reader scored similarity inside the read and
        // returns only the kept candidates, flagged meaningLane.
        return {
          status: 'read' as const, complete: true,
          meaningLane: true as const, matched: 2,
          candidates: [{ ...item('dog', 'puppy'), signals: { similarity: 0.9 }, laneScore: 0.9 }],
        };
      },
    }], { task: 'pets', meaning: { embed: async (texts) => texts.map(() => [1, 0]), nearest: 1 } },
    { task: 'pets', decide });
    // The keyword read plus one meaning read per query; the source
    // streamed its lane, so there is no full-pool re-read.
    expect(seen).toEqual([{ task: 'pets', meaning: false }, { task: 'pets', meaning: true, limit: 1 }]);
    expect(result.reads[0]).toMatchObject({
      lanes: [
        { task: 'pets', lane: 'search', read: 2, kept: 1 },
        { task: 'pets', lane: 'meaning', read: 2, kept: 1 },
      ],
    });
    expect(result.selected.map((candidate) => candidate.id).sort()).toEqual(['bill', 'dog']);
    expect(result.selected.find((candidate) => candidate.id === 'bill')?.searchRanks).toEqual([0]);
    expect(result.selected.find((candidate) => candidate.id === 'dog')?.searchRanks).toEqual([null, 0]);
  });

  it('keeps nothing and records no search match when no similarity is positive', async () => {
    // This reader ignores the meaningLane flag, so the pool is scored
    // here: zero keyword scores and zero similarities admit nothing.
    const result = await pickFromSources([{
      id: 'notes', role: 'reference',
      read: async () => ({
        status: 'read' as const, complete: true,
        candidates: [item('bill', 'invoice'), item('dog', 'puppy')],
      }),
    }], { task: 'pets', meaning: { embed: async (texts) =>
        texts.map((text) => (text === 'pets' ? [1, 0] : [0, 1])) } },
      { task: 'pets', decide });
    const read = result.reads[0]!;
    if (read.status !== 'read') throw new Error('read failed');
    expect(read.candidates).toEqual([]);
    expect(read.noSearchMatch).toBe(true);
    expect(result.selected).toEqual([]);

    // With the scaled top-k dial on the read still carries the whole
    // pool to count the history's size, but pool members are no
    // lane's: the same miss must still flag, scored here or streamed.
    const counted = await pickFromSources([{
      id: 'notes', role: 'reference',
      read: async () => ({
        status: 'read' as const, complete: true,
        candidates: [item('bill', 'invoice'), item('dog', 'puppy')],
      }),
    }], { task: 'pets', meaning: { embed: async (texts) =>
        texts.map((text) => (text === 'pets' ? [1, 0] : [0, 1])) } },
      { task: 'pets', decide, everyRanked: { c: 0.68 } });
    const countedRead = counted.reads[0]!;
    if (countedRead.status !== 'read') throw new Error('read failed');
    expect(countedRead.candidates).toHaveLength(2);
    expect(countedRead.candidates.every((candidate) => candidate.poolOnly === true)).toBe(true);
    expect(countedRead.noSearchMatch).toBe(true);
    expect(counted.selected).toEqual([]);
    const streamed = await pickFromSources([{
      id: 'notes', role: 'reference',
      read: async (request) => request.meaningLane === undefined
        ? {
            status: 'read' as const, complete: true,
            candidates: [item('bill', 'invoice'), item('dog', 'puppy')],
          }
        : {
            status: 'read' as const, complete: true,
            meaningLane: true as const, matched: 0, candidates: [],
          },
    }], { task: 'pets', meaning: { embed: async (texts) =>
        texts.map((text) => (text === 'pets' ? [1, 0] : [0, 1])) } },
      { task: 'pets', decide, everyRanked: { c: 0.68 } });
    const streamedRead = streamed.reads[0]!;
    if (streamedRead.status !== 'read') throw new Error('read failed');
    expect(streamedRead.candidates).toHaveLength(2);
    expect(streamedRead.candidates.every((candidate) => candidate.poolOnly === true)).toBe(true);
    expect(streamedRead.noSearchMatch).toBe(true);
    expect(streamed.selected).toEqual([]);
  });

  it('reports no miss when a meaning match rescues a keyword miss, scored here or streamed', async () => {
    // The fallback path scores the returned pool itself: 'puppy' alone
    // has a positive similarity to 'pets'.
    const plain = await pickFromSources([{
      id: 'notes', role: 'reference',
      read: async () => ({
        status: 'read' as const, complete: true,
        candidates: [item('bill', 'invoice'), item('dog', 'puppy')],
      }),
    }], { task: 'pets', meaning: { embed } }, { task: 'pets', decide });
    const plainRead = plain.reads[0]!;
    if (plainRead.status !== 'read') throw new Error('read failed');
    expect(plainRead.candidates.map((candidate) => candidate.id)).toEqual(['dog']);
    expect(plainRead.noSearchMatch).toBeUndefined();
    // A reader serving the lane itself returns its kept set flagged
    // meaningLane; the flag is still computed on the combined read.
    const streamed = await pickFromSources([{
      id: 'notes', role: 'reference',
      read: async (request) => request.meaningLane === undefined
        ? {
            status: 'read' as const, complete: true,
            candidates: [item('bill', 'invoice'), item('dog', 'puppy')],
          }
        : {
            status: 'read' as const, complete: true, meaningLane: true as const, matched: 2,
            candidates: [{ ...item('dog', 'puppy'), signals: { similarity: 0.9 }, laneScore: 0.9 }],
          },
    }], { task: 'pets', meaning: { embed } }, { task: 'pets', decide });
    const streamedRead = streamed.reads[0]!;
    if (streamedRead.status !== 'read') throw new Error('read failed');
    expect(streamedRead.candidates.map((candidate) => candidate.id)).toEqual(['dog']);
    expect(streamedRead.noSearchMatch).toBeUndefined();
  });

  it('keeps meaning reports in query order when a lane is absent', async () => {
    const result = await pickFromSources([{
      id: 'notes', role: 'reference',
      read: async (request) => {
        if (request.meaningLane !== undefined) {
          if (request.task === 'gone') return { status: 'absent' as const, reason: 'no index' };
          return {
            status: 'read' as const, complete: true,
            meaningLane: true as const, matched: 2,
            candidates: [{ ...item('dog', 'puppy'), signals: { similarity: 0.9 }, laneScore: 0.9 }],
          };
        }
        return { status: 'read' as const, complete: true, candidates: [item('bill', 'invoice', 9)] };
      },
    }], { task: 'pets', searchLines: ['gone', 'finance'], meaning: { embed } }, { task: 'pets', decide });
    const read = result.reads[0]!;
    if (read.status !== 'read') throw new Error('read failed');
    // The absent lane still holds its position: later lanes' rank
    // offsets use the query order, not the order reads succeeded in.
    expect(read.lanes).toEqual([
      { task: 'pets', lane: 'search', read: 1, kept: 1 },
      { task: 'gone', lane: 'search', read: 1, kept: 1 },
      { task: 'finance', lane: 'search', read: 1, kept: 1 },
      { task: 'pets', lane: 'meaning', read: 2, kept: 1 },
      { task: 'gone', lane: 'meaning', read: 0, kept: 0 },
      { task: 'finance', lane: 'meaning', read: 2, kept: 1 },
    ]);
    expect(read.complete).toBe(false);
    const dog = result.selected.find((candidate) => candidate.id === 'dog')!;
    expect(dog.searchRanks).toEqual([null, null, null, 0, null, 0]);
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
