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
function score(candidates: ChatPart[], task: string, config: ChatKeywordSettings, stems: Record<string, string>, queryText: string | null = null) {
  const shortIds = new Set(config.short ? keywordsOf(task,true).filter(w => w.length <= 2) : []);
  const tok = (t: string) => t.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 || shortIds.has(w)).map(w => config.stem ? (stems[w] ?? w) : w);
  const query = [...new Set(queryText === null ? keywordsOf(task,config.short,config.stop).flatMap(tok) : tok(queryText))];
  const docs = candidates.map(c => tok(`${c.title} ${c.text}`));
  const avg = docs.reduce((n,d) => n+d.length,0)/Math.max(1,docs.length);
  const df = new Map<string, number>(); for (const d of docs) for (const w of new Set(d)) df.set(w,(df.get(w)??0)+1);
  const named = new Set(tok((task.match(/\b[A-Z][\w]*\b/g) ?? []).join(' ')));
  const k1 = config.k1 ?? 1.2, b = config.b ?? .75;
  return docs.map(d => {
    const tf = new Map<string, number>(); for (const w of d) tf.set(w,(tf.get(w)??0)+1);
    return query.reduce((sum,q) => {
      const f = tf.get(q)??0; if (!f) return sum;
      const weight = config.nouns ? named.has(q) ? 2 : VERBS.has(q) || /(?:ing|ed)$/.test(q) ? .5 : 1 : 1;
      return sum + weight*Math.log(1+(docs.length-df.get(q)!+.5)/(df.get(q)!+.5))*f*(k1+1)/(f+k1*(1-b+b*d.length/avg));
    },0);
  });
}
/** The LongMemEval chat calculation, using plain TypeScript Porter stems. */
export function rankChat(candidates: ChatPart[], task: string, settings: Partial<ChatKeywordSettings> = {}): void {
  if (!candidates.length) return;
  const config = { ...CHAT_KEYWORD_SETTINGS, ...settings };
  const words = [...new Set([task, ...candidates.map(c => `${c.title} ${c.text}`)].join(' ').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2))];
  const stems = Object.fromEntries(words.map(w => [w, porterStem(w)]));
  const raw = score(candidates, task, config, stems);
  const top = Math.max(...raw, 1e-9);
  const keywords = keywordsOf(task, config.short, config.stop);
  const hits = (text: string) => keywords.filter(k => text.toLowerCase().includes(k)).length;
  const base = raw.map((s, i) => 3 * s / top + Math.min(2, hits(candidates[i]!.heading) * 2) + Math.min(1, hits(`${candidates[i]!.name} ${candidates[i]!.front}`)));
  if (config.rrf === false) {
    candidates.forEach((candidate, index) => { candidate.score = base[index]!; });
    return;
  }
  const sorted = (scores: number[]) => candidates.map((c, i) => ({ c, s: scores[i]! })).sort((a, b) => b.s - a.s || a.c.id.localeCompare(b.c.id));
  const content = keywordsOf(task, false, 'content').filter(w => !VERBS.has(w) && !/(?:ing|ed)$/.test(w)).join(' ');
  const names = (task.match(/\b[A-Z][\w]*\b/g) ?? []).filter(w => !COMMON.has(w.toLowerCase()) && !STOP.has(w.toLowerCase())).join(' ');
  const fusion = new Map(candidates.map(c => [c.id, 0]));
  const bonus = new Map<string, number>();
  [sorted(base), ...[content, names].filter(Boolean).map(q => sorted(score(candidates, task, config, stems, q)))].forEach((list, j) => {
    list.forEach(({ c, s }, r) => {
      if (s <= 0) return;
      fusion.set(c.id, fusion.get(c.id)! + (j === 0 ? 2 : 1) / (60 + r + 1));
      bonus.set(c.id, Math.max(bonus.get(c.id) ?? 0, r === 0 ? 0.05 : r < 3 ? 0.02 : 0));
    });
  });
  for (const c of candidates) {
    // Use the frozen score directly: adding a freshness constant can change floating-point ties.
    c.score = fusion.get(c.id)! + (bonus.get(c.id) ?? 0);
  }
}
