import { rankedRead, type Mode, type ModeRead, type PickCascade } from '../../src/index.js';

/** Each source's question set as its mode, read down the ranked list
 *  unless `read` says otherwise; the mode is named after the source. */
export const modesOf = (sets: Readonly<Record<string, PickCascade>>, read: ModeRead = rankedRead): Record<string, Mode> =>
  Object.fromEntries(Object.entries(sets).map(([id, questions]) => [id, { name: id, questions, read }]));
