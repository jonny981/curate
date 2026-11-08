import { describe, expect, it } from 'vitest';

import { historySource, type PickCascade } from '@curatejs/core';
import { AGENT_CHAT_CASCADE, chat, chatSettings, JUDGMENT_CHAT_CASCADE } from '../src/index.js';

/** A model-scored set with invented weights, for the selection tests. */
const FITTED: PickCascade = {
  anonymousItems: true,
  model: {
    keys: ['topic_match', 'answerhood'],
    mu: [0, 2], sd: [1, 1], w: [1, 1], b: -1, bar: 0.42,
  },
  questions: [
    { key: 'topic_match', instructions: "Is this excerpt about the question's subject?",
      true: 'Same subject', false: 'Different subject' },
    { key: 'answerhood', instructions: 'Could this excerpt itself be the answer?',
      levels: ['a', 'b', 'c', 'd', 'e'] },
  ],
};

describe('JUDGMENT_CHAT_CASCADE', () => {
  it('holds the two measured judgments, anonymous items and no fitted constants', () => {
    expect(JUDGMENT_CHAT_CASCADE.anonymousItems).toBe(true);
    expect(JUDGMENT_CHAT_CASCADE.questions.map((question) => question.key))
      .toEqual(['topic_match', 'answerhood']);
    expect(JUDGMENT_CHAT_CASCADE.questions[0]).toEqual({
      key: 'topic_match',
      instructions: "Is this excerpt about the question's subject?",
      true: 'Same subject',
      false: 'Different subject',
    });
    expect(JUDGMENT_CHAT_CASCADE.questions[1]).toEqual({
      key: 'answerhood',
      instructions: 'Could this excerpt itself be the answer?',
      levels: ["can't be the answer", 'the kind asked, but not this one',
        'possible but uncertain or partial', 'likely, with some doubt', 'definitely the answer'],
    });
    for (const key of ['first', 'band', 'firstOnly', 'typed', 'written', 'named'] as const) {
      expect(JUDGMENT_CHAT_CASCADE[key]).toBeUndefined();
    }
  });

  it('fails closed while its weights file is unfitted', () => {
    expect(() => chat({ questions: JUDGMENT_CHAT_CASCADE })).toThrowError(TypeError);
    expect(() => historySource({ reader: chat(), ...chatSettings, questions: JUDGMENT_CHAT_CASCADE }))
      .toThrowError(TypeError);
  });
});

describe('chat() question and bar selection', () => {
  it('keeps AGENT_CHAT_CASCADE and the 0.0146 bar by default', () => {
    const source = chat({ id: 'a' });
    expect(source.questions).toBe(AGENT_CHAT_CASCADE);
    expect(source.bar).toBe(0.0146);
  });

  it('selects a caller question set and reads its fitted bar', () => {
    const source = chat({ id: 'a', questions: FITTED });
    expect(source.questions).toBe(FITTED);
    expect(source.bar).toBe(0.42);
  });

  it('lets an explicit bar win over the fitted bar', () => {
    expect(chat({ id: 'a', questions: FITTED, bar: 0.5 }).bar).toBe(0.5);
    expect(chat({ id: 'a', bar: 0.5 }).bar).toBe(0.5);
  });
});
