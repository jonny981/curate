import type { HistorySettings } from '@curatejs/core';
import { GIT_HISTORY_CASCADE } from './questions.js';

/** The settings `git()` reads with: the rare-word round on, no label
 *  kinds, the 0.0146 decision-score bar and the `GIT_HISTORY_CASCADE`
 *  decision questions. Change one with
 *  `historySource({ reader: git('.'), ...gitSettings, bar: 0.05 })`. */
export const gitSettings: HistorySettings = { rare: true, labels: false, bar: 0.0146, questions: GIT_HISTORY_CASCADE };

export interface GitKeywordSettings {
  readonly sharedWordCap: number;
  readonly recencyDays: number;
  readonly namedPathWeight: number;
  readonly liveLinesWeight: number;
  readonly coChangeWeight: number;
  readonly stopWords: readonly string[];
}

export const GIT_KEYWORD_SETTINGS: GitKeywordSettings = {
  sharedWordCap: 3,
  recencyDays: 60,
  namedPathWeight: 3,
  liveLinesWeight: 2,
  coChangeWeight: 1,
  stopWords: ['about', 'after', 'agent', 'and', 'answers', 'are', 'before', 'change', 'context', 'every', 'for', 'into', 'not', 'only', 'question', 'should', 'that', 'the', 'their', 'there', 'these', 'this', 'what', 'when', 'where', 'which', 'with', 'would', 'you'],
};

/** Wording guidance for host-written extra searches; Curate generates no lines. */
export const GIT_SEARCH_LINE_REGISTER = 'A commit subject and body.';

/** Kind-lane phrases in the commit register, by the kind of message a
 *  task asks for. Feed the matching list into `kindLanes` on the read
 *  request (`{ 'git-history': GIT_HISTORY_KIND_PHRASES.decisions }`);
 *  kind lanes stay off by default. */
export const GIT_HISTORY_KIND_PHRASES: Readonly<Record<'directions' | 'decisions' | 'corrections', readonly string[]>> = {
  directions: ['must', 'do not', 'never', 'always', 'required'],
  decisions: ['chose', 'decided', 'picked', 'switch to', 'instead of', 'rather than'],
  corrections: ['revert', 'fix', 'oops', 'typo', 'correct'],
};
