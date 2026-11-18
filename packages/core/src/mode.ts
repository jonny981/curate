import { chatRead, type ConversationRules } from './chat-read.js';
import type { EmbeddingFunction } from './meaning.js';
import type { MemoryCandidate, PickCascade } from './pick.js';

/** How one kind of source is judged and read: its decision questions,
 *  the bar its reference parts are kept at, and how the decide step
 *  reads them. A source carries its mode; each reader package exports
 *  its own. Core holds no mode, only the two shared reads below. */
export interface Mode {
  /** The mode's name; the record names each source's mode with it. */
  readonly name: string;
  /** The decision questions asked of the mode's reference parts.
   *  Absent: the built-in question for each part's kind. */
  readonly questions?: PickCascade;
  /** A reference part is kept when scored at or above this. Absent:
   *  the question set's fitted bar, or else 0.0146. */
  readonly bar?: number;
  /** The decision state of a request of this mode's parts lists the
   *  facts the answer needs, when the call gives them (`needed`). */
  readonly needed?: boolean;
  /** How the decide step reads the mode's parts on the fused order:
   *  `rankedRead` or a `conversationRead()`. Parts of modes that share
   *  a read are read together. */
  readonly read: ModeRead;
}

/** One read of the fused order's parts. */
export type ModeRead = (input: ModeReadInput) => Promise<ModeReadResult>;

/** A source's parts that no lane kept, for a mode read of its own:
 *  found by key and made into candidates only when the read reaches
 *  them. A source whose mode reads on its own hands them on the read
 *  that sizes its history (`poolIds`), so the pick never holds them.
 *  Each answers at once, from the source's own index: the read runs
 *  beside others, and a wait here would change when its requests go
 *  out against theirs. */
export interface ModeParts {
  /** The transcript `part` sits in, as positions in place order; a part
   *  is made only when asked for. Undefined when the source does not
   *  hold the part. */
  transcript(part: MemoryCandidate): ModeTranscript | undefined;
  /** The person's own parts, newest first; equal dates in pool order. */
  person(): Iterable<MemoryCandidate>;
  /** Every part that can belong to a unit of agent work (marked a
   *  prompt, a report or a summary, or written by an agent in the
   *  user's turn), in pool order. */
  units(): readonly MemoryCandidate[];
  /** A part's place in the pool order: the order the source's whole
   *  read lists every part in. Parts that share an id take the place of
   *  the first of them. */
  place(part: MemoryCandidate): number;
  /** Where each part comes among the parts of the pool order no lane
   *  holds, counting only the first part of each id: the order a pick
   *  given the whole pool would list them in. `laneIds` are the ids of
   *  the source's parts the lanes hold. */
  dealt(laneIds: ReadonlySet<string>): (part: MemoryCandidate) => number;
  /** The parts the call keeps, in their order. A part this lookup made
   *  holds no text of its own: its text is read once more and checked
   *  against the text it was made from, and it comes back holding that
   *  text. A part whose row no longer holds that text, then or at any
   *  read during the call, is left out and counted in `changed`. */
  settle(selected: readonly MemoryCandidate[]): { readonly kept: readonly MemoryCandidate[]; readonly changed: number };
  /** Lets go of the index connection the lookup holds open. */
  close(): void;
  /** The same parts with the pool order `compare` gives (a stable sort
   *  of the reader's own order): a caller that reorders the source's
   *  whole read reorders these the same way. The reader sorts one array
   *  of part numbers and reuses the two parts it hands `compare`, so
   *  `compare` must not keep them. */
  ordered(compare: (left: PoolPart, right: PoolPart) => number): ModeParts;
}

/** What a pool order compares: a part's id, its score in the task's
 *  keyword read of the whole history, its date and its session's latest
 *  date in the read (milliseconds; 0 for none). */
export interface PoolPart {
  readonly id: string;
  readonly score: number;
  readonly date: number;
  readonly sessionLatest: number;
}

/** A transcript a source hands by key: its parts by position, in place
 *  order, each made only when asked for. Parts that share an id count
 *  once, at the first of them. */
export interface ModeTranscript {
  /** How many parts it holds. */
  readonly length: number;
  /** The id of the part at a position. */
  id(position: number): string;
  /** The part at a position, made when first asked for. */
  part(position: number): MemoryCandidate;
  /** Each position's text, read again from the source and not kept. */
  texts(): readonly string[];
  /** True when two of its parts share a place, so place order alone
   *  does not order them. */
  readonly ties: boolean;
}

/** A transcript the conversation read reaches: its parts by position in
 *  place order. The read makes a part only when it rates or returns it;
 *  the rest it knows by position. */
export interface ReachedTranscript {
  readonly length: number;
  /** The part at a position, made if the call does not hold it yet. */
  at(position: number): MemoryCandidate;
  /** The part at a position if the call holds it already. */
  held(position: number): MemoryCandidate | undefined;
  /** Where a part of this transcript sits. */
  positionOf(part: MemoryCandidate): number;
  /** The topic split's text for each position: the part's text, or its
   *  title when the text is blank. */
  texts(): readonly string[];
}

/** The parts a conversation read may reach beyond `parts`, from every
 *  source of the read, made into one candidate a part per call. */
export interface ModeReach {
  readonly transcript: (part: MemoryCandidate) => ReachedTranscript;
  readonly person: () => Iterable<MemoryCandidate>;
  readonly units: () => readonly MemoryCandidate[];
  /** Where a part sits in the pick's order of the read's parts, as
   *  `parts` lists them: lower first. */
  readonly queued: (part: MemoryCandidate) => readonly [number, number];
}

/** What a read is given. The ranked read takes `order`, `then`,
 *  `between`, `waves`, `copied`, `score`, `kept`, `stopped` and `stop`;
 *  the conversation read takes `parts`, `order`, `byKeyword`, `lanes`,
 *  `score`, `kept` and `stopped`. Both rate through `rate`. */
export interface ModeReadInput {
  /** The modes' reference parts: every part the read may reach. */
  readonly parts: readonly MemoryCandidate[];
  /** The parts to read, in the fused order. */
  readonly order: readonly MemoryCandidate[];
  /** Parts the ranked read reads after `order`, under the same stop,
   *  when `between` returns true: the call's `bestPartFirst`. */
  readonly then?: readonly MemoryCandidate[];
  readonly between?: () => boolean;
  /** The parts the keyword lanes ranked, best first. */
  readonly byKeyword: readonly MemoryCandidate[];
  /** Each search lane's parts in lane order, across the sources this
   *  read reads: no other source's parts take its lane heads. */
  readonly lanes: readonly (readonly MemoryCandidate[])[];
  /** Rate these parts; resolves once their ratings are in. One
   *  function serves every read of the call. */
  readonly rate: (parts: readonly MemoryCandidate[]) => Promise<void>;
  /** The next wave of rating `order` from `from`: the parts listed by
   *  the request each goes out in. */
  readonly waves: (order: readonly MemoryCandidate[], from: number) => MemoryCandidate[][];
  /** True when an identical earlier text answered the part, so it
   *  rode free in its request. */
  readonly copied: (part: MemoryCandidate) => boolean;
  /** A part's decision score as selection reads it, or undefined. */
  readonly score: (part: MemoryCandidate) => number | undefined;
  /** True when selection would keep one of these parts. */
  readonly kept: (parts: readonly MemoryCandidate[]) => boolean;
  /** True once a stopping dial has ended the call. */
  readonly stopped: () => boolean;
  /** The call's rating stop (`stopWhenCold`), when set. */
  readonly stop?: { readonly floor: number; readonly share: number };
  /** True when a part's decision came from an earlier pick of the call. */
  readonly reused?: (part: MemoryCandidate) => boolean;
  /** The search texts the read's sources read, the task first. */
  readonly queries?: readonly string[];
  /** The call's local embedder, when it has one. */
  readonly embed?: EmbeddingFunction;
  /** The parts beyond `parts` a conversation read may reach, when its
   *  sources hand them by key rather than as candidates. */
  readonly reach?: ModeReach;
}

/** What a read did. */
export interface ModeReadResult {
  /** The reference parts it rated, in the order it reached them. The
   *  ranked read lists them only under a rating stop. */
  readonly read: readonly MemoryCandidate[];
  /** The parts of the order it never reached, and the reason they
   *  record. */
  readonly unread: readonly MemoryCandidate[];
  readonly reason: 'stopWhenCold' | 'chatRead';
  /** What ended it: 'order' when the order ran out, 'cold' when the
   *  ranked read's ratings went cold, 'fall' when the conversation
   *  read's new warm parts fell, 'stopped' when a stopping dial ended
   *  the call. */
  readonly ended: 'order' | 'cold' | 'fall' | 'stopped';
  /** The ranked read under a rating stop: the waves of requests it
   *  sent, the requests it checked, and the one that went cold. */
  readonly waves?: number;
  readonly batches?: number;
  readonly cold?: {
    readonly batch: number;
    readonly best: number;
    readonly bestBefore: number;
    readonly under: 'floor' | 'share';
  };
  /** The conversation read: the requests of the order it read before
   *  the segments, the segments it opened, and the units of agent work
   *  it opened after them. */
  readonly requests?: number;
  readonly segments?: number;
  readonly units?: number;
}

/** The ranked read: the fused order from the top. With no rating stop
 *  it rates the whole order at once. With one, it rates a wave of
 *  requests at a time and checks each request in order: it stops at
 *  the first whose best score is under `stop.floor`, or under
 *  `stop.share` times the best score before it, once selection keeps a
 *  part it rated. A part an identical earlier text answered does not
 *  count toward its request's best. */
export const rankedRead: ModeRead = async (input) => {
  const rated = new Set<MemoryCandidate>();
  const unread: MemoryCandidate[] = [];
  let waves = 0;
  let batches = 0;
  let best = 0;
  let cold: ModeReadResult['cold'];
  const read = async (order: readonly MemoryCandidate[]) => {
    const rule = input.stop;
    if (rule === undefined) { await input.rate(order); return; }
    let at = 0;
    while (at < order.length && !input.stopped() && cold === undefined) {
      const wave = input.waves(order, at);
      const parts = wave.flat();
      await input.rate(parts);
      waves += 1;
      at += parts.length;
      for (const part of parts) {
        if (part.role === 'reference' && input.score(part) !== undefined) rated.add(part);
      }
      let kept: boolean | undefined;
      const keptAny = () => kept ??= input.kept([...rated]);
      for (const batch of wave) {
        const own = batch.filter((part) => part.role === 'reference' && !input.copied(part));
        if (!own.some((part) => input.score(part) !== undefined)) continue;
        batches += 1;
        if (input.stopped() || cold !== undefined) continue;
        const top = Math.max(0, ...own.map((part) => input.score(part) ?? 0));
        // Until the read has kept a part, a cold request does not stop
        // it, so a history whose evidence sits below a cold stretch
        // never comes back empty.
        if ((top < rule.floor || top < rule.share * best) && keptAny()) {
          cold = { batch: batches, best: top, bestBefore: best, under: top < rule.floor ? 'floor' : 'share' };
        } else best = Math.max(best, top);
      }
    }
    if (cold !== undefined) unread.push(...order.slice(at));
  };
  await read(input.order);
  if (input.then !== undefined && input.between?.() !== false) await read(input.then);
  return { read: [...rated], unread, reason: 'stopWhenCold', ended: cold === undefined ? 'order' : 'cold',
    ...(input.stop === undefined ? {} : { waves, batches }), ...(cold === undefined ? {} : { cold }) };
};

/** A conversation read (`chatRead`): the person's own parts first,
 *  rings of neighbours around the warm ones, a stop when a request's
 *  new warm parts fall, then the topic segments that hold a warm person
 *  part or a search lane's top part, walked out from their warm parts,
 *  then the units of agent work (a subagent's prompt or report) that
 *  rank above the bend of the keyword ranking or of the meaning ranking
 *  against the queries, among their own kind, read the
 *  same way, each container read in the order its parts' `place` gives. `rules`
 *  replaces any of its three decisions; with none it is the read
 *  measured on coding-agent transcripts. Make it once per mode: modes
 *  that share one read are read together. */
export function conversationRead(rules: ConversationRules = {}): ModeRead {
  return async (input) => {
    const result = await chatRead({ parts: input.parts, order: input.order, byKeyword: input.byKeyword,
      lanes: input.lanes, rate: input.rate, score: input.score, kept: input.kept, stopped: input.stopped, rules,
      ...(input.reach === undefined ? {} : { reach: input.reach }),
      ...(input.queries === undefined ? {} : { queries: input.queries }),
      ...(input.reused === undefined ? {} : { reused: input.reused }),
      ...(input.embed === undefined ? {} : { embed: input.embed }) });
    const reached = new Set(result.read);
    return { read: result.read, unread: input.order.filter((part) => !reached.has(part)), reason: 'chatRead',
      ended: result.ended, requests: result.requests, segments: result.segments, units: result.units };
  };
}
