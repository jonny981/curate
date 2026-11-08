import type { CurateWrite } from './curate.js';
import { levelDistribution } from './decisions.js';
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
 *  rejected request's reason is never lost, and the Retry-After header a
 *  rate-limit reply waits by. */
async function jevPost(url: string, apiKey: string | undefined, text: string, signal: AbortSignal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), 'content-type': 'application/json' },
    body: text,
    signal,
  });
  return { ok: response.ok, status: response.status,
    retryAfter: response.headers.get('retry-after'), text: await response.text() };
}

/** The wait a reply's Retry-After header names, in milliseconds; an
 *  unreadable or absent header waits one second. */
function retryAfterMs(header: string | null): number {
  if (header === null) return 1000;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds)) return Math.max(seconds * 1000, 0);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(date - Date.now(), 0) : 1000;
}

/** A wait that stops when the signal fires. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

/** TypeSafe's published starting allowance: 80 requests and 100,000
 *  tokens a second, a token estimated at three characters like the
 *  request-size bounds. The service publishes no simultaneous-request
 *  limit; these two rates bound every request the adapter sends. */
const JEV_TOKENS_PER_SECOND = 100_000;
const JEV_REQUESTS_PER_SECOND = 80;

/** A pick's failure state inside the allowance queue: `stop` marks it
 *  once with the failure's own reason. */
interface AllowanceDomain {
  stopped: boolean;
  reason?: unknown;
}

/** Each send reserves its estimated tokens and one request slot before
 *  it dispatches, in send order, so sends at once cannot together pass
 *  the rates. A request whose estimate passes a second's tokens pays a
 *  full second's allowance once the bucket is full. A cancelled wait
 *  reserves nothing.
 *  A terminal failure stops its own pick, not the adapter: every send
 *  of one pick waits under the same `domain`, and `stop` drops the
 *  waits still queued under it — inside the failed batch's splits and
 *  its sibling batches — with the failure's own reason, then refuses
 *  every later wait of that pick, a batch not yet dispatched included.
 *  Sends already dispatched settle on their own; a wait under another
 *  pick's domain sends normally. A stop on a stopped domain changes
 *  nothing. */
function rateAllowance(tokensPerSecond: number, requestsPerSecond: number) {
  let tokens = tokensPerSecond;
  let requests = requestsPerSecond;
  let at = Date.now();
  const queue: { readonly cost: number; readonly domain: AllowanceDomain;
    grant(): void; drop(reason: unknown): void }[] = [];
  const refill = () => {
    const now = Date.now();
    const elapsed = (now - at) / 1000;
    at = now;
    tokens = Math.min(tokensPerSecond, tokens + elapsed * tokensPerSecond);
    requests = Math.min(requestsPerSecond, requests + elapsed * requestsPerSecond);
  };
  const pump = () => {
    refill();
    while (queue.length > 0) {
      const head = queue[0]!;
      const need = Math.min(head.cost, tokensPerSecond);
      if (tokens < need || requests < 1) break;
      tokens -= need;
      requests -= 1;
      queue.shift();
      head.grant();
    }
    if (queue.length > 0) {
      const head = queue[0]!;
      const waitMs = Math.max(
        (Math.min(head.cost, tokensPerSecond) - tokens) / tokensPerSecond,
        (1 - requests) / requestsPerSecond) * 1000;
      setTimeout(pump, Math.max(Math.ceil(waitMs), 1));
    }
  };
  const wait = (chars: number, domain: AllowanceDomain, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    if (domain.stopped) { reject(domain.reason); return; }
    if (signal?.aborted) { reject(signal.reason); return; }
    const entry = { cost: Math.ceil(chars / 3), domain, grant: () => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, drop: (reason: unknown) => {
      signal?.removeEventListener('abort', cancel);
      reject(reason);
    } };
    const cancel = () => {
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    queue.push(entry);
    if (queue.length === 1) pump();
  });
  const stop = (domain: AllowanceDomain, why: unknown) => {
    if (domain.stopped) return;
    domain.stopped = true;
    domain.reason = why;
    for (const entry of [...queue]) {
      if (entry.domain !== domain) continue;
      queue.splice(queue.indexOf(entry), 1);
      entry.drop(why);
    }
  };
  return { wait, stop };
}

/** An item as a decision model reads it: its id and date, its title,
 *  then its text. An anonymous item keeps only its date and its text,
 *  with the `# session` header lines bench chunks carry stripped —
 *  its identifying fields never reach the request body. */
function itemState(question: PickQuestion): string {
  if (question.anonymous === true) {
    const text = question.text.split('\n').filter((line) => !line.startsWith('# session')).join('\n');
    return question.date === undefined ? text
      : `(${question.date.meaning} ${question.date.value})\n\n${text}`;
  }
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
    questions: Object.fromEntries(batch.questions.map((question, index) => [`q${index}`,
      question.levels === undefined
        ? {
          type: 'noul',
          instructions: `${question.question}\n\nItem ${number(question)}`,
          criteria: { true: question.trueCriterion, false: question.falseCriterion },
        }
        : {
          type: 'score',
          instructions: `${question.question}\n\nItem ${number(question)}`,
          criteria: [...question.levels],
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
    question.instructions.length + (Array.isArray(question.criteria)
      ? question.criteria.join('').length
      : (question.criteria.true ?? '').length + (question.criteria.false ?? '').length)));
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
  // The two published rates bound every request this adapter sends:
  // planned subrequests, rejection splits and rate-limit resends each
  // reserve their allowance before dispatching. A request held for its
  // split children holds no allowance while it waits.
  const allow = rateAllowance(JEV_TOKENS_PER_SECOND, JEV_REQUESTS_PER_SECOND);
  // A pick is its signal: every decide call of one pick — its batches,
  // splits and resends — arrives under the same signal object, so a
  // send's failure domain is looked up from it. A batch of that pick
  // dispatched after a terminal failure lands in the stopped domain and
  // never reaches fetch; a different pick's signal keeps a live domain
  // of its own.
  const domains = new WeakMap<AbortSignal, AllowanceDomain>();
  const domainFor = (signal: AbortSignal): AllowanceDomain => {
    let domain = domains.get(signal);
    if (domain === undefined) { domain = { stopped: false }; domains.set(signal, domain); }
    return domain;
  };
  const send = async (part: PickBatch, signal: AbortSignal): Promise<[string, PickAnswer][]> => {
    const text = JSON.stringify(jevRequest(part, model));
    const domain = domainFor(signal);
    for (;;) {
      try {
        await allow.wait(text.length, domain, signal);
        const then = Date.now();
        let reply: Awaited<ReturnType<typeof jevPost>>;
        try {
          reply = await jevPost(url, apiKey, text, signal);
        } catch (error) {
          // A request that never got a reply — a network failure or a
          // cancelled signal — is still a call. The sends still queued
          // stop before the record write below can let one through:
          // report the call with its timing and the error it raised,
          // then let that error fail the pick.
          allow.stop(domain, error);
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
        // A rate-limited request waits as the reply directs, then sends the
        // same request unchanged: it is never split, dropped or counted as
        // a size rejection, and every attempt stays in the record.
        if (reply.status === 429) {
          await onCall?.(call);
          await wait(retryAfterMs(reply.retryAfter), signal);
          continue;
        }
        if (!reply.ok) return await fail(part, signal, call, reply.text, domain);
        accepted = Math.max(accepted, call.size);
        await onCall?.(call);
        const answers = record(raw.answers);
        return part.questions.map((q, index): [string, PickAnswer] => {
          const answer = record(answers[`q${index}`]);
          if (q.levels !== undefined) {
            // A score answer's level probabilities arrive keyed "0"
            // onward; the score field itself is never a substitute.
            const raw = answer.probabilities;
            const probabilities = Array.isArray(raw) ? raw
              : typeof raw === 'object' && raw !== null
                ? q.levels.map((_, level) => (raw as Record<string, unknown>)[String(level)])
                : undefined;
            return [q.key, probabilities !== undefined && levelDistribution(probabilities, q.levels.length)
              ? { status: 'answered', probabilities: [...probabilities] }
              : { status: 'missing' }];
          }
          return [q.key, probabilityAnswer(answer.noul)];
        });
      } catch (error) {
        // A terminal failure ends the sends still waiting for allowance —
        // inside this batch's splits and inside other batches — with the
        // failure's own reason; it does not wait for the batch promises
        // around it to settle first.
        allow.stop(domain, error);
        throw error;
      }
    }
  };
  const fail = async (part: PickBatch, signal: AbortSignal, call: {
    started: string; questions: number; size: number; status: number; ms: number;
    usage?: unknown; answers?: unknown; splits: number;
  }, replyText: string, domain: AllowanceDomain): Promise<[string, PickAnswer][]> => {
    rejected = true;
    // Only a rejection size can explain is retried: a too-large status
    // on a body bigger than every body Jev has accepted so far.
    if ((call.status === 400 || call.status === 413) && call.size > accepted) {
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
        const halves: [string, PickAnswer][] = [];
        // Both halves start; a failed half returns only once the other
        // half has settled and reported, so its request is never
        // missing from the record.
        for (const half of await Promise.allSettled([groups.slice(0, middle), groups.slice(middle)]
          .map((half) => send({ task: part.task, questions: half.flat() }, signal)))) {
          if (half.status === 'rejected') throw half.reason;
          halves.push(...half.value);
        }
        return halves;
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
    // A terminal reply stops the sends still queued before the record
    // write below can let one through; the failure thrown is its own.
    const error = new Error(`Model request failed: HTTP ${call.status}. ${replyText}`);
    allow.stop(domain, error);
    await onCall?.(call);
    throw error;
  };
  const decide: PickDecide = async (batch, signal) => {
    const answered: [string, PickAnswer][] = [];
    // Every request a failure already started settles — and reports —
    // before the failure returns, in dispatch order.
    for (const planned of await Promise.allSettled(
        jevBatches(batch, model, rejected && accepted > 0 ? accepted : JEV_REQUEST_CHARS)
          .map((part) => send(part, signal)))) {
      if (planned.status === 'rejected') throw planned.reason;
      answered.push(...planned.value);
    }
    return Object.fromEntries(answered);
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
