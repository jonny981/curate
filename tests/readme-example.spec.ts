import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
  if (url === 'https://api.typesafe.ai/v1/systemone') {
    assert.equal(body.model, 'jev-latest');
    assert.ok(Object.keys(body.questions).length > 0);
    return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, { noul: 0.5 }])) });
  }
  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(body.model, 'gpt-5-mini');
  assert.match(body.messages[1].content, /Invoices must preserve the currency/);
  return Response.json({ choices: [{ message: { content: '[2026-01-12] Invoices preserve the order currency (said 2026-01-12; E1)' } }] });
};
`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const output = execFileSync(process.execPath, ['--import', './stub-models.mjs', 'recall.mjs'], {
      cwd: directory, encoding: 'utf8',
      env: { ...env, XDG_CACHE_HOME: join(directory, 'cache'), TYPESAFE_API_KEY: 'test-only', CHAT_API_KEY: 'test-only' },
    });
    expect(output).toContain('[2026-01-12] Invoices preserve the order currency');
    expect(output).toContain('billing.md#1)');
    expect(output).not.toContain('; E1)');
    expect(JSON.parse(await readFile(join(directory, 'calls.json'), 'utf8'))).toEqual([
      'https://api.typesafe.ai/v1/systemone', 'https://api.openai.com/v1/chat/completions',
    ]);
    console.log('README example (stub models):\n' + output.trim());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
