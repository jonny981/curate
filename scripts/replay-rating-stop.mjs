// Offline check of the rating stop on a finished run's saved ratings. No
// model is called: a stand-in decide answers each part with the score the
// run saved for it, so `pick()`, with `stopWhenCold: {}`, reads the same
// fused order in its own request-sized batches and waves, and stops where
// its own rule says.
// Beside it the same saved scores are read one batch at a time in
// fixed-size batches, the rule's measured form. Both count the evidence
// they reach.
//
//   node scripts/replay-rating-stop.mjs <order dir> <parts dir> <results dir> <chat|markdown> [packages dir] > out.json
//
// <order dir>: one JSON file per question, each with `key`, `conv`,
//   `task`, `order` (the part ids in fused order, each text once),
//   `copies` (ids whose text repeats an earlier part's), `gold` (each
//   evidence unit's part ids) and `requests` (each first-round decision
//   request's `items`).
// <parts dir>: `<conv>.json` per history, each part's `id`, `session`,
//   `date` and `text`.
// <results dir>: the run's `<key>.json` per question, with
//   `pick.selected` ({ id, p }) or `pick.all` ([id, status, reason, p]);
//   a run folder whose `results` or `*/results` holds them will do. A
//   part with no saved score scores 0, as the run kept it under its bar.
// chat|markdown: the question set whose wording packs the batches: the
//   agent-transcript set's first question, or the Markdown set's four.
// [packages dir]: this repo's built packages/ directory; defaults to
//   ../packages relative to this file.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [orderDir, partsDir, resultsDir, kind,
  packagesDir = join(dirname(fileURLToPath(import.meta.url)), '../packages')] = process.argv.slice(2);
if (!orderDir || !partsDir || !resultsDir || !['chat', 'markdown'].includes(kind)) {
  console.error('usage: node scripts/replay-rating-stop.mjs <order dir> <parts dir> <results dir> <chat|markdown> [packages dir]');
  process.exit(2);
}
const load = async (name) => import(pathToFileURL(join(packagesDir, name, 'dist/index.js')));
const { pick } = await load('core');
const { AGENT_CHAT_CASCADE } = await load('chat');
const { GIT_HISTORY_CASCADE } = await load('git');
const { MARKDOWN_CASCADE } = await load('markdown');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

// The skill's request bound: Jev's 32,000-token state, three characters
// a token, less the longest question of the skill's sets.
const maxBatchChars = 32_000 * 3 - Math.max(...[AGENT_CHAT_CASCADE, GIT_HISTORY_CASCADE, MARKDOWN_CASCADE]
  .flatMap((set) => set.questions).map((q) => q.instructions.length + q.true.length + q.false.length));
// The run's set, weighted so the decision score is the first answer
// itself: the saved score is that score, and the wording packs the
// batches as the run's first round did.
const real = kind === 'chat' ? AGENT_CHAT_CASCADE : MARKDOWN_CASCADE;
const asked = kind === 'chat' ? real.questions.filter((q) => q.key === real.first) : real.questions;
const set = { bias: 0, questions: asked.map((q, index) => ({ ...q, weight: index === 0 ? 1 : 0 })) };

const FLOOR = 0.1;
const SHARE = 0.2;
const rows = readdirSync(orderDir).filter((name) => name.endsWith('.json')).sort().map((name) => readJson(join(orderDir, name)));
// The measured form's batch: the median first-round request, the last of each question left out.
const sizes = rows.flatMap((row) => row.requests.slice(0, -1).map((request) => request.items)).sort((a, b) => a - b);
const fixed = sizes[Math.floor(sizes.length / 2)];
const histories = new Map();
const resultsFolder = [resultsDir, join(resultsDir, 'results'),
  ...readdirSync(resultsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .map((entry) => join(resultsDir, entry.name, 'results'))]
  .find((folder) => {
    try {
      const pick = readJson(join(folder, `${rows[0].key}.json`)).pick;
      return pick?.selected !== undefined || pick?.all !== undefined;
    } catch { return false; }
  });

const out = [];
for (const row of rows) {
  if (!histories.has(row.conv)) histories.set(row.conv, new Map(readJson(join(partsDir, `${row.conv}.json`)).map((part) => [part.id, part])));
  const parts = histories.get(row.conv);
  const result = readJson(join(resultsFolder, `${row.key}.json`));
  const score = new Map(result.pick.selected !== undefined
    ? result.pick.selected.map((entry) => [entry.id, entry.p])
    : result.pick.all.filter(([, status]) => status === 'selected').map(([id, , , p]) => [id, p]));
  const kept = new Set(score.keys());

  const candidates = row.order.map((id, rank) => {
    const part = parts.get(id);
    return { sourceId: 'history', id, role: 'reference', title: part.session ?? '', text: part.text,
      ...(part.date ? { date: { value: part.date, meaning: 'recorded' } } : {}), signals: {}, searchRanks: [rank] };
  });
  const requests = [];
  const decide = async (batch) => {
    requests.push([...new Set(batch.questions.map((q) => q.id))]);
    return Object.fromEntries(batch.questions.map((q) => [q.key,
      { status: 'answered', probability: Math.min(1, Math.max(0, q.questionKey === asked[0].key ? score.get(q.id) ?? 0 : 0.5)) }]));
  };
  const picked = await pick(candidates, { task: row.task, decide, rare: false, stopWhenCold: {},
    questionsBySource: { history: set }, limits: { maxBatchChars } });
  const stop = picked.record.pick.stopWhenCold;
  const rated = new Set(picked.record.candidates.filter((entry) => entry.status === 'selected' || entry.status === 'rejected')
    .map((entry) => entry.id));
  // One request a batch: the set asks every question in one round.
  const upToCold = stop.cold === undefined ? rated.size : new Set(requests.slice(0, stop.cold.batch).flat()).size;

  // The measured form: fixed batches, read one at a time.
  let read = 0;
  let best = 0;
  for (let at = 0; at < row.order.length; at += fixed) {
    const top = Math.max(0, ...row.order.slice(at, at + fixed).map((id) => score.get(id) ?? 0));
    read = Math.min(row.order.length, at + fixed);
    if (top < FLOOR || top < SHARE * best) break;
    best = Math.max(best, top);
  }
  const measured = new Set(row.order.slice(0, read));

  // A copy is reached when the part whose text it repeats is.
  const text = (id) => parts.get(id)?.text;
  const first = new Map();
  for (const id of row.order) if (!first.has(text(id))) first.set(text(id), id);
  const reached = (ids) => (id) => ids.has(id) || (row.copies.includes(id) && ids.has(first.get(text(id))));
  const units = row.gold.map((unit) => unit.parts.filter((id) => kept.has(id))).filter((held) => held.length > 0);
  const found = (ids) => units.filter((held) => held.some(reached(ids))).length;

  out.push({ key: row.key, order: row.order.length, units: units.length,
    built: { rated: rated.size, waves: stop.waves, batches: stop.batches, cold: stop.cold ?? null,
      upToCold, overRead: rated.size - upToCold, found: found(rated),
      batchParts: requests.slice(0, stop.batches).map((ids) => ids.length) },
    measured: { rated: measured.size, batches: Math.ceil(read / fixed), found: found(measured) },
    ids: [...rated] });
}

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
const sum = (values) => values.reduce((total, value) => total + value, 0);
const units = sum(out.map((row) => row.units));
const builtBatches = out.flatMap((row) => row.built.batchParts);
console.error([
  `${out.length} questions; the measured form's batch: ${fixed} parts; the built code's batches: median ${
    builtBatches.sort((a, b) => a - b)[Math.floor(builtBatches.length / 2)]} parts`,
  `parts rated, mean: built ${mean(out.map((row) => row.built.rated)).toFixed(1)}, one batch at a time ${
    mean(out.map((row) => row.measured.rated)).toFixed(1)}, whole order ${mean(out.map((row) => row.order)).toFixed(1)}`,
  `read past the batch that went cold, mean: ${mean(out.map((row) => row.built.overRead)).toFixed(1)} parts`,
  `evidence units the run kept: ${units}; found: built ${sum(out.map((row) => row.built.found))}, one batch at a time ${
    sum(out.map((row) => row.measured.found))}`,
].join('\n'));
process.stdout.write(`${JSON.stringify(out)}\n`);
