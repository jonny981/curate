import type { CurateWrite } from './curate.js';
import { LABEL_LANE_BAR } from './labels.js';
import type { PickCriterion, PickOptions } from './pick.js';

export type TaskKind = 'count' | 'date' | 'advice' | 'named' | 'other';

/** Classify only the task's words. A task can need more than one kind of answer. */
export function classifyTask(task: string): readonly TaskKind[] {
  const text = task.replace(/\s*\(asked .*\)\s*$/, '');
  const kinds: TaskKind[] = [];
  if (/\b(how many|how much|total|count|list|enumerate|every|all (?:the|my|of))\b/i.test(text)) kinds.push('count');
  if (/\b(when|how long|how (?:many|much) (?:days?|weeks?|months?|years?|time)|before|after|earlier|later|first|last|latest|oldest|newest|order|since|until|ago)\b/i.test(text)) kinds.push('date');
  if (/\b(advice|suggest\w*|recommend\w*|should|good idea|ideas?|what (?:can|could|would) (?:i|we)|help me (?:choose|pick|decide|plan))\b/i.test(text)) kinds.push('advice');
  if (taskNames(text).length > 0) kinds.push('named');
  return kinds.length ? kinds : ['other'];
}

const MONTHS = 'January February March April May June July August September October November December Jan Feb Mar Apr Jun Jul Aug Sep Sept Oct Nov Dec';
const DAYS = 'Monday Tuesday Wednesday Thursday Friday Saturday Sunday Mon Tue Wed Thu Fri Sat Sun';
const WORDS = 'I I\'m I\'ve I\'d I\'ll How What Which Who Whom Whose Where When Why Can Could Would Should Do Does Did Is Are Was Were Have Has Had Any Some The A An My Your Please Hey Hi OK';
/** Capitalised words that never start or join a name. */
const NOT_NAMES = new Set(`${MONTHS} ${DAYS} ${WORDS}`.split(' '));
/** Abbreviations whose full stop stays inside a name. */
const ABBREVIATIONS = new Set(['Dr', 'St', 'Mr', 'Mrs', 'Ms', 'Jr', 'Sr', 'Mt']);
const upper = (word: string) => /^\p{Uppercase}/u.test(word);
const alphanumeric = (word: string) => /^[\p{L}\p{N}]/u.test(word);

/** The people and things the task names, found with code and no
 *  model, in the order they appear: quoted titles, hashtags, and runs
 *  of capitalised words that do not start a sentence. A run of two or
 *  more capitalised words counts even at the start of a sentence.
 *  Month and day names, "I" and question words are never names; "Dr."
 *  and "St." stay inside a name, a trailing "'s" is dropped, and an
 *  "(asked …)" suffix is ignored. A capitalised word that names
 *  nothing specific, such as "Korean", is listed too. */
export function taskNames(task: string): string[] {
  const found: string[] = [];
  const take = (_match: string, name: string) => { found.push(name); return ' , '; };
  const text = task.replace(/\s*\(asked .*\)\s*$/, '')
    .replace(/(?<![\p{L}\p{N}_])['"‘“](.+?)['"’”](?![\p{L}\p{N}_])/gu, take)
    .replace(/(#[\p{L}\p{N}_]+)/gu, take);
  const run: string[] = [];
  let start = true;
  const close = () => {
    while (run.length > 0 && /^\p{Nd}/u.test(run[run.length - 1]!)) run.pop();
    if (run.length > 0) found.push(run.join(' ').replace(/['’]s$/, ''));
    run.length = 0;
  };
  const tokens = text.match(/[\p{L}\p{N}_'’&-]+\.?|[^\p{L}\p{N}_\s]/gu) ?? [];
  for (const [index, token] of tokens.entries()) {
    const stop = token.endsWith('.') && !ABBREVIATIONS.has(token.slice(0, -1));
    const word = stop ? token.slice(0, -1) : token;
    const next = tokens[index + 1] ?? '';
    const capital = upper(word) && !NOT_NAMES.has(word.replace(/\.+$/, ''));
    if (!alphanumeric(word)) {
      close();
      start = '?!'.includes(word);
    } else if (capital && (!start || run.length > 0 || (upper(next) && !NOT_NAMES.has(next.replace(/\.+$/, ''))))) {
      run.push(word);
    } else if (/^\p{Nd}/u.test(word) && run.length > 0) {
      run.push(word);
    } else {
      close();
    }
    if (alphanumeric(word)) start = false;
    if (stop) { close(); start = true; }
  }
  close();
  return [...new Set(found)];
}

/** The curator options a route answer can switch on. */
export type RouteOption = 'working' | 'preferenceAdvice' | 'preferenceChange';

/** The four yes/no route questions asked of the task itself when
 *  `route: 'jev'` is on: what answering the question needs, asked once
 *  per pick through the decide port. The wording is the question set's
 *  own: `question` asks it of the task, `trueCriterion` and
 *  `falseCriterion` are the answer criteria. */
export const ROUTE_QUESTIONS = [
  { key: 'count',
    question: 'Does this question need a count or a complete list across sessions?',
    trueCriterion: 'Answering it takes counting or listing instances from more than one session.',
    falseCriterion: 'It does not ask for a count or a list across sessions.' },
  { key: 'date',
    question: 'Does this question need a date, a duration or an order of events?',
    trueCriterion: 'Answering it takes a date, a duration or the order of events.',
    falseCriterion: 'It does not ask about when, how long or in what order.' },
  { key: 'taste',
    question: 'Does this question need the user\'s stated tastes or wants?',
    trueCriterion: 'The user\'s stated tastes, wants or limits shape the answer.',
    falseCriterion: 'The user\'s tastes do not shape the answer.' },
  { key: 'latest',
    question: 'Does this question need the latest or current value of something?',
    trueCriterion: 'The answer is the most recent value or state; an earlier one is out of date.',
    falseCriterion: 'It does not ask for a latest or current value.' },
] as const;

export type RouteKey = (typeof ROUTE_QUESTIONS)[number]['key'];

/** The kinds of answer a task can need, asked of the task itself when
 *  `answerTypes` is on: one yes/no question each, all in one decide
 *  request per pick. `phrase` names the type in the curator's hint
 *  line (`answerHint`); `question` asks it of the task, `trueCriterion`
 *  and `falseCriterion` are the answer criteria. */
export const ANSWER_TYPES = [
  { key: 'date', phrase: 'a date',
    question: 'Is the answer a point in time?',
    trueCriterion: 'The answer names when something happened or will happen: a calendar date, a day of the week, a month, a year or a time of day.',
    falseCriterion: 'The answer is not a point in time.' },
  { key: 'duration', phrase: 'a length of time',
    question: 'Is the answer a length of time?',
    trueCriterion: 'The answer is how long something lasted or took, or how much time passed between two events or since an event (days, weeks, months, years).',
    falseCriterion: 'The answer is not a length of time.' },
  { key: 'order', phrase: 'the order of events',
    question: 'Does the answer depend on the order of two or more events?',
    trueCriterion: 'The question asks which happened first, last, before or after, or asks for events in sequence.',
    falseCriterion: 'The question does not ask about the order of events.' },
  { key: 'number', phrase: 'a number',
    question: 'Is the answer a number?',
    trueCriterion: 'The answer is a number: a quantity, a count, an amount of money, a measurement, an age, a score or a percentage.',
    falseCriterion: 'The answer is not a number.' },
  { key: 'entity', phrase: 'a specific name',
    question: 'Is the answer a specific named thing?',
    trueCriterion: 'The answer is a particular person, place, product, brand, organisation, pet, or title of a book, film, show or song.',
    falseCriterion: 'The answer is not a particular named person, place, product or title.' },
  { key: 'yesno', phrase: 'a yes or no',
    question: 'Can the question be answered with yes or no?',
    trueCriterion: 'The question asks whether something is true, happened or holds, so a yes or a no answers it.',
    falseCriterion: 'A yes or a no does not answer the question.' },
  { key: 'list', phrase: 'a full count or list',
    question: 'Does the answer need every instance of something gathered?',
    trueCriterion: 'The answer is a count of items or events, or a complete list of them, so every instance must be found.',
    falseCriterion: 'The answer does not need instances counted or listed.' },
  { key: 'advice', phrase: 'a recommendation',
    question: 'Does the question ask for a recommendation, a suggestion or an opinion?',
    trueCriterion: 'The user asks what they should do, choose, try or think, rather than asking for a fact from their past.',
    falseCriterion: 'The user asks for a fact, not for a recommendation or an opinion.' },
  { key: 'preference', phrase: 'the user\'s own tastes',
    question: 'Does the answer depend on the user\'s own preferences?',
    trueCriterion: 'The user\'s stated likes, dislikes, tastes, wants or limits shape what a good answer is.',
    falseCriterion: 'The user\'s preferences do not shape the answer.' },
  { key: 'latest', phrase: 'the latest value',
    question: 'Does the question ask for the current or most recent value of something that can change?',
    trueCriterion: 'The answer is the most recent value or state of something that may have changed over time; an earlier value would be out of date.',
    falseCriterion: 'The question does not ask for a current or latest value.' },
] as const;

export type AnswerType = (typeof ANSWER_TYPES)[number]['key'];

/** A typed question for count and list tasks: does the part report one
 *  actual instance of what the task counts? It has no fitted weight, so
 *  it acts only through `keepAt`: a part answered 0.5 or more is kept
 *  whatever its score. Add it to a set's `typed` questions with
 *  `answerTypes` on. */
export const COUNT_MARKER = {
  answerType: 'list',
  key: 'instance',
  instructions: 'Does this part report at least one actual instance of the thing the task counts or lists? A total, a question, a suggestion, a hypothetical, or the assistant repeating something is not a new instance.',
  true: 'It reports at least one actual instance',
  false: 'It reports no actual instance',
  weight: 0,
  keepAt: 0.5,
} as const;

/** The instructions `taskQuestionWriter` sends with the task. */
export const TASK_QUESTION_PROMPT = 'Write 2 to 4 narrow yes/no questions for a decision model reading one part of a history (a chat message, a commit or a note), with its date, for the task below. Any part holding one piece of the evidence should get true on at least one question; merely sharing a topic should get false. Name the concrete thing the task asks about. For counts ask about one instance; for time ask about dates or durations; for advice ask about the user\'s own preferences and limits; for assistant content ask about what the assistant said. Do not guess an answer. Return only a JSON array of objects with string fields instructions, true, false. Answer from the task text only. Do not run any command and do not read any file.';

/** A `writeQuestions` option built from the same `write` function the
 *  curator uses: it sends `TASK_QUESTION_PROMPT` with the task, reads
 *  the JSON array in the reply and keys its questions `task1` onward.
 *  The pick checks the count and the fields. */
export function taskQuestionWriter(write: CurateWrite): NonNullable<PickOptions['writeQuestions']> {
  return async (task, signal) => {
    const reply = await write({ instructions: TASK_QUESTION_PROMPT, body: `TASK:\n${task}` },
      signal ?? new AbortController().signal);
    const list: unknown = JSON.parse(reply.slice(reply.indexOf('['), reply.lastIndexOf(']') + 1));
    if (!Array.isArray(list)) throw new TypeError('the task question reply holds no JSON array.');
    return list.map((q: PickCriterion, index) => ({
      key: `task${index + 1}`, instructions: q?.instructions, true: q?.true, false: q?.false,
    }));
  };
}

/** The curator options each route answer switches on: a stated taste
 *  needs both preference lines; a count, a date or a latest value
 *  needs worked notes, which carry each fact's date so the curator
 *  can order the changes and pick the newest. */
export const ROUTE_OPTIONS: Readonly<Record<RouteKey, readonly RouteOption[]>> = {
  count: ['working'],
  date: ['working'],
  taste: ['preferenceAdvice', 'preferenceChange'],
  latest: ['working'],
};

/** The curator options a route answer set switches on at the shared
 *  label bar: each route question answered at LABEL_LANE_BAR or more
 *  adds its options. A missing or refused answer adds nothing. */
export function routeOptions(answers: Readonly<Partial<Record<RouteKey, number>>>): RouteOption[] {
  return [...new Set(ROUTE_QUESTIONS.flatMap((route) =>
    (answers[route.key] ?? 0) >= LABEL_LANE_BAR ? ROUTE_OPTIONS[route.key] : []))];
}
