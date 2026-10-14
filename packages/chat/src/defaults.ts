export { CHAT_KEYWORD_SETTINGS } from './chat-rank.js';

/** Wording guidance for host-written extra searches; Curate generates no lines. */
export const CHAT_SEARCH_LINE_REGISTER = "A user's chat message.";

/** Kind-lane phrases in the chat register, by the kind of message a
 *  task asks for. Feed the matching list into `kindLanes` on the read
 *  request (`{ chat: CHAT_KIND_PHRASES.directions }`); kind lanes stay
 *  off by default. `speakerOnly` narrows them to the person's own
 *  messages. */
export const CHAT_KIND_PHRASES: Readonly<Record<'directions' | 'decisions' | 'corrections', readonly string[]>> = {
  directions: ['we need to', "don't", 'never', 'always', 'i want', "let's"],
  decisions: ['we decided', 'decided to', 'we agreed', 'the decision', 'going with', 'settled on'],
  corrections: ['i meant', 'scratch that', 'not that', 'i was wrong', 'forget i said', 'actually no'],
};
