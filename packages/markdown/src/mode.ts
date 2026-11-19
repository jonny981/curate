import { rankedRead, type Mode } from '@curatejs/core';
import { MARKDOWN_CASCADE } from './questions.js';

/** Notes, the mode of `markdown()`, `knowledgeBase()` and `rules()`: the
 *  `MARKDOWN_CASCADE` decision questions, the 0.0146 bar and the ranked
 *  read, asked in the plain-text form its bar was measured with (on 149
 *  LongMemEval questions the JSON form rated the same parts lower and,
 *  at this bar, answered 142.33 right against 145.33). A lever that
 *  needs the JSON state's fields sends JSON. */
export const notes: Mode = { name: 'notes', questions: MARKDOWN_CASCADE, bar: 0.0146, read: rankedRead, request: 'text' };

/** Messages between people, the mode of `whatsapp()`: the
 *  `MARKDOWN_CASCADE` decision questions, as the LoCoMo runs measured
 *  them on sessions read as Markdown notes, the 0.0146 bar and the ranked
 *  read. It sets no text share: a share of 0.1 measured 384 against 387
 *  of 400 LoCoMo questions answered right, so it is a dial a caller sets. */
export const directMessages: Mode = { name: 'direct-messages', questions: MARKDOWN_CASCADE, bar: 0.0146, read: rankedRead };
