import { LABEL_LANE_BAR, type MemoryCandidate, type PickAnswer, type PickDecide, type PickQuestion } from '@curatejs/core';
import { taskMoment, timeZoneOf, zonedIso } from '@curatejs/core/internal';
import { markdownSource, type MarkdownOptions } from './markdown.js';

export interface NoteProposal {
  /** The note's file, as the parts' `contentRef` names it: an absolute path. */
  readonly path: string;
  readonly action: 'retire' | 'promote';
  /** The parts whose answers made the proposal, with the decision model's probability for each. */
  readonly parts: readonly { readonly id: string; readonly probability: number }[];
  readonly date?: MemoryCandidate['date'];
  /** For 'retire': the one front-matter line that marks the note, which the reader already ranks lower. */
  readonly edit?: string;
}

/** What one review read and asked. */
export interface ReviewRecord {
  /** The moment the review judged from, as an ISO date-time in `timeZone`: the task date, or now when none was given. */
  readonly asOf: string;
  readonly timeZone: string;
  /** The answer at or above which a question counted as yes. */
  readonly bar: number;
  /** `decide.deciderId`, or 'custom' when it has none. */
  readonly deciderId: string;
  /** The notes and parts the read gave. */
  readonly notes: number;
  readonly parts: number;
  /** The questions sent to `decide`. */
  readonly questions: number;
  /** Each question a stop, a failed batch or a reply without a probability left unanswered. */
  readonly unanswered: readonly {
    readonly id: string;
    readonly question: 'stale' | 'lasting';
    readonly reason: 'cancelled' | 'refused' | 'missing' | 'error';
    readonly detail?: string;
  }[];
  /** Why the paths held no notes to read, when they held none. */
  readonly absent?: string;
}

/** Questions per decide call: pick's default `maxPerBatch`. */
const BATCH = 150;

const QUESTIONS = {
  stale: {
    question: (day: string) => `As of ${day}, does this part describe something that is no longer true, no longer done, `
      + 'or replaced by a later decision?',
    trueCriterion: 'It describes a past state, a finished plan or something since replaced.',
    falseCriterion: 'It still describes how things are.',
  },
  lasting: {
    question: (day: string) => `As of ${day}, does this part state a lasting rule, decision or fact that people rely on `
      + 'beyond one event?',
    trueCriterion: 'It states a rule, decision or fact that holds beyond one event.',
    falseCriterion: 'It records one event, a plan or a passing remark.',
  },
} as const;

type Which = keyof typeof QUESTIONS;
const keyOf = (id: string, which: Which) => JSON.stringify([id, which]);
const line = (part: MemoryCandidate) => Number(/#L(\d+)/.exec(part.contentRef ?? '')?.[1] ?? 0);

/**
 * Ask the decision model which notes look retired and which parts look
 * like lasting rules, and return proposals. It reads what `markdown()`
 * reads with the same options and asks each part two questions through
 * the decide port: `stale` and `lasting`. A note gets a 'retire'
 * proposal when every part answers `stale` at or above the bar, and a
 * 'promote' proposal when any part answers `lasting` at or above it. A
 * note already marked replaced is not asked `stale`, and a rules source
 * is not asked `lasting`. It never edits a file.
 */
export async function reviewNotes(options: MarkdownOptions & {
  readonly decide: PickDecide;
  readonly taskDate?: string;
  readonly timeZone?: string;
  /** The answer at or above which a question counts as yes. Default 0.5. */
  readonly bar?: number;
  readonly signal?: AbortSignal;
}): Promise<{ readonly proposals: readonly NoteProposal[]; readonly record: ReviewRecord }> {
  const { decide, taskDate, timeZone, bar = LABEL_LANE_BAR, signal, ...markdownOptions } = options;
  if (typeof decide !== 'function') throw new TypeError('decide must be a function.');
  if (typeof bar !== 'number' || !Number.isFinite(bar) || bar < 0 || bar > 1) {
    throw new TypeError('bar must be a number from 0 to 1.');
  }
  const zone = timeZoneOf(timeZone);
  const asOf = zonedIso(taskMoment(taskDate, zone), zone);
  const day = asOf.slice(0, 10);
  const base = { asOf, timeZone: zone, bar, deciderId: decide.deciderId ?? 'custom' };
  // A read with no task keeps every part whole, in the reader's own order.
  const read = await markdownSource(markdownOptions).read({ task: '', wholeLanes: true, ...(signal === undefined ? {} : { signal }) });
  if (read.status === 'absent') {
    return { proposals: [], record: { ...base, notes: 0, parts: 0, questions: 0, unanswered: [], absent: read.reason } };
  }

  const notes = new Map<string, MemoryCandidate[]>();
  for (const part of read.candidates) {
    const ref = part.contentRef ?? part.id;
    const path = ref.slice(0, ref.lastIndexOf('#L') < 0 ? ref.length : ref.lastIndexOf('#L'));
    const parts = notes.get(path);
    if (parts === undefined) notes.set(path, [part]);
    else parts.push(part);
  }
  const ordered = [...notes.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  for (const [, parts] of ordered) parts.sort((left, right) => line(left) - line(right) || (left.id < right.id ? -1 : 1));
  const rule = markdownOptions.kind === 'rules' || markdownOptions.kind === 'instructions';
  const replaced = (parts: readonly MemoryCandidate[]) => parts.some((part) => part.signals['replaced'] !== undefined);

  const pending: { readonly which: Which; readonly question: PickQuestion }[] = [];
  for (const [, parts] of ordered) {
    const asks: Which[] = [...(replaced(parts) ? [] : ['stale' as const]), ...(rule ? [] : ['lasting' as const])];
    for (const part of parts) {
      for (const which of asks) {
        pending.push({ which, question: {
          key: keyOf(part.id, which), questionKey: which, ...(part.date === undefined ? {} : { date: part.date }),
          role: part.role, ...(part.kind === undefined ? {} : { kind: part.kind }),
          question: QUESTIONS[which].question(day), trueCriterion: QUESTIONS[which].trueCriterion,
          falseCriterion: QUESTIONS[which].falseCriterion,
          sourceId: part.sourceId, id: part.id, title: part.title, text: part.text,
        } });
      }
    }
  }

  const task = `Review these notes as of ${day}: say whether each part is stale and whether it states a lasting rule.`;
  const answers = new Map<string, number>();
  const unanswered: ReviewRecord['unanswered'][number][] = [];
  let asked = 0;
  for (let start = 0; start < pending.length; start += BATCH) {
    if (signal?.aborted) {
      for (const { which, question } of pending.slice(start)) unanswered.push({ id: question.id, question: which, reason: 'cancelled' });
      break;
    }
    const slice = pending.slice(start, start + BATCH);
    asked += slice.length;
    let reply: Record<string, PickAnswer> | undefined;
    let failure: unknown;
    try {
      const returned: unknown = await decide({ task, questions: slice.map(({ question }) => question) },
        signal ?? new AbortController().signal);
      reply = typeof returned === 'object' && returned !== null ? returned as Record<string, PickAnswer> : undefined;
    } catch (error) {
      failure = error;
    }
    for (const { which, question } of slice) {
      const answer = reply?.[question.key];
      if (answer?.status === 'answered' && typeof answer.probability === 'number'
        && answer.probability >= 0 && answer.probability <= 1) {
        answers.set(question.key, answer.probability);
        continue;
      }
      const detail = failure !== undefined ? (failure instanceof Error ? failure.message : String(failure))
        : answer !== undefined && 'detail' in answer ? answer.detail : undefined;
      unanswered.push({ id: question.id, question: which,
        reason: failure !== undefined ? (signal?.aborted ? 'cancelled' : 'error')
          : answer?.status === 'refused' || answer?.status === 'error' ? answer.status : 'missing',
        ...(detail === undefined ? {} : { detail }) });
    }
  }

  const proposals: NoteProposal[] = [];
  for (const [path, parts] of ordered) {
    const date = parts[0]!.date === undefined ? {} : { date: parts[0]!.date };
    if (!replaced(parts)) {
      const stale = parts.map((part) => ({ id: part.id, probability: answers.get(keyOf(part.id, 'stale')) }));
      if (stale.every(({ probability }) => probability !== undefined && probability >= bar)) {
        proposals.push({ path, action: 'retire', parts: stale as NoteProposal['parts'], ...date, edit: 'status: deprecated' });
      }
    }
    if (!rule) {
      const lasting = parts.flatMap((part) => {
        const probability = answers.get(keyOf(part.id, 'lasting'));
        return probability !== undefined && probability >= bar ? [{ id: part.id, probability }] : [];
      });
      if (lasting.length > 0) proposals.push({ path, action: 'promote', parts: lasting, ...date });
    }
  }
  return { proposals, record: { ...base, notes: ordered.length, parts: read.candidates.length, questions: asked, unanswered } };
}
