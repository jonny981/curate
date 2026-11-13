import { rankedRead, type Mode } from '@curatejs/core';
import { GIT_HISTORY_CASCADE } from './questions.js';

/** Commits, `git()`'s mode: the `GIT_HISTORY_CASCADE` decision
 *  questions, the 0.0146 bar and the ranked read. */
export const commits: Mode = { name: 'commits', questions: GIT_HISTORY_CASCADE, bar: 0.0146, read: rankedRead };
