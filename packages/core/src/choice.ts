import { DecisionServiceError, jevListRequest } from './models.js';
import type { PickCascade, PickItem, PickListAnswer, PickListDecide, PickListQuestion, PickListRequest } from './pick.js';

/** The most options one Choice may hold: the decision service's own
 *  limit. */
export const CHOICE_OPTIONS = 255;

/** The Choice asked once per needed fact, built to the decision model's
 *  maker's large-choice recipe: the task in the state, and each
 *  candidate's text written into its own option ("Put the top twenty in
 *  one `Choice` question, with their long plots as the options"). */
export const FACT_CHOICE = {
  question: (fact: string) => `Which of these items states this needed fact: ${fact}`,
} as const;

/** How many candidates a Choice per needed fact weighs by default: the
 *  maker's large-choice recipe puts its top twenty in one Choice, and says
 *  a Choice holds "only about forty when each option is a long plot
 *  summary". A recipe value, not a measured best. */
export const CHOICE_CANDIDATES = 20;

/** The narrow question without its "or", in two: whether an item
 *  answers the task, and, once per needed fact (`facts` in a question
 *  set), whether it states that fact. Each is one judgment, worded as
 *  the labels mean it, "answers" rather than "relevant", and its `false`
 *  names the confusing case. */
export const ANSWER_QUESTION = {
  key: 'answers',
  instructions: 'Does this item answer the task?',
  true: 'It states the answer to the task itself',
  false: 'It describes work toward the answer, a plan, or a question about it, without stating the result',
} as const;
export const FACT_QUESTION = {
  key: 'fact',
  instructions: 'Does this item state this needed fact: {fact}',
  true: 'It states the fact itself',
  false: 'It is about the same subject, a plan or a step toward it, without stating the fact',
} as const;

/** The narrow question in two as a question set a mode can keep by:
 *  its score is the "answers" probability itself (weight 1, no bias),
 *  the wording measured to calibrate, and the needed-fact question is
 *  asked once per fact beside it at weight 0, so its answers are
 *  recorded and screen a Choice per needed fact without moving the
 *  score. No weight is fitted. */
export const ANSWER_CASCADE: PickCascade = {
  bias: 0,
  questions: [{ ...ANSWER_QUESTION, weight: 1 }],
  facts: { question: FACT_QUESTION, highest: 0 },
};

/** What a part is doing with the task's subject: a Choice per item, each
 *  option a concrete situation, as the decision model's maker advises. */
export const ROLE_QUESTION = {
  question: 'What does this item do with the subject of the task?',
  options: [
    ['decision', 'It states a decision, result or fact about the subject as settled'],
    ['proposal', 'It proposes or plans something about the subject that is not yet settled'],
    ['step', 'It reports a step of the work on the subject while the work is going on'],
    ['question', 'It asks about the subject'],
    ['approval', 'It agrees to or approves what came before it'],
    ['repeat', 'It repeats or quotes something said earlier'],
    ['tool', 'It is the output of a tool or a command'],
    ['mention', 'It only mentions the subject in passing'],
  ],
} as const satisfies { readonly question: string; readonly options: readonly (readonly [string, string])[] };

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
  /** Every candidate, each under its key. */
  readonly items: readonly (readonly [string, PickItem])[];
  /** Each fact's candidates, as keys of `items`, in the order a Choice's
   *  options go: the screen, best first. */
  readonly candidates: readonly (readonly string[])[];
  readonly list: PickListDecide;
  readonly signal: AbortSignal;
  /** The most characters a request's state plus its Choice may hold: a
   *  fact's candidates are cut into consecutive windows that fit. */
  readonly maxChars: number;
  /** Send each Choice's options in the reverse order: the maker's check
   *  for a lean toward the first option. */
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
}

export interface ChoiceResult {
  readonly facts: readonly {
    readonly fact: string;
    readonly picks: readonly ChoicePick[];
    /** Every candidate of the fact: the picks in the order picked, then
     *  the rest by the probability the last Choice they were in gave them. */
    readonly ranked: readonly { readonly key: string; readonly probability: number }[];
    /** 'empty' when no candidate was left, 'enough' when the sufficiency
     *  question said the picks suffice. */
    readonly ended: 'empty' | 'enough';
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

/** A Choice per needed fact over its candidates, run as a loop: each
 *  request holds the task in its state and one Choice whose options are
 *  the candidates left, each option's description the candidate's text;
 *  the pick is removed and the Choice asked again until the sufficiency
 *  question, asked after each round of the picks so far, says they
 *  suffice, or no candidate is left. Candidates too long for one request
 *  are cut into consecutive windows that fit, each asked on its own, with
 *  one more Choice among the windows' picks; a window that lost nothing
 *  is not asked again, and a window the service refuses as too large is
 *  asked again in halves. The loops of every fact advance a round
 *  together. */
export async function choosePerFact(input: ChoiceInput): Promise<ChoiceResult> {
  const byKey = new Map(input.items);
  let requests = 0;
  const ask = (keys: readonly string[], questions: Record<string, PickListQuestion>) => {
    requests += 1;
    return input.list({ task: input.task, ...input.header, items: keys.map((key) => [key, byKey.get(key)!] as const), questions },
      input.signal);
  };
  const choice = (fact: string, keys: readonly string[]): PickListQuestion => ({ type: 'choice', described: true,
    question: FACT_CHOICE.question(fact), options: input.reverseOptions === true ? [...keys].reverse() : [...keys] });
  // The request a window would send, measured as the service counts it.
  const fits = (keys: readonly string[], fact: string) => {
    if (keys.length > CHOICE_OPTIONS) return false;
    const body = jevListRequest({ task: input.task, ...input.header, items: keys.map((key) => [key, byKey.get(key)!] as const),
      questions: { pick: choice(fact, keys) } });
    return JSON.stringify(body.state).length + JSON.stringify(body.questions.pick).length <= input.maxChars;
  };
  const loops = input.facts.map((fact, index) => {
    // Consecutive windows that fit, cut once: a pick leaves its own window
    // only, so every other window's request is unchanged.
    const windows: string[][] = [];
    for (const key of input.candidates[index] ?? []) {
      const last = windows.at(-1);
      if (last !== undefined && fits([...last, key], fact)) last.push(key);
      else windows.push([key]);
    }
    return { fact, windows, picks: [] as ChoicePick[], ended: (windows.length === 0 ? 'empty' : undefined) as ChoiceResult['facts'][number]['ended'] | undefined,
      asked: new Map<string, Found>(), last: new Map<string, number>() };
  });
  type Found = { key: string; probability: number };
  type Loop = (typeof loops)[number];
  const top = (probabilities: Readonly<Record<string, number>>, keys: readonly string[]) =>
    keys.reduce((best, key) => (probabilities[key] ?? 0) > (probabilities[best] ?? 0) ? key : best);
  // A Choice's answer: its pick, with every option's probability kept.
  const read = (loop: Loop, answers: Record<string, PickListAnswer>, keys: readonly string[]): Found => {
    const picked = answered(answers.pick, 'a Choice');
    if (!('probabilities' in picked)) throw new Error('The decision service answered a list question in the wrong shape.');
    for (const key of keys) loop.last.set(key, picked.probabilities[key] ?? 0);
    const key = top(picked.probabilities, keys);
    return { key, probability: picked.probabilities[key]! };
  };
  // A window's pick. A window the service refuses as too large takes two
  // places, its halves, and both are asked.
  const askWindow = async (loop: Loop, window: string[]): Promise<Found[]> => {
    const known = loop.asked.get(window.join('\n'));
    if (known !== undefined) return [known];
    let answers: Record<string, PickListAnswer>;
    try {
      answers = await ask(window, { pick: choice(loop.fact, window) });
    } catch (error) {
      if (!refusedForSize(error) || window.length < 2) throw error;
      const halves = [window.slice(0, Math.ceil(window.length / 2)), window.slice(Math.ceil(window.length / 2))];
      loop.windows.splice(loop.windows.indexOf(window), 1, ...halves);
      return (await Promise.all(halves.map((half) => askWindow(loop, half)))).flat();
    }
    const found = read(loop, answers, window);
    loop.asked.set(window.join('\n'), found);
    return [found];
  };
  // One pick among several windows' picks; a set refused as too large is
  // decided in halves, and two too large to share a request go by their
  // own windows' probabilities.
  const chooseAmong = async (loop: Loop, found: readonly Found[]): Promise<Found> => {
    if (found.length === 1) return found[0]!;
    const keys = found.map((result) => result.key);
    try {
      const answers = await ask(keys, { pick: choice(loop.fact, keys) });
      const picked = answered(answers.pick, 'a Choice');
      if (!('probabilities' in picked)) throw new Error('The decision service answered a list question in the wrong shape.');
      const key = top(picked.probabilities, keys);
      return { key, probability: picked.probabilities[key]! };
    } catch (error) {
      if (!refusedForSize(error)) throw error;
      if (found.length === 2) return [...found].sort((left, right) => right.probability - left.probability)[0]!;
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
      const pick = await chooseAmong(loop, results);
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
  return { rounds, requests, ...(input.enough === undefined ? {} : { enough }),
    facts: loops.map(({ fact, picks, ended, last }) => {
      const taken = new Set(picks.map((pick) => pick.key));
      return { fact, picks, ended: ended!, ranked: [...picks.map(({ key, probability }) => ({ key, probability })),
        ...[...last].filter(([key]) => !taken.has(key)).sort((left, right) => right[1] - left[1])
          .map(([key, probability]) => ({ key, probability }))] };
    }) };
}
