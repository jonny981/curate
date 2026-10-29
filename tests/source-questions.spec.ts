import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { historySource, pick, pickFromSources, type CandidateSource, type CandidateSourceKind, type MemoryCandidate, type PickCascade, type PickCriterion, type PickDecide } from '@curatejs/core';
import { chat, chatSettings } from '@curatejs/chat';
import { git as gitSource, gitSettings } from '@curatejs/git';
import { knowledgeBase, markdownSettings, rules, rulesSettings } from '@curatejs/markdown';

const uncutPick = { everyRanked: true, everyScored: true, rare: false } as const;

const criterion = (key: string): PickCriterion => ({
  key, instructions: `Check ${key}?`, true: `${key} applies.`, false: `${key} does not apply.`,
});
const fitted = (key: string): PickCascade => ({
  bias: 0, questions: [{ ...criterion(key), weight: 1 }],
});
const candidate = (id: string, overrides: Partial<MemoryCandidate> = {}): MemoryCandidate => ({
  id, sourceId: 'notes', role: 'reference', title: id, text: `Task evidence ${overrides.sourceId ?? 'notes'}/${id}.`, signals: {}, ...overrides,
});
const answers = (probability: number): PickDecide => async ({ questions }) => Object.fromEntries(
  questions.map((q) => [q.key, { status: 'answered', probability }]),
);
const source = (id: string, kind?: CandidateSourceKind, questions?: PickCascade): CandidateSource => ({
  id: `reader-${id}`, kind, role: 'reference', ...(questions === undefined ? {} : { questions }),
  read: async () => ({ status: 'read', complete: true, candidates: [candidate('same', { sourceId: id })] }),
});

describe('questions chosen by source', () => {
  it('uses each source\'s set and its own first-question band in a mixed batch', async () => {
    const chat: PickCascade = {
      bias: 0, first: 'chat-first', band: [0.2, 0.8], firstOnly: { bias: 0, weight: 1 },
      questions: [{ ...criterion('chat-first'), weight: 1 }, { ...criterion('chat-next'), weight: 0 }],
    };
    const history: PickCascade = {
      bias: 0, first: 'history-first', band: [0.4, 0.6], firstOnly: { bias: 0, weight: 1 },
      questions: [{ ...criterion('history-first'), weight: 1 }, { ...criterion('history-next'), weight: 0 }],
    };
    const calls: string[][] = [];
    const result = await pick([
      candidate('same', { sourceId: 'conversation' }),
      candidate('same', { sourceId: 'commits' }),
      candidate('same', { sourceId: 'notes' }),
    ], { ...uncutPick,
      task: 'Choose evidence',
      sourceKinds: { conversation: 'chat', commits: 'git-history', notes: 'markdown' },
      questionsBySource: { conversation: chat, commits: history, notes: fitted('note-evidence') },
      decide: async ({ questions }) => {
        calls.push(questions.map((q) => `${q.sourceId}:${q.questionKey}`));
        expect(new Set(questions.map((q) => q.key)).size).toBe(questions.length);
        return Object.fromEntries(questions.map((q) => [q.key, {
          status: 'answered', probability: q.sourceId === 'conversation' ? 0.1 : q.sourceId === 'commits' ? 0.5 : 0.9,
        }]));
      },
    });
    expect(calls).toEqual([
      ['conversation:chat-first', 'commits:history-first', 'notes:note-evidence'],
      ['commits:history-next'],
    ]);
    expect(result.selected.map((c) => c.sourceId)).toEqual(['notes', 'commits', 'conversation']);
    expect(result.record.candidates.map((c) => c.sourceKind)).toEqual(['chat', 'git-history', 'markdown']);
    expect(result.record.candidates[0]?.questions).toEqual([
      { key: 'chat-first', status: 'answered', probability: 0.1 }, { key: 'chat-next', status: 'missing' },
    ]);
    expect(result.record.candidates[1]).toMatchObject({ probability: 0.5 });
  });

  it('keeps each source on its own set whatever its kind', async () => {
    const calls: string[][] = [];
    const result = await pick([
      candidate('a', { sourceId: 'conversation' }),
      candidate('b', { sourceId: 'notes' }),
      candidate('c', { sourceId: 'unknown' }),
    ], { ...uncutPick,
      task: 'Choose evidence',
      questionsBySource: { conversation: fitted('chat'), notes: fitted('shared'), unknown: fitted('shared') },
      sourceKinds: { conversation: 'chat', notes: 'markdown' },
      decide: async (batch, signal) => {
        calls.push(batch.questions.map((q) => `${q.sourceId}:${q.questionKey}`));
        return answers(0.9)(batch, signal);
      },
    });
    expect(calls).toEqual([['conversation:chat', 'notes:shared', 'unknown:shared']]);
    expect(result.selected).toHaveLength(3);
    expect(result.record.candidates[2]).not.toHaveProperty('sourceKind');
    expect(result.record.levers.sources.conversation?.questions).toEqual(fitted('chat'));
    expect(result.record.levers.sources.unknown?.questions).toEqual(fitted('shared'));
    expect(result.record).not.toHaveProperty('sourceKinds');
  });

  it('uses the ordinary question for a source without a set', async () => {
    const asked: (string | undefined)[] = [];
    const result = await pick([candidate('a', { sourceId: 'conversation' }), candidate('b')], { ...uncutPick,
      task: 'Choose evidence', questionsBySource: { conversation: fitted('chat') },
      sourceKinds: { conversation: 'chat', notes: 'markdown' },
      decide: async (batch, signal) => {
        asked.push(...batch.questions.map((q) => q.questionKey));
        return answers(0.9)(batch, signal);
      },
    });
    expect(asked).toEqual(['chat', undefined]);
    expect(result.record.candidates[1]).not.toHaveProperty('questions');
    expect(result.selected).toHaveLength(2);
  });

  it('routes each source\'s questions and declared kind even when reader and candidate identities differ', async () => {
    const calls: string[][] = [];
    const result = await pickFromSources([
      source('conversation', 'chat', fitted('chat')), source('commits', 'git-history', fitted('history')),
      source('notes', 'markdown', fitted('note')), source('custom', undefined, fitted('note')),
    ], { task: 'Choose evidence', wholeLanes: true }, { ...uncutPick,
      task: 'Choose evidence',
      sourceKinds: { custom: 'markdown', conversation: 'markdown' },
      decide: async (batch, signal) => {
        calls.push(batch.questions.map((q) => `${q.sourceId}:${q.questionKey}`));
        return answers(0.9)(batch, signal);
      },
    });
    expect(calls).toEqual([['conversation:chat', 'commits:history', 'notes:note', 'custom:note']]);
    expect(result.record.candidates.map((entry) => entry.sourceKind)).toEqual(['chat', 'git-history', 'markdown', 'markdown']);
    expect(result.record.levers.sources.custom?.questions).toEqual(fitted('note'));
    expect(result.selected).toHaveLength(4);
  });

  it('routes source identities that also name built-in object properties', async () => {
    const asked: (string | undefined)[] = [];
    const result = await pickFromSources([source('__proto__', 'chat', fitted('chat')), source('constructor')], { task: 'Choose evidence', wholeLanes: true }, { ...uncutPick,
      task: 'Choose evidence',
      decide: async (batch, signal) => {
        asked.push(...batch.questions.map((q) => q.questionKey));
        return answers(0.9)(batch, signal);
      },
    });
    expect(asked).toEqual(['chat', undefined]);
    expect(result.record.candidates[0]?.sourceKind).toBe('chat');
    expect(result.record.candidates[1]).not.toHaveProperty('sourceKind');
    expect(result.record.levers.sources.constructor).not.toHaveProperty('questions');
  });

  it('keeps shared questions and records each part\'s kind but no kind map without tag sets', async () => {
    const candidates = [candidate('a'), candidate('b')];
    const original = await pick(candidates, { ...uncutPick, task: 'Choose evidence', questionsBySource: { notes: fitted('shared') }, decide: answers(0.9) });
    const disabled = await pick(candidates, { ...uncutPick,
      task: 'Choose evidence', questionsBySource: { notes: fitted('shared') }, decide: answers(0.9),
      sourceKinds: { notes: 'chat' },
    });
    expect(disabled.selected).toEqual(original.selected);
    expect(disabled.record.candidates.map((entry) => entry.questions)).toEqual(
      original.record.candidates.map((entry) => entry.questions));
    expect(disabled.record.candidates[0]?.sourceKind).toBe('chat');
    expect(disabled.record).not.toHaveProperty('sourceKinds');
    const read = await pickFromSources([source('notes', 'chat', fitted('shared'))], { task: 'Choose evidence', wholeLanes: true }, { ...uncutPick,
      task: 'Choose evidence', decide: answers(0.9),
    });
    expect(read.record).not.toHaveProperty('sourceKinds');
    expect(read.record.candidates[0]?.sourceKind).toBe('chat');
    expect(read.record.candidates[0]?.questions?.[0]?.key).toBe('shared');
  });
});

describe('rule questions', () => {
  it('does not apply reference question sets to rules', async () => {
    const asked: string[] = [];
    const result = await pick([
      candidate('always', { role: 'rule', applies: 'always' }),
      candidate('applies', { role: 'rule' }), candidate('irrelevant', { role: 'rule' }), candidate('reference'),
    ], { ...uncutPick,
      task: 'Choose evidence',
      questionsBySource: { notes: fitted('evidence') }, ruleBarBySource: { notes: 0.8 },
      decide: async ({ questions }) => {
        asked.push(...questions.map((q) => `${q.id}:${q.questionKey ?? q.role}`));
        return Object.fromEntries(questions.map((q) => [q.key, {
          status: 'answered', probability: q.id === 'applies' ? 0.8 : q.id === 'irrelevant' ? 0.7 : 0.9,
        }]));
      },
    });
    expect(asked).toEqual(['applies:rule', 'irrelevant:rule', 'reference:evidence']);
    expect(result.selected.map((c) => c.id)).toEqual(['always', 'applies', 'reference']);
    expect(result.record.candidates[0]).toMatchObject({ status: 'selected', asked: false });
    expect(result.record.candidates.slice(0, 3).every((c) => !('questions' in c))).toBe(true);
    expect(result.record.rulesCoverage).toBe('complete');
  });

});

describe('built-in source routing', () => {
  it('declares each built-in source kind without reading files', () => {
    expect(chat({ paths: ['fixture'] }).kind).toBe('chat');
    expect(gitSource('fixture').kind).toBe('git-history');
    expect(knowledgeBase('fixture').kind).toBe('markdown');
    expect(rules('fixture').kind).toBe('markdown');
  });

  it('reads chat, history, notes and rules together and routes their actual candidates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'curate-source-questions-'));
    try {
      for (const name of ['notes', 'policy', 'transcripts']) await mkdir(join(directory, name));
      await writeFile(join(directory, 'notes', 'guide.md'), '## Evidence\nValidate inputs before saving.\n');
      await writeFile(join(directory, 'policy', 'rules.md'), '## Policy\nReject invalid inputs.\n');
      await writeFile(join(directory, 'transcripts', 'session.jsonl'), [
        { type: 'session_meta', timestamp: '2026-01-01T10:00:00Z', payload: { id: 'session-one' } },
        {
          type: 'response_item', timestamp: '2026-01-01T10:01:00Z',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Validate inputs.' }] },
        },
      ].map((record) => JSON.stringify(record)).join('\n') + '\n');
      const git = (...args: string[]) => execFileSync('git', ['-C', directory, '-c', 'core.hooksPath=/dev/null', ...args], {
        env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
          GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
        stdio: 'pipe',
      });
      git('init', '-b', 'main');
      git('add', 'notes', 'policy');
      git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Document input validation');
      const readers = [
        historySource({ reader: chat({ paths: [join(directory, 'transcripts')], providers: ['codex'] }), ...chatSettings, labels: false, questions: fitted('chat') }),
        historySource({ reader: gitSource(directory), ...gitSettings, questions: fitted('history') }),
        historySource({ reader: knowledgeBase(join(directory, 'notes')), ...markdownSettings, questions: fitted('note') }),
        historySource({ reader: rules(join(directory, 'policy')), ...rulesSettings, questions: fitted('note') }),
      ];
      const kindFor = new Map(readers.map((reader) => [reader.id, reader.kind]));
      const asked: string[] = [];
      const result = await pickFromSources(readers, { task: 'Validate inputs' }, { ...uncutPick,
        task: 'Validate inputs',
        decide: async ({ questions }) => Object.fromEntries(questions.map((q) => {
          const kind = kindFor.get(q.sourceId);
          asked.push(`${kind}:${q.questionKey ?? q.role}`);
          if (q.role === 'rule') expect(q.questionKey).toBeUndefined();
          else {
            expect(q.questionKey).toBe(kind === 'chat' ? 'chat' : kind === 'git-history' ? 'history' : 'note');
          }
          return [q.key, { status: 'answered', probability: q.role === 'rule' ? 0.8
            : 0.5 }];
        })),
      });
      expect(result.reads.every((read) => read.status === 'read')).toBe(true);
      expect(asked).toEqual(expect.arrayContaining(['chat:chat', 'git-history:history', 'markdown:note', 'markdown:rule']));
      expect(result.record.candidates.filter((entry) => entry.sourceKind === 'chat')).toEqual([
        expect.objectContaining({ status: 'selected', probability: 0.5 }),
      ]);
      expect(result.selected.some((entry) => kindFor.get(entry.sourceId) === 'git-history')).toBe(true);
      expect(result.selected.some((entry) => kindFor.get(entry.sourceId) === 'markdown' && entry.role === 'reference')).toBe(true);
      expect(result.selected.some((entry) => entry.role === 'rule')).toBe(true);
      expect(result.record.rulesCoverage).toBe('complete');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe('limits across source questions', () => {
  it('shares candidate and batch limits across fitted assessment calls', async () => {
    const calls: number[] = [];
    const result = await pick([candidate('a'), candidate('b'), candidate('c')], { ...uncutPick,
      task: 'Choose evidence', questionsBySource: { notes: { bias: 0, questions: [{ ...criterion('one'), weight: 1 }, { ...criterion('two'), weight: 1 }] } }, limits: { maxCandidates: 2, maxPerBatch: 1, maxBatches: 3 },
      decide: async (batch, signal) => { calls.push(batch.questions.length); return answers(0.5)(batch, signal); },
    });
    expect(calls).toEqual([1, 1, 1]);
    expect(result.selected.map((c) => c.id)).toEqual(['a']);
    expect(result.record.candidates[1]).toMatchObject({ status: 'unassessed', reason: 'limits' });
    expect(result.record.candidates[2]).toMatchObject({ status: 'unassessed', reason: 'limits' });
  });

  it('leaves incomplete fitted assessments unassessed when later questions cannot run', async () => {
    let calls = 0;
    const result = await pick([candidate('a')], { ...uncutPick,
      task: 'Choose evidence',
      questionsBySource: {
        notes: { bias: 0, questions: [{ ...criterion('one'), weight: 1 }, { ...criterion('two'), weight: 1 }] },
      },
      limits: { maxPerBatch: 1, maxBatches: 1 },
      decide: async (batch, signal) => { calls++; return answers(0.5)(batch, signal); },
    });
    expect(calls).toBe(1);
    expect(result.record.candidates[0]).toMatchObject({ status: 'unassessed', reason: 'limits' });
  });

  it('leaves fitted assessment unassessed if cancellation arrives after its first question', async () => {
    const controller = new AbortController();
    let calls = 0;
    const result = await pick([candidate('a')], { ...uncutPick,
      task: 'Choose evidence', questionsBySource: { notes: { bias: 0, first: 'one', band: [0.1, 0.9], firstOnly: { bias: 0, weight: 1 }, questions: [{ ...criterion('one'), weight: 1 }, { ...criterion('two'), weight: 1 }] } }, signal: controller.signal,
      decide: async (batch, signal) => { calls++; controller.abort(); return answers(0.5)(batch, signal); },
    });
    expect(calls).toBe(1);
    expect(result.selected).toEqual([]);
    expect(result.record.candidates[0]).toMatchObject({ status: 'unassessed', reason: 'cancelled' });
  });

  it('uses the same elapsed budget for fitted questions', async () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      let calls = 0;
      const result = await pick([candidate('a')], { ...uncutPick,
        task: 'Choose evidence', questionsBySource: { notes: { bias: 0, first: 'one', band: [0.1, 0.9], firstOnly: { bias: 0, weight: 1 }, questions: [{ ...criterion('one'), weight: 1 }, { ...criterion('two'), weight: 1 }] } }, limits: { maxElapsedMs: 10 },
        decide: async (batch, signal) => { calls++; now += 10; return answers(0.5)(batch, signal); },
      });
      expect(calls).toBe(1);
      expect(result.record.candidates[0]).toMatchObject({ status: 'unassessed', reason: 'time' });
    } finally { clock.mockRestore(); }
  });

  it('records a fitted question that never finishes before the time limit', async () => {
    const result = await pick([candidate('a')], { ...uncutPick,
      task: 'Choose evidence', questionsBySource: { notes: { bias: 0, first: 'one', band: [0.1, 0.9], firstOnly: { bias: 0, weight: 1 }, questions: [{ ...criterion('one'), weight: 1 }, { ...criterion('two'), weight: 1 }] } }, limits: { maxElapsedMs: 20 },
      decide: async (batch, signal) => batch.questions[0]?.questionKey === 'two'
        ? new Promise(() => {}) : answers(0.5)(batch, signal),
    });
    expect(result.selected.map((entry) => entry.id)).toEqual(['a']);
    expect(result.record.candidates[0]).toMatchObject({
      status: 'selected', questions: [
        { key: 'one', status: 'answered', probability: 0.5 },
        { key: 'two', status: 'error' },
      ],
    });
  });
});

describe('configuration validation', () => {
  it('validates a source\'s set even when no candidate comes from that source', async () => {
    let calls = 0;
    await expect(pick([candidate('a')], { ...uncutPick,
      task: 'Choose evidence', questionsBySource: { chat: { bias: 0, questions: [] } },
      decide: async () => { calls++; return {}; },
    })).rejects.toThrow('question set');
    expect(calls).toBe(0);
  });
});
