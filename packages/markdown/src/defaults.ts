import type { HistorySettings } from '@curatejs/core';
import { notes } from './mode.js';

/** The settings `markdown()` and `knowledgeBase()` read with: no label
 *  kinds, a name lane for each name the task names, and the `notes`
 *  mode (the `MARKDOWN_CASCADE` decision questions, the 0.0146 bar and
 *  the ranked read). Change one with
 *  `historySource({ reader: knowledgeBase('docs'), ...markdownSettings, names: false })`. */
export const markdownSettings: HistorySettings = {
  labels: false, names: true, mode: notes,
};

/** The settings `rules()` reads with: `markdownSettings` with no name
 *  lanes, because rules are chosen by where they apply, not by search,
 *  and a rule bar of 0.5, so a rule is kept when the decision model
 *  answers 0.5 or more that it applies to the task. 0.5 is a starting
 *  value, not yet tuned; it will be fitted on the 160-task rules test. */
export const rulesSettings: HistorySettings = { ...markdownSettings, names: false, ruleBar: 0.5 };

export interface MarkdownKeywordSettings {
  readonly k1: number;
  readonly b: number;
  readonly headingWeight: number;
  readonly headingCap: number;
  readonly fileCap: number;
  readonly namedPathWeight: number;
  readonly inboundLinkCap: number;
  readonly replacedWeight: number;
  readonly stopWords: readonly string[];
}

export const MARKDOWN_KEYWORD_SETTINGS: MarkdownKeywordSettings = {
  k1: 1.2,
  b: 0.75,
  headingWeight: 2,
  headingCap: 2,
  fileCap: 1,
  namedPathWeight: 3,
  inboundLinkCap: 1,
  replacedWeight: -2,
  stopWords: ['about', 'after', 'agent', 'and', 'answers', 'are', 'before', 'change', 'context', 'every', 'for', 'into', 'not', 'only', 'question', 'should', 'that', 'the', 'their', 'there', 'these', 'this', 'what', 'when', 'where', 'which', 'with', 'would', 'you'],
};

/** Wording guidance for host-written extra searches; Curate generates no lines. */
export const MARKDOWN_SEARCH_LINE_REGISTER = 'A note paragraph.';

/** Kind-lane phrases in the note register, by the kind of message a
 *  task asks for. Feed the matching list into `kindLanes` on the read
 *  request (`{ markdown: MARKDOWN_KIND_PHRASES.decisions }`); kind
 *  lanes stay off by default. */
export const MARKDOWN_KIND_PHRASES: Readonly<Record<'directions' | 'decisions' | 'corrections', readonly string[]>> = {
  directions: ['always', 'never', 'must', 'do not', 'required'],
  decisions: ['decision:', 'decided', 'we chose', 'chosen', 'decision record'],
  corrections: ['superseded', 'supersedes', 'was wrong', 'corrected', 'no longer'],
};
