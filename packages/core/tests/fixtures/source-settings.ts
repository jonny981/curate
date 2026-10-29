// Sources shaped like the chat, git and Markdown readers, and a decide function with fixed answers, so a pick
// over them can be compared with the picks the build before this change made (source-settings-baseline.json).
import type { CandidateSource, LabelKind, MemoryCandidate, PickDecide, PickQuestion } from '../../src/index.js';

export const task = 'Which deploy constraint did we agree for the billing service?';
const WORDS = ['deploy', 'billing', 'service', 'constraint', 'agreed', 'release', 'notes', 'plan', 'queue', 'cache'];

/** 400 parts. Parts i and i + 200 share a word no other part of this source has (every tenth i below 200), so
 *  the rare-word round can follow a selected part in the lanes to its partner outside them. `crowd`, when given,
 *  is added to parts 100 to 111, making those words common in this source. */
export function parts(sourceId: string, rareWord: string, crowd = ''): MemoryCandidate[] {
  return Array.from({ length: 400 }, (_, i) => ({
    sourceId, id: `${sourceId}#${i}`, title: `${sourceId} part ${i}`, role: 'reference',
    text: `${sourceId} ${WORDS[i % 10]} ${WORDS[(i * 7) % 10]} part ${i}${i % 200 % 10 === 0 ? ` ${rareWord}${i % 200}` : ''}`
      + `${crowd && i >= 100 && i < 112 ? ` ${crowd}` : ''}`,
    signals: { keyword: (400 - i) / 400 }, date: { value: `2026-01-${String(1 + (i % 28)).padStart(2, '0')}`, meaning: 'recorded' },
  }));
}

/** A source with the given settings; its keyword lanes return the first 60 parts, a whole-lane read all 400,
 *  with the parts past the first 60 marked as past the lane cut. */
export function fixtureSource(id: 'chat' | 'git' | 'markdown', pool: readonly MemoryCandidate[],
  settings: { rare: boolean; labelKinds?: readonly LabelKind[] }): CandidateSource {
  return {
    id, kind: id === 'git' ? 'git-history' : id, role: 'reference', rare: settings.rare,
    ...(settings.labelKinds === undefined ? {} : { labelKinds: settings.labelKinds }),
    read: async (request) => ({ status: 'read', complete: true, laneCutApplied: true,
      candidates: request.wholeLanes
        ? pool.map((part, index) => index < 60 ? part : { ...part, pastLaneCut: true as const })
        : pool.slice(0, 60) }),
  };
}

// A fixed answer per question, cubed so about a quarter of the parts fall under the 0.0146 bar.
function answer(q: PickQuestion): number {
  let h = 2166136261;
  for (const c of `${q.sourceId}|${q.id}|${q.questionKey ?? ''}|${q.question}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) / 2 ** 32) ** 3;
}
export const decide: PickDecide = Object.assign(async ({ questions }: { questions: readonly PickQuestion[] }) =>
  Object.fromEntries(questions.map((q) => [q.key, { status: 'answered' as const, probability: answer(q) }])), { deciderId: 'fixture' });
