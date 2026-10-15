// Pin the exact contents of every published tarball.
//
// Each package is packed with pnpm, then the tarball itself is listed, so
// what is pinned is the artifact a registry would serve, not the working
// tree. A file added to a package's `files` list or a build output that
// appears or vanishes fails here until this list is reviewed and updated.
// tsup names shared chunks by content hash, so chunk files are pinned as
// `chunk-*.js` and the hash is stripped from the packed names before the
// comparison.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const PACKAGES = {
  '@curatejs/core': 'packages/core',
  '@curatejs/chat': 'packages/chat',
  '@curatejs/git': 'packages/git',
  '@curatejs/markdown': 'packages/markdown',
};

export const EXPECTED_FILES = {
  '@curatejs/core': [
    'package/LICENSE',
    'package/README.md',
    'package/dist/chunk-*.js',
    'package/dist/chunk-*.js.map',
    'package/dist/curate.d.ts',
    'package/dist/document.d.ts',
    'package/dist/git.d.ts',
    'package/dist/index.d.ts',
    'package/dist/index.js',
    'package/dist/index.js.map',
    'package/dist/internal.d.ts',
    'package/dist/internal.js',
    'package/dist/internal.js.map',
    'package/dist/keywords.d.ts',
    'package/dist/lanes.d.ts',
    'package/dist/local-embeddings.d.ts',
    'package/dist/local-embeddings.js',
    'package/dist/local-embeddings.js.map',
    'package/dist/log-format.d.ts',
    'package/dist/meaning.d.ts',
    'package/dist/observe.d.ts',
    'package/dist/pick.d.ts',
    'package/dist/search.d.ts',
    'package/dist/source.d.ts',
    'package/dist/tags.d.ts',
    'package/dist/task.d.ts',
    'package/dist/vectors.d.ts',
    'package/package.json',
  ],
  '@curatejs/chat': [
    'package/LICENSE',
    'package/README.md',
    'package/dist/chat-rank.d.ts',
    'package/dist/chat-scrub.d.ts',
    'package/dist/chat.d.ts',
    'package/dist/defaults.d.ts',
    'package/dist/index.d.ts',
    'package/dist/index.js',
    'package/dist/index.js.map',
    'package/dist/porter.d.ts',
    'package/dist/questions.d.ts',
    'package/package.json',
  ],
  '@curatejs/git': [
    'package/LICENSE',
    'package/README.md',
    'package/dist/defaults.d.ts',
    'package/dist/git-history.d.ts',
    'package/dist/index.d.ts',
    'package/dist/index.js',
    'package/dist/index.js.map',
    'package/dist/questions.d.ts',
    'package/package.json',
  ],
  '@curatejs/markdown': [
    'package/LICENSE',
    'package/README.md',
    'package/dist/defaults.d.ts',
    'package/dist/index.d.ts',
    'package/dist/index.js',
    'package/dist/index.js.map',
    'package/dist/markdown.d.ts',
    'package/dist/questions.d.ts',
    'package/package.json',
  ],
};

function packContents(packageDir) {
  const destination = mkdtempSync(join(tmpdir(), 'curate-tarball-'));
  try {
    execFileSync('pnpm', ['pack', '--pack-destination', destination], {
      cwd: packageDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tarballs = readdirSync(destination).filter((name) => name.endsWith('.tgz'));
    if (tarballs.length !== 1) {
      throw new Error(`expected one tarball in ${destination}, found ${tarballs.length}`);
    }
    const listing = execFileSync('tar', ['-tzf', join(destination, tarballs[0])], { encoding: 'utf8' });
    return listing.trim().split('\n')
      .map((entry) => entry.replace(/chunk-[A-Z0-9]{8}\.js/, 'chunk-*.js'))
      .sort();
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
}

let failed = false;
for (const [name, dir] of Object.entries(PACKAGES)) {
  let actual;
  try {
    actual = packContents(join(root, dir));
  } catch (error) {
    console.log(`${name}: could not pack or list the tarball`);
    console.log(error.stderr ?? error.message);
    failed = true;
    continue;
  }
  const expected = [...EXPECTED_FILES[name]].sort();
  const missing = expected.filter((entry) => !actual.includes(entry));
  const extra = actual.filter((entry) => !expected.includes(entry));
  if (missing.length || extra.length) {
    failed = true;
    console.log(`${name}: the tarball does not match the pinned list`);
    for (const entry of missing) console.log(`  missing: ${entry}`);
    for (const entry of extra) console.log(`  extra:   ${entry}`);
  } else {
    console.log(`${name}: ${actual.length} files, as pinned`);
  }
}
process.exit(failed ? 1 : 0);
