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
  /** Merge the scored parts. `ids` ties equal scores to a stable order;
   *  returns the merged ordering score (`scores`) and the pre-merge
   *  lane score (`base`) in part order. */
  finish(ids: readonly string[]): { scores: readonly number[]; base: readonly number[] };
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
  const bm25 = (tokens: string[], query: readonly string[]) => {
    const tf = new Map<string, number>();
    for (const word of tokens) tf.set(word, (tf.get(word) ?? 0) + 1);
    const avg = length / Math.max(1, docs);
    return query.reduce((sum, q) => {
      const f = tf.get(q) ?? 0;
      if (!f) return sum;
      const weight = config.nouns ? named.has(q) ? 2 : VERBS.has(q) || /(?:ing|ed)$/.test(q) ? .5 : 1 : 1;
      return sum + weight * Math.log(1 + (docs - df.get(q)! + .5) / (df.get(q)! + .5)) * f * (k1 + 1) / (f + k1 * (1 - b + b * tokens.length / avg));
    }, 0);
  };
  return {
    observe(text) {
      const tokens = tok(text);
      docs += 1;
      length += tokens.length;
      for (const word of new Set(tokens)) if (queryTerms.has(word)) df.set(word, (df.get(word) ?? 0) + 1);
    },
    score(text, fields) {
      const tokens = tok(text);
      parts.push({
        raw: bm25(tokens, queries.main),
        content: queries.content === null ? 0 : bm25(tokens, queries.content),
        names: queries.names === null ? 0 : bm25(tokens, queries.names),
        extra: Math.min(2, hits(fields.heading) * 2) + Math.min(1, hits(`${fields.name} ${fields.front}`)),
      });
    },
    finish(ids) {
      const count = parts.length;
      if (!count) return { scores: [], base: [] };
      let top = 1e-9;
      for (const part of parts) top = Math.max(top, part.raw);
      const base = parts.map((part) => 3 * part.raw / top + part.extra);
      if (config.rrf === false) return { scores: base, base };
      const order = (values: readonly number[]) => values
        .map((value, index) => ({ value, index }))
        .sort((a, b) => b.value - a.value || ids[a.index]!.localeCompare(ids[b.index]!))
        .map((entry) => entry.index);
      const lists = [order(base)];
      const contentScores = queries.content === null ? null : order(parts.map((part) => part.content));
      const namesScores = queries.names === null ? null : order(parts.map((part) => part.names));
      if (contentScores !== null) lists.push(contentScores);
      if (namesScores !== null) lists.push(namesScores);
      const value = (list: number, index: number) => list === 0 ? base[index]!
        : list === 1 && contentScores !== null ? parts[index]!.content
        : parts[index]!.names;
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
