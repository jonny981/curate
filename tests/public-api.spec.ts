import { asSourceReadError } from '@curatejs/core/internal';
import { describe, expect, it } from 'vitest';

import { curate, DEFAULT_MAX_QUESTION_TEXT, LABEL_KINDS, LABEL_LANE_BAR, LABEL_QUESTION_VERSION, pick, PICK_QUESTION_VERSION, pickFromSources, SourceReadError, type CandidateSource, type CurateOptions, type CurateRecord, type CurateResult, type CurateWrite, type MemoryCandidate, type PickLabels, type PickThresholds } from '@curatejs/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('exports the label gate, its kind questions and its option type', async () => {
    const labels: PickLabels = { directory: mkdtempSync(join(tmpdir(), 'curate-api-')), deciderId: 'api-test' };
    try {
      const picked = await pick([{
        sourceId: 'notes', role: 'reference', id: 'trip', title: 'Trip',
        text: 'Visited York last Saturday.', signals: {},
      }], {
        task: 'Where did I go?', labels,
        decide: async (batch) => Object.fromEntries(
          batch.questions.map((q) => [q.key, { status: 'answered', probability: 0.9 }]),
        ),
      });
      expect(LABEL_KINDS.map((kind) => kind.key)).toEqual(
        ['personal', 'owns', 'acquired', 'event', 'preference', 'habit', 'decision']);
      expect(LABEL_LANE_BAR).toBe(0.5);
      expect(LABEL_QUESTION_VERSION).toContain('labels');
      expect(picked.record.labels).toEqual({
        questionVersion: LABEL_QUESTION_VERSION, deciderId: 'api-test',
        asked: 2, reused: 0, gate: 1, failedWrites: 0,
      });
    } finally {
      rmSync(labels.directory, { recursive: true, force: true });
    }
  });
});

it('keeps source error identity and cancellation across core entry points', () => {
  const cancelled = new SourceReadError('cancelled', 'Stopped');
  expect(asSourceReadError(cancelled)).toBe(cancelled);
  const failed = asSourceReadError(new Error('Unreadable'));
  expect(failed).toBeInstanceOf(SourceReadError);
  expect(failed.code).toBe('failed');
});
