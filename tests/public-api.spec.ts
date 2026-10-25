import { asSourceReadError } from '@curatejs/core/internal';
import { describe, expect, it } from 'vitest';

import { curate, decisionFileStore, DEFAULT_MAX_QUESTION_TEXT, historySource, LABEL_KINDS, LABEL_LANE_BAR, LABEL_QUESTION_VERSION, pick, PICK_QUESTION_VERSION, pickFromSources, SourceReadError, type CandidateSource, type CurateOptions, type CurateRecord, type CurateResult, type CurateWrite, type DecisionStore, type HistorySettings, type LeverStates, type MemoryCandidate, type PickCache, type PickLabels, type PickOptions, type PickThresholds, type SourceSettings } from '@curatejs/core';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chat, CHAT_CASCADE, chatSettings, type ChatOptions, type ChatProvider } from '@curatejs/chat';
import { git, GIT_HISTORY_CASCADE, gitSettings, type GitOptions } from '@curatejs/git';
import { markdown, MARKDOWN_CASCADE, markdownSettings, knowledgeBase, rules, rulesSettings, type MarkdownOptions, type KnowledgeBaseOptions } from '@curatejs/markdown';

const uncutPick = { everyRanked: true, everyScored: true, rare: false } as const;

describe('package exports', () => {
  it('exports the curate step and its caller-supplied writer types', async () => {
    const write: CurateWrite = async () => '[2023-05-13] Visited York (said 2023-05-20; E1)';
    const options: CurateOptions = { write, working: false };
    const picked = await pick([{
      sourceId: 'notes', role: 'reference', id: 'trip', title: 'Trip',
      text: 'Visited York last Saturday.', signals: {},
      date: { value: '2023-05-20', meaning: 'recorded' },
    }], { ...uncutPick,
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
    const historyOptions: GitOptions = {
      id: 'history',
      repository: 'key',
      blame: true,
      coChange: true,
    };
    const history: CandidateSource = git('/nonexistent', historyOptions);
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
    const thresholds: PickThresholds = { linkedPathBar: 0.4 };
    const pickOptions: PickOptions = {
      task: 'Recall', everyRanked: { c: 0.68 }, everyScored: { bar: 0.05 },
      rare: { share: 0.5, bar: 0.0146 },
      decide: async (batch) => Object.fromEntries(
        batch.questions.map((q) => [q.key, { status: 'answered' as const, probability: 0.9 }])),
    };
    const decisionStore: DecisionStore = decisionFileStore('/nonexistent');
    const decisionCache: PickCache = { store: decisionStore, deciderId: 'api-test' };
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
    expect(pickOptions.everyScored).toEqual({ bar: 0.05 });
    expect(decisionCache.deciderId).toBe('api-test');
    expect(typeof decisionStore.get).toBe('function');
    expect(typeof decisionStore.set).toBe('function');
    expect(candidate.changedPaths).toHaveLength(1);
    expect(typeof pick).toBe('function');
    expect(typeof pickFromSources).toBe('function');
    expect(new SourceReadError('failed', 'x')).toBeInstanceOf(Error);
    expect(DEFAULT_MAX_QUESTION_TEXT).toBeGreaterThan(0);
    expect(PICK_QUESTION_VERSION).toContain('memory-pick');
  });

  it('exports the lever and source settings types', () => {
    const levers: LeverStates = {
      everyRanked: true, everyScored: true, route: false, rare: false,
      sources: { chat: { kind: 'chat', labels: true, rare: false, bar: 0.0146 } },
    };
    const settings: SourceSettings = levers.sources['chat']!;
    expect(settings.labels).toBe(true);
    expect(levers.everyRanked).toBe(true);
  });

  it('exports each reader\'s settings and historySource to change them', () => {
    const settings: readonly HistorySettings[] = [chatSettings, gitSettings, markdownSettings, rulesSettings];
    expect(settings).toEqual([
      { rare: false, labels: true, bar: 0.0146, questions: CHAT_CASCADE },
      { rare: true, labels: false, bar: 0.0146, questions: GIT_HISTORY_CASCADE },
      { rare: true, labels: false, bar: 0.0146, questions: MARKDOWN_CASCADE },
      { rare: true, labels: false, bar: 0.0146, questions: MARKDOWN_CASCADE, ruleBar: 0.5 },
    ]);
    const reader = chat({ providers: ['codex'], paths: ['/nonexistent'] });
    expect(reader).toMatchObject({ kind: 'chat', rare: false, bar: 0.0146, labelKinds: LABEL_KINDS, questions: CHAT_CASCADE });
    expect(historySource({ reader, rare: false, labels: false, bar: 0.0146 }).questions).toBeUndefined();
    const unlabelled = historySource({ reader, ...chatSettings, labels: false });
    expect(unlabelled).toMatchObject({ id: reader.id, kind: 'chat', rare: false, bar: 0.0146 });
    expect(unlabelled.labelKinds).toBeUndefined();
    expect(historySource({ reader: unlabelled, ...chatSettings }).labelKinds).toEqual(LABEL_KINDS);
    expect(rules('/nonexistent')).toMatchObject({ rare: true, bar: 0.0146, ruleBar: 0.5 });
    expect(historySource({ reader: rules('/nonexistent'), ...markdownSettings }).ruleBar).toBeUndefined();
  });

  it('exports the label gate, its kind questions and its option type', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'curate-api-'));
    const labels: PickLabels = { directory, deciderId: 'api-test' };
    try {
      const picked = await pick([{
        sourceId: 'notes', role: 'reference', id: 'trip', title: 'Trip',
        text: 'Visited York last Saturday.', signals: {},
      }], { ...uncutPick,
        task: 'Where did I go?', labels, labelKindsBySource: { notes: LABEL_KINDS },
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
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('exports the one Jev request builder, which the skill imports instead of keeping its own', async () => {
    const { jevRequest } = await import('@curatejs/core');
    expect(jevRequest({ task: 'task', questions: [] })).toEqual({ model: 'jev-latest', state: 'task', questions: {} });
    const skill = readFileSync(join(__dirname, '../skills/curate/run.mjs'), 'utf8');
    expect(skill).not.toContain('function jevRequest');
    expect(skill.split('\n').find((line) => line.includes("from '@curatejs/core'"))).toContain('jevRequest');
  });
});

it('keeps source error identity and cancellation across core entry points', () => {
  const cancelled = new SourceReadError('cancelled', 'Stopped');
  expect(asSourceReadError(cancelled)).toBe(cancelled);
  const failed = asSourceReadError(new Error('Unreadable'));
  expect(failed).toBeInstanceOf(SourceReadError);
  expect(failed.code).toBe('failed');
});
