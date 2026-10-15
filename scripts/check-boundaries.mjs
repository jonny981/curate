// Pin the import arrows between the workspace packages.
//
// `@curatejs/core` sits at the bottom: its sources import no other
// `@curatejs` package, because its manifest declares none. Each adapter
// package may import only what its own manifest's dependencies declare:
// `@curatejs/core`, and for `@curatejs/markdown` never `@curatejs/git`,
// which is a devDependency there so tests may use it but shipped source
// cannot. No source reaches another package through a relative path, and
// no shipped source names a test path.
//
// Every module specifier in every scanned file is read: files under a
// package's `src/` directory are shipped, files under a `tests/` directory
// or named `*.spec.*` are tests. A shipped file's bare imports must come
// from its package's dependencies, peerDependencies or
// optionalDependencies; a test file may also use devDependencies, its own
// package's and the workspace root's (the root provisions vitest for every
// package). Relative imports must resolve inside the owning package. Node
// builtins pass. Comments are stripped before specifiers are read; a
// specifier that is not a plain quoted string is out of scope by
// construction, as is one inside a template interpolation.

import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);
const sourceExtensions = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx']);
const isTestPath = (path) => /(?:^|[/\\])(?:test|tests|__tests__)[/\\]|\.(?:test|spec)\.[^/\\]+$/.test(path);

// A specifier found in code, or null when the construct holds no plain
// string (a template or computed specifier is skipped by the patterns).
function* specifiers(code) {
  const patterns = [
    /(?<![\w$.-])(?:import|export)\s+[^'"()]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /(?<![\w$.-])import\s+['"]([^'"]+)['"]/g,
    /(?<![\w$.-])(?:import\.meta\.resolve|require\.resolve|require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) yield match[1];
  }
}

// Blank out comments while keeping strings and line structure, so a `//`
// or `/*` inside a string is never read as a comment and a comment can
// never hide or fake a specifier.
function stripComments(text) {
  let out = '';
  let index = 0;
  const blank = (chunk) => chunk.replace(/[^\n]/g, ' ');
  while (index < text.length) {
    const rest = text.slice(index);
    const candidates = [rest.indexOf('//'), rest.indexOf('/*'), rest.search(/['"`]/)]
      .filter((at) => at >= 0);
    if (!candidates.length) return out + rest;
    const at = Math.min(...candidates);
    out += rest.slice(0, at);
    index += at;
    if (text.startsWith('//', index)) {
      const end = text.indexOf('\n', index);
      if (end === -1) return out + blank(text.slice(index));
      out += blank(text.slice(index, end));
      index = end;
    } else if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      if (end === -1) return out + blank(text.slice(index));
      out += blank(text.slice(index, end + 2));
      index = end + 2;
    } else {
      // A string or template literal: copy it whole. A backslash escapes
      // the next character, so the literal ends at its own mark.
      const mark = text[index];
      let cursor = index + 1;
      while (cursor < text.length && text[cursor] !== mark) {
        cursor += text[cursor] === '\\' ? 2 : 1;
      }
      out += text.slice(index, cursor + 1);
      index = cursor + 1;
    }
  }
  return out;
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, files);
    else if (sourceExtensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

// The nearest package.json at or above a path, with its directory.
const manifestCache = new Map();
function owner(file) {
  let dir = dirname(file);
  while (true) {
    if (manifestCache.has(dir)) return manifestCache.get(dir);
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      const found = { dir, manifest };
      manifestCache.set(dir, found);
      return found;
    } catch { /* keep walking up */ }
    const parent = dirname(dir);
    if (parent === dir) return { dir: root, manifest: {} };
    dir = parent;
  }
}

function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

// The scanned set: every package's shipped sources and tests, plus the
// workspace tests. Package-root config files (tsup, vitest) are build
// tooling: they ship nothing and declare nothing, so they are not read.
const files = [];
for (const pkg of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
  if (!pkg.isDirectory()) continue;
  for (const dir of ['src', 'tests']) {
    try {
      walk(join(root, 'packages', pkg.name, dir), files);
    } catch { /* the package has no such directory */ }
  }
}
walk(join(root, 'tests'), files);
const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const failures = [];

for (const file of files) {
  const shipped = !isTestPath(relative(root, file));
  const { dir: packageDir, manifest } = owner(file);
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);
  const devDeclared = new Set([
    ...declared,
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(rootManifest.devDependencies ?? {}),
  ]);
  const code = stripComments(readFileSync(file, 'utf8'));
  for (const specifier of specifiers(code)) {
    const at = relative(root, file);
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      const target = resolve(dirname(file), specifier);
      if (relative(packageDir, target).startsWith('..')) {
        failures.push(`${at}: '${specifier}' reaches outside its own package`);
        continue;
      }
      if (shipped && isTestPath(target)) {
        failures.push(`${at}: shipped source names the test path '${specifier}'`);
      }
      continue;
    }
    if (builtins.has(specifier)) continue;
    const name = packageName(specifier);
    const allowed = shipped ? declared : devDeclared;
    if (allowed.has(name)) continue;
    const devOnly = Object.keys(manifest.devDependencies ?? {}).includes(name);
    failures.push(`${at}: imports '${name}', which ${manifest.name ?? 'its package'} does not declare`
      + (devOnly ? ' (a devDependency: tests may use it, shipped source cannot)' : ''));
  }
}

if (failures.length) {
  console.log('check:boundaries failed');
  for (const failure of failures) console.log(`  ${failure}`);
  process.exit(1);
}
console.log(`check:boundaries: ${files.length} files scanned, every arrow held`);
