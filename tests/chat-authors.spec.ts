import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { chat } from '@curatejs/chat';
import { curate, pick, type CuratePrompt, type PickDecide } from '@curatejs/core';

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

const PERSON = 'keep the old exporter until March, then drop it';
const SUMMARY = 'The person wants the old exporter kept for now and removed in the spring.';

it('gives the curator the person\'s message and an agent\'s later summary of it, each marked with its author', async () => {
  root = await mkdtemp(join(tmpdir(), 'curate-chat-authors-'));
  await mkdir(join(root, 'project', 'session', 'subagents'), { recursive: true });
  const line = (record: unknown) => `${JSON.stringify(record)}\n`;
  await writeFile(join(root, 'project', 'session.jsonl'), line({ type: 'user', timestamp: '2026-10-06T08:00:00.000Z',
    sessionId: 'session', origin: { kind: 'human' }, message: { role: 'user', content: PERSON } }));
  await writeFile(join(root, 'project', 'session', 'subagents', 'agent-a1.jsonl'), line({ type: 'user', timestamp: '2026-10-07T08:00:00.000Z',
    sessionId: 'session', isSidechain: true, message: { role: 'user', content: [{ type: 'text', text: SUMMARY }] } }));

  const read = await chat({ providers: ['claude-code'], paths: [root] }).read({ task: 'When does the old exporter go?', timeZone: 'UTC' });
  if (read.status !== 'read') throw new Error('Expected a read');
  const decide: PickDecide = async ({ questions }) =>
    Object.fromEntries(questions.map((question) => [question.key, { status: 'answered' as const, probability: 0.9 }]));
  const task = 'When does the old exporter go?';
  const picked = await pick(read.candidates, { task, decide, everyRanked: true, everyScored: true, rare: false });
  expect(picked.selected.map((candidate) => candidate.text).sort()).toEqual([SUMMARY, PERSON].sort());

  const calls: CuratePrompt[] = [];
  await curate(task, picked, { write: async (prompt) => { calls.push(prompt); return ''; } });
  const blocks = calls[0]!.body.split('\n\n### ');
  const person = blocks.find((block) => block.includes(PERSON))!;
  const summary = blocks.find((block) => block.includes(SUMMARY))!;
  expect(person).toMatch(/^E\d \(2026-10-06T08:00:00\.000\+00:00, 0\.9, by the person\): claude-code session user \(the person\) 2026-10-06T08:00:00\.000\+00:00\n/);
  expect(summary).toMatch(/^E\d \(2026-10-07T08:00:00\.000\+00:00, 0\.9, by an agent\): claude-code session user \(agent\) 2026-10-07T08:00:00\.000\+00:00\n/);
  expect(calls[0]!.instructions).toContain('Words quoted as the person\'s must come from an item marked \'by the person\'.');
  expect(calls[0]!.instructions).toContain('When an item by the person and a later item by an agent say the same thing, cite the person\'s item and keep the person\'s words.');
});
