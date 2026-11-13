import { describe, expect, it } from 'vitest';

import { conversationRead, historySource, rankedRead, type PickCascade } from '@curatejs/core';
import { AGENT_CHAT_CASCADE, agentTranscripts, chat, chatSettings, JUDGMENT_CHAT_CASCADE } from '../src/index.js';

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
    const judgments = { name: 'judgments', questions: JUDGMENT_CHAT_CASCADE, read: rankedRead };
    expect(() => chat({ mode: judgments })).toThrowError(TypeError);
    expect(() => historySource({ reader: chat(), ...chatSettings, mode: judgments })).toThrowError(TypeError);
  });
});

describe('chat() modes', () => {
  it('reads in the agent mode by default: AGENT_CHAT_CASCADE, the 0.0146 bar and the conversation read', () => {
    expect(chat({ id: 'a' }).mode).toBe(agentTranscripts);
    expect(agentTranscripts).toMatchObject({ questions: AGENT_CHAT_CASCADE, bar: 0.0146, read: conversationRead });
  });

  it('takes a caller mode', () => {
    const mode = { name: 'fitted', questions: FITTED, read: rankedRead };
    expect(chat({ id: 'a', mode }).mode).toBe(mode);
    expect(chat({ id: 'a', mode: { ...agentTranscripts, bar: 0.5 } }).mode?.bar).toBe(0.5);
  });
});
