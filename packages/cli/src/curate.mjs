#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// `check`, `prepare` and `setup` name a step only when the word is the whole
// command line. Anything else, a question or the script's own flags such as
// `--sources`, goes to the script as it is.
export function route(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) return { help: true };
  if (args.length === 1 && args[0] === '--version') return { version: true };
  if (args.length === 1 && args[0] === 'setup') return { setup: true };
  if (args.length === 1 && (args[0] === 'check' || args[0] === 'prepare')) return { args: [`--${args[0]}`] };
  return { args };
}

const HELP = `Recall what was decided, tried or said before, from the history of the project you are in.

Usage:
  curate "<question>"   Print the evidence for the question, in the speakers' own words.
  curate check          List each need as ready or missing, with its fix.
  curate setup          Check, then offer to download and create what is missing.
  curate prepare        Bring the stored index and embeddings up to date.

Options:
  --sources <file>      Read this settings file in place of ~/.curate/sources.json.
  --version             Print the version.
  --help                Print this help.`;

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  // Node warns that SQLite is experimental when the stored index opens; only that warning is dropped.
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...rest) => String(warning).includes('SQLite is an experimental feature') ? undefined : emitWarning.call(process, warning, ...rest);
  const step = route(process.argv.slice(2));
  if (step.help) console.log(HELP);
  else if (step.version) console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  else if (step.setup) {
    const { setup } = await import('./setup.mjs');
    await setup().then((code) => { process.exitCode = code; },
      (error) => { console.error(error.message); process.exitCode = error.exitCode ?? 1; });
  } else await (await import('../dist/run.mjs')).main(step.args, { command: 'curate' });
}
