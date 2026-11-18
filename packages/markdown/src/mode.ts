import { rankedRead, type Mode } from '@curatejs/core';
import { MARKDOWN_CASCADE } from './questions.js';

/** Notes, the mode of `markdown()`, `knowledgeBase()` and `rules()`: the
 *  `MARKDOWN_CASCADE` decision questions, the 0.0146 bar and the ranked
 *  read. */
export const notes: Mode = { name: 'notes', questions: MARKDOWN_CASCADE, bar: 0.0146, read: rankedRead };

/** Messages between people, the mode of `whatsapp()`: the
 *  `MARKDOWN_CASCADE` decision questions, as the LoCoMo runs measured
 *  them on sessions read as Markdown notes, the 0.0146 bar and the ranked
 *  read. */
export const directMessages: Mode = { name: 'direct-messages', questions: MARKDOWN_CASCADE, bar: 0.0146, read: rankedRead };
