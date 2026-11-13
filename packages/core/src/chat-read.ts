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

/** A chat part's transcript and its place in it: the chat reader's part
 *  id ends in the line, block and piece after the transcript's path. A
 *  part whose id ends otherwise is a transcript of its own. */
function placeOf(part: MemoryCandidate): { readonly transcript: string; readonly at: readonly number[] } {
  const fields = part.id.split(':');
  const tail = fields.slice(-3);
  return fields.length > 3 && tail.every((field) => /^\d+$/.test(field))
    ? { transcript: JSON.stringify([part.sourceId, fields.slice(0, -3).join(':')]), at: tail.map(Number) }
    : { transcript: JSON.stringify([part.sourceId, part.id]), at: [] };
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
  const { score, stopped } = input;
  if (stopped()) return { read: [], requests: 0, segments: 0, ended: 'stopped' };
  const members = new Set(input.parts);
  // Each transcript's parts in their order, and its topic segments.
  const transcripts = new Map<string, { part: MemoryCandidate; at: readonly number[] }[]>();
  for (const part of input.parts) {
    const { transcript, at } = placeOf(part);
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
    for (const part of fresh) { seen.add(part); read.push(part); }
    await input.rate(fresh);
    for (const part of fresh) best = Math.max(best, score(part) ?? 0);
  };
  const warm = (part: MemoryCandidate) => {
    const value = score(part);
    return value !== undefined && value > 0 && value >= WARM * best;
  };
  const person = (part: MemoryCandidate) => part.chat?.author === 'person';

  // New warm parts per request; the stop compares the last with the most before it.
  const added: number[] = [];
  const fell = () => added.some((count) => count > 0) && added.length > 1
    && added.at(-1)! <= FALL * Math.max(...added.slice(0, -1)) && input.kept(read);
  const request = async (batch: readonly MemoryCandidate[], rings: boolean) => {
    const before = read.length;
    await rate(batch);
    if (rings) {
      const reply = (part: MemoryCandidate) => {
        const { session, at } = where.get(part)!;
        return session[at + 1];
      };
      const warmPeople = batch.filter(warm);
      await rate(warmPeople.flatMap((part) => reply(part) ?? []));
      let hot = warmPeople.filter((part) => {
        const next = reply(part);
        return next !== undefined && warm(next);
      });
      for (let width = 2; hot.length > 0 && !stopped(); width += 1) {
        const ring = hot.map((part) => {
          const { session, at } = where.get(part)!;
          return [session[at - width + 1], session[at + width]]
            .filter((next): next is MemoryCandidate => next !== undefined && !seen.has(next));
        });
        await rate(ring.flat());
        hot = hot.filter((_, index) => ring[index]!.some(warm));
      }
    }
    added.push(read.slice(before).filter(warm).length);
  };

  let ended: ChatReadResult['ended'] = 'order';
  const people = listed(input.byKeyword).filter(person);
  const others = ranked.filter((part) => !person(part));
  for (const [parts, rings] of [[people, true], [others, false]] as const) {
    for (let at = 0; at < parts.length && ended === 'order'; at += STEP) {
      await request(parts.slice(at, at + STEP), rings);
      if (stopped()) ended = 'stopped';
      else if (fell()) ended = 'fall';
    }
  }
  const requests = added.length;
  if (ended === 'stopped') return { read, requests, segments: 0, ended };

  // The segments to open, in the order's ranking of their best part.
  const opened = new Set<readonly MemoryCandidate[]>();
  for (const part of read) if (person(part) && warm(part)) opened.add(segmentOf.get(part)!);
  for (const lane of input.lanes) {
    for (const part of lane.slice(0, HEADS)) if (members.has(part)) opened.add(segmentOf.get(part)!);
  }
  const first = (segment: readonly MemoryCandidate[]) =>
    segment.reduce((lowest, part) => Math.min(lowest, place.get(part)!), Number.POSITIVE_INFINITY);
  const segments = [...opened].sort((left, right) => first(left) - first(right));
  await rate(segments.flatMap((segment) =>
    [...segment].sort((left, right) => place.get(left)! - place.get(right)!).slice(0, STARTS)));
  // A walk from every warm part of every opened segment. The walks
  // advance together: each round rates the next ring of every walk
  // still open, so the rounds in a row are the longest walk's, not their
  // sum. A walk ends at the segment's edges or after a ring with no warm
  // part.
  let walks = segments.flatMap((segment) => segment.flatMap((part, at) =>
    seen.has(part) && warm(part) ? [{ segment, at, width: 1 }] : []));
  while (walks.length > 0 && !stopped()) {
    const rings = walks.map(({ segment, at, width }) =>
      [segment[at - width], segment[at + width]].filter((part) => part !== undefined));
    await rate(rings.flat());
    walks = walks.flatMap((walk, index) =>
      rings[index]!.some(warm) ? [{ ...walk, width: walk.width + 1 }] : []);
  }
  return { read, requests, segments: segments.length, ended: stopped() ? 'stopped' : ended };
}
