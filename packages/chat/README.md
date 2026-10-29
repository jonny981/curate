# @curatejs/chat

Read local Claude Code and Codex transcripts. The package depends only on
`@curatejs/core`; it calls no model or network service.

## Install

```bash
pnpm add @curatejs/core @curatejs/chat
```

## Requirements

Node.js 22.20 or later.

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
  or `'12 hours'`. An ISO date is the cutoff itself. A duration counts
  back from the task date: the read request's `taskDate`, else its `asOf`,
  else now. Only messages at or after the cutoff are emitted. Omit it to read all dated messages. With `taskDate`,
  a message dated after it is not read.
- **Records read:** Claude Code `user` and `assistant` records, and the
  `attachment` records whose `attachment.type` is `queued_command`. Claude
  Code saves a message typed while an agent works as a queued attachment;
  the reader reads its `prompt` as a user part dated by the record's
  `timestamp`. A list prompt's text blocks are joined by line breaks. Every
  other attachment type stays unread. Codex `response_item` messages are
  read, and the first record's `session_meta` says what started the session.
- **Parts:** Each user or assistant text block becomes a candidate. Text
  is split at line ends into at most 700 characters. Longer lines are
  hard-cut. `maxQuestionText` and the request's text budget can tighten
  that limit. Joining the parts reproduces the scrubbed block.
- **Metadata:** `candidate.chat` carries `provider`, `sessionId`, the
  message `role`, the part's `author` and, when the transcript names an
  agent, `authorName`. The title names the author after the role, for
  example `claude-code <session> user (the person) <date>` or
  `user (agent team-lead)`. The candidate's own `role` stays `'reference'`. `date`
  holds the message timestamp with meaning `'recorded'`, as an ISO
  date-time with the offset of the read request's `timeZone`, or of the
  system's zone when it has none: 23:30 UTC on 1 June is
  `2025-06-02T00:30:00.000+01:00` in `Europe/London`. UTC is written
  `+00:00`. The candidate's title carries the same value. `contentRef`
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
- **Meaning search:** Each part embeds with the previous part from the same file. A reply therefore carries its question's context. Decision text stays unchanged.
- **Read results:** Missing folders return `absent` when none can be read.
  Missing folders alongside readable folders, skipped symbolic links,
  undated messages, and a candidate limit make the read incomplete.
  Excluded paths are refused before opening content. Cancellation and
  file or JSON failures throw `SourceReadError`. Revision pins return
  `absent` because transcripts have no git revision.
- **Memory:** The read streams the history: one pass over the transcripts
  collects keyword statistics, a second scores each part against them,
  and a third reads back only the transcripts the read keeps. With the
  lane cut on (`wholeLanes` off, the `pickFromSources` default), peak heap stays roughly
  flat as the history grows. A search lane where nothing scores above
  zero keeps only ids, never bodies; a read that keeps nothing
  records `noSearchMatch` so the caller can ask more broadly. A read
  with `wholeLanes: true` returns every part. A phrase lane needs only
  the matching pass.

## Who wrote each part

A user-role part is not always the person's: an agent's brief, another
agent's message, a tool event and a compaction summary all arrive as user
text. The reader marks each part's `author` as `person`, `agent`, `tool`,
`system` or `unmarked`. It never guesses: a part is `person` only where the
transcript says so, and `unmarked` where the transcript says nothing.

Assistant parts are `agent`. Tool calls and tool results are `tool`.

A Claude Code user record or queued message:

| What the record says | Author |
| --- | --- |
| `isSidechain: true` (an agent's own transcript) | `agent`, named by `origin.name`, `<agent-message from="…">` or `<teammate-message teammate_id="…">` when present |
| `isCompactSummary: true` | `agent` (a summary) |
| `origin.kind: "task-notification"` | `tool` |
| `isMeta: true` | `system` |
| `origin.kind: "human"` | `person` |
| `origin.kind: "peer"` | `agent`, named by `origin.name` |
| `origin.kind: "auto-continuation"` | `system` |
| No `origin`, text starting "Another Claude session sent a message" | `agent`, named by `<agent-message from="…">` |
| Anything else | `unmarked` |

The first row that matches decides.

A Codex user message:

| Session or message | Author |
| --- | --- |
| Text starting `# AGENTS.md instructions`, `<environment_context>` or `<user_instructions>` | `system` |
| A session whose `source` is `exec` | `agent` (a program started it) |
| A session another agent started (`source.subagent`) | `agent`, named by its parent thread id |
| Any other session, such as `cli` | `unmarked` |

In a `cli` session a user message can be the person's or text another tool
typed into the terminal. The transcript cannot tell them apart, so it stays
`unmarked`.

The author mark changes no rank: keyword scores and phrase matches read the
title without it.

## Defaults and overrides

`chat()` reads with `chatSettings` and the `AGENT_CHAT_CASCADE` question set: no rare-word round, core's seven label kinds, a name lane for each name the task names, and references kept when scored 0.0146 or more,
ordered and weighted by decision probability.
Set `everyScored: true` on the pick to keep every scored reference from every source.
The curator receives exact scores. Its `tiers` instructions ask for less space for low-scored items.
Labels are on because they find parts the keyword search missed, which recall needs.
To change a setting, build the source with core's `historySource()`. To turn labels off for one chat source:

```ts
import { historySource } from '@curatejs/core';
import { chat, chatSettings, AGENT_CHAT_CASCADE } from '@curatejs/chat';

const source = historySource({ reader: chat({ paths: ['transcripts'] }), ...chatSettings, labels: false, questions: AGENT_CHAT_CASCADE });
```

See [core's measured reason](https://github.com/jonny981/curate/blob/main/packages/core/README.md#defaults-and-evidence) for the saved-decision sweep's answer-turn losses.

- **Keyword settings:** `CHAT_KEYWORD_SETTINGS` exports the ranking defaults. Pass a partial `keyword` object to the reader to override them.
- **Questions:** `chat()` uses `AGENT_CHAT_CASCADE`: `relevant` first, then `needed` inside the question band. It leaves out `own`. Core's `memory()` and `pickFromSources()` ask this set. Shared `chatSettings` keeps `CHAT_CASCADE`, including `own`, for host-provided personal histories. Spreading `chatSettings` into `historySource()` selects that shared set. Set `questions: AGENT_CHAT_CASCADE` to preserve agent questions when you change other settings.
- **Question band:** `AGENT_CHAT_CASCADE.band`, `[0.1, 0.9]`, decides when the other questions are asked. A part whose answer to the first question, `relevant`, falls outside the band is scored on that answer alone. Set your own band through `questions`:

  ```ts
  import { historySource } from '@curatejs/core';
  import { chat, AGENT_CHAT_CASCADE, chatSettings } from '@curatejs/chat';

  const source = historySource({ reader: chat(), ...chatSettings, questions: { ...AGENT_CHAT_CASCADE, band: [0.05, 0.95] } });
  ```
- **Personal questions:** `PERSONAL_CHAT_CASCADE` is a question set for histories of a person's own life: events, purchases, people, ages, places and numbers. It asks first whether the user says something about their own life that bears on the task, then `needed`, `aside` and `preference` inside the 0.1 to 0.9 band. On saved answers for chat-history tasks, it ranked the parts holding an answer above the hard non-answers of their own task more often than `CHAT_CASCADE` did: 0.815 against 0.778. It is not the default because `chat()` mostly reads coding-agent transcripts. A clear "no" to its first question settles a part with no further question, so a coding decision such as "we'll use Postgres" would likely be dropped. Use it through `historySource`:

  ```ts
  import { historySource } from '@curatejs/core';
  import { chat, chatSettings, PERSONAL_CHAT_CASCADE } from '@curatejs/chat';

  const source = historySource({ reader: chat(), ...chatSettings, questions: PERSONAL_CHAT_CASCADE });
  ```
- **Personal questions with written ones:** `PERSONAL_CHAT_WRITTEN_CASCADE` holds the same questions, fitted together with two to four questions a model writes for each task and a question asked once per name the task names ([core's name question](https://github.com/jonny981/curate/blob/main/packages/core/README.md#a-question-about-each-name)). It needs core's `writeQuestions` pick option; `taskQuestionWriter(write)` builds one from your curator's `write` function. A pick with this set and no writer throws. See [core's written questions](https://github.com/jonny981/curate/blob/main/packages/core/README.md#questions-written-for-each-task).

  ```ts
  import { historySource, memory, taskQuestionWriter } from '@curatejs/core';
  import { chatWriter, jev } from '@curatejs/core/models';
  import { chat, chatSettings, PERSONAL_CHAT_WRITTEN_CASCADE } from '@curatejs/chat';

  const decide = jev({ apiKey: process.env.TYPESAFE_API_KEY });
  const write = chatWriter({ apiKey: process.env.CHAT_API_KEY, model: 'gpt-5-mini' });

  const mem = memory({
    sources: [historySource({ reader: chat(), ...chatSettings, questions: PERSONAL_CHAT_WRITTEN_CASCADE })],
    decide,
    write,
    pick: { writeQuestions: taskQuestionWriter(write) },
  });
  ```
- **Label bar:** `labelBar` sets how sure a label must be, 0.5 when absent. A higher bar brings fewer parts in through the label lane: `historySource({ reader: chat(), ...chatSettings, labelBar: 0.7, questions: AGENT_CHAT_CASCADE })`.
- **Labels:** `labels: true` asks core's seven `LABEL_KINDS` for transcript facts; a list of kinds asks your own set instead. See [core's label options](https://github.com/jonny981/curate/blob/main/packages/core/README.md#label-gate).
- **Search wording:** `CHAT_SEARCH_LINE_REGISTER` describes the wording for host-written extra search lines. Copy or replace this text in your host; the package generates no lines.
- **Kind phrases:** `CHAT_KIND_PHRASES` exports phrases in the chat register for `directions`, `decisions` and `corrections`. Pass one list to core's `kindLanes` option, for example `{ chat: CHAT_KIND_PHRASES.directions }`; kind lanes stay off by default.

```ts
import { chat, CHAT_KEYWORD_SETTINGS, CHAT_CASCADE, CHAT_SEARCH_LINE_REGISTER } from '@curatejs/chat';

const source = chat({ paths: ['transcripts'], keyword: { k1: 1.2 } });
```

`rankChat(parts, task, keyword)` accepts the same keyword overrides.
`rrf: false` keeps the full-query keyword score without merging content
and name rankings. The default is `true`. To use ordinary keyword settings,
pass `{ k1: 1.2, b: 0.75, stem: false, short: false, stop: 'baseline', nouns: false, rrf: false }`.
`scrubChat(text)` exports the transcript secret scrubber.

See [core](https://github.com/jonny981/curate/blob/main/packages/core/README.md) for selection, search lines, optional cuts and curation.
