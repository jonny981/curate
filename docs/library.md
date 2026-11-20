# Library reference

The library's options, with each reader's settings.
Start with the [README](../README.md) for installation and a first example.

Pass reader options under `read`, selection options under `pick`, and layout options under `curate`:

```js
const mem = memory({
  sources,
  decide,
  pick: { limits: { maxBatchChars: 50000 } },
  curate: { answerTokens: 4000 },
});
```

Batch sizes change request size without dropping evidence.
Limits that leave a read incomplete or decisions unfinished make `recall()` throw.
The [core package](../packages/core/README.md) documents every option and record field.

## What recall returns

`recall()` returns the laid-out text as `log`, exact selected rules as joined text, and the full selection and layout records:

```js
const { log, rules, picked, result } = await mem.recall('What billing constraint must this change preserve?');
```

- **Source questions are automatic.** Each reader brings its own set of narrow questions.
- **Incomplete collection throws.** An absent or incomplete read, an unanswered candidate, or interrupted decisions stop recall. Parts intentionally excluded by the label questions are allowed. Read and model errors reach the caller.
- **Rules stay exact.** `rules` joins the selected rule text with blank lines. The laid-out text holds reference evidence, not rules.
- **Every kept part is laid out whole.** No budget cuts the text and no sentence is rated unless `curate.answerTokens` or `curate.sentenceCutoff` is set. A pick that kept nothing gives an empty text. See [Layout](#layout).
- **Cancellation is optional.** Pass an `AbortSignal` as `mem.recall(task, { signal })`.

## Settings for each source

Each source carries its own settings, tuned for that kind of history.

| Source | Rare-word round | Labels | Label bar | Name lanes | Decision-score bar | Rule bar | Questions |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `chat()` | Off | On, the seven kinds | 0.5 | On | 0.0146 | | `AGENT_CHAT_CASCADE` |
| `git()` | On | Off | | On | 0.0146 | | `GIT_HISTORY_CASCADE` |
| `markdown()`, `knowledgeBase()` | On | Off | | On | 0.0146 | | `MARKDOWN_CASCADE` |
| `rules()` | On | Off | | Off | 0.0146 | 0.5, not yet tuned | `MARKDOWN_CASCADE` |

- **Rare-word round:** after selection, find unselected parts of the same source that share a rare word with a selected part, and ask about them.
- **Labels:** check each history part for seven kinds of personal fact, such as what someone owns, prefers or decided. This helps Curate find relevant parts that keyword search missed. Each part is labelled once and the label stored for later questions.
- **Label bar (`labelBar`):** Curate checks which kinds of fact the task needs. If a kind scores at least `labelBar`, Curate brings in the source's parts whose label for that kind also scores at least `labelBar`. 0.5 for every source that carries labels.
- **Name lanes (`names`):** search once more for each person or thing the task names, as an exact phrase, so every part that mentions it reaches the decision step. A part the search loses can never be picked. Off for rules, which are chosen by where they apply, not by search.
- **Decision-score bar:** keep a reference part the decision model scored at or above this.
- **Rule bar:** keep a rule the decision model scored at or above this. Only sources whose parts are rules use it: `rules()`, and `markdown()` with kind `rules` or `instructions`.
- **Questions:** the yes/no questions the decision model answers about each reference part, with fitted weights that combine the answers into its score.

Sources can still affect each other.
A selected commit brings in a note it changed, and the [whole-call options](#whole-call-options) are shared by every source.
The pick record names the settings each source ran with under `levers.sources`, such as `{ kind: 'chat', labels: true, labelBar: 0.5, rare: false, bar: 0.0146 }`, with `questions` holding the question set its parts were asked.
Each pick record's `effects` list says what each setting changed: the parts it brought in or kept out, and why when it changed nothing ([what each setting did](../packages/core/README.md#what-each-setting-did)).

## Whole-call options

| Option | Out of the box |
| --- | --- |
| `read.wholeLanes` | Off: cut each search lane |
| `pick.stopWhenCold` | Off: rate every part of the fused order. `{}`, or `{ floor, share }`, stops where the decision scores go cold |
| `pick.feed` | Unset: the whole fused order. `{ order: 'combsum', size }` orders by summed lane places and reads at most `size` parts |
| `pick.everyRanked` | Unset: the decision step reads the fused order. `true` decides every ranked part; `{ c }` a scaled top-k |
| `pick.route` | Off |
| `pick.everyScored` | Unset: each source's bar. When set, one bar for every source |
| `pick.rare` | Unset: each source's setting. When set, one setting for every source |
| `pick.taskPeriod` | On: a task that names a period lets in the parts dated inside it |
| `curate.answerTokens` | Unset: no budget, every kept part is laid out. A number keeps the text within that many estimated tokens |
| `curate.sentenceCutoff` | Unset: no sentence is rated. A number keeps the sentences `decide` rates at it or more |

The fused order and `pick.everyRanked: { c }` rank every source's parts in one fused list before they read or cut, and a stopping limit in `pick.limits` (questions, batches, time) is shared by every source.
With any of them, one source's settings can change what Curate picks from another.

## Rank

Chat and Markdown use BM25, a score for matching words.
Git uses BM25 over each commit's subject and body, plus age and changed paths.
Each search stops keeping results when their match scores level off, rather than after a fixed number.
Set `read.wholeLanes: true` to keep every part the readers return.

- **Extra wording:** Supply `read.searchLines` for phrases or hypothetical answers that describe the evidence you need. Curate does not generate them.
- **Kinds of statement:** Supply `read.kindLanes` for phrases that help find directions, decisions or corrections.
- **Meaning search:** Supply an embedding function, which turns text into numbers for similarity search. It is off by default and needs no database.

## Decide

By default, Curate combines search results from all sources into a ranked list, and the decision model rates every part of it.
Curate keeps those that score at least their source's decision-score bar (0.0146 for every reader), highest scores first.
Unanswered candidates and unfinished decisions stay visible in the record and stop `recall()`.
Parts intentionally excluded by the label questions stay in the record without stopping recall.

- **Where the read stops:** off by default, so a call's cost grows with the parts the search lanes keep, about $0.00002 a part. `pick.stopWhenCold: {}` reads the list two batches at a time and stops at the first batch whose best rating is under `floor` (0.1), or under `share` (0.2) times the best rating of every batch before it. It never stops before the read has kept a part and rated one at or above `floor`, so a question the history holds nothing for, and a history whose every part rates under `floor`, read the whole order, at the cost of the stop off. A higher `share` stops sooner; a higher `floor` can make a read longer, since the read goes on until some part rates at or above it. Parts below the stop stay unasked and record `stopWhenCold` ([details](../packages/core/README.md#stop-when-the-ratings-go-cold)).
- **What the stop costs and saves:** on three benchmark runs' saved scores, `{}` rated 64% (LoCoMo), 55% (DolphinBench) and 83% (BEAM) of the parts the runs rated and kept 98.5%, 95.2% and 100% of the evidence they found. On the published runs it saved $0.0012 a LoCoMo question and $0.0067 a LongMemEval question; it cost about 5 to 12 of LoCoMo's 1,540 right answers, the 4 lost in both answer runs each because evidence left the text, and stayed inside the noise on LongMemEval. On DolphinBench's 5,800-part transcripts it rated about half the parts, about $0.026 saved a test; its effect on answers there is not measured.
- **Other ways to read less:** `pick.feed: { order: 'combsum', size }` reads at most `size` parts, and parts past it record `feed`. `pick.everyRanked: true` decides every ranked part instead, and `pick.everyRanked: { c }` keeps the top `round(c × N^0.8)` reference parts, where N is the number of reference parts. Rules pass through uncut in every mode. The skipped parts are unassessed, so use the [separate selection API](#separate-selection-and-curation) to inspect them.
- **Score cuts:** a source's `bar` sets its score cut. `pick.everyScored: { bar }` sets one cut for every source, and `pick.everyScored: true` keeps every scored reference.
- **More evidence:** Git and Markdown run the rare-word round through their settings, each within its own parts. `pick.rare: true` runs it on every source; `pick.rare: false` turns it off. With the stop set, the round asks the parts it pulls, a part below the stop included, two batches at a time under a stop of its own; with a `feed` size it asks only while the size still has room.
- **Tags:** `pick.tags` labels selected items with their intent, importance, emphasis and whether they correct something earlier.
- **Label store:** labels are stored in `$XDG_CACHE_HOME/curate/labels`, or `~/.cache/curate/labels` when `XDG_CACHE_HOME` is unset. Use `pick.labels: { directory: 'my-labels' }` to choose a folder.

## Layout

`curate()` lays out the kept reference parts in their own words.
No model writes the text.

- **Strongest first:** the two parts with the highest decision score sit under `### Most likely answer`. Every other part is grouped by the date it was said and its source, oldest first and strongest first inside a group. A part with no date sits under `(said unknown)`, last. A date that is only a file's last change reads `(file changed <date>)`.
- **Copies taken once:** a part whose text is the same as a stronger kept part's is left out, and the kept part's heading names where else it was said.
- **Budget:** off by default: every kept part is laid out, and the record's `estimatedTokens` states the text's size. `curate.answerTokens` keeps the text within that many estimated tokens. The strongest part is always kept whole. The record's `leftOut` counts the parts the budget stopped before.
- **Sentence cutoff:** off by default. Set `curate.sentenceCutoff` to a number and curate rates each sentence of the taken parts with `decide` in one request and keeps those rated that number or more. `…` marks where text was left out. When the request fails, the whole text comes back and the record says why.
- **Nothing kept:** a pick that kept no part gives an empty text, and the record's `nothingKept` says so.

## Your own source settings

Build a source with any settings through `historySource()`.
Spread a reader's settings object, then change what you need:

```js
import { historySource } from '@curatejs/core';
import { chat, chatSettings, AGENT_CHAT_CASCADE } from '@curatejs/chat';

const source = historySource({ reader: chat({ paths: ['transcripts'] }), ...chatSettings, labels: false, questions: AGENT_CHAT_CASCADE });
```

This turns labels off for one chat source, as the DolphinBench run did.
`gitSettings`, `markdownSettings` and `rulesSettings` hold the other readers' settings.

Give a source your own decision questions the same way:

```js
import { git, gitSettings } from '@curatejs/git';

const mySet = {
  bias: 0,
  questions: [{
    key: 'decision',
    instructions: 'Does this commit record a decision the task depends on?',
    true: 'It records a decision the task depends on.',
    false: 'It records no decision the task depends on.',
    weight: 1,
  }],
};
const commits = historySource({ reader: git('.'), ...gitSettings, questions: mySet });
```

- **No `questions`:** the source asks each part one built-in question.
- **Other question sets:** `PERSONAL_CHAT_CASCADE` for histories of a person's own life, `COUNT_MARKER` for count tasks, and `pick.writeQuestions` for questions written for each task (see [core's options](../packages/core/README.md#questions-written-for-each-task)).
- **Your own reader:** `reader` can also be your own source; see [core's options](../packages/core/README.md#levers-and-source-settings).

## Answer types

The decision model can say, from the task's words alone, what kind of answer the task needs: a date, a number, a name, the order of events and so on.
`pick.answerTypes` asks the task the ten questions in `ANSWER_TYPES`, in one request per pick.
A source's question set can hold `typed` questions. Each is asked of the source's parts only when the task needs its answer type, and its answer counts toward the part's score like the set's other questions.
`pick.answerTypes` is off by default, and no preset carries a typed question.

Turn it on, and add a typed question to git's set:

```js
import { historySource, memory } from '@curatejs/core';
import { git, gitSettings, GIT_HISTORY_CASCADE } from '@curatejs/git';

const DATED = {
  ...GIT_HISTORY_CASCADE,
  typed: [{
    answerType: 'date',
    key: 'when-decided',
    instructions: 'Does this commit say when this was decided?',
    true: 'It gives the date or time of the decision',
    false: 'It gives no date for the decision',
    weight: 1,
  }],
};
const commits = historySource({ reader: git('.'), ...gitSettings, questions: DATED });
const mem = memory({ sources: [commits], decide, pick: { answerTypes: true } });
```

A pick whose sources carry typed questions while `pick.answerTypes` is off throws a `TypeError` before it reads, so a typed question never sits unread.

## Time

Every read measures from one moment: the task date.
Give it with each call, beside the person's time zone:

```js
const { log } = await mem.recall('What did I decide in March?', { taskDate: '2025-06-02', timeZone: 'Europe/London' });
```

- **The task date:** an ISO 8601 date or date-time, such as `2025-06-02` or `2025-06-02T09:15:00+01:00`. A date alone means the end of that day. Without one, the task date is now. Git recency and a chat `since` duration count back from it. The pick record names the moment as `asOf`, so a replay with the same values reads the same history.
- **Nothing from after it:** with `taskDate`, a chat message or a git commit dated after it is not read. Markdown keeps notes dated after it: a note can declare an `effective` date ahead, and a rule that takes effect next month is still a rule. To read notes as they stood, pin the read to a revision with `read: { revision }`.
- **The person's time zone:** chat dates carry the zone's offset, so a message sent at 00:30 in London in summer is dated that day, not the day before. `timeZone` is an IANA name such as `Europe/London`. Without it, the system's own zone applies.
- **The task's period:** a task that names a period, such as "in March", "last week" or "on 2025-03-04", lets the parts dated inside it reach the decision step even when no search kept them. Nothing is dropped for its date. A part is dated when it was written, so a message in April that recalls March is dated April, and a filter on March would drop the answer. `pick: { taskPeriod: false }` turns it off.

## Bring your own models

Curate accepts one plain function, `decide`.
It can call an API, a local model or a command.
The built-in helpers use `fetch` and need no model SDK.

- **`decide` answers narrow questions.** It receives `{ task, questions }` and an `AbortSignal`. Return an answer under each question's `key`, with `status: 'answered'` and a finite `probability` from 0 to 1. See [`PickDecide`](../packages/core/src/pick.ts) for question fields and unavailable answers.
- **OpenAI.** Use `openAIDecisions()` for [OpenAI's Decisions API](https://developers.openai.com/api/docs/guides/decisions) in place of `jev()`.
- **Label IDs.** The hosted helpers identify their label answers as `typesafe:${model}:items-once` and `openai:${model}`. For a handwritten `decide`, set its `deciderId` property; an explicit `pick.labels.deciderId` overrides it. Without an ID it uses `'custom'`, so different handwritten decision functions must supply different IDs to keep their saved labels apart.

```js
import { openAIDecisions } from '@curatejs/core/models';

const decide = openAIDecisions({ apiKey: process.env.OPENAI_API_KEY });
```

## Run it on your own machine

Ranking and deciding can both run against models on your own machine, and the layout calls no model but `decide`.
The one requirement: the decision server must return log-probabilities.
`localDecisions()` throws when a reply has none, because a pick that cannot judge must not guess.

- **`localDecisions()`** asks an OpenAI-compatible chat server each yes/no question, one request at a time. It reads the answer from the log-probabilities of "yes" and "no" for the first reply token.
- **`jev()` at another address** decides through a server that speaks Jev's format, such as a Clef server. Give it the address and model name your server uses. Away from TypeSafe's address, an API key is optional, and the helpers send none unless you give one.

```js
import { jev, localDecisions } from '@curatejs/core/models';

const decide = localDecisions({ url: 'http://127.0.0.1:8000/v1/chat/completions', model: 'my-local-model' });
// or
const viaJev = jev({ url: 'http://127.0.0.1:30000/v1/systemone', model: 'clef-flash' });
```

For meaning search, use the local embedder (it needs `node-llama-cpp@3.18.1`):

```js
import { memory } from '@curatejs/core';
import { createLocalEmbedder } from '@curatejs/core/local-embeddings';

// A local embedding model file in GGUF form, such as EmbeddingGemma 300M; the adapter downloads nothing.
const local = await createLocalEmbedder({ modelPath });
try {
  const mem = memory({ sources, decide, read: { meaning: { embed: local.embed } } });
  const { log } = await mem.recall('What billing constraint must this change preserve?');
} finally {
  await local.dispose();
}
```

Labels from each server are stored under its own ID: `local:<host><path>:<model>` for `localDecisions()`, and `jev:<host><path>:<model>:items-once` for `jev()` at another address.
The ID leaves out the scheme and the query, so set `pick.labels.deciderId` yourself for two servers that differ only there.
A decision cache keeps the `deciderId` you give it, so give each server its own.

## Separate selection and curation

`pickFromSources()` and `curate()` remain available when you need to inspect or change the evidence before the layout.
With these separate calls, check the read and candidate records yourself before using the result.

```js
import { pickFromSources, curate } from '@curatejs/core';
import { markdown } from '@curatejs/markdown';

const task = 'What billing constraint must this change preserve?';
const sources = [markdown({ paths: ['docs'], kind: 'docs' })];
const picked = await pickFromSources(sources, { task }, { task, decide });
const result = await curate(task, picked, { decide });
```

`pickFromSources()` asks each source its own question set, as `memory()` does.
See the [core package](../packages/core/README.md) for question sets, tags, local meaning search and full records.
