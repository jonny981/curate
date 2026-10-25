// Dry run of pick()'s `route: 'jev'` over a file of question texts.
// For each question the script runs pick() with no candidates and a
// stand-in decide that captures the request instead of answering a
// model: with labels off the four route questions go alone, so the one
// request the decide port sees is exactly the route request the pick
// would send. The script prints that request for the first three
// questions and ends with a standalone `input tokens: N` line for the
// whole file. N sums each captured request's Jev wire JSON, built by
// core's request builder (jevRequest in @curatejs/core) and
// estimated at four characters per token.
//
//   node tools/prove-route.mjs --dry-run <questions.jsonl>
//
// <questions.jsonl>: one JSON object per line with `question_id` and
//   `question`. An example file lives at
//   packages/core/tests/fixtures/route-questions.jsonl.
//
// No model is called. The real table of which questions each route
// switches on is made from fresh answers after landing, not here.
// The script imports the built core package: run `pnpm build` first.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const [flag, questionsFile] = process.argv.slice(2);
if (flag !== '--dry-run' || !questionsFile || process.argv.length !== 4) {
  console.error('usage: node tools/prove-route.mjs --dry-run <questions.jsonl>');
  process.exit(2);
}
const root = dirname(fileURLToPath(import.meta.url));
const { jevRequest, pick, ROUTE_QUESTIONS } = await import(pathToFileURL(join(root, '../packages/core/dist/index.js')).href);
const routeKeys = new Set(ROUTE_QUESTIONS.map((route) => route.key));

const questions = [];
{
  const lines = createInterface({ input: createReadStream(questionsFile), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    assert(typeof row.question_id === 'string' && typeof row.question === 'string',
      `each line needs a question_id and a question: ${line}`);
    questions.push(row);
  }
}

let tokens = 0;
const shown = [];
for (const [index, row] of questions.entries()) {
  const requests = [];
  const result = await pick([], {
    task: row.question,
    route: 'jev',
    decide: async (batch) => {
      requests.push(batch);
      return Object.fromEntries(batch.questions.map((question) => [
        question.key, { status: 'answered', probability: 0.9 },
      ]));
    },
  });
  assert.equal(requests.length, 1, `route asked once for ${row.question_id}`);
  const request = requests[0];
  assert.deepEqual(new Set(request.questions.map((question) => question.questionKey)), routeKeys,
    `the request for ${row.question_id} is not the route question set`);
  assert(result.record.route, `no route record for ${row.question_id}`);
  tokens += Math.ceil(JSON.stringify(jevRequest(request)).length / 4);
  if (index < 3) shown.push({ question_id: row.question_id, request });
}

for (const { question_id, request } of shown) {
  console.log(`=== ${question_id} ===`);
  console.log(JSON.stringify(request, null, 2));
}
console.log(`\n${questions.length} questions, one route request each.`);
console.log('input tokens are estimated from characters at four per token over each request\'s Jev wire JSON, not counted with a tokenizer.');
console.log(`input tokens: ${tokens}`);
