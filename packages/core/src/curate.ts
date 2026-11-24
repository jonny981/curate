import type { MemoryCandidate, PickBatch, PickDecide, PickResult } from './pick.js';
import type { LeverStates } from './levers.js';
import { checkCurateOptions } from './options.js';
import { messageKey, messagePieces, messageText } from './chat-read.js';

/** The estimate curate states its text's size with, and holds an
 *  `answerTokens` budget with when one is set. Characters
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
 *  `#### <source> (said <date>)` heading; when a Choice per needed fact
 *  picked items (the record entries' `chosen`), the picks sit there
 *  instead, in the order picked: each round's picks, fact by fact. Every other item is grouped by
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
 *  <date>)`. The kept parts of an item cut into parts (`part` and
 *  `documentId` set), such as a long commit message, sit together at the
 *  place of the first taken, under the item's title and in their own
 *  order, with `…` where parts were left out and a last line saying how
 *  many. */
export interface CurateOptions {
  /** Keep the whole text within this many estimated tokens. The
   *  estimate needs no tokenizer and is set a little high, but it is an
   *  approximate budget: a real tokenizer can count more on text full of
   *  rare names. Items are taken in weight order,
   *  and the first item that would take the text over this stops the
   *  taking. The strongest item is always kept whole, even over the
   *  budget. Omitted, there is no budget: every kept item its source's
   *  text share admits is laid out. */
  readonly answerTokens?: number;
  /** Keep only the sentences that bear on the task. Measured at 0.1 on
   *  150 LongMemEval questions, it removed 9.2% of the sentences and 7.2%
   *  of the tokens, and cut 12 labelled answer turns that were whole in
   *  the text to partial or absent. After the items are
   *  taken, `decide` rates every sentence of them in one request, and a
   *  sentence stays when its rating is this number or more, from 0 to 1.
   *  Kept sentences stay in their own words and order under the same
   *  headings, and `…` marks each place text was left out. An item with
   *  no sentence kept is left out. A sentence is the text up to a full
   *  stop, question mark or exclamation mark followed by a space, or to
   *  the line's end; blank lines go. A line that opens `user: `,
   *  `assistant: ` or `<name>: ` for a name in the item's `speakers`
   *  names its speaker, and the first kept sentence of
   *  that speaker's turn carries the name. A sentence `decide` gives no
   *  rating stays. When the request fails, the whole text is returned as
   *  if no sentence were rated, and `record.sentences.failed` says why.
   *  An `answerTokens` budget, when set, bounds the text that is rated,
   *  not the text returned, which is usually far smaller. A kept sentence
   *  can lose the sentence that says what it refers to. Omitted or
   *  `false`, no sentence is rated and no model is called, whether or
   *  not `decide` is given. A number needs `decide`. */
  readonly sentenceCutoff?: number | false;
  /** Rates each sentence for `sentenceCutoff`. */
  readonly decide?: PickDecide;
  readonly signal?: AbortSignal;
  /** The person's name, for a text laid out message by message: their
   *  messages are headed with it. Absent: "the person". */
  readonly person?: string;
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
  /** The returned text's estimated tokens: its size, a result of the
   *  ratings unless an `answerTokens` budget was set. */
  readonly estimatedTokens: number;
  /** Present when an `answerTokens` budget was set: the budget the items
   *  were taken within. */
  readonly answerTokens?: number;
  /** Present when the pick kept no reference item: the text is empty. */
  readonly nothingKept?: true;
  /** How many items were left out as copies of an item taken before
   *  them: the same text. */
  readonly collapsed: number;
  /** Present when the text shows an item in parts, such as a long commit
   *  message: how many of those items' parts it does not show. */
  readonly partsNotKept?: number;
  /** The selected items an `answerTokens` budget stopped before: how
   *  many, the highest weight among them, and how many have a weight of
   *  0.5 or more. None when no budget is set. A copy counted in
   *  `collapsed` is not counted here. */
  readonly leftOut: {
    readonly count: number;
    readonly strongestWeight?: number;
    readonly atHalfOrMore: number;
  };
  /** Present when a source's mode sets `textShare`: how many selected
   *  items were left out for weighing under that share of their
   *  source's best item. They are not counted in `leftOut`. */
  readonly underShare?: number;
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

/** Who said a message laid out on its own: a turn's speaker, the person,
 *  an agent, tool output or the system; undefined when its reader marked
 *  no one. */
const speakerOf = (candidate: MemoryCandidate, person: string | undefined) => candidate.turn?.speaker
  ?? (candidate.author === 'person' ? person ?? 'the person' : candidate.author === 'agent' ? 'agent'
    : candidate.author === 'tool' ? 'tool output' : candidate.author === 'system' ? 'system' : undefined);

/** The taken items as the layout shows them: each on its own, except
 *  the parts of one item cut into parts (`part` and `documentId` set),
 *  which join the place of the first of them taken. */
function blocksOf(taken: readonly Item[]): Item[][] {
  const blocks: Item[][] = [];
  const byDocument = new Map<string, Item[]>();
  for (const item of taken) {
    const { part, documentId, sourceId, sourceRevision } = item.candidate;
    if (part === undefined || documentId === undefined) {
      blocks.push([item]);
      continue;
    }
    const key = JSON.stringify([sourceId, sourceRevision, documentId]);
    const block = byDocument.get(key);
    if (block === undefined) {
      const opened = [item];
      byDocument.set(key, opened);
      blocks.push(opened);
    } else block.push(item);
  }
  return blocks;
}

/** A block's text. Parts of one item show under its title, in their own
 *  order, with `…` where parts between or after them were not kept, and
 *  a last line saying how many were not kept. */
function blockText(block: readonly Item[]): string {
  const first = block[0]!.candidate;
  if (first.part === undefined || first.documentId === undefined) return body(block[0]!);
  const parts = [...block].sort((left, right) => left.candidate.part!.index - right.candidate.part!.index);
  const lines = [first.title];
  let last = 0;
  for (const item of parts) {
    if (item.candidate.part!.index > last + 1) lines.push('…');
    lines.push(body(item));
    last = item.candidate.part!.index;
  }
  const notKept = first.part.of - parts.length;
  if (notKept === 0) return lines.join('\n\n');
  if (last < first.part.of) lines.push('…');
  return [...lines, `${notKept} of ${first.part.of} parts of ${first.documentId} were not kept.`].join('\n\n');
}

/** `partsNotKept` for the record: present when the text shows an item in parts. */
function partsNotKept(taken: readonly Item[]): { partsNotKept?: number } {
  const shown = blocksOf(taken).filter((block) => block[0]!.candidate.part !== undefined
    && block[0]!.candidate.documentId !== undefined);
  return shown.length === 0 ? {}
    : { partsNotKept: shown.reduce((sum, block) => sum + block[0]!.candidate.part!.of - block.length, 0) };
}

/** The memory text for the items taken, strongest first. A taken item's
 *  heading also names each other place and date its copies were said.
 *  `picked`, when a Choice per needed fact picked items: those lead,
 *  under `Most likely answer`, in place of the two strongest.
 *  `byMessage`, for a text whose every item is a whole message: each
 *  item under its own heading, strongest first, naming its session, its
 *  time to the minute and who said it, with no grouping by date. */
function layOutItems(taken: readonly Item[], copies: ReadonlyMap<Item, readonly Item[]>, picked?: (item: Item) => boolean,
  byMessage?: {
    readonly person?: string;
    readonly exchangeOf?: (item: Item) => readonly { readonly sourceId: string; readonly id: string }[];
    /** Whether an item was kept only for an exchange whose source lays
     *  such messages out as their paragraph nearest the person's. */
    readonly cutForExchange?: (item: Item) => boolean;
  }): string {
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
  if (byMessage !== undefined) {
    const lead = picked === undefined ? 2 : taken.filter(picked).length;
    // A message's session, or a turn's note, in place of the source, and
    // its time to the minute, as its record wrote it.
    const placeOf = (item: Item) => {
      const { label } = source(item);
      const candidate = item.candidate;
      const minute = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(candidate.date?.value ?? '');
      const said = minute === null ? source(item).said : `${minute[1]} ${minute[2]}`;
      const where = candidate.chat !== undefined ? `session ${candidate.chat.sessionId.slice(0, 8)}` : candidate.turn?.session ?? source(item).where;
      return `${where} (${label} ${said || 'unknown'})`;
    };
    const named = (item: Item) => {
      const own = placeOf(item);
      const elsewhere = [...new Set((copies.get(item) ?? []).map(placeOf))].filter((other) => other !== own);
      const who = speakerOf(item.candidate, byMessage.person);
      return `#### ${own}${who === undefined ? '' : `, ${who}`}${elsewhere.length === 0 ? '' : `, also ${elsewhere.join(', ')}`}\n\n${body(item)}`;
    };
    // Messages kept as one exchange are one passage: in conversation
    // order, placed by their strongest message, each line naming who
    // said it and when, under one heading for the passage.
    const at = new Map(taken.map((item, index) => [JSON.stringify([item.candidate.sourceId, item.candidate.id]), index]));
    const parent = taken.map((_, index) => index);
    const root = (index: number): number => parent[index] === index ? index : (parent[index] = root(parent[index]!));
    taken.forEach((item, index) => {
      for (const anchor of byMessage.exchangeOf?.(item) ?? []) {
        const other = at.get(JSON.stringify([anchor.sourceId, anchor.id]));
        if (other !== undefined) parent[root(index)] = root(other);
      }
    });
    const passages = new Map<number, Item[]>();
    taken.forEach((item, index) => { passages.set(root(index), [...(passages.get(root(index)) ?? []), item]); });
    const order = (item: Item) => [Date.parse(item.candidate.date?.value ?? '') || 0, ...(item.candidate.place?.at ?? [])];
    const earlier = (left: Item, right: Item) => {
      const [a, b] = [order(left), order(right)];
      for (let index = 0; index < Math.max(a.length, b.length); index += 1) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
      return 0;
    };
    const laid = [...passages.values()].sort((left, right) => taken.indexOf(left[0]!) - taken.indexOf(right[0]!)).map((members) => {
      if (members.length === 1) return named(members[0]!);
      const inOrder = [...members].sort(earlier);
      // An agent message kept only for the exchange, cut to the paragraph
      // nearest the person's message: the closing paragraph of one the
      // person answers, the opening paragraph of one that replies; what
      // is left out is marked with the message's id.
      const keyOf = (item: Item) => JSON.stringify([item.candidate.sourceId, item.candidate.id]);
      const position = new Map(inOrder.map((item, index) => [keyOf(item), index]));
      const shown = (item: Item, index: number) => {
        if (byMessage.cutForExchange?.(item) !== true) return body(item);
        const anchors = (byMessage.exchangeOf?.(item) ?? []).flatMap((anchor) => {
          const at = position.get(JSON.stringify([anchor.sourceId, anchor.id]));
          return at === undefined ? [] : [at];
        });
        const paragraphs = body(item).split(/\n[ \t]*\n/).filter((paragraph) => paragraph.trim() !== '');
        if (paragraphs.length <= 1 || anchors.length === 0) return body(item);
        // A message the person answers keeps its closing paragraph; a reply
        // to the person keeps its opening one; a message that is both keeps both.
        const opening = anchors.some((at) => at < index);
        const closing = anchors.some((at) => at > index);
        const left = (where: string) => `[${where} paragraphs left out; the whole message is ${item.candidate.id}]`;
        return [
          ...(opening ? [paragraphs[0]!] : [left('earlier')]),
          ...(opening && closing && paragraphs.length > 2 ? [left('middle')] : []),
          ...(closing ? [paragraphs.at(-1)!] : [left('later')]),
        ].join('\n\n');
      };
      const times = inOrder.map((item) => /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(item.candidate.date?.value ?? ''));
      const when = (match: RegExpExecArray | null) => match === null ? 'unknown' : `${match[1]} ${match[2]}`;
      const where = placeOf(inOrder[0]!).replace(/ \(.*$/, '');
      return [`#### ${where}, an exchange (said ${when(times[0]!)} to ${when(times.at(-1)!)})`,
        ...inOrder.map((item, index) => `[${when(times[index]!)}] ${speakerOf(item.candidate, byMessage.person) ?? 'unmarked'}:\n${shown(item, index)}`)].join('\n\n');
    });
    const rest = laid.slice(lead);
    return [`### Most likely answer\n\n${laid.slice(0, lead).join('\n\n')}\n`,
      ...(rest.length === 0 ? [] : [`### More messages, strongest first\n\n${rest.join('\n\n')}`])].join('\n\n');
  }
  const blocks = blocksOf(taken);
  // The parts of one item sit in one block, so the lead counts blocks.
  const lead = picked === undefined ? 2 : blocks.filter((block) => picked(block[0]!)).length;
  const top = blocks.slice(0, lead).map((block) => `#### ${heading(block[0]!)}\n\n${blockText(block)}`);
  const groups = new Map<string, Item[][]>();
  for (const block of blocks.slice(lead)) {
    const item = block[0]!;
    // The heading closes the key, so an item whose copies were said elsewhere never shares a heading with one whose were not.
    const key = `${source(item).said}|${item.candidate.sourceId}|${source(item).where}|${source(item).label}|${heading(item)}`;
    groups.set(key, [...(groups.get(key) ?? []), block]);
  }
  const rest = [...groups].sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([, group]) => `### ${heading(group[0]![0]!)}\n\n${group.map(blockText).join('\n\n')}`);
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

const escaped = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A text as sentences, in order. Blank lines hold none. A line opening
 *  `user: `, `assistant: ` or one of `speakers` and a colon names who said it. */
function sentencesOf(text: string, speakers: readonly string[] = []): Sentence[] {
  const sentences: Sentence[] = [];
  let turn = 0;
  const opener = new RegExp(`^(${['user', 'assistant', ...speakers.filter((name) => name.trim() !== '')].map(escaped).join('|')}): `);
  text.split('\n').forEach((line, index) => {
    const named = opener.exec(line);
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
 *  own words, within an `answerTokens` budget when one is set, and, when
 *  sentences are rated, keep only the sentences that bear on the task.
 *  Selected rules remain the caller's instructions. */
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
  // The ids two different references share, found in one pass: such a
  // reference is named by its source and id together.
  const firstOf = new Map<string, MemoryCandidate>();
  const shared = new Set<string>();
  for (const candidate of references) {
    const first = firstOf.get(candidate.id);
    if (first === undefined) firstOf.set(candidate.id, candidate);
    else if (first !== candidate) shared.add(candidate.id);
  }
  const pieceItems = references.map((candidate) => {
    const entry = entries.get(JSON.stringify([candidate.sourceId, candidate.id]));
    if (entry?.status !== 'selected' || entry.probability === undefined
      || !Number.isFinite(entry.probability) || entry.probability < 0 || entry.probability > 1) {
      throw new TypeError('curate: each reference needs a selected record entry with a weight between 0 and 1.');
    }
    const id = shared.has(candidate.id) ? JSON.stringify([candidate.sourceId, candidate.id]) : candidate.id;
    return { id, candidate, weight: entry.probability };
  });
  // A source whose mode judged whole messages lays each message out once,
  // whole: its kept pieces joined in order, at its first piece's place,
  // with the message's weight.
  const whole = (candidate: MemoryCandidate) => (picked.record.levers.sources?.[candidate.sourceId]?.wholeMessages === true
    || picked.record.levers.sources?.[candidate.sourceId]?.keep?.wholeMessages === true)
    && (candidate.turn !== undefined || (candidate.chat !== undefined && (candidate.place?.at.length ?? 0) >= 3));
  const pieces = messagePieces(references.filter(whole));
  const itemOf = new Map(pieceItems.map((item) => [item.candidate, item]));
  const laid = new Set<string>();
  const items = pieceItems.flatMap((item) => {
    if (!whole(item.candidate)) return [item];
    const key = messageKey(item.candidate);
    if (laid.has(key)) return [];
    laid.add(key);
    const message = pieces.get(key)!;
    // A turn of a note written as a conversation is laid out whole, as its
    // reader read it.
    const turn = message[0]!.turn?.text;
    if (message.length === 1 && turn === undefined) return [item];
    const first = itemOf.get(message[0]!)!;
    return [{ ...first, candidate: { ...first.candidate, text: turn ?? messageText(message) },
      weight: Math.max(...message.map((piece) => itemOf.get(piece)!.weight)) }];
  });
  const answerTokens = options.answerTokens;
  // A pick that kept nothing gives an empty text: a question the history
  // holds nothing for still gets an answer.
  if (!items.length) {
    return { log: '', record: { levers: picked.record.levers, items: [], estimatedTokens: 0,
      ...(answerTokens === undefined ? {} : { answerTokens }), collapsed: 0, leftOut: { count: 0, atHalfOrMore: 0 }, nothingKept: true } };
  }
  // A source whose mode sizes its text by the ratings gives only the
  // parts within its share of its best part's weight.
  const best = new Map<string, number>();
  for (const { candidate, weight } of items) best.set(candidate.sourceId, Math.max(best.get(candidate.sourceId) ?? 0, weight));
  const shareOf = (sourceId: string) => picked.record.levers.sources?.[sourceId]?.textShare;
  const sized = items.filter(({ candidate, weight }) => weight >= (shareOf(candidate.sourceId) ?? 0) * best.get(candidate.sourceId)!);
  // The parts a Choice per needed fact picked lead, in the order they were
  // picked: each round's picks, fact by fact. Every other part follows.
  const pickOf = (item: Item) => entries.get(JSON.stringify([item.candidate.sourceId, item.candidate.id]))?.chosen
    ?.reduce((first, pick) => pick.round < first.round || (pick.round === first.round && pick.fact < first.fact) ? pick : first);
  const leading = (left: Item, right: Item) => {
    const [a, b] = [pickOf(left), pickOf(right)];
    return a === undefined || b === undefined ? Number(a === undefined) - Number(b === undefined) : a.round - b.round || a.fact - b.fact;
  };
  // `items` follows `picked.selected`, so a stable sort leaves equal weights in the fused order.
  const ordered = [...sized].sort((left, right) => leading(left, right) || right.weight - left.weight);
  // With picks, they make the `Most likely answer` section; without, the two strongest parts do.
  const picks = sized.some((item) => pickOf(item) !== undefined) ? (item: Item) => pickOf(item) !== undefined : undefined;
  // A text whose every item is a whole message is laid out message by
  // message, strongest first, each naming who said it.
  const exchangeOf = (item: Item) => {
    const entry = entries.get(JSON.stringify([item.candidate.sourceId, item.candidate.id]));
    return entry !== undefined && entry.status === 'selected' ? entry.exchange ?? [] : [];
  };
  const cutForExchange = (item: Item) => {
    const exchange = picked.record.levers.sources?.[item.candidate.sourceId]?.keep?.exchange;
    const entry = entries.get(JSON.stringify([item.candidate.sourceId, item.candidate.id]));
    return typeof exchange === 'object' && exchange.nearest === 'paragraph'
      && entry !== undefined && entry.status === 'selected' && entry.keptAs === 'exchange';
  };
  const byMessage = sized.length > 0 && sized.every((item) => whole(item.candidate))
    ? { ...(options.person === undefined ? {} : { person: options.person }), exchangeOf, cutForExchange } : undefined;
  let taken: Item[] = [];
  let copies = new Map<Item, readonly Item[]>();
  let log = '';
  let stopped = ordered.length;
  if (answerTokens === undefined) {
    // No budget: every item is taken, and the text is laid out once.
    const firstWith = new Map<string, Item>();
    for (const item of ordered) {
      // A copy of an item already taken adds only a place and date to that item's heading.
      const shown = body(item).trim();
      const original = firstWith.get(shown);
      if (original === undefined) { firstWith.set(shown, item); taken.push(item); }
      else copies.set(original, [...(copies.get(original) ?? []), item]);
    }
    log = layOutItems(taken, copies, picks, byMessage);
  } else {
    for (const [index, item] of ordered.entries()) {
      // A copy of an item already taken adds only a place and date to that item's heading.
      const shown = body(item).trim();
      const original = taken.find((kept) => body(kept).trim() === shown);
      const nextTaken = original === undefined ? [...taken, item] : taken;
      const nextCopies = original === undefined ? copies : new Map(copies).set(original, [...(copies.get(original) ?? []), item]);
      const text = layOutItems(nextTaken, nextCopies, picks, byMessage);
      if (taken.length > 0 && estimateAnswerTokens(text) > answerTokens) { stopped = index; break; }
      [taken, copies, log] = [nextTaken, nextCopies, text];
    }
  }
  const leftOut = ordered.slice(stopped);
  const record: CurateRecord = {
    levers: picked.record.levers,
    items: taken, estimatedTokens: estimateAnswerTokens(log), ...(answerTokens === undefined ? {} : { answerTokens }),
    collapsed: [...copies.values()].reduce((sum, list) => sum + list.length, 0),
    ...partsNotKept(taken),
    leftOut: {
      count: leftOut.length, ...(leftOut.length ? { strongestWeight: leftOut[0]!.weight } : {}),
      atHalfOrMore: leftOut.filter((item) => item.weight >= 0.5).length,
    },
    ...(items.some(({ candidate }) => shareOf(candidate.sourceId) !== undefined) ? { underShare: items.length - sized.length } : {}),
  };
  const cutoff = options.sentenceCutoff ?? false;
  if (cutoff === false) return { log, record };

  const split = taken.map((item) => sentencesOf(body(item), item.candidate.speakers));
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
    new Map([...copies].flatMap(([item, list]) => shown.has(item) ? [[shown.get(item)!, list] as const] : [])), picks, byMessage);
  const { partsNotKept: _before, ...rest } = record;
  return { log: trimmed, record: {
    ...rest, ...partsNotKept(left), items: left, estimatedTokens: estimateAnswerTokens(trimmed),
    sentences: { ...counts, kept, unanswered, itemsTrimmed, itemsLeftOut: taken.length - left.length },
  } };
}
