// Offline measure of the short item ids' effect on curator prompt
// size. A saved curator input carries the prompt the input produced
// when each evidence item's header showed its full id; running
// curate() on the same input with a stand-in write port gives the
// prompt as it is now, `En` headers included. The script prints both
// prompts' characters, and the size of the same prompt with the id
// swap undone — the part of the difference this change accounts for,
// separate from edits the saved file predates. No model is called.
//
//   node tools/measure-short-ids.mjs <saved curator input>
//
// <saved curator input>: a JSON file holding {task, picked, prompts},
//   the shape the fixtures under packages/core/tests/fixtures/curate/
//   carry, where each `prompts` entry is {working, prompt}.
//
// The script imports the built core package: run `pnpm build` first.
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [file] = process.argv.slice(2);
if (!file) {
  console.error('usage: node tools/measure-short-ids.mjs <saved curator input.json>');
  process.exit(2);
}
const root = dirname(fileURLToPath(import.meta.url));
const { curate } = await import(pathToFileURL(join(root, '../packages/core/dist/index.js')).href);
const input = JSON.parse(readFileSync(file, 'utf8'));

console.log(`${basename(file)}: ${input.picked.selected.length} selected item(s)`);
for (const { working, prompt: saved } of input.prompts) {
  let prompt;
  const result = await curate(input.task, input.picked, {
    working,
    write: async (received) => {
      prompt ??= received;
      return '[2023-05-13] Stand-in observation (said 2023-05-20; E1)';
    },
  });
  const items = result.record.items;
  // The same prompt with this change undone: the `En` headers swapped
  // back to the items' full ids, the instruction wording back to
  // "the full item id". Its difference from `prompt` is exactly what
  // the short ids save.
  let fullIdBody = prompt.body;
  for (const [index, item] of items.entries()) {
    fullIdBody = fullIdBody.replace(`### E${index + 1} (`, `### ${item.id} (`);
  }
  const fullIdInstructions = prompt.instructions
    .replaceAll('the item id from its header', 'the full item id from its header')
    .replace('with its date and the item ids in brackets', 'with its date and id');
  const before = fullIdInstructions.length + fullIdBody.length;
  const after = prompt.instructions.length + prompt.body.length;
  const savedTotal = saved.instructions.length + saved.body.length;
  const fullIds = items.map((item) => item.id.length).reduce((a, b) => a + b, 0);
  const shortIds = items.map((_, index) => `E${index + 1}`.length).reduce((a, b) => a + b, 0);
  console.log(`\nworking=${working}`);
  console.log(`  prompt with full ids:  ${before} chars (instructions ${fullIdInstructions.length}, body ${fullIdBody.length})`);
  console.log(`  prompt with short ids: ${after} chars (instructions ${prompt.instructions.length}, body ${prompt.body.length})`);
  console.log(`  ${before - after} fewer characters, ${((before - after) / before * 100).toFixed(1)}% of the prompt;`);
  console.log(`  the items' ${fullIds} chars of full ids appear in evidence headers as ${shortIds} chars`);
  console.log(`  (the file's own saved prompt is ${savedTotal} chars; it predates edits outside this change)`);
}
