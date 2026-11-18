import { describe, expect, it } from 'vitest';

import { pick, type MemoryCandidate, type PickDecide } from '@curatejs/core';
import { assistantChatHistory, CHAT_CASCADE, longAssistantChats } from '../src/index.js';

/** One part of a chat with an assistant: the person's message or the assistant's reply. */
const part = (index: number, author: 'person' | 'agent'): MemoryCandidate => ({
  sourceId: 'chats', role: 'reference', id: `chat-${index}`, title: `chat ${author === 'person' ? 'user' : 'assistant'}`,
  text: `message ${index}`, signals: {}, author, searchRanks: [index],
});

/** Answers every question of a part with its rating; 0.001 when unlisted. */
const rater = (ratings: Readonly<Record<string, number>>) => {
  const asked: string[][] = [];
  const decide: PickDecide = async ({ questions }) => {
    asked.push([...new Set(questions.map((question) => question.id))]);
    return Object.fromEntries(questions.map((question) => [question.key, { status: 'answered', probability: ratings[question.id] ?? 0.001 }]));
  };
  return { asked, decide };
};

describe('the two assistant-chat modes', () => {
  it('share one set of defaults under their own names, each with a read of its own', () => {
    for (const [mode, name] of [[assistantChatHistory, 'assistant-chat-history'], [longAssistantChats, 'long-assistant-chats']] as const) {
      expect(mode).toMatchObject({ name, questions: CHAT_CASCADE, bar: 0.0146, textShare: 0.2 });
      expect(mode.needed).toBeUndefined();
    }
    expect(assistantChatHistory.read).not.toBe(longAssistantChats.read);
  });

  it('reads the person\'s own messages first, then the rest of the order', async () => {
    // The assistant's replies rank above every message the person wrote.
    const parts = [...Array.from({ length: 6 }, (_, index) => part(index, 'agent')), ...Array.from({ length: 6 }, (_, index) => part(6 + index, 'person'))];
    const { asked, decide } = rater({ 'chat-8': 0.9, 'chat-2': 0.6 });
    await pick(parts, { task: 'What did I ask about?', decide, modesBySource: { chats: assistantChatHistory }, limits: { maxPerBatch: 6 } });
    expect(asked[0]).toEqual(['chat-6', 'chat-7', 'chat-8', 'chat-9', 'chat-10', 'chat-11']);
  });

  it('stops where the ratings go cold though the call sets no stop', async () => {
    const parts = Array.from({ length: 40 }, (_, index) => part(index, index % 2 === 0 ? 'person' : 'agent'));
    const { asked, decide } = rater({ 'chat-0': 0.9 });
    const result = await pick(parts, { task: 'What did I ask about?', decide, modesBySource: { chats: longAssistantChats }, limits: { maxPerBatch: 4 } });
    const rated = new Set(asked.flat());
    expect(rated.size).toBeLessThan(40);
    const unread = result.record.candidates.filter((entry) => entry.status === 'unassessed' && 'reason' in entry && entry.reason === 'stopWhenCold');
    expect(unread.length).toBe(40 - rated.size);
    expect(result.selected.map((item) => item.id)).toContain('chat-0');
  });
});
