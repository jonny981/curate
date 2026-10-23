// Offline check of the rare-word round on saved decide replies. The
// saved tuning-half decisions of a LongMemEval run show that keeping
// the parts a decision scores 0.05 or more loses answer messages, and
// that parts sharing a word rare in the history — a document frequency
// of at most 5 on an 850-part history — with a kept part held six of
// the fifteen lost messages once rescored against a 0.0146 bar. The
// dial makes that count proportional: a word is rare when its document
// frequency over the history is at most share x N, share defaulting to
// 5/850, and a pulled part joins the selection at or above the second
// bar, default 0.0146. This runs the option itself on the saved
// decisions and counts what it recovers. No model is called: the saved
// replies stand in for the decide step.
//
//   node tools/prove-rare-words.mjs <inputs dir> <coverage dir> <decider dir> [packages dir]
//
// <inputs dir>: a directory holding the question inputs:
//   bench/lib/longmemeval-source.mjs, exporting
//     longMemEvalSource(instance, {packagePath, maxSession}) to build a
//     question's candidates;
//   bench/lib/curate-adapter.mjs, exporting jevDecider(dir, {fetch}) to
//     build a decide that posts through the caller's fetch;
//   bench/lib/state.mjs, exporting hash(request) for the reply table's
//     key;
//   bench/questions/cascade.json, the fitted question set;
//   bench/results/decisions-tu-off-s<1-4>.<question_id>.curate.json,
//     the saved decide replies as {responses: {<request hash>: {text,
//     status, headers}}}.
// <coverage dir>: a directory holding
//   keep-all-input/tuning.json, the saved tuning questions as a JSON
//     array;
//   funnel-eval/coverage.mjs, exporting answerParts(instance) to map
//     each answer message to the ids of the parts that carry it.
// <decider dir>: a directory where jevDecider's own imports resolve,
//   so a replayed request carries the shape the replies were saved
//   under.
// [packages dir]: this repo's built packages/ directory; defaults to
//   ../packages relative to this file.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [benchDir, coverageDir, deciderDir,
  packagesDir = join(dirname(fileURLToPath(import.meta.url)), '../packages')] = process.argv.slice(2);
if (!benchDir || !coverageDir || !deciderDir) {
  console.error('usage: node tools/prove-rare-words.mjs <inputs dir> <coverage dir> <decider dir> [packages dir]');
  process.exit(2);
}

process.env.TYPESAFE_API_KEY ??= 'prove-only';
const { pick } = await import(pathToFileURL(join(packagesDir, 'core/dist/index.js')));
const { longMemEvalSource } = await import(pathToFileURL(join(benchDir, 'bench/lib/longmemeval-source.mjs')));
const { jevDecider } = await import(pathToFileURL(join(benchDir, 'bench/lib/curate-adapter.mjs')));
const { hash } = await import(pathToFileURL(join(benchDir, 'bench/lib/state.mjs')));
const { answerParts } = await import(pathToFileURL(join(coverageDir, 'funnel-eval/coverage.mjs')));
const cascade = JSON.parse(readFileSync(join(benchDir, 'bench/questions/cascade.json'), 'utf8'));
const data = JSON.parse(readFileSync(join(coverageDir, 'keep-all-input/tuning.json'), 'utf8'));

let questions = 0, lost = 0, recovered = 0, added = 0, asked = 0, pulled = 0;
const detail = [];
for (const inst of data) {
  const decisionsFile = [1, 2, 3, 4]
    .map((shard) => join(benchDir, `bench/results/decisions-tu-off-s${shard}.${inst.question_id}.curate.json`))
    .find(existsSync);
  if (!decisionsFile) continue;
  const saved = JSON.parse(readFileSync(decisionsFile, 'utf8'));
  const decide = await jevDecider(deciderDir, {
    fetch: async (endpoint, wire) => {
      const request = { ...JSON.parse(wire.body), endpoint, method: wire.method, price_model: 'jev' };
      const reply = saved.responses[hash(request)];
      if (!reply) throw new Error(`replay miss for ${inst.question_id}: no saved reply`);
      return new Response(reply.text, { status: reply.status, headers: reply.headers });
    },
  });
  const candidates = await longMemEvalSource(inst, { packagePath: join(packagesDir, 'core'), maxSession: 0 });
  const picked = await pick(candidates, {
    task: `${inst.question} (asked ${inst.question_date})`,
    decide,
    cascade,
    keepTop: 0,
    everyRanked: true,
    everyScored: { bar: 0.05 },
    rare: true,
  });
  const rare = picked.record.pick?.rare;
  if (!rare) throw new Error(`no rare record for ${inst.question_id}`);
  // A pulled part was unselected after the first pass, so a pulled
  // part that ends selected is one the round added.
  const addedIds = new Set(rare.pulled.map((part) => part.id)
    .filter((id) => picked.selected.some((candidate) => candidate.id === id)));
  const firstPass = new Set(picked.selected.map((candidate) => candidate.id)
    .filter((id) => !addedIds.has(id)));
  let lostHere = 0, recoveredHere = 0;
  for (const message of answerParts(inst)) {
    if (message.parts.some((id) => firstPass.has(id))) continue;
    lostHere += 1;
    if (message.parts.some((id) => addedIds.has(id))) recoveredHere += 1;
  }
  if (lostHere > 0 || addedIds.size > 0) {
    detail.push(`  ${inst.question_id}  N=${candidates.length}  bound=${(rare.share * candidates.length).toFixed(1)}  pulled=${rare.pulled.length}  asked=${rare.asked}  added=${addedIds.size}  lost=${lostHere}  recovered=${recoveredHere}`);
  }
  questions += 1;
  lost += lostHere;
  recovered += recoveredHere;
  added += addedIds.size;
  asked += rare.asked;
  pulled += rare.pulled.length;
}

console.log(`questions:              ${questions}`);
console.log(`lost messages:          ${lost}`);
console.log(`recovered messages:     ${recovered}`);
console.log(`parts pulled in:        ${pulled} (${(pulled / questions).toFixed(1)} per question)`);
console.log(`parts asked first time: ${asked}${asked === 0 ? ' (every part reached the decide step in the first pass)' : ''}`);
console.log(`parts added:            ${added} (${(added / questions).toFixed(1)} per question)`);
console.log('questions with lost or added parts:');
for (const line of detail) console.log(line);
