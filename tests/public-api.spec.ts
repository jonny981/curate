import { asSourceReadError } from '@curatejs/core/internal';
import { describe, expect, it } from 'vitest';

import { curate, DEFAULT_MAX_QUESTION_TEXT, observe, OBSERVE_INSTRUCTION_VERSION, observationCandidates, pick, PICK_QUESTION_VERSION, pickFromSources, SourceReadError, type CandidateSource, type CurateOptions, type CurateRecord, type CurateResult, type CurateWrite, type MemoryCandidate, type ObserveOptions, type ObserveResult, type ObserveStore, type PickThresholds } from '@curatejs/core';
import { chat, type ChatOptions, type ChatProvider } from '@curatejs/chat';
import { gitHistory, type GitHistoryOptions } from '@curatejs/git';
import { markdown, knowledgeBase, rules, type MarkdownOptions, type KnowledgeBaseOptions } from '@curatejs/markdown';

describe('package exports', () => {
  it('exports the curate step and its caller-supplied writer types', async () => {
    const write: CurateWrite = async () => '[2023-05-13] Visited York (said 2023-05-20; trip)';
    const options: CurateOptions = { write, working: false };
    const picked = await pick([{
      sourceId: 'notes', role: 'reference', id: 'trip', title: 'Trip',
      text: 'Visited York last Saturday.', signals: {},
      date: { value: '2023-05-20', meaning: 'recorded' },
    }], {
      task: 'Where did I go?', decide: async (batch) => Object.fromEntries(
        batch.questions.map((q) => [q.key, { status: 'answered', probability: 0.9 }]),
      ),
    });
    const result: CurateResult = await curate('Where did I go?', picked, options);
    const record: CurateRecord = result.record;
    expect(result.log).toContain('[2023-05-13]');
    expect(record.promptVersion).toBe('v4');
    expect(record.weights).toBe('tiers');
    expect(record.items[0]!.weight).toBe(0.9);
  });

  it('exports the sources, the picker, and their option types', () => {
    const historyOptions: GitHistoryOptions = {
      id: 'history',
      repository: 'key',
      blame: true,
      coChange: true,
    };
    const history: CandidateSource = gitHistory('/nonexistent', historyOptions);
    const baseOptions: KnowledgeBaseOptions = {
      maxQuestionText: 100,
      repository: 'key',
    };
    const base: CandidateSource = knowledgeBase('/nonexistent', baseOptions);
    const ruleSource: CandidateSource = rules('/nonexistent');
    const markdownOptions: MarkdownOptions = { paths: ['/nonexistent'], kind: 'instructions' };
    const instructions: CandidateSource = markdown(markdownOptions);
    const provider: ChatProvider = 'codex';
    const chatOptions: ChatOptions = {
      id: 'transcripts', providers: [provider], paths: ['/nonexistent'],
      since: '14 days', includeTools: false, maxQuestionText: 700,
    };
    const transcripts: CandidateSource = chat(chatOptions);
    const thresholds: PickThresholds = { reference: 0.6, rule: 0.6, linkedPathBar: 0.4 };
    const candidate: MemoryCandidate = {
      sourceId: 'history',
      role: 'reference',
      id: 'commit abc1234',
      title: 'a change',
      text: 'the body',
      contentRef: 'abc1234',
      changedPaths: ['docs/a.md'],
      path: 'docs/a.md',
      repository: 'key',
      signals: { recency: 1 },
    };

    expect(history.role).toBe('reference');
    expect(base.role).toBe('reference');
    expect(ruleSource.role).toBe('rule');
    expect(instructions.role).toBe('rule');
    expect(instructions.kind).toBe('markdown');
    expect(transcripts.role).toBe('reference');
    expect(transcripts.id).toBe('transcripts');
    expect(thresholds.linkedPathBar).toBe(0.4);
    expect(candidate.changedPaths).toHaveLength(1);
    expect(typeof pick).toBe('function');
    expect(typeof pickFromSources).toBe('function');
    expect(new SourceReadError('failed', 'x')).toBeInstanceOf(Error);
    expect(DEFAULT_MAX_QUESTION_TEXT).toBeGreaterThan(0);
    expect(PICK_QUESTION_VERSION).toContain('memory-pick');
  });

  it('exports the observe step, its store port and its option types', async () => {
    const values = new Map<string, unknown>();
    const store: ObserveStore = {
      get: async (key) => values.get(key),
      set: async (key, value) => { values.set(key, value); },
    };
    const write: CurateWrite = async (prompt) => prompt.body.split('\n')
      .filter((line) => line.startsWith('SESSION ') || line.startsWith('### '))
      .map((line) => line.startsWith('SESSION ')
        ? line
        : `[2023-05-13] A fact (said 2023-05-20; ${/### (.+?)(?: \(.+\))?: /.exec(line)![1]})`)
      .join('\n');
    const options: ObserveOptions = { write, writerId: 'test-writer', store };
    const result: ObserveResult = await observe([
      { sourceId: 'notes', role: 'reference', id: 'p1', title: 'p1', text: 'A part.', signals: {}, documentId: 's1' },
    ], options);
    expect(result.sessions[0]!.lines).toHaveLength(1);
    expect(result.record.writerId).toBe('test-writer');
    expect(result.record.instructionVersion).toBe(OBSERVE_INSTRUCTION_VERSION);
    const candidates = observationCandidates(result);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.id).toBe('s1#L1');
    expect(candidates[0]!.cites).toEqual(['p1']);
    const again = await observe([{ sourceId: 'notes', role: 'reference', id: 'p1', title: 'p1', text: 'A part.', signals: {}, documentId: 's1' }], options);
    expect(again.record.calls).toBe(0);
    expect(again.sessions[0]!.outcome).toBe('reused');
  });
});

it('keeps source error identity and cancellation across core entry points', () => {
  const cancelled = new SourceReadError('cancelled', 'Stopped');
  expect(asSourceReadError(cancelled)).toBe(cancelled);
  const failed = asSourceReadError(new Error('Unreadable'));
  expect(failed).toBeInstanceOf(SourceReadError);
  expect(failed.code).toBe('failed');
});
