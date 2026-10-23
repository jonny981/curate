// Offline check of the pick() decision cache over a saved question:
// a pick that stores each answered decision must answer a second
// identical pick entirely from the store — the stand-in decide port is
// called zero times, and the second pick's record equals the first's
// in every entry's status and probability, not only its selection. A
// third pick at a changed reference bar must reselect from the same
// stored answers, still with zero calls. No model is called: saved
// decision answers stand in for the decide port.
//
//   node tools/prove-decision-cache.mjs <replay file>
//
// <replay file>: a JSON object {task, options, candidates, answers},
//   built from the saved record of a real pick and its full candidate
//   list by tools/build-decision-cache-replay.mjs — see that tool's
//   header. task and candidates are the pick's input, options its
//   remaining options (cascade, keepTop, thresholds, tags, limits),
//   and answers maps each part — keyed by its [sourceId, id] pair — to
//   each question's spec key (the questionKey on a fitted or tag
//   question, the role on a plain one) to the saved answer
//   ({status, probability} — non-'answered' statuses carry status and
//   any detail). A question the replay does not name fails the proof:
//   the pick may only ask what the saved run asked.
//
// The script imports the built core package: run `pnpm build` first.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const [replayFile] = process.argv.slice(2);
if (!replayFile) {
  console.error('usage: node tools/prove-decision-cache.mjs <replay file>');
  process.exit(2);
}
const root = dirname(fileURLToPath(import.meta.url));
const { pick, decisionFileStore } = await import(
  pathToFileURL(join(root, '../packages/core/dist/index.js')).href);
const uncutPick = { everyRanked: true, rare: false };
const { task, options = {}, candidates, answers } = JSON.parse(readFileSync(replayFile, 'utf8'));

let calls = 0;
const decide = async (batch) => {
  calls += 1;
  return Object.fromEntries(batch.questions.map((question) => {
    const specKey = question.questionKey ?? question.role;
    const part = JSON.stringify([question.sourceId, question.id]);
    const saved = answers[part]?.[specKey];
    assert(saved, `the replay has no saved answer for ${part} ${specKey}`);
    return [question.key, saved];
  }));
};

// Two records are equal when they differ only where reuse shows: the
// cache counter and each answer's `reused` mark. Every entry's status
// and probability must match — the check that stored answers were the
// ones returned, which a keep-all threshold alone cannot prove.
const comparable = (record) => JSON.parse(JSON.stringify(record, (key, value) =>
  key === 'cache' || key === 'reused' || key === 'elapsed' ? undefined : value));

const directory = mkdtempSync(join(tmpdir(), 'curate-decision-proof-'));
try {
  const cache = { store: decisionFileStore(directory), deciderId: 'saved-decisions' };
  const first = await pick(candidates, { ...uncutPick, task, ...options, decide, cache });
  const asked = first.record.cache.asked;
  assert(asked > 0, 'the first pick asked nothing');
  const selected = first.selected.map((candidate) => candidate.id);
  const firstCalls = calls;

  calls = 0;
  const second = await pick(candidates, { ...uncutPick, task, ...options, decide, cache });
  assert.equal(calls, 0, `the second pick made ${calls} decider calls`);
  assert.deepEqual(second.selected.map((candidate) => candidate.id), selected);
  assert.equal(second.record.cache.reused, asked);
  assert.deepEqual(comparable(second.record), comparable(first.record),
    "the second pick's record differs from the first's beyond reuse marks");

  // A changed reference bar reselects from the same stored answers:
  // still zero calls, and the selection must move, proving the stored
  // probabilities — not just their presence — drive it. The bar comes
  // off the saved run's own probabilities: between the top two bands
  // when they spread, just past the single value when they do not.
  const probabilities = [...new Set(first.record.candidates
    .filter((entry) => entry.status === 'selected')
    .map((entry) => entry.probability))].sort((a, b) => a - b);
  const bar = probabilities.length > 1
    ? (probabilities.at(-1) + probabilities.at(-2)) / 2
    : probabilities[0] + 0.01;
  const third = await pick(candidates, {
    ...uncutPick, task, ...options,
    everyScored: {
      ...(typeof options.everyScored === 'object' && options.everyScored !== null ? options.everyScored : {}),
      bar,
    },
    decide, cache,
  });
  assert.equal(calls, 0, `the pick at reference ${bar} made ${calls} decider calls`);
  assert.equal(third.record.cache.reused, asked);
  assert.notEqual(third.selected.length, selected.length,
    `a changed bar selected the same ${selected.length} parts: this replay cannot show reselection`);

  console.log(`first pick: ${asked} questions in ${firstCalls} decider calls`);
  console.log(`second pick: 0 decider calls, ${second.record.cache.reused} answers reused; records equal beyond reuse marks`);
  console.log(`selected ${selected.length} parts at the saved bar, ${third.selected.length} at reference ${bar}, both with zero calls`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
