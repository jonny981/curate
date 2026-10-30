import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { historySource, LABEL_KINDS, pickFromSources, type LabelKind, type PickQuestion } from '@curatejs/core';
import { chat, chatSettings } from '@curatejs/chat';
import { git } from '@curatejs/git';
import { knowledgeBase, markdown, rules } from '@curatejs/markdown';

describe('source label questions', () => {
  it('gives chat the seven transcript label kinds by default, and none when its labels are off', () => {
    const source = chat({ paths: ['/nonexistent'] });
    expect(historySource({ reader: source, ...chatSettings, labels: false }).labelKinds).toBeUndefined();
    expect(source.labelKinds).toEqual(LABEL_KINDS);
    expect(source.labelKinds?.map((kind) => kind.key)).toEqual([
      'personal', 'owns', 'acquired', 'event', 'preference', 'habit', 'decision',
    ]);
  });

  it.each([
    { name: 'git history', create: () => git('/nonexistent') },
    { name: 'Markdown', create: () => markdown({ paths: ['/nonexistent'], kind: 'docs' }) },
    { name: 'knowledge notes', create: () => knowledgeBase('/nonexistent') },
    { name: 'rules', create: () => rules('/nonexistent') },
  ])('gives $name no label kinds', ({ create }) => {
    expect(create().labelKinds).toBeUndefined();
  });

  it('uses custom Markdown labels to select a part with no matching keywords', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'curate-source-labels-'));
    try {
      const docs = join(directory, 'docs');
      await mkdir(docs);
      await writeFile(join(docs, 'billing.md'), '# Billing\nBilling currency stays fixed.\n');
      await writeFile(join(docs, 'denomination.md'), '# Retained denomination\nPreserve the denomination at order creation.\n');
      const labelKinds: readonly LabelKind[] = [{
        key: 'constraint',
        name: 'a constraint',
        part: { true: 'The excerpt states a constraint.', false: 'The excerpt states no constraint.' },
      }];
      const source = { ...markdown({ paths: [docs], kind: 'docs' }), labelKinds };
      const questions: PickQuestion[] = [];
      const task = 'billing currency';
      const result = await pickFromSources([source], { task }, {
        task,
        // The label gate pulling a pool member into the decide step is
        // an everyRanked feed behavior; a level leaves it unassessed.
        everyRanked: true,
        labels: { directory: join(directory, 'cache'), deciderId: 'custom-source-labels' },
        decide: async (batch) => {
          questions.push(...batch.questions);
          return Object.fromEntries(batch.questions.map((question) =>
            [question.key, { status: 'answered', probability: 0.9 }]));
        },
      });

      expect(questions.some((question) => question.questionKey === 'constraint'
        && question.text.includes('Preserve the denomination'))).toBe(true);
      expect(result.selected.some((item) => item.text.includes('Preserve the denomination'))).toBe(true);
      expect(result.record.labelKindsBySource![source.id]).toEqual(labelKinds);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
