import { describe, expect, it } from 'vitest';
import {
  ANSWER_QUESTION, FACT_QUESTION, jevRequest, pick, rankedRead, type MemoryCandidate, type PickBatch, type PickCascade, type PickDecide,
} from '../src/index.js';

const task = 'Which database did we choose, and why?';
const needed = ['which database was chosen', 'why it was chosen'];
/** The narrow question in two: whether a part answers, and once per needed fact whether it states that fact. */
const set: PickCascade = { bias: 0, questions: [{ ...ANSWER_QUESTION, weight: 1 }], facts: { question: FACT_QUESTION, highest: 1 } };
const mode = (questions: PickCascade = set) => ({ name: 'notes', questions, read: rankedRead, needed: true });
const part: MemoryCandidate = { sourceId: 'notes', role: 'reference', id: 'n1', title: 'n1', text: 'We chose Postgres.', signals: {}, searchRanks: [0] };
/** Answers 0.8 to whether it answers, 0.9 to the first fact and 0.2 to the second. */
const recording = () => {
  const batches: PickBatch[] = [];
  const decide: PickDecide = async (batch) => {
    batches.push(batch);
    return Object.fromEntries(batch.questions.map((question) => [question.key, { status: 'answered',
      probability: question.questionKey === 'answers' ? 0.8 : question.questionKey === 'fact1' ? 0.9 : 0.2 }]));
  };
  return { batches, decide };
};
const logit = (p: number) => Math.log(p / (1 - p));

describe('the narrow question in two, in the answers wording', () => {
  it('asks whether a part answers and, once per needed fact, whether it states it, as sent', async () => {
    const { batches, decide } = recording();
    const result = await pick([part], { task, decide, needed, modesBySource: { notes: mode() } });
    expect(batches).toHaveLength(1);
    expect(jevRequest(batches[0]!)).toEqual({
      model: 'jev-latest',
      state: {
        task,
        needed,
        items: { 1: { id: 'n1', date: null, title: 'n1', text: 'We chose Postgres.' } },
      },
      questions: {
        q0: {
          type: 'noul',
          instructions: { question: 'Does this item answer the task?', item: 'items.1' },
          criteria: {
            true: 'It states the answer to the task itself',
            false: 'It describes work toward the answer, a plan, or a question about it, without stating the result',
          },
        },
        q1: {
          type: 'noul',
          instructions: { question: 'Does this item state this needed fact: which database was chosen', item: 'items.1' },
          criteria: {
            true: 'It states the fact itself',
            false: 'It is about the same subject, a plan or a step toward it, without stating the fact',
          },
        },
        q2: {
          type: 'noul',
          instructions: { question: 'Does this item state this needed fact: why it was chosen', item: 'items.1' },
          criteria: {
            true: 'It states the fact itself',
            false: 'It is about the same subject, a plan or a step toward it, without stating the fact',
          },
        },
      },
    });
    const entry = result.record.candidates[0]!;
    // The score adds the answers question and the best fact answer, each through its weight.
    expect('probability' in entry && entry.probability).toBeCloseTo(1 / (1 + Math.exp(-(logit(0.8) + logit(0.9)))), 9);
    expect(entry.questions!.map((answer) => answer.key)).toEqual(['answers', 'fact1', 'fact2']);
  });

  it('asks only whether a part answers when the call gives no needed facts', async () => {
    const { batches, decide } = recording();
    const result = await pick([part], { task, decide, modesBySource: { notes: mode() } });
    expect(batches.flatMap((batch) => batch.questions).map((question) => question.questionKey)).toEqual(['answers']);
    const entry = result.record.candidates[0]!;
    expect('probability' in entry && entry.probability).toBeCloseTo(0.8, 9);
  });

  it('checks the facts question', async () => {
    const { decide } = recording();
    const clash: PickCascade = { ...set, questions: [{ ...ANSWER_QUESTION, key: 'fact1', weight: 1 }] };
    await expect(pick([part], { task, decide, needed, modesBySource: { notes: mode(clash) } }))
      .rejects.toThrow('a question set\'s facts question needs a key, instructions, true and false, a finite highest weight');
    const unweighted = { ...set, facts: { question: FACT_QUESTION } } as unknown as PickCascade;
    await expect(pick([part], { task, decide, needed, modesBySource: { notes: mode(unweighted) } }))
      .rejects.toThrow('a question set\'s facts question needs');
  });
});
