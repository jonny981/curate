import { createHash } from 'node:crypto';

import { labelFileStore } from './labels.js';
import type { PickQuestion } from './pick.js';

export interface DecisionStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

/** One answer's store key: SHA-256 over the 'decision' namespace, the
 *  task text, the question-set version, the caller's deciderId, the
 *  rendered question (its wording and true and false criteria, and the
 *  fitted name and tag set it carries for a cascade or tag question),
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
      question.question, question.trueCriterion, question.falseCriterion,
      question.questionKey ?? null, question.tagSet ?? null,
      question.sourceId, question.id, question.title, question.role, question.kind ?? null,
      question.date === undefined ? null : [question.date.value, question.date.meaning],
      String(maxQuestionText), question.text, text,
    ]))
    .digest('hex');
}

/** A stored entry is `{ answer: { status: 'answered', probability } }`
 *  with a finite 0-to-1 probability — a refused, missing or errored
 *  answer is never stored, so a file holding one is corrupt. A
 *  missing, corrupt or wrong-shaped entry is a miss. */
export function storedDecision(
  value: unknown,
): { readonly status: 'answered'; readonly probability: number } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const answer = (value as { readonly answer?: unknown }).answer;
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) return undefined;
  const { status, probability } = answer as { readonly status?: unknown; readonly probability?: unknown };
  return status === 'answered' && typeof probability === 'number'
    && Number.isFinite(probability) && probability >= 0 && probability <= 1
    ? { status: 'answered', probability }
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
