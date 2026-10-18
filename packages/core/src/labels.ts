import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { MemoryCandidate } from './pick.js';

/** The question-set version mixed into every label store key and the
 *  record; it changes when the kind questions change. */
export const LABEL_QUESTION_VERSION = 'memory-kind-labels-1';

/** One shared bar for the question's needs and a part's labels: a kind
 *  the question needs at 0.5 or more puts every part labelled 0.5 or
 *  more on that kind in the label lane. The bar is a dial to fit, not a
 *  measured best. */
export const LABEL_LANE_BAR = 0.5;

/** The seven fixed kinds of statement the label gate asks of every part
 *  and every question. Matching is by kind, not by shared words, so a
 *  part labelled once serves questions it shares no words with. The
 *  wording is the question set's own: `question` asks it of an item the
 *  batch names, `true` and `false` are the answer criteria. */
export const LABEL_KINDS = [
  { key: 'personal', name: 'a personal fact about the user',
    part: { true: 'The excerpt states a fact about the user themself: their age, job, family members, where they live, their health or body, or another lasting personal detail.',
            false: 'The excerpt states no lasting personal fact about the user; it is advice, general information, or about other people or things only.' } },
  { key: 'owns', name: 'something the user owns or uses',
    part: { true: 'The excerpt says the user has, owns, uses or relies on a specific object, device, tool, vehicle, pet, account or piece of equipment.',
            false: 'The excerpt names nothing the user owns or uses.' } },
  { key: 'acquired', name: 'a purchase, gift or arrival of something',
    part: { true: 'The excerpt says the user bought, ordered, received, was given, picked up or got something new, or that something arrived for them.',
            false: 'The excerpt reports no purchase, gift, order or arrival for the user.' } },
  { key: 'event', name: 'an event, trip or plan with a time',
    part: { true: 'The excerpt describes something the user did, attended, travelled to or plans to do, at a stated or implied time.',
            false: 'The excerpt describes no dated or timed event, trip or plan of the user.' } },
  { key: 'preference', name: 'a stated preference or taste',
    part: { true: 'The excerpt states what the user likes, dislikes, prefers, enjoys, wants or values.',
            false: 'The excerpt states no preference, taste or want of the user.' } },
  { key: 'habit', name: 'a habit or routine and how often',
    part: { true: 'The excerpt says the user regularly does something, or how often they do it (daily, twice a week, every morning).',
            false: 'The excerpt states no habit, routine or frequency for the user.' } },
  { key: 'decision', name: 'a decision or change of mind',
    part: { true: 'The excerpt says the user decided, chose, switched, changed their mind, stopped or started something.',
            false: 'The excerpt reports no decision or change by the user.' } },
] as const;

export type LabelKindKey = (typeof LABEL_KINDS)[number]['key'];

/** The question a part answers for one kind. The item the excerpt is
 *  is the batch's own item, named the way the caller's decide call
 *  names its items. */
export function labelPartQuestion(kind: (typeof LABEL_KINDS)[number]) {
  return {
    question: `Does this excerpt contain ${kind.name}?`,
    trueCriterion: kind.part.true,
    falseCriterion: kind.part.false,
  };
}

/** The question the pick's task answers for one kind. */
export function labelTaskQuestion(kind: (typeof LABEL_KINDS)[number]) {
  const name = kind.name[0]!.toUpperCase() + kind.name.slice(1);
  return {
    question: `Would a statement that contains ${kind.name} help answer this question?`,
    trueCriterion: `Knowing ${kind.name} from the user's past conversations could supply part of the answer.`,
    falseCriterion: `${name} would not help answer this question.`,
  };
}

/** The task text a part-label batch carries: the question set's own
 *  framing, so the decider sees the ask the way the set was written. */
export const LABEL_PARTS_TASK
  = 'Label short excerpts from a user\'s past chats with an assistant. Each question names one item.';

/** The task text the question-label batch carries. */
export function labelQuestionTask(task: string): string {
  return `QUESTION the user asked: ${task}`;
}

/** A part's store key, and a question's: SHA-256 over the labels
 *  namespace, the question-set version, the caller's deciderId and the
 *  text the labels describe. The question's key adds its own namespace
 *  so a task that equals a part's text can never share its entry. */
export function labelKey(version: string, deciderId: string, text: string, of: 'part' | 'question' = 'part'): string {
  return createHash('sha256')
    .update(JSON.stringify([of === 'part' ? 'labels' : 'labels-question', version, deciderId, text]))
    .digest('hex');
}

export interface LabelStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

/** The plain-file store: `<key>.json` under the directory, one file per
 *  labelled item, written to a temporary file and renamed into place so
 *  a reader never sees a half-written entry. A missing file or contents
 *  that fail to parse is a miss; any other read failure throws, or a
 *  flooded disk or permissions problem would relabel every part on
 *  every pick while looking like ordinary misses. */
export function labelFileStore(directory: string): LabelStore {
  return {
    get: async (key) => {
      try {
        return JSON.parse(await readFile(join(directory, `${key}.json`), 'utf8')) as unknown;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
          return undefined;
        }
        throw error;
      }
    },
    set: async (key, value) => {
      await mkdir(directory, { recursive: true });
      const file = join(directory, `${key}.json`);
      const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(value));
        await rename(temporary, file);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
    },
  };
}

export type PartLabels = Readonly<Record<LabelKindKey, number>>;

/** A stored entry is `{ labels: { <kind>: probability } }` with a
 *  finite 0-to-1 probability for every kind — a refused, missing or
 *  errored answer is never stored, so a file holding one is corrupt.
 *  A missing, corrupt or wrong-shaped entry is a miss. */
export function storedLabels(value: unknown): PartLabels | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const labels = (value as { readonly labels?: unknown }).labels;
  if (typeof labels !== 'object' || labels === null || Array.isArray(labels)) return undefined;
  const entries = labels as Record<string, unknown>;
  if (!LABEL_KINDS.every((kind) => {
    const probability = entries[kind.key];
    return typeof probability === 'number' && Number.isFinite(probability)
      && probability >= 0 && probability <= 1;
  })) return undefined;
  return Object.fromEntries(LABEL_KINDS.map((kind) => [kind.key, entries[kind.key]])) as PartLabels;
}

/** Reciprocal-rank fusion of the keyword order and the label order, as
 *  the label gate orders what the decide step sees. Positions are read
 *  over the pick's whole ranked order — a buried part keeps its buried
 *  position — not over the gated subset alone. The label order sorts
 *  in-lane parts by their needed-kind probability first; the rest follow
 *  by that probability, then keyword position. Returns the gated
 *  candidates in fused order. */
export function fuseLabelLane(
  gated: readonly MemoryCandidate[],
  order: readonly MemoryCandidate[],
  inLane: ReadonlySet<MemoryCandidate>,
  labelStrength: (candidate: MemoryCandidate) => number,
): MemoryCandidate[] {
  const keywordPosition = new Map(order.map((candidate, index) => [candidate, index + 1]));
  const labelOrder = [...order].sort((left, right) =>
    Number(inLane.has(right)) - Number(inLane.has(left))
    || labelStrength(right) - labelStrength(left)
    || keywordPosition.get(left)! - keywordPosition.get(right)!);
  const labelPosition = new Map(labelOrder.map((candidate, index) => [candidate, index + 1]));
  const fusion = (candidate: MemoryCandidate) =>
    1 / (60 + labelPosition.get(candidate)!) + 1 / (60 + keywordPosition.get(candidate)!);
  return [...gated].sort((left, right) =>
    fusion(right) - fusion(left)
    || keywordPosition.get(left)! - keywordPosition.get(right)!);
}
