import type { CurateWrite } from './curate.js';
import type { PickAnswer, PickBatch, PickDecide, PickQuestion } from './pick.js';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function itemText(q: PickQuestion): string {
  const { sourceId, id, role, kind, date, title, text } = q;
  return JSON.stringify({ sourceId, id, role, kind, date, title, text });
}

function probabilityAnswer(probability: unknown): PickAnswer {
  return typeof probability === 'number' && Number.isFinite(probability)
    && probability >= 0 && probability <= 1
    ? { status: 'answered', probability } : { status: 'missing' };
}

async function post(url: string, apiKey: string, body: unknown, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`Model request failed: HTTP ${response.status}.`);
  return response.json();
}

/** Jev's request body for a batch. The state is the batch's task, then
 *  each distinct item once, numbered; each question's instructions are
 *  its wording, then the number of the item it asks about. */
export function jevRequest(batch: PickBatch, model = 'jev-latest') {
  const items = new Map<string, PickQuestion>();
  for (const question of batch.questions) {
    const key = `${question.sourceId}\n${question.id}`;
    if (!items.has(key)) items.set(key, question);
  }
  const numbers = new Map([...items.keys()].map((key, index) => [key, index + 1]));
  const number = (question: PickQuestion) => numbers.get(`${question.sourceId}\n${question.id}`);
  const state = [batch.task, ...[...items.values()].map((question) =>
    `Item ${number(question)}: ${question.id}${question.date === undefined ? ''
      : ` (${question.date.meaning} ${question.date.value})`}\n${question.title}\n\n${question.text}`)].join('\n\n');
  return {
    model,
    state,
    questions: Object.fromEntries(batch.questions.map((question, index) => [`q${index}`, {
      type: 'noul',
      instructions: `${question.question}\n\nItem ${number(question)}`,
      criteria: { true: question.trueCriterion, false: question.falseCriterion },
    }])),
  };
}

/** Jev's limits are 32,000 tokens for the state plus the longest
 *  question and 64,000 for the whole request, at an estimate of three
 *  characters a token. */
const JEV_STATE_CHARS = 32_000 * 3;
const JEV_REQUEST_CHARS = 64_000 * 3;

function fitsJev(body: ReturnType<typeof jevRequest>): boolean {
  const longest = Math.max(0, ...Object.values(body.questions).map((question) =>
    question.instructions.length + question.criteria.true.length + question.criteria.false.length));
  return body.state.length + longest <= JEV_STATE_CHARS && JSON.stringify(body).length <= JEV_REQUEST_CHARS;
}

/** The batch split into requests inside Jev's limits. Whole items join a
 *  request in order until the next would pass a limit; an item's
 *  questions always go with it, and an item too large alone goes alone. */
function jevBatches(batch: PickBatch, model: string): PickBatch[] {
  const items = new Map<string, PickQuestion[]>();
  for (const question of batch.questions) {
    const key = `${question.sourceId}\n${question.id}`;
    items.set(key, [...(items.get(key) ?? []), question]);
  }
  const batches: PickBatch[] = [];
  let questions: PickQuestion[] = [];
  for (const own of items.values()) {
    const next = { task: batch.task, questions: [...questions, ...own] };
    if (questions.length > 0 && !fitsJev(jevRequest(next, model))) {
      batches.push({ task: batch.task, questions });
      questions = own;
    } else questions = next.questions;
  }
  if (questions.length > 0) batches.push({ task: batch.task, questions });
  return batches;
}

/** Create a decision function using TypeSafe's yes/no probabilities. */
export function jev({ apiKey, model = 'jev-latest' }: {
  readonly apiKey: string | undefined;
  readonly model?: string;
}): PickDecide {
  if (!apiKey) throw new Error('Jev requires an API key.');
  const decide: PickDecide = async (batch, signal) => {
    const answered = await Promise.all(jevBatches(batch, model).map(async (part) => {
      const answers = record(record(await post('https://api.typesafe.ai/v1/systemone', apiKey,
        jevRequest(part, model), signal)).answers);
      return part.questions.map((q, index): [string, PickAnswer] =>
        [q.key, probabilityAnswer(record(answers[`q${index}`]).noul)]);
    }));
    return Object.fromEntries(answered.flat());
  };
  return Object.assign(decide, { deciderId: `typesafe:${model}:items-once` });
}

/** Create a decision function using OpenAI's named predicate answers. */
export function openAIDecisions({ apiKey, model = 'gpt-6-luna' }: {
  readonly apiKey: string | undefined;
  readonly model?: string;
}): PickDecide {
  if (!apiKey) throw new Error('OpenAI Decisions requires an API key.');
  const decide: PickDecide = async (batch, signal) => {
    const raw = await post('https://api.openai.com/v1/decisions', apiKey, {
      model,
      input: batch.task,
      questions: batch.questions.map((q, index) => ({
        type: 'predicate',
        name: `q${index}`,
        instructions: `${q.question}\nTrue: ${q.trueCriterion}\nFalse: ${q.falseCriterion}\nEvidence: ${itemText(q)}`,
      })),
    }, signal);
    const rawAnswers = record(raw).answers;
    const answers = new Map((Array.isArray(rawAnswers) ? rawAnswers : []).map((value: unknown) => {
      const answer = record(value);
      return [answer.name, answer] as const;
    }));
    return Object.fromEntries(batch.questions.map((q, index): [string, PickAnswer] => {
      const answer = answers.get(`q${index}`);
      return [q.key, answer?.type === 'refusal' ? { status: 'refused' }
        : probabilityAnswer(answer?.type === 'predicate' ? answer.probability : undefined)];
    }));
  };
  return Object.assign(decide, { deciderId: `openai:${model}` });
}

/** Create a writer using an OpenAI-compatible Chat Completions endpoint. */
export function chatWriter({ apiKey, model, url = 'https://api.openai.com/v1/chat/completions' }: {
  readonly apiKey: string | undefined;
  readonly model: string;
  readonly url?: string;
}): CurateWrite {
  if (!apiKey) throw new Error('Chat writer requires an API key.');
  return async ({ instructions, body }, signal) => {
    const raw = await post(url, apiKey, {
      model,
      messages: [
        { role: 'system', content: instructions },
        { role: 'user', content: body },
      ],
    }, signal);
    const choices = record(raw).choices;
    const text = record(record(Array.isArray(choices) ? choices[0] : undefined).message).content;
    if (typeof text !== 'string') throw new Error('Writer returned no log.');
    return text;
  };
}
