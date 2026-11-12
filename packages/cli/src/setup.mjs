import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { main, MODEL_URL, run, SETUP_EXIT } from '../dist/run.mjs';

const COMMAND = 'curate';
const KEY_FILE = '~/.curate/credentials.env';

// The model streams to `<path>.part` and takes its name only when complete,
// so a stopped download never looks like a model.
async function download(path, fetch) {
  await mkdir(dirname(path), { recursive: true });
  console.log(`Downloading ${MODEL_URL}`);
  const response = await fetch(MODEL_URL);
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(`${path}.part`));
  await rename(`${path}.part`, path);
  console.log(`Saved ${path}.`);
}

// The settings file names a private file for the decision key. Neither file
// is ever overwritten, and neither is read.
async function createSettings() {
  const folder = join(homedir(), '.curate');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  for (const [name, text, mode] of [
    ['sources.json', `${JSON.stringify({ envFile: KEY_FILE }, null, 2)}\n`, 0o644],
    ['credentials.env', '# Put your TypeSafe key on its own line here, as TYPESAFE_API_KEY=<key>.\n', 0o600],
  ]) {
    const file = join(folder, name);
    await writeFile(file, text, { flag: 'wx', mode }).then(() => console.log(`Created ${file}.`), (error) => {
      if (error.code !== 'EEXIST') throw error;
      console.log(`Left ${file} as it was.`);
    });
  }
  console.log(`Get a decision key at https://typesafe.ai, then put it in ${KEY_FILE} as TYPESAFE_API_KEY=<key>.`);
}

// `curate setup`: the check, then, in a terminal only, an offer for each
// thing it can download or create, each answered no unless the person types
// y, then the check again. Resolves to the exit code: 0 when a call would
// run, 3 when it would not. Without a terminal it writes and fetches nothing.
export async function setup({ interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY), ask, fetch = globalThis.fetch } = {}) {
  let checked = await run(['--check'], undefined, { command: COMMAND });
  if (interactive) {
    const missing = (id) => checked.setup.status.some((entry) => entry.id === id && !entry.ready);
    const { modelPath } = checked.setup;
    const terminal = ask === undefined ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
    const yes = async (question) => /^y(es)?$/i.test((await (ask ?? ((text) => terminal.question(text)))(`${question} [y/N] `)).trim());
    try {
      let downloaded = false;
      if (missing('model') && !existsSync(modelPath)
        && await yes(`Download the recommended embedding model, EmbeddingGemma 300M (about 330 MB) to ${modelPath}?`)) {
        downloaded = await download(modelPath, fetch).then(() => true,
          (error) => { console.error(`The download stopped: ${error.message}.`); return false; });
      }
      if (missing('key') && !existsSync(join(homedir(), '.curate/sources.json'))
        && await yes(`Create ~/.curate/sources.json, naming ${KEY_FILE} as the private file for the decision key?`)) {
        await createSettings();
      }
      if (['node', 'engine', 'sources'].every((id) => !missing(id)) && (!missing('model') || downloaded)
        && await yes('Prepare this project now? The first build reads and embeds its whole history, which can take a while.')) {
        await main(['--prepare'], { command: COMMAND });
      }
    } finally {
      terminal?.close();
    }
    console.log('\nChecking again:');
    checked = await run(['--check'], undefined, { command: COMMAND });
  }
  console.log(`To let Claude Code and Codex call Curate, install the skill: npx skills add jonny981/curate -g -a claude-code -a codex -y`);
  return checked.setup.ready ? 0 : SETUP_EXIT;
}
