// The picks compared with bars-and-batches-baseline.json: two label-carrying pick runs on the source-settings
// fixture.
import { createHash } from 'node:crypto';

import { chatSettings } from '@curatejs/chat';
import { gitSettings } from '@curatejs/git';
import { markdownSettings } from '@curatejs/markdown';
import {
  historySource, pickFromSources, type CandidateSource, type HistorySettings, type PickDecide, type PickQuestion,
  type PickSourcesResult,
} from '@curatejs/core';
import { decide, fixtureSource, parts, task } from './source-settings.js';

export const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A chat source on the fixture; `id` renames it, `extra` adds settings such as `labelBar`. */
export const chatSource = (id = 'chat', extra: Partial<HistorySettings> = {}): CandidateSource =>
  historySource({ reader: { ...fixtureSource('chat', parts(id, `${id}word`), { rare: false }), id },
    ...chatSettings, labels: true, ...extra });
const git = () => historySource({ reader: fixtureSource('git', parts('git', 'gitword'), { rare: true }), ...gitSettings });
const markdown = () =>
  historySource({ reader: fixtureSource('markdown', parts('markdown', 'noteword'), { rare: false }), ...markdownSettings });

export const PICK_RUNS: Record<string, () => CandidateSource[]> = {
  'chat labels': () => [chatSource()],
  'chat labels all': () => [chatSource(), git(), markdown()],
};

/** A pick on the fixture, with every decide request it sent. */
export async function fixturePick(sources: CandidateSource[]) {
  const requests: { readonly task: string; readonly questions: readonly PickQuestion[] }[] = [];
  const how: PickDecide = Object.assign(async (batch: Parameters<PickDecide>[0], signal: AbortSignal) => {
    requests.push(batch);
    return decide(batch, signal);
  }, { deciderId: 'fixture' });
  // The baseline these runs reproduce was recorded on the everyRanked feed.
  const picked = await pickFromSources(sources, { task }, { task, decide: how, everyRanked: true });
  return { picked, requests };
}

/** The selected ids, and the hash of the fields questions-per-source.spec.ts hashes: each entry's source id,
 *  id, status, probability and reason, the label counts, and every question asked. */
export function pickFields(picked: PickSourcesResult, requests: Awaited<ReturnType<typeof fixturePick>>['requests']) {
  const selected = picked.selected.map((c) => c.id);
  const candidates = picked.record.candidates.map((c) => [c.sourceId, c.id, c.status,
    'probability' in c ? c.probability ?? null : null, 'reason' in c ? c.reason ?? null : null]);
  const record = picked.record.labels;
  const labels = record === undefined ? null : [record.asked, record.reused, record.gate];
  const asked = requests.map((r) => r.questions.map((q) => [q.key, q.questionKey ?? null, q.question]));
  return { selected, sha256: sha256([selected, candidates, labels, asked]) };
}
