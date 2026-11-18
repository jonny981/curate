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
  /** The text takes a kept part of this mode only when its decision
   *  weight is at least this share of the best kept part's of its
   *  source. Absent: every kept part, within the token budget. */
  readonly textShare?: number;
  /** Judge whole messages, off by default. A transcript message is cut
   *  into pieces for the search lanes; with this on, the decision
   *  questions about a ranked piece are asked once about its whole
   *  message (every piece the pick holds, joined in order), a
   *  subagent's report with the request that produced it (`asked`),
   *  and the message's rating applies to each of its pieces: they are
   *  kept together, and the text lays the message out once, whole. A
   *  message too large for one request (`limits.maxBatchChars`) is sent
   *  as consecutive parts, each marked `part: 'k of n'` and, after the
   *  first, carrying the message's first piece as `opening`; the
   *  message's rating is its best part's. Only parts a transcript reader
   *  placed (`chat` and `place`) are joined; any other part is its own
   *  message. */
  readonly wholeMessages?: boolean;
  /** How the decide step reads the mode's parts on the fused order:
   *  `rankedRead` or a `conversationRead()`. Parts of modes that share
   *  a read are read together. */
  readonly read: ModeRead;
}

/** One read of the fused order's parts. */
export type ModeRead = ((input: ModeReadInput) => Promise<ModeReadResult>) & {
  /** True for a read that walks each part's whole container, such as a
   *  `conversationRead()`: its source keeps every part of its history,
   *  not only the parts a search lane kept. Any other read, like the
   *  ranked read, has the parts no lane kept counted, never given. */
  readonly walks?: boolean;
};

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
  /** The call's rating stop (`stopWhenCold`), when set: its floor and
   *  share, and how many rated parts it judges at a time. */
  readonly stop?: { readonly floor: number; readonly share: number; readonly parts: number };
  /** The search texts the read's sources read, the task first. */
  readonly queries?: readonly string[];
  /** The call's local embedder, when it has one. */
  readonly embed?: EmbeddingFunction;
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
   *  sent, the windows of rated parts it judged, and the one that went
   *  cold. */
  readonly waves?: number;
  readonly windows?: number;
  readonly cold?: {
    readonly window: number;
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
 *  requests at a time and judges the rated parts in windows of
 *  `stop.parts`, in order: it stops at the first window whose best
 *  score is under `stop.floor`, or under `stop.share` times the best
 *  score before it, once selection keeps a part it rated. A window is a
 *  count of parts, not a request, so how many parts one request holds
 *  (fewer when parts are long) never changes how much the stop judges.
 *  A part an identical earlier text answered does not count toward a
 *  window. Parts that do not fill a window at the end of the order are
 *  not judged. */
export const rankedRead: ModeRead = async (input) => {
  const rated = new Set<MemoryCandidate>();
  const unread: MemoryCandidate[] = [];
  let waves = 0;
  let windows = 0;
  let best = 0;
  // Rated parts waiting to fill the next window, in order.
  const pending: MemoryCandidate[] = [];
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
        pending.push(...batch.filter((part) => part.role === 'reference' && !input.copied(part) && input.score(part) !== undefined));
      }
      while (pending.length >= rule.parts && !input.stopped() && cold === undefined) {
        const judged = pending.splice(0, rule.parts);
        windows += 1;
        const top = Math.max(0, ...judged.map((part) => input.score(part) ?? 0));
        // Until the read has kept a part and rated one at or above the
        // floor, a cold window does not stop it, so a history whose
        // evidence sits below a cold stretch never comes back empty, and a
        // read whose first ratings all sit under the floor goes on until
        // one reaches it.
        if ((top < rule.floor || top < rule.share * best)
          && [...rated].some((part) => (input.score(part) ?? 0) >= rule.floor) && keptAny()) {
          cold = { window: windows, best: top, bestBefore: best, under: top < rule.floor ? 'floor' : 'share' };
        } else best = Math.max(best, top);
      }
    }
    if (cold !== undefined) unread.push(...order.slice(at));
  };
  await read(input.order);
  if (input.then !== undefined && input.between?.() !== false) await read(input.then);
  return { read: [...rated], unread, reason: 'stopWhenCold', ended: cold === undefined ? 'order' : 'cold',
    ...(input.stop === undefined ? {} : { waves, windows }), ...(cold === undefined ? {} : { cold }) };
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
  return Object.assign(async (input: ModeReadInput): Promise<ModeReadResult> => {
    const result = await chatRead({ parts: input.parts, order: input.order, byKeyword: input.byKeyword,
      lanes: input.lanes, rate: input.rate, score: input.score, kept: input.kept, stopped: input.stopped, rules,
      ...(input.queries === undefined ? {} : { queries: input.queries }),
      ...(input.embed === undefined ? {} : { embed: input.embed }) });
    const reached = new Set(result.read);
    return { read: result.read, unread: input.order.filter((part) => !reached.has(part)), reason: 'chatRead',
      ended: result.ended, requests: result.requests, segments: result.segments, units: result.units };
  }, { walks: true });
}
