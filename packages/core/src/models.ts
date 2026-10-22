import type { CurateWrite } from './curate.js';
import type { PickAnswer, PickDecide, PickQuestion } from './pick.js';

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

/** Create a decision function using TypeSafe's yes/no probabilities. */
export function jev({ apiKey, model = 'jev-latest' }: {
  readonly apiKey: string | undefined;
  readonly model?: string;
}): PickDecide {
  if (!apiKey) throw new Error('Jev requires an API key.');
  const decide: PickDecide = async (batch, signal) => {
    const raw = await post('https://api.typesafe.ai/v1/systemone', apiKey, {
      model,
      state: batch.task,
      questions: Object.fromEntries(batch.questions.map((q, index) => [`q${index}`, {
        type: 'noul',
        instructions: `${q.question}\n\nEvidence: ${itemText(q)}`,
        criteria: { true: q.trueCriterion, false: q.falseCriterion },
      }])),
    }, signal);
    const answers = record(record(raw).answers);
    return Object.fromEntries(batch.questions.map((q, index): [string, PickAnswer] =>
      [q.key, probabilityAnswer(record(answers[`q${index}`]).noul)]));
  };
  return Object.assign(decide, { deciderId: `typesafe:${model}` });
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
