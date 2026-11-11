import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('runs the first README example against temporary notes and stub models', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  const snippet = /```js\n([\s\S]*?)\n```/.exec(readme)?.[1];
  expect(snippet).toContain('memory(');
  const directory = await mkdtemp(join(tmpdir(), 'curate-readme-'));
  try {
    await mkdir(join(directory, 'docs'));
    await writeFile(join(directory, 'docs/billing.md'), [
      '---', 'date: 2026-01-12', '---', '# Billing',
      'Invoices must preserve the currency recorded when the order was placed.', '',
    ].join('\n'));
    await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
    await writeFile(join(directory, 'recall.mjs'), snippet!);
    await writeFile(join(directory, 'stub-models.mjs'), `
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
const calls = [];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push(url);
  writeFileSync('calls.json', JSON.stringify(calls));
  assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(body.model, 'jev-latest');
  assert.ok(Object.keys(body.questions).length > 0);
  return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, { noul: 0.5 }])) });
};
`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const output = execFileSync(process.execPath, ['--import', './stub-models.mjs', 'recall.mjs'], {
      cwd: directory, encoding: 'utf8',
      env: { ...env, XDG_CACHE_HOME: join(directory, 'cache'), TYPESAFE_API_KEY: 'test-only' },
    });
    // The README shows the same text, with the temporary folder as /home/sam.
    const shown = /```text\n([\s\S]*?)\n```/.exec(readme)?.[1];
    expect(output.trim().replaceAll(await realpath(directory), '/home/sam')).toBe(shown);
    // One request decides the note and one rates its sentences.
    expect(JSON.parse(await readFile(join(directory, 'calls.json'), 'utf8'))).toEqual([
      'https://api.typesafe.ai/v1/systemone', 'https://api.typesafe.ai/v1/systemone',
    ]);
    console.log('README example (stub models):\n' + output.trim());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
