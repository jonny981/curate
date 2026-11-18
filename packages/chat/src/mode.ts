import { conversationRead, rankedRead, type Mode, type ModeRead } from '@curatejs/core';
import { AGENT_CHAT_CASCADE, CHAT_CASCADE } from './questions.js';

/** Coding-agent transcripts, `chat()`'s mode: the agent question set,
 *  the 0.0146 bar, the conversation read from the person's own messages
 *  outward, and the facts the answer needs in the decision state when
 *  the call gives them. */
export const agentTranscripts: Mode = {
  name: 'agent-transcripts', questions: AGENT_CHAT_CASCADE, bar: 0.0146, read: conversationRead(), needed: true,
};

/** The read of a person's chats with an assistant: the fused order with
 *  the person's own messages first, each group in the order's own order,
 *  read two batches at a time and stopped where the ratings go cold, at
 *  the call's `stopWhenCold` levels or, with none set, a floor of 0.1 and
 *  a share of 0.2, judged in windows of whole requests holding at least 150 rated parts. Make it once per mode: modes that share a read are
 *  read and stopped together. */
export function assistantChatRead(): ModeRead {
  return (input) => rankedRead({ ...input,
    order: [...input.order.filter((part) => part.author === 'person'), ...input.order.filter((part) => part.author !== 'person')],
    stop: input.stop ?? { floor: 0.1, share: 0.2, parts: 150 } });
}

/** The defaults both assistant-chat modes share: the chat question set,
 *  the 0.0146 bar and `assistantChatRead()`. They set no text share: a
 *  share of 0.2 was measured only under a 2,000-token budget, and with no
 *  budget it leaves out kept parts, so it is a dial a caller sets. One set won or tied on both
 *  measured kinds of history; each mode keeps its own name, so each can
 *  be tuned on its own. */
const assistantChat = (name: string): Mode => ({ name, questions: CHAT_CASCADE, bar: 0.0146, read: assistantChatRead() });

/** A person's history of many short chats with an assistant,
 *  `chatSettings`' mode. */
export const assistantChatHistory: Mode = assistantChat('assistant-chat-history');

/** A person's long chats with an assistant, each long enough that its
 *  topic changes inside it. */
export const longAssistantChats: Mode = assistantChat('long-assistant-chats');
