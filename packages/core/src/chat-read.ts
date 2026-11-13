import type { MemoryCandidate } from './pick.js';

// The numbers below were measured on one history: about 116,000 parts of
// a person's own coding-agent transcripts (Claude Code and Codex, 45,000
// chat parts), Markdown notes and commits, with eight tasks and 56 known
// answer parts. Read live with the agent question set on that history,
// this read found 51 of the answers in 5,900 rated parts.

/** Person parts read in one request before the stop is checked, and
 *  the request size of the rest of the order: 112, the median number of
 *  parts one decision request carried in the replays the read was
 *  measured on. */
const STEP = 112;
/** A part is warm at this share of the best rating the read has seen so
 *  far, or more: 0.1, the keep level relative to a call's best that kept
 *  54 of the 56 answers. */
const WARM = 0.1;
/** The read stops after a request whose new warm parts are at most this
 *  share of the most any earlier request added: 0.3, fitted on three of
 *  the eight tasks; on the other five it read 3,744 parts against
 *  6,155 for a stop on no new warm part, and found the same 25 answers. */
const FALL = 0.3;
/** Each search lane's top parts whose topic segments the read opens:
 *  10, the head size that put 7 of the 9 agent-written answers inside
 *  2% of the history. */
const HEADS = 10;
/** The parts the lanes rank first inside an opened segment, where its
 *  walk starts: 3, which found 51 of 55 answers inside opened segments
 *  where one start found 32. */
const STARTS = 3;
/** The topic split (TextTiling, Hearst 1997): the word counts of this
 *  many parts on each side of a gap are compared, and a session of
 *  fewer than `TILE_MIN` parts stays whole. Taken as set, not tuned. */
const TILE_SIDE = 5;
const TILE_MIN = 40;
/** Common words the topic split ignores. */
const TILE_STOP = new Set(('about also aren assistant because been being could didn does doesn doing from have here into '
  + 'just like made make more much need only other over should some such than that their them then there these they '
  + 'this those used user using very want wasn were weren what when where which while will with would your').split(' '));

export interface ChatReadInput {
  /** The chat sources' reference parts: every part the read may reach. */
  readonly parts: readonly MemoryCandidate[];
  /** The order the call reads, best first: the parts some search lane
   *  ranked. Any other part comes after them, newest first. It orders
   *  the segments and their starts, and the read after the person's
   *  parts. */
  readonly order: readonly MemoryCandidate[];
  /** The parts the keyword lanes ranked, best first: the order the
   *  person's own parts are read in. Any other person part comes after
   *  them, newest first. */
  readonly byKeyword: readonly MemoryCandidate[];
  /** Each search lane's parts in lane order, across every source. */
  readonly lanes: readonly (readonly MemoryCandidate[])[];
  /** Rate these parts; resolves once their ratings are in. */
  readonly rate: (parts: readonly MemoryCandidate[]) => Promise<void>;
  /** A part's rating, or undefined when it has none. */
  readonly score: (part: MemoryCandidate) => number | undefined;
  /** True when selection would keep one of these parts: the stop waits
   *  until the read has kept one, so a call never ends its read with
   *  nothing kept while warm parts remain to read. */
  readonly kept: (parts: readonly MemoryCandidate[]) => boolean;
  /** True once a stopping dial has ended the call. */
  readonly stopped: () => boolean;
  /** The read's decisions; each one absent is today's measured rule
   *  (`walksOn`, `opens`, `stops`). */
  readonly rules?: ConversationRules;
}

/** The decisions a conversation read makes from ratings, each given the
 *  facts it may use. */
export interface ConversationRules {
  /** Whether a walk goes on from a part. */
  readonly walksOn?: (facts: WalkFacts) => boolean;
  /** Whether a topic segment opens. */
  readonly opens?: (facts: OpenFacts) => boolean;
  /** Whether the read stops after its last request. */
  readonly stops?: (facts: StopFacts) => boolean;
}

export interface ChatReadResult {
  /** The parts rated, in the order the read reached them. */
  readonly read: readonly MemoryCandidate[];
  /** Requests of the order read before the read moved to segments. */
  readonly requests: number;
  /** Topic segments opened. */
  readonly segments: number;
  /** 'fall' when the new warm parts fell, 'order' when the order ran
   *  out first, 'stopped' when a stopping dial ended the call. */
  readonly ended: 'fall' | 'order' | 'stopped';
}

const words = (text: string) => (text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [])
  .filter((word) => !TILE_STOP.has(word));

/** Where one session's topic shifts, by word counts alone: the cosine of
 *  the counts in the parts before and after each gap, each gap's depth
 *  below the nearest peaks on either side, and a cut at each local
 *  deepest gap whose depth is over the mean plus one spread. Returns the
 *  index of the first part after each cut. */
export function topicShifts(texts: readonly string[]): number[] {
  const n = texts.length;
  if (n < 4 * TILE_SIDE) return [];
  const bags = texts.map((text) => {
    const bag = new Map<string, number>();
    for (const word of words(text)) bag.set(word, (bag.get(word) ?? 0) + 1);
    return bag;
  });
  const window = (from: number, to: number) => {
    const sum = new Map<string, number>();
    for (const bag of bags.slice(Math.max(0, from), to)) {
      for (const [word, count] of bag) sum.set(word, (sum.get(word) ?? 0) + count);
    }
    return sum;
  };
  const squares = (bag: Map<string, number>) => [...bag.values()].reduce((sum, count) => sum + count * count, 0);
  const gaps: number[] = [];
  for (let gap = 1; gap < n; gap += 1) {
    const left = window(gap - TILE_SIDE, gap);
    const right = window(gap, gap + TILE_SIDE);
    let dot = 0;
    for (const [word, count] of left) dot += count * (right.get(word) ?? 0);
    const norm = Math.sqrt(squares(left) * squares(right));
    gaps.push(norm === 0 ? 0 : dot / norm);
  }
  const depth = gaps.map((value, at) => {
    let left = value;
    for (let j = at; j > 0 && gaps[j - 1]! >= left; j -= 1) left = gaps[j - 1]!;
    let right = value;
    for (let j = at; j < gaps.length - 1 && gaps[j + 1]! >= right; j += 1) right = gaps[j + 1]!;
    return (left - value) + (right - value);
  });
  const mean = depth.reduce((sum, value) => sum + value, 0) / depth.length;
  const cut = mean + Math.sqrt(depth.reduce((sum, value) => sum + (value - mean) ** 2, 0) / depth.length);
  return depth.flatMap((value, at) => value > cut && (at === 0 || depth[at - 1]! <= value)
    && (at === depth.length - 1 || depth[at + 1]! < value) ? [at + 1] : []);
}

const compareAt = (left: readonly number[], right: readonly number[]) => {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return left.length - right.length;
};

const dateMs = (part: MemoryCandidate) => {
  const ms = Date.parse(part.date?.value ?? '');
  return Number.isFinite(ms) ? ms : 0;
};

/** A rating at least `WARM` times the best rating the read has seen:
 *  the measured test each decision below reads today. */
const warmAt = (rating: number | undefined, best: number) =>
  rating !== undefined && rating > 0 && rating >= WARM * best;

const bestOf = (ratings: Iterable<number | undefined>) => {
  let top: number | undefined;
  for (const rating of ratings) if (rating !== undefined && (top === undefined || rating > top)) top = rating;
  return top;
};

/** What the read knows when it decides whether a walk goes on from a
 *  part: the part's rating, the best rating the read has seen, and the
 *  best ratings among the parts it has rated two either side of the part
 *  in its session and in the rest of its topic segment. */
export interface WalkFacts {
  readonly rating: number | undefined;
  readonly best: number;
  /** Computed when called: a walk check runs for every part of every
   *  ring, so facts no rule reads cost nothing. */
  readonly neighbours: () => number | undefined;
  readonly segment: () => number | undefined;
}

/** What the read knows when it decides whether a topic segment opens:
 *  the best ratings of its rated person parts and of all its rated parts,
 *  the best rating the read has seen, and whether one of each search
 *  lane's top parts sits in it. */
export interface OpenFacts {
  readonly person: number | undefined;
  readonly rating: number | undefined;
  readonly best: number;
  readonly laneHead: boolean;
}

/** What the read knows after a request: each request's new parts'
 *  ratings and the best rating the read had seen when it ended (so the
 *  read's depth is their count), and whether selection keeps one of the
 *  parts read so far. */
export interface StopFacts {
  readonly requests: readonly { readonly ratings: readonly (number | undefined)[]; readonly best: number }[];
  readonly kept: boolean;
}

/** Whether a walk goes on from a part: rings around a warm person part,
 *  the next ring of a walk, and where a segment's walks start. Measured
 *  form: the part's own rating is warm. A part's neighbours and its
 *  segment predicted this better on held-out tasks, from fits on four
 *  tasks, so they are read here and not yet used. */
export function walksOn(facts: WalkFacts): boolean {
  return warmAt(facts.rating, facts.best);
}

/** Whether a topic segment opens. Measured form: it holds a warm person
 *  part, or one of each search lane's top parts. */
export function opens(facts: OpenFacts): boolean {
  return facts.laneHead || warmAt(facts.person, facts.best);
}

/** Whether the read stops after its last request. Measured form: the
 *  request added at most `FALL` times the most warm parts any earlier
 *  request added, each request's warm parts counted against the best
 *  rating when it ended; never before a warm part, and never before
 *  selection keeps a part (`kept`). Keeping itself is selection's
 *  decision: its bar, which pick hands the read as `kept`. */
export function stops(facts: StopFacts): boolean {
  const added = facts.requests.map(({ ratings, best }) => ratings.filter((rating) => warmAt(rating, best)).length);
  return added.some((count) => count > 0) && added.length > 1
    && added.at(-1)! <= FALL * Math.max(...added.slice(0, -1)) && facts.kept;
}

/** The read for coding-agent transcripts: the parts of chat sources
 *  scored with the agent question set. It reads the person's own parts
 *  in the keyword lanes' ranking, a request at a time, and rings of
 *  neighbours around each warm one: the reply first, then one more part
 *  on each side while the last ring held a warm part. When the person's
 *  parts run out it reads the rest of the order the same way, without
 *  rings. It stops when a request adds at most `FALL` times the most new
 *  warm parts any earlier request added, never before the first warm
 *  part or before it has kept a part. Then it opens the topic segments
 *  that hold a warm person part or one of each lane's top parts, rates
 *  each segment's starts, and walks out from every warm part of a
 *  segment while a ring holds a warm part, every walk advancing a ring a
 *  round. Warm means rated at least `WARM` times the best rating the
 *  read has seen so far. */
export async function chatRead(input: ChatReadInput): Promise<ChatReadResult> {
  const rules = { walksOn, opens, stops, ...input.rules };
  const { score, stopped } = input;
  if (stopped()) return { read: [], requests: 0, segments: 0, ended: 'stopped' };
  const members = new Set(input.parts);
  // Each transcript's parts in their order, and its topic segments.
  const transcripts = new Map<string, { part: MemoryCandidate; at: readonly number[] }[]>();
  for (const part of input.parts) {
    // A part with no place is a container of its own.
    const transcript = JSON.stringify([part.sourceId, part.place?.container ?? part.id]);
    const at = part.place?.at ?? [];
    const list = transcripts.get(transcript);
    if (list === undefined) transcripts.set(transcript, [{ part, at }]);
    else list.push({ part, at });
  }
  const where = new Map<MemoryCandidate, { readonly session: readonly MemoryCandidate[]; readonly at: number }>();
  const segmentOf = new Map<MemoryCandidate, readonly MemoryCandidate[]>();
  for (const list of transcripts.values()) {
    const session = list.sort((left, right) => compareAt(left.at, right.at)).map(({ part }) => part);
    session.forEach((part, at) => where.set(part, { session, at }));
    const cuts = session.length < TILE_MIN ? []
      : topicShifts(session.map((part) => /\S/.test(part.text) ? part.text : part.title));
    let from = 0;
    for (const to of [...cuts, session.length]) {
      const segment = session.slice(from, to);
      for (const part of segment) segmentOf.set(part, segment);
      from = to;
    }
  }
  // An order's parts, then every other part newest first.
  const listed = (order: readonly MemoryCandidate[]) => {
    const ranked = order.filter((part) => members.has(part));
    const held = new Set(ranked);
    return [...ranked, ...input.parts.filter((part) => !held.has(part))
      .sort((left, right) => dateMs(right) - dateMs(left))];
  };
  const ranked = input.order.filter((part) => members.has(part));
  const place = new Map(listed(input.order).map((part, index) => [part, index]));

  const seen = new Set<MemoryCandidate>();
  const read: MemoryCandidate[] = [];
  let best = 0;
  const rate = async (parts: Iterable<MemoryCandidate>) => {
    if (stopped()) return;
    const fresh = [...new Set(parts)].filter((part) => !seen.has(part));
    if (fresh.length === 0) return;
    for (const part of fresh) seen.add(part);
    await input.rate(fresh);
    // A stopping dial (a batch or time limit, a cancellation) that ended
    // the call during the request leaves the parts it never rated unread.
    const done = stopped() ? fresh.filter((part) => score(part) !== undefined) : fresh;
    read.push(...done);
    for (const part of done) best = Math.max(best, score(part) ?? 0);
  };
  const person = (part: MemoryCandidate) => part.author === 'person';
  const rated = (part: MemoryCandidate) => seen.has(part) ? score(part) : undefined;
  // A walk decision about a part, with the facts the read has about it.
  const walkable = (part: MemoryCandidate) => {
    const { session, at } = where.get(part)!;
    return rules.walksOn({ rating: score(part), best,
      neighbours: () => bestOf([session[at - 2], session[at - 1], session[at + 1], session[at + 2]]
        .map((next) => next === undefined ? undefined : rated(next))),
      segment: () => bestOf(segmentOf.get(part)!.map((next) => next === part ? undefined : rated(next))) });
  };

  // Each request's new parts' ratings and the best rating when it ended.
  const log: { ratings: (number | undefined)[]; best: number }[] = [];
  const request = async (batch: readonly MemoryCandidate[], rings: boolean) => {
    const before = read.length;
    await rate(batch);
    if (rings) {
      const reply = (part: MemoryCandidate) => {
        const { session, at } = where.get(part)!;
        return session[at + 1];
      };
      const warmPeople = batch.filter(walkable);
      await rate(warmPeople.flatMap((part) => reply(part) ?? []));
      let hot = warmPeople.filter((part) => {
        const next = reply(part);
        return next !== undefined && walkable(next);
      });
      for (let width = 2; hot.length > 0 && !stopped(); width += 1) {
        const ring = hot.map((part) => {
          const { session, at } = where.get(part)!;
          return [session[at - width + 1], session[at + width]]
            .filter((next): next is MemoryCandidate => next !== undefined && !seen.has(next));
        });
        await rate(ring.flat());
        hot = hot.filter((_, index) => ring[index]!.some(walkable));
      }
    }
    log.push({ ratings: read.slice(before).map(score), best });
  };

  let ended: ChatReadResult['ended'] = 'order';
  const people = listed(input.byKeyword).filter(person);
  const others = ranked.filter((part) => !person(part));
  for (const [parts, rings] of [[people, true], [others, false]] as const) {
    for (let at = 0; at < parts.length && ended === 'order'; at += STEP) {
      await request(parts.slice(at, at + STEP), rings);
      if (stopped()) ended = 'stopped';
      else if (rules.stops({ requests: log, kept: input.kept(read) })) ended = 'fall';
    }
  }
  const requests = log.length;
  if (ended === 'stopped') return { read, requests, segments: 0, ended };

  // The segments to open, in the order's ranking of their best part.
  const heads = new Set<readonly MemoryCandidate[]>();
  for (const lane of input.lanes) {
    for (const part of lane.slice(0, HEADS)) if (members.has(part)) heads.add(segmentOf.get(part)!);
  }
  const opened = [...new Set([...read.map((part) => segmentOf.get(part)!), ...heads])].filter((segment) => rules.opens({
    person: bestOf(segment.map((part) => person(part) ? rated(part) : undefined)),
    rating: bestOf(segment.map(rated)), best, laneHead: heads.has(segment) }));
  const first = (segment: readonly MemoryCandidate[]) =>
    segment.reduce((lowest, part) => Math.min(lowest, place.get(part)!), Number.POSITIVE_INFINITY);
  const segments = opened.sort((left, right) => first(left) - first(right));
  await rate(segments.flatMap((segment) =>
    [...segment].sort((left, right) => place.get(left)! - place.get(right)!).slice(0, STARTS)));
  // A walk from every warm part of every opened segment. The walks
  // advance together: each round rates the next ring of every walk
  // still open, so the rounds in a row are the longest walk's, not their
  // sum. A walk ends at the segment's edges or after a ring with no warm
  // part.
  let walks = segments.flatMap((segment) => segment.flatMap((part, at) =>
    seen.has(part) && walkable(part) ? [{ segment, at, width: 1 }] : []));
  while (walks.length > 0 && !stopped()) {
    const rings = walks.map(({ segment, at, width }) =>
      [segment[at - width], segment[at + width]].filter((part) => part !== undefined));
    await rate(rings.flat());
    walks = walks.flatMap((walk, index) =>
      rings[index]!.some(walkable) ? [{ ...walk, width: walk.width + 1 }] : []);
  }
  return { read, requests, segments: segments.length, ended: stopped() ? 'stopped' : ended };
}
