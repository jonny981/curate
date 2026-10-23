import { describe, expect, it } from 'vitest';
import { pick, type MemoryCandidate, type PickCascade, type PickDecide } from '@curatejs/core';
import { CHAT_CASCADE } from '@curatejs/chat';
import { GIT_HISTORY_CASCADE } from '@curatejs/git';
import { MARKDOWN_CASCADE } from '@curatejs/markdown';

const uncutPick = { everyRanked: true, everyScored: true, rare: false } as const;

const candidate: MemoryCandidate = {
  sourceId: 'evidence', role: 'reference', id: 'item', title: 'Evidence', text: 'Evidence for the task',
  signals: {},
};

async function score(cascade: PickCascade, values: Readonly<Record<string, number>>) {
  const asked: string[] = [];
  const decide: PickDecide = async ({ questions }) => Object.fromEntries(questions.map((question) => {
    const key = question.questionKey!;
    asked.push(key);
    return [question.key, { status: 'answered', probability: values[key]! }];
  }));
  const result = await pick([candidate], { ...uncutPick,
    task: 'Find evidence', cascade, decide,
  });
  const entry = result.record.candidates[0]!;
  return { asked, probability: 'probability' in entry ? entry.probability : undefined };
}

describe('exported question defaults', () => {
  it('preserves chat scores for both full and first-question decisions', async () => {
    const full = await score(CHAT_CASCADE, { relevant: 0.5, own: 0.8, needed: 0.8 });
    expect(full.asked).toEqual(['relevant', 'own', 'needed']);
    expect(full.probability).toBeCloseTo(0.5428380008201791, 14);

    const firstOnly = await score(CHAT_CASCADE, { relevant: 0.95 });
    expect(firstOnly.asked).toEqual(['relevant']);
    expect(firstOnly.probability).toBeCloseTo(0.9579375146912384, 14);
    expect(Object.keys(CHAT_CASCADE).sort()).toEqual(['band', 'bias', 'first', 'firstOnly', 'questions']);
  });

  it('shares all four commit questions with Markdown and lowers off-topic scores', async () => {
    expect(MARKDOWN_CASCADE).toEqual(GIT_HISTORY_CASCADE);
    const onTopic = await score(GIT_HISTORY_CASCADE, { current: 0.8, needed: 0.7, when: 0.6, offtopic: 0.2 });
    const offTopic = await score(MARKDOWN_CASCADE, { current: 0.8, needed: 0.7, when: 0.6, offtopic: 0.8 });

    expect(onTopic.asked).toEqual(['current', 'needed', 'when', 'offtopic']);
    expect(offTopic.asked).toEqual(onTopic.asked);
    expect(onTopic.probability).toBeCloseTo(0.4954048151109378, 14);
    expect(offTopic.probability).toBeCloseTo(0.0836952709978445, 14);
    expect(offTopic.probability!).toBeLessThan(onTopic.probability!);
    expect(GIT_HISTORY_CASCADE.questions.find((question) => question.key === 'offtopic')!.weight).toBeLessThan(0);
  });
});
