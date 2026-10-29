// Picks and curator prompts on a task that names people and things, compared with named-tasks-baseline.json:
// what the build before name lanes made with every source's name lanes off and no `named` question.
import { chatSettings } from '@curatejs/chat';
import { gitSettings } from '@curatejs/git';
import { markdownSettings } from '@curatejs/markdown';
import {
  curate, historySource, pickFromSources, type CandidateSource, type CuratePrompt, type MemoryCandidate,
  type PickBatch, type PickDecide, type PickRecord,
} from '@curatejs/core';
import { curatePick, sha256 } from './bars-and-batches.js';
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
 *  entries, which the task date added. */
const asBaseline = ({ asOf: _asOf, timeZone: _timeZone, ...record }: PickRecord) => ({ ...record,
  effects: record.effects.filter((entry) => entry.setting !== 'taskPeriod') });

/** One pick and one curate call per task, each run's selected ids and the hashes of its record, decide
 *  requests and curator prompts. */
export async function offRuns(tasks: readonly string[]) {
  const runs: Record<string, { selected: string; record: string; requests: string; prompts: string }> = {};
  for (const task of tasks) {
    const requests: PickBatch[] = [];
    const how: PickDecide = Object.assign(async (batch: PickBatch, signal: AbortSignal) => {
      requests.push(batch);
      return decide(batch, signal);
    }, { deciderId: 'fixture' });
    const picked = await pickFromSources(offSources(), { task }, { task, decide: how });
    const prompts: CuratePrompt[] = [];
    const evidence = { ...picked, selected: picked.selected.map((part) => ({ ...part,
      text: baselineText(part.sourceId, part.text) })) };
    await curate(task, evidence, { routeByTask: true, write: async (prompt) => { prompts.push(prompt); return ''; } });
    const baselineRequests = requests.map((request) => ({ ...request,
      questions: request.questions.map((question) => ({ ...question,
        text: baselineText(question.sourceId, question.text) })),
    }));
    runs[task] = { selected: sha256(picked.selected.map((c) => c.id)), record: sha256(asBaseline(picked.record)),
      requests: sha256(baselineRequests), prompts: sha256(prompts) };
  }
  return runs;
}

/** The curator prompt a `routeByTask` call writes for the task on a small fixed pick. */
export async function routedPrompt(task: string): Promise<CuratePrompt> {
  const prompts: CuratePrompt[] = [];
  await curate(task, curatePick(2, 120), { routeByTask: true, write: async (prompt) => { prompts.push(prompt); return ''; } });
  return prompts[0]!;
}
