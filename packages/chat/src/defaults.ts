import type { HistorySettings } from '@curatejs/core';
import { CHAT_CASCADE } from './questions.js';

export { CHAT_KEYWORD_SETTINGS } from './chat-rank.js';

/** The settings `chat()` reads with: no rare-word round, the seven label
 *  kinds, which find parts the keyword search missed, a name lane for
 *  each name the task names, the 0.0146 decision-score bar and the
 *  `CHAT_CASCADE` decision questions.
 *  Change one with `historySource({ reader: chat(), ...chatSettings, labels: false })`. */
export const chatSettings: HistorySettings = {
  rare: false, labels: true, names: true, bar: 0.0146, questions: CHAT_CASCADE,
};

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
