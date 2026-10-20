// Offline check of the scaled top-k dial against saved fusion
// rankings: keeping the top round(0.68 x N^0.8) parts of each saved
// ranking must keep about 99% of the answer messages at every history
// size. No model is called: the saved rankings stand in for the pick's.
//
//   node tools/prove-scaled-topk.mjs <labelpass file> <positions file>
//
// <labelpass file>: .jsonl rows of {qid, size, N, messages}, each
//   message carrying its one-based `fusion` rank in that row's
//   keyword-and-label ranking.
// <positions file>: .jsonl rows of the same shape; the union of
//   message ids at size 'f1' names the answer messages counted.
//
// The saved rankings break equal fusion scores by item id; the
// package's fused order breaks them by keyword position. This checks
// the saved rankings' coverage, not identical coverage for the
// package's own ranking.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const [labelpassFile, positionsFile] = process.argv.slice(2);
if (!labelpassFile || !positionsFile) {
  console.error('usage: node tools/prove-scaled-topk.mjs <labelpass file> <positions file>');
  process.exit(2);
}

const rowsOf = async (file) => {
  const rows = [];
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) rows.push(JSON.parse(line));
  return rows;
};

// The answer messages: every message id the full-size rows name.
const answers = new Set((await rowsOf(positionsFile))
  .filter((row) => row.size === 'f1')
  .flatMap((row) => row.messages)
  .map((message) => message.m));

const C = 0.68;
const keep = (n) => Math.min(n, Math.round(C * Math.pow(n, 0.8)));

const bySize = new Map();
for (const row of await rowsOf(labelpassFile)) {
  const entry = bySize.get(row.size) ?? { sizes: [], kept: 0, of: 0 };
  entry.sizes.push(row.N);
  for (const message of row.messages) {
    if (!answers.has(message.m)) continue;
    entry.of += 1;
    if (message.fusion <= keep(row.N)) entry.kept += 1;
  }
  bySize.set(row.size, entry);
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(`keep rule: top round(${C} x N^0.8) of the saved fusion rankings`);
console.log(`answer messages: ${answers.size}`);
console.log('\nsize   | N (median) | parts kept | answers kept');
console.log('-------|------------|------------|-------------');
for (const [size, entry] of bySize) {
  const n = median(entry.sizes);
  console.log(`${size.padEnd(6)} | ${String(n).padStart(10)} | ${String(keep(n)).padStart(10)} | ${entry.kept} of ${entry.of}`);
}
