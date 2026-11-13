import { describe, expect, it } from 'vitest';
import { PHRASE_INDEX, phraseCount, phraseQuery, phraseWords } from '../src/search.js';
import { pickFromSources, type CandidateSource, type MemoryCandidate } from '../src/index.js';

const uncutPick = { everyRanked: true, everyScored: true, rare: false } as const;

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
    const result = await pickFromSources([reader], { task: 'albums', searchPhrases: [' got my ', 'got my', ''], limit: 1 }, { ...uncutPick,
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
    const result = await pickFromSources([reader], { task: 'got my', searchLines: ['got my'], searchPhrases: ['got my'] }, { ...uncutPick, task: 'got my', decide: yes });
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
    const result = await pickFromSources([reader], { task: 'albums', searchPhrases: ['got my'] }, { ...uncutPick, task: 'albums', decide: yes });
    expect(result.selected.find((item) => item.id === 'title')?.searchRanks?.[1]).toBe(0);
    expect(result.selected.find((item) => item.id === 'split')?.searchRanks?.[1]).toBe(null);
  });

  it('preserves the single-read result when phrase searches are empty', async () => {
    const read = { status: 'read' as const, complete: true, candidates: [candidate('a', 'Text')] };
    const reader: CandidateSource = { id: 'chat', role: 'reference', read: async () => read };
    const base = await pickFromSources([reader], { task: 'albums' }, { ...uncutPick, task: 'albums', decide: yes });
    const empty = await pickFromSources([reader], { task: 'albums', searchPhrases: ['', ' '] }, { ...uncutPick, task: 'albums', decide: yes });
    expect({ ...empty, record: { ...empty.record, asOf: base.record.asOf } }).toEqual(base);
    expect(empty.reads[0]).toEqual({ ...read,
      lanes: [{ task: 'albums', lane: 'search', read: 1, kept: 1 }] });
  });
});

describe('the stored phrase index', () => {
  // An index phrase match must hold exactly where `phraseCount` counts
  // one, whatever the script: the index keeps `phraseWords` of each text
  // and reads it with FTS5's `ascii` tokenizer.
  const pieces = [
    'orchard', 'pump', 'Pump', 'ORCHARD', 'a', 'an', 'AND', 'OR', 'NOT', 'NEAR', 'the', 'café', 'CAFÉ', 'café',
    'straße', 'STRASSE', 'İstanbul', 'istanbul', 'ıiİI', 'K', 'k', 'ΣΟΦΟΣ', 'σοφος', 'σοφοσ', 'Москва', 'москва',
    '漢字', '汉字', 'かな', 'カナ', 'مرحبا', 'नमस्ते', 'क्ष', 'שלום', '😀', '👩‍💻', '‍', '​', 'x', 'xy',
    '𝒜𝒷', '𐐀𐐨', '٣٤', '²', '½', 'Ⅻ', 'ⅻ', 'Ａｂ', 'ﬁle', 'ǅ', 'ǆ', 'ß', 'ẞ', 'ŉ', 'İi̇', 'é', 'ño',
    'v2', 'id_9', "don't", 'x-ray', 'a.b', '"quoted"', '*', 'col:on', '(paren)', '{brace}', '-', '^', '\t', '\n', ' ', ' ', '　',
    'a'.repeat(3000), `${'é'.repeat(500)}z`,
  ];
  let seed = 3;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
  const glue = () => pick([' ', ' ', ' ', '', '\n', ', ', '-', ' ', '_']);
  const texts = Array.from({ length: 400 }, () => Array.from({ length: 1 + Math.floor(random() * 25) }, () => pick(pieces) + glue()).join(''));
  const recase = (text: string) => text.split('').map((char) => random() < 0.3 ? char.toUpperCase() : char).join('');
  it('matches the texts phraseCount matches, for every phrase, across scripts, marks and symbols', () => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const database = new DatabaseSync(':memory:');
    database.exec(`CREATE VIRTUAL TABLE phrases USING fts5(words, ${PHRASE_INDEX})`);
    const put = database.prepare('INSERT INTO phrases (rowid, words) VALUES (?, ?)');
    texts.forEach((text, at) => put.run(at, phraseWords(text)));
    const search = database.prepare('SELECT rowid AS id FROM phrases WHERE phrases MATCH ? ORDER BY rowid');
    // Phrases from the texts' own words, re-cased, and from the pieces.
    const phrases = [
      ...Array.from({ length: 300 }, () => {
        const words = pick(texts).match(/[\p{L}\p{N}]+/gu) ?? [];
        const start = Math.floor(random() * words.length);
        return recase(words.slice(start, start + 1 + Math.floor(random() * 3)).join(pick([' ', '-', ', '])));
      }),
      ...pieces, ...pieces.map((piece) => `${piece} ${pick(pieces)}`),
    ];
    let compared = 0;
    for (const phrase of phrases) {
      const counted = texts.flatMap((text, at) => phraseCount(text, phrase) > 0 ? [at] : []);
      const query = phraseQuery(phrase);
      const found = query === undefined ? [] : (search.all(query) as { id: number }[]).map((row) => row.id);
      expect(found, JSON.stringify(phrase)).toEqual(counted);
      compared += counted.length;
    }
    // The comparison is not empty: phrases match many texts.
    expect(compared).toBeGreaterThan(1000);
    // A phrase with no word matches nowhere, as phraseCount counts nothing.
    expect(phraseQuery('!!! 😀 ‍')).toBeUndefined();
    database.close();
  });
});
