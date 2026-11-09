# Curate

A TypeScript library that finds what your agent needs from past chats, notes and commits.

93.8% on LongMemEval under its official grader, with about 121 times less context than the raw history. That run used code outside the published packages.

Curate gives an agent the context it needs for a task, drawn from chat transcripts, Markdown and git history.
It chooses evidence and turns it into a dated, cited log that the agent reads before starting work.

## Results at a glance

Curate scores close to or above other memory systems' published LongMemEval results, with far less context. The answering models and the markers differ:

| Benchmark | System | Task model | Score | Task model tokens |
| --- | --- | --- | --- | --- |
| **LongMemEval S** | **[Curate, markup setting](benchmarks/longmemeval/2026-11-04/README.md)** | **gpt-6.1-sol** | **93.8** | **844** |
| **LongMemEval S** | **Curate** | **GPT-5** | **93.4** | **449** |
| LongMemEval S | [Mem0 platform](https://github.com/mem0ai/memory-benchmarks/blob/4b61c5d31b9c668a12b4f5e78064248a02c82d2b/results/platform/longmemeval_results.json) | GPT-5 | 93.4 | 6,787 mean (15x more) |
| **LongMemEval S** | **Curate** | **GPT-5-mini** | **91.6** | **485** |
| LongMemEval S | [Mastra observational memory](https://mastra.ai/research/observational-memory) | GPT-5-mini | 93.6 | ~30,000 mean (62x more) |
| LongMemEval S | [Zep](https://getzep.com/research) | GPT-5.4 | 90.2 | 4,408 median (10x more) |

The task model does the work (here, answering the question), so it should read only what the task needs.

*Each multiplier compares with Curate on the same task model. The GPT-5.4 row compares with Curate on GPT-5.*

*The gpt-6.1-sol row ran the markup setting outside the published packages, marked by LongMemEval's own grader. Mem0's published answers scored 91.0 under that grader in the same session.*

DolphinBench: **22 of 30 tests passed**, at $0.24 a test at list prices. [See the results](benchmarks/README.md#dolphinbench-a-30-test-slice).

Every result, how each run was set up and its proof files are in [benchmarks](benchmarks/README.md).

## Built for memory that keeps growing

- **No work when history is written.** Curate reads transcripts, git history and Markdown where they already live, when a task asks. No extraction step or graph to keep in sync, and no database server or hosted vector store: local index files, made on first use.
- **Go straight to the source.** [Mem0](https://docs.mem0.ai/core-concepts/memory-operations/add) extracts facts with a model, [Mastra](https://mastra.ai/docs/memory/observational-memory) keeps observations written by a model, and [Zep](https://help.getzep.com/v4/how-graph-creation-works) builds a knowledge graph. Curate selects from the original history for each task.
- **Keep the task model focused.** It gets a dated, cited log chosen for its task, even when the history spans thousands of parts.

[LongMemEval](benchmarks/longmemeval/2026-10-22/README.md): **449 to 485 task-model tokens** from histories of about **50 sessions** and **102,580 tokens** on average (o200k, every turn's role and text): about 230 times less with GPT-5. The markup setting gives gpt-6.1-sol **844** tokens, [about 121 times less](benchmarks/longmemeval/2026-11-04/README.md#context-sizes). [DolphinBench slice](benchmarks/dolphinbench/2026-10-22/results.md): Curate turns **5,400–5,900 history parts** into a log the agent reads, with a median of **about 4,500 tokens** (o200k). The published copies of those logs use shorter part IDs, so they count about 3,200.

## Install only what you need

Use Node.js 22.20 or later.

```sh
# Run the Markdown example below.
pnpm add @curatejs/core @curatejs/markdown

# Add transcript or git readers as needed.
pnpm add @curatejs/chat @curatejs/git

# Or supply your own sources.
pnpm add @curatejs/core
```

## Packages

| Package | What it supplies |
| --- | --- |
| [**@curatejs/core**](packages/core/README.md) | Task recall, selection, curation, model helpers and source contracts. No reader. |
| [**@curatejs/chat**](packages/chat/README.md) | Local agent transcripts, secret scrubbing, chat ranking and questions. |
| [**@curatejs/git**](packages/git/README.md) | Git commit history, keyword settings and questions. |
| [**@curatejs/markdown**](packages/markdown/README.md) | Markdown notes and rules, keyword settings and questions. |

Each source package depends only on core and exports its keyword settings, question set and wording guidance for extra searches.
See the [changelog](CHANGELOG.md) for what each release contains.

## Use it

Call Curate before a task, then give its log to your agent as text.
Always-on files such as `CLAUDE.md` and `AGENTS.md` stay with your agent's harness, and Curate picks the rules a task needs from your rule library.
Curate is a library: it calls the models you supply, with no database server or hosted vector store to deploy: local index files, made on first use.
Your agent keeps its own tools and can follow the citations when it needs more detail.

### Recall context for a task

Save this as `recall.mjs`:

```js
import { memory } from '@curatejs/core';
import { jev, chatWriter } from '@curatejs/core/models';
import { markdown } from '@curatejs/markdown';

const decide = jev({ apiKey: process.env.TYPESAFE_API_KEY });
const write = chatWriter({ apiKey: process.env.CHAT_API_KEY, model: 'gpt-5-mini' });
const mem = memory({
  sources: [markdown({ paths: ['docs'], kind: 'docs' })],
  decide,
  write,
});

const { log } = await mem.recall('What billing constraint must this change preserve?');
console.log(log);
```

Create a source note:

```sh
mkdir -p docs
cat > docs/billing.md <<'NOTE'
---
date: 2026-01-12
---
# Billing
Invoices must preserve the currency recorded when the order was placed.
NOTE
```

Set the model keys and run:

```sh
export TYPESAFE_API_KEY='your-typesafe-key'
export CHAT_API_KEY='your-chat-provider-key'
node recall.mjs
```

The log cites the source file, for example:

```text
[2026-01-12] Invoices preserve the order's recorded currency (said 2026-01-12; /home/sam/docs/billing.md#1)
```

> [!NOTE]
> At their default addresses, the model helpers make paid API calls. `jev()` uses TypeSafe's `jev-latest`; `chatWriter()` uses OpenAI's Chat Completions URL. A local model server needs no hosted service. To keep every step on your machine, see [Run it on your own machine](#run-it-on-your-own-machine).

`recall()` returns the log, exact selected rules as joined text, and the full selection and curation records:

```js
const { log, rules, picked, result } = await mem.recall('What billing constraint must this change preserve?');
```

- **Source questions are automatic.** Each reader brings its own set of narrow questions.
- **Incomplete collection throws.** An absent or incomplete read, an unanswered candidate, or interrupted decisions stop recall. Parts intentionally excluded by the label questions are allowed. Read and model errors reach the caller.
- **Rules stay exact.** `rules` joins the selected rule text with blank lines. The writer receives reference evidence, not rules.
- **Cancellation is optional.** Pass an `AbortSignal` as `mem.recall(task, { signal })`.

### Read each source with its own settings

Each reader is one line:

```js
import { chat } from '@curatejs/chat';
import { git } from '@curatejs/git';
import { knowledgeBase, markdown } from '@curatejs/markdown';

chat();                                      // Claude Code and Codex transcripts
git('.');                                    // this repository's commits
markdown({ paths: ['docs'], kind: 'docs' }); // any Markdown folder, file or glob
knowledgeBase('docs');                       // a notes folder, in one argument
```

Combine them in one call:

```js
const mem = memory({ sources: [chat(), git('.'), markdown({ paths: ['docs'], kind: 'docs' })], decide, write });
```

Each source carries its own settings, tuned for that kind of history.
Sources can still affect each other. A selected commit brings in a note it changed, and the whole-call limits below are shared by every source.

| Source | Rare-word round | Labels | Label bar | Name lanes | Decision-score bar | Rule bar | Questions |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `chat()` | Off | On, the seven kinds | 0.5 | On | 0.0146 | | `AGENT_CHAT_CASCADE` |
| `git()` | On | Off | | On | 0.0146 | | `GIT_HISTORY_CASCADE` |
| `markdown()`, `knowledgeBase()` | On | Off | | On | 0.0146 | | `MARKDOWN_CASCADE` |
| `rules()` | On | Off | | Off | 0.0146 | 0.5, not yet tuned | `MARKDOWN_CASCADE` |

- **Rare-word round:** after selection, find unselected parts of the same source that share a rare word with a selected part, and ask about them.
- **Labels:** check each history part for seven kinds of personal fact, such as what someone owns, prefers or decided. This helps Curate find relevant parts that keyword search missed. Each part is labelled once and the label stored for later questions.
- **Label bar (`labelBar`):** Curate checks which kinds of fact the task needs. If a kind scores at least `labelBar`, Curate brings in the source's parts whose label for that kind also scores at least `labelBar`. 0.5 for every source that carries labels.
- **Name lanes (`names`):** search once more for each person or thing the task names, as an exact phrase, so every part that mentions it reaches the decision step. The reason is recall: a part the search loses can never be picked. Off for rules, which are chosen by where they apply, not by search.
- **Decision-score bar:** keep a reference part the decision model scored at or above this.
- **Rule bar:** keep a rule the decision model scored at or above this. Only sources whose parts are rules use it: `rules()`, and `markdown()` with kind `rules` or `instructions`.
- **Questions:** the yes/no questions the decision model answers about each reference part, with fitted weights that combine the answers into its score.

The pick record names the settings each source ran with under `levers.sources`, such as `{ kind: 'chat', labels: true, labelBar: 0.5, rare: false, bar: 0.0146 }`, with `questions` holding the question set its parts were asked.
Each pick and curate record's `effects` list says what each setting changed: the parts it brought in or kept out, and why when it changed nothing ([what each setting did](packages/core/README.md#what-each-setting-did)).

These levers act on the whole call:

| Lever | Out of the box |
| --- | --- |
| `read.wholeLanes` | Off: cut each search lane |
| `pick.thoroughness` | `'deep'`: decide the top 12,896 of the fused order; `quick` 672, `normal` 3,674 |
| `pick.everyRanked` | Unset: `thoroughness` bounds the feed. `true` decides every ranked part; `{ c }` a scaled top-k |
| `pick.route` and `curate.route` | Off |
| `pick.everyScored` | Unset: each source's bar. When set, one bar for every source |
| `pick.rare` | Unset: each source's setting. When set, one setting for every source |
| `pick.taskPeriod` | On: a task that names a period lets in the parts dated inside it |
| `curate.weightBands` | `[0.1, 0.6]`: the low and high weights the curator's instructions name |
| `curate.batchTokens` | Unset: one call up to 150,000 estimated tokens of evidence, layered batches of 150,000 above |

The default batch size acts only when neither `curate.batchTokens` nor `curate.contextLimit` is given.

`pick.thoroughness` and `pick.everyRanked: { c }` rank every source's parts in one fused list before they cut, and a stopping limit in `pick.limits` (questions, batches, time) is shared by every source.
With any of them, one source's settings can change what Curate picks from another.

### Set your own

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

A source without `questions` asks each part one built-in question.
Other question options: `PERSONAL_CHAT_CASCADE` for histories of a person's own life, `COUNT_MARKER` for count tasks, and `pick.writeQuestions` for questions written for each task (see [core's options](packages/core/README.md#questions-written-for-each-task)).
`reader` can also be your own source; see [core's options](packages/core/README.md#levers-and-source-settings).

Pass reader options under `read`, selection options under `pick`, and writer options under `curate`:

```js
const mem = memory({
  sources,
  decide,
  write,
  pick: { limits: { maxBatchChars: 50000 } },
  curate: { batchTokens: 2000 },
});
```

Batch sizes change request size without dropping evidence.
Limits that leave a read incomplete or decisions unfinished make `recall()` throw.

Labels are stored in `$XDG_CACHE_HOME/curate/labels`, or `~/.cache/curate/labels` when `XDG_CACHE_HOME` is unset.
Use `pick.labels: { directory: 'my-labels' }` to choose a folder.

### Answer types

The decision model can say, from the task's words alone, what kind of answer the task needs: a date, a number, a name, the order of events and so on.
`pick.answerTypes` asks the task the ten questions in `ANSWER_TYPES`, in one request per pick.
Two options use the types it finds:

- **Typed questions:** a source's question set can hold `typed` questions. Each is asked of the source's parts only when the task needs its answer type, and its answer counts toward the part's score like the set's other questions.
- **The hint line:** `curate.answerHint` adds one line under the task the curator reads, such as "The answer likely needs: a date, a number."

Both are off by default, and no preset carries a typed question.
Turn both on:

```js
const mem = memory({ sources, decide, write, pick: { answerTypes: true }, curate: { answerHint: true } });
```

Add a typed question to git's set through `historySource()`:

```js
import { historySource } from '@curatejs/core';
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
```

A pick whose sources carry typed questions while `pick.answerTypes` is off throws a `TypeError` before it reads, so a typed question never sits unread.

### Time

Every read measures from one moment: the task date.
Give it with each call, beside the person's time zone:

```js
const { log } = await mem.recall('What did I decide in March?', { taskDate: '2025-06-02', timeZone: 'Europe/London' });
```

- **The task date:** an ISO 8601 date or date-time, such as `2025-06-02` or `2025-06-02T09:15:00+01:00`. A date alone means the end of that day. Without one, the task date is now. Git recency and a chat `since` duration count back from it. The pick record names the moment as `asOf`, so a replay with the same values reads the same history.
- **Nothing from after it:** with `taskDate`, a chat message or a git commit dated after it is not read. Markdown keeps notes dated after it: a note can declare an `effective` date ahead, and a rule that takes effect next month is still a rule. To read notes as they stood, pin the read to a revision with `read: { revision }`.
- **The person's time zone:** chat dates carry the zone's offset, so a message sent at 00:30 in London in summer is dated that day, not the day before. `timeZone` is an IANA name such as `Europe/London`. Without it, the system's own zone applies.
- **The task's period:** a task that names a period, such as "in March", "last week" or "on 2025-03-04", lets the parts dated inside it reach the decision step even when no search kept them. Nothing is dropped for its date. A part is dated when it was written, so a message in April that recalls March is dated April, and a filter on March would drop the answer. `pick: { taskPeriod: false }` turns it off.

## Sources

Combine any of these readers in the `sources` array.
Each reader ranks its own source text without a model or network call.

### Transcripts

`@curatejs/chat` reads local Claude Code and Codex JSONL transcripts.
Use `paths` for your own folders, or omit it to use the providers' default folders.

```js
import { chat } from '@curatejs/chat';

const source = chat({ paths: ['transcripts'], providers: ['claude-code'] });
```

See the [transcript reader](packages/chat/README.md) for date filters, tool messages and secret scrubbing.

### Git history

`@curatejs/git` reads non-merge commits, including their bodies, dates and changed paths.
Git must be on `PATH`.

```js
import { git } from '@curatejs/git';

const source = git('.');
```

See the [git reader](packages/git/README.md) for keyword settings and optional signals from live lines and files that change together.

### Markdown

`@curatejs/markdown` reads folders, files and globs.
Choose `knowledge` or `docs` for reference evidence, and `rules` or `instructions` for exact rules.
`rules()` reads a rule library and keeps only the rules the decision model says apply to the task.

```js
import { markdown, rules } from '@curatejs/markdown';

const sources = [
  markdown({ paths: ['docs'], kind: 'docs' }),
  rules('.cursor/rules'),
];
```

See the [Markdown reader](packages/markdown/README.md) for dates, rule scopes and revision pins.
`knowledgeBase()` reads an [Open Knowledge Format](packages/markdown/README.md#open-knowledge-format) bundle: its page dates, titles, root links, index and log.
Older notes can rank lower with [decay](packages/markdown/README.md#decay), off by default, and [`reviewNotes()`](packages/markdown/README.md#reviewing-notes) proposes notes to retire or parts to promote.

## Bring your own models

Curate accepts two plain functions.
They can call an API, a local model or a command.
The built-in helpers use `fetch` and need no model SDK.

- **`decide` answers narrow questions.** It receives `{ task, questions }` and an `AbortSignal`. Return an answer under each question's `key`, with `status: 'answered'` and a finite `probability` from 0 to 1. See [`PickDecide`](packages/core/src/pick.ts) for question fields and unavailable answers.
- **`write` turns evidence into log text.** It receives `{ instructions, body }` and an `AbortSignal`. Return the log without a Markdown fence, or an empty string when no evidence bears on the task; Curate asks once more and, if the second reply is empty too, returns an empty log marked `empty: true`. See [`CurateWrite`](packages/core/src/curate.ts) for the full contract.

Use `openAIDecisions()` for [OpenAI's Decisions API](https://developers.openai.com/api/docs/guides/decisions) in place of `jev()`:

```js
import { openAIDecisions } from '@curatejs/core/models';

const decide = openAIDecisions({ apiKey: process.env.OPENAI_API_KEY });
```

The hosted helpers identify their label answers as `typesafe:${model}:items-once` and `openai:${model}`.
For a handwritten `decide`, set its `deciderId` property.
An explicit `pick.labels.deciderId` overrides the function's ID.
Without an ID it uses `'custom'`, so different handwritten decision functions must supply different IDs to keep their saved labels apart.

Curate checks observation dates and cited IDs.
It does not prove that the facts or date calculations are correct.
A reply with invalid format goes back to the writer once with the reason.
If repair fails, Curate keeps valid lines and malformed lines that name a supplied item ID, and drops unsupported lines.
The record's `formatRecovery` lists malformed lines kept as written and lines dropped.
A format error stops curation only when no usable evidence remains.

To use another provider that accepts Chat Completions, give the writer its URL and model:

```js
const write = chatWriter({
  apiKey: process.env.CHAT_API_KEY,
  url: process.env.CHAT_URL,
  model: process.env.CHAT_MODEL,
});
```

### Run it on your own machine

Ranking, deciding and curating can all run against models on your own machine.
The one requirement: the decision server must return log-probabilities.
`localDecisions()` throws when a reply has none, because a pick that cannot judge must not guess.

`localDecisions()` asks an OpenAI-compatible chat server each yes/no question, one request at a time.
It reads the answer from the log-probabilities of "yes" and "no" for the first reply token:

```js
import { chatWriter, jev, localDecisions } from '@curatejs/core/models';

const decide = localDecisions({ url: 'http://127.0.0.1:8000/v1/chat/completions', model: 'my-local-model' });
```

A server that speaks Jev's format, such as a Clef server, can decide through `jev()`.
Give it the address and model name your server uses:

```js
const decide = jev({ url: 'http://127.0.0.1:30000/v1/systemone', model: 'clef-flash' });
```

The writer takes any OpenAI-compatible chat address:

```js
const write = chatWriter({ url: 'http://127.0.0.1:8000/v1/chat/completions', model: 'my-local-model' });
```

Away from TypeSafe's and OpenAI's addresses, an API key is optional, and the helpers send none unless you give one.

For meaning search, use the local embedder (it needs `node-llama-cpp@3.18.1`):

```js
import { memory } from '@curatejs/core';
import { createLocalEmbedder } from '@curatejs/core/local-embeddings';

// A local MiniLM GGUF model file; the adapter downloads nothing.
const local = await createLocalEmbedder({ modelPath });
try {
  const mem = memory({ sources, decide, write, read: { meaning: { embed: local.embed } } });
  const { log } = await mem.recall('What billing constraint must this change preserve?');
} finally {
  await local.dispose();
}
```

Labels from each server are stored under its own ID: `local:<host><path>:<model>` for `localDecisions()`, and `jev:<host><path>:<model>:items-once` for `jev()` at another address.
The ID leaves out the scheme and the query, so set `pick.labels.deciderId` yourself for two servers that differ only there.
A decision cache keeps the `deciderId` you give it, so give each server its own.

### Separate selection and curation

`pickFromSources()` and `curate()` remain available when you need to inspect or change the evidence before writing.
With these separate calls, check the read and candidate records yourself before using the result.

```js
import { pickFromSources, curate } from '@curatejs/core';
import { markdown } from '@curatejs/markdown';

const task = 'What billing constraint must this change preserve?';
const sources = [markdown({ paths: ['docs'], kind: 'docs' })];
const picked = await pickFromSources(sources, { task }, { task, decide });
const result = await curate(task, picked, { write });
```

`pickFromSources()` asks each source its own question set, as `memory()` does.
See the [core package](packages/core/README.md) for question sets, tags, local meaning search and full records.

### The `/curate` skill

The [coding-agent skill](skills/curate/SKILL.md) reads sources and prints a log for a task.
It needs Jev credentials and a signed-in model subscription.
Build the repository and save your source settings outside it:

```sh
pnpm install --frozen-lockfile
pnpm build
node skills/curate/run.mjs --sources sources.json 'Which decisions bear on this task?'
```

Save `sources.json` with your own paths:

```json
{
  "sources": [
    {
      "type": "claude-code",
      "path": "~/history/chat"
    },
    {
      "type": "git",
      "path": "~/projects/example"
    },
    {
      "type": "markdown",
      "path": "~/notes/example"
    }
  ],
  "embeddingModel": "~/models/embeddinggemma-300M-Q8_0.gguf",
  "thoroughness": "normal",
  "envFile": "~/.curate/credentials.env"
}
```

Paths must be absolute or start with `~/`.
Set `TYPESAFE_API_KEY` in the environment or the `KEY=VALUE` file named by `envFile`.
Without `--sources`, the script reads `~/.curate/sources.json`.
Supply a local embedding GGUF through `embeddingModel`. The script requires Metal on macOS and downloads no model.
Optional `compression` sets what the skill prints: `high`, the default, prints the log, and `low` prints the marked-up memory described in [Compression](#compression).
Optional `thoroughness` sets how many ranked history parts the decision model checks: `quick` checks the top 672, `normal` 3,674 and `deep` 12,896, the default.
Measured on a replayed ~116,000-part history, each level cost about 1, 5 and 17 pence of questions on the largest of eight task sets; `quick` kept 24 of the 56 known answer parts, `normal` 49 and `deep` all 56.
Each source can also set `since` (an ISO date or a duration such as `"14 days"`, counted back from the task date), `exclude` (paths that source alone refuses, resolved inside `path`), and, for `git` only, `include` (only commits that changed one of the paths).
The skill combines keyword and meaning lanes, and disables label admission and the rare-word round.
Saved embeddings are reused when the model file and input text match. Identical text shares matching decision answers within each pick.
It prints the log and saves the log, source reads, model usage and timings under `~/.curate/runs/`.
Subscription route failures never fall back to an API.

## Rank, decide, curate

```mermaid
flowchart LR
  sources["Chat, Markdown and git"] --> rank["Rank<br/>Keyword search"]
  rank --> decide["Decide<br/>Narrow questions"]
  decide --> curate["Curate<br/>Dated, cited log"]
  curate --> agent["Agent<br/>Does the task"]
  agent -. "Own tools" .-> sources
```

### Rank

Each reader ranks evidence using settings suited to its source.
Chat and Markdown use BM25, a score for matching words.
Git uses BM25 over each commit's subject and body, plus age and changed paths.
Each search stops keeping results when their match scores level off, rather than after a fixed number.
Set `read.wholeLanes: true` to keep every part the readers return.

- **Extra wording:** Supply `read.searchLines` for phrases or hypothetical answers that describe the evidence you need. Curate does not generate them.
- **Kinds of statement:** Supply `read.kindLanes` for phrases that help find directions, decisions or corrections.
- **Meaning search:** Supply an embedding function, which turns text into numbers for similarity search. It is off by default and needs no database.

### Decide

The decision function answers each reader's narrow questions.
By default, Curate combines search results from all sources into a ranked list.
The decision model checks the top 12,896 reference parts (the `deep` thoroughness level).
Curate keeps those that score at least their source's decision-score bar (0.0146 for every reader), highest scores first.
Unanswered candidates and unfinished decisions stay visible in the record and stop `recall()`.
Parts intentionally excluded by the label questions stay in the record without stopping recall.

- **Feed depth:** `pick.thoroughness` sets how many ranked history parts the decision model checks: 672 for `quick`, 3,674 for `normal` and 12,896 for `deep`, the default. Parts deeper than the level stay unasked and record `thoroughness`. `pick.everyRanked: true` decides every ranked part instead, and `pick.everyRanked: { c }` keeps the top `round(c × N^0.8)` reference parts, where N is the number of reference parts. Rules pass through uncut in every mode. The skipped parts are unassessed, so use the separate selection API to inspect them. Measured on a replayed ~116,000-part history of chat transcripts, Git history and Markdown notes: each level cost about 1, 5 and 17 pence of questions on the largest of eight task sets (about 0.8, 2.3 and 6.6 decide-step minutes), and `quick` kept 24 of the 56 known answer parts, `normal` 49 of 56 and `deep` all 56.
- **Writer inputs:** a source's `bar` sets its score cut. `pick.everyScored: { bar }` sets one cut for every source, and `pick.everyScored: true` keeps every scored reference.
- **More evidence:** Git and Markdown run the rare-word round through their settings, each within its own parts. `pick.rare: true` runs it on every source; `pick.rare: false` turns it off. Under a thoroughness level the round asks its pulled parts only while the depth still has room.
- **Tags:** `pick.tags` labels selected items with their intent, importance, emphasis and whether they correct something earlier.

### Curate

The writer receives reference evidence with dates, source kinds, decision scores and any tags.
It writes observations with event dates, statement dates and source IDs.
When a later fact replaces an earlier one, the log can carry both dates.

- **Space by score:** The instructions ask the writer to retain observations scored 0.6 or more, include useful facts from 0.1 to below 0.6, and give scores below 0.1 little space. `curate.weightBands` sets the two numbers.
- **Batches:** `curate.batchTokens` writes strongest evidence first. Later batches add lines without rewording or removing earlier ones. Evidence over 150,000 estimated tokens is batched by default.
- **Length:** There is no fixed log length cap.

## Plain files and git

The sources remain readable without Curate.
Markdown holds facts and instructions.
Commit bodies can record why a change was made, the options considered and the constraints behind it.
The agent can follow a cited commit with its own tools when it needs the code.

Dates help the writer tell an old decision from its replacement, even when they share the same words.

## Results

Every result, how each run was set up and its proof files are in [benchmarks](benchmarks/README.md).

## Compression

`curate.compression` sets how much Curate shortens the parts it keeps.

- **`'high'`, the default:** the curator writes the dated, cited log.
- **`'low'`:** Curate lists the events in the kept parts. The decision model says which events count. Code adds them up. The memory holds those totals and events. Then come the parts they cite, in the source's own words, with tags that mark events, amounts and tone. It is larger than the log and costs more model calls.

See [the core package](packages/core/README.md#compression).

## Development

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

Build first so dependent packages and integration tests can use core's declarations and package exports.
Each package also supports `pnpm --filter @curatejs/<name> build`, `test`, `typecheck` and `pack`.

## License

[MIT](LICENSE).
