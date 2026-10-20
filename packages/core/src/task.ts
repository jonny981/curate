import { LABEL_LANE_BAR } from './labels.js';

export type TaskKind = 'count' | 'date' | 'advice' | 'changed' | 'named' | 'other';

/** Classify only the task's words. A task can need more than one kind of answer. */
export function classifyTask(task: string): readonly TaskKind[] {
  const text = task.replace(/\s*\(asked .*\)\s*$/, '');
  const kinds: TaskKind[] = [];
  if (/\b(how many|how much|total|count|list|enumerate|every|all (?:the|my|of))\b/i.test(text)) kinds.push('count');
  if (/\b(when|how long|how (?:many|much) (?:days?|weeks?|months?|years?|time)|before|after|earlier|later|first|last|latest|oldest|newest|order|since|until|ago)\b/i.test(text)) kinds.push('date');
  if (/\b(advice|suggest\w*|recommend\w*|should|good idea|ideas?|what (?:can|could|would) (?:i|we)|help me (?:choose|pick|decide|plan))\b/i.test(text)) kinds.push('advice');
  if (/\b(now|current\w*|latest|updated?|changed?|instead|anymore|no longer|still|new (?:job|role|plan|habit))\b/i.test(text)) kinds.push('changed');
  const names = text.replace(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|I)\b/g, '');
  if (/(?<![\p{L}\p{N}])['"“‘][^'"”’]+['"”’](?![\p{L}\p{N}])|#[\p{L}\p{N}_]+/u.test(names)
    || /(?<![\p{L}\p{N}])\p{Lu}[\p{L}\p{N}_-]+/u.test(names.replace(/(?:^|[.!?]\s+)\S+/g, ''))) kinds.push('named');
  return kinds.length ? kinds : ['other'];
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
