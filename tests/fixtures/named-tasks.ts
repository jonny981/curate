// Picks on a task that names people and things, compared with named-tasks-baseline.json:
// what the build before name lanes made with every source's name lanes off and no `named` question.
import { chatSettings } from '@curatejs/chat';
import { gitSettings } from '@curatejs/git';
import { markdownSettings } from '@curatejs/markdown';
import {
  historySource, pickFromSources, type CandidateSource, type MemoryCandidate,
  type PickBatch, type PickDecide, type PickRecord,
} from '@curatejs/core';
import { sha256 } from './bars-and-batches.js';
import { baselineText, decide, fixtureSource, parts } from './source-settings.js';

export const namedTask = 'Which deploy constraint did Emma agree with Book Lovers Unite for the billing service?';

/** The fixture's parts plus two past its keyword lanes that mention the task's names. */
export function namedParts(sourceId: string, rareWord: string): MemoryCandidate[] {
  const pool = parts(sourceId, rareWord);
  return [...pool, ...['Emma said the deploy waits a week.', 'Book Lovers Unite meets on Tuesday.'].map((text, i) => ({
    ...pool[0]!, id: `${sourceId}#${400 + i}`, title: `${sourceId} part ${400 + i}`, text: `${sourceId} ${text}`, signals: { keyword: 0 },
  }))];
}

/** The three presets with name lanes off. */
export const offSources = (): CandidateSource[] => [
  historySource({ reader: fixtureSource('chat', namedParts('chat', 'chatword'), { rare: false }), ...chatSettings, names: false }),
  historySource({ reader: fixtureSource('git', namedParts('git', 'gitword'), { rare: true }), ...gitSettings, names: false }),
  historySource({ reader: fixtureSource('markdown', namedParts('markdown', 'noteword'), { rare: false }),
    ...markdownSettings, names: false }),
];

/** The record as the baseline build wrote it: without the moment, the time zone and the task-period
 *  entries, which the task date added, without `pick`'s decide-call counts, which the fused-order
 *  accounting added (the old build wrote `pick` only under a dial, so a `pick` holding counts alone
 *  goes too), and without lane-0 ranks, which the fused order's need for positions added to
 *  single-search reads. */
const asBaseline = (record: PickRecord): PickRecord => {
  const slim: Partial<Record<keyof PickRecord, unknown>> = { ...record,
    candidates: record.candidates.map(({ searchRanks: _ranks, ...candidate }) => candidate),
    effects: record.effects.filter((entry) => entry.setting !== 'taskPeriod') };
  delete slim.asOf;
  delete slim.timeZone;
  if (record.pick !== undefined) {
    const { sent: _sent, questions: _questions, ...pick } = record.pick;
    if (pick.rare === undefined && pick.c === undefined) delete slim.pick;
    else slim.pick = pick;
  }
  return slim as PickRecord;
};

/** One pick per task, each run's selected ids and the hashes of its record and decide requests. */
export async function offRuns(tasks: readonly string[]) {
  const runs: Record<string, { selected: string; record: string; requests: string }> = {};
  for (const task of tasks) {
    const requests: PickBatch[] = [];
    const how: PickDecide = Object.assign(async (batch: PickBatch, signal: AbortSignal) => {
      requests.push(batch);
      return decide(batch, signal);
    }, { deciderId: 'fixture' });
    // The baseline these runs reproduce was recorded on the everyRanked feed.
    const picked = await pickFromSources(offSources(), { task }, { task, decide: how, everyRanked: true });
    const baselineRequests = requests.map((request) => ({ ...request,
      questions: request.questions.map((question) => ({ ...question,
        text: baselineText(question.sourceId, question.text) })),
    }));
    runs[task] = { selected: sha256(picked.selected.map((c) => c.id)), record: sha256(asBaseline(picked.record)),
      requests: sha256(baselineRequests) };
  }
  return runs;
}
