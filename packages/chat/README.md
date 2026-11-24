# @curatejs/chat

Reads the Claude Code and Codex transcripts (JSONL files) on your machine, so Curate can pick evidence from your past chats.
It depends only on `@curatejs/core` and calls no model or network service.

## Install

```bash
pnpm add @curatejs/core @curatejs/chat
```

You need Node.js 22.20 or later.

## Example

```ts
import { chat } from '@curatejs/chat';

const source = chat({ providers: ['claude-code', 'codex'], since: '14 days' });
```

Pass it to core's `memory()` or `pickFromSources()`.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `providers` | `['claude-code', 'codex']` | Which transcripts to read: Claude Code's from `~/.claude/projects/` and Codex's from `~/.codex/sessions/`, subfolders included. |
| `paths` | each provider's folder | Folders to read instead, for each provider you chose. |
| `since` | every dated message | How far back to read: an ISO date, or a duration such as `'14 days'` or `'12 hours'`. See [Dates](#dates). |
| `exclude` | none | Files or folders to skip, absolute or relative to the provider folder. They're never opened, but other sources still read them. |
| `includeTools` | `false` | `true` adds tool calls and tool results, with message roles `'tool-call'` and `'tool-result'`. |
| `maxQuestionText` | 700 | The most characters in a part. A value above 700 has no effect. |
| `keyword` | `CHAT_KEYWORD_SETTINGS` | Your changes to the keyword ranking. See [Keyword settings](#keyword-settings). |
| `mode` | `agentTranscripts` | How the decision step judges and reads the parts: the questions it asks, the score a part needs to be kept, and the read. See [Modes](#modes). |
| `index` | on | `{ directory }` picks where the index file goes, and `false` turns it off. See [Stored index](#stored-index). |
| `id` | `chat:` plus the providers and folders | The source's id. |

## What it reads

From Claude Code, the reader takes `user` and `assistant` records, and `attachment` records whose `attachment.type` is `queued_command`.
Other attachment types aren't read.
A queued command is a message you typed while an agent was working: the reader reads its `prompt` as a user part, dated by the record's `timestamp`, and joins a list prompt's text blocks with line breaks.

From Codex, it takes `response_item` messages.
The first record's `session_meta` says what started the session (see [Who wrote each part](#who-wrote-each-part)).

Thinking blocks and Codex's event copies are always left out.

### Parts and titles

Each user or assistant text block is split at line ends into parts of at most 700 characters, and a longer line is cut wherever the limit falls.
`maxQuestionText` and the request's text budget can make parts smaller.
Joining a block's parts gives back the block exactly, after [scrubbing](#secret-scrubbing).

Every part has role `'reference'`.
`candidate.chat` carries the `provider`, the `sessionId`, the message `role`, `authorName` when the transcript names an agent, and `unit` for a part of an agent's work ([below](#the-parts-of-an-agents-work)).
`candidate.author` holds who wrote the part, and `candidate.place` its transcript and its line, block and piece there.
`contentRef` names the provider, session, JSONL line, block and part.

The title names the author after the role, for example `claude-code <session> user (the person) <date>` or `user (agent team-lead)`.

### Compressed Codex sessions

Codex compresses older sessions as `<name>.jsonl.zst`.
The reader decompresses them with Node's own zstd, a line at a time, and never holds a whole file.

A compressed file is read as the session `<name>.jsonl`: the same session id, the same part ids and the same place in the stored index.
So a session indexed before Codex compressed it keeps its parts, and only the lines it gained since then are read.
If both forms sit side by side, the reader reads the uncompressed one, since that's the one that can still grow.
If Codex compresses a session after the reader lists the folder, the reader reads the compressed form.

The reader reads every zstd frame and checks the file against its own frame structure.
A session that's empty, cut off inside a frame, has bytes after its last frame, or won't decompress is left out and counted, and so is one that's gone in both forms.
The read is then incomplete, and `partial` says how many sessions were left out.
A file cut exactly between two whole frames can't be told from a whole one.

`firstSessionLine(path)` returns the first line of a session file, plain (`.jsonl`) or compressed (`.jsonl.zst`), and reads no further.
It rejects an empty or damaged compressed file, so you can admit a session by its header with the same frame check the reader uses.

## Dates

A part's `date` is its message timestamp, with meaning `'recorded'`.
It's an ISO date-time in the read request's `timeZone`, or in the system's zone if the request has none: 23:30 UTC on 1 June is `2025-06-02T00:30:00.000+01:00` in `Europe/London`.
UTC is written `+00:00`, and the part's title carries the same value.

`since` takes an ISO date, which is the cutoff itself, or a duration counted back from the task date.
The task date is the read request's `taskDate`, else its `asOf`, else now.
Only messages at or after the cutoff are read, and with no `since`, every dated message is read.
With a `taskDate`, a message dated after it isn't read.

## Who wrote each part

A user-role part isn't always the person's.
An agent's brief, another agent's message, a tool event and a compaction summary all arrive as user text.
So the reader marks each part's `author` as `person`, `agent`, `tool`, `system` or `unmarked`.
It never guesses: a part is `person` only where the transcript says so, and `unmarked` where it says nothing.

Assistant parts are `agent`.
Tool calls and tool results are `tool`.

For a Claude Code user record or queued message, the first row that matches decides:

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

For a Codex user message:

| Session or message | Author |
| --- | --- |
| Text starting `# AGENTS.md instructions`, `<environment_context>` or `<user_instructions>` | `system` |
| A session whose `source` is `exec` | `agent` (a program started it) |
| A session another agent started (`source.subagent`) | `agent`, named by its parent thread id |
| Any other session, such as `cli` | `unmarked` |

In a `cli` session, a user message can be the person's or text another tool typed into the terminal.
The transcript can't tell them apart, so it stays `unmarked`.

The author mark doesn't change the search ranking: keyword scores and phrase matches read the title without it.
The chat read starts from the person's own parts, and the decision model can read the author in a part's record.

### The parts of an agent's work

Three kinds of part carry `chat.unit`:

- **`prompt`:** the first line of a Claude Code subagent's transcript (`<session>/subagents/agent-<id>.jsonl`), the brief it was given.
- **`report`:** the last line of that transcript holding assistant text, the agent's last message. Its `authorName` is the agent's id, from the file name, so its title reads `assistant (agent <id>)`.
- **`summary`:** a Claude Code compaction summary (`isCompactSummary: true`).

Codex sessions carry no `unit`. The marks add no part and change no search rank.

## Secret scrubbing

The reader scrubs whole message blocks and tool arguments before it splits or ranks them.
The patterns cover private keys, common API keys and tokens, named passwords and credentials, credentials in URLs, and long strings that look like secrets.
A 40-character hex commit id is kept.
Pattern matching can't promise to catch every secret.

Part ids are scrubbed too.
An id is built from the folder read, the transcript's path in it, and the part's line, block and piece.
The folder and the path are scrubbed separately before they're joined, so a name that looks like a secret is masked.
A masked folder or path is followed by `#` and the first 16 hex characters of a SHA-256 of the real folder and path.
So two transcripts whose names mask alike, such as two files named by 32 hex characters, keep their own ids and their own place, and the real name is never shown.

`scrubChat(text)` exports the same scrubber.

## Ranking

Chat uses the LongMemEval settings: BM25 with `k1: 0.6` and `b: 0`, Porter word stems, short identifiers, noun weights, and merged rankings for the full query, content words and names.
Markdown and git use their own settings.

For meaning search, each part is embedded together with the previous part from the same file.
For a reply, that's often its question, but it can be a tool output or an earlier slice of the same message.
The text the decision model reads doesn't change.

## Errors and memory use

If none of the folders can be read, the read returns `absent`.
It's incomplete when some folders are missing but others can be read, or when it skips symbolic links, finds undated messages or hits a part limit.
Cancellation and file or JSON failures throw `SourceReadError`.
A revision pin returns `absent`, since transcripts have no git revision.

The read streams the history in passes.
The first collects keyword statistics, the second scores each part against them, and the third reads back only the transcripts the read keeps.
A phrase lane needs only the matching pass.

With the lane cut on (`wholeLanes` off, the `pickFromSources` default), peak memory stays roughly flat as the history grows.
A read with `wholeLanes: true` returns every part.
A search lane where nothing scores above zero keeps only ids, never the text.
A read that keeps nothing records `noSearchMatch`, so the caller can ask more broadly.

## Stored index

By default the reader keeps one local file for this source, made on its first read, and every lane reads that file instead of the transcripts.
Each call reads only what changed: what was added to a transcript that grew, a changed transcript in full, and any new transcript.
The file goes in `~/.cache/curate/index`, or `$XDG_CACHE_HOME/curate/index` if that's set.
Set `index: { directory }` to choose the folder, or `index: false` to read the transcripts directly every time.

Core's [Stored index](https://github.com/jonny981/curate/blob/main/packages/core/README.md#stored-index) has the detail.

## Defaults and overrides

`chat()` reads with `chatSettings` and the `agentTranscripts` mode:

- **Labels on:** core's seven label kinds. They find parts the keyword search missed, which recall needs.
- **Name lanes:** one for each name the task names.
- **The `agentTranscripts` mode:** parts scoring 0.0146 or more on `AGENT_CHAT_CASCADE` are kept, ordered and weighted by decision probability, and the parts are read with [core's chat read](https://github.com/jonny981/curate/blob/main/docs/library.md#the-chat-read) ([Modes](#modes)).

Set `everyScored: true` on the pick to keep every scored reference part from every source.
Core's `curate()` lays out the kept parts by their exact scores, strongest first.

To change a setting, build the source with core's `historySource()`.
This turns labels off for one chat source:

```ts
import { historySource } from '@curatejs/core';
import { agentTranscripts, chat, chatSettings } from '@curatejs/chat';

const source = historySource({ reader: chat({ paths: ['transcripts'] }), ...chatSettings, labels: false, mode: agentTranscripts });
```

Core's [Defaults and evidence](https://github.com/jonny981/curate/blob/main/docs/measurements.md#defaults-and-evidence) explains the 0.0146 bar: in its saved-decision sweep, higher bars dropped whole answer turns.

### Keyword settings

`CHAT_KEYWORD_SETTINGS` holds the ranking defaults.
Pass a partial `keyword` object to the reader to change them:

```ts
import { chat, CHAT_KEYWORD_SETTINGS, CHAT_CASCADE, CHAT_SEARCH_LINE_REGISTER } from '@curatejs/chat';

const source = chat({ paths: ['transcripts'], keyword: { k1: 1.2 } });
```

`rankChat(parts, task, keyword)` takes the same changes.
`rrf: false` keeps the full-query keyword score instead of merging it with the content-word and name rankings; the default is `true`.
For ordinary keyword settings, pass `{ k1: 1.2, b: 0.75, stem: false, short: false, stop: 'baseline', nouns: false, rrf: false }`.

### Modes

A mode says how the decision step judges and reads a source's parts: its questions, the bar a part is kept at, and its read.
The package exports three.

| Mode | Questions | Bar | Read | Use it for |
| --- | --- | --- | --- | --- |
| `agentTranscripts`, `chat()`'s default | `AGENT_CHAT_CASCADE` | 0.0146 | `conversationRead()` | Coding-agent transcripts |
| `assistantChatHistory`, `chatSettings`' mode | `CHAT_CASCADE` | 0.0146 | `assistantChatRead()` | Many short chats with an assistant |
| `longAssistantChats` | `CHAT_CASCADE` | 0.0146 | `assistantChatRead()` | Chats long enough that their topic changes inside them |

`agentTranscripts` also puts the facts the answer needs in each request's decision state, when the call gives them (`needed`).
Its `conversationRead()` means a pick on the fused order reads its parts with [core's chat read](https://github.com/jonny981/curate/blob/main/docs/library.md#the-chat-read): the person's own messages first, rings of neighbours around those rated well, then the topic segments that hold one of them or a search lane's top 10 parts, until new well-rated parts fall off.
A source in a mode that reads with `rankedRead` keeps the plain read, and so does a pick with `everyRanked`, which decides every ranked part.

`agentTranscripts` asks in the JSON state, and the two assistant-chat modes in plain text, the form `CHAT_CASCADE`'s bar was set in.

The two assistant-chat modes share one set of defaults, each under its own name so each can be tuned on its own.
`assistantChatRead()` reads the fused order with the person's own messages first, two batches at a time, and stops where the ratings go cold: at the call's `stopWhenCold` levels or, with none set, a floor of 0.1 and a share of 0.2, judged over windows of whole requests holding at least 150 rated parts.
Replayed on saved ratings, this one set found as much evidence as each mode's own measured rules on both benchmarks: the same 97 of 104 evidence units on BEAM's long chats, and 856 of 886 against 851 on LongMemEval.
Their text takes every kept part: a text share of 0.2 was measured only under a 2,000-token budget, and with no budget it leaves out kept parts, so `textShare` is a dial you set.
An author weight, the facts the answer needs and a second search are left out: the weight wasn't fitted for this set, and the other two weren't measured with it.

### Question sets

`AGENT_CHAT_CASCADE` is the default.
It asks `relevant` first, then `needed` inside the question band, and it leaves out `own`.
The band, `AGENT_CHAT_CASCADE.band`, is `[0.1, 0.9]`: a part whose answer to `relevant` falls outside it is scored on that answer alone.
Set your own band through the mode's `questions`:

```ts
import { historySource } from '@curatejs/core';
import { agentTranscripts, chat, AGENT_CHAT_CASCADE, chatSettings } from '@curatejs/chat';

const source = historySource({ reader: chat(), ...chatSettings, mode: { ...agentTranscripts, questions: { ...AGENT_CHAT_CASCADE, band: [0.05, 0.95] } } });
```

`chatSettings` itself carries the `assistantChatHistory` mode, whose `CHAT_CASCADE` includes `own`, for personal histories a host provides.
Spreading `chatSettings` into `historySource()` picks that mode, so add `mode: agentTranscripts` to keep the agent questions and read when you change other settings.

#### Personal questions

`PERSONAL_CHAT_CASCADE` is for histories of a person's own life: events, purchases, people, ages, places and numbers.
It first asks whether the user says something about their own life that bears on the task, then asks `needed`, `aside` and `preference` inside the 0.1 to 0.9 band.
On saved answers for chat-history tasks, it ranked the parts holding an answer above the hard non-answers of their own task more often than `CHAT_CASCADE` did: 0.815 against 0.778.

It isn't the default because `chat()` mostly reads coding-agent transcripts.
A clear "no" to its first question settles a part with no further questions, so a coding decision such as "we'll use Postgres" would likely be dropped.
Use it through `historySource`:

```ts
import { historySource } from '@curatejs/core';
import { assistantChatHistory, chat, chatSettings, PERSONAL_CHAT_CASCADE } from '@curatejs/chat';

const source = historySource({ reader: chat(), ...chatSettings, mode: { ...assistantChatHistory, questions: PERSONAL_CHAT_CASCADE } });
```

#### Personal questions with written ones

`PERSONAL_CHAT_WRITTEN_CASCADE` holds the same questions, fitted together with two to four questions a model writes for each task, and a question asked once for each name the task names ([core's name question](https://github.com/jonny981/curate/blob/main/docs/library.md#a-question-about-each-name)).

It needs core's `writeQuestions` pick option, and a pick with this set and no writer throws.
`taskQuestionWriter(write)` builds a writer from a `write` function that sends a prompt to a model and returns its reply text.
See [core's written questions](https://github.com/jonny981/curate/blob/main/docs/library.md#questions-written-for-each-task).

```ts
import { historySource, memory, taskQuestionWriter, type CurateWrite } from '@curatejs/core';
import { jev } from '@curatejs/core/models';
import { assistantChatHistory, chat, chatSettings, PERSONAL_CHAT_WRITTEN_CASCADE } from '@curatejs/chat';

const decide = jev({ apiKey: process.env.TYPESAFE_API_KEY });
// Any model call: it gets { instructions, body } and returns the reply text.
const write: CurateWrite = async ({ instructions, body }, signal) => askYourModel(instructions, body, signal);

const mem = memory({
  sources: [historySource({ reader: chat(), ...chatSettings, mode: { ...assistantChatHistory, questions: PERSONAL_CHAT_WRITTEN_CASCADE } })],
  decide,
  pick: { writeQuestions: taskQuestionWriter(write) },
});
```

#### Judgment questions

`JUDGMENT_CHAT_CASCADE` asks every part two narrow questions: `topic_match`, a yes/no subject match, and `answerhood`, a five-level score for "could this excerpt itself be the answer".
It combines the answers with facts the code works out for each part (position, keyword rank, task kind and the rest), using the fitted constants in `judgment-chat-weights.json`, which ships beside the bundle.
The model sees each part without names: a date and its text, with no id, title or session.
Pick it with a mode that carries it, and change its fitted bar with the mode's `bar`:

```ts
const source = chat({ paths: ['transcripts'], mode: { name: 'judgments', questions: JUDGMENT_CHAT_CASCADE, bar: 0.3, read: rankedRead } });
```

The weights file ships empty, so the set throws until a fitted run writes `keys`, `mu`, `sd`, `w`, `b` and `bar` beside the bundle, plus a `provenance` block naming the population the fit measured.
The set never borrows another set's weights or bar.

That population is the saved benchmark's: 700-character transcript chunks, session dates, full pools and roles the adapter assigned.
A pass checks the set on that population only; it isn't calibration for ordinary `/curate` sources.
The `curate` skill picks `JUDGMENT_CHAT_CASCADE` for a chat source when `sources.json` sets `questions: "judgments"` on it.

#### Message answers

`MESSAGE_ANSWER_CASCADE` asks of a whole message whether it states the answer to the task, and once per needed fact whether it states that fact. A message's score is the highest of its answers.
It's the question set of a mode's second stage (`keep`), which the `curate` skill's `answers` and `exchange` sets use.
In this wording, on 22 coding-agent tasks of one history, each whole message judged with its hard facts, the highest bar that lost no labelled answer was 0.59 on tasks that want one decision and 0.04 on tasks that want everything said.
A bar measured in this wording doesn't carry to another.

### Labels

`labelBar` sets how sure a label must be, 0.5 if you don't set it.
A higher bar lets fewer parts in through the label lane: `historySource({ reader: chat(), ...chatSettings, labelBar: 0.7, mode: agentTranscripts })`.

`labels: true` asks for core's seven `LABEL_KINDS`, and a list of kinds asks for your own set instead.
See [core's label options](https://github.com/jonny981/curate/blob/main/docs/library.md#labels).

### Search wording and kind phrases

`CHAT_SEARCH_LINE_REGISTER` describes how to word extra search lines your host writes.
Copy or replace the text in your host: the package writes no lines itself.

`CHAT_KIND_PHRASES` holds phrases in chat wording for `directions`, `decisions` and `corrections`.
Pass one list to core's `kindLanes` option, for example `{ chat: CHAT_KIND_PHRASES.directions }`.
Kind lanes are off by default.

See [core](https://github.com/jonny981/curate/blob/main/packages/core/README.md) for selection, search lines, optional cuts and curation.
