// Run N calls at once in one process against one index, and report what
// each call adds and whether each still returns what it returns alone.
//
// A generated history (Codex transcripts, a Markdown notes repository, a
// code repository's commits and a WhatsApp export, about `--parts` parts
// in all) is indexed
// once. Then, in a fresh process for each N, N calls start together, each
// with a task from a fixed list, through the skill's read and pick path
// (`pickFullSources`, the second search on the coding-agent transcripts
// as the skill runs it, then `curate`), with a stand-in embedder and a
// stand-in decision service. Every call waits at its first decision
// request until all N have arrived; then the live heap and the resident
// memory are read after a garbage collection. Each task run alone is
// also read through its whole call: at its first decision request, at
// every eighth, after the pick and after the layout.
//
// The stand-in decision service answers after a fixed delay a request,
// behind one limit of tokens a second that every call shares. With
// `--ratings uniform` (the default) each answer comes from a hash of the
// question, so most parts rate warm and a read goes far: the worst case.
// With `--ratings lifelike` each part's rating is drawn from the spread
// of live decision ratings, higher the more of the task's search words
// the part holds; a chat part rates warm only in the eight days of
// transcripts that hold the task's strongest matches, so warm parts
// gather in a few sessions as live ones do. The call stops its ranked
// read where the ratings go cold, as the skill does by default: the
// expected case.
//
// Reported for each N: memory each call adds (live heap and resident,
// over the process before the calls, divided by N), the peak resident
// memory, the time per call (median and slowest, with and without the
// time any of its requests spent waiting on the shared limit), CPU per
// call (the process's CPU over N: the calls share one thread), and
// whether every call's output (its selected parts, record and laid-out
// text) equals the same task's output run alone. The check fails when an
// output differs, or when `--max-own-mb` is given and a call's own heap
// is above it.
//
//   node scripts/check-concurrency.mjs [--parts 2000] [--calls 1,4]
//     [--delay-ms 0] [--tokens-per-second 0] [--tokens-per-part 440]
//     [--dir <folder>] [--max-own-mb <MB>] [--ratings uniform|lifelike] [--json]
//
// `--tokens-per-second 0` sets no limit. `--dir` keeps the history and its
// index for the next run of the same size. Run `pnpm build` first: the
// script imports the built packages. No model and no network are used.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const self = fileURLToPath(import.meta.url);

const TASKS = [
  { task: 'Why did we drop the quorum lease for the ledger sync, and what replaced it?',
    keywords: ['quorum lease ledger sync', 'dropped the lease timeout', 'ledger sync replica leader'],
    answers: ['We dropped the quorum lease because the ledger sync now uses a replica leader.'] },
  { task: 'What did we decide about the vector cache expiry and the rebuild?',
    keywords: ['vector cache expiry', 'cache rebuild counter', 'expiry fold schema'],
    answers: ['The cache expiry was removed and the counter rebuilds the vectors.'] },
  { task: 'How do the batch worker pool and the queue backoff work together?',
    keywords: ['batch worker pool', 'queue backoff retry', 'worker thread heartbeat'],
    answers: ['Each worker takes a batch from the queue and backs off on a timeout.'] },
  { task: 'What changed in the billing tariff and the meter export?',
    keywords: ['billing tariff meter', 'meter export import', 'tariff currency invoice'],
    answers: ['The tariff now bills the meter export against the import.'] },
];

function parse(argv) {
  const options = { parts: 2000, calls: [1, 4], delayMs: 0, tokensPerSecond: 0, tokensPerPart: 440, dir: undefined,
    maxOwnMb: undefined, json: false, ratings: 'uniform' };
  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at];
    const value = () => {
      const next = argv[++at];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === '--parts') options.parts = Number(value());
    else if (flag === '--calls') options.calls = value().split(',').map(Number);
    else if (flag === '--delay-ms') options.delayMs = Number(value());
    else if (flag === '--tokens-per-second') options.tokensPerSecond = Number(value());
    else if (flag === '--tokens-per-part') options.tokensPerPart = Number(value());
    else if (flag === '--dir') options.dir = resolve(value());
    else if (flag === '--max-own-mb') options.maxOwnMb = Number(value());
    else if (flag === '--json') options.json = true;
    else if (flag === '--ratings') {
      options.ratings = value();
      if (!['uniform', 'lifelike'].includes(options.ratings)) throw new Error('--ratings must be uniform or lifelike');
    }
    else throw new Error(`unknown option ${flag}`);
  }
  const counts = [options.parts, ...options.calls, options.delayMs, options.tokensPerSecond, options.tokensPerPart];
  if (counts.some((n) => !Number.isFinite(n) || n < 0) || options.parts < 100 || options.calls.some((n) => !Number.isInteger(n) || n < 1)) {
    throw new Error('--parts must be 100 or more, --calls positive whole numbers, and the rest non-negative numbers');
  }
  return options;
}

// ---------------------------------------------------------------- history

/** A history of about `parts` parts: Codex transcripts (72%), a Markdown
 *  notes repository (26%) and a code repository's commits (2%). The same
 *  size always gives the same history. */
function generate(dir, parts) {
  let seed = 12345;
  const rand = () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const COMMON = ('the a to and of in is it that for we on this with be as not are you was have but or if at by from so can '
    + 'will do what when which they there should would about after before need use make then also just like only into more '
    + 'some our than them these those because').split(' ');
  const TOPIC = ('ledger quorum lease sync shard index vector posting bend lane fused pick record layout stream cache fold '
    + 'expiry counter rebuild migration schema journal snapshot replica leader follower heartbeat timeout retry backoff '
    + 'budget token decision rating evidence answer question session transcript commit branch merge rebase review gate '
    + 'worker thread pool queue batch embed model cosine recall precision orchard quince pump filter garden invoice '
    + 'currency billing tariff battery inverter solar export import meter').split(' ');
  const syllables = ['ka', 'lo', 'mi', 'ne', 'ru', 'ta', 'vo', 'zi', 'pe', 'sa', 'do', 'gu', 'fi', 'ha', 'jo', 'be'];
  const tail = Array.from({ length: 20000 }, () => Array.from({ length: 2 + Math.floor(rand() * 3) }, () => pick(syllables)).join(''));
  const word = () => {
    const r = rand();
    if (r < 0.45) return pick(COMMON);
    if (r < 0.75) return pick(TOPIC);
    return tail[Math.floor(tail.length * rand() ** 3)];
  };
  const sentence = (min, max) => {
    const words = Array.from({ length: min + Math.floor(rand() * (max - min)) }, word);
    words[0] = words[0][0].toUpperCase() + words[0].slice(1);
    return `${words.join(' ')}.`;
  };
  const paragraph = (count) => Array.from({ length: count }, () => sentence(6, 18)).join(' ');
  const start = Date.parse('2024-11-01T00:00:00Z');
  const span = 2 * 365 * 86_400_000;

  const chatParts = Math.round(parts * 0.72);
  let made = 0;
  for (let session = 0; made < chatParts; session += 1) {
    const at = start + Math.floor(rand() * span);
    const folder = join(dir, 'chat', new Date(at).toISOString().slice(0, 10).replace(/-/g, '/'));
    mkdirSync(folder, { recursive: true });
    const id = `${`0000${session}`.slice(-6)}-aaaa-bbbb-cccc-${`00000000000${session}`.slice(-12)}`;
    const lines = [JSON.stringify({ type: 'session_meta', timestamp: new Date(at).toISOString(), payload: { id } })];
    const turns = 40 + Math.floor(rand() * 40);
    for (let turn = 0; turn < turns && made < chatParts; turn += 1) {
      const role = turn % 2 === 0 ? 'user' : 'assistant';
      const text = rand() < 0.1 ? paragraph(12) : paragraph(1 + Math.floor(rand() * 4));
      const said = rand() < 0.03 ? 'Noted, carrying on with the ledger sync.' : text;
      lines.push(JSON.stringify({ type: 'response_item', timestamp: new Date(at + turn * 30_000).toISOString(),
        payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: said }] } }));
      made += said.length > 700 ? Math.ceil(said.length / 650) : 1;
    }
    const stamp = new Date(at).toISOString().slice(0, 19).replace(/:/g, '-');
    writeFileSync(join(folder, `rollout-${stamp}-${id}.jsonl`), `${lines.join('\n')}\n`);
  }

  const environment = (date) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_AUTHOR_NAME: 'Check', GIT_AUTHOR_EMAIL: 'check@example.invalid', GIT_COMMITTER_NAME: 'Check',
    GIT_COMMITTER_EMAIL: 'check@example.invalid', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  const git = (cwd, args, date = '2025-01-01T00:00:00Z', input) => execFileSync('git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null',
    '-c', 'commit.gpgsign=false', ...args], { env: environment(date), stdio: 'pipe', input, maxBuffer: 1 << 30 });

  const notes = join(dir, 'notes');
  mkdirSync(notes, { recursive: true });
  git(notes, ['init', '-q', '-b', 'main']);
  const noteCount = Math.ceil(Math.round(parts * 0.26) / 6);
  const noteName = (index) => `topic-${index}`;
  const batches = Math.min(40, noteCount);
  for (let batch = 0; batch < batches; batch += 1) {
    for (let index = Math.floor(batch * noteCount / batches); index < Math.floor((batch + 1) * noteCount / batches); index += 1) {
      const folder = join(notes, `area-${index % 30}`);
      mkdirSync(folder, { recursive: true });
      const front = rand() < 0.5 ? `---\ntitle: "${sentence(2, 5).slice(0, -1)}"\ntype: "research"\ndate: "${
        new Date(start + Math.floor(rand() * span)).toISOString().slice(0, 10)}"\n---\n` : '';
      const sections = Array.from({ length: 6 }, () => `## ${sentence(2, 5).slice(0, -1)}\n\n${paragraph(2 + Math.floor(rand() * 3))}${
        rand() < 0.4 ? ` See [[${noteName(Math.floor(rand() * noteCount))}]].` : ''}`);
      writeFileSync(join(folder, `${noteName(index)}.md`), `${front}# ${sentence(2, 5).slice(0, -1)}\n\n${sections.join('\n\n')}\n`);
    }
    git(notes, ['add', '-A']);
    git(notes, ['commit', '-q', '-m', `Notes batch ${batch}`], new Date(start + Math.floor(span * (batch + 1) / batches)).toISOString());
  }

  const code = join(dir, 'code');
  mkdirSync(code, { recursive: true });
  git(code, ['init', '-q', '-b', 'main']);
  const commits = Math.max(50, Math.round(parts * 0.02));
  let stream = '';
  for (let index = 0; index < commits; index += 1) {
    const when = Math.floor((start + span * index / commits) / 1000);
    const message = `${sentence(4, 10).slice(0, -1)}\n\n${paragraph(1 + Math.floor(rand() * 3))}\n`;
    const content = `${paragraph(2)}\n`;
    stream += `commit refs/heads/main\nmark :${index + 1}\ncommitter Check <check@example.invalid> ${when} +0000\n`
      + `data ${Buffer.byteLength(message)}\n${message}\n${index === 0 ? '' : `from :${index}\n`}`
      + `M 100644 inline src/file-${index % 300}.ts\ndata ${Buffer.byteLength(content)}\n${content}\n`;
  }
  git(code, ['fast-import', '--quiet'], undefined, stream);
  git(code, ['checkout', '-q', 'main']);

  // A WhatsApp export between two people, one message a line, read as one
  // note a day: calls at once write the same notes.
  const messages = Math.max(60, Math.round(parts * 0.02));
  const exported = Array.from({ length: messages }, (_, index) => {
    const at = new Date(start + Math.floor(span * index / messages)).toISOString();
    const [year, month, day] = at.slice(0, 10).split('-');
    return `[${day}/${month}/${year}, ${at.slice(11, 19)}] ${index % 2 ? 'Sam' : 'Ann'}: ${paragraph(1 + Math.floor(rand() * 2))}`;
  });
  mkdirSync(join(dir, 'messages'), { recursive: true });
  writeFileSync(join(dir, 'messages', '_chat.txt'), `${exported.join('\n')}\n`);
}

// ------------------------------------------------------------------ calls

const MB = (bytes) => bytes / 2 ** 20;

/** Runs in a child process: either every task once, alone (`alone`), or
 *  `n` calls at once held together at their first decision request. */
// Quantiles of the live decision ratings (Climb 8, eight tasks, 17,212 rated parts): [share, rating].
const LIVE = [[0.0, 0.0034], [0.05, 0.00579], [0.1, 0.00848], [0.15, 0.01143], [0.2, 0.01341], [0.25, 0.0146], [0.3, 0.01619], [0.35, 0.01799], [0.4, 0.0191], [0.45, 0.02159], [0.5, 0.02237], [0.55, 0.02539], [0.6, 0.02737], [0.65, 0.03313], [0.7, 0.04068], [0.75, 0.05332], [0.8, 0.07225], [0.85, 0.10667], [0.9, 0.18092], [0.95, 0.34519], [0.96, 0.39905], [0.97, 0.4682], [0.98, 0.55636], [0.99, 0.90995], [0.995, 0.93492], [1, 0.97834]];
// Set from `--ratings` in each child.
let lifelike = false;
const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
// One answer for every question of a part: the agent set scores relevant (0.7031) and needed (0.5134)
// with bias -1.7305 while the first answer is inside [0.1, 0.9], and the first answer alone
// (bias -0.6674, weight 1.2882) outside it.
// The days of transcripts a task is about: the eight days whose chat parts hold the most of the task's search
// words (most in one record, then most in all), worked out once a child from the generated history. A live read's
// warm parts gather in the few sessions a task is about; without this the read finds warm parts all through a large
// history and reads far deeper than a live one.
const TOPIC_DAYS = 8;
const topicCache = new Map();
function topicDaysOf(dir, terms) {
  const key = [...terms].join(' ');
  if (topicCache.has(key)) return topicCache.get(key);
  const days = new Map();
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      const day = /\d{4}\/\d{2}\/\d{2}\//.exec(path)?.[0];
      if (!entry.name.endsWith('.jsonl') || day === undefined) continue;
      const score = days.get(day) ?? [0, 0];
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.includes('"text"')) continue;
        const words = new Set(line.toLowerCase().split(/[^a-z]+/));
        let held = 0;
        for (const term of terms) if (words.has(term)) held += 1;
        score[0] = Math.max(score[0], held);
        score[1] += held;
      }
      days.set(day, score);
    }
  };
  walk(join(dir, 'chat'));
  const chosen = [...days].sort(([left, a], [right, b]) => b[0] - a[0] || b[1] - a[1] || left.localeCompare(right))
    .slice(0, TOPIC_DAYS).map(([day]) => day);
  topicCache.set(key, chosen);
  return chosen;
}

function liveAnswer(question, fnv, terms, topicDays) {
  const hashed = fnv(`${question.sourceId}|${question.id}`) / 2 ** 32;
  const words = new Set(`${question.title} ${question.text}`.toLowerCase().split(/[^a-z]+/));
  let held = 0;
  for (const term of terms) if (words.has(term)) held += 1;
  // Up to one search word: the cold 80 percent; two: the cold 85; three: the middle; four or more: the warm 15 percent.
  // A chat part outside the days the task is about rates cold. Inside them: no search word cold, one in the middle,
  // two or more warm. A source other than chat goes by words alone: up to one cold, two the cold 85 percent, three
  // the middle, four or more warm.
  const day = /\d{4}\/\d{2}\/\d{2}\//.exec(question.id)?.[0];
  const u = !question.sourceId.startsWith('chat:')
    ? (held <= 1 ? hashed * 0.8 : held === 2 ? hashed * 0.85 : held === 3 ? 0.5 + hashed * 0.45 : 0.85 + hashed * 0.15)
    : day === undefined || !topicDays.has(day) || held === 0 ? hashed * 0.8
      : held === 1 ? 0.5 + hashed * 0.45 : 0.85 + hashed * 0.15;
  let at = 1;
  while (at < LIVE.length - 1 && LIVE[at][0] < u) at += 1;
  const [u0, r0] = LIVE[at - 1];
  const [u1, r1] = LIVE[at];
  const rating = Math.min(0.999, Math.max(0.001, r0 + (r1 - r0) * (u1 === u0 ? 0 : (u - u0) / (u1 - u0))));
  // The Markdown and Git sets weigh current (0.2884) and when (0.7034) for a part and needed (-0.1165) and
  // offtopic (-0.8565) against it, with bias -1.7920: the two against are answered the other way.
  if (!question.sourceId.startsWith('chat:')) {
    const answer = sigmoid((logit(rating) + 1.7920) / 1.9648);
    return question.questionKey === 'needed' || question.questionKey === 'offtopic' ? 1 - answer : answer;
  }
  const inside = sigmoid((logit(rating) + 1.7305) / 1.2165);
  if (inside >= 0.1 && inside <= 0.9) return inside;
  const outside = sigmoid((logit(rating) + 0.6674) / 1.2882);
  return outside < 0.1 || outside > 0.9 ? outside : inside;
}

async function child(config) {
  const { dir, n, alone, delayMs, tokensPerSecond, tokensPerPart } = config;
  lifelike = config.ratings === 'lifelike';
  const run = await import(pathToFileURL(join(root, 'skills/curate/run.mjs')).href);
  const core = await import('@curatejs/core');
  const { agentTranscripts, chat } = await import('@curatejs/chat');
  const { git } = await import('@curatejs/git');
  const { knowledgeBase, whatsapp } = await import('@curatejs/markdown');
  const { Worker } = await import('node:worker_threads');

  // A stand-in embedder: a vector from each word's hash, so texts that share
  // words lie near each other. No model.
  const fnv = (text) => {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); }
    return hash >>> 0;
  };
  const embed = core.cachedEmbeddings(async (texts) => texts.map((text) => {
    const vector = new Float64Array(768);
    for (const word of text.toLowerCase().split(/[^a-z0-9]+/).filter((each) => each.length > 2).slice(-80)) {
      const hash = fnv(word);
      vector[hash % 768] += 1;
      vector[(hash >>> 10) % 768] += hash & 1 ? 0.5 : -0.5;
    }
    vector[fnv(text) % 768] += 0.01;
    return vector;
  }), { directory: join(dir, 'cache', 'curate', 'embeddings'), modelId: 'check-concurrency-standin-768' });

  // One shared limit: each request takes its tokens from one budget that
  // refills at `tokensPerSecond`, then waits `delayMs`.
  let free = performance.now();
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  // Returns the stretch of time the request waited on the limit.
  const service = async (tokens) => {
    const now = performance.now();
    let until = now;
    if (tokensPerSecond > 0) {
      free = Math.max(free, now) + tokens / tokensPerSecond * 1000;
      until = free;
      await sleep(until - now);
    }
    if (delayMs > 0) await sleep(delayMs);
    return [now, until];
  };
  // How long at least one of a call's requests was waiting: requests in
  // flight together wait at the same time, so their waits are not added.
  const covered = (stretches) => {
    let total = 0;
    let end = Number.NEGATIVE_INFINITY;
    for (const [from, to] of [...stretches].sort((left, right) => left[0] - right[0])) {
      if (to > end) { total += to - Math.max(from, end); end = to; }
    }
    return total;
  };

  // Peak resident memory, sampled by a worker thread, which keeps sampling
  // while the main thread runs synchronous SQLite work.
  const peak = new Float64Array(new SharedArrayBuffer(8));
  const sampler = new Worker(`const { workerData } = require('node:worker_threads');
    const peak = new Float64Array(workerData);
    setInterval(() => { const rss = process.memoryUsage.rss(); if (rss > peak[0]) peak[0] = rss; }, 2);`,
  { eval: true, workerData: peak.buffer });
  sampler.unref();

  const count = alone ? TASKS.length : n;
  let arrived = 0;
  let release;
  const gate = new Promise((done) => { release = done; });
  let atGate;
  const arrive = () => {
    if (alone) return;
    arrived += 1;
    if (arrived === n) {
      globalThis.gc();
      const memory = process.memoryUsage();
      atGate = { heap: memory.heapUsed, rss: memory.rss };
      release();
    }
  };
  // Timings and the index update report differ from run to run.
  const strip = (value) => JSON.parse(JSON.stringify(value, (key, item) => (key === 'ms' || /Ms$/.test(key) || key === 'index') ? undefined : item));

  const call = async (index) => {
    const { task, keywords, answers } = TASKS[index % TASKS.length];
    const lines = { keywords, answers };
    const raw = [chat({ providers: ['codex'], paths: [join(dir, 'chat')] }), knowledgeBase(join(dir, 'notes')), git(join(dir, 'code')),
      whatsapp(join(dir, 'messages', '_chat.txt'), { directory: join(dir, 'messages-notes') })];
    const searched = (source, searches) => run.searchSource({ ...source, labelKinds: [], rare: false }, searches, [], dir, { readAudit: false });
    const sources = raw.map((source) => searched(source, { chat: lines, 'git-history': lines, markdown: lines }));
    // The coding-agent transcripts, which the skill searches a second time.
    const agentIds = new Set(sources.filter((source) => source.mode?.name === agentTranscripts.name).map((source) => source.id));
    const named = (count) => Array.from({ length: count }, (_, at) => `curate-search:${at}`);
    let first = true;
    const waits = [];
    const live = () => { globalThis.gc(); return process.memoryUsage().heapUsed; };
    // After the pick and the layout, work the call started may still be
    // settling; the heap is read once it has.
    const settled = async () => { await new Promise((done) => setImmediate(done)); await new Promise((done) => setTimeout(done, 50)); return live(); };
    // Alone, a call's live heap is read through the whole call: at its
    // first decision request, at every eighth, after the pick and after
    // the layout, each after a garbage collection, less the heap before it.
    const watched = alone;
    const base = watched ? live() : 0;
    const marks = { first: 0, peak: 0, picked: 0, laid: 0 };
    let requests = 0;
    const terms = new Set(keywords.join(' ').toLowerCase().split(/[^a-z]+/).filter((word) => word.length >= 4));
    const topicDays = new Set(lifelike ? topicDaysOf(dir, terms) : []);
    const decide = Object.assign(async (batch) => {
      if (watched && (requests === 0 || requests % 8 === 0)) {
        const heap = live() - base;
        if (requests === 0) marks.first = heap;
        marks.peak = Math.max(marks.peak, heap);
      }
      requests += 1;
      if (first) { first = false; arrive(); if (!alone) await gate; }
      const parts = new Set(batch.questions.map((question) => JSON.stringify([question.sourceId, question.id]))).size;
      waits.push(await service(parts * tokensPerPart));
      return Object.fromEntries(batch.questions.map((question) => {
        const hash = fnv(`${question.sourceId}|${question.id}|${question.questionKey ?? question.key}`) / 2 ** 32;
        if (question.levels !== undefined) {
          const raw = question.levels.map((_, level) => (fnv(`${hash}|${level}`) % 1000) + 1);
          const sum = raw.reduce((total, value) => total + value, 0);
          return [question.key, { status: 'answered', probabilities: raw.map((value) => value / sum) }];
        }
        return [question.key, { status: 'answered', probability: lifelike ? liveAnswer(question, fnv, terms, topicDays) : hash }];
      }));
    }, { deciderId: 'check-concurrency-standin' });
    const started = performance.now();
    const cpu = process.cpuUsage();
    try {
      const request = { task, taskDate: '2026-11-13T12:00:00Z', searchLines: named(keywords.length + answers.length), meaning: { embed } };
      const options = { task, decide, limits: { maxBatchChars: 120_000 }, cache: false, ...(lifelike ? { stopWhenCold: {} } : {}) };
      const round = await run.pickFullSources(sources, request, options);
      // The second search, from round one's warmest parts' rarest words.
      const again = agentIds.size === 0 ? { picked: round } : await run.searchAgain(task, round, agentIds, (found) => run.pickFullSources(
        raw.filter((_, at) => agentIds.has(sources[at].id)).map((source) => searched(source, { chat: found })),
        { ...request, searchLines: named(found.keywords.length + found.answers.length) }, options));
      const picked = again.picked;
      if (watched) { marks.picked = (await settled()) - base; marks.peak = Math.max(marks.peak, marks.picked); }
      const result = await core.curate(task, picked, { sentenceCutoff: false });
      if (watched) { marks.laid = (await settled()) - base; marks.peak = Math.max(marks.peak, marks.laid); }
      const second = again.record === undefined ? null
        : { lines: again.lines, seeds: again.seeds, added: again.added, record: strip(again.record) };
      const output = createHash('sha256').update(JSON.stringify({ selected: picked.selected.map((part) => [part.sourceId, part.id]),
        record: strip(picked.record), log: result.log, second })).digest('hex');
      const used = process.cpuUsage(cpu);
      return { task: index % TASKS.length, output, ms: performance.now() - started, waitMs: covered(waits),
        cpuMs: (used.user + used.system) / 1000, selected: picked.selected.length, marks, requests };
    } finally {
      if (first) arrive();
    }
  };

  if (alone) {
    await call(0);
    const calls = [];
    for (let index = 0; index < count; index += 1) calls.push(await call(index));
    return { calls };
  }
  await sleep(20);
  globalThis.gc();
  const before = process.memoryUsage();
  peak[0] = 0;
  const cpu = process.cpuUsage();
  const calls = await Promise.all(Array.from({ length: n }, (_, index) => call(index)));
  const used = process.cpuUsage(cpu);
  return { n, calls, before: { heap: before.heapUsed, rss: before.rss }, atGate, peakRss: Math.max(peak[0], process.memoryUsage.rss()),
    cpuMs: (used.user + used.system) / 1000 };
}

function spawnChild(config, dir) {
  // The heap may grow to three quarters of the machine's memory, so the
  // number of calls a run can hold is set by the machine, not by Node's default.
  const heapMb = Math.floor(totalmem() / 2 ** 20 * 0.75);
  const result = spawnSync(process.execPath, ['--expose-gc', '--no-warnings', `--max-old-space-size=${heapMb}`, self, '--child',
    JSON.stringify(config)], {
    encoding: 'utf8', maxBuffer: 1 << 26, env: { ...process.env, XDG_CACHE_HOME: join(dir, 'cache') },
  });
  if (result.status !== 0) throw new Error(`a child run failed:\n${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) / 2)];
};

async function main() {
  const options = parse(process.argv.slice(2));
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'curate-concurrency-'));
  try {
    const marker = join(dir, 'history.json');
    const made = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : undefined;
    if (made?.parts !== options.parts) {
      for (const folder of ['chat', 'notes', 'code', 'cache']) rmSync(join(dir, folder), { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      generate(dir, options.parts);
      writeFileSync(marker, JSON.stringify({ parts: options.parts }));
    }
    const service = { delayMs: options.delayMs, tokensPerSecond: options.tokensPerSecond, tokensPerPart: options.tokensPerPart,
      ratings: options.ratings };
    // Every task alone, after one call that brings the index up to date.
    const alone = spawnChild({ dir, alone: true, ...service }, dir).calls;
    const expected = new Map(alone.map((call) => [call.task, call.output]));
    const rows = [];
    for (const n of options.calls) {
      const result = spawnChild({ dir, n, ...service }, dir);
      const local = result.calls.map((call) => call.ms - call.waitMs);
      rows.push({
        n,
        ownHeapMb: MB(result.atGate.heap - result.before.heap) / n,
        ownRssMb: MB(result.atGate.rss - result.before.rss) / n,
        peakRssMb: MB(result.peakRss),
        medianS: median(result.calls.map((call) => call.ms)) / 1000,
        slowestS: Math.max(...result.calls.map((call) => call.ms)) / 1000,
        medianLocalS: median(local) / 1000,
        slowestLocalS: Math.max(...local) / 1000,
        cpuS: result.cpuMs / n / 1000,
        selected: result.calls[0].selected,
        identical: result.calls.every((call) => call.output === expected.get(call.task)),
      });
    }
    // Each task's output alone, so two builds can be compared.
    const report = { parts: options.parts, ...service,
      alone: alone.map((call) => ({ task: call.task, output: call.output, s: call.ms / 1000, cpuS: call.cpuMs / 1000,
        heapMb: Object.fromEntries(Object.entries(call.marks).map(([point, bytes]) => [point, MB(bytes)])),
        requests: call.requests })), rows };
    if (options.json) console.log(JSON.stringify(report));
    else {
      const fixed = (value, digits = 1) => value.toFixed(digits);
      console.log(`${options.parts} parts; decision service: ${options.delayMs} ms a request, ${
        options.tokensPerSecond === 0 ? 'no token limit' : `${options.tokensPerSecond} tokens a second`}, ${options.tokensPerPart} tokens a part, ${
        options.ratings} ratings`);
      // The call that brings the index up to date is not among them.
      const tasks = report.alone;
      const middle = (point) => fixed(median(tasks.map((call) => call.heapMb[point])));
      console.log(`a call alone, median of the tasks: heap ${middle('first')} MB at its first decision request, ${
        middle('peak')} MB at its highest, ${middle('picked')} MB after the pick`);
      console.log('N | own heap MB/call | own RSS MB/call | peak RSS MB | time/call s (median, slowest) | without limit wait | CPU s/call | same as alone');
      for (const row of rows) {
        console.log(`${row.n} | ${fixed(row.ownHeapMb)} | ${fixed(row.ownRssMb)} | ${fixed(row.peakRssMb, 0)} | ${fixed(row.medianS)}, ${
          fixed(row.slowestS)} | ${fixed(row.medianLocalS)}, ${fixed(row.slowestLocalS)} | ${fixed(row.cpuS)} | ${row.identical ? 'yes' : 'NO'}`);
      }
    }
    const differ = rows.filter((row) => !row.identical);
    if (differ.length > 0) {
      console.error(`check-concurrency: a call's output differs from the same task run alone at N = ${differ.map((row) => row.n).join(', ')}`);
      process.exitCode = 1;
    }
    const heavy = options.maxOwnMb === undefined ? [] : rows.filter((row) => row.ownHeapMb > options.maxOwnMb);
    if (heavy.length > 0) {
      console.error(`check-concurrency: a call's own heap is over ${options.maxOwnMb} MB at N = ${heavy.map((row) => row.n).join(', ')}`);
      process.exitCode = 1;
    }
  } finally {
    if (options.dir === undefined) rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--child') {
  const result = await child(JSON.parse(process.argv[3]));
  console.log(JSON.stringify(result));
  process.exit(0);
} else {
  await main();
}
