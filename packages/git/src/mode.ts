import { rankedRead, type Mode } from '@curatejs/core';
import { GIT_HISTORY_CASCADE } from './questions.js';

/** Commits, `git()`'s mode: the `GIT_HISTORY_CASCADE` decision
 *  questions, the 0.0146 bar and the ranked read, asked in plain text
 *  with the rating stop judging each request alone: the form and the
 *  rule the bar and the stop's levels were set with. The JSON state
 *  rates parts on another scale, and was never measured on commits. */
export const commits: Mode = { name: 'commits', questions: GIT_HISTORY_CASCADE, bar: 0.0146, read: rankedRead, request: 'text', stopWindow: 'request' };
