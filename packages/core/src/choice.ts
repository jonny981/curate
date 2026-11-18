import { DecisionServiceError, jevListRequest } from './models.js';
import type { PickItem, PickListAnswer, PickListDecide, PickListQuestion, PickListRequest } from './pick.js';

/** The most options one Choice may hold: the decision service's own
 *  limit. */
export const CHOICE_OPTIONS = 255;

/** The Choice asked once per needed fact, and its companion yes/no, which
 *  says whether any item fits at all: a Choice always picks one. The
 *  companion's `false` names the confusing case, as the model's maker
 *  advises. */
export const FACT_CHOICE = {
  question: (fact: string) => `Which item states this needed fact: ${fact}`,
  any: (fact: string) => `Does any item state this needed fact: ${fact}`,
  true: 'An item states the fact itself',
  false: 'The items share its subject, plan it, ask about it or report work toward it, without stating it',
} as const;

/** The question that says whether the parts picked so far suffice: asked
 *  of them alone, in their own request. */
export const ENOUGH_QUESTION = {
  question: 'Do these items together state everything the task asks?',
  true: 'Every fact the task asks for is stated in them',
  false: 'Some fact the task asks for is not stated in them',
} as const;

export interface ChoiceInput {
  readonly task: string;
  /** The facts the answer needs: one loop each. */
  readonly facts: readonly string[];
  /** Fields every request carries beside the task. */
  readonly header?: Pick<PickListRequest, 'needed' | 'person' | 'wanted'>;
  /** The items, each under its key, in the order a Choice's options go. */
  readonly items: readonly (readonly [string, PickItem])[];
  readonly list: PickListDecide;
  readonly signal: AbortSignal;
  /** A fact's loop ends once its companion answers under this. */
  readonly bar: number;
  /** The most characters a request's state plus its Choice may hold:
   *  the items are cut into consecutive windows that fit. */
  readonly maxChars: number;
  /** Send each Choice's options in the reverse order, the state
   *  unchanged: the maker's check for a lean toward the first option. */
  readonly reverseOptions?: boolean;
  /** After each round, ask whether the parts picked so far state
   *  everything the task asks; at or over this, every loop ends. */
  readonly enough?: number;
}

export interface ChoicePick {
  readonly key: string;
  readonly round: number;
  /** The Choice's probability for the pick. */
  readonly probability: number;
  /** The companion's answer in the request that picked it. */
  readonly any: number;
}

export interface ChoiceResult {
  readonly facts: readonly {
    readonly fact: string;
    readonly picks: readonly ChoicePick[];
    /** 'no' when the companion said no, 'empty' when no item was left,
     *  'enough' when the sufficiency question said the picks suffice. */
    readonly ended: 'no' | 'empty' | 'enough';
  }[];
  readonly rounds: number;
  readonly requests: number;
  /** The sufficiency question's answer after each round, when asked. */
  readonly enough?: readonly number[];
}

/** A request the service refused as too large: asked again in halves. */
const refusedForSize = (error: unknown) => error instanceof DecisionServiceError && (error.status === 400 || error.status === 413);

const answered = (answer: PickListAnswer | undefined, what: string) => {
  if (answer?.status !== 'answered') throw new Error(`The decision service gave no answer to ${what}.`);
  return answer;
};

/** A Choice per needed fact over the items, run as a loop: each request
 *  holds the items left in the state, their keys as the Choice's options
 *  with no descriptions, and the companion yes/no; the pick is removed
 *  and the Choice asked again until the companion falls under `bar` or
 *  no item is left. A list too long for one request is cut into
 *  consecutive windows that fit, each asked on its own; when more than
 *  one window's companion says yes, one more Choice among their picks
 *  decides, and a window that lost nothing is not asked again. The
 *  loops of every fact advance a round together. */
export async function choosePerFact(input: ChoiceInput): Promise<ChoiceResult> {
  const byKey = new Map(input.items);
  let requests = 0;
  const ask = (keys: readonly string[], questions: Record<string, PickListQuestion>) => {
    requests += 1;
    return input.list({ task: input.task, ...input.header, items: keys.map((key) => [key, byKey.get(key)!] as const), questions },
      input.signal);
  };
  const choice = (question: string, keys: readonly string[]): PickListQuestion =>
    ({ type: 'choice', question, options: input.reverseOptions === true ? [...keys].reverse() : [...keys] });
  // The request a window would send, measured as the service counts it.
  const fits = (keys: readonly string[], fact: string) => {
    if (keys.length > CHOICE_OPTIONS) return false;
    const body = jevListRequest({ task: input.task, ...input.header, items: keys.map((key) => [key, byKey.get(key)!] as const),
      questions: { pick: choice(FACT_CHOICE.question(fact), keys) } });
    return JSON.stringify(body.state).length + JSON.stringify(body.questions.pick).length <= input.maxChars;
  };
  const loops = input.facts.map((fact) => {
    // Consecutive windows that fit, cut once: a pick leaves its own window
    // only, so every other window's request is unchanged.
    const windows: string[][] = [];
    for (const [key] of input.items) {
      const last = windows.at(-1);
      if (last !== undefined && fits([...last, key], fact)) last.push(key);
      else windows.push([key]);
    }
    return { fact, windows, picks: [] as ChoicePick[], ended: undefined as ChoiceResult['facts'][number]['ended'] | undefined,
      asked: new Map<string, { key: string; probability: number; any: number }>() };
  });
  const top = (probabilities: Readonly<Record<string, number>>, keys: readonly string[]) =>
    keys.reduce((best, key) => (probabilities[key] ?? 0) > (probabilities[best] ?? 0) ? key : best);
  type Loop = (typeof loops)[number];
  type Found = { key: string; probability: number; any: number };
  // A window's pick and companion. A window the service refuses as too
  // large takes two places, its halves, and both are asked.
  const askWindow = async (loop: Loop, window: string[]): Promise<Found[]> => {
    const known = loop.asked.get(window.join('\n'));
    if (known !== undefined) return [known];
    let answers: Record<string, PickListAnswer>;
    try {
      answers = await ask(window, { pick: choice(FACT_CHOICE.question(loop.fact), window),
        any: { type: 'noul', question: FACT_CHOICE.any(loop.fact), trueCriterion: FACT_CHOICE.true, falseCriterion: FACT_CHOICE.false } });
    } catch (error) {
      if (!refusedForSize(error) || window.length < 2) throw error;
      const halves = [window.slice(0, Math.ceil(window.length / 2)), window.slice(Math.ceil(window.length / 2))];
      loop.windows.splice(loop.windows.indexOf(window), 1, ...halves);
      return (await Promise.all(halves.map((half) => askWindow(loop, half)))).flat();
    }
    const picked = answered(answers.pick, 'a Choice');
    const any = answered(answers.any, 'a companion question');
    if (!('probabilities' in picked) || !('probability' in any)) throw new Error('The decision service answered a list question in the wrong shape.');
    const key = top(picked.probabilities, window);
    const found = { key, probability: picked.probabilities[key]!, any: any.probability };
    loop.asked.set(window.join('\n'), found);
    return [found];
  };
  // One pick among several windows' picks; a set refused as too large is
  // decided in halves, and two parts too large to share a request go by
  // the companion and then the Choice in their own windows.
  const chooseAmong = async (loop: Loop, found: readonly Found[]): Promise<Found> => {
    if (found.length === 1) return found[0]!;
    const keys = found.map((result) => result.key);
    try {
      const answers = await ask(keys, { pick: choice(FACT_CHOICE.question(loop.fact), keys) });
      const picked = answered(answers.pick, 'a Choice');
      if (!('probabilities' in picked)) throw new Error('The decision service answered a list question in the wrong shape.');
      const key = top(picked.probabilities, keys);
      return { key, probability: picked.probabilities[key]!, any: Math.max(...found.map((result) => result.any)) };
    } catch (error) {
      if (!refusedForSize(error)) throw error;
      if (found.length === 2) return [...found].sort((left, right) => right.any - left.any || right.probability - left.probability)[0]!;
      const middle = Math.ceil(found.length / 2);
      return chooseAmong(loop, [await chooseAmong(loop, found.slice(0, middle)), await chooseAmong(loop, found.slice(middle))]);
    }
  };
  const enough: number[] = [];
  let rounds = 0;
  for (let round = 1; loops.some((loop) => loop.ended === undefined); round += 1) {
    rounds = round;
    await Promise.all(loops.filter((loop) => loop.ended === undefined).map(async (loop) => {
      const results = (await Promise.all(loop.windows.filter((window) => window.length > 0)
        .map((window) => askWindow(loop, window)))).flat();
      const yes = results.filter((result) => result.any >= input.bar);
      if (yes.length === 0) { loop.ended = 'no'; return; }
      const pick = await chooseAmong(loop, yes);
      loop.picks.push({ ...pick, round });
      for (const window of loop.windows) {
        const at = window.indexOf(pick.key);
        if (at >= 0) window.splice(at, 1);
      }
      if (loop.windows.every((window) => window.length === 0)) loop.ended = 'empty';
    }));
    if (input.enough !== undefined && loops.some((loop) => loop.ended === undefined)) {
      const picked = [...new Set(loops.flatMap((loop) => loop.picks.map((pick) => pick.key)))];
      const answers = await ask(picked, { enough: { type: 'noul', question: ENOUGH_QUESTION.question,
        trueCriterion: ENOUGH_QUESTION.true, falseCriterion: ENOUGH_QUESTION.false } });
      const said = answered(answers.enough, 'the sufficiency question');
      if (!('probability' in said)) throw new Error('The decision service answered a list question in the wrong shape.');
      enough.push(said.probability);
      if (said.probability >= input.enough) for (const loop of loops) loop.ended ??= 'enough';
    }
  }
  return { facts: loops.map(({ fact, picks, ended }) => ({ fact, picks, ended: ended! })), rounds, requests,
    ...(input.enough === undefined ? {} : { enough }) };
}
