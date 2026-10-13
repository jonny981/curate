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
