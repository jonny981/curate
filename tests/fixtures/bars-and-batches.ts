// The picks and curator prompts compared with bars-and-batches-baseline.json: two label-carrying pick runs on
// the source-settings fixture, and the curator's prompts on one fixed pick written three ways.
import { createHash } from 'node:crypto';

import { chatSettings } from '@curatejs/chat';
import { gitSettings } from '@curatejs/git';
import { markdownSettings } from '@curatejs/markdown';
import {
  curate, historySource, pickFromSources, type CandidateSource, type CuratePrompt, type CurateOptions,
  type CurateWrite, type HistorySettings, type MemoryCandidate, type PickDecide, type PickQuestion,
  type PickResult, type PickSourcesResult,
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

const WEIGHTS = [0.92, 0.71, 0.64, 0.48, 0.33, 0.2, 0.12, 0.07, 0.03];
const SENTENCES = ['The billing service deploy waits for the freeze to end.', 'The release notes name the queue change.',
  'We agreed the cache warms before traffic moves.', 'The plan keeps one deploy a day.'];

/** Reference items of about `characters` each, with fixed dates and weights. */
export function curatePick(count = WEIGHTS.length, characters = 2000): PickResult {
  const items: MemoryCandidate[] = Array.from({ length: count }, (_, i) => ({
    sourceId: 'notes', id: `note-${i}`, title: `note ${i}`, role: 'reference', signals: {},
    date: { value: `2026-02-${String(1 + (i % 28)).padStart(2, '0')}`, meaning: 'recorded' },
    text: Array.from({ length: Math.ceil(characters / 40) }, (_, j) => SENTENCES[(i + j) % SENTENCES.length]).join(' ')
      .slice(0, characters),
  }));
  return {
    selected: items,
    record: {
      questionVersion: 'fixture', limits: {}, thresholds: { linkedPathBar: 0 }, rulesCoverage: 'complete',
      levers: { everyRanked: true, route: false, rare: false, sources: {} }, effects: [],
      candidates: items.map((item, i) => ({ sourceId: item.sourceId, id: item.id, role: item.role, priority: i,
        signals: item.signals, status: 'selected' as const, asked: true, probability: WEIGHTS[i % WEIGHTS.length]! })),
    },
  };
}

export const CURATE_LOG = '[2026-02-01] The billing service deploy waits for the freeze to end (said 2026-02-01; E1)';

/** A writer that keeps every prompt and always returns the same valid log. */
export function recordingWriter() {
  const prompts: CuratePrompt[] = [];
  const write: CurateWrite = async (prompt) => {
    prompts.push(prompt);
    return CURATE_LOG;
  };
  return { prompts, write };
}

export const CURATE_WAYS: Record<string, Omit<CurateOptions, 'write'>> = {
  'no options': {},
  // Under the fixed log's length, so the condense prompt is written.
  contextLimit: { contextLimit: 40 },
  batchTokens: { batchTokens: 2000 },
};

/** The prompts one way wrote on the fixed pick. */
export async function curatePrompts(way: Omit<CurateOptions, 'write'>, pick = curatePick()) {
  const writer = recordingWriter();
  const result = await curate(task, pick, { ...way, write: writer.write });
  return { prompts: writer.prompts, result };
}
