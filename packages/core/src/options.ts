import type { CurateLowOptions, CurateNoneOptions, CurateOptions } from './curate.js';
import type {
  CandidateSourceKind, MemoryKind, PickCache, PickCascade, PickCriterion,
  PickLabels, PickLimits, PickOptions, PickScoreCriterion, PickTagSet, PickThresholds,
} from './pick.js';
import type { CandidateReadRequest } from './source.js';
import type { MeaningSearchOptions } from './meaning.js';
import { ANSWER_TYPES, taskNames } from './task.js';

/** Option names the levers change renamed, in one place: each old
 *  dotted path a caller could still pass names the option that took
 *  its place. */
const RENAMED_OPTIONS: Readonly<Record<string, string>> = {
  pick: '`everyRanked` or `rare`',
  'thresholds.reference': '`everyScored`',
  'thresholds.referenceBySize': '`everyScored.bySize`',
  laneCut: '`wholeLanes`',
  'meaning.laneCut': '`meaning.wholeLanes`',
};

const PICK_OPTION_KEYS: readonly (keyof PickOptions)[] = [
  'ranking', 'task', 'decide', 'questionsBySource', 'sourceKinds', 'labelKindsBySource', 'labelBarBySource',
  'keepTop', 'rankProtection', 'bestPartFirst', 'tags', 'tagsByKind',
  'labels', 'cache', 'route', 'answerTypes', 'writeQuestions', 'findNames', 'everyRanked', 'everyScored', 'rare', 'rareBySource',
  'thoroughness', 'feed',
  'barBySource', 'ruleBarBySource', 'rulesEnumerationComplete', 'readsBySource', 'limits', 'thresholds',
  'taskDate', 'timeZone', 'taskPeriod', 'signal',
];
const THRESHOLD_KEYS: readonly (keyof PickThresholds)[] = ['linkedPathBar'];
const LIMIT_KEYS: readonly (keyof PickLimits)[] = [
  'maxPerBatch', 'maxBatchChars', 'maxBatches', 'maxCandidates',
  'maxElapsedMs', 'maxQuestionText', 'maxInFlight',
];
const LABEL_KEYS: readonly (keyof PickLabels)[] = ['directory', 'deciderId', 'questionVersion'];
const CACHE_KEYS: readonly (keyof PickCache)[] = ['store', 'deciderId', 'questionVersion'];
const READ_REQUEST_KEYS: readonly (keyof CandidateReadRequest)[] = [
  'task', 'searchLines', 'searchPhrases', 'meaning', 'kindLanes', 'wholeLanes',
  'speakerOnly', 'phraseLane', 'topic', 'meaningLane', 'meaningPositions', 'keptBodiesOnly', 'labelPool',
  'stripSearchInstructions', 'paths', 'exclude', 'revision', 'limit',
  'maxQuestionText', 'taskDate', 'timeZone', 'asOf', 'taskPeriod', 'decayHalfLife', 'decayLimit', 'signal',
];
const MEANING_KEYS: readonly (keyof MeaningSearchOptions)[] = ['embed', 'nearest', 'wholeLanes'];
const CURATE_KEYS: readonly (keyof CurateOptions | keyof CurateLowOptions | keyof CurateNoneOptions)[] = [
  'write', 'working', 'context', 'routeByTask', 'route', 'preferenceAdvice',
  'preferenceChange', 'taskDate', 'answerHint', 'contextLimit', 'batchTokens', 'weightBands',
  'compression', 'decide', 'answerTokens', 'signal',
];
/** The fixed keys of the maps keyed by source kind — tagsByKind and
 *  the read request's kindLanes — and the values sourceKinds maps to. */
const SOURCE_KIND_KEYS: readonly CandidateSourceKind[] = ['chat', 'git-history', 'markdown'];
/** The fixed keys of `ranking`, keyed by candidate kind. */
const MEMORY_KIND_KEYS: readonly MemoryKind[] = ['knowledge', 'docs', 'rules', 'instructions'];
const CASCADE_KEYS: readonly (keyof PickCascade)[] = [
  'bias', 'questions', 'typed', 'first', 'band', 'firstOnly', 'written', 'named', 'model', 'anonymousItems',
];
const TAG_SET_KEYS: readonly (keyof PickTagSet)[] = ['key', 'questions'];
const CRITERION_KEYS: readonly (keyof PickCriterion)[] = ['key', 'instructions', 'true', 'false'];
const MODEL_KEYS: readonly (keyof NonNullable<PickCascade['model']>)[] = [
  'keys', 'mu', 'sd', 'w', 'b', 'bar', 'provenance',
];
const CASCADE_QUESTION_KEYS: readonly string[] = [
  ...CRITERION_KEYS, 'levels', 'weight',
];
const TYPED_QUESTION_KEYS: readonly (keyof NonNullable<PickCascade['typed']>[number])[] = [
  ...CRITERION_KEYS, 'weight', 'answerType', 'keepAt',
];
const FIRST_ONLY_KEYS: readonly (keyof NonNullable<PickCascade['firstOnly']>)[] = ['bias', 'weight'];
const WRITTEN_KEYS: readonly (keyof NonNullable<PickCascade['written']>)[] = ['highest', 'second'];
const NAMED_KEYS: readonly (keyof NonNullable<PickCascade['named']>)[] = ['question', 'highest', 'hasNames'];
/** The keys Curate gives the written questions, in order. */
export const WRITTEN_QUESTION_KEYS = ['task1', 'task2', 'task3', 'task4'] as const;

/** Reject one key the object does not declare, naming its dotted path.
 *  A renamed key names the option that replaced it; any other lists
 *  the keys the level allows. A non-object value is left to that
 *  option's own checks, where it has them. */
function checkKeys(value: unknown, allowed: readonly string[], path: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    const full = path === '' ? key : `${path}.${key}`;
    const renamed = RENAMED_OPTIONS[full];
    if (renamed !== undefined) {
      throw new TypeError(`\`${full}\` is not an option; use ${renamed} (see the README's Levers section)`);
    }
    throw new TypeError(`\`${full}\` is not an option; allowed keys are ${allowed.map((name) => `\`${name}\``).join(', ')}`);
  }
}

/** One question set's own keys, then its firstOnly weights and each
 *  fitted and typed question's keys: an extra key beside the fitted
 *  fields would otherwise go unread. */
export function checkCascadeKeys(set: PickCascade | undefined, path: string): void {
  checkKeys(set, CASCADE_KEYS, path);
  checkKeys(set?.model, MODEL_KEYS, `${path}.model`);
  checkKeys(set?.firstOnly, FIRST_ONLY_KEYS, `${path}.firstOnly`);
  checkKeys(set?.written, WRITTEN_KEYS, `${path}.written`);
  checkKeys(set?.named, NAMED_KEYS, `${path}.named`);
  checkKeys(set?.named?.question, CRITERION_KEYS, `${path}.named.question`);
  for (const [index, question] of (set?.questions ?? []).entries()) {
    checkKeys(question, CASCADE_QUESTION_KEYS, `${path}.questions[${index}]`);
  }
  for (const [index, question] of (set?.typed ?? []).entries()) {
    checkKeys(question, TYPED_QUESTION_KEYS, `${path}.typed[${index}]`);
  }
}

/** A question set's values: unique, complete questions with finite
 *  weights, typed questions whose keys no other question in the set
 *  shares, whose answer type is one of ANSWER_TYPES and whose keepAt is
 *  between 0 and 1, first, band and firstOnly together or not at all,
 *  finite written weights beside keys that leave `task1` to `task4`
 *  free, and a complete name question with finite weights whose key,
 *  followed by a number, is no other question's key. A model-scored
 *  set follows a different shape: a complete fitted model, questions
 *  that each carry true and false or at least two ordered levels, no
 *  per-question weights needed, and none of the first, band, firstOnly,
 *  typed, written or named machinery. */
export function checkCascade(set: PickCascade | undefined): void {
  if (set === undefined) return;
  if (set.anonymousItems !== undefined && typeof set.anonymousItems !== 'boolean') {
    throw new TypeError('a question set\'s anonymousItems must be a boolean.');
  }
  const keys = set.questions.map((q) => q.key);
  const levelled = (q: PickCascade['questions'][number]): q is PickScoreCriterion & { readonly weight?: number } =>
    'levels' in q && q.levels !== undefined;
  if (set.model !== undefined) {
    const model = set.model;
    const complete = typeof model === 'object' && model !== null
      && Array.isArray(model.keys) && model.keys.length > 0
      && model.keys.every((key) => typeof key === 'string' && key !== '')
      && [model.mu, model.sd, model.w].every((list) => Array.isArray(list)
        && list.length === model.keys.length && list.every((value) => typeof value === 'number' && Number.isFinite(value)))
      && typeof model.b === 'number' && Number.isFinite(model.b)
      && typeof model.bar === 'number' && Number.isFinite(model.bar) && model.bar >= 0 && model.bar <= 1;
    if (!complete) {
      throw new TypeError('a model question set needs fitted weights: keys with mu, sd and w arrays '
        + 'of the same nonzero length, a finite b, and a bar from 0 to 1.');
    }
    if (set.first !== undefined || set.band !== undefined || set.firstOnly !== undefined
      || set.typed !== undefined || set.written !== undefined || set.named !== undefined) {
      throw new TypeError('a model question set selects through its weights alone: '
        + 'it cannot carry first, band, firstOnly, typed, written or named.');
    }
    const nouled = (q: PickCascade['questions'][number]) =>
      'true' in q && 'false' in q && q.true !== undefined && q.false !== undefined;
    if (!keys.length || new Set(keys).size !== keys.length
      || set.questions.some((q) => !q.key || !q.instructions || levelled(q) === nouled(q)
        || (levelled(q) && (q.levels.length < 2
          || q.levels.some((level) => typeof level !== 'string' || !level.trim()))))) {
      throw new TypeError('a model question set needs unique questions, each with true and false '
        + 'or at least two ordered levels.');
    }
    return;
  }
  if (!Number.isFinite(set.bias) || !keys.length || new Set(keys).size !== keys.length
    || set.questions.some((q) => !q.key || !q.instructions || levelled(q)
      || !('true' in q) || !('false' in q) || !q.true || !q.false || !Number.isFinite(q.weight))) {
    throw new TypeError('a question set needs unique questions and finite fitted weights.');
  }
  if (set.typed !== undefined) {
    const all = Array.isArray(set.typed) ? [...keys, ...set.typed.map((q) => q.key)] : [];
    if (!Array.isArray(set.typed) || new Set(all).size !== all.length
      || set.typed.some((q) => !q.key || !q.instructions || !q.true || !q.false || !Number.isFinite(q.weight)
        || !ANSWER_TYPES.some((type) => type.key === q.answerType))) {
      throw new TypeError('a question set\'s typed questions need keys unique across questions and typed, '
        + 'finite weights and a known answerType.');
    }
    if (set.typed.some((q) => q.keepAt !== undefined
      && (typeof q.keepAt !== 'number' || !Number.isFinite(q.keepAt) || q.keepAt < 0 || q.keepAt > 1))) {
      throw new TypeError('a typed question\'s keepAt must be a number between 0 and 1.');
    }
  }
  if (set.written !== undefined) {
    const all = [...keys, ...(set.typed ?? []).map((q) => q.key)];
    if (typeof set.written !== 'object' || set.written === null
      || !Number.isFinite(set.written.highest) || !Number.isFinite(set.written.second)
      || all.some((key) => (WRITTEN_QUESTION_KEYS as readonly string[]).includes(key))) {
      throw new TypeError('a question set\'s written weights must be finite, and its own question keys '
        + 'cannot be task1 to task4.');
    }
  }
  if (set.named !== undefined) {
    const named: Partial<NonNullable<PickCascade['named']>> =
      typeof set.named === 'object' && set.named !== null ? set.named : {};
    const question = named.question;
    const all = [...keys, ...(set.typed ?? []).map((q) => q.key), ...(set.written === undefined ? [] : WRITTEN_QUESTION_KEYS)];
    if (typeof question !== 'object' || question === null
      || [question.key, question.instructions, question.true, question.false].some((text) => typeof text !== 'string' || !text.trim())
      || !Number.isFinite(named.highest) || !Number.isFinite(named.hasNames)
      || all.some((key) => key.startsWith(question.key) && /^\d+$/.test(key.slice(question.key.length)))) {
      throw new TypeError('a question set\'s named question needs a key, instructions, true and false, finite highest '
        + 'and hasNames weights, and a key that, followed by a number, is no other question\'s key.');
    }
  }
  if (set.first !== undefined || set.band !== undefined || set.firstOnly !== undefined) {
    if (!keys.includes(set.first!) || !set.band || set.band.length !== 2
      || set.band.some((p) => !Number.isFinite(p) || p < 0 || p > 1)
      || set.band[0] > set.band[1] || !set.firstOnly
      || !Number.isFinite(set.firstOnly.bias) || !Number.isFinite(set.firstOnly.weight)) {
      throw new TypeError('a question set\'s first, band and firstOnly must be supplied together with valid weights.');
    }
  }
}

/** One tag set's own keys, then each question's. */
function checkTagSetKeys(set: PickTagSet | undefined, path: string): void {
  checkKeys(set, TAG_SET_KEYS, path);
  for (const [index, question] of (set?.questions ?? []).entries()) {
    checkKeys(question, CRITERION_KEYS, `${path}.questions[${index}]`);
  }
}

/** Reject an unknown key in the pick's options, a nested settings
 *  object or a fixed-key map, before any decide call. A kind-keyed map
 *  is looked up by a source's or candidate's own kind, so a mistyped
 *  key would sit unread while the pick fell back to the plain setting:
 *  its keys are the declared kinds. `sourceKinds` is keyed by caller
 *  source id, so its values are checked the same way instead. */
export function checkPickOptions(options: PickOptions): void {
  checkKeys(options, PICK_OPTION_KEYS, '');
  checkKeys(options.thresholds, THRESHOLD_KEYS, 'thresholds');
  checkKeys(options.limits, LIMIT_KEYS, 'limits');
  checkKeys(options.labels, LABEL_KEYS, 'labels');
  for (const [id, kinds] of Object.entries(options.labelKindsBySource ?? {})) {
    if (!Array.isArray(kinds) || kinds.some((kind) =>
      !kind || [kind.key, kind.name, kind.part?.true, kind.part?.false]
        .some((value) => typeof value !== 'string' || !value.trim()))) {
      throw new TypeError(`labelKindsBySource.${id} needs kinds with nonblank key, name and part criteria.`);
    }
    if (new Set(kinds.map((kind) => kind.key)).size !== kinds.length) {
      throw new TypeError(`labelKindsBySource.${id} needs unique kind keys.`);
    }
  }
  checkKeys(options.cache, CACHE_KEYS, 'cache');
  checkKeys(options.everyRanked, ['c'], 'everyRanked');
  if (options.thoroughness !== undefined) {
    if (options.thoroughness !== 'quick' && options.thoroughness !== 'normal' && options.thoroughness !== 'deep') {
      throw new TypeError(`thoroughness must be 'quick', 'normal' or 'deep'.`);
    }
    // The dials name two different feeds and are never combined.
    if (options.everyRanked !== undefined) {
      throw new TypeError('everyRanked and thoroughness cannot both be set; thoroughness applies only when everyRanked is not given.');
    }
  }
  if (options.feed !== undefined) {
    checkKeys(options.feed, ['order', 'size'], 'feed');
    if (options.feed === null || typeof options.feed !== 'object' || options.feed.order !== 'combsum') {
      throw new TypeError("feed.order must be 'combsum'.");
    }
    if (options.feed.size !== undefined && (!Number.isSafeInteger(options.feed.size) || options.feed.size < 1)) {
      throw new TypeError('feed.size must be a positive integer.');
    }
    if (options.everyRanked !== undefined) {
      throw new TypeError('feed and everyRanked cannot both be set; feed orders the feed a thoroughness level bounds.');
    }
  }
  checkKeys(options.everyScored, ['bar', 'bySize'], 'everyScored');
  checkKeys(options.rare, ['share', 'bar'], 'rare');
  checkKeys(options.answerTypes, ['bar'], 'answerTypes');
  if (options.taskPeriod !== undefined && typeof options.taskPeriod !== 'boolean') {
    throw new TypeError('taskPeriod must be a boolean.');
  }
  for (const [id, enabled] of Object.entries(options.rareBySource ?? {})) {
    if (typeof enabled !== 'boolean') throw new TypeError(`rareBySource.${id} must be a boolean.`);
  }
  for (const [name, bars] of [['labelBarBySource', options.labelBarBySource], ['barBySource', options.barBySource],
    ['ruleBarBySource', options.ruleBarBySource]] as const) {
    for (const [id, bar] of Object.entries(bars ?? {})) {
      if (typeof bar !== 'number' || !Number.isFinite(bar) || bar < 0 || bar > 1) {
        throw new TypeError(`${name}.${id} must be a number between 0 and 1.`);
      }
    }
  }
  checkKeys(options.ranking, MEMORY_KIND_KEYS, 'ranking');
  checkKeys(options.tagsByKind, SOURCE_KIND_KEYS, 'tagsByKind');
  for (const [id, set] of Object.entries(options.questionsBySource ?? {})) {
    checkCascadeKeys(set, `questionsBySource.${id}`);
    // A typed question is asked only when the task needs its answer
    // type, so with answerTypes off it would sit unread.
    if ((set?.typed?.length ?? 0) > 0 && (options.answerTypes === undefined || options.answerTypes === false)) {
      throw new TypeError(`${id}'s questions include typed questions, which are asked only when answerTypes is on.`);
    }
    // Written weights were fitted with the written terms in the score,
    // so the score without them would be wrong.
    if (set?.written !== undefined && options.writeQuestions === undefined) {
      throw new TypeError(`${id}'s questions weigh written questions, which need writeQuestions.`);
    }
  }
  if (options.writeQuestions !== undefined && typeof options.writeQuestions !== 'function') {
    throw new TypeError('writeQuestions must be a function.');
  }
  if (options.findNames !== undefined && typeof options.findNames !== 'function') {
    throw new TypeError('findNames must be a function.');
  }
  for (const [index, set] of (options.tags ?? []).entries()) {
    checkTagSetKeys(set, `tags[${index}]`);
  }
  for (const [kind, sets] of Object.entries(options.tagsByKind ?? {})) {
    for (const [index, set] of (sets ?? []).entries()) {
      checkTagSetKeys(set, `tagsByKind.${kind}[${index}]`);
    }
  }
  for (const [id, kind] of Object.entries(options.sourceKinds ?? {})) {
    if (kind !== undefined && !SOURCE_KIND_KEYS.includes(kind)) {
      throw new TypeError(`\`sourceKinds.${id}\` names a kind that is not 'chat', 'git-history' or 'markdown'.`);
    }
  }
}

/** A writer no source's set weighs would be paid for and never read.
 *  Run once every source's set is known. */
export function checkWriteQuestions(options: PickOptions): void {
  if (options.writeQuestions !== undefined
    && !Object.values(options.questionsBySource ?? {}).some((set) => set?.written !== undefined)) {
    throw new TypeError('writeQuestions is set, but no source\'s question set has written weights.');
  }
}

/** The names the task names: what the caller's `findNames` returns,
 *  or `taskNames` without one. Names are trimmed, and blank and
 *  repeated names are dropped. */
export async function findTaskNames(
  options: PickOptions,
): Promise<{ readonly found: readonly string[]; readonly by: 'code' | 'caller' }> {
  if (options.findNames === undefined) return { found: taskNames(options.task), by: 'code' };
  let returned: unknown;
  try {
    returned = await options.findNames(options.task);
  } catch (error) {
    throw new Error(`findNames failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!Array.isArray(returned) || returned.some((name) => typeof name !== 'string')) {
    throw new TypeError('findNames must return an array of strings.');
  }
  return { found: [...new Set((returned as string[]).map((name) => name.trim()).filter(Boolean))], by: 'caller' };
}

/** The same for the source-read request `pickFromSources` takes,
 *  before any source read. */
export function checkReadRequest(request: CandidateReadRequest): void {
  checkKeys(request, READ_REQUEST_KEYS, '');
  checkKeys(request.meaning, MEANING_KEYS, 'meaning');
  checkKeys(request.meaningLane, MEANING_KEYS, 'meaningLane');
  checkKeys(request.kindLanes, SOURCE_KIND_KEYS, 'kindLanes');
}

/** And for the curator's options, before any write call. */
export function checkCurateOptions(options: CurateOptions | CurateLowOptions | CurateNoneOptions): void {
  checkKeys(options, CURATE_KEYS, '');
}

/** And for the compression setting, before any source read or call:
 *  'high', 'low' or 'none'; `decide` only with 'low', which needs it;
 *  `answerTokens` only with 'none'; under 'low', none of the options
 *  only the log reads; and under 'none', no model function and none of
 *  the options only a curator reads. */
export function checkCompression(options: CurateOptions | CurateLowOptions | CurateNoneOptions): void {
  const compression: unknown = options.compression;
  if (compression !== undefined && compression !== 'high' && compression !== 'low' && compression !== 'none') {
    throw new TypeError("curate: compression must be 'high', 'low' or 'none'.");
  }
  if (options.compression === 'none') {
    const given = options as Partial<Record<keyof CurateOptions | 'decide', unknown>>;
    const unsupported = [
      ...(['working', 'context', 'routeByTask', 'preferenceAdvice', 'preferenceChange', 'answerHint'] as const)
        .filter((key) => given[key] === true),
      ...(['write', 'decide', 'route', 'contextLimit', 'batchTokens', 'weightBands', 'taskDate'] as const)
        .filter((key) => given[key] !== undefined),
    ];
    if (unsupported.length) {
      throw new TypeError(`curate: compression: 'none' only lays out the selected items, so it cannot take ${unsupported.join(', ')}.`);
    }
    if (options.answerTokens !== undefined && (!Number.isInteger(options.answerTokens) || options.answerTokens <= 0)) {
      throw new TypeError('curate: answerTokens must be a positive integer of estimated tokens.');
    }
    return;
  }
  if ((options as { readonly answerTokens?: unknown }).answerTokens !== undefined) {
    throw new TypeError("curate: answerTokens is read only with compression: 'none'.");
  }
  if (options.compression !== 'low') {
    if ('decide' in options && options.decide !== undefined) {
      throw new TypeError("curate: decide is read only with compression: 'low'.");
    }
    return;
  }
  const given = options as Partial<Record<keyof CurateOptions, unknown>>;
  const unsupported = [
    ...(['working', 'context', 'routeByTask', 'preferenceAdvice', 'preferenceChange'] as const)
      .filter((key) => given[key] === true),
    ...(['route', 'contextLimit', 'batchTokens', 'weightBands'] as const).filter((key) => given[key] !== undefined),
  ];
  if (unsupported.length) {
    throw new TypeError(`curate: compression: 'low' writes no dated log, so it cannot take ${unsupported.join(', ')}.`);
  }
  if (typeof options.decide !== 'function') {
    throw new TypeError("curate: compression: 'low' needs decide, the decision function that asks whether each row counts.");
  }
}
