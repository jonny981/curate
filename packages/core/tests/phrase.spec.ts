import { describe, expect, it } from 'vitest';
import { phraseCount } from '../src/search.js';
import { pickFromSources, type CandidateSource, type MemoryCandidate } from '../src/index.js';

const candidate = (id: string, text: string): MemoryCandidate => ({ id, text, sourceId: 'chat', title: id, role: 'reference', signals: { keyword: 1 } });
const yes = async ({ questions }: { questions: readonly { key: string }[] }) => Object.fromEntries(
  questions.map(({ key }) => [key, { status: 'answered' as const, probability: 1 }]),
);

describe('phrase searches', () => {
  it.each([
    ['I even got my vinyl signed', 'got my', 1],
    ['BOUGHT, a record. Bought a vinyl.', 'bought a', 2],
    ['bought the record', 'bought a', 0],
    ['forgot my record', 'got my', 0],
    ['got a signed copy of my record', 'got my', 0],
    ['ordered records', 'order', 0],
    ['a a a', 'a a', 2],
    ['J’ai acheté un disque', 'acheté un', 1],
    ['anything', '!!!', 0],
  ])('matches contiguous whole words in %s', (text, phrase, count) => {
    expect(phraseCount(text, phrase)).toBe(count);
  });

  it('filters before the read limit, keeps originals, and decides each union item once', async () => {
    const calls: { task: string; limit?: number }[] = [];
    const reader: CandidateSource = { id: 'chat', role: 'reference', read: async (request) => {
      calls.push(request);
      return { status: 'read', complete: true, candidates: request.task === 'albums'
        ? [candidate('original', 'Albums are on the shelf')]
        : [candidate('distractor', 'I forgot my bag'), candidate('single', 'I even got my vinyl signed'),
          candidate('repeated', 'I got my record and got my LP')] };
    } };
    const asked: string[] = [];
    const result = await pickFromSources([reader], { task: 'albums', searchPhrases: [' got my ', 'got my', ''], limit: 1 }, {
      task: 'albums', limits: { maxCandidates: 1 }, decide: async (batch) => {
        asked.push(...batch.questions.map((question) => question.id));
        return yes(batch);
      },
    });
    expect(calls.map(({ task, limit }) => [task, limit])).toEqual([['albums', 1], ['got my', undefined]]);
    expect(asked.sort()).toEqual(['original', 'repeated']);
    expect(result.reads[0]).toMatchObject({ complete: false, partial: 'the phrase limit kept 1 of 2 candidates' });
    expect(result.selected.find((item) => item.id === 'repeated')).toMatchObject({ signals: { phrase: 2 }, searchRanks: [null, 0] });
  });

  it('keeps keyword and phrase searches separate even for identical text', async () => {
    const reader: CandidateSource = { id: 'chat', role: 'reference', read: async () => ({
      status: 'read', complete: true, candidates: [candidate('signed', 'I got my vinyl signed'), candidate('other', 'my got')],
    }) };
    const result = await pickFromSources([reader], { task: 'got my', searchLines: ['got my'], searchPhrases: ['got my'] }, { task: 'got my', decide: yes });
    expect(result.selected.find((item) => item.id === 'signed')?.searchRanks).toEqual([1, 0]);
    expect(result.selected.find((item) => item.id === 'other')?.searchRanks).toEqual([0, null]);
  });

  it('matches titles without joining the title and body into a phrase', async () => {
    const reader: CandidateSource = { id: 'chat', role: 'reference', read: async () => ({
      status: 'read', complete: true, candidates: [
        { ...candidate('title', 'Details'), title: 'I got my vinyl signed' },
        { ...candidate('split', 'my vinyl signed'), title: 'I got' },
      ],
    }) };
    const result = await pickFromSources([reader], { task: 'albums', searchPhrases: ['got my'] }, { task: 'albums', decide: yes });
    expect(result.selected.find((item) => item.id === 'title')?.searchRanks?.[1]).toBe(0);
    expect(result.selected.find((item) => item.id === 'split')?.searchRanks?.[1]).toBe(null);
  });

  it('preserves the single-read result when phrase searches are empty', async () => {
    const read = { status: 'read' as const, complete: true, candidates: [candidate('a', 'Text')] };
    const reader: CandidateSource = { id: 'chat', role: 'reference', read: async () => read };
    const base = await pickFromSources([reader], { task: 'albums' }, { task: 'albums', decide: yes });
    const empty = await pickFromSources([reader], { task: 'albums', searchPhrases: ['', ' '] }, { task: 'albums', decide: yes });
    expect(empty).toEqual(base);
    expect(empty.reads[0]).toBe(read);
  });
});
