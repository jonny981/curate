import type { MemoryCandidate, PickResult } from './pick.js';

export interface CuratePrompt {
  readonly instructions: string;
  readonly body: string;
}

export type CurateWrite = (prompt: CuratePrompt, signal: AbortSignal) => Promise<string>;

export interface CurateOptions {
  readonly write: CurateWrite;
  /** Add numbered instances, computed gaps, or latest values under the log. */
  readonly working?: boolean;
  readonly signal?: AbortSignal;
}

export interface CurateRecord {
  readonly promptVersion: 'v4';
  readonly weights: 'tiers';
  readonly working: boolean;
  /** The reference items given to the writer, in prompt order, with exact weights. */
  readonly items: readonly {
    /** Full item id in the prompt; includes the source when ids would clash. */
    readonly id: string;
    readonly candidate: MemoryCandidate;
    readonly weight: number;
  }[];
}

export interface CurateResult {
  readonly log: string;
  readonly record: CurateRecord;
}

const LOG_LIMIT = 3500;
const WORKING_HEADING = "Working (the curator's; check it against the log):";
const NO_WORKING = '- Do not answer the task, do not count, and do not decide whether an observation falls inside a period the task names: give its dates and leave that to the reader.';

// Keep these instructions byte for byte with recall/curate.ts's v4 + tiers prompt.
const INSTRUCTIONS = [
  'You curate memory for a person or an agent about to do a task. You get the task and evidence items, each with an id and a date.',
  'Rewrite the evidence that could bear on the task as a log of observations, oldest first, one line each:',
  '[YYYY-MM-DD the event happened] the observation, with its exact names, numbers and amounts (said YYYY-MM-DD; the full item id from its header)',
  '- The "said" date is the date in the item header. Work out when the event happened from it: "last Saturday" said on 2023-05-20 happened on 2023-05-13. When the item gives no time for the event, use the said date and write "(when not stated)". Never shift a date that is already absolute.',
  '- One line per distinct event or fact. When two items tell the same event, write it once and give both ids.',
  '- When a later observation replaces an earlier one (a new job, a changed plan, an updated number, a new habit), keep both and always end the later line with "(replaces [the earlier date])".',
  '- Include preferences, habits, opinions, interests and limits the person states, dated.',
  '- Include what the assistant said only when the task asks about it.',
  NO_WORKING,
  'At most 3500 characters.',
  'Each item header shows, in brackets after its date, a weight from 0 to 1: how strongly a decision model judged the item relevant to this task. The weight is graded, not a yes or no, and every item already passed a search for this task. Make sure every observation from items weighted 0.6 or more is in the log. Items weighted from 0.1 to 0.6 are less direct but often hold part of what the task needs, such as one instance of several or an earlier value: include their facts when they bear on the task. Items weighted below 0.1 rarely matter: use one only when it clearly states a fact the task needs.',
].join('\n');

function isDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function checkLog(raw: unknown, working: boolean, ids: readonly string[]): string {
  if (typeof raw !== 'string') throw new TypeError('curate: malformed log; write must return text.');
  const log = raw.trim();
  if (!log) throw new Error('curate: empty log.');
  if (log.length > LOG_LIMIT) throw new Error(`curate: oversized log; at most ${LOG_LIMIT} characters allowed.`);

  const lines = log.split('\n').map((line) => line.trim()).filter(Boolean);
  const heading = lines.indexOf(WORKING_HEADING);
  if (heading !== -1 && (!working || heading === 0 || heading === lines.length - 1)) {
    throw new Error('curate: malformed log; unexpected or empty working section.');
  }
  const sources = ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const date = '(\\d{4}-\\d{2}-\\d{2})';
  const separator = '(?:,\\s*(?:and\\s+)?|;\\s*|\\s+(?:and|&)\\s+)';
  const observation = new RegExp(`^\\[${date}\\] (.+?) \\(said ${date}; (?:${sources})(?:${separator}(?:${sources}))*\\)(?: \\(when not stated\\))?(?: \\(replaces \\[${date}\\]\\))?$`);
  for (const line of heading === -1 ? lines : lines.slice(0, heading)) {
    const match = observation.exec(line);
    if (!match || !isDate(match[1]!) || !match[2]!.trim() || !isDate(match[3]!)
      || (match[4] !== undefined && !isDate(match[4]))) {
      throw new Error('curate: malformed log; each observation needs an event date, a said date, and a full item id.');
    }
  }
  return log;
}

/** Write only the dated log. Selected rules remain the caller's instructions. */
export async function curate(
  task: string,
  picked: PickResult,
  options: CurateOptions,
): Promise<CurateResult> {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const working = options.working ?? false;
  const references = picked.selected.filter((candidate) => candidate.role === 'reference');
  const items = references.map((candidate) => {
    const entry = picked.record.candidates.find((item) =>
      item.sourceId === candidate.sourceId && item.id === candidate.id);
    if (entry?.status !== 'selected' || entry.probability === undefined
      || !Number.isFinite(entry.probability) || entry.probability < 0 || entry.probability > 1) {
      throw new TypeError('curate: each reference needs a selected record entry with a weight between 0 and 1.');
    }
    const id = references.some((other) => other !== candidate && other.id === candidate.id)
      ? JSON.stringify([candidate.sourceId, candidate.id]) : candidate.id;
    return { id, candidate, weight: entry.probability };
  });
  if (!items.length) throw new Error('curate: no selected reference items to curate.');

  const blocks = items.map(({ id, candidate, weight }) =>
    `### ${id} (${candidate.date ? `${candidate.date.value}, ` : ''}${weight.toFixed(2)}): ${candidate.title}\n\n${candidate.text}`.trim());
  const instructions = !working ? INSTRUCTIONS : INSTRUCTIONS.replace(NO_WORKING,
    '- In the log itself, do not judge: give every observation its dates, including ones near the edge of a period the task names.')
    + '\nAfter the log, add a short section headed "Working (the curator\'s; check it against the log):". For a count or a list: number each distinct instance that falls inside the period the task names, with its date and id, then name any instance you left out and why (outside the period, or the same as another). For a question about time or order: the dates involved and the computed difference or order. For something that changed: the latest value and its date. Leave out any part the task does not need. Keep the log and the working together within 3500 characters.';
  const raw = await options.write({
    instructions,
    body: `TASK:\n${task}\n\nEVIDENCE:\n\n${blocks.join('\n\n')}`,
  }, signal);
  signal.throwIfAborted();
  return {
    log: checkLog(raw, working, items.map((item) => item.id)),
    record: { promptVersion: 'v4', weights: 'tiers', working, items },
  };
}
