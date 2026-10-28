import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import { memory } from '@curatejs/core';
import { chatWriter, localDecisions } from '@curatejs/core/models';
import { git as gitSource } from '@curatejs/git';
import { knowledgeBase } from '@curatejs/markdown';

const LOG = '[2026-01-12] Keep the order currency (said 2026-01-12; E1)';

/** A local model server: decision requests get log-probabilities that favour yes when
 *  the item names currency, and writer requests get a one-line log. */
function modelServer() {
  return createServer((request, response) => {
    let text = '';
    request.on('data', (chunk) => { text += chunk; });
    request.on('end', () => {
      const body = JSON.parse(text) as { logprobs?: boolean; messages: { content: string }[] };
      response.setHeader('content-type', 'application/json');
      if (!body.logprobs) {
        response.end(JSON.stringify({ choices: [{ message: { content: LOG } }] }));
        return;
      }
      const item = body.messages.at(-1)!.content.split('\nItem:\n').at(-1)!;
      const [yes, no] = /currency/i.test(item) ? [-0.01, -9] : [-9, -0.01];
      response.end(JSON.stringify({ choices: [{ message: { content: 'yes' }, logprobs: { content: [{
        token: 'yes', logprob: yes, top_logprobs: [{ token: 'yes', logprob: yes }, { token: 'no', logprob: no }],
      }] } }] }));
    });
  });
}

it('runs a whole recall against a model server on this machine', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'curate-local-'));
  const server = modelServer();
  const realFetch = globalThis.fetch;
  const hosts: string[] = [];
  try {
    vi.stubEnv('XDG_CACHE_HOME', join(directory, 'cache'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      hosts.push(new URL(input instanceof Request ? input.url : input).hostname);
      return realFetch(input, init);
    });

    const repo = join(directory, 'repo');
    const notes = join(directory, 'notes');
    await mkdir(repo);
    await mkdir(notes);
    await writeFile(join(repo, 'billing.ts'), 'export const currency = "order";\n');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', ...args], {
      env: { ...env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
        GIT_AUTHOR_DATE: '2026-01-12T10:00:00Z', GIT_COMMITTER_DATE: '2026-01-12T10:00:00Z' },
      stdio: 'pipe',
    });
    git('init', '-b', 'main');
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Keep the billing currency', '-m', 'Invoices preserve the order currency.');
    await writeFile(join(notes, 'billing.md'), '---\ndate: 2026-01-12\n---\n# Billing\nInvoices keep the order currency.\n');
    await writeFile(join(notes, 'garden.md'), '---\ndate: 2026-01-12\n---\n# Garden\nWater the billing plants on Fridays.\n');

    const embed = async (texts: readonly string[]) => texts.map((text) => (/billing/i.test(text) ? [1, 0] : [0, 1]));
    const { log, picked } = await memory({
      sources: [gitSource(repo), knowledgeBase(notes)],
      decide: localDecisions({ url: `${base}/v1/chat/completions`, model: 'local' }),
      write: chatWriter({ url: `${base}/v1/chat/completions`, model: 'local' }),
      read: { meaning: { embed } },
    }).recall('What billing constraint must this change preserve?');

    expect(log).toContain('Keep the order currency');
    const kept = picked.record.candidates.filter((item) => item.status === 'selected');
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.some((item) => item.id === 'billing.md#1')).toBe(true);
    expect(hosts.length).toBeGreaterThan(kept.length);
    expect(new Set(hosts)).toEqual(new Set(['127.0.0.1']));
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
