# @curatejs/core

The engine behind Curate.
It ranks the parts of your history, has a decision model rate them with narrow yes/no questions, and lays out what it keeps, strongest first, word for word.
No model writes the text, and every step returns a record of what it did.

Core brings no reader of its own. Add [chat](https://github.com/jonny981/curate/blob/main/packages/chat/README.md), [git](https://github.com/jonny981/curate/blob/main/packages/git/README.md) or [markdown](https://github.com/jonny981/curate/blob/main/packages/markdown/README.md), or [write your own source](#write-your-own-source).
[How it works](https://github.com/jonny981/curate#how-it-works) explains the three steps: rank, decide, curate.

## Install

```bash
pnpm add @curatejs/core @curatejs/markdown
```

You need Node.js 22.20 or later.
The default entry loads no model engine. Only the local embedding entry needs one, `node-llama-cpp`, which you install yourself.

## Example

```ts
import { memory } from '@curatejs/core';
import { jev } from '@curatejs/core/models';
import { markdown } from '@curatejs/markdown';

const mem = memory({
  sources: [markdown({ paths: ['docs'], kind: 'docs' })],
  decide: jev({ apiKey: process.env.TYPESAFE_API_KEY }),
});

const { log, rules } = await mem.recall('What billing constraint must this change preserve?');
```

`log` is the kept evidence, laid out under its source and date, and `rules` the rules that apply, word for word.
The [library reference](https://github.com/jonny981/curate/blob/main/docs/library.md) explains every option `memory()` takes and everything `recall()` returns.

## What it exports

| Export | What it is |
| --- | --- |
| **`@curatejs/core`** | |
| `memory()` | Read, decide and lay out in one call ([library reference](https://github.com/jonny981/curate/blob/main/docs/library.md)) |
| `pickFromSources()`, `pick()`, `curate()` | The three steps, to call yourself ([Call the steps yourself](#call-the-steps-yourself)) |
| `historySource()`, `HistorySettings` | A source with your own settings ([Your own source settings](https://github.com/jonny981/curate/blob/main/docs/library.md#your-own-source-settings)) |
| `Mode`, `rankedRead`, `conversationRead()` | How a source's parts are judged and read: its questions, its keep bar and its read ([Modes](https://github.com/jonny981/curate/blob/main/docs/library.md#modes)) |
| `walksOn`, `opens`, `stops`, `ConversationRules` | The chat read's measured rules, to change with `conversationRead()` ([The chat read](https://github.com/jonny981/curate/blob/main/docs/library.md#the-chat-read)) |
| `HistoryStore` | Where a call keeps a transcript's topic cuts and each unit's words between calls, as `pick.history` ([The chat read](https://github.com/jonny981/curate/blob/main/docs/library.md#the-chat-read)) |
| `ANSWER_QUESTION`, `FACT_QUESTION`, `ANSWER_CASCADE` | The narrow question in two, and the set that keeps by it ([The narrow question in two](https://github.com/jonny981/curate/blob/main/docs/library.md#the-narrow-question-in-two)) |
| `choosePerFact()`, `FACT_CHOICE`, `ENOUGH_QUESTION`, `CHOICE_CANDIDATES`, `CHOICE_OPTIONS`, `ROLE_QUESTION` | A Choice per needed fact, and what each kept part is doing ([A Choice per needed fact](https://github.com/jonny981/curate/blob/main/docs/library.md#a-choice-per-needed-fact)) |
| `KEEP_KINDS`, `PICK_WANTED` | The kinds of message a second stage can keep at bars of their own, and the two kinds of task ([A second stage](https://github.com/jonny981/curate/blob/main/docs/library.md#a-second-stage)) |
| `CandidateSource`, `CandidateReadRequest`, `CandidateReadResult`, `CandidateReadContext`, `SourceReadError` | The contract a source implements ([Write your own source](#write-your-own-source)) |
| `taskNames()`, `classifyTask()` | The names a task mentions, and the kinds of answer its words ask for ([Names](https://github.com/jonny981/curate/blob/main/docs/library.md#names)) |
| `taskPeriod()`, `taskMoment()`, `sinceCutoff()` | The period a task names, the moment a task date means, and the moment a `since` look-back means ([Time](https://github.com/jonny981/curate/blob/main/docs/library.md#time)) |
| `stripSearchInstructions()` | Removes output instructions from search text ([Search lines](https://github.com/jonny981/curate/blob/main/docs/library.md#search-lines)) |
| `LABEL_KINDS`, `LABEL_LANE_BAR`, `LABEL_QUESTION_VERSION` | The seven label kinds, the default label bar (0.5), and the label questions' version ([Labels](https://github.com/jonny981/curate/blob/main/docs/library.md#labels)) |
| `ANSWER_TYPES`, `COUNT_MARKER` | The ten answer-type questions, and a typed question for count tasks ([Answer types](https://github.com/jonny981/curate/blob/main/docs/library.md#answer-types)) |
| `taskQuestionWriter()`, `TASK_QUESTION_PROMPT` | Questions a model writes for each task ([Questions written for each task](https://github.com/jonny981/curate/blob/main/docs/library.md#questions-written-for-each-task)) |
| `ROUTE_QUESTIONS`, `ROUTE_OPTIONS`, `routeOptions()` | The route questions, and the options each answer switches on ([Routing](https://github.com/jonny981/curate/blob/main/docs/library.md#routing)) |
| `DECISION_TAGS` | The shared tag sets ([Tags](https://github.com/jonny981/curate/blob/main/docs/library.md#tags)) |
| `decisionFileStore()`, `decisionKey()`, `storedDecision()`, `levelDistribution()` | The decision cache's file store and its keys ([Decision cache](https://github.com/jonny981/curate/blob/main/docs/library.md#decision-cache)) |
| `addMeaningRanks()`, `cachedEmbeddings()`, `EmbeddingFunction` | Meaning ranks for parts you already have, and a vector store for any embedding function ([Local embeddings](#local-embeddings)) |
| `cutLane()`, `cutScoreCurve()`, `laneBend()`, `laneScoreOf()` | The cut each search lane makes where its scores level off ([Lane cut](https://github.com/jonny981/curate/blob/main/docs/library.md#lane-cut)) |
| `judgmentFacts()`, `judgmentPopulation()`, `modelScore()` | The code facts and fitted score behind a question set's `model` field |
| `jevRequest()`, `jevTextRequest()`, `jevListRequest()` | Build the body of a Jev request: the JSON state, the plain-text form, and a Choice ([Jev](#jev)) |
| `DEFAULT_MAX_QUESTION_TEXT`, `PICK_QUESTION_VERSION` | The default reader part size (700 characters), and the decision questions' version |
| `PickDecide`, `PickCascade`, `PickRecord`, `CurateResult`, `LeverStates`, `SourceSettings` and the other types | The shapes of `decide`, question sets and records |
| **`@curatejs/core/models`** | |
| `jev()`, `openAIDecisions()`, `localDecisions()` | Ready-made decision functions ([Decision models](#decision-models)) |
| `DecisionServiceError` | What `jev()` throws when the service refuses a request or can't be reached ([Jev](#jev)) |
| **`@curatejs/core/local-embeddings`** | |
| `createLocalEmbedder()` | Meaning search with a model on your machine ([Local embeddings](#local-embeddings)) |
| **`@curatejs/core/internal`** | |
| File, git, keyword, vector and stored-index helpers | Shared by the reader packages. It brings no source and no ranking defaults |

## Levers

Every option that trades quality for cost works the same way: turning it on reads more evidence or adds more guidance, at the risk of more cost, and turning it off saves cost but can lose quality.
An option lives in one of four places: a source's own settings, the read request, the pick options, or the layout options.
The record keeps the resolved state of every lever under `levers` ([The record](#the-record)).
Options you pass to `memory()` apply to the whole call, beside each source's own settings:

```ts
const mem = memory({
  sources: [historySource({ reader: chat(), ...chatSettings, mode: agentTranscripts }), git('.')],
  decide,
  read: { wholeLanes: true },
  pick: { everyScored: { bar: 0.05 } },
  curate: { answerTokens: 4000, sentenceCutoff: false },
});
```

| Lever | Set on | Default | Cost when on |
| --- | --- | --- | --- |
| [`wholeLanes`](https://github.com/jonny981/curate/blob/main/docs/library.md#lane-cut) | Read | Off | The decision step also reads the parts each lane's cut would drop, and deciding is the costly step |
| [`stopWhenCold`](https://github.com/jonny981/curate/blob/main/docs/library.md#the-rating-stop) | Pick | Off | On saves cost: it rates the parts before the ratings go cold, and at most one wave past them |
| [`everyRanked`](https://github.com/jonny981/curate/blob/main/docs/library.md#every-ranked-part) | Pick | Unset | `true` decides the whole ranking; `{ c }` decides `round(c × N^0.8)` parts |
| [`bar`, `everyScored`](https://github.com/jonny981/curate/blob/main/docs/library.md#keep-bars) | Source's mode, pick | Each mode's `bar`, 0.0146 | A lower bar sends more parts to the layout: about 70 of a LongMemEval history's 850 at 0.0146 |
| [`labels`](https://github.com/jonny981/curate/blob/main/docs/library.md#labels) | Source | On for chat | One question per kind for each part and task, once per text, kind set and decision model; later picks reuse the stored answers |
| [`route`](https://github.com/jonny981/curate/blob/main/docs/library.md#routing) | Pick | Off | Four questions of the task, once a pick |
| [`wholeMessages`](https://github.com/jonny981/curate/blob/main/docs/library.md#whole-messages) | Source's mode | Off | 2.47 times the request text on one coding-agent history |
| [`hardFacts`](https://github.com/jonny981/curate/blob/main/docs/library.md#hard-facts) | Source's mode | Off | 1.48 times the request text, batched |
| [`itemsPerRequest`](https://github.com/jonny981/curate/blob/main/docs/library.md#items-per-request) | Source's mode | Off | One part a request: 1.38 times the request text on pieces, and a request for each part |
| [`roles`](https://github.com/jonny981/curate/blob/main/docs/library.md#what-each-kept-part-is-doing) | Source's mode | Off | One Choice per kept part, after selection: about one request a LongMemEval question |
| [`choicePerFact`](https://github.com/jonny981/curate/blob/main/docs/library.md#a-choice-per-needed-fact) | Source's mode | Off | One Choice per needed fact a round, after selection, the rounds one after another |
| [`keep`](https://github.com/jonny981/curate/blob/main/docs/library.md#a-second-stage) | Source's mode | Off | The read's kept parts judged again: about 2.7 cents a coding-agent task, batched |

The [measurements](https://github.com/jonny981/curate/blob/main/docs/measurements.md) show what each lever gains and costs.
The decision cache isn't a lever: it loses no quality, so it's on whenever you pass one.

Some options have new names. An old name throws a `TypeError` that names its replacement:

| Old name | Use |
| --- | --- |
| `pick` | `everyRanked` |
| `thresholds.reference` | `everyScored` |
| `thresholds.referenceBySize` | `everyScored.bySize` |
| `laneCut` | `wholeLanes` |
| `meaning.laneCut` | `meaning.wholeLanes` |
| `thoroughness` | `stopWhenCold` |

## Call the steps yourself

`memory()` runs three calls you can also make yourself, to inspect or change the evidence between them:

```ts
const picked = await pickFromSources(sources, { task }, { task, decide });
const result = await curate(task, picked, { decide });
```

| Call | What it does |
| --- | --- |
| `pickFromSources(sources, request, options)` | Reads every source with `request` (the `read` options), then picks over all their parts with `options` (the `pick` options). Returns a `PickSourcesResult`: `reads`, `selected` and `record` |
| `pick(candidates, options)` | Ranks parts you already have, asks `decide` in bounded requests, and returns the kept parts with a `PickRecord` |
| `curate(task, picked, options)` | Lays out the kept reference parts of either result. Returns `{ log, record }` ([The layout record](#the-layout-record)) |

Called this way, an absent or partial read and an undecided part don't throw, so check `reads` and the record yourself; a read error or a [failed decision](#when-a-decision-fails) still does.
A rule source that was absent or returned `complete: false` makes the record's `rulesCoverage` `'incomplete'`, even when every rule it did return was answered; `rulesEnumerationComplete: false` in the options does the same.

### Settings by source

`pickFromSources()` takes each source's settings from the source.
A direct `pick()` has parts, not sources, so it takes them as maps keyed by each part's `sourceId`:

| Option | What it holds |
| --- | --- |
| `modesBySource` | Each source's mode, such as `{ conversations: assistantChatHistory }`: its questions, keep bar and read. A source it doesn't name asks the built-in question, keeps at 0.0146 and takes the ranked read |
| `ruleBarBySource` | Each source's rule bar |
| `labelKindsBySource` | Each source's label kinds; an absent or empty entry means no label work |
| `labelBarBySource` | Each source's label bar |
| `queriesBySource` | Each source's search texts, the task first, which the chat read ranks units of agent work against. `pickFromSources()` fills a source it leaves out with the call's task and search lines |
| `embed` | The call's embedding function, for the same ranking. `pickFromSources()` takes it from the request's meaning lanes |
| `sourceKinds` | Each source's kind, such as `{ conversations: 'chat' }`, for `tagsByKind`. A source's own declared kind wins. With `tagsByKind`, the record keeps the map and each entry its `sourceKind` |

```ts
const picked = await pick(candidates, {
  task,
  decide,
  labelKindsBySource: { [source.id]: labelKinds },
});
```

`pickFromSources()` also tells `pick()` how each source was read, through `readsBySource`: the option each search rank came from, the extra lanes the read request gave, and whether the read kept whole lanes.
A direct `pick()` without it gets no extra-lane or `wholeLanes` entries in its [effects](#what-each-setting-did).

A direct `pick()` that passes `searchRanks` on its parts must put the task's own search at index 0 and extra searches after it, with ranks for every part of each searched source.
Each rank is zero-based within its source, `null` means the part was absent from that search, and the lowest rank becomes the part's `priority`.
Sources without ranks keep their ordinary signal order.

### When a decision fails

A `decide` call that throws fails the pick with a `PickError`, unless the elapsed limit stopped it or your signal cancelled it.
Its message leads with the decide error's own message, then says how many parts of the refused request weren't decided, and its `cause` is that error.
The error's `record` names the request's parts and holds the error's message in `decideError`.
A failed decision request leaves its parts unanswered, even if an earlier request answered some of their questions. There's no retry and no fallback.

## Decision models

`@curatejs/core/models` has three ready-made decision functions, built on Node's own `fetch`.

| Helper | Options | Default model | Talks to |
| --- | --- | --- | --- |
| `jev()` | `apiKey`, `model`, `url`, `onCall`, `requestsPerSecond`, `tokensPerSecond` | `'jev-latest'` | TypeSafe's System One endpoint, or any server that speaks Jev's format at `url`, such as a Clef server |
| `openAIDecisions()` | `apiKey`, `model` | `'gpt-6-luna'` | OpenAI's [Decisions API](https://developers.openai.com/api/docs/guides/decisions) |
| `localDecisions()` | `url`, `model`, `apiKey` | You name it | An OpenAI-compatible chat completions address |

At their default addresses, `jev()` and `openAIDecisions()` make paid model calls; `jev()` needs an API key there, and `openAIDecisions()` always does.
Each helper sets `deciderId`, the ID its labels and cached decisions are stored under ([Label IDs](https://github.com/jonny981/curate/blob/main/docs/library.md#label-ids)).
A missing or invalid probability in a reply becomes a missing answer.
No `authorization` header is sent without a key, and cancellation reaches `fetch`.

### Jev

A Jev request goes in one of two forms ([The request's form](https://github.com/jonny981/curate/blob/main/docs/library.md#the-requests-form)):

- **The JSON state,** the default. The state is a JSON object: the batch's task, the facts the answer needs when the batch carries them (`needed`), and each item once, as a record under its number in `items`, with its id, date, title and text, its `author` where its reader marked one, and any fields code wrote about it. Each question's instructions are an object holding its wording and its item's path, such as `items.3`. `jevRequest(batch, model?)` builds this body.
- **Plain text,** for a mode that asks with `request: 'text'`. The state is the task, then each item once, numbered, with its id, date, title and text. Each question's instructions are its wording followed by its item's number. `jevTextRequest(batch, model?)` builds this body.

Either way, an item asked seven questions is sent once. Both builders come from `@curatejs/core`.

Jev limits a request to 32,000 tokens for the state plus the longest question, and 64,000 for the whole request.
At an estimate of three characters a token, `jev()` splits a batch so that each request's state plus its longest question's instructions and criteria is at most 96,000 characters, and the whole body at most 192,000.
An item's questions always go in its item's request, and an item larger than those bounds goes alone. The answers come back as one map for the batch.

If the service rejects a request as too large (HTTP 400 or 413), `jev()` splits it in two, each item keeping all its questions, and splits a rejected half again.
A lone item is resent with its text halved, and its answers are marked `truncated`.
`jev()` remembers the largest body the service accepted and plans later batches inside it after a rejection. The service counts tokens, not characters, so a request at or under that size can still be over its limit: one whose reply says so (`max_tokens_exceeded`) is split like any other. A request rejected at or under that size for any other reason, or a lone item cut to nothing, didn't fail for size, so the reply is thrown as sent and the error carries its whole body.

On HTTP 429 (over a rate limit) or 529 (the service overloaded), `jev()` waits as the reply asks and sends the same request again, for at most 60 seconds from the first such reply.
It reads `retry-after-ms` first, as TypeSafe's own client does, then `Retry-After`, and waits one second when neither is there.
A request that gets no reply, such as one whose connection timed out, is sent again a second later, for at most 60 seconds from its first try; a cancelled one is never sent again.

Any failure throws a `DecisionServiceError`, whose message leads with the reason and then gives the service's own message:

| `reason` | When | Message starts |
| --- | --- | --- |
| `credit` | HTTP 402 | `The decision service has no credit (HTTP 402)` |
| `key` | HTTP 401 or 403 | `The decision service refused the API key` |
| `busy` | Still 429 or 529 after 60 seconds; the message gives the time waited | `The decision service is still rate-limiting requests`, or `is still overloaded` |
| `unreachable` | No reply | `The decision service could not be reached` |
| `refused` | Any other status | `The decision service refused the request` |

It also carries `status` (0 with no reply), `reply`, the reply's whole body, and `said`, the service's message.
A cancellation stays a cancellation.

#### Rate limits

TypeSafe sets request and token rates per organization and shows them in its developer console.
Set yours with `requestsPerSecond` and `tokensPerSecond`: `jev()` queues every request inside both and never sends faster.
Unset, it keeps to 320 requests and 400,000 estimated tokens a second, at three characters a token, as stand-ins; TypeSafe publishes no figures and its replies carry no rate headers.

On one call of 141 requests, raised in steps with no 429 or 529 at any pace, the decision step took 22.1 seconds at 100,000 tokens a second, 15.1 at 200,000, 11.9 at 400,000, 14.6 at 800,000 and 19.2 unpaced.
Past 400,000 the service answered each request more slowly: the slowest tenth took over 0.37 seconds at 400,000, 1.0 at 800,000 and 4.1 unpaced.
A pace that slows itself when the service's replies slow down isn't tried.

`onCall` is called once per request, planned, split and resent alike, with a `JevCall`: when it was sent, the number of questions, the body's size, the reply's status, the milliseconds it took, and the usage and answers the reply held.
Its `splits` counts the extra requests a rejection caused: 2 for a split, 1 for a resent item, 0 otherwise.
A request that got no reply, from a network failure or a cancellation, is reported with status 0 and the failure's message in `error`, each try on its own. A cancellation, or no reply after 60 seconds of tries, fails the pick.

### OpenAI

`openAIDecisions()` turns predicate answers into probabilities, and a refusal into `{ status: 'refused' }`.

### Local

`localDecisions()` sends one request per question, one after another.
Each request holds the task, the question with its true and false criteria, and the item's id, date, title and text, and asks for one token with `temperature: 0`, `logprobs: true` and `top_logprobs: 20`.
The answer is the probability of the "yes" tokens over the "yes" and "no" tokens among the first token's top log-probabilities, ignoring case and leading spaces; with neither there, the answer is missing.
A reply with no log-probabilities throws `The model server at <url> returned no log-probabilities; localDecisions needs a server that does.`

## Local embeddings

`createLocalEmbedder()` from `@curatejs/core/local-embeddings` runs a sentence embedding model on your machine, for [meaning search](https://github.com/jonny981/curate/blob/main/docs/library.md#meaning-search).
Install its runtime first:

```bash
pnpm add node-llama-cpp@3.18.1
```

```ts
import { pickFromSources } from '@curatejs/core';
import { createLocalEmbedder } from '@curatejs/core/local-embeddings';

// A local MiniLM GGUF model file; the adapter downloads nothing.
const local = await createLocalEmbedder({ modelPath });
try {
  const picked = await pickFromSources(
    sources,
    { task, searchLines, meaning: { embed: local.embed } },
    { task, decide },
  );
} finally {
  await local.dispose();
}
```

| Option | Default | What it does |
| --- | --- | --- |
| `modelPath` | Required | A model file in GGUF form. Nothing is downloaded |
| `cacheDirectory` | None: vectors last only while a batch is scored | Keeps vectors on disk, keyed by the model's bytes and each input's full text |
| `gpu` | `'auto'` | Name a backend to require it, such as `'metal'` for the Mac GPU. If it's unavailable, the call stops rather than falling back to the CPU |

It returns `embed`, `gpu` (the backend in use) and `dispose()`.

It takes sentence embedding models that read plain text.
The tested model is [MiniLM-L6 Q4](https://huggingface.co/second-state/All-MiniLM-L6-v2-Embedding-GGUF), a 19,699,648-byte model with 384 dimensions, on the same Node runtime as QMD's larger EmbeddingGemma model.
A model that needs query or document prompts needs your own embedding function.

Nothing is cut to fit the model: a longer input is embedded in token windows, and their normalised vectors are averaged by token count.
A part whose body is only whitespace or invisible formatting is embedded by its title, as is a commit with only a subject, and its own body and title stay in the evidence.

### Where vectors are kept

With `cacheDirectory` set, each model keeps its normalised 64-bit vectors in two files:

| File | What it holds |
| --- | --- |
| `<model>.vectors.data` | One record per text, each added after the last |
| `<model>.vectors.keys.sqlite` | Where each text's record is, found by the text's SHA-256 |

A read looks up the records it needs, or passes over the data file once, a chunk at a time, when it needs most of them; neither file is ever read whole into memory.
Nothing rewrites a record and no vector expires, so the vectors of deleted or changed parts stay.

A record cut short by a stopped write is never used, and its text is embedded again. A vector of the wrong length for the model is kept in the key file.
The files hold hashes and vectors, never source text, and stay apart from the [stored index](#stored-index), which does hold your history's text.

The chat and Markdown stored indexes keep each part's vector key, so Curate finds those vectors without hashing the text again.
A returned vector can be shared with other callers: read it, don't write to it.
Repeated inputs reuse the files across calls.

When the key file is first made, it takes in every vector the earlier formats hold: `<model>.vectors.flat`, the vectors waiting to join it in `<model>.vectors.waiting.sqlite`, and, when there's no `.flat` file, the store before it, `<model>.vectors.sqlite`.
Using the store deletes nothing, since an older process can still have those files open.

Between calls, `removeEarlierFiles()` on the cached `embed` deletes the `.flat` file and the waiting store once every vector in them is found again in the new files, byte for byte, and returns the paths it deleted. If one can't be checked, both stay and a line on standard error says so; `curate prepare` calls it.
`<model>.vectors.sqlite` is only ever read, so an older checkout sharing the folder keeps its vectors, and a text the files don't hold is read once from the earlier per-text JSON files, which are never written.

`cachedEmbeddings(embed, { directory, modelId })` gives any embedding function the same store.
`withProgress(progress)` returns the same store and calls `progress(embedded, missing)` as an embedding goes: 0 before the first batch, then after each batch of 32. A lookup that embeds nothing never calls it.

Two processes embedding the same texts share the work. Each looks a batch up again just before it embeds it and reads what the other stored meanwhile, and every other embedding starts from the far end of its list. Two calls started together over 640 texts embedded 672 between them, where each used to embed all 640.

### Meaning ranks for parts you already have

`addMeaningRanks(candidates, task, { embed, searchLines })` returns the same meaning ranks `pickFromSources()` would add, for `pick()`.
An `EmbeddingFunction` returns one vector per full input text, in input order.
The helper compares vectors by cosine similarity (their direction, not their length) and breaks ties by candidate id.

## Write your own source

A source implements `CandidateSource`: an `id`, a `role` (`reference`, `rule` or `mixed`), and a `read(request)` that returns a `CandidateReadResult`.
A read ends in one of three ways:

| Outcome | When |
| --- | --- |
| `status: 'read'` | It found parts. Set `complete: false` if it stopped early or skipped anything |
| `status: 'absent'` | It expected nothing, such as no folder or no store. Not an error; give the reason |
| Throws `SourceReadError` | A real failure, such as an unreadable file or a corrupt store, or `code: 'cancelled'` when the read was cancelled |

`pickFromSources()` reports a source whose read fails (`code: 'failed'`) as `absent`, with the reason `the read failed: <message>`, and reads the others.
When every source failed, it throws the first failure.

Refuse the request's `exclude` paths before you open anything, so excluded text never reaches a signal or a model.
Resolve a `revision` pin once and use it for everything the read does; if you can't honour a pin, answer `absent` rather than guess.
A part's `text` is a snapshot of exactly the text you scored.

A source can declare `maxQuestionText` as its preferred part size, and `Infinity` asks for whole items by default; a caller's own text size wins.
Wrap the source with [`historySource()`](https://github.com/jonny981/curate/blob/main/docs/library.md#your-own-source-settings) to give it settings and a question set.

### Streaming reads

A reader that only returns its ranked parts needs nothing more: the pick filters and cuts each lane itself.
A reader that streams can do that work inside the read, so a large history's text is never held in memory. `pickFromSources()` marks each read with what the lane needs:

| Request field | What the reader does |
| --- | --- |
| `phraseLane: true` | `task` is an exact phrase to match, not keywords to score: keep the matches without scoring the whole history |
| `topic` | On a kind lane, the task the lane serves: rank each phrase match by it |
| `meaningLane` | Carries the embedding function: score each part's similarity inside the read and return only the kept parts, flagged `meaningLane` |
| `wholeLanes: false` | Cut the lane at its own score curve (`laneBend()` gives the same bend `cutLane()` would) and return only the kept parts. `limit` on a kind or meaning read caps the kept set after the curve |
| `taskPeriod` | Return the parts dated from `from` to `to`, whatever their match |

A read that cut its own lane sets `laneCutApplied: true` and `matched`, the lane's count before the cut, so the pick never cuts twice.
A reader that ignores these fields leaves both unset, and the pick cuts as before.
The request type lists its other fields, each marked as internal to `pickFromSources()`.

### Read context

`context.files` shares file text between lanes and overlapping sources in one pick, up to 64 MB: inside the cap a file is read once, and past it each pass reads again, so a large history is never held whole.
A read context lasts one call, so pass a new one to each call.
Within it, the chat, git and Markdown readers keep what a later read of the same call would redo: the stored index update and its folder walk, the Markdown reader's `git status` and git date lookups, and each Markdown note parsed from the stored index. Parsed notes sit outside the 64 MB cap until the call ends.

### Stored index

The chat, git and Markdown readers each keep one local file per source, made on its first read.
Every search lane then reads that file instead of decoding transcripts, fetching each commit from git or parsing notes again.
It's SQLite, through `node:sqlite`, which is built into Node, so there's no database server.

- **Where.** `$XDG_CACHE_HOME/curate/index`, or `~/.cache/curate/index` when `XDG_CACHE_HOME` is unset. Set `index: { directory }` on the reader to choose another folder.
- **Permissions.** The folder is mode `0700` and the file `0600`, because the file holds your history's text.
- **Turning it off.** `index: false` on the reader reads the source directly every time.
- **Ranks.** Unchanged: a lane read from the file returns the same parts, in the same order, with the same signals, as with `index: false`.
- **Node.** Node 22 prints `ExperimentalWarning: SQLite is an experimental feature and might change at any time` when the file is first opened, and Curate doesn't hide warnings. A Node without `node:sqlite` stops the read with an error that says so.
- **Record.** `record.index` says, by source id, what each update did ([Record fields](#record-fields)).

```ts
import { chat } from '@curatejs/chat';

const source = chat({
  providers: ['claude-code'],
  index: {
    directory: '/tmp/curate-index',
  },
});
```

The file's name comes from the source id, a format version, and the settings that decide which parts exist, so a change to any of them names a new file and a stale one is never read:

| Reader | Settings in the name |
| --- | --- |
| Chat | `includeTools`, the part size, the source's own `exclude` and the keyword `stem` setting |
| Git | The source's own `exclude`, `paths` and `since`, and the part size when it isn't the default 700 |
| Markdown | The reader (`markdown()`, `knowledgeBase()` or `rules()`), the kind, the part size and the source's own `exclude` |

A read context's `onFirstIndex(source, done, total, unit)` hears how far a file built from nothing has got, from 0 to every transcript, Markdown file or commit read. A file that already holds the source never calls it.

A read never deletes a file an earlier format wrote, since an older reader may still have it open.
A run between calls does: a read context given a `removed` list brings the file up to date, deletes the files earlier formats wrote for the same source and settings, and adds each deleted path to the list. `curate prepare` runs this way.

The file holds every part the reader produces, with its id, title, text, date and metadata, plus a word count for each word in each part, so a keyword lane reads its counts from the file.
Chat stores its words stemmed when its settings stem, git stores the subject and body's words together (a long commit cut into parts stores each part's words, the subject with the first), and Markdown also stores each note's frontmatter, fields, links and whether it says it was replaced.
Chat and Markdown also keep each part's vector key (for chat, the key of the part together with the part before it in its transcript, which is what a meaning lane embeds unless a date window starts between them), and a phrase index (SQLite's FTS5) that finds the parts holding a phrase, name or kind-lane phrase, with the same results as scanning every part.
Chat stores each part's scrubbed id, made under the real path of the folder it was read from; a read through another path makes the ids again.

#### Keeping it up to date

The file is brought up to date on the first read of each call, before that read's lane, and the call's later reads share the update.
A read with no read context updates the file on its own.

| Reader | What it reads again |
| --- | --- |
| Chat | A transcript that grew, whose stored bytes ended a line and still start and end with the same kilobyte, has only its new bytes read. Any other change reads it again whole. A new transcript is read, and a removed one's parts are deleted |
| Git | Commits the file doesn't hold. If a stored commit is no longer reachable from the head, the file is emptied and every commit read again. Git only lists commit names, once per call and date range |
| Markdown | Notes that are new, or changed in size or modification time. A note gone from the folder loses its parts on a read that excludes nothing. The folder walk and the check for uncommitted changes run once per call |

Git's commit count, word counts and average length depend on the call's look-back, filters and limit, so they're counted for each call over the commits the lane ranks.
A git read pinned to a revision uses the file only when this call brought the file to that commit; any other pinned read runs git directly. A pinned Markdown read reads the files directly.

Markdown stores each file's last commit date with the head it was read at, and runs `git log` again only when the head moves. A shallow clone, or a repository with replacement refs or grafts, can show other history without its head moving, so its dates are never stored and its log runs every call.

A path the source's own `exclude` names is never written to the file.
A path the request's `exclude` names is never opened, returned or scored, but its stored parts stay for calls that do read it.
Git records a commit the source's `exclude` names, or one that changed none of its `paths`, by name only, and never reads its subject or body. A commit dated before the source's `since` or after the task date is left unread and unwritten, so a later call whose dates include it reads it then.

Each update that changes the file adds one to its update count (SQLite's `user_version`).
If another update moves the count after a read took its parts, that read's phrase lookups name every part it holds, as a scan would.

## The record

Every pick returns a `PickRecord`, and every layout a `CurateRecord`.
They say which settings were on (`levers`), what each one did (`effects`), and what happened to every part.

### Levers in the record

`levers` holds the resolved state of every lever, and `levers.sources` maps each source id to the settings it ran with, a `SourceSettings`:

| Field | What it holds |
| --- | --- |
| `kind` | The source's kind, when it declares one |
| `mode` | The name of its mode, when it carries one |
| `labels` | Whether labels ran on its parts |
| `labelBar` | The label bar it used, when it carries label kinds |
| `bar` | The bar its reference parts were cut at, 0 when every rated part was kept |
| `ruleBar` | The bar its rules were cut at, when it produced rules |
| `questions` | The question set its reference parts were asked, when it carries one; absent means the built-in question |
| `textShare` | Its mode's text share, when it sets one |
| `wholeMessages`, `hardFacts`, `roles` | `true` when its mode turns that lever on |
| `itemsPerRequest` | How many items one decision request held, when its mode sets it |
| `request` | `'text'` when its mode asks in plain text |
| `keep` | Its mode's second stage: its questions, the bar it kept at for this pick, and its own settings |
| `stageOff` | `true` when its mode's second stage keeps each kind at its own bar and the source marked no message as the person's: the stage didn't run, and `keep` is absent |
| `choicePerFact` | When its mode compares its kept parts for each needed fact: the candidates a fact, and the sufficiency bar |
| `decay` | The half-life its parts ranked with, when `decay` is on. Only a `pickFromSources()` record has it |

A chat source with labels on reads `{ kind: 'chat', mode: 'agent-transcripts', labels: true, labelBar: 0.5, bar: 0.0146 }`.
The reader's `since`, `paths` and `exclude` sit beside these.

`levers.everyScored` appears only when the call set it.
`levers.stopWhenCold` holds `{ floor, share, parts }`, or `false` when off, whenever `everyRanked` is unset. `parts` is `'request'` when the read judged each request alone. `levers.everyRanked` appears only when the call set it, and the two never appear together.
When `meaning.wholeLanes` differs from the read's `wholeLanes`, the record holds `levers.wholeLanes: { keyword, meaning }`.

### What each setting did

`levers` says which settings were on; `effects` says what each one did.
Each entry names one setting that was on and the source it acted on, counts the parts it looked at and the kept parts it brought in or kept out, and says in a sentence why when it changed nothing.
A setting that was off has no entry, and every count comes from the one pick that ran.

A part reaches the decision step one or more ways: the task's own keyword lane, an extra lane (a search line, a phrase, a name or a meaning query), the label lane, a whole-lane read past the lane cut, the task's period, or a commit's link to a note.
A setting counts a kept part as `added` only when that was the part's only way in and the link didn't keep it, so a part two ways brought in counts for neither.
A lane is a way in only for the parts inside its `maxCandidates`, and a search line that repeats the task opens no lane, which its entry says.

| Setting | Has an entry when | `actedOn` | `added` | `dropped` |
| --- | --- | --- | --- | --- |
| `labels` | The source carries label kinds; the summary names its label bar | Its parts labelled this pick, asked or reused | Kept parts whose only way in was the label lane | 0: labels never remove a part a lane holds. `null` when something ended the feed early |
| `searchLines`, `searchPhrases`, `meaning` | The read request set that option | Parts those lanes held | Kept parts whose only way in was those lanes | 0, or `null` when something ended the feed early |
| `names` | The source's `names` is on | Parts the name lanes held | Kept parts whose only way in was a name lane | 0, or `null` when something ended the feed early |
| `wholeLanes` | `read.wholeLanes` is on | Parts read past the lane cut | Kept parts whose only way in was the whole-lane read | 0, or `null` when something ended the feed early |
| `taskPeriod` | `taskPeriod` is on, the default | Reference parts dated inside the period; 0 when the task names none | Kept parts whose only way in was the period | 0, or `null` when the task named a period and something ended the feed early. When it added none, the summary says why: no period, none of its parts kept, every one already in a search lane, or each with another way in |
| `linkedPathBar` | The pick holds a reference part with a `path` and a `repository` | Reference parts below their bar but at or above the link bar, with a `path` and a `repository` | Parts kept through the link | 0 |
| `bar` | Always, for a source with reference parts | Its rated reference parts | 0 | Rated parts below the bar that nothing later kept. The link and a typed question's `keepAt` can still keep a part below the bar |
| `ruleBar` | The source has rules and a bar above 0; the summary says how many were asked, picked and dropped | Its rules asked | 0 | Rules below the bar |
| `decay` | The source has `decay` on | The dated parts its read ranked | Parts its lanes, taken together, kept only because decay ranked others lower | Parts every lane left out only because decay ranked them lower. Both are counted in the read, before the decision step, from one set of scores |
| `alwaysOnSkipped` | The read skipped files the agent's harness loads every session; the summary names each file and why | The files skipped | 0 | `null`: a skipped file is never split into parts |
| `everyScored` | The call set it | As `bar`, which it replaces | 0 | As `bar` |
| `everyRanked` | The call set `{ c }` | Ranked parts | 0 | `null`. The summary says how many parts the cut left undecided |
| `feed` | The call set a `size` | The source's ranked reference parts | 0 | `null`. The summary says how many parts the size kept and left undecided |
| `stopWhenCold` | The call set the stop | The source's parts in the fused order | 0 | `null`. The summary says what ended the read (the order's end, the ratings going cold and where and why, or a limit, a time-out or a cancellation) and how many of the source's parts it rated and left unread |
| `typed` | The source's question set has typed questions | Parts asked at least one typed question | Kept parts that reach the bar only with the typed terms, and parts a `keepAt` kept | Parts below the bar only because of the typed terms that nothing later kept |
| `written` | The set has `written` weights | Parts asked at least one written question | Kept parts that reach the bar only with the written terms, apart from parts a `keepAt` keeps | Parts below the bar only because of the written terms that nothing later kept |
| `named` | The set has `named` | Parts asked at least one name question | Kept parts that reach the bar only with the name terms, apart from parts a `keepAt` keeps | Parts below the bar only because of the name terms that nothing later kept |

Labels, extra lanes, `wholeLanes` and the task's period also change the order of the decision feed.
That order only matters when something ends the feed early: an `everyRanked: { c }` cut, a `feed` size, the rating stop or a stopping limit.
Then one of these settings can swap one kept part for another even when every part had two ways in, and since one pick can't say which parts would have been decided without it, `dropped` is `null` and the summary says the feed ended early.

To know which parts lie past the lane cut, a read with `wholeLanes` on still finds the cut.
It marks each part that every lane holding it holds past the cut with `pastLaneCut: true`, on the part and on its record entry, and returns the same parts as before.

For example, a direct `pick()` over every part of a 400-part chat history, with labels on, decides every part, so labels had nothing to add:

```json
{
  "setting": "labels",
  "source": "chat",
  "actedOn": 400,
  "added": 0,
  "dropped": 0,
  "summary": "labels on chat: labelled 400 parts, but every part was already going to the decide step, so labels added none. It added no part."
}
```

The same history through `pickFromSources()`, where the keyword lane holds 60 parts, gives the label lane parts to add:

```json
{
  "setting": "labels",
  "source": "chat",
  "actedOn": 400,
  "added": 56,
  "dropped": 0,
  "summary": "labels on chat: labelled 400 parts; 70 reached the decide step only through the label lane, and 56 of them were kept."
}
```

Check `effects` before you pay for answers in a benchmark or a tuning run.
A setting with `added` and `dropped` both 0, not `null`, brought in no part and kept out none, but it may still have changed the order of the kept parts, and `curate` breaks equal ratings by that order.
To prove two runs gave `curate` the same input, compare their kept parts in order.

### Parts that weren't rated

A part that was never rated records `unassessed` with a reason:

| Reason | Why |
| --- | --- |
| `'stopWhenCold'` | It sat past the rating stop. It also records its `place` in the fused order, counted from 0 |
| `'chatRead'` | A [chat read](https://github.com/jonny981/curate/blob/main/docs/library.md#the-chat-read) stopped before reaching it. It also records its `place` in that read's order |
| `'feed'` | No lane placed it in the order, or it sat past a `feed` size |
| `'pick'` | It sat below an `everyRanked: { c }` count |
| `'gate'` | The keyword lanes never held it, and its stored or answered labels left it out. A part a lane limit cut or a stop left unlabelled keeps that reason instead |
| `'limits'` | A lane's candidate limit cut it |

`memory()` accepts `'gate'`, `'stopWhenCold'`, `'chatRead'` and `'feed'`, and throws for the others.
Parts that no lane kept sit in the record the same way, so an unordered part is unassessed rather than missing.
A source whose mode has a read of its own, such as `conversationRead()`, keeps every part, since that read walks each part's whole transcript.
When the source's mode reads with `rankedRead`, as a source with no mode does, the source asks no label kinds and the task names no period, `pickFromSources()` only counts them: `unheld` holds, by source id, how many parts of each history no lane kept, and neither `candidates` nor a read's candidates in `reads` lists them. `pick.n` still counts every part, and a part only a meaning lane kept follows the keyword lanes' parts in those lists, in the order the meaning lanes reached it.

### The rating stop's record

The record's `pick` field keeps `n`, `sent`, `questions`, `kept` and `ranking` (`'fusion'` or `'keyword'`).
With the stop on, `pick.stopWhenCold` adds:

| Field | What it holds |
| --- | --- |
| `floor`, `share`, `parts` | The two levels used, and the window: the fewest rated parts a run of whole requests holds, or `'request'` |
| `waves` | The rounds of requests sent |
| `windows`, `rated` | The windows it judged, and the parts of the order it rated |
| `unread` | The parts of the order it never rated |
| `kept` | Rated parts at or above their keep bar |
| `atFloor` | Rated parts at or above the floor |
| `ended` | `'order'` when it reached the order's end; `'cold'` when the ratings went cold; or the limit that ended it first: `'limits'`, `'time'`, `'cancelled'` or `'error'` |
| `cold` | When it went cold: the `window` that did, counted from 1, its `best` rating, the best rating before it (`bestBefore`) and the test it failed (`under`) |

A read that reached the order's end records `kept: 0` when nothing reached the keep bar, and `atFloor: 0` when nothing reached the floor.
Under `everyRanked: { c }`, the `pick` field keeps `n`, `sent`, `questions`, `c`, `kept` and `ranking`.

```ts
const picked = await pick(candidates, { task, decide, stopWhenCold: { share: 0.1 } });
picked.record.pick?.stopWhenCold;
// { floor: 0.1, share: 0.1, parts: 150, waves: 2, windows: 3, rated: 520, unread: 1480, kept: 37, atFloor: 21, ended: 'cold',
//   cold: { window: 3, best: 0.04, bestBefore: 0.92, under: 'floor' } }
```

A chat read keeps its own numbers under `pick.chatRead`, one entry for each such read of the call, under the name of the mode it read (`agent-transcripts` for `chat()`'s):

| Field | What it holds |
| --- | --- |
| `requests` | The requests read before the stop |
| `segments`, `units` | The topic segments and the units of agent work it opened |
| `rated` | The parts its own requests rated |
| `reused` | The parts whose decision came from the decision cache. They count toward its stop with their stored ratings, so a run whose decisions are stored reads as the run that stored them did |
| `unread` | The chat parts of the order it left unread |
| `ended` | `'fall'` when new well-rated parts fell off, `'order'` when the order ran out first, or the stopping dial that ended it |

### Record fields

| Field | What it holds |
| --- | --- |
| `PickRecord.effects` | A `PickSettingEffect[]`: one entry per setting that was on, per source it applied to |
| `PickSettingEffect` | `setting`, the setting's name as you write it; `source`; `actedOn`; `added`; `dropped`, or `null` when one pick can't tell; and `summary`, one plain sentence |
| `PickRecord.pick` | On every pick. `n`, the history's size in reference parts; `sent`, the reference parts the decision model was asked at least one task question about (a cached answer doesn't count); `questions`, the task questions actually sent (label questions count on `labels`); `stopWhenCold`, `chatRead`, `feed` (order, size and unjudged count), `c`, `kept` (the reference parts the feed sent to the decision step) and `ranking` |
| `PickRecord.keep` | When a mode has a second stage: the items asked, the stage's requests, the questions left unanswered, the parts of a kind at a bar of 1 it didn't ask about (`notAsked`), and per source the parts kept and left out, the bar, and the parts kept as part of an exchange (`byExchange`) |
| `PickRecord.choicePerFact` | When a mode compared its kept parts for each needed fact: the candidates a fact; per fact its picks in order (the item's id, the round, the Choice's probability), every candidate ranked, and why its loop ended (`'empty'` or `'enough'`); the rounds and requests; the sufficiency bar and answers; `skipped` when no Choice was asked, and `error` when a request failed |
| `PickRecord.labels` | The label questions' version, the `deciderId`, how many parts the model was asked about, how many were reused, `waited` (parts whose labels came from another pick's request in flight, left out when 0), the gate's size, and `failedWrites` |
| `PickRecord.labelKindsBySource` | The full kind definitions applied to each source, or `[]` when it has none |
| `PickRecord.cache` | The question set's version, the `deciderId`, how many decision and tag questions were asked and reused, and `failedWrites` |
| `PickRecord.route` | The route answers and the options they switched on |
| `PickRecord.answerTypes` | When `answerTypes` was on: `bar`, one answer per type in `answers`, and `needed`, the types at or above the bar in `ANSWER_TYPES` order. An answer a stop left unasked records `unassessed` with the stop's reason |
| `PickRecord.writtenQuestions` | When `writeQuestions` ran: `questions`, the questions it wrote, keyed `task1` to `task4` |
| `PickRecord.names` | When the pick looked for names: `found`, the names, and `by`, `'code'` for `taskNames` or `'caller'` for `findNames` |
| `PickRecord.asOf`, `timeZone`, `taskPeriod` | The moment and zone the pick read dates in, and the period the task named ([Time](https://github.com/jonny981/curate/blob/main/docs/library.md#time)) |
| `PickRecord.index` | When `pickFromSources()` read a source from its [stored index](#stored-index), by source id: `parts`, the parts in the file after the update; `added`, parts written this call; `removed`, parts deleted, including the old copies of parts read again; `rebuilt`, true when the file was emptied and every part read again; and `ms`, the update's elapsed milliseconds, shared by sources read in parallel |
| `PickRecord.thresholds` | The bars used, including `appliedReference` under `everyScored: { bySize }` |
| `PickRecord.rulesCoverage` | `'incomplete'` when a rule source was absent or partial |
| `PickRecordEntry.keptBy` | On a kept part, the key of the typed question whose `keepAt` kept it below its bar |
| `PickRecordEntry.link` | On a note kept through a commit's link, that commit |
| `PickRecordEntry.reused` | When every decision behind the entry came from the decision cache; also on each cached answer. Never on an `applies: 'always'` rule |
| `PickRecordEntry.tags` | Each tag answer, with its status |
| `PickRecordEntry.readProbability` | On a part a second stage judged: the read's own score. `probability` is then the stage's |
| `PickRecordEntry.keptAs`, `exchange` | On a part a second stage kept: `'rating'` or `'exchange'`, and whose exchanges it belongs to |
| `PickRecordEntry.chosen` | On a part a Choice per needed fact picked: the fact, the round and the probability of each pick |
| `PickRecordEntry.doing`, `approvedBy` | With `roles` on: the option chosen and every option's probability, and an agent's proposal the person's next message approved |
| `pastLaneCut` | On a part and its entry: true when a `wholeLanes` read returned it although the lane cut would have dropped it |
| `dateWindow` | On a part and its entry: `'task-period'` when the task's period brought it in |

A labels or cache write that fails adds a `warning` to `labels` or `cache`.

### The layout record

`curate()` returns `{ log, record }`. The record holds:

| Field | What it holds |
| --- | --- |
| `levers` | The pick's levers |
| `items` | The parts taken, in order, each with its full `id` (with its source when two parts share an id), its `candidate` as shown and its exact `weight` |
| `estimatedTokens` | The estimated size of the returned text |
| `answerTokens` | The budget, when one was set |
| `collapsed` | How many copies were taken once |
| `partsNotKept` | When the text shows an item in parts: how many of its parts were not kept, added up |
| `underShare` | When a source's mode sets a text share: how many kept parts it left out. They aren't counted in `leftOut` |
| `leftOut` | How many kept parts the budget stopped before, the strongest weight among them, and how many weigh 0.5 or more |
| `nothingKept` | `true` when the pick kept no reference part |
| `sentences` | When sentences were rated: the `cutoff`, the sentences `kept` of how many (`of`), how many were `unanswered`, the parts that lost a sentence (`itemsTrimmed`) or every sentence (`itemsLeftOut`), `estimatedTokensBefore`, and `failed` when the request failed |

`curate()` throws a `TypeError` before any call for an unknown option, an `answerTokens` that isn't a positive whole number, a `sentenceCutoff` that's neither `false` nor a number from 0 to 1, a number without `decide`, or a `decide` that isn't a function.
A kept reference part with no kept record entry and weight throws too.
