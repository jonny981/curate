import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { MemoryCandidate } from '@curatejs/core';
import { chat, type ChatProvider } from '../src/index.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

/** Write each transcript to its own file and read every part back. */
async function readAll(provider: ChatProvider, files: Record<string, readonly unknown[]>, includeTools = false) {
  const root = await mkdtemp(join(tmpdir(), 'curate-chat-authors-'));
  directories.push(root);
  await mkdir(join(root, 'project'));
  for (const [name, records] of Object.entries(files)) {
    await writeFile(join(root, 'project', `${name}.jsonl`), records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  }
  const result = await chat({ providers: [provider], paths: [root], includeTools }).read({ task: 'what was asked', timeZone: 'UTC' });
  if (result.status !== 'read') throw new Error('Expected a read');
  return result.candidates;
}
const byText = (candidates: readonly MemoryCandidate[]) =>
  Object.fromEntries(candidates.map((candidate) => [candidate.text, candidate]));
const marks = (candidates: readonly MemoryCandidate[]) => Object.fromEntries(candidates.map((candidate) =>
  [candidate.text, [candidate.chat?.role, candidate.chat?.author, candidate.chat?.authorName]]));

const at = (second: number) => `2026-10-06T08:16:${String(second).padStart(2, '0')}.000+00:00`;
const user = (second: number, content: unknown, extra: Record<string, unknown> = {}) =>
  ({ type: 'user', timestamp: at(second), sessionId: 'session', message: { role: 'user', content }, ...extra });
const queued = (second: number, prompt: unknown, origin?: unknown) => ({
  type: 'attachment', timestamp: at(second), sessionId: 'session',
  attachment: { type: 'queued_command', prompt, ...(origin === undefined ? {} : { origin }), humanTurn: true, commandMode: 'prompt' },
});

describe('queued messages', () => {
  it('reads each queued message as a user part with its author and date', async () => {
    const parts = byText(await readAll('claude-code', { session: [
      user(1, 'typed while idle', { origin: { kind: 'human' } }),
      queued(2, 'typed while the agent works', { kind: 'human' }),
      queued(3, [{ type: 'text', text: 'first block' }, { type: 'image', source: {} }, { type: 'text', text: 'second block' }], { kind: 'human' }),
      queued(4, '<task-notification>a background task finished</task-notification>', { kind: 'task-notification' }),
      { type: 'attachment', timestamp: at(5), sessionId: 'session', attachment: { type: 'edited_text_file', filename: 'a.ts', snippet: 'an edited file' } },
      { type: 'attachment', timestamp: at(6), sessionId: 'session', attachment: { type: 'hook_additional_context', content: ['hook output'] } },
    ] }));
    expect(Object.keys(parts).sort()).toEqual([
      '<task-notification>a background task finished</task-notification>',
      'first block\nsecond block', 'typed while idle', 'typed while the agent works',
    ]);
    for (const [text, second] of [['typed while the agent works', 2], ['first block\nsecond block', 3]] as const) {
      expect(parts[text]!.chat).toMatchObject({ provider: 'claude-code', sessionId: 'session', role: 'user', author: 'person' });
      expect(Date.parse(parts[text]!.date!.value)).toBe(Date.parse(at(second)));
    }
    expect(parts['<task-notification>a background task finished</task-notification>']!.chat)
      .toMatchObject({ role: 'user', author: 'tool' });
    expect(parts['typed while the agent works']!.id).toMatch(/:2:1:1$/);
  });
});

describe('who wrote each part', () => {
  it('marks every part of a Claude Code main transcript', async () => {
    expect(marks(await readAll('claude-code', { session: [
      user(1, 'human words', { origin: { kind: 'human' } }),
      user(2, 'peer words', { origin: { kind: 'peer', name: 'reviewer' } }),
      user(3, 'monitor event', { origin: { kind: 'task-notification' } }),
      user(4, 'carry on', { origin: { kind: 'auto-continuation' } }),
      user(5, 'Another Claude session sent a message:\n<agent-message from="builder">done</agent-message>'),
      user(6, 'summary of the session so far', { isCompactSummary: true }),
      user(7, 'command output', { isMeta: true }),
      user(8, 'plain words with no origin'),
      { type: 'assistant', timestamp: at(9), sessionId: 'session', message: { content: [{ type: 'text', text: 'assistant words' }] } },
    ] }))).toEqual({
      'human words': ['user', 'person', undefined],
      'peer words': ['user', 'agent', 'reviewer'],
      'monitor event': ['user', 'tool', undefined],
      'carry on': ['user', 'system', undefined],
      'Another Claude session sent a message:\n<agent-message from="builder">done</agent-message>': ['user', 'agent', 'builder'],
      'summary of the session so far': ['user', 'agent', undefined],
      'command output': ['user', 'system', undefined],
      'plain words with no origin': ['user', 'unmarked', undefined],
      'assistant words': ['assistant', 'agent', undefined],
    });
  });

  it('marks every part of a Claude Code agent transcript', async () => {
    const side = { isSidechain: true };
    expect(marks(await readAll('claude-code', { 'agent-a1': [
      user(1, 'the brief from whoever launched the agent', side),
      user(2, '<teammate-message teammate_id="team-lead">check the tests</teammate-message>', side),
      user(3, [{ type: 'tool_result', content: [{ type: 'text', text: 'tool output' }] }], side),
      user(4, 'a background task finished', { ...side, origin: { kind: 'task-notification' }, isMeta: true }),
      { type: 'assistant', timestamp: at(5), sessionId: 'session', isSidechain: true, message: { content: [{ type: 'tool_use', name: 'shell', input: { command: 'ls' } }] } },
      user(6, 'peer words in an agent transcript', { ...side, origin: { kind: 'peer', name: 'reviewer' } }),
      user(7, 'Another Claude session sent a message:\n<agent-message from="builder">done</agent-message>', side),
    ] }, true))).toEqual({
      'the brief from whoever launched the agent': ['user', 'agent', undefined],
      '<teammate-message teammate_id="team-lead">check the tests</teammate-message>': ['user', 'agent', 'team-lead'],
      'tool output': ['tool-result', 'tool', undefined],
      'a background task finished': ['user', 'agent', undefined],
      'shell\n{"command":"ls"}': ['tool-call', 'tool', undefined],
      'peer words in an agent transcript': ['user', 'agent', 'reviewer'],
      'Another Claude session sent a message:\n<agent-message from="builder">done</agent-message>': ['user', 'agent', 'builder'],
    });
  });

  it('marks every part of a Codex session by what started it', async () => {
    const meta = (id: string, source: unknown) => ({ type: 'session_meta', timestamp: at(0), payload: { id, source } });
    const message = (second: number, role: 'user' | 'assistant', text: string) => ({ type: 'response_item', timestamp: at(second),
      payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
    expect(marks(await readAll('codex', {
      cli: [meta('cli', 'cli'),
        message(1, 'user', '# AGENTS.md instructions for /repo\nbe brief'),
        message(2, 'user', '<environment_context>\n<cwd>/repo</cwd>\n</environment_context>'),
        message(3, 'user', '<user_instructions>\nbe kind\n</user_instructions>'),
        message(4, 'user', 'cli words'),
        message(5, 'assistant', 'cli answer')],
      exec: [meta('exec', 'exec'), message(1, 'user', 'exec words')],
      sub: [meta('sub', { subagent: { thread_spawn: { parent_thread_id: 'parent-1', depth: 1 } } }), message(1, 'user', 'sub-agent words')],
    }))).toEqual({
      '# AGENTS.md instructions for /repo\nbe brief': ['user', 'system', undefined],
      '<environment_context>\n<cwd>/repo</cwd>\n</environment_context>': ['user', 'system', undefined],
      '<user_instructions>\nbe kind\n</user_instructions>': ['user', 'system', undefined],
      'cli words': ['user', 'unmarked', undefined],
      'cli answer': ['assistant', 'agent', undefined],
      'exec words': ['user', 'agent', undefined],
      'sub-agent words': ['user', 'agent', 'parent-1'],
    });
  });

  it('names the author after the role in the title', async () => {
    const titles = Object.fromEntries((await readAll('claude-code', { session: [
      user(1, 'human words', { origin: { kind: 'human' } }),
      user(2, 'peer words', { origin: { kind: 'peer', name: 'team-lead' } }),
      user(3, 'monitor event', { origin: { kind: 'task-notification' } }),
      user(4, 'plain words with no origin'),
    ] })).map((candidate) => [candidate.text, candidate.title]));
    expect(titles).toEqual({
      'human words': 'claude-code session user (the person) 2026-10-06T08:16:01.000+00:00',
      'peer words': 'claude-code session user (agent team-lead) 2026-10-06T08:16:02.000+00:00',
      'monitor event': 'claude-code session user (tool) 2026-10-06T08:16:03.000+00:00',
      'plain words with no origin': 'claude-code session user 2026-10-06T08:16:04.000+00:00',
    });
  });
});
