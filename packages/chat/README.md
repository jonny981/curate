# @curatejs/chat

Read local Claude Code and Codex transcripts. The package depends only on
`@curatejs/core`; it calls no model or network service.

## Install

```bash
pnpm add @curatejs/core @curatejs/chat
```

## Requirements

Node.js 22.12 or later.

## Chat transcripts

`chat(options)` reads local JSONL transcripts as reference candidates.

```ts
import { chat } from '@curatejs/chat';

const source = chat({ providers: ['claude-code', 'codex'], since: '14 days' });
```

- **Providers:** Claude Code reads `~/.claude/projects/`; Codex reads
  `~/.codex/sessions/`. Both folders are scanned recursively. `providers`
  defaults to both. `paths: ['/path/to/transcripts']` replaces the default
  folders for each selected provider.
- **Dates:** `since` accepts an ISO date or a duration such as `'14 days'`
  or `'12 hours'`, measured from read start. Only messages at or after
  that date are emitted. Omit it to read all dated messages.
- **Parts:** Each user or assistant text block becomes a candidate. Text
  is split at line ends into at most 700 characters. Longer lines are
  hard-cut. `maxQuestionText` and the request's text budget can tighten
  that limit. Joining the parts reproduces the scrubbed block.
- **Metadata:** `candidate.chat` carries `provider`, `sessionId` and the
  message `role`. The candidate's own `role` stays `'reference'`. `date`
  holds the message timestamp with meaning `'recorded'`. `contentRef`
  names the provider, session, JSONL line, block and part.
- **Tools:** Tool calls and results are excluded by default.
  `includeTools: true` includes them with message roles `'tool-call'` and
  `'tool-result'`. Thinking blocks and Codex event copies are excluded.
- **Scrubbing:** Full message blocks and tool arguments are scrubbed
  before splitting or ranking. Patterns cover private keys, common API
  keys and tokens, named passwords and credentials, credentials in URLs,
  and long strings that look like secrets. A 40-character hex commit id
  is retained. Pattern matching is not a guarantee that arbitrary secret
  text will be recognized.
- **Ranking:** Chat uses the LongMemEval settings: BM25 with `k1: 0.6`
  and `b: 0`, Porter word stems, short identifiers, noun weights, and
  merged rankings for the full query, content words and names. Markdown
  and git use their own settings. No model or network call is made.
- **Read results:** Missing folders return `absent` when none can be read.
  Missing folders alongside readable folders, skipped symbolic links,
  undated messages, and a candidate limit make the read incomplete.
  Excluded paths are refused before opening content. Cancellation and
  file or JSON failures throw `SourceReadError`. Revision pins return
  `absent` because transcripts have no git revision.

## Defaults and overrides

- **Keyword settings:** `CHAT_KEYWORD_SETTINGS` exports the ranking defaults. Pass a partial `keyword` object to the reader to override them.
- **Questions:** `CHAT_CASCADE` exports the fitted questions. `CHAT_DECISION_RULE` exports the personal-fact check and its score bars. Pass the cascade to core’s `cascade` or `cascadesByKind` option. The defaults are opt-in.
- **Search wording:** `CHAT_SEARCH_LINE_REGISTER` describes the wording for host-written extra search lines. Copy or replace this text in your host; the package generates no lines.

```ts
import { chat, CHAT_KEYWORD_SETTINGS, CHAT_CASCADE, CHAT_SEARCH_LINE_REGISTER } from '@curatejs/chat';

const source = chat({ paths: ['transcripts'], keyword: { k1: 1.2 } });
```

`rankChat(parts, task, keyword)` accepts the same keyword overrides.
`scrubChat(text)` exports the transcript secret scrubber.

See [core](../core/README.md) for selection, search lines, decision rules and curation.
