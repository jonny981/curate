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
   *  the question set's fitted bar, or else 0.0146. One bar per kind of
   *  task (`{ 'one decision': 0.59, 'everything said': 0.04 }`) keeps at
   *  the bar for the pick's `wanted`, and at the lower of the two when
   *  the pick gives none. */
  readonly bar?: number | { readonly 'one decision': number; readonly 'everything said': number };
  /** The decision state of a request of this mode's parts lists the
   *  facts the answer needs, when the call gives them (`needed`). */
  readonly needed?: boolean;
  /** The form of this mode's decision requests: `'text'`, the task and
   *  each item as plain text (`jevTextRequest`), or, unset or `'json'`,
   *  the JSON state (`jevRequest`). A request that carries anything the
   *  JSON state is for (the needed facts, the person, the kind of task,
   *  hard facts, a Choice, one item alone, a second stage) is sent as
   *  JSON whatever this says. The form moves the decision model's scale,
   *  so a bar is measured for the form a mode uses. */
  readonly request?: 'text' | 'json';
  /** Whether a caller's second search reads this mode's sources: the
   *  skill searches the sources the agent mode reads again, with lines
   *  drawn from the first pick's surest parts. `false` turns it off;
   *  core itself does not search again. */
  readonly searchAgain?: boolean;
  /** A second stage, off by default: after the read ends, the parts it
   *  kept at the mode's own bar are judged again with these questions,
   *  and kept only at or above this stage's bar; the read itself stays
   *  on the mode's questions and bar. `wholeMessages`, `hardFacts` and
   *  `itemsPerRequest` act on this stage's requests alone (unset: parts
   *  as they are, no hard facts, batched). The needed facts go in its
   *  requests' state when the call gives them. A kept message keeps
   *  every piece the pick holds, at its message's score, which is the
   *  entry's `probability`; the read's own score is `readProbability`.
   *  Its set takes questions, weights, a needed-fact question and
   *  `combine`, none of the read-only machinery (typed, written, named,
   *  first, band, a fitted model). */
  readonly keep?: {
    readonly questions: PickCascade;
    readonly bar?: number | { readonly 'one decision': number; readonly 'everything said': number };
    /** A bar for each kind of message (`KEEP_KINDS`: the person's
     *  message, an agent step, tool output, a subagent's prompt or final
     *  report, a compaction summary, a system message), each a number or
     *  one per kind of task; a kind with none given, or a message whose
     *  kind its reader did not mark, uses `bar`. A bar of 1 keeps a kind
     *  only as part of an exchange. */
    readonly barByKind?: { readonly [kind: string]: number | { readonly 'one decision': number; readonly 'everything said': number } };
    /** Keep the exchange around what the person said: for each message
     *  of the person this stage keeps, the agent message it replies to
     *  and the agent's reply (the last agent message before the person's
     *  next), whatever they rate; for each subagent's final report it
     *  keeps, the request that asked for it. Tool output joins no
     *  exchange. Each such message's entry says it was kept for an
     *  exchange (`keptAs: 'exchange'`) and whose (`exchange`), and the
     *  text lays an exchange out as one passage. `{ nearest: 'paragraph' }`
     *  lays each agent message kept only for an exchange out as the
     *  paragraph nearest the person's message (the closing paragraph of
     *  the message the person answers, the opening paragraph of the
     *  reply), marking what is left out with the message's id; a message
     *  kept on its own rating is never cut. */
    readonly exchange?: boolean | { readonly nearest?: 'paragraph' };
    readonly wholeMessages?: boolean;
    readonly hardFacts?: boolean;
    readonly itemsPerRequest?: number;
  };
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
  /** Hard facts in the decision state, off by default: fields code
   *  knows for certain about each item, written into its record, never
   *  as prose in its text. A transcript part gets its `kind` ('<person>
   *  message', 'agent step', 'tool output', 'compaction summary',
   *  'subagent prompt', 'subagent final report', 'system message'), its
   *  `session`, and how many `pieces` its message has (with the item's
   *  own `piece` when it is one of several); the person's messages get
   *  the call's `person` as their `author`. When the mode's read walks
   *  whole transcripts, so the pick holds every part, it also gets its
   *  message's `position` in the session, `replies_to` (the nearest
   *  earlier message by the other side, the person or anyone else) and,
   *  for a message not the person's, `answered_by` (the person's next
   *  message), each that message's first piece's id and its first 1,000
   *  characters. A commit gets `kind: 'commit'` and a note `kind:
   *  'note'`, and nothing else. The request's state also carries the
   *  call's `person` and `wanted`, when the call gives them. With
   *  `wholeMessages` and `itemsPerRequest: 1` this is the form measured
   *  to sharpen the ranking; batched with many items, the same fields
   *  did not. */
  readonly hardFacts?: boolean;
  /** What each kept part is doing, off by default: after selection, a
   *  Choice per kept part, "What does this item do with the subject of
   *  the task?", among eight concrete situations (states a settled
   *  decision, proposes, reports a work step, asks, approves, repeats
   *  what was said, tool output, only mentions the subject). Its answer
   *  goes in the record entry as `doing`, and in the item's record in the
   *  state of a later step (a Choice per needed fact) as `doing`. Where
   *  the read walks whole transcripts, code marks an agent's proposal
   *  that the person's next message approves with `approvedBy`, the
   *  person's part, and `approved_by` in the later step's state. No
   *  weight is put on any role. */
  readonly roles?: boolean;
  /** Compare the kept parts for each needed fact, off by default. After
   *  selection, for each fact the call gives (`needed`), the decision
   *  model's maker's large-choice recipe: the `candidates` kept parts
   *  (one per message under `wholeMessages`) the rating already bought
   *  ranks best for that fact (the set's own question for the fact when
   *  it asks one, else the part's score), each written into its own
   *  option of one Choice, "Which of these items states this needed
   *  fact: {fact}", the task in the state. The pick is removed and the
   *  Choice asked again until the sufficiency question, asked after each
   *  round of the picks so far, says they suffice, or no candidate is
   *  left. The picks lead the text; every other kept part still follows,
   *  so nothing is dropped. It needs a decider that answers list
   *  requests, such as `jev()`. */
  readonly choicePerFact?: boolean | {
    /** The candidates a fact: 20 unless set, the recipe's value. */
    readonly candidates?: number;
    /** "Do these items together state everything the task asks?", asked
     *  of the picks so far alone, in their own request, after each round;
     *  at or over the bar (default 0.7, the maker's starting point for a
     *  clear yes) every fact's loop ends. On unless `false`. */
    readonly enough?: boolean | { readonly bar?: number };
  };
  /** How many items one decision request about the mode's parts holds,
   *  off by default: unset, requests hold as many items as the request
   *  limits allow, as before. `1` sends each item in a request of its
   *  own, with all of its questions; the requests of a round go out at
   *  once, inside `limits.maxInFlight` and the decider's own rate, so the
   *  wait does not grow with their count, but the task and the fields
   *  beside it repeat in every request. A rating stop still plans its
   *  waves in parts, as before. */
  readonly itemsPerRequest?: number;
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
