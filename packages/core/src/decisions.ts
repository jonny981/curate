import { createHash } from 'node:crypto';

import { labelFileStore } from './labels.js';
import type { PickQuestion } from './pick.js';

export interface DecisionStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

/** One answer's store key: SHA-256 over the 'decision' namespace, the
 *  task text, the question-set version, the caller's deciderId, the
 *  rendered question (its wording, its true and false criteria —
 *  plus its levels and anonymity when the question carries them,
 *  so an ordinary noul question's key is the one already stored —
 *  and the fitted name and tag set it carries
 *  for a cascade or tag question),
 *  and every field of the part the decider receives: its source id,
 *  id, title, role, kind and date, the text cut applied, the text the
 *  decider sees and the part's full text. A changed task, version,
 *  deciderId, question, source, id, title, role, kind, date, cut or
 *  text names a different answer, even when the change sits past the
 *  cut; an unchanged part's key is the same in every batch, so an
 *  answer is reused across batches. The request `key` is not hashed
 *  on its own: it is built from the part's source id and id and the
 *  spec key, each already in the key — a fitted or tag spec key rides
 *  in `questionKey`, a plain one's role in `role`. */
export function decisionKey(
  task: string,
  questionVersion: string,
  deciderId: string,
  maxQuestionText: number,
  question: PickQuestion,
  text: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([
      'decision', task, questionVersion, deciderId,
      question.question, question.trueCriterion ?? null, question.falseCriterion ?? null,
      // A levelled or anonymous question's fields hash only when it
      // carries them: the array a plain question builds is unchanged.
      ...(question.levels === undefined && question.anonymous === undefined ? []
        : [question.levels ?? null, question.anonymous ?? null]),
      question.questionKey ?? null, question.tagSet ?? null,
      question.sourceId, question.id, question.title, question.role, question.kind ?? null,
      question.date === undefined ? null : [question.date.value, question.date.meaning],
      String(maxQuestionText), question.text, text,
    ]))
    .digest('hex');
}

/** A levelled question's answer distribution, as a decider returns
 *  it: `length` numbers — one per level, each from 0 to 1 — that add
 *  to one. */
export function levelDistribution(value: unknown, length?: number): value is number[] {
  return Array.isArray(value) && value.length >= 2
    && (length === undefined || value.length === length)
    && value.every((p) => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1)
    && Math.abs(value.reduce<number>((sum, p) => sum + p, 0) - 1) <= 0.01;
}

/** A stored entry is `{ answer: { status: 'answered', probability } }`
 *  with a finite 0-to-1 probability, or `{ answer: { status:
 *  'answered', probabilities } }` with a valid level distribution for
 *  a levelled question — a refused, missing or errored answer is never
 *  stored, so a file holding one is corrupt — plus the `truncated`
 *  flag when the stored answer carried one. An entry holding both
 *  answer shapes is corrupt. A missing, corrupt or wrong-shaped entry
 *  is a miss. */
export function storedDecision(
  value: unknown,
):
  | { readonly status: 'answered'; readonly probability: number; readonly truncated?: boolean }
  | { readonly status: 'answered'; readonly probabilities: readonly number[]; readonly truncated?: boolean }
  | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const answer = (value as { readonly answer?: unknown }).answer;
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) return undefined;
  const { status, probability, probabilities, truncated } = answer as {
    readonly status?: unknown; readonly probability?: unknown;
    readonly probabilities?: unknown; readonly truncated?: unknown };
  const cut = truncated === true ? { truncated: true as const } : {};
  if (status !== 'answered' || (probability !== undefined && probabilities !== undefined)) return undefined;
  if (probabilities !== undefined) {
    return levelDistribution(probabilities)
      ? { status: 'answered', probabilities: [...probabilities], ...cut }
      : undefined;
  }
  return typeof probability === 'number'
    && Number.isFinite(probability) && probability >= 0 && probability <= 1
    ? { status: 'answered', probability, ...cut }
    : undefined;
}

/** The plain-file store: `<key>.json` under the directory, one file per
 *  answer, written to a temporary file and renamed into place so a
 *  reader never sees a half-written entry. Every failed read is a
 *  miss — a missing, corrupt or unreadable file answers nothing. */
export function decisionFileStore(directory: string): DecisionStore {
  const store = labelFileStore(directory);
  return {
    get: async (key) => {
      try {
        return await store.get(key);
      } catch {
        return undefined;
      }
    },
    set: store.set,
  };
}
