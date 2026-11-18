import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pickFromSources, type CandidateReadRequest, type CandidateSource, type PickDecide } from '@curatejs/core';
import { chat } from '@curatejs/chat';

// Every index connection a call opens is closed again: when the pick
// ends, when a read is cancelled before the pick, and when the decision
// service fails.
// The connections are counted where core opens them, through node:sqlite.
const sqlite = process.getBuiltinModule('node:sqlite') as unknown as { DatabaseSync: new (path: string, ...rest: unknown[]) => { close(): void } };
const Original = sqlite.DatabaseSync;
const open = new Map<object, string>();
beforeAll(() => {
  sqlite.DatabaseSync = class extends Original {
    constructor(path: string, ...rest: unknown[]) {
      super(path, ...rest);
      open.set(this, String(path));
    }
    override close() {
      super.close();
      open.delete(this);
    }
  };
});
afterAll(() => { sqlite.DatabaseSync = Original; });

const line = (role: 'user' | 'assistant', text: string) =>
  `${JSON.stringify({ type: role, sessionId: 's', timestamp: '2026-11-01T12:00:00Z', message: { role, content: text } })}\n`;
const answered: PickDecide = async (batch) => Object.fromEntries(batch.questions.map((question) =>
  [question.key, { status: 'answered', probability: 0.9 }]));

async function history(test: (source: CandidateSource, openIn: () => string[]) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'curate-connections-'));
  try {
    await mkdir(join(dir, 'history'));
    await writeFile(join(dir, 'history', 'a.jsonl'), line('user', 'orchard plan one') + line('assistant', 'orchard answer two'));
    const source = chat({ providers: ['claude-code'], paths: [join(dir, 'history')], index: { directory: join(dir, 'index') } });
    await test(source, () => [...open.values()].filter((path) => path.startsWith(dir)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('index connections', () => {
  it('are all closed when a read is cancelled after earlier reads made parts', { timeout: 60_000 }, async () => {
    await history(async (source, openIn) => {
      let reads = 0;
      const cancelled: CandidateSource = { ...source, async read(request: CandidateReadRequest, context) {
        reads += 1;
        if (reads !== 3) return source.read(request, context);
        const abort = new AbortController();
        abort.abort();
        return source.read({ ...request, signal: abort.signal }, context);
      } };
      await expect(pickFromSources([cancelled], { task: 'orchard', searchPhrases: ['orchard', 'answer'] },
        { task: 'orchard', cache: false, decide: answered })).rejects.toThrow('cancelled');
      expect(openIn()).toEqual([]);
    });
  });

  it('are all closed after a pick that ends, and one whose decisions fail', { timeout: 60_000 }, async () => {
    await history(async (source, openIn) => {
      await pickFromSources([source], { task: 'orchard' }, { task: 'orchard', cache: false, decide: answered });
      expect(openIn()).toEqual([]);
      await expect(pickFromSources([source], { task: 'orchard' }, { task: 'orchard', cache: false,
        decide: async () => { throw new Error('offline'); } })).rejects.toThrow('offline');
      expect(openIn()).toEqual([]);
    });
  });
});
