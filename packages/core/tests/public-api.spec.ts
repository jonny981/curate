import { describe, expect, it } from 'vitest';

import {
  curate,
  DEFAULT_MAX_QUESTION_TEXT,
  chat,
  gitHistory,
  knowledgeBase,
  pick,
  PICK_QUESTION_VERSION,
  pickFromSources,
  rules,
  SourceReadError,
  type CandidateSource,
  type ChatOptions,
  type ChatProvider,
  type CurateOptions,
  type CurateRecord,
  type CurateResult,
  type CurateWrite,
  type GitHistoryOptions,
  type KnowledgeBaseOptions,
  type MemoryCandidate,
  type PickThresholds,
} from '../src/index.js';

describe('@curatejs/core', () => {
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
});
