import { bagCount, wordBag } from '@curatejs/core/internal';
import { porterStem } from './porter.js';

export interface ChatKeywordSettings {
  readonly k1: number;
  readonly b: number;
  readonly stem: boolean;
  readonly short: boolean;
  readonly stop: 'baseline' | 'none' | 'content';
  readonly nouns: boolean;
  /** Merge full-query, content and name ranks. Defaults to true. */
  readonly rrf?: boolean;
}
export const CHAT_KEYWORD_SETTINGS: ChatKeywordSettings = { k1: 0.6, b: 0, stem: true, short: true, stop: 'none', nouns: true, rrf: true };
export interface ChatPart { id: string; title: string; text: string; heading: string; name: string; front: string; score: number }
const STOP = new Set('about after agent answers before change context every into only question should that their there these this what when where which with would'.split(' '));
const COMMON = new Set('a an and are as at be been being but by can could did do does for from had has have how i if in is it its me my of on or our so than the them then they to was we were who why will you your asked am also get got tell please many much'.split(' '));
const VERBS = new Set('ask asked buy bought count describe determine find give go going know like list make mention need prefer recommend say said suggest take tell think use want went work'.split(' '));
function keywordsOf(task: string, short = false, stop = 'baseline') {
  const ids = short ? task.split(/(?<=[.?!:])\s+/).flatMap(s => s.split(/[^A-Za-z0-9]+/).filter(Boolean).filter((w,i) => /\d/.test(w) || (i > 0 && /[A-Z]/.test(w)))).map(w => w.toLowerCase()) : [];
  const words = stop === 'baseline' ? task.toLowerCase().split(/[^a-z0-9-]+/).filter(w => w.length > 4 && !STOP.has(w)) : task.toLowerCase().split(/[^a-z0-9-]+/).filter(w => w.length > 4 && (stop === 'none' || (!COMMON.has(w) && !STOP.has(w))));
  return [...new Set([...ids, ...(task.match(/[@\w./-]*[./@][\w./-]+|[a-z]+[A-Z]\w+|`[^`]+`/g) ?? []).map(w => w.replace(/`/g,'')), ...words].map(w => w.toLowerCase()))];
}

/** A streamed LongMemEval chat rank. Feed every part once through
 *  `observe`, which builds the corpus statistics (document frequencies,
 *  lengths, stems) without holding any part; then feed every part
 *  through `score`, which reads those statistics back into the three
 *  BM25 queries. `finish` applies the heading/name/front extras and
 *  the rank merge, so a reader can keep a part's two scores without
 *  ever holding every part's text at once. Parts must be observed and
 *  scored in the same order, and all observes must run before any
 *  score, because every score needs the final statistics. */
export interface ChatRankSession {
  /** First pass: fold one part's `${title} ${text}` into the corpus
   *  statistics. */
  observe(text: string): void;
  /** Second pass: the part's three query scores plus its
   *  heading/name/front extras, stored internally by part order. */
  score(text: string, fields: { heading: string; name: string; front: string }): void;
  /** `observe` for a part read from the stored index: its title, and its
   *  text's words as `storedWords` keeps them. They count exactly as the
   *  text's own words would. */
  observeStored(title: string, words: StoredChatWords): void;
  /** `score` for a stored part, as `observeStored` is for `observe`. */
  scoreStored(title: string, words: StoredChatWords, fields: { heading: string; name: string; front: string }): void;
  /** The terms a postings index resolves for this session: `stems`
   *  look up a part's stored stemmed words, `shorts` its stored short
   *  words. Only the parts a term's list names can score above zero,
   *  so a postings read scores just those parts. */
  postingTerms(): { stems: readonly string[]; shorts: readonly string[] };
  /** The part at `index` in a postings read, counted once for the
   *  corpus statistics: its title's tokens (folded into the counts and
   *  document frequencies exactly as `storedBag` folds them) and its
   *  stored word total. */
  observeIndexed(index: number, title: string, long: number): void;
  /** `observeIndexed` for every part of a postings read at once, from its
   *  titles' words indexed once for the whole call: the parts count, each
   *  title's words count into the totals, and each query term's title
   *  words count for the parts that hold them, exactly as `observeIndexed`
   *  counts them part by part. */
  observeTitles(titles: ChatTitleIndex): void;
  /** One posting row of the read's population: the part at `index`
   *  holds `term` `count` times. A `short` row's word stems the way
   *  `storedBag` stems it before it counts. */
  posting(index: number, term: string, count: number, short: boolean): void;
  /** `score` for every part a posting or a title term named, in the
   *  parts' own indices; every part they never named counts as a
   *  scored zero at `finish`, and the score arrays span the whole
   *  `ids`. */
  scoreIndexed(fields: { heading: string; name: string; front: string }): void;
  /** Merge the scored parts. `ids` ties equal scores to a stable order;
   *  returns the merged ordering score (`scores`) and the pre-merge
   *  lane score (`base`) in part order. `places` is each id's place in
   *  that order, equal ids sharing one, for a caller that orders the
   *  ids once for every lane; the merge is the same. */
  finish(ids: readonly string[], places?: ArrayLike<number>): { scores: readonly number[]; base: readonly number[] };
}

/** A text's words as the stored index keeps them, worked out once when
 *  the part is stored. A word of three characters or more counts for
 *  every task: `long` is how many there are and `stems` their counts,
 *  stemmed when the settings stem. A shorter word counts only when the
 *  task names it as an identifier, so `short` keeps those as written. */
export interface StoredChatWords {
  readonly long: number;
  readonly stems: string;
  readonly short: string;
}

/** Each part's title words, indexed once for a whole call so that a
 *  postings read finds the titles holding a query term without visiting
 *  every title. A word of three characters or more is kept under its
 *  stem, when the settings stem, and a shorter one as written. Each entry
 *  of a list is one occurrence. */
export interface ChatTitleIndex {
  readonly parts: number;
  /** Every part's title words of three characters or more and its long
   *  text words, summed over the parts. */
  readonly length: number;
  /** Each part's title words of three characters or more and long text
   *  words. */
  readonly lengths: Uint32Array;
  readonly stems: ReadonlyMap<string, readonly number[]>;
  readonly shorts: ReadonlyMap<string, readonly number[]>;
}

/** The title index of parts whose titles are `titles` and whose stored
 *  long-word totals are `longs`, under these keyword settings. */
export function chatTitleIndex(
  titles: readonly string[], longs: ArrayLike<number>, settings: Partial<ChatKeywordSettings> = {},
): ChatTitleIndex {
  const stem = ({ ...CHAT_KEYWORD_SETTINGS, ...settings }).stem;
  const stemmed = new Map<string, string>();
  const stems = new Map<string, number[]>();
  const shorts = new Map<string, number[]>();
  const lengths = new Uint32Array(titles.length);
  let length = 0;
  const add = (map: Map<string, number[]>, key: string, index: number) => {
    const list = map.get(key);
    if (list === undefined) map.set(key, [index]);
    else list.push(index);
  };
  titles.forEach((title, index) => {
    let kept = 0;
    for (const word of title.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length > 2) {
        kept += 1;
        let value = stemmed.get(word);
        if (value === undefined) stemmed.set(word, value = stem ? porterStem(word) : word);
        add(stems, value, index);
      } else if (word !== '') {
        add(shorts, word, index);
      }
    }
    lengths[index] = kept + longs[index]!;
    length += kept + longs[index]!;
  });
  return { parts: titles.length, length, lengths, stems, shorts };
}

/** The stored form of a part's text under these keyword settings. */
export function storedChatWords(text: string, settings: Partial<ChatKeywordSettings> = {}): StoredChatWords {
  const stem = ({ ...CHAT_KEYWORD_SETTINGS, ...settings }).stem;
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word !== '');
  const long = words.filter((word) => word.length > 2);
  return {
    long: long.length,
    stems: wordBag(stem ? long.map(porterStem) : long),
    short: wordBag(words.filter((word) => word.length <= 2)),
  };
}

export function startChatRank(task: string, settings: Partial<ChatKeywordSettings> = {}): ChatRankSession {
  const config = { ...CHAT_KEYWORD_SETTINGS, ...settings };
  const keywords = keywordsOf(task, config.short, config.stop);
  const hits = (text: string) => keywords.filter((k) => text.toLowerCase().includes(k)).length;
  // A word's stem is deterministic, so the map is a cache, not state the
  // whole corpus must fill before scoring: a word stems the same whether
  // it was seen in an earlier document or not. It is capped so a large
  // corpus vocabulary cannot grow the session without bound: the words
  // seen first — the corpus's most common — stay cached, and words past
  // the cap stem on every occurrence instead.
  const stems = new Map<string, string>();
  const stemOf = (word: string) => {
    if (!config.stem) return word;
    const stem = stems.get(word);
    if (stem !== undefined) return stem;
    const value = porterStem(word);
    if (stems.size < 65_536) stems.set(word, value);
    return value;
  };
  const shortIds = new Set(config.short ? keywordsOf(task, true).filter((w) => w.length <= 2) : []);
  const tok = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 || shortIds.has(w)).map(stemOf);
  const named = new Set(tok((task.match(/\b[A-Z][\w]*\b/g) ?? []).join(' ')));
  const content = keywordsOf(task, false, 'content').filter((w) => !VERBS.has(w) && !/(?:ing|ed)$/.test(w)).join(' ');
  const names = (task.match(/\b[A-Z][\w]*\b/g) ?? []).filter((w) => !COMMON.has(w.toLowerCase()) && !STOP.has(w.toLowerCase())).join(' ');
  const queries = {
    main: [...new Set(keywordsOf(task, config.short, config.stop).flatMap(tok))],
    content: content ? [...new Set(tok(content))] : null,
    names: names ? [...new Set(tok(names))] : null,
  };
  const queryTerms = new Set([queries.main, queries.content ?? [], queries.names ?? []].flat());
  const df = new Map<string, number>();
  let docs = 0;
  let length = 0;
  const parts: { raw: number; content: number; names: number; extra: number }[] = [];
  const k1 = config.k1 ?? 1.2, b = config.b ?? .75;
  // A part as BM25 reads it: each token's count and the token total.
  type Bag = { readonly tf: Map<string, number>; length: number };
  const textBag = (text: string): Bag => {
    const tokens = tok(text);
    const tf = new Map<string, number>();
    for (const word of tokens) tf.set(word, (tf.get(word) ?? 0) + 1);
    return { tf, length: tokens.length };
  };
  // A stored part's tokens are its long words, stemmed when stored, and
  // the short words the task names, stemmed here. Only the query's terms
  // are looked up: no other token's count enters a score.
  const shortStems = [...shortIds].map((word) => [word, stemOf(word)] as const);
  const storedBag = (title: string, words: StoredChatWords): Bag => {
    const bag = textBag(title);
    bag.length += words.long;
    for (const term of queryTerms) {
      const count = bagCount(words.stems, term);
      if (count > 0) bag.tf.set(term, (bag.tf.get(term) ?? 0) + count);
    }
    for (const [word, stem] of shortStems) {
      const count = bagCount(words.short, word);
      if (count === 0) continue;
      bag.length += count;
      bag.tf.set(stem, (bag.tf.get(stem) ?? 0) + count);
    }
    return bag;
  };
  const bm25 = (bag: Bag, query: readonly string[]) => {
    const { tf } = bag;
    const avg = length / Math.max(1, docs);
    return query.reduce((sum, q) => {
      const f = tf.get(q) ?? 0;
      if (!f) return sum;
      const weight = config.nouns ? named.has(q) ? 2 : VERBS.has(q) || /(?:ing|ed)$/.test(q) ? .5 : 1 : 1;
      return sum + weight * Math.log(1 + (docs - df.get(q)! + .5) / (df.get(q)! + .5)) * f * (k1 + 1) / (f + k1 * (1 - b + b * bag.length / avg));
    }, 0);
  };
  const observeBag = (bag: Bag) => {
    docs += 1;
    length += bag.length;
    for (const word of bag.tf.keys()) if (queryTerms.has(word)) df.set(word, (df.get(word) ?? 0) + 1);
  };
  const scoreBag = (fields: { heading: string; name: string; front: string }, bag: Bag) => ({
    raw: bm25(bag, queries.main),
    content: queries.content === null ? 0 : bm25(bag, queries.content),
    names: queries.names === null ? 0 : bm25(bag, queries.names),
    extra: Math.min(2, hits(fields.heading) * 2) + Math.min(1, hits(`${fields.name} ${fields.front}`)),
  });
  // A postings read scores parts out of order; the scores still sit at
  // the part's own index, and `finish` spans every id so an unscored
  // part ranks zero exactly as a scored zero-ranking part does.
  let sparse = false;
  const EMPTY = { raw: 0, content: 0, names: 0, extra: 0 };
  const scored = (index: number) => parts[index] ?? EMPTY;
  // The postings path assembles the same bag `storedBag` would: a term
  // frequency map per part the postings or a title named, the part's
  // length before short words, its matched short-word count, and a set
  // of the parts holding each term for the document frequencies.
  const statLen = new Map<number, number>();
  const shortLen = new Map<number, number>();
  // With a title index, a part's length before short words is its title
  // index length plus the short title words the task names.
  let titleIndex: ChatTitleIndex | undefined;
  const titleShort = new Map<number, number>();
  // The parts `scoreIndexed` scored: in a postings read, the only parts
  // `finish` has to order.
  let scoredIndexes: number[] | undefined;
  const termFreq = new Map<number, Map<string, number>>();
  const holders = new Map<string, Set<number>>();
  const addTerm = (index: number, term: string, count: number) => {
    let tf = termFreq.get(index);
    if (tf === undefined) termFreq.set(index, tf = new Map());
    tf.set(term, (tf.get(term) ?? 0) + count);
    let held = holders.get(term);
    if (held === undefined) holders.set(term, held = new Set());
    held.add(index);
  };
  return {
    observe(text) {
      observeBag(textBag(text));
    },
    score(text, fields) {
      parts.push(scoreBag(fields, textBag(text)));
    },
    observeStored(title, words) {
      observeBag(storedBag(title, words));
    },
    scoreStored(title, words, fields) {
      parts.push(scoreBag(fields, storedBag(title, words)));
    },
    postingTerms() {
      sparse = true;
      return { stems: [...queryTerms], shorts: [...shortIds] };
    },
    observeIndexed(index, title, long) {
      sparse = true;
      docs += 1;
      const bag = textBag(title);
      statLen.set(index, bag.length + long);
      length += bag.length + long;
      for (const [word, count] of bag.tf) if (queryTerms.has(word)) addTerm(index, word, count);
    },
    observeTitles(titles) {
      sparse = true;
      titleIndex = titles;
      docs += titles.parts;
      length += titles.length;
      for (const term of queryTerms) for (const index of titles.stems.get(term) ?? []) addTerm(index, term, 1);
      for (const word of shortIds) {
        const stem = stemOf(word);
        for (const index of titles.shorts.get(word) ?? []) {
          titleShort.set(index, (titleShort.get(index) ?? 0) + 1);
          length += 1;
          if (queryTerms.has(stem)) addTerm(index, stem, 1);
        }
      }
    },
    posting(index, term, count, short) {
      sparse = true;
      if (!short) {
        addTerm(index, term, count);
        return;
      }
      shortLen.set(index, (shortLen.get(index) ?? 0) + count);
      length += count;
      const stem = stemOf(term);
      if (queryTerms.has(stem)) addTerm(index, stem, count);
    },
    scoreIndexed(fields) {
      for (const [term, held] of holders) df.set(term, held.size);
      const statOf = (index: number) => statLen.get(index)
        ?? (titleIndex === undefined ? 0 : titleIndex.lengths[index]! + (titleShort.get(index) ?? 0));
      for (const [index, tf] of termFreq) {
        parts[index] = scoreBag(fields, { tf, length: statOf(index) + (shortLen.get(index) ?? 0) });
      }
      scoredIndexes = [...termFreq.keys()];
    },
    finish(ids, places) {
      const count = sparse ? ids.length : parts.length;
      if (!count) return { scores: [], base: [] };
      // A postings read scored only the parts its postings named. Every
      // other part scores zero in every list, so it gets no fused score
      // and sorts after every scored part: ordering the scored parts alone
      // gives them the ranks a sort of every part would.
      if (scoredIndexes !== undefined) {
        const scoredList = scoredIndexes;
        let top = 1e-9;
        for (const index of scoredList) top = Math.max(top, scored(index).raw);
        const base = new Array<number>(count).fill(0);
        for (const index of scoredList) base[index] = 3 * scored(index).raw / top + scored(index).extra;
        if (config.rrf === false) return { scores: base, base };
        const ranked = (value: (index: number) => number) => [...scoredList].sort((a, b) => value(b) - value(a)
          || (places === undefined ? ids[a]!.localeCompare(ids[b]!) : places[a]! - places[b]!) || a - b);
        const lists: [(index: number) => number, number][] = [[(index) => base[index]!, 2]];
        if (queries.content !== null) lists.push([(index) => scored(index).content, 1]);
        if (queries.names !== null) lists.push([(index) => scored(index).names, 1]);
        const scores = new Array<number>(count).fill(0);
        const bonus = new Map<number, number>();
        for (const [value, weight] of lists) {
          ranked(value).forEach((index, rank) => {
            if (value(index) <= 0) return;
            scores[index] = scores[index]! + weight / (60 + rank + 1);
            bonus.set(index, Math.max(bonus.get(index) ?? 0, rank === 0 ? 0.05 : rank < 3 ? 0.02 : 0));
          });
        }
        for (const [index, extra] of bonus) scores[index] = scores[index]! + extra;
        return { scores, base };
      }
      let top = 1e-9;
      for (let index = 0; index < count; index += 1) top = Math.max(top, scored(index).raw);
      const base = Array.from({ length: count }, (_, index) => 3 * scored(index).raw / top + scored(index).extra);
      if (config.rrf === false) return { scores: base, base };
      // With `places`, ties break on each id's place in the id order:
      // the same order as comparing the ids, without comparing them.
      const order = (values: readonly number[]): ArrayLike<number> & { forEach(visit: (index: number, rank: number) => void): void } =>
        places === undefined ? values
          .map((value, index) => ({ value, index }))
          .sort((a, b) => b.value - a.value || ids[a.index]!.localeCompare(ids[b.index]!))
          .map((entry) => entry.index)
          : Uint32Array.from({ length: count }, (_, index) => index)
            .sort((a, b) => values[b]! - values[a]! || places[a]! - places[b]!);
      const lists = [order(base)];
      const contentScores = queries.content === null ? null : order(Array.from({ length: count }, (_, index) => scored(index).content));
      const namesScores = queries.names === null ? null : order(Array.from({ length: count }, (_, index) => scored(index).names));
      if (contentScores !== null) lists.push(contentScores);
      if (namesScores !== null) lists.push(namesScores);
      const value = (list: number, index: number) => list === 0 ? base[index]!
        : list === 1 && contentScores !== null ? scored(index).content
        : scored(index).names;
      const fusion = new Array<number>(count).fill(0);
      const bonus = new Array<number>(count).fill(0);
      lists.forEach((list, j) => list.forEach((index, rank) => {
        if (value(j, index) <= 0) return;
        fusion[index] = fusion[index]! + (j === 0 ? 2 : 1) / (60 + rank + 1);
        bonus[index] = Math.max(bonus[index]!, rank === 0 ? 0.05 : rank < 3 ? 0.02 : 0);
      }));
      return { scores: fusion.map((score, index) => score + bonus[index]!), base };
    },
  };
}

/** The LongMemEval chat calculation, using plain TypeScript Porter
 *  stems. Sets each part's `score` and returns the pre-merge keyword
 *  score per part: the lane's own match score, for the curve cut to
 *  measure where the merged ranking score cannot. Runs the same
 *  streamed calculation as a two-pass read. */
export function rankChat(candidates: ChatPart[], task: string, settings: Partial<ChatKeywordSettings> = {}): readonly number[] {
  if (!candidates.length) return [];
  const rank = startChatRank(task, settings);
  for (const part of candidates) rank.observe(`${part.title} ${part.text}`);
  for (const part of candidates) rank.score(`${part.title} ${part.text}`, { heading: part.heading, name: part.name, front: part.front });
  const { scores, base } = rank.finish(candidates.map((part) => part.id));
  candidates.forEach((candidate, index) => { candidate.score = scores[index]!; });
  return base;
}
