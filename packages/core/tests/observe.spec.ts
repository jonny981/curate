import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  curate,
  observe,
  OBSERVE_INSTRUCTION_VERSION,
  observationCandidates,
  pick,
  type CuratePrompt,
  type CurateWrite,
  type MemoryCandidate,
  type ObserveStore,
} from '../src/index.js';

function part(id: string, extra: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    sourceId: 'test', id, title: id, text: `Text of ${id}`, role: 'reference',
    signals: {}, date: { value: '2023-05-20', meaning: 'recorded' }, documentId: 'doc',
    ...extra,
  };
}

/** A counting stand-in writer: it reads the sessions and items from the
 *  prompt body and answers one format-valid line per item. */
function autoWriter(reply?: (prompt: CuratePrompt, call: number) => string | undefined) {
  const calls: CuratePrompt[] = [];
  const write: CurateWrite = async (prompt) => {
    calls.push(prompt);
    const custom = reply?.(prompt, calls.length);
    if (custom !== undefined) return custom;
    return parseBody(prompt.body).map(({ name, items }) =>
      `SESSION ${name}\n${items.map(({ id, date }) =>
        `[2023-05-13] A fact about ${id} (said ${date}; ${id})`).join('\n')}`
    ).join('\n');
  };
  return { write, calls };
}

function parseBody(body: string): { name: string; items: { id: string; date: string }[] }[] {
  const sessions: { name: string; items: { id: string; date: string }[] }[] = [];
  for (const line of body.split('\n')) {
    // A repair body appends the rejected reply after the evidence; only
    // the evidence is answered.
    if (line.startsWith('REJECTED REPLY')) break;
    if (line.startsWith('SESSION ')) {
      sessions.push({ name: line.slice(8).trim(), items: [] });
      continue;
    }
    if (line.startsWith('### ')) {
      const match = /^### (.+?) \((.*)\): /.exec(line) ?? /^### (.+?): /.exec(line);
      sessions.at(-1)!.items.push({
        id: match![1]!,
        date: /^\d{4}-\d{2}-\d{2}$/.test(match![2] ?? '') ? match![2]! : '2023-05-20',
      });
    }
  }
  return sessions;
}

function memoryStore() {
  const map = new Map<string, unknown>();
  const counts = { gets: 0, sets: 0 };
  const store: ObserveStore = {
    get: async (key) => { counts.gets += 1; return map.get(key); },
    set: async (key, value) => { counts.sets += 1; map.set(key, value); },
  };
  return { map, counts, store };
}

const options = (over: Partial<Parameters<typeof observe>[1]> = {}) => ({
  write: over.write!, writerId: 'writer-1', ...over,
});

describe('observe', () => {

  it('writes each session once, then reuses the stored lines on a second observe', async () => {
    const parts = [part('p1', { documentId: 's1' }), part('p2', { documentId: 's1' }), part('p3', { documentId: 's2' })];
    const { write, calls } = autoWriter();
    const { store, counts } = memoryStore();
    const first = await observe(parts, options({ write, store }));
    expect(calls).toHaveLength(2);
    expect(first.sessions.map((session) => session.session)).toEqual(['s1', 's2']);
    expect(first.sessions[0]!.lines).toHaveLength(2);
    expect(first.record.calls).toBe(2);
    expect(first.record.writerId).toBe('writer-1');
    expect(first.record.instructionVersion).toBe(OBSERVE_INSTRUCTION_VERSION);
    const second = await observe(parts, options({ write, store }));
    expect(calls).toHaveLength(2);
    expect(counts.gets).toBe(4);
    expect(counts.sets).toBe(2);
    expect(second.sessions.map((session) => session.lines)).toEqual(first.sessions.map((session) => session.lines));
    expect(second.record.sessions.map((session) => session.outcome)).toEqual(['reused', 'reused']);
    // A full store hit packs into no calls: batchTokens never writes
    // an empty body.
    const batched = await observe(parts, options({ write, store, batchTokens: 100_000 }));
    expect(calls).toHaveLength(2);
    expect(batched.record.calls).toBe(0);
    expect(batched.sessions.map((session) => session.lines)).toEqual(first.sessions.map((session) => session.lines));
    expect(batched.record.sessions.map((session) => session.outcome)).toEqual(['reused', 'reused']);
  });

  it('observes an edited or grown session again while unchanged sessions are reused', async () => {
    const parts = [
      part('p1', { documentId: 's1' }), part('p2', { documentId: 's1' }),
      part('p3', { documentId: 's2' }), part('p4', { documentId: 's3' }),
    ];
    const { write, calls } = autoWriter();
    const { store } = memoryStore();
    await observe(parts, options({ write, store }));
    const changed = [
      { ...parts[0]!, text: 'Edited text' }, parts[1]!,
      parts[2]!, part('p5', { documentId: 's2' }), parts[3]!,
    ];
    const second = await observe(changed, options({ write, store }));
    expect(calls).toHaveLength(5);
    expect(second.record.sessions.map((session) => session.outcome)).toEqual(['written', 'written', 'reused']);
    expect(second.sessions[1]!.lines).toHaveLength(2);
    expect(second.sessions[1]!.lines.some((line) => line.includes('p5'))).toBe(true);
  });

  it('observes every session again under a different writerId or instruction version', async () => {
    const parts = [part('p1', { documentId: 's1' }), part('p2', { documentId: 's2' })];
    const { write, calls } = autoWriter();
    const { store } = memoryStore();
    await observe(parts, options({ write, store }));
    const renamed = await observe(parts, options({ write, store, writerId: 'writer-2' }));
    expect(renamed.record.sessions.map((session) => session.outcome)).toEqual(['written', 'written']);
    const versioned = await observe(parts, options({ write, store, writerId: 'writer-2', instructionVersion: 'draft-2' }));
    expect(versioned.record.sessions.map((session) => session.outcome)).toEqual(['written', 'written']);
    expect(versioned.record.instructionVersion).toBe('draft-2');
    const restored = await observe(parts, options({ write, store }));
    expect(restored.record.sessions.map((session) => session.outcome)).toEqual(['reused', 'reused']);
    expect(calls).toHaveLength(6);
  });

  it('sends a reply citing another session\'s part or lacking dates back once, then falls back to raw parts', async () => {
    const parts = [part('p1', { documentId: 's1' }), part('p2', { documentId: 's2' })];
    const { store, counts } = memoryStore();
    const replies = [
      // s1 cites p2, which belongs to s2: its session fails the check.
      'SESSION s1\n[2023-05-13] A fact (said 2023-05-20; p2)\nSESSION s2\n[2023-05-13] B fact (said 2023-05-20; p2)',
      // The repair still fails for s1, this time with an undated line.
      'SESSION s1\nno dates on this line\nSESSION s2\n[2023-05-13] B fact (said 2023-05-20; p2)',
    ];
    const { write, calls } = autoWriter((_prompt, call) => replies[call - 1]);
    const result = await observe(parts, options({ write, store, batchTokens: 100_000 }));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.instructions).toContain('rejected for its format');
    expect(calls[1]!.body).toContain('REJECTED REPLY');
    expect(calls[1]!.body).toContain(replies[0]);
    expect(result.record.repairs).toBe(1);
    expect(result.record.sessions.map((session) => session.outcome)).toEqual(['failed', 'written']);
    expect(result.record.sessions[0]!.warning).toContain('an event date, a said date, and a full item id');
    const candidates = observationCandidates(result);
    expect(candidates.map((candidate) => candidate.id)).toEqual(['p1', 's2#L1']);
    // Nothing was stored for the failed session: the next observe asks again.
    expect(counts.sets).toBe(1);
    const again = await observe(parts, options({ write: autoWriter().write, store }));
    expect(again.record.sessions.map((session) => session.outcome)).toEqual(['written', 'reused']);
  });

  it('keeps sessions that passed the first check when the repair reply omits them', async () => {
    const parts = [part('p1', { documentId: 's1' }), part('p2', { documentId: 's2' })];
    const { store, counts } = memoryStore();
    const replies = [
      // s1 cites p2, which belongs to s2: its session fails the check.
      'SESSION s1\n[2023-05-13] A fact (said 2023-05-20; p2)\nSESSION s2\n[2023-05-13] B fact (said 2023-05-20; p2)',
      // The repair answers only the failed session and leaves s2 out.
      'SESSION s1\n[2023-05-13] A fact (said 2023-05-20; p1)',
    ];
    const { write } = autoWriter((_prompt, call) => replies[call - 1]);
    const result = await observe(parts, options({ write, store, batchTokens: 100_000 }));
    expect(result.record.repairs).toBe(1);
    expect(result.record.sessions.map((session) => session.outcome)).toEqual(['written', 'written']);
    // Both sessions were stored: a passed session survives a repair
    // that names it no more.
    expect(counts.sets).toBe(2);
    const again = await observe(parts, options({ write: autoWriter().write, store }));
    expect(again.record.sessions.map((session) => session.outcome)).toEqual(['reused', 'reused']);
  });

  it('stores a session with no facts as checked when the writer answers NO FACTS, and never asks again', async () => {
    const parts = [part('p1', { documentId: 's1', text: 'Hi! How are you today?' }), part('p2', { documentId: 's2' })];
    const { store, counts } = memoryStore();
    const { write, calls } = autoWriter((prompt) =>
      prompt.body.startsWith('SESSION s1\n') ? 'SESSION s1\nNO FACTS' : undefined);
    const first = await observe(parts, options({ write, store }));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.instructions).toContain('"NO FACTS"');
    expect(first.record.repairs).toBeUndefined();
    expect(first.record.sessions[0]).toEqual({ session: 's1', parts: 1, outcome: 'written', lines: 0 });
    expect(first.sessions[0]!.lines).toEqual([]);
    expect(observationCandidates(first).map((candidate) => candidate.id)).toEqual(['s2#L1']);
    expect(counts.sets).toBe(2);
    const second = await observe(parts, options({ write, store }));
    expect(calls).toHaveLength(2);
    expect(second.record.calls).toBe(0);
    expect(second.record.sessions.map((session) => session.outcome)).toEqual(['reused', 'reused']);
    expect(second.sessions[0]!.lines).toEqual([]);
  });

  it('traces a line to only the ids it cites, never to digits inside dates', async () => {
    const parts = [part('1', { documentId: 's1' }), part('2', { documentId: 's1' })];
    const { write } = autoWriter(() => 'SESSION s1\n[2023-05-13] A fact (said 2023-05-20; 1)');
    const result = await observe(parts, options({ write }));
    const [candidate] = observationCandidates(result);
    expect(candidate!.cites).toEqual(['1']);
  });

  it('treats a corrupt file, a wrong-shaped file and an unreadable directory as misses', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'curate-observe-'));
    try {
      const parts = [part('p1', { documentId: 's1' })];
      const { write, calls } = autoWriter();
      await observe(parts, options({ write, directory }));
      const [file] = readdirSync(directory);
      expect(calls).toHaveLength(1);

      writeFileSync(join(directory, file!), 'not json at all');
      const corrupt = await observe(parts, options({ write, directory }));
      expect(corrupt.sessions[0]!.outcome).toBe('written');
      expect(calls).toHaveLength(2);

      writeFileSync(join(directory, file!), JSON.stringify({ lines: 42 }));
      const wrongShape = await observe(parts, options({ write, directory }));
      expect(wrongShape.sessions[0]!.outcome).toBe('written');
      expect(calls).toHaveLength(3);

      writeFileSync(join(directory, file!), JSON.stringify({ lines: ['[2023-01-01] Wrong (said 2023-01-01; other)'] }));
      const badLines = await observe(parts, options({ write, directory }));
      expect(badLines.sessions[0]!.outcome).toBe('written');
      expect(calls).toHaveLength(4);

      writeFileSync(join(directory, file!), JSON.stringify({ lines: ['[2023-02-30] Wrong (said 2023-05-20; p1)'] }));
      const badDate = await observe(parts, options({ write, directory }));
      expect(badDate.sessions[0]!.outcome).toBe('written');
      expect(calls).toHaveLength(5);

      const blocked = join(directory, 'blocked');
      writeFileSync(blocked, 'a file where a directory is expected');
      const unreadable = await observe(parts, options({ write, directory: blocked }));
      expect(unreadable.sessions[0]!.outcome).toBe('written');
      expect(unreadable.sessions[0]!.lines).toHaveLength(1);
      expect(unreadable.record.sessions[0]!.warning).toContain('store');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps the lines and records a warning when the store write throws', async () => {
    const parts = [part('p1', { documentId: 's1' })];
    const { write, calls } = autoWriter();
    const store: ObserveStore = {
      get: async () => undefined,
      set: async () => { throw new Error('read-only store'); },
    };
    const first = await observe(parts, options({ write, store }));
    expect(first.sessions[0]!.outcome).toBe('written');
    expect(first.sessions[0]!.lines).toHaveLength(1);
    expect(first.record.sessions[0]!.warning).toContain('read-only store');
    const second = await observe(parts, options({ write, store }));
    expect(second.sessions[0]!.outcome).toBe('written');
    expect(calls).toHaveLength(2);
  });

  it('packs whole sessions into one call within batchTokens, with an oversized session alone', async () => {
    const parts = [
      part('p1', { documentId: 's1' }), part('p2', { documentId: 's2' }),
      part('p3', { documentId: 's3' }),
      part('big', { documentId: 'big', text: 'Large text. '.repeat(500) }),
    ];
    const { write, calls } = autoWriter();
    const packed = await observe(parts, options({ write, batchTokens: 200 }));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toContain('SESSION s1');
    expect(calls[0]!.body).toContain('SESSION s3');
    expect(calls[0]!.body).not.toContain('SESSION big');
    expect(calls[1]!.body).toContain('SESSION big');
    expect(calls[1]!.body).toContain('Large text. '.repeat(500).trim());
    expect(packed.record.sessions.map((session) => session.outcome)).toEqual(['written', 'written', 'written', 'written']);
    expect(packed.record.batchTokens).toBe(200);

    const unpacked = autoWriter();
    await observe(parts, options({ write: unpacked.write }));
    expect(unpacked.calls).toHaveLength(4);
  });

  it('feeds observation candidates through pick and curate unchanged, keeping cited ids', async () => {
    const parts = [part('p1', { documentId: 's1' }), part('p2', { documentId: 's1' }), part('p3', { documentId: 's2' })];
    const { write } = autoWriter();
    const result = await observe(parts, options({ write }));
    const candidates = observationCandidates(result);
    expect(candidates.map((candidate) => candidate.id)).toEqual(['s1#L1', 's1#L2', 's2#L1']);
    expect(candidates[0]).toMatchObject({
      role: 'reference', documentId: 's1', cites: ['p1'],
      date: { value: '2023-05-13', meaning: 'effective' },
    });
    const picked = await pick(candidates, {
      task: 'What facts do I have?',
      decide: async (batch) => Object.fromEntries(
        batch.questions.map((question) => [question.key, { status: 'answered', probability: 0.9 }]),
      ),
    });
    expect(picked.selected).toHaveLength(3);
    expect(picked.selected[0]!.cites).toEqual(['p1']);
    const curated = await curate('What facts do I have?', picked, {
      write: async () => '[2023-05-13] A fact (said 2023-05-20; s1#L1)',
    });
    expect(curated.log).toContain('(said 2023-05-20; s1#L1)');
  });

  it('validates its options before any writer call', async () => {
    const { write, calls } = autoWriter();
    const parts = [part('p1')];
    await expect(observe(parts, options({ write, writerId: ' ' }))).rejects.toThrow('writerId must be a nonempty');
    await expect(observe(parts, options({ write, instructionVersion: ' ' }))).rejects.toThrow('instructionVersion');
    await expect(observe(parts, options({ write, batchTokens: 0 }))).rejects.toThrow('batchTokens must be a positive integer');
    await expect(observe(parts, options({ write, store: memoryStore().store, directory: '/tmp/x' }))).rejects.toThrow('either store or directory');
    expect(calls).toHaveLength(0);
  });
});
