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
