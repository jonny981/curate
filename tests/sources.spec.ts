import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LABEL_KINDS, pickFromSources, SourceReadError, type CandidateReadResult, type CandidateSource, type MemoryCandidate, type PickAnswer } from '@curatejs/core';
import { git } from '@curatejs/git';

const uncutPick = { everyRanked: true, everyScored: true, rare: false } as const;

function candidate(overrides: Partial<MemoryCandidate> & Pick<MemoryCandidate, 'sourceId' | 'id'>): MemoryCandidate {
  return {
    role: 'reference',
    title: overrides.id,
    text: `text of ${overrides.sourceId}/${overrides.id}`,
    signals: { score: 1 },
    ...overrides,
  };
}

function source(
  id: string,
  role: CandidateSource['role'],
  read: () => Promise<CandidateReadResult>,
): CandidateSource {
  return { id, role, read };
}

const sayYes = async (batch: { questions: readonly { key: string }[] }) =>
  Object.fromEntries(batch.questions.map((question) => [
    question.key,
    { status: 'answered' as const, probability: 0.9 } satisfies PickAnswer,
  ]));

describe('pickFromSources', () => {
  it('reads every source and picks over the combined candidates', async () => {
    const result = await pickFromSources(
      [
        source('notes', 'reference', async () => ({
          status: 'read',
          complete: true,
          candidates: [candidate({ sourceId: 'notes', id: 'n1' })],
        })),
        source('policy', 'rule', async () => ({
          status: 'read',
          complete: true,
          candidates: [candidate({ sourceId: 'policy', id: 'r1', role: 'rule' })],
        })),
      ],
      { task: 'the task' },
      { ...uncutPick, task: 'the task', decide: sayYes },
    );

    expect(result.selected.map((item) => item.id).sort()).toEqual(['n1', 'r1']);
    expect(result.record.rulesCoverage).toBe('complete');
    expect(result.reads.map((read) => read.status)).toEqual(['read', 'read']);
  });

  it('proceeds past a git history source that reports absent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'curate-src-'));
    try {
      const result = await pickFromSources(
        [
          git(directory),
          source('notes', 'reference', async () => ({
            status: 'read',
            complete: true,
            candidates: [candidate({ sourceId: 'notes', id: 'n1' })],
          })),
        ],
        { task: 'the task' },
        { ...uncutPick, task: 'the task', decide: sayYes },
      );

      expect(result.reads[0]).toEqual({ status: 'absent', reason: 'no-history' });
      expect(result.selected.map((item) => item.id)).toEqual(['n1']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('treats an absent source as a result, not a failure', async () => {
    const result = await pickFromSources(
      [
        source('gone', 'reference', async () => ({ status: 'absent', reason: 'no directory' })),
        source('notes', 'reference', async () => ({
          status: 'read',
          complete: true,
          candidates: [candidate({ sourceId: 'notes', id: 'n1' })],
        })),
      ],
      { task: 'the task' },
      { ...uncutPick, task: 'the task', decide: sayYes },
    );

    expect(result.reads[0]).toEqual({ status: 'absent', reason: 'no directory' });
    expect(result.selected.map((item) => item.id)).toEqual(['n1']);
  });

  it('copies the read revision onto candidates that do not carry one', async () => {
    const result = await pickFromSources(
      [
        source('history', 'reference', async () => ({
          status: 'read',
          revision: 'abc123',
          complete: true,
          candidates: [
            candidate({ sourceId: 'history', id: 'a' }),
            candidate({ sourceId: 'history', id: 'b', sourceRevision: 'pinned-self' }),
          ],
        })),
      ],
      { task: 'the task' },
      { ...uncutPick, task: 'the task', decide: sayYes },
    );

    const byId = new Map(result.selected.map((item) => [item.id, item]));
    expect(byId.get('a')?.sourceRevision).toBe('abc123');
    expect(byId.get('b')?.sourceRevision).toBe('pinned-self');
  });

  it('reports incomplete coverage when a rule source read was truncated, even with every rule answered', async () => {
    const result = await pickFromSources(
      [
        source('policy', 'rule', async () => ({
          status: 'read',
          complete: false,
          partial: 'the limit kept 1 of 3 candidates',
          candidates: [candidate({ sourceId: 'policy', id: 'r1', role: 'rule' })],
        })),
      ],
      { task: 'the task' },
      { ...uncutPick, task: 'the task', decide: sayYes },
    );

    expect(result.record.rulesCoverage).toBe('incomplete');
    expect(result.selected.map((item) => item.id)).toEqual(['r1']);
  });

  it('keeps a caller-supplied rulesEnumerationComplete: false when every source read completely', async () => {
    const result = await pickFromSources(
      [
        source('policy', 'rule', async () => ({
          status: 'read',
          complete: true,
          candidates: [candidate({ sourceId: 'policy', id: 'r1', role: 'rule' })],
        })),
      ],
      { task: 'the task' },
      { ...uncutPick, task: 'the task', decide: sayYes, rulesEnumerationComplete: false },
    );

    // The caller warned that rules were omitted upstream; a clean set of
    // source reads must not turn that warning back into 'complete'.
    expect(result.record.rulesCoverage).toBe('incomplete');
  });

  it('reports incomplete coverage when a rule source is absent', async () => {
    const result = await pickFromSources(
      [
        source('policy', 'rule', async () => ({ status: 'absent', reason: 'no rules directory' })),
        source('notes', 'reference', async () => ({
          status: 'read',
          complete: true,
          candidates: [candidate({ sourceId: 'notes', id: 'n1' })],
        })),
      ],
      { task: 'the task' },
      { ...uncutPick, task: 'the task', decide: sayYes },
    );

    expect(result.record.rulesCoverage).toBe('incomplete');
    expect(result.selected.map((item) => item.id)).toEqual(['n1']);
  });

  it('lets an absent reference source leave rule coverage complete', async () => {
    const result = await pickFromSources(
      [
        source('gone', 'reference', async () => ({ status: 'absent', reason: 'no directory' })),
        source('policy', 'rule', async () => ({
          status: 'read',
          complete: true,
          candidates: [candidate({ sourceId: 'policy', id: 'r1', role: 'rule' })],
        })),
      ],
      { task: 'the task' },
      { ...uncutPick, task: 'the task', decide: sayYes },
    );

    expect(result.record.rulesCoverage).toBe('complete');
  });

  it('lets a label match rescue a reference part the keyword lane cut excluded', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'curate-labels-'));
    try {
      // The score curve keeps only the strongest part under the default
      // lane cut; 'late' never reaches the pick without the label gate.
      const read = async () => ({
        status: 'read' as const,
        complete: true,
        candidates: [
          candidate({ sourceId: 'notes', id: 'hit', signals: { score: 10 } }),
          candidate({ sourceId: 'notes', id: 'late', signals: { score: 1 } }),
          candidate({ sourceId: 'notes', id: 'low1', signals: { score: 1 } }),
          candidate({ sourceId: 'notes', id: 'low2', signals: { score: 1 } }),
        ],
      });
      const decided: string[] = [];
      const labelled: string[] = [];
      const result = await pickFromSources(
        [{ ...source('notes', 'reference', read), labelKinds: LABEL_KINDS }],
        { task: 'the task' },
        { ...uncutPick,
          task: 'the task',
          labels: { directory, deciderId: 'test-decider' },
          decide: async (batch) => {
            for (const question of batch.questions) {
              if (question.questionKey === undefined) decided.push(question.id);
              else labelled.push(question.id);
            }
            return Object.fromEntries(batch.questions.map((question) => [
              question.key,
              {
                status: 'answered' as const,
                probability: question.questionKey === undefined ? 0.9
                  : question.id === 'question' ? (question.questionKey === 'habit' ? 0.9 : 0.1)
                    : question.questionKey === 'habit' && question.id === 'late' ? 0.9 : 0.1,
              } satisfies PickAnswer,
            ]));
          },
        },
      );

      // Every pool part was labelled, but only the keyword survivor and
      // the label-lane rescue were decided.
      expect([...new Set(labelled)].sort()).toEqual(['hit', 'late', 'low1', 'low2', 'question']);
      expect([...new Set(decided)].sort()).toEqual(['hit', 'late']);
      expect(result.record.labels?.gate).toBe(2);
      expect(result.selected.map((item) => item.id).sort()).toEqual(['hit', 'late']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('lets a meaning lane rescue a pool member without the label lane', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'curate-labels-'));
    try {
      const read = async () => ({
        status: 'read' as const,
        complete: true,
        candidates: [
          candidate({ sourceId: 'notes', id: 'hit', signals: { score: 10 } }),
          candidate({ sourceId: 'notes', id: 'late', signals: { score: 1 } }),
          candidate({ sourceId: 'notes', id: 'low1', signals: { score: 1 } }),
        ],
      });
      // The embed maps 'late' onto the task and everything else away.
      const embed = async (texts: readonly string[]) =>
        texts.map((text) => (text === 'the task' || text === 'text of notes/late' ? [1, 0] : [0, 1]));
      const decided: string[] = [];
      const result = await pickFromSources(
        [{ ...source('notes', 'reference', read), labelKinds: LABEL_KINDS }],
        { task: 'the task', meaning: { embed, nearest: 1 } },
        { ...uncutPick,
          task: 'the task',
          labels: { directory, deciderId: 'test-decider' },
          decide: async (batch) => {
            for (const question of batch.questions) {
              if (question.questionKey === undefined) decided.push(question.id);
            }
            return Object.fromEntries(batch.questions.map((question) => [
              question.key,
              {
                status: 'answered' as const,
                probability: question.questionKey === undefined ? 0.9
                  : question.id === 'question' && question.questionKey === 'habit' ? 0.9 : 0.1,
              } satisfies PickAnswer,
            ]));
          },
        },
      );

      // 'late' scores below the label bar on the task's only needed
      // kind, so the meaning lane alone puts it in the decide step; the
      // other pool members stay out.
      expect([...new Set(decided)].sort()).toEqual(['hit', 'late']);
      expect(result.record.labels?.gate).toBe(2);
      expect(result.selected.map((item) => item.id).sort()).toEqual(['hit', 'late']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('clears noSearchMatch when the label pool hands back what the lane cut dropped', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'curate-labels-'));
    try {
      // No candidate scores above zero, so the lane cut keeps nothing
      // and the keyword read reports a miss; the label pool still
      // returns every part for the gate to label.
      const read = async () => ({
        status: 'read' as const,
        complete: true,
        candidates: [
          candidate({ sourceId: 'notes', id: 'a', signals: { score: 0 } }),
          candidate({ sourceId: 'notes', id: 'b', signals: { score: 0 } }),
        ],
      });
      const result = await pickFromSources(
        [{ ...source('notes', 'reference', read), labelKinds: LABEL_KINDS }],
        { task: 'the task' },
        { ...uncutPick, task: 'the task', labels: { directory, deciderId: 'test-decider' }, decide: sayYes },
      );

      const merged = result.reads[0]!;
      expect(merged.status).toBe('read');
      if (merged.status !== 'read') return;
      expect(merged.lanes).toEqual([{ task: 'the task', lane: 'search', read: 2, kept: 0 }]);
      expect(merged.candidates.map((item) => item.id).sort()).toEqual(['a', 'b']);
      expect(merged.noSearchMatch).toBeUndefined();
      expect(result.record.labels?.gate).toBe(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('propagates a source read failure', async () => {
    await expect(
      pickFromSources(
        [source('broken', 'reference', async () => {
          throw new SourceReadError('failed', 'permission denied');
        })],
        { task: 'the task' },
        { ...uncutPick, task: 'the task', decide: sayYes },
      ),
    ).rejects.toMatchObject({ name: 'SourceReadError', code: 'failed' });
  });
});
