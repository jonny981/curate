import type { MemoryCandidate, PickBatch, PickDecide, PickResult } from './pick.js';
import type { LeverStates } from './levers.js';
import { checkCurateOptions } from './options.js';

/** The estimated tokens curate keeps its text within when
 *  `answerTokens` is omitted. */
export const DEFAULT_ANSWER_TOKENS = 2_000;

/** The sentence rating curate keeps a sentence at when `decide` is given
 *  and `sentenceCutoff` is omitted. */
export const DEFAULT_SENTENCE_CUTOFF = 0.1;

/** The estimate curate holds its budget with. Characters
 *  alone run far too low on dense text (figures, tables, code), so this
 *  counts what a tokenizer splits on: words, with a little more for long
 *  ones and for capitals inside a word; digits in threes; runs of one
 *  punctuation mark; line ends; and characters outside ASCII. A run of
 *  more than 20 letters is no word and counts a token per three letters.
 *  The weights were fitted to a real tokenizer's counts, with a margin
 *  on top. It is still an estimate, not a ceiling: text full of rare
 *  names (products, medicines) can cost more tokens than it counts. */
const ANSWER_ESTIMATE_MARGIN = 1.09;
function estimateAnswerTokens(text: string): number {
  let tokens = 0;
  for (const word of text.match(/\p{L}+/gu) ?? []) {
    tokens += word.length > 20 ? Math.ceil(word.length / 3) : 0.93 + 0.13 * (Math.ceil(word.length / 6) - 1);
    tokens += 0.51 * (word.slice(1).match(/\p{Lu}/gu)?.length ?? 0);
  }
  for (const digits of text.match(/\p{N}+/gu) ?? []) tokens += 1.39 * Math.ceil(digits.length / 3);
  tokens += 0.84 * (text.match(/([^\s\p{L}\p{N}])\1*/gu)?.length ?? 0);
  tokens += 0.45 * (text.match(/\n/g)?.length ?? 0);
  tokens += 0.85 * (text.match(/[^\x00-\x7f]/g)?.length ?? 0);
  return Math.ceil(ANSWER_ESTIMATE_MARGIN * tokens);
}

/** Curate calls no model unless it rates sentences. Code lays out the
 *  selected reference items, strongest first, for the answering model to
 *  read. The two items with the highest decision weight (ties broken by
 *  the fused order) sit under `### Most likely answer`, each under its own
 *  `#### <source> (said <date>)` heading. Every other item is grouped by
 *  said date and source, under `### <source> (said <date>)`, groups
 *  oldest first and items in weight order inside a group. An item with
 *  no date shows `(said unknown)` and its group comes last. A date that
 *  is only the file's last change shows `(file changed <date>)`. A
 *  heading names the item's file or session when it has one, so two
 *  files of one source stay apart. An item whose text, trimmed, is the
 *  same as an item taken before it is not taken again, and the next item
 *  gets its room. A text that only sits inside a longer item stays: it
 *  may be a quote, a rejected plan or a later restatement, and the longer
 *  item's place and date are not its own. The taken item's heading then also names where and when the
 *  copy was said, when that differs: `<heading>, also <source> (said
 *  <date>)`. */
export interface CurateOptions {
  /** Keep the whole text within this many estimated tokens. The
   *  estimate needs no tokenizer and is set a little high, but it is an
   *  approximate budget: a real tokenizer can count more on text full of
   *  rare names. Items are taken in weight order,
   *  and the first item that would take the text over this stops the
   *  taking. The strongest item is always kept whole, even over the
   *  budget. Omitted means DEFAULT_ANSWER_TOKENS (2,000). */
  readonly answerTokens?: number;
  /** Keep only the sentences that bear on the task. After the items are
   *  taken, `decide` rates every sentence of them in one request, and a
   *  sentence stays when its rating is this number or more, from 0 to 1.
   *  Kept sentences stay in their own words and order under the same
   *  headings, and `…` marks each place text was left out. An item with
   *  no sentence kept is left out. A sentence is the text up to a full
   *  stop, question mark or exclamation mark followed by a space, or to
   *  the line's end; blank lines go. A line that opens `user: ` or
   *  `assistant: ` names its speaker, and the first kept sentence of
   *  that speaker's turn carries the name. A sentence `decide` gives no
   *  rating stays. When the request fails, the whole text is returned as
   *  if no sentence were rated, and `record.sentences.failed` says why.
   *  `answerTokens` bounds the text that is rated, so the returned text
   *  is usually far smaller. A kept sentence can lose the sentence that
   *  says what it refers to. Omitted means DEFAULT_SENTENCE_CUTOFF (0.1)
   *  when `decide` is given, and no rating without it. `false` rates no
   *  sentence and calls no model. A number needs `decide`. */
  readonly sentenceCutoff?: number | false;
  /** Rates each sentence for `sentenceCutoff`. */
  readonly decide?: PickDecide;
  readonly signal?: AbortSignal;
}

export interface CurateRecord {
  /** The lever set the pick ran with, carried from its record. */
  readonly levers: LeverStates;
  /** The items in the returned text, in the order they were taken, with
   *  exact weights. When sentences were rated, each holds its text as
   *  returned. */
  readonly items: readonly {
    /** Full item id; includes the source when ids would clash. */
    readonly id: string;
    readonly candidate: MemoryCandidate;
    readonly weight: number;
  }[];
  /** The returned text's estimated tokens. */
  readonly estimatedTokens: number;
  /** The budget the items were taken within. */
  readonly answerTokens: number;
  /** How many items were left out as copies of an item taken before
   *  them: the same text. */
  readonly collapsed: number;
  /** The selected items the budget stopped before: how many, the
   *  highest weight among them, and how many have a weight of 0.5 or
   *  more. A copy counted in `collapsed` is not counted here. */
  readonly leftOut: {
    readonly count: number;
    readonly strongestWeight?: number;
    readonly atHalfOrMore: number;
  };
  /** Present when sentences were rated: what the sentence pass did. */
  readonly sentences?: {
    readonly cutoff: number;
    /** Sentences in the returned text, of how many the taken items held. */
    readonly kept: number;
    readonly of: number;
    /** Sentences `decide` gave no rating; each one stays. */
    readonly unanswered: number;
    /** Items in the returned text that lost at least one sentence. */
    readonly itemsTrimmed: number;
    /** Taken items left out because no sentence of theirs was kept. */
    readonly itemsLeftOut: number;
    /** The text's estimated tokens before any sentence was left out;
     *  `estimatedTokens` is the figure after. */
    readonly estimatedTokensBefore: number;
    /** Present when the decision request failed: its message. The text
     *  is then returned whole. */
    readonly failed?: string;
  };
}

/** What curate returns: the memory text in `log`. */
export interface CurateResult {
  readonly log: string;
  readonly record: CurateRecord;
}

type Item = CurateRecord['items'][number];

/** The calendar date a date value or label writes first, as YYYY-MM-DD:
 *  `2023/05/28 (Sun) 12:05`, `2023-05-28` and `2023-05-28T12:05:00Z`
 *  all give `2023-05-28`. '' when it writes none. */
function dayOf(value: unknown): string {
  const match = /(\d{4})[/-](\d{2})[/-](\d{2})/.exec(String(value ?? ''));
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

// A commit with no body carries its evidence in its title.
const body = (item: Item) => item.candidate.text.trim() ? item.candidate.text : item.candidate.title;

/** The memory text for the items taken, strongest first. A taken item's
 *  heading also names each other place and date its copies were said. */
function layOutItems(taken: readonly Item[], copies: ReadonlyMap<Item, readonly Item[]>): string {
  const source = (item: Item) => {
    const said = dayOf(item.candidate.date?.value);
    // A file's last-changed date is not when anything in it was said.
    const label = item.candidate.date === undefined || item.candidate.date.meaning === 'recorded' ? 'said' : 'file changed';
    // The file or session inside the source, when the source names one.
    const where = item.candidate.path ?? item.candidate.sourceId;
    return { said, label, where, heading: `${where} (${label} ${said || 'unknown'})` };
  };
  const heading = (item: Item) => {
    const own = source(item).heading;
    const elsewhere = [...new Set((copies.get(item) ?? []).map((copy) => source(copy).heading))].filter((other) => other !== own);
    if (!elsewhere.length) return own;
    return `${own}, also ${elsewhere.length === 1 ? elsewhere[0] : `${elsewhere.slice(0, -1).join(', ')} and ${elsewhere[elsewhere.length - 1]}`}`;
  };
  const top = taken.slice(0, 2).map((item) => `#### ${heading(item)}\n\n${body(item)}`);
  const groups = new Map<string, Item[]>();
  for (const item of taken.slice(2)) {
    // The heading closes the key, so an item whose copies were said elsewhere never shares a heading with one whose were not.
    const key = `${source(item).said}|${item.candidate.sourceId}|${source(item).where}|${source(item).label}|${heading(item)}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const rest = [...groups].sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([, group]) => `### ${heading(group[0]!)}\n\n${group.map(body).join('\n\n')}`);
  return [`### Most likely answer\n\n${top.join('\n\n')}\n`, ...rest].join('\n\n');
}

const SENTENCE_QUESTION = 'Does this sentence supply evidence, a constraint or a decision for this task?';
const SENTENCE_TRUE = 'It helps with this task, or is needed to understand a sentence that does.';
const SENTENCE_FALSE = 'It gives nothing that helps with this task.';

interface Sentence {
  readonly text: string;
  readonly line: number;
  /** Counts the speaker lines so far; 0 before the first. */
  readonly turn: number;
  /** The speaker's name, on the first sentence of the line that names it. */
  readonly speaker?: string;
}

/** A text as sentences, in order. Blank lines hold none. */
function sentencesOf(text: string): Sentence[] {
  const sentences: Sentence[] = [];
  let turn = 0;
  text.split('\n').forEach((line, index) => {
    const named = /^(user|assistant): /.exec(line);
    if (named) turn += 1;
    let speaker = named?.[1];
    for (const sentence of (named ? line.slice(named[0].length) : line).split(/(?<=[.!?])\s+/)) {
      if (!sentence.trim()) continue;
      sentences.push({ text: sentence, line: index, turn, ...(speaker === undefined ? {} : { speaker }) });
      speaker = undefined;
    }
  });
  return sentences;
}

/** The kept sentences as text: one line per source line, `…` where
 *  sentences were left out, and the speaker's name on the first kept
 *  sentence of each turn. */
function keptText(sentences: readonly Sentence[], keep: readonly boolean[]): string {
  const speakers = new Map(sentences.flatMap((sentence) => sentence.speaker === undefined ? [] : [[sentence.turn, sentence.speaker] as const]));
  let text = '', gap = false, lastLine = -1, lastTurn = -1;
  sentences.forEach((sentence, index) => {
    if (!keep[index]) { gap = true; return; }
    const speaker = sentence.turn === lastTurn ? undefined : speakers.get(sentence.turn);
    text += (text ? (sentence.line === lastLine ? ' ' : '\n') : '') + (gap ? '… ' : '')
      + (speaker === undefined ? '' : `${speaker}: `) + sentence.text;
    [gap, lastLine, lastTurn] = [false, sentence.line, sentence.turn];
  });
  return gap && text ? `${text} …` : text;
}

/** Lay out the selected reference items as they stand, in the person's
 *  own words, within the token budget, and, when sentences are rated,
 *  keep only the sentences that bear on the task. Selected rules remain
 *  the caller's instructions. */
export async function curate(task: string, picked: PickResult, options: CurateOptions = {}): Promise<CurateResult> {
  checkCurateOptions(options);
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const references = picked.selected.filter((candidate) => candidate.role === 'reference');
  // Each record entry by source and id; the first entry of a pair wins.
  const entries = new Map<string, PickResult['record']['candidates'][number]>();
  for (const item of picked.record.candidates) {
    const key = JSON.stringify([item.sourceId, item.id]);
    if (!entries.has(key)) entries.set(key, item);
  }
  const items = references.map((candidate) => {
    const entry = entries.get(JSON.stringify([candidate.sourceId, candidate.id]));
    if (entry?.status !== 'selected' || entry.probability === undefined
      || !Number.isFinite(entry.probability) || entry.probability < 0 || entry.probability > 1) {
      throw new TypeError('curate: each reference needs a selected record entry with a weight between 0 and 1.');
    }
    const id = references.some((other) => other !== candidate && other.id === candidate.id)
      ? JSON.stringify([candidate.sourceId, candidate.id]) : candidate.id;
    return { id, candidate, weight: entry.probability };
  });
  if (!items.length) throw new Error('curate: no selected reference items to curate.');
  const answerTokens = options.answerTokens ?? DEFAULT_ANSWER_TOKENS;
  // `items` follows `picked.selected`, so a stable sort leaves equal weights in the fused order.
  const ordered = [...items].sort((left, right) => right.weight - left.weight);
  let taken: Item[] = [];
  let copies = new Map<Item, readonly Item[]>();
  let log = '';
  let stopped = ordered.length;
  for (const [index, item] of ordered.entries()) {
    // A copy of an item already taken adds only a place and date to that item's heading.
    const shown = body(item).trim();
    const original = taken.find((kept) => body(kept).trim() === shown);
    const nextTaken = original === undefined ? [...taken, item] : taken;
    const nextCopies = original === undefined ? copies : new Map(copies).set(original, [...(copies.get(original) ?? []), item]);
    const text = layOutItems(nextTaken, nextCopies);
    if (taken.length > 0 && estimateAnswerTokens(text) > answerTokens) { stopped = index; break; }
    [taken, copies, log] = [nextTaken, nextCopies, text];
  }
  const leftOut = ordered.slice(stopped);
  const record: CurateRecord = {
    levers: picked.record.levers,
    items: taken, estimatedTokens: estimateAnswerTokens(log), answerTokens,
    collapsed: [...copies.values()].reduce((sum, list) => sum + list.length, 0),
    leftOut: {
      count: leftOut.length, ...(leftOut.length ? { strongestWeight: leftOut[0]!.weight } : {}),
      atHalfOrMore: leftOut.filter((item) => item.weight >= 0.5).length,
    },
  };
  const cutoff = options.sentenceCutoff ?? (options.decide === undefined ? false : DEFAULT_SENTENCE_CUTOFF);
  if (cutoff === false) return { log, record };

  const split = taken.map((item) => sentencesOf(body(item)));
  const batch: PickBatch = { task, questions: split.flatMap((sentences, part) => sentences.map((sentence, index) => ({
    key: `p${part}u${index}`, sourceId: `p${part}`, id: `u${index}`, role: 'reference' as const, title: '', anonymous: true,
    text: sentence.speaker === undefined ? sentence.text : `${sentence.speaker}: ${sentence.text}`,
    // The item's date rides on its first sentence.
    ...(index === 0 && taken[part]!.candidate.date ? { date: taken[part]!.candidate.date } : {}),
    question: SENTENCE_QUESTION, trueCriterion: SENTENCE_TRUE, falseCriterion: SENTENCE_FALSE,
  }))) };
  const counts = { cutoff, of: batch.questions.length, estimatedTokensBefore: record.estimatedTokens };
  let answers: Awaited<ReturnType<PickDecide>>;
  try {
    answers = await options.decide!(batch, signal);
  } catch (error) {
    signal.throwIfAborted();
    // A failed request must not lose the answer: the whole text goes back.
    return { log, record: { ...record, sentences: {
      ...counts, kept: counts.of, unanswered: counts.of, itemsTrimmed: 0, itemsLeftOut: 0,
      failed: error instanceof Error ? error.message : String(error),
    } } };
  }
  let kept = 0, unanswered = 0, itemsTrimmed = 0;
  const shown = new Map<Item, Item>();
  taken.forEach((item, part) => {
    const keep = split[part]!.map((_, index) => {
      const answer = answers?.[`p${part}u${index}`];
      const rating = answer?.status === 'answered' && 'probability' in answer ? answer.probability : NaN;
      // A sentence with no rating stays: a missing answer must not lose evidence.
      if (!Number.isFinite(rating)) { unanswered += 1; return true; }
      return rating >= cutoff;
    });
    const text = keptText(split[part]!, keep);
    if (!text.trim()) return;
    kept += keep.filter(Boolean).length;
    if (keep.includes(false)) itemsTrimmed += 1;
    shown.set(item, { ...item, candidate: { ...item.candidate, text } });
  });
  const left = [...shown.values()];
  const trimmed = left.length === 0 ? '' : layOutItems(left,
    new Map([...copies].flatMap(([item, list]) => shown.has(item) ? [[shown.get(item)!, list] as const] : [])));
  return { log: trimmed, record: {
    ...record, items: left, estimatedTokens: estimateAnswerTokens(trimmed),
    sentences: { ...counts, kept, unanswered, itemsTrimmed, itemsLeftOut: taken.length - left.length },
  } };
}
