import { conversationRead, rankedRead, type Mode } from '@curatejs/core';
import { AGENT_CHAT_CASCADE, CHAT_CASCADE } from './questions.js';

/** Coding-agent transcripts, `chat()`'s mode: the agent question set,
 *  the 0.0146 bar, the conversation read from the person's own messages
 *  outward, and the facts the answer needs in the decision state when
 *  the call gives them. */
export const agentTranscripts: Mode = {
  name: 'agent-transcripts', questions: AGENT_CHAT_CASCADE, bar: 0.0146, read: conversationRead(), needed: true,
};

/** A person's chats with an assistant, `chatSettings`' mode: the chat
 *  question set, the 0.0146 bar and the ranked read. */
export const assistantChatHistory: Mode = {
  name: 'assistant-chat-history', questions: CHAT_CASCADE, bar: 0.0146, read: rankedRead,
};
