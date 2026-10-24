import type { CurateOptions } from './curate.js';
import type {
  CandidateSourceKind, MemoryKind, PickCache, PickCascade, PickCriterion,
  PickLabels, PickLimits, PickOptions, PickTagSet, PickThresholds,
} from './pick.js';
import type { CandidateReadRequest } from './source.js';
import type { MeaningSearchOptions } from './meaning.js';

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
  'ranking', 'task', 'decide', 'questionsBySource', 'sourceKinds', 'labelKindsBySource',
  'keepTop', 'rankProtection', 'bestPartFirst', 'tags', 'tagsByKind',
  'labels', 'cache', 'route', 'everyRanked', 'everyScored', 'rare', 'rareBySource',
  'barBySource', 'ruleBarBySource', 'rulesEnumerationComplete', 'readsBySource', 'limits', 'thresholds', 'signal',
];
const THRESHOLD_KEYS: readonly (keyof PickThresholds)[] = ['linkedPathBar'];
const LIMIT_KEYS: readonly (keyof PickLimits)[] = [
  'maxPerBatch', 'maxBatchChars', 'maxBatches', 'maxCandidates',
  'maxElapsedMs', 'maxQuestionText',
];
const LABEL_KEYS: readonly (keyof PickLabels)[] = ['directory', 'deciderId', 'questionVersion'];
const CACHE_KEYS: readonly (keyof PickCache)[] = ['store', 'deciderId', 'questionVersion'];
const READ_REQUEST_KEYS: readonly (keyof CandidateReadRequest)[] = [
  'task', 'searchLines', 'searchPhrases', 'meaning', 'kindLanes', 'wholeLanes',
  'speakerOnly', 'phraseLane', 'topic', 'meaningLane', 'labelPool',
  'stripSearchInstructions', 'paths', 'exclude', 'revision', 'limit',
  'maxQuestionText', 'signal',
];
const MEANING_KEYS: readonly (keyof MeaningSearchOptions)[] = ['embed', 'nearest', 'wholeLanes'];
const CURATE_KEYS: readonly (keyof CurateOptions)[] = [
  'write', 'working', 'context', 'routeByTask', 'route', 'preferenceAdvice',
  'preferenceChange', 'taskDate', 'contextLimit', 'batchTokens', 'signal',
];
/** The fixed keys of the maps keyed by source kind — tagsByKind and
 *  the read request's kindLanes — and the values sourceKinds maps to. */
const SOURCE_KIND_KEYS: readonly CandidateSourceKind[] = ['chat', 'git-history', 'markdown'];
/** The fixed keys of `ranking`, keyed by candidate kind. */
const MEMORY_KIND_KEYS: readonly MemoryKind[] = ['knowledge', 'docs', 'rules', 'instructions'];
const CASCADE_KEYS: readonly (keyof PickCascade)[] = ['bias', 'questions', 'first', 'band', 'firstOnly'];
const TAG_SET_KEYS: readonly (keyof PickTagSet)[] = ['key', 'questions'];
const CRITERION_KEYS: readonly (keyof PickCriterion)[] = ['key', 'instructions', 'true', 'false'];
const CASCADE_QUESTION_KEYS: readonly (keyof PickCascade['questions'][number])[] = [
  ...CRITERION_KEYS, 'weight',
];
const FIRST_ONLY_KEYS: readonly (keyof NonNullable<PickCascade['firstOnly']>)[] = ['bias', 'weight'];

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
 *  fitted question's keys: an extra key beside the fitted fields would
 *  otherwise go unread. */
export function checkCascadeKeys(set: PickCascade | undefined, path: string): void {
  checkKeys(set, CASCADE_KEYS, path);
  checkKeys(set?.firstOnly, FIRST_ONLY_KEYS, `${path}.firstOnly`);
  for (const [index, question] of (set?.questions ?? []).entries()) {
    checkKeys(question, CASCADE_QUESTION_KEYS, `${path}.questions[${index}]`);
  }
}

/** A question set's values: unique, complete questions with finite
 *  weights, and first, band and firstOnly together or not at all. */
export function checkCascade(set: PickCascade | undefined): void {
  if (set === undefined) return;
  const keys = set.questions.map((q) => q.key);
  if (!Number.isFinite(set.bias) || !keys.length || new Set(keys).size !== keys.length
    || set.questions.some((q) => !q.key || !q.instructions || !q.true || !q.false || !Number.isFinite(q.weight))) {
    throw new TypeError('a question set needs unique questions and finite fitted weights.');
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
  checkKeys(options.everyScored, ['bar', 'bySize'], 'everyScored');
  checkKeys(options.rare, ['share', 'bar'], 'rare');
  for (const [id, enabled] of Object.entries(options.rareBySource ?? {})) {
    if (typeof enabled !== 'boolean') throw new TypeError(`rareBySource.${id} must be a boolean.`);
  }
  for (const [name, bars] of [['barBySource', options.barBySource], ['ruleBarBySource', options.ruleBarBySource]] as const) {
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

/** The same for the source-read request `pickFromSources` takes,
 *  before any source read. */
export function checkReadRequest(request: CandidateReadRequest): void {
  checkKeys(request, READ_REQUEST_KEYS, '');
  checkKeys(request.meaning, MEANING_KEYS, 'meaning');
  checkKeys(request.meaningLane, MEANING_KEYS, 'meaningLane');
  checkKeys(request.kindLanes, SOURCE_KIND_KEYS, 'kindLanes');
}

/** And for the curator's options, before any write call. */
export function checkCurateOptions(options: CurateOptions): void {
  checkKeys(options, CURATE_KEYS, '');
}
