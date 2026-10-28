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

async function post(url: string, apiKey: string | undefined, body: unknown, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`Model request failed: HTTP ${response.status}.`);
  return response.json();
}

/** Jev's reply to one request: its HTTP status and whole body, read so a
 *  rejected request's reason is never lost. */
async function jevPost(url: string, apiKey: string | undefined, text: string, signal: AbortSignal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), 'content-type': 'application/json' },
    body: text,
    signal,
  });
  return { ok: response.ok, status: response.status, text: await response.text() };
}

/** An item as a decision model reads it: its id and date, its title, then its text. */
function itemState(question: PickQuestion): string {
  return `${question.id}${question.date === undefined ? ''
    : ` (${question.date.meaning} ${question.date.value})`}\n${question.title}\n\n${question.text}`;
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
    `Item ${number(question)}: ${itemState(question)}`)].join('\n\n');
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

function fitsJev(body: ReturnType<typeof jevRequest>, maxChars = JEV_REQUEST_CHARS): boolean {
  const longest = Math.max(0, ...Object.values(body.questions).map((question) =>
    question.instructions.length + question.criteria.true.length + question.criteria.false.length));
  return body.state.length + longest <= JEV_STATE_CHARS && JSON.stringify(body).length <= maxChars;
}

/** The batch split into requests inside Jev's limits. Whole items join a
 *  request in order until the next would pass a limit; an item's
 *  questions always go with it, and an item too large alone goes alone.
 *  `maxChars` is the whole-request bound a plan keeps to, the learned
 *  limit once a rejection has landed. */
function jevBatches(batch: PickBatch, model: string, maxChars = JEV_REQUEST_CHARS): PickBatch[] {
  const items = new Map<string, PickQuestion[]>();
  for (const question of batch.questions) {
    const key = `${question.sourceId}\n${question.id}`;
    items.set(key, [...(items.get(key) ?? []), question]);
  }
  const batches: PickBatch[] = [];
  let questions: PickQuestion[] = [];
  for (const own of items.values()) {
    const next = { task: batch.task, questions: [...questions, ...own] };
    if (questions.length > 0 && !fitsJev(jevRequest(next, model), maxChars)) {
      batches.push({ task: batch.task, questions });
      questions = own;
    } else questions = next.questions;
  }
  if (questions.length > 0) batches.push({ task: batch.task, questions });
  return batches;
}

const JEV_URL = 'https://api.typesafe.ai/v1/systemone';

/** A URL's host and path, so labels stored from servers at different
 *  hosts or paths keep apart. The scheme and query are left out. */
function hostAndPath(url: string): string {
  const { host, pathname } = new URL(url);
  return `${host}${pathname}`;
}

/** One request `jev()` sent, reported through `onCall`. `splits` is the
 *  number of extra requests its rejection produced: two halves when a
 *  multi-item request was split, one resend when a lone item's text was
 *  halved, zero for a request the service answered or finally rejected. */
export interface JevCall {
  /** When the request was sent. */
  readonly started: string;
  /** How many questions the request asked. */
  readonly questions: number;
  /** The whole request body, in characters. */
  readonly size: number;
  /** The reply's HTTP status, or 0 when the request never got a reply. */
  readonly status: number;
  /** How long the request took, in milliseconds. */
  readonly ms: number;
  /** The failure's message, when the request never got a reply: a
   *  network error or a cancellation. */
  readonly error?: string;
  /** The usage the reply reported, when it held one. */
  readonly usage?: unknown;
  /** The reply's raw answers, when it held them. */
  readonly answers?: unknown;
  /** The extra requests this rejection spawned. */
  readonly splits: number;
}

/** Create a decision function using TypeSafe's yes/no probabilities, or
 *  those of another server that speaks Jev's format at `url`. */
export function jev({ apiKey, model = 'jev-latest', url = JEV_URL, onCall }: {
  /** Required at TypeSafe's address; sent only when given. */
  readonly apiKey?: string | undefined;
  readonly model?: string;
  readonly url?: string;
  /** Called once per request, split and resent requests included. */
  readonly onCall?: ((call: JevCall) => void | Promise<void>) | undefined;
}): PickDecide {
  if (!apiKey && url === JEV_URL) throw new Error('Jev requires an API key.');
  const deciderId = url === JEV_URL ? `typesafe:${model}:items-once` : `jev:${hostAndPath(url)}:${model}:items-once`;
  // The largest whole body Jev has accepted in this pick. Once a
  // rejection has landed, later batches are planned inside it, and a
  // request rejected at no more than it did not fail for size: its
  // reply is thrown as sent.
  let accepted = 0;
  let rejected = false;
  const send = async (part: PickBatch, signal: AbortSignal): Promise<[string, PickAnswer][]> => {
    const text = JSON.stringify(jevRequest(part, model));
    const then = Date.now();
    let reply: Awaited<ReturnType<typeof jevPost>>;
    try {
      reply = await jevPost(url, apiKey, text, signal);
    } catch (error) {
      // A request that never got a reply — a network failure or a
      // cancelled signal — is still a call: report it with its timing
      // and the error it raised, then let that error fail the pick.
      await onCall?.({
        started: new Date(then).toISOString(), questions: part.questions.length,
        size: text.length, status: 0, ms: Date.now() - then,
        error: error instanceof Error ? error.message : String(error),
        splits: 0,
      });
      throw error;
    }
    const raw = (() => { try { return record(JSON.parse(reply.text)); } catch { return {}; } })();
    const call = {
      started: new Date(then).toISOString(), questions: part.questions.length,
      size: text.length, status: reply.status, ms: Date.now() - then,
      ...(raw.usage === undefined ? {} : { usage: raw.usage }),
      ...(raw.answers === undefined ? {} : { answers: raw.answers }),
      splits: 0,
    };
    if (reply.ok) {
      accepted = Math.max(accepted, call.size);
      await onCall?.(call);
      const answers = record(raw.answers);
      return part.questions.map((q, index): [string, PickAnswer] =>
        [q.key, probabilityAnswer(record(answers[`q${index}`]).noul)]);
    }
    rejected = true;
    // Only a rejection size can explain is retried: a too-large status
    // on a body bigger than every body Jev has accepted so far.
    if ((reply.status === 400 || reply.status === 413) && call.size > accepted) {
      const items = new Map<string, PickQuestion[]>();
      for (const q of part.questions) {
        const key = `${q.sourceId}\n${q.id}`;
        items.set(key, [...(items.get(key) ?? []), q]);
      }
      if (items.size > 1) {
        call.splits = 2;
        await onCall?.(call);
        const groups = [...items.values()];
        const middle = Math.ceil(groups.length / 2);
        const halves = await Promise.all([groups.slice(0, middle), groups.slice(middle)]
          .map((half) => send({ task: part.task, questions: half.flat() }, signal)));
        return halves.flat();
      }
      // A lone oversized item is resent with its evidence halved, never
      // its question; an empty text cannot be cut further.
      const current = part.questions[0]!.text;
      if (current !== '') {
        call.splits = 1;
        await onCall?.(call);
        const points = [...current];
        const half = points.slice(0, Math.floor(points.length / 2)).join('');
        const answers = await send({ task: part.task,
          questions: part.questions.map((q) => ({ ...q, text: half })) }, signal);
        return answers.map(([key, answer]): [string, PickAnswer] => [key, { ...answer, truncated: true }]);
      }
    }
    await onCall?.(call);
    throw new Error(`Model request failed: HTTP ${reply.status}. ${reply.text}`);
  };
  const decide: PickDecide = async (batch, signal) => {
    const answered = await Promise.all(
      jevBatches(batch, model, rejected && accepted > 0 ? accepted : JEV_REQUEST_CHARS)
        .map((part) => send(part, signal)));
    return Object.fromEntries(answered.flat());
  };
  return Object.assign(decide, { deciderId });
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

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

/** The yes share of the first answer token's top log-probabilities:
 *  the "yes" tokens' probability over the "yes" and "no" tokens', with
 *  case and leading whitespace ignored. Missing when neither is there. */
function yesProbability(raw: unknown, url: string): PickAnswer {
  const choices = record(raw).choices;
  const content = record(record(Array.isArray(choices) ? choices[0] : undefined).logprobs).content;
  const top = record(Array.isArray(content) ? content[0] : undefined).top_logprobs;
  if (!Array.isArray(top)) {
    throw new Error(`The model server at ${url} returned no log-probabilities; localDecisions needs a server that does.`);
  }
  let yes = 0;
  let no = 0;
  for (const entry of top) {
    const { token, logprob } = record(entry);
    if (typeof token !== 'string' || typeof logprob !== 'number') continue;
    const word = token.trimStart().toLowerCase();
    if (word === 'yes') yes += Math.exp(logprob);
    else if (word === 'no') no += Math.exp(logprob);
  }
  return yes + no > 0 ? probabilityAnswer(yes / (yes + no)) : { status: 'missing' };
}

/** Create a decision function using yes/no log-probabilities from an
 *  OpenAI-compatible chat server, one question a request, in turn. */
export function localDecisions({ url, model, apiKey }: {
  /** An OpenAI-compatible chat completions address that returns log-probabilities, for example http://127.0.0.1:8000/v1/chat/completions. */
  readonly url: string;
  readonly model: string;
  readonly apiKey?: string;
}): PickDecide {
  const decide: PickDecide = async (batch, signal) => {
    const answers: Record<string, PickAnswer> = {};
    for (const q of batch.questions) {
      answers[q.key] = yesProbability(await post(url, apiKey, {
        model,
        messages: [
          { role: 'system', content: 'Answer the question about the item with one word, yes or no.' },
          { role: 'user', content: `Task:\n${batch.task}\n\nQuestion:\n${q.question}\n\nYes means: ${q.trueCriterion}\n`
            + `No means: ${q.falseCriterion}\n\nItem:\n${itemState(q)}` },
        ],
        max_tokens: 1,
        temperature: 0,
        logprobs: true,
        top_logprobs: 20,
      }, signal), url);
    }
    return answers;
  };
  return Object.assign(decide, { deciderId: `local:${hostAndPath(url)}:${model}` });
}

/** Create a writer using an OpenAI-compatible Chat Completions endpoint. */
export function chatWriter({ apiKey, model, url = OPENAI_CHAT_URL }: {
  /** Required at OpenAI's address; sent only when given. */
  readonly apiKey?: string | undefined;
  readonly model: string;
  readonly url?: string;
}): CurateWrite {
  if (!apiKey && url === OPENAI_CHAT_URL) throw new Error('Chat writer requires an API key.');
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
