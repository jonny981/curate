// Builds the replay file tools/prove-decision-cache.mjs reads, from
// the saved record of a real pick. No model is called: the saved
// answers stand in for the decide port on the replayed run.
//
//   node tools/build-decision-cache-replay.mjs <record file> <candidates file> <task file> <out file>
//
// <record file>: a saved curate record, a JSON object holding `picked`
//   (the pick's PickRecord). `picked.candidates` carries every part's
//   stored answers in the pick's own order — including parts the pick
//   rejected or never asked — and the record's other fields echo the
//   options the pick ran with.
// <candidates file>: the pick's full candidate list, a JSON object
//   `{candidate_sha256, candidates}`. `candidates` is the list the
//   saved pick ran over, for example rebuilt from the source the run
//   read; `candidate_sha256` is the SHA-256 of
//   `JSON.stringify(candidates)` recorded beside the run — where the
//   run kept no hash, the file's writer computes it the same way. The
//   build recomputes the hash and refuses a mismatch, then requires
//   each recorded part to be the candidate at the same index under its
//   [sourceId, id] pair. The list cannot come from `curated.items`:
//   that record keeps only the selected references, under an id that
//   is rewritten when ids clash.
// <task file>: any JSON object holding a `task` string — the task the
//   saved run used; a record does not keep it.
// <out file>: where the replay file is written.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const [recordFile, candidatesFile, taskFile, outFile] = process.argv.slice(2);
if (!recordFile || !candidatesFile || !taskFile || !outFile) {
  console.error('usage: node tools/build-decision-cache-replay.mjs <record file> <candidates file> <task file> <out file>');
  process.exit(2);
}
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const record = read(recordFile);
const picked = record.picked;
assert(picked?.candidates, 'the record file holds no pick record under `picked`');
assert(picked.decideError === undefined,
  'the saved pick ended on a failed decide call; its record cannot replay');
assert(picked.levers?.sources !== undefined,
  'the saved pick records no per-source settings; it predates them and cannot replay');
assert(picked.labels === undefined,
  'the saved pick used the label gate; its label answers are not in the record, so the run cannot replay');
const file = read(candidatesFile);
const candidates = file?.candidates;
assert(Array.isArray(candidates), 'the candidates file holds no `candidates` list');
assert.equal(
  createHash('sha256').update(JSON.stringify(candidates)).digest('hex'),
  file.candidate_sha256,
  'the candidates do not hash to the recorded candidate_sha256');
const { task } = read(taskFile);
assert(typeof task === 'string' && task.length > 0, 'the task file holds no `task` string');
assert.equal(candidates.length, picked.candidates.length,
  'the candidates file is not the saved pick\'s full candidate list');

const pair = (sourceId, id) => JSON.stringify([sourceId, id]);
const answers = {};
const replayed = picked.candidates.map((entry, index) => {
  const candidate = candidates[index];
  assert(candidate && pair(candidate.sourceId, candidate.id) === pair(entry.sourceId, entry.id),
    `record entry ${index} (${pair(entry.sourceId, entry.id)}) is not the candidate at that index`);
  const saved = Object.fromEntries((entry.questions ?? []).map((question) => [
    question.key,
    question.status === 'answered'
      ? { status: 'answered', probability: question.probability }
      : { status: question.status, ...(question.detail === undefined ? {} : { detail: question.detail }) },
  ]));
  // A pick without a cascade asked one question per part and recorded
  // only the verdict; a tag set's answers sit under its `tags`. An
  // `applies: 'always'` rule and a part a stop left unassessed were
  // never asked, so no answer is stored for them.
  if (entry.questions === undefined) {
    if ((entry.status === 'selected' && entry.asked !== false) || entry.status === 'rejected') {
      saved[entry.role] = { status: 'answered', probability: entry.probability };
    } else if (entry.status === 'unanswered') {
      saved[entry.role] = { status: entry.answer, ...(entry.detail === undefined ? {} : { detail: entry.detail }) };
    }
  }
  for (const [set, tag] of Object.entries(entry.tags ?? {})) {
    for (const answer of tag.answers) {
      if (answer.status !== 'unassessed') {
        saved[`${set}.${answer.key}`] = answer.status === 'answered'
          ? { status: 'answered', probability: answer.probability }
          : { status: answer.status, ...(answer.detail === undefined ? {} : { detail: answer.detail }) };
      }
    }
  }
  answers[pair(entry.sourceId, entry.id)] = saved;
  return candidate;
});

// The options the saved pick ran with, read back off its record: the
// fitted cascade, each source's bars, its link bar and limits, and the
// dials the record echoes. A changed threshold on the replay reselects
// from stored answers, so `appliedReference` (an output, not an input)
// is dropped.
const sources = Object.entries(picked.levers.sources);
const options = {
  everyRanked: true,
  rare: false,
  barBySource: Object.fromEntries(sources.map(([id, settings]) => [id, settings.bar])),
  ruleBarBySource: Object.fromEntries(sources.flatMap(([id, settings]) =>
    settings.ruleBar === undefined ? [] : [[id, settings.ruleBar]])),
  ...(picked.cascade === undefined ? {} : { cascade: picked.cascade }),
  ...(picked.cascadesByKind === undefined ? {} : { cascadesByKind: picked.cascadesByKind }),
  ...(picked.sourceKinds === undefined ? {} : { sourceKinds: picked.sourceKinds }),
  ...(picked.ranking === undefined ? {} : { ranking: picked.ranking }),
  ...(picked.thresholds === undefined ? {} : {
    thresholds: { linkedPathBar: picked.thresholds.linkedPathBar },
    ...(picked.thresholds.referenceBySize === undefined ? {}
      : { everyScored: { bySize: picked.thresholds.referenceBySize } }),
  }),
  ...(picked.limits === undefined ? {} : { limits: picked.limits }),
  ...(picked.keepTop === undefined ? {} : { keepTop: picked.keepTop }),
  ...(picked.rankProtection === undefined ? {} : { rankProtection: picked.rankProtection }),
  ...(picked.bestPartFirst === undefined ? {} : { bestPartFirst: picked.bestPartFirst }),
  ...(picked.tags === undefined ? {} : { tags: picked.tags }),
  ...(picked.tagsByKind === undefined ? {} : { tagsByKind: picked.tagsByKind }),
};

writeFileSync(outFile, JSON.stringify({ task, options, candidates: replayed, answers }) + '\n');
const asked = Object.values(answers)
  .reduce((count, saved) => count + Object.values(saved)
    .filter((answer) => answer.status === 'answered').length, 0);
console.log(`${replayed.length} candidates, ${asked} saved answers, wrote ${outFile}`);
