# @curatejs/core

Curate selects the memory an agent needs for a task from typed sources. Its RDC process ranks candidates, asks your decision function how strongly each item bears on the task, and lays out the strongest items in their own words within a token budget. No model writes the memory text. Selection and curation each return a record.

## RDC process

- **Rank:** Order memory candidates by their signals.
- **Decide:** Judge ranked evidence with narrow questions. Keep references scored 0.0146 or more, ordered and weighted by decision probability. Check rules against their separate applicability bar.
- **Curate:** Call `curate(task, picked, { decide })` to lay out the kept references for the working model to read, keeping the sentences `decide` rates 0.1 or more.

## Install

```bash
pnpm add @curatejs/core
```

The host supplies its own sources and decision function. The default entry imports no model engine. The optional local embedding entry uses a separately installed runtime.

## Requirements

Node.js 22.20 or later.

## Recall context

`memory()` reads sources, selects evidence and lays it out in one call.
Supply the readers and your decision function:

```ts
import { memory } from '@curatejs/core';

const mem = memory({ sources, decide });
const { log, rules, picked, result } = await mem.recall('What billing constraint must this change preserve?');
```

- **Log:** `log` is the text `curate()` lays out from the kept references, with each sentence `decide` rates under 0.1 left out. `result` is the full `CurateResult`, including its record. See [Curating](#curating).
- **Rules:** `rules` joins selected rules with blank lines and preserves each rule's text. Rules are not in `log`.
- **Selection:** `picked` is the full `PickSourcesResult`, including source reads and decision records.
- **Questions:** Each source carries its decision question set as `questions`, set through `historySource()`, and each built-in reader carries its fitted set. `memory()`, `pickFromSources()` and the `/curate` skill all ask each source its own set. A source without one asks core's ordinary question. A direct `pick()` takes the sets by source id as `questionsBySource`.
- **Incomplete collection:** Absent or incomplete reads, unanswered candidates and interrupted decisions throw before the layout. Parts intentionally excluded by the label questions are allowed. The error's `cause` holds `picked` for inspection. Source read errors propagate. A limit that leaves candidates unassessed also throws; use `pickFromSources()` directly if you need to accept a partial selection.
- **Cancellation:** `mem.recall(task, { signal })` passes the signal to the readers and every `decide` call.

Each source carries its own settings: whether the rare-word round runs on it, which label kinds its parts are asked, and the decision-score bars its parts are cut at.
Git and Markdown run the rare-word round and chat leaves it off; chat asks the seven label kinds and git and Markdown ask none; every reader keeps references scored 0.0146 or more.
Out of the box the call rates every part of the fused order, with the rating stop (`stopWhenCold`) and routing off.
Explicit `read`, `pick` and `curate` options apply to the whole call:

```ts
const mem = memory({
  sources: [historySource({ reader: chat(), ...chatSettings, questions: AGENT_CHAT_CASCADE }), git('.')],
  decide,
  read: { wholeLanes: true },
  pick: { everyScored: { bar: 0.05 } },
  curate: { answerTokens: 4000, sentenceCutoff: false },
});
```

See [levers and source settings](#levers-and-source-settings) for each source's settings and how to change them.

`pickFromSources()` and `curate()` remain separate public calls for hosts that manage each step themselves.
`pickFromSources()` asks each source its own question set, as `memory()` does.
See the [runnable example](https://github.com/jonny981/curate#use-it) for installation and source setup.

## Model helpers

The optional `@curatejs/core/models` entry supplies three decision factories using Node's built-in `fetch`:

```ts
import { jev } from '@curatejs/core/models';

const decide = jev({ apiKey: process.env.TYPESAFE_API_KEY });
```

- **Jev:** `jev({ apiKey?, model?, url? })` returns a `PickDecide` function for TypeSafe's System One endpoint, with `deciderId: typesafe:${model}:items-once`. The model defaults to `'jev-latest'`. Missing or invalid probabilities become missing answers.
- **Jev at another address:** set `url` for any server that speaks Jev's format, such as a Clef server. The key is then optional, and no `authorization` header is sent without one. The `deciderId` is `jev:${host}${path}:${model}:items-once`, read from `url`.
- **What a Jev request holds:** the request's state is the batch's task, then each item once, numbered, with its id, date, title and text. Each question's instructions are its wording, then the number of its item, so an item asked seven questions is sent once. `jevRequest(batch, model?)`, exported from `@curatejs/core`, builds that body.
- **Jev request size:** Jev documents its limits in tokens: 32,000 for the state plus the longest question, and 64,000 for the whole request. At an estimate of three characters a token, `jev()` splits a batch into several requests so that in each one the state plus its longest question's instructions and criteria is at most 96,000 characters, and the whole request body at most 192,000. An item's questions always go in its item's request, and an item larger than those bounds goes alone. The answers come back as one map for the batch.
- **A request rejected as too large is sent again, smaller:** an HTTP 400 or 413 reply splits a multi-item request in two, each item keeping all its questions, and a rejected half splits again. A lone item is resent with its evidence text halved, and its answers are marked `truncated`. `jev()` remembers the largest whole body the service accepted; after a rejection, later batches are planned inside it. A request rejected at no more than that size — or a lone item whose text was cut to nothing — did not fail for size, so its reply is thrown as sent and the batch still fails. The error of a failed request carries the reply's whole body.
- **Every request reported:** `jev({ apiKey, onCall })` calls `onCall` once per request, planned, split and resent ones alike, with a `JevCall`: when it was sent, the questions count, the whole-body size, the reply's status, the milliseconds it took, the usage and answers the reply held, and `splits`, the extra requests its rejection produced — 2 for a split, 1 for a resent item, 0 otherwise. A request that never got a reply, through a network failure or a cancellation, is reported with status 0 and the failure's message in `error`; the error still fails the pick.
- **Labels and decisions stored by an older `jev()`:** they are keyed by its earlier ID, `typesafe:${model}`, so `jev()` asks for them once more. A pick that sets `labels.deciderId`, or a decision cache with its own `deciderId`, keeps its stored entries.
- **OpenAI Decisions:** `openAIDecisions({ apiKey, model? })` returns a `PickDecide` function for the [Decisions API](https://developers.openai.com/api/docs/guides/decisions), with `deciderId: openai:${model}`. The model defaults to `'gpt-6-luna'`. Predicate answers become probabilities; refusals become `{ status: 'refused' }`. Missing or invalid probabilities become missing answers.
- **Local decisions:** `localDecisions({ url, model, apiKey? })` returns a `PickDecide` function for an OpenAI-compatible chat completions address, with `deciderId: local:${host}${path}:${model}`. It sends one request a question, one after another. Each request holds the task, the question with its true and false criteria, and the item's id, date, title and text, and asks for one token with `temperature: 0`, `logprobs: true` and `top_logprobs: 20`. The answer is the probability of the "yes" tokens over the "yes" and "no" tokens among the first token's top log-probabilities, with case and leading whitespace ignored. When neither is there, the answer is missing. No `authorization` header is sent without a key.
- **Separate IDs per server:** the IDs built from `url` leave out its scheme and query. Set `labels.deciderId` yourself for two servers that differ only there. A decision cache keeps its own `deciderId`, so give it a different one for each server.
- **Errors:** `jev()` rejects a missing API key at its default address, and `openAIDecisions()` always does. A `localDecisions()` reply with no log-probabilities throws `The model server at <url> returned no log-probabilities; localDecisions needs a server that does.` An HTTP 429 reply to a `jev()` request waits as its Retry-After header directs, then sends the same request again. Other HTTP failures throw. Cancellation reaches `fetch`.

> [!NOTE]
> At their default addresses, `jev()` and `openAIDecisions()` make paid model calls. A local model server needs no hosted service. You can also supply a plain `decide` function using any model route.

## Source packages

Core supplies no reader. Install [chat](https://github.com/jonny981/curate/blob/main/packages/chat/README.md), [git](https://github.com/jonny981/curate/blob/main/packages/git/README.md)
or [markdown](https://github.com/jonny981/curate/blob/main/packages/markdown/README.md) for built-in readers. Each depends on core.
The `@curatejs/core/internal` entry contains shared file, git and keyword helpers
used by those packages; it supplies no source or ranking defaults.

## Sources

A source implements `CandidateSource`: it has an `id`, a declared `role`
(`reference`, `rule` or `mixed`), and a `read` that takes a
`CandidateReadRequest` and returns a `CandidateReadResult`.

`read` answers one of three outcomes:

- **`status: 'read'`**: candidates, plus `complete: false` whenever
  enumeration stopped early or skipped anything.
- **`status: 'absent'`**: the expected nothing: no directory, no store.
  Non-fatal, with its reason.
- **A thrown `SourceReadError`**: a real failure: an unreadable file, a
  corrupt store, or `code: 'cancelled'` when the read was aborted.

The request's `exclude` paths are refused before any content is opened,
so excluded text never reaches signals or a model. A `revision` pin is
resolved once and used for every operation that read performs; a source
that cannot honour a pin answers `absent` rather than guess. A
candidate's `text` is the retained snapshot of the exact text scored.

Request flags let a streaming reader do lane work inside the read.
`phraseLane: true` means `task` is an exact phrase to match, not keywords
to score, so the reader can keep matches without scoring the corpus; on
a kind lane `topic` then carries the task the lane serves, and the
reader ranks each match by it. `meaningLane` carries the embedding
function for a meaning read: the reader scores each part's similarity
inside the read and returns only the kept parts, so the corpus's text
is never held. `wholeLanes` arrives already resolved: `false` tells the
reader to narrow its own lane at the score curve and emit only the
kept candidates; `limit` on a kind or meaning read caps that kept set
after the curve, not the scoring before it. A read that narrowed
itself reports `laneCutApplied: true` and sets `matched` to the lane's
count before the curve, so the pick never cuts it twice. A reader
that returns everything leaves both unset and the pick cuts as before,
so a non-streaming source needs no change.

`context.files` shares file text between lanes and overlapping sources
in one pick. Readers fill it through a byte cap (64 MB): inside the cap
a file is read once; past it each pass re-reads, so a large corpus is
never held whole.

A read context lasts one call: pass a new one to each call. Within it
the chat, git and Markdown readers keep what a later read of the same
call would redo: the stored index update with its folder walk, the
Markdown reader's `git status` and git date lookups, and each Markdown
note parsed from the stored index. Parsed notes are held outside the byte
cap until the call ends.

### Stored index

The chat, git and Markdown readers keep one local file per source, made on the source's first read.
There is no database server: the file is SQLite, through `node:sqlite`, which is built into Node.
Every lane of a call then reads the file instead of decoding the transcripts, fetching each commit from git and parsing the notes again.

- **Where it lives:** `$XDG_CACHE_HOME/curate/index`, or `~/.cache/curate/index` when `XDG_CACHE_HOME` is unset.
  Set `index: { directory }` on the reader to choose another folder.
  The folder is created with mode `0700` and the file with mode `0600`, because the file holds the history's text.
- **Its name:** the source id, the settings that decide which parts exist, and a format version.
  A change to any of them names a new file, so a stale file is never read.
  For chat those settings are `includeTools`, the part size, the source's own `exclude` and the keyword `stem` setting.
  For git they are the source's own `exclude`, `paths` and `since`.
  For Markdown they are the reader (`markdown()`, `knowledgeBase()` or `rules()`), the kind, the part size and the source's own `exclude`.
- **What it holds:** every part the reader produces, with its id, title, text, date and metadata.
  A postings table holds one row per word per part with its count, written in the same transaction and deleted when the part's rows go.
  From it a keyword lane reads each term's per-part counts, each part's word total and each term's document frequency.
  Chat stores its words stemmed when its settings stem. Git stores the words of the subject and body joined.
  Markdown also stores each note's frontmatter, its fields, its links and whether it says it was replaced.
- **Ranks do not change:** each reader keeps its own scoring and reads the stored counts where it read the text.
  A lane read from the file returns the same candidates, in the same order, with the same signals, as the same read with `index: false`.
  Git's commit count, holding counts and average length depend on the call's look-back, filters and limit, so they are counted for each call over the commits the lane ranks.
- **When it is brought up to date:** on the first read of each call, before that read's lane.
  The later reads of the same `pickFromSources` call share the update.
  A read with no read context brings the file up to date on its own.
- **Chat:** a transcript with its stored size and modification time is kept.
  A transcript that grew, whose indexed bytes ended a line and still start and end with the same kilobyte, has only its new bytes read.
  Any other change reads it again whole. A new transcript is read, and a removed one's parts are deleted.
- **Git:** commits the file does not hold are read. If a stored commit is no longer reachable from the head, the file is emptied and every commit is read again.
  A lane takes each commit's subject, body and paths from the file. Git only lists the commit names, once per call and date range.
  A read pinned to a revision reads the file only when this call brought the file to that commit. Any other pinned read runs git as before.
- **Markdown:** notes that are new, or changed in size or modification time, are read again.
  A note no longer in the folder loses its parts on a read whose request excludes nothing.
  The folder walk runs once per call. The last commit date of each file is stored with the head it was read at, and the git log runs again only when the head has moved.
  A shallow clone, or a repository with replacement refs or grafts, can show other history without its head moving, so its dates are never stored: its log runs on every call.
  The check for uncommitted changes runs once per call. A read pinned to a revision reads the files as before.
- **Exclusions:** a path the source's own `exclude` names is never written to the file.
  A path the request's `exclude` names is never opened, returned or scored. Its stored parts stay for calls that do read it.
  Git records a commit the source's own `exclude` names, or one that changed none of the source's `paths`, by its name only, and never reads its subject or body.
  Git leaves a commit dated before the source's `since` or after the task date unread and unwritten, so a later call whose dates hold it reads it then.
- **Turning it off:** `index: false` on the reader reads the source directly on every read, as before.
- **Node:** Node 22 prints `ExperimentalWarning: SQLite is an experimental feature and might change at any time` when the file is first opened.
  Curate does not hide warnings.
  A Node without `node:sqlite` stops the read with an error that says so.
- **Records:** `record.index` in the pick record says, by source id, what each update did ([Record fields](#record-fields)).

```ts
import { chat } from '@curatejs/chat';

const source = chat({
  providers: ['claude-code'],
  index: {
    directory: '/tmp/curate-index',
  },
});
```

## Search options

`pickFromSources` accepts host-written `searchLines` in its read request.
Each source searches the task and every distinct, nonblank line. A line
can be keywords or a short passage describing what the answer evidence
would say. Curate generates no lines. Keyword searches need no model.

```ts
const picked = await pickFromSources(
  sources,
  {
    task,
    searchLines: ['Backup copies are encrypted and tested by restoring them.'],
    searchPhrases: ['restored a', 'tested the backup'],
    stripSearchInstructions: true,
  },
  { task, decide, limits: { maxCandidates: 200 } },
);
```

- **Results:** The union keeps each `[sourceId, id]` once, with its best
  rank and the candidate data from that search. `searchRanks` records
  each zero-based rank within its source; `null` means absent from that
  search. The lowest rank becomes the record's `priority`.
- **Candidate budget:** `maxCandidates` applies to each search's
  interleaved feed. Their union can exceed that number, so extra searches
  add decisions without displacing original candidates. Batch and time
  limits still apply to the combined run.
- **Read budget:** `request.limit` applies to each keyword source read. Markdown
  and chat keep their best matches; git history enumerates the latest
  commits before ranking. A git read limit therefore excludes older
  commits from keyword searches. Phrase searches filter before this limit,
  as described below. Resolved revisions are reused across reads.
- **Single search:** Omit `searchLines` or pass `[]`. Duplicate lines
  and lines that repeat the original task add no read.

`searchPhrases` adds exact, contiguous word searches over candidate text and titles.
Case and punctuation are ignored; short words and word order remain.
For example, “got my” matches “I even got my vinyl signed”, while
“forgot my” and “got a copy of my” do not match. There is no stemming.
A phrase cannot span the title and text. Matches are ordered by occurrence
count, then item id.
The original task and keyword lines keep their ordinary search behavior.

Phrase matching runs before the per-read `limit` is applied. The pick
asks the source to enumerate without that limit and marks the read
`phraseLane`; a streaming reader then keeps only the matching parts,
while a reader that ignores the flag gets the same exact-match filter in
core after its read. Either way a phrase read can cost more local I/O
than a keyword read. Exclusions, revision pins and cancellation still
reach the reader.
A source that stops enumeration remains incomplete. A phrase with no
matches contributes no candidates. The per-search decision budget also
applies to each phrase; only matching candidates enter that feed.
Omit `searchPhrases` or pass `[]` to keep phrase searches off.
Curate generates no phrases and makes no model call.

Each source read is a set of lanes: one keyword lane for the task and
each distinct search line, one phrase lane per phrase, and any kind or
meaning lanes. A read result's `lanes` lists every lane with its search
text, its type (`search`, `phrase`, `kind`, `meaning` or `name`), the candidate
count the source returned for it before the lane's own filter, and the
count the lane kept. The
read's candidates are the union of what the lanes kept; the union has
no ceiling beyond what the lane curves cut. A host can read
`candidates.length` for the union size each task produced and report
its median, spread and largest across tasks; the per-lane `read` and
`kept` counts show which lanes made the large cases large.

Keyword lanes on reference sources cut themselves where each lane's own
score curve flattens. `cutLane` orders a lane's candidates by the sum
of their signals, and `cutScoreCurve` finds the bend: the point
furthest below the straight line between the lane's best and worst
positive scores. The curve measures the lane's own match score: a
candidate carries it in `laneScore` when its signals hold an ordering
or rank-merge score. Chat's signals hold a rank-merge score, so the
chat curve reads the pre-merge keyword score, never a rank position.
Candidates at or below the bend drop out. Equal scores fall together,
two or fewer positive scores always stay, and a lane with no bend
keeps every positive score. A search lane where nothing scored admits
nothing: it matched nothing. When a read keeps no candidates at all
it reports `noSearchMatch` on its read result, so the caller sees
the miss and can ask more broadly. The count comes from the scores,
so no lane has a fixed cut and the union has no ceiling. `searchPhrases` lanes are
never cut: an exact phrase is its own evidence. A kind lane is never
cut on how often its phrase occurs: the count says a match exists, not
that it is relevant, and a direction said once would lose to a phrase
everyone repeats. A streaming reader instead ranks each kind-lane
match by the task's own score and cuts that curve inside the read
when `wholeLanes` is off; a reader that cannot score the task returns
every match and the pick keeps them all. Meaning lanes get the same
curve cut on similarity scores, inside the read when the source
streams it. Pass `wholeLanes: true` in the read request to keep every
candidate each search returned.

`kindLanes` adds phrase lanes in the language of the kind of message a
task asks for. It maps each source kind (`chat`, `git-history`,
`markdown`) to a list of exact phrases, for example direction wording
such as "we need to" or "never" for chat and "decision:" for notes.
A source reads only its own kind's phrases. Each phrase is a lane of
its own: the source searches for it, then an exact-match filter keeps
the candidates whose title or text contains it. A phrase only
identifies the match; it does not measure relevance. The read request
sends the phrase as `task` and the task itself as `topic`, and a
streaming reader scores the matches against the topic and cuts that
score curve inside the read. A source that cannot score returns every
match rather than ranking by phrase frequency, so a direction stated
once survives a phrase used everywhere.

Each source package exports ready phrase sets, one list per kind of
message a task commonly asks for: `CHAT_KIND_PHRASES`,
`GIT_HISTORY_KIND_PHRASES` and `MARKDOWN_KIND_PHRASES`. Each maps
`directions`, `decisions` and `corrections` to phrases in its source's
register, for example "we decided" and "settled on" in chat against
"chose" and "instead of" in commits. Feed the matching list in for the
task, such as `kindLanes: { chat: CHAT_KIND_PHRASES.directions }`.

When the task asks what a named person said, `speakerOnly: true`
narrows chat kind lanes to that person's own messages: a candidate
with chat metadata matches only when its recorded role is `user`.
Candidates without chat metadata still match. Omit `kindLanes` to keep
kind lanes off; omit `speakerOnly` to keep every matching role.

For direct `pick` calls, hosts supplying `searchRanks` must include the
original search at index 0 and extra searches after it. Supply ranks for
every part of a searched source. Sources without those ranks retain
their ordinary signal order in each feed.

`stripSearchInstructions: true` removes explicit, standalone output
clauses such as “cite both” and “answer in one line” from search text.
The exported `stripSearchInstructions(task)` helper performs the same
operation. It preserves unfamiliar wording and retrieval needs such as
counting, dates, comparisons and identifying the newer fact. The full
task still goes to `decide`; pass that same task to `curate`.

### Names in the task

`taskNames(task)` lists the people and things a task names, found with
code and no model. It finds quoted titles, hashtags, and runs of
capitalised words that do not start a sentence. A run of two or more
capitalised words counts even at the start of a sentence. Month and day
names, "I" and question words are never names. "Dr." and "St." stay
inside a name, and a trailing "'s" is dropped. So
`taskNames('Who graduated first among Emma, Rachel and Alex?')` returns
`['Emma', 'Rachel', 'Alex']`. It also lists capitalised words that name
nothing specific, such as "Korean". `classifyTask` tags a task `named`
exactly when `taskNames` finds a name.

A source with its `names` setting on searches once more for each name,
as an exact phrase that ignores case, like a `searchPhrases` entry. The
reason is recall: a part the search loses never reaches the decision
step, and a name is the most exact search a task offers. A name lane is
never cut on its score curve. Like every lane, it holds at most the
read's `limit` matches, `maxCandidates` caps it on its own, and a feed
cut, `everyRanked: { c }` or the rating stop can leave one of its
matches undecided. Its
entry in the read's `lanes` has the type `name` and the name as its
search text. A task with no names opens no name lane, and neither does
a name another phrase lane already searches. A name gets no meaning
lane.

`findNames` on `pick` or `pickFromSources` replaces `taskNames` for one
call, for example with a small model. It takes the task and returns the
names. It is called once per pick, and only when a source has `names`
on or a source's question set has `named`. A function that throws, or
returns anything but an array of strings, stops the pick. Curate ships
no model for it. `record.names` holds `found`, the names, and `by`,
`'code'` or `'caller'`. It is present when the pick looked for names.

### Optional local meaning search

`meaning: { embed }` adds local embedding searches for the task and its
distinct search lines. Each part receives a separate meaning rank for
each query. Keyword ranks and signals stay intact. The decision feed
unions the keyword and meaning matches, keeping each `[sourceId, id]`
once. Omit `meaning` to keep ordinary keyword search.

```mermaid
flowchart LR
  Task[Task and search lines] --> Words[Keyword matches]
  Task --> Meaning[Local meaning matches]
  Parts[Candidate parts] --> Words
  Parts --> Meaning
  Words --> Union[Union: each part once]
  Meaning --> Union
  Union --> Decide[Decision model]
```

For the supplied local adapter, install its optional peer runtime:

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

- **Model:** The adapter accepts sentence embedding models that take plain
  text. The tested model is [MiniLM-L6 Q4](https://huggingface.co/second-state/All-MiniLM-L6-v2-Embedding-GGUF),
  a 19,699,648-byte model with 384 vector dimensions. It uses the same
  Node runtime as QMD's larger EmbeddingGemma model. Models that require
  query or document prompts need a host-supplied embedding function.
- **Complete text:** Inputs longer than the model window are embedded in
  token windows. Their normalized vectors are averaged by token count.
  No input text is cut off to fit the model. A part whose body contains
  only whitespace or invisible formatting characters uses its title for
  embedding, including a commit with only a subject.
  Its original body and title remain in the returned evidence.
- **Storage:** Set `cacheDirectory` on `createLocalEmbedder()` to persist vectors by model bytes and complete input text.
  Each model holds one vector file of normalized 64-bit vectors, read whole into memory once per process, so a stored text costs no lookup on disk.
  New vectors wait in a SQLite file beside it (`<model>.vectors.waiting.sqlite`) and are folded into the vector file once 4,096 wait. The file is only ever written whole and renamed into place.
  An earlier `<model>.vectors.sqlite` store is read once, to build the vector file when there is none, and is never written: code from before the vector file keeps finding its vectors there.
  Nothing deletes that earlier store. Delete it by hand once no older checkout shares the folder.
  A fold leaves out a vector unused for 30 days, so the vectors of deleted or changed parts do not pile up; using such a text again embeds it again.
  A text neither file holds is read once from the earlier per-text JSON files, which are never written.
  A returned vector can be the stored one itself: read it, do not write to it.
  Repeated inputs reuse these files across calls. The vector files contain hashes and vectors, not source text.
  With no directory supplied, vectors exist only while a batch is scored.
  Vectors are kept apart from the [stored index](#stored-index), whose file per source does hold the history's text.
- **GPU:** Set `gpu: 'metal'` to require the Mac GPU. An unavailable explicit backend stops the call instead of selecting CPU.
  The returned `gpu` field names the backend in use.
- **Candidate reads:** A supplied keyword `request.limit` still controls
  keyword results. Each meaning query first asks the source to serve the
  lane itself (`meaningLane` on the read request): a streaming reader
  scores similarity inside the read, keeps what the curve keeps, and
  returns only those parts flagged `meaningLane`, so the corpus's text
  is never held. A source that does not honour the flag answers an
  ordinary keyword read, and the pick then makes one unrestricted
  fallback read and scores its whole pool itself. Exclusions and
  revision pins apply either way. Partial source reads remain recorded
  as partial.
- **Dials:** `meaning.nearest` is an optional positive integer per query
  and source. Each meaning query is cut where its similarity score
  curve flattens, the same cut keyword lanes get; pass `wholeLanes: true`
  on the read request (or `meaning.wholeLanes: true` for meaning only)
  to keep every rank. `nearest` bounds the ranks a query keeps either
  way. An optional `limits.maxCandidates` still applies to each
  interleaved query feed; their union can exceed it.
  The union preserves keyword eligibility; caller-supplied batch or time
  limits can still leave keyword candidates unasked because meaning
  ranks affect the combined decision order.
- **Failures:** Local model failures stop the search before decisions.
  Cancellation is checked between batches and model windows. There is
  no API fallback.

For hosts that already have candidates, `addMeaningRanks(candidates,
task, { embed, searchLines })` returns the same union rank data for
`pick`. An `EmbeddingFunction` returns one vector per complete input
text, in input order. The helper uses cosine similarity, which compares
vector direction rather than length, and breaks ties by candidate id.

### Defaults and evidence

The LongMemEval tuning check covers 249 questions and 445 labelled
answer-turn starts. It measures evidence reaching decisions, not final
answer accuracy. The union comparisons use a budget per search.

| Option | Default | Measured reason |
| --- | --- | --- |
| **Reference selection** | Keep references scored 0.0146 or more | In the saved-decision sweep, 0.05/0.5 removed every fed fragment of 50 answer turns; 0.2/0.6 removed 70; a single 0.6 cut removed 183. Keeping everything added no selection losses. Seven of 445 labelled turns were absent from the feed. This measures retention before curation, not final answer accuracy. |
| **Extra search lines** | Run when supplied | Using the chat package, five subject lines plus five alternate-name lines at 100 parts reach 440/445 turns and add 207.3 decisions per question. At 200, five subject lines reach 442/445 and add 214.2. At 600, task-only search reaches all 445; extra lines add no labelled evidence. |
| **Phrase searches** | Off unless supplied | One event phrase recovers one extra labelled turn at 100 parts for 0.9 extra decisions per question on average. Keyword lines also recover that turn. On its sports-event order question, the phrase adds two parts, compared with 58 for one subject line. At 200 and 600 it adds no labelled turns. |
| **Local meaning search** | Off | In 249 tuning questions, 200 keyword parts plus 48 nearest task-meaning matches reaches all 445 labelled turn starts and all their surviving parts, adding 19.5 decisions per question. Keyword-only retrieval at 600 parts reaches the same evidence. The 48-part depth is measured for that tuning setup, not a cutoff for other histories. Final-answer accuracy is unmeasured. |
| **Instruction removal** | Off | It changed zero tuning questions and ranks. Benefit on tasks with output instructions is unmeasured. |
| **Rank protection** | Off | In a 60-question cached sample, recall in the first four items fell from 94.09% to 84.68%; in the first eight, from 100% to 99.71%. Full-feed packing is unmeasured. |
| **Best part first** | Off | One part per session reached 259/445 answer turns. Even an optimistic continuation at 0.4 reached only 423/445. This does not establish a safe way to skip parts. |

The line comparison generates five subject lines, five alternate-name
lines and five subject-free event phrases per tuning question with a
subscription model, then tests prefixes of one, three and five.
Keywords use the chat package's default ranking. Core unions the feeds
and applies the budget per search. These host settings retain every
labelled turn and every complete labelled turn found with all fifteen
lines, checked question by question:

| Parts per search | Subject lines | Alternate-name lines | Event phrases |
| --- | --- | --- | --- |
| 100 | 5 | 5 | 0 |
| 200 | 5 | 0 | 0 |
| 600 | 0 | 0 | 0 |

Hosts can keep event phrases for cheaper retrieval of specific events.
The sports-event order example uses “watched” to recover its third
labelled turn. A count/list-only route would omit that question.
The combined keyword settings also find that turn, so omitting phrases
from these combined defaults preserves its evidence.

The line gains use keyword and phrase search, not vector search. The rank sample uses saved “needed”
answers, rather than a complete decision feed. The document check uses
a 0.4 continuation gate. No continuation gate is used by the package.

## Time

Every read measures from one moment, the task's date.
Two fields set it, on the read request and in `pick`'s options:

- **`taskDate`:** an ISO 8601 date or date-time, such as `2025-06-02` or `2025-06-02T09:15:00+01:00`. A date without a time means the end of that day in `timeZone`. A time without an offset is a time in `timeZone`. Anything else throws a `TypeError` before any read. Absent means now.
- **`timeZone`:** the IANA time zone of the person asking, such as `Europe/London`. Absent means the system's own zone. A name the runtime does not know throws a `TypeError`.

`pickFromSources` takes both from the read request, or from `pick`'s options when the request has none, and passes them to every read and to `pick`.
Without `taskDate`, it reads now once and passes that moment to every read as the request's `asOf`, the moment the record's `asOf` names.
A reader measures from `taskDate`, else `asOf`, else now. It leaves out records dated after the moment only when `taskDate` is given.
`memory().recall(task, { taskDate, timeZone })` passes them the same way.
It also gives `taskDate` to `curate` as the task's date label, unless `curate.taskDate` is set.

The readers use them:

- **Git:** the `recency` signal is measured from the task date.
- **Chat:** a `since` duration counts back from the task date, and each date carries the zone's offset, such as `2025-06-02T00:30:00.000+01:00`.
- **A source's own look-back:** every reader accepts a `since`: an ISO date or a duration such as `'14 days'`, counted back from the same task date. Git passes it to `git log`; chat emits only messages at or after it; Markdown drops parts whose emitted date is older, keeping undated parts. Each source sets its own, and the pick records it under `levers.sources`.
- **After the task date:** with `taskDate` given, a chat message or a git commit dated after it is not read. Without it nothing is left out for its date. Markdown keeps notes dated after it, since a note can declare an `effective` date ahead. A `revision` pin reads a knowledge base as it stood.

### The task's period

`taskPeriod(task, { asOf, timeZone })` returns the period a task names as `{ from, to }`, or `undefined`.
`from` is the start of the first day and `to` the end of the last, each an ISO date-time with the zone's offset.
`asOf` takes the forms `taskDate` takes and defaults to now.
It reads only these English forms:

- **A month:** after "in", "during" or "of", or with a year or a day: "in March", "March 2024", "3 March", "March 3".
- **A year:** after "in" or "during": "in 2024".
- **A named day, week, month or year:** "today", "yesterday", "this week", "last week", "this month", "last month", "this year", "last year".
- **A count back:** "N days ago", "N weeks ago", "N months ago".
- **An ISO date:** "on 2025-03-04".

A month or a day with no year is its latest occurrence on or before `asOf`.
Weeks start on Monday.
Several periods in one task give one span, from the earliest start to the latest end.
A month name counts only in the forms above, so "May I ask what we chose?" names no period.

`pick`'s `taskPeriod` option is on by default and acts only when the task names a period.
`pickFromSources` then reads each source once more with the read request's `taskPeriod` set to that period.
It adds the parts dated inside it that no lane kept, marked `dateWindow: 'task-period'` and `poolOnly`.
`pick` admits a part with a `dateWindow` to the decide step as it admits a lane member.
A rule source is not read again: its parts are never cut.
`taskPeriod: false` turns it off.

Nothing is removed for its date.
A part is dated when it was written, not when the thing it describes happened.
A message in April that recalls March is dated April, so a filter on March would drop the very answer.

Each reader serves the period read in its own way.
Chat keeps the parts dated inside the period as they stream past.
Git reads the period with `git log --since --until`.
Markdown keeps the parts of notes dated inside it.
A reader that ignores the request's `taskPeriod` answers a whole-lane read, and `pickFromSources` keeps the parts it returned that are dated inside the period.

The pick record names what was used:

- **`asOf`:** the moment used, as an ISO date-time in `timeZone`. Pass it back as `taskDate` with the same `timeZone` to replay the pick.
- **`timeZone`:** the zone dates were read in.
- **`taskPeriod`:** `{ from, to }`, present when the option was on and the task named a period.
- **`dateWindow`:** on a part and its `PickRecordEntry`, `'task-period'` when the period, not a lane, brought it in.

## Picking

`pick(candidates, { task, decide })` ranks the candidates, asks `decide`
in bounded batches, and returns the selected candidates with a
`PickRecord`. By default, labels run only for a source that carries
label kinds: `chat()` carries the seven kinds, and `git()` and the
Markdown readers carry none. Each reference is kept
when its score reaches its source's bar: `barBySource`, keyed by source
id, or 0.0146 for a source it does not name. `pickFromSources` fills
`barBySource` from each source's `bar`. `everyScored` sets one bar for
every source in their place; `everyScored: true` keeps every valid
score, including zero.
The model orders and weights selected references. References
with no valid decision answer remain unanswered; limits can leave items
unassessed. A `decide` call that throws fails the pick with a `PickError`,
unless the elapsed limit stopped the call or the caller's signal aborted
it. The error's `record` carries the pick's record, which names the
batch's candidate ids and the error's message in `decideError`. A failed
decision batch leaves its candidates unanswered even when an earlier
batch answered some of their questions; a failed tag batch leaves a
decided selection standing and records the error on the tag answers.
There is no retry and no fallback.

To change the score cut for every source, set your own bar:

```ts
const picked = await pick(candidates, {
  task, decide, everyScored: { bar: 0.05 },
});
```

Rules also keep every scored item by default. A rules source's
`ruleBar`, or `ruleBarBySource` on a direct `pick()`, sets an optional
applicability cut; `rules()` from `@curatejs/markdown` sets 0.5. A candidate
a host builds with `applies: 'always'` bypasses that check.

`everyScored: { bySize }` replaces the flat bar with a
curve of `[decided count, bar]` points. Below the first point the first
bar applies; above the last the last bar applies; between two points
the bar moves linearly. The count is the number of references that
answered, so a small decided set can keep everything while a large one
cuts more of the weakest. The record keeps the sorted points and the
bar used as `thresholds.appliedReference`. Points must be unique
nonnegative safe integers with bars between 0 and 1. Their positions
are a measurement question: set them against the history the funnel
will read, and measure recall where each point lands before relying
on it.

`pickFromSources(sources, request, options)` reads the
sources first, then picks over the combined candidates; a rule source
that returned `complete: false` or was absent makes the record's
`rulesCoverage` `'incomplete'`, even when every supplied rule was
answered. `rulesEnumerationComplete: false` in the options is honoured
the same way.

Each candidate's `changedPaths` names the repository paths it changed;
`git()` fills it from the commit's diff, never from paths the text
mentions. When a reference score cut applies, a reference answered
at or above `linkedPathBar` (0.4 by default) still passes when a selected
commit from the same `repository` names its `path` in
`changedPaths`. The record entry names the commit that carried it over
in `link`, and a linked candidate never carries another. The bar is a
chosen default, not a measured best; `PickThresholds.linkedPathBar`
overrides it.

A source's `questions` setting takes a fitted question set, a
`PickCascade`: `bias` and `questions`, each with `key`, `instructions`,
`true`, `false`, and `weight`. Curate combines the answers with those
weights into the decision probability. Optional `first`,
`band: [low, high]`, and `firstOnly: { bias, weight }` ask one question
first and use its fitted probability outside the band; inside the band,
all questions contribute. `historySource()` checks the set when it builds
the source. The record keeps the set under
`levers.sources[sourceId].questions` and each question's answer on the
part's entry. A missing returned answer contributes nothing
to the fitted sum; when every answer is missing, the item stays unanswered.
If a limit stops required questions before they are asked, the item stays
unassessed.

### Question sets by source

Each source asks its reference parts the set in its own `questions`
setting. The presets carry their reader's fitted set through their
settings objects, and two sources of the same kind can ask different
sets. A source without a set asks the ordinary reference question.
Rule candidates keep their separate applicability question.
`memory()`, `pickFromSources()` and the `/curate` skill ask each
source's set the same way.

```ts
import { historySource, pickFromSources } from '@curatejs/core';
import { chat } from '@curatejs/chat';
import { git, gitSettings } from '@curatejs/git';
import { knowledgeBase } from '@curatejs/markdown';

const picked = await pickFromSources(
  [chat({ paths: ['transcripts'] }), historySource({ reader: git('.'), ...gitSettings, questions: mySet }), knowledgeBase('docs')],
  { task },
  { task, decide },
);
```

A direct `pick` call has parts, not sources, so it takes the sets by
source id: `questionsBySource: { conversations: CHAT_CASCADE }`.
`pickFromSources` fills that map from the sources that returned those
candidates.

The chat package’s `CHAT_CASCADE` contains the fitted relevance, own-situation and needed
questions, with relevance asked first. `chat()` uses `AGENT_CHAT_CASCADE`, which leaves out `own`.
Host-provided personal histories can keep `CHAT_CASCADE`. `GIT_HISTORY_CASCADE` and
`MARKDOWN_CASCADE`, exported by git and markdown respectively, share four fitted questions: `current`, `needed`,
`when`, and `offtopic`. They ask about relevance, needed information,
timing, and a different subject. The negative `offtopic` weight lowers
the score when an item is about a different subject. These sets ask
neither `own` nor `preference` of commits or notes. Fitted scores order
evidence; they do not measure the chance of a correct final answer.

Identical text shares answers to matching decision questions within one pick, including copies in one batch.
A part with no text shares on its title instead, so two title-only commits with different subjects get their own answers.
Each copy keeps its source and uses that source's question weights and score bar.

### Answer types

`answerTypes: true` on `pick` or `pickFromSources` asks the task what
kind of answer it needs. Your `decide` function gets the ten yes/no
questions in `ANSWER_TYPES` in one request per pick. They ride in the
request that asks the task its label kinds or route questions when
either runs, and go alone otherwise. A type answered at 0.5 or more is
needed; `answerTypes: { bar }` sets another bar. It is off by default,
and `memory()` passes it through `pick` like any pick option.

| Key | Question | True when | False when |
| --- | --- | --- | --- |
| `date` | Is the answer a point in time? | The answer names when something happened or will happen: a calendar date, a day of the week, a month, a year or a time of day. | The answer is not a point in time. |
| `duration` | Is the answer a length of time? | The answer is how long something lasted or took, or how much time passed between two events or since an event (days, weeks, months, years). | The answer is not a length of time. |
| `order` | Does the answer depend on the order of two or more events? | The question asks which happened first, last, before or after, or asks for events in sequence. | The question does not ask about the order of events. |
| `number` | Is the answer a number? | The answer is a number: a quantity, a count, an amount of money, a measurement, an age, a score or a percentage. | The answer is not a number. |
| `entity` | Is the answer a specific named thing? | The answer is a particular person, place, product, brand, organisation, pet, or title of a book, film, show or song. | The answer is not a particular named person, place, product or title. |
| `yesno` | Can the question be answered with yes or no? | The question asks whether something is true, happened or holds, so a yes or a no answers it. | A yes or a no does not answer the question. |
| `list` | Does the answer need every instance of something gathered? | The answer is a count of items or events, or a complete list of them, so every instance must be found. | The answer does not need instances counted or listed. |
| `advice` | Does the question ask for a recommendation, a suggestion or an opinion? | The user asks what they should do, choose, try or think, rather than asking for a fact from their past. | The user asks for a fact, not for a recommendation or an opinion. |
| `preference` | Does the answer depend on the user's own preferences? | The user's stated likes, dislikes, tastes, wants or limits shape what a good answer is. | The user's preferences do not shape the answer. |
| `latest` | Does the question ask for the current or most recent value of something that can change? | The answer is the most recent value or state of something that may have changed over time; an earlier value would be out of date. | The question does not ask for a current or latest value. |

The true and false columns are each entry's `trueCriterion` and
`falseCriterion`. `AnswerType` is the type of the keys.

`record.answerTypes` holds the `bar`, one entry in `answers` per type
with its answer, and `needed`, the types answered at or above the bar
in `ANSWER_TYPES` order. An answer a stop left unasked records
`unassessed` with the stop's reason.

A source's question set can carry `typed` questions beside its
`questions`. Each has an `answerType` and a fitted `weight`. It is
asked of the source's reference parts only when `needed` holds its
type, in the same request as the set's other questions. In a set with
`first` and `band`, it is asked only when the other questions are,
that is when the first answer is inside the band. Its answer adds
`weight × logit(p)` to the part's score like the others, and a typed
question that is not asked adds nothing. A part's record entry lists
the typed questions it was asked beside the others. Keys must be
unique across `questions` and `typed`.

```ts
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
const mem = memory({
  sources: [historySource({ reader: git('.'), ...gitSettings, questions: DATED })],
  decide,
  pick: { answerTypes: true },
});
```

No preset carries a typed question. A pick whose sources carry typed
questions while `answerTypes` is off throws a `TypeError` that names
the source, before any read.

### Keeping a part on one typed answer

A typed question can carry `keepAt`, a number from 0 to 1. When the
question is asked and its answer is at or above `keepAt`, the part is
kept even when its score is below the source's bar. Its record entry
then has `keptBy`, the key of the typed question that kept it.

`COUNT_MARKER` is a typed question for tasks that count or list. It
asks whether the part reports at least one actual instance of the thing
the task counts. A total, a question, a suggestion, a hypothetical, or
the assistant repeating something does not count. Its answer type is
`list`, its weight is 0 and its `keepAt` is 0.5. With weight 0 it never
moves a score: it only keeps a part that answers 0.5 or more. No preset
carries it. Add it to a set with `answerTypes` on:

```ts
import { COUNT_MARKER, historySource, memory } from '@curatejs/core';
import { jev } from '@curatejs/core/models';
import { chat, chatSettings, AGENT_CHAT_CASCADE } from '@curatejs/chat';

const decide = jev({ apiKey: process.env.TYPESAFE_API_KEY });

const mem = memory({
  sources: [historySource({ reader: chat(), ...chatSettings, questions: { ...AGENT_CHAT_CASCADE, typed: [COUNT_MARKER] } })],
  decide,
  pick: { answerTypes: true },
});
```

### Questions written for each task

`writeQuestions` on `pick` or `pickFromSources` writes two to four
yes/no questions about the task, once per pick, before any decide
request. `memory()` passes it through `pick`. It takes the task and the
pick's signal and returns `PickCriterion` questions. Curate keys them
`task1` to `task4` and asks them of the reference parts of every source
whose question set has `written` weights. It is off by default.

`taskQuestionWriter(write)` builds the option from a `write` function,
a `CurateWrite`: it gets `{ instructions, body }` and a signal, and
returns the model's reply text. It sends `TASK_QUESTION_PROMPT` as the
instructions, with the task in the body, and reads the JSON array in
the reply.

A set's `written: { highest, second }` adds
`highest × logit(best written answer) + second × logit(second-best
written answer)` to a part's score. Each answer is clamped to 0.0001
to 0.9999 before the logit. A written answer that comes back missing
adds nothing. In a set with `first` and `band`, written questions are
asked only when the other questions are, and a part outside the band
keeps the `firstOnly` score.

```ts
import { historySource, memory, taskQuestionWriter, type CurateWrite } from '@curatejs/core';
import { jev } from '@curatejs/core/models';
import { chat, chatSettings, PERSONAL_CHAT_WRITTEN_CASCADE } from '@curatejs/chat';

const decide = jev({ apiKey: process.env.TYPESAFE_API_KEY });
// Any model call: it gets { instructions, body } and returns the reply text.
const write: CurateWrite = async ({ instructions, body }, signal) => askYourModel(instructions, body, signal);

const mem = memory({
  sources: [historySource({ reader: chat(), ...chatSettings, questions: PERSONAL_CHAT_WRITTEN_CASCADE })],
  decide,
  pick: { writeQuestions: taskQuestionWriter(write) },
});
```

Each mistake throws before any decide request:

- **A writer no set reads:** `writeQuestions` while no source's set has
  `written` throws a `TypeError`.
- **Weights with no writer:** a set with `written` while
  `writeQuestions` is unset throws a `TypeError` that names the source.
  Its weights were fitted with the written terms, so the score without
  them would be wrong.
- **A failed writer:** a writer that throws, or returns anything but 2
  to 4 questions each with nonempty `instructions`, `true` and `false`,
  stops the pick with the reason.

`record.writtenQuestions` holds the `questions` the writer wrote, with
their keys. A part's record entry lists the written questions it was
asked beside the others. A set with `written` cannot use the keys
`task1` to `task4` for its own questions.

### A question about each name

A question set's `named` field asks its `question` once per name the
task names, with `{name}` replaced by the name. It is asked of each
reference part in the same request as the set's other questions. In a
set with `first` and `band`, it is asked only of parts whose first
answer is inside the band. Each answer is keyed by the question's key
followed by the name's place in the list from 1, such as `name1`. A
task with no names asks it of no part and adds neither term. The names
come from `taskNames`, or from `findNames` when the call gives it.

`named: { question, highest, hasNames }` adds `highest × logit(highest
answer across the task's names) + hasNames` to a part's score. The
answer is clamped to 0.0001 to 0.9999 before the logit. With every name
answer missing, only `hasNames` is added. A name answer is a weighted
term, never a rule: other parts of the same history mention the same
name and get answers just as high, so a rule that raised a part to its
name answer ranked the answer parts worse in tuning.

`PERSONAL_CHAT_WRITTEN_CASCADE` carries `named`, asking "Does this part
mention {name}?", with `highest` 0.1655479793453193 and `hasNames`
-0.1646894012324575. Those weights were fitted together with the rest
of that set. No other shipped set carries `named`, because no weight
was fitted for one. A set's own question keys cannot be the name
question's key followed by a number.

### Decision tags

`tags` asks extra yes/no questions of each reference that passes
relevance, after selection decides. A `PickTagSet` is a named set of
`PickCriterion` questions such as intent or importance. The answers
never change what is selected: they label the kept pieces so a later
step can read intent, importance and emphasis without asking the
decision model again. Rules are never tagged.

```ts
import { DECISION_TAGS } from '@curatejs/core';
import { GIT_HISTORY_TAGS } from '@curatejs/git';
import { MARKDOWN_TAGS } from '@curatejs/markdown';

const picked = await pickFromSources(sources, request, {
  task, decide,
  tags: DECISION_TAGS,
  tagsByKind: { 'git-history': GIT_HISTORY_TAGS, markdown: MARKDOWN_TAGS },
});
```

`DECISION_TAGS` carries the shared sets: intent (instruction, decision,
correction, idea, question, fact, chat), importance (passing, relevant,
important, critical), emphasis (neutral, emphatic, approving) and a
yes/no "corrects something earlier" set. `GIT_HISTORY_TAGS` adds fix,
feature and revert for commits; `MARKDOWN_TAGS` adds decision record,
rule and how-to for notes. `tagsByKind` adds sets for references of one
source kind. For direct `pick` calls, supply `sourceKinds: { conversations: 'chat' }`
to map each candidate's `sourceId` to its kind. `pickFromSources` fills
that map from the sources that returned those candidates; a declared
source kind takes precedence over the supplied map. The record keeps the
map when `tagsByKind` is given, and each candidate entry records
`sourceKind` when its kind is known.
Tag set keys must be unique across `tags` and `tagsByKind` for one
candidate.

Every answer is recorded on the reference's record entry under `tags`,
with its status kept as returned (`answered`, `missing`, `refused` or
`error`). Tag questions run under the same stopping dials as relevance;
a question a stop left unasked records `unassessed` with the stop
reason, and the sets stay on the reference so a host can see which tags
are partial. A set's `value` is the first of its questions, in list
order, answered at 0.5 or more; earlier keys win, and the value stays
unset when none reach 0.5. A single-question set values to `yes` at
probability 0.5 or more, otherwise `no`. A set whose answers all
failed records its answers and no value. The record keeps the supplied sets.
Omit both options to skip decision tags.

Selected references are ordered by decision probability, strongest first,
with ranked order breaking ties. The default score cut is 0.0146.
There is no fixed character cap.
`keepTop: N` marks the first N ranked keyword hits. Those that pass
the threshold move to the front; rejected items stay rejected. N must be a
nonnegative safe integer. Fitted sets and top-hit promotion are opt-in.

### Optional rank protection

`rankProtection: true` orders selected references by
`w / rank + (1 - w) * probability`. Rank is one-based within the source;
with extra searches it is the best rank across them. The weight `w` is
0.75 at ranks 1–3, 0.60 at 4–10, and 0.40 below that. Rules stay first,
and `keepTop` retains its explicit promotion.

This affects order only. Reference score cuts still apply; rules keep
their separate applicability bar. The record stores `orderScore`
separately; the weights curate receives remain the original decision probabilities. Omit the option or pass
`false` to retain the default order and record format.

### Optional best part first

`bestPartFirst: true` first asks about the fed part with the most distinct
task words in each document. Words must have more than two characters;
ties use feed order. Chat parts group by provider and session, notes by
their file, and commits remain separate items. Source and revision are
part of every group identity. Hosts can supply `candidate.documentId`
for their own parts; candidates without document metadata stay separate.

Curate applies the representative's question set before asking about all
its other fed parts. A low score on the first part never skips the rest
of the document. Score cuts apply to each part's own decision score.

Each fed reference records its `representative` item id. Batch, candidate,
time and cancellation limits remain in force. A stopped run reports the
stop reason for unasked parts. Rules are asked independently. Omit the
option or pass `false` to judge the whole feed as usual.

### Label gate

The gate runs for each source that carries label kinds, and for no other.
A source supplies its label questions through `labelKinds`, which
`historySource()` sets from its `labels` setting: `true` for `LABEL_KINDS`
(personal facts, things owned or used, purchases or arrivals, events or
plans, preferences, habits, and decisions), a list for those kinds, or
`false` for none. Chat's settings ask the seven kinds; git's and Markdown's ask none.
A source with no kinds receives no label questions; its other search lanes still apply.
`pick.labels: { directory, deciderId }` sets where labels are stored and the decider identity they are keyed by; both are optional.
The default directory is `$XDG_CACHE_HOME/curate/labels`, or `~/.cache/curate/labels` when `XDG_CACHE_HOME` is unset.

Give a source your own kinds through `labels`:

```ts
import { historySource, type LabelKind } from '@curatejs/core';
import { markdown, markdownSettings } from '@curatejs/markdown';

const labelKinds: readonly LabelKind[] = [{
  key: 'constraint',
  name: 'a constraint',
  part: {
    true: 'The excerpt states a constraint.',
    false: 'The excerpt states no constraint.',
  },
}];
const source = historySource({ reader: markdown({ paths: ['docs'], kind: 'docs' }), ...markdownSettings, labels: labelKinds });
```

`memory()` and `pickFromSources()` use each source's kinds automatically.
For a direct `pick()`, pass `labelKindsBySource`, keyed by each candidate's
`sourceId`; an absent or empty set means no label work:

```ts
const picked = await pick(candidates, {
  task,
  decide,
  labelKindsBySource: { [source.id]: labelKinds },
});
```

`PickDecide` accepts an optional `deciderId` property.
The built-in helpers use `typesafe:${model}:items-once` and `openai:${model}`.
An explicit `labels.deciderId` overrides the function's ID.
A handwritten function without an ID uses `'custom'`.
Different handwritten decision functions must supply different IDs to keep their saved labels apart.

Labels add the parts they find to the decide feed.
Each reference part answers its source's kind questions once.
The answers do not depend on the task, so the pick
stores each part's set in `directory`, one JSON file per part written to
a temporary file and renamed into place. A later pick over the same
part text reuses the stored set and asks nothing. A changed part,
`deciderId`, kind set or `questionVersion` uses a different key and is
labelled again. A missing, corrupt or wrong-shaped
file is a miss, and a refused, missing or errored answer is never
stored.

Picks running at the same time in one Node process share label work.
When a pick needs a part's labels that another pick is already asking for,
from the same label directory, kind set, `questionVersion` and `deciderId`,
it waits for that answer instead of asking again. When that answer fails,
a stop leaves the part unasked, or the asking pick's `signal` aborts
while its decide call is still running, one waiting pick asks for the
part itself and any other waiting pick waits for it. A wait ends at the waiting pick's own `signal` and `maxElapsedMs`.
Picks in separate processes do not share: each asks for the labels it
has not found in the store.

The task answers each distinct kind set once, and its sets are stored the
same way under the task's own keys: a later pick over the same task text
reuses it too. Each source has its own label bar, its `labelBar`
setting, 0.5 (`LABEL_LANE_BAR`) when absent. A kind the task needs at a
source's bar or more puts every part of that source labelled at that
bar or more on the kind in the label lane, ordered by that
probability. Two sources that share a kind set share the task's
labels, but each reads them at its own bar. The decide step then sees
the union of the keyword lanes and the label lane, ordered by
reciprocal-rank fusion of the two orders. Through `pickFromSources` the gate
labels the source's full uncut search pool: on the `everyRanked` feed a
part the keyword lanes dropped can still reach the decide step through
the label lane, while under the fused order the lane reorders the order
the decide step reads and admits none. It reorders before the read
starts, so every part of the order, inside any `feed` size, is
labelled first; the store keeps each part's labels for later picks. Through
`pick` directly it labels reference parts with kinds in `labelKindsBySource`.
Label batches
count against `maxBatches` and `maxElapsedMs`, so a stop while labelling
leaves the decide step unasked. The label lane is not capped by
`maxCandidates`: every part in it reaches the decide step unless a feed
bound caps the merged ranking: `everyRanked: { c }`, a `feed` size or
a rating stop.

The record's `labelKindsBySource` lists the full kind definitions applied
to each source, or `[]` when it carries none.
The record's `labels` field keeps the question-set version, the
`deciderId`, how many items' labels the decide port was asked, how many
were reused from the store, `waited`, how many parts' labels came from
another pick's request in flight (left out when 0), the gate's size, and `failedWrites`, how
many label sets the store could not write. A failed write keeps the
answers for this pick, adds one `warning` to `labels`, and the next pick
asks for that set again. A reference part the keyword lanes never
held, left out on its stored or answered labels, records `unassessed`
with reason `'gate'`; a part a lane limit cut or a stop left unlabelled
keeps that reason instead. `memory()` accepts the intentional `'gate'`
exclusions, but rejects interrupted or unanswered work.

`route: 'jev'` asks the task itself what kind of answer it needs, off
by default. The four route questions in `ROUTE_QUESTIONS` ask whether
the task needs a count or a complete list across sessions, a date, a
duration or an order, the user's stated tastes, or the latest value of
something. They go through the decide port once per pick: in the same
request as the task's kind labels when the label gate asks them, alone
otherwise, and always as one request whatever the request-size dials
allow. An answer at `LABEL_LANE_BAR` or more switches on the
options its route maps to: `taste` switches on
`preferenceAdvice` and `preferenceChange`, and `count`, `date` and
`latest` switch on `working`. The record's `route` field keeps the
answers and the options they switched on. Omit the option and the pick
is identical to a pick without it.

### Optional decision cache

`cache: { store, deciderId }` stores each answered decision, off by
default. The `store` port is asynchronous `get(key)` and
`set(key, value)`; `decisionFileStore(directory)` is the supplied one,
one JSON file per answer under `directory`, each written to a
temporary file and renamed into place. `deciderId` is required: it
names the decider behind the stored answers, so two different
deciders never read each other's files.

Each answer's key is a SHA-256 over the task text, the question-set
version, the rendered question's wording, true and false criteria
and fitted name and tag set, the `deciderId`, the text cut applied,
and every field of the part the decider receives: its source id, id,
title, role, kind and date, and its text, a change past the cut
included. A changed task, version, deciderId, wording, part or cut
asks again; an unchanged part hits. The key names the part and its
exact question, not the batch around it, so an answer is reused
across batches: a later pick that adds or changes one part asks only
that part and reuses the rest. That rests on one assumption: a
part's answer barely depends on the parts batched beside it. Reuse
matters for resumed runs and repeated questions, where most parts
are unchanged. A missing, corrupt, wrong-shaped or unreadable entry
is a miss, and a refused, missing, errored or never-asked answer is
never stored, so a stored file always holds one complete answer. The
signal and elapsed dials guard the reads as they guard the batches:
a stop leaves every question not yet resolved unassessed. Thresholds and
link rules apply to cached answers as fresh ones, so a changed
threshold reselects from stored answers without asking.

A stored answer marks its record entry `reused`: on a selected or
rejected entry when every decision behind it came from the store,
on each per-question and tag answer, and never on an
`applies: 'always'` rule, which is never asked. An answer the
decider had to truncate is stored with its `truncated` flag, so a
reused answer keeps the warning. The record's `cache`
field keeps the question-set version, the `deciderId`, how many
decision and tag questions the decide port was asked, how many
answers were reused, and `failedWrites`. Label questions go through
the same port but are not counted here: `labels.asked` counts each
asked item once, and an item asked sends one question per label
kind. A failed write keeps the answers for this pick, adds one
`warning` to `cache`, and the next pick asks for them again. Pass
`cache: false` to bypass a configured cache for one pick, for
example a held-out benchmark run: nothing is read or written and
every part is asked. Omit the option and the pick is identical to a
pick without it.

### Optional scaled top-k

`everyRanked: { c }` decides only the top `round(c × N^0.8)` reference parts
of the ranking the decide step reads. `everyRanked` is unset by
default, the decide step reads the whole fused order instead, and `true`
reads every ranked part, the earlier feed. N is the number
of reference parts the pick received: the history's size, not the
ranking's. Through `pickFromSources` the read carries the source's
full uncut pool, so lane cuts and read limits do not shrink it; a pool
member only counts toward N, and with the label gate off it reaches
the feed or the record only when the rare-word round pulls it in. The
ranking is the gate's fused order
when the gate fused its lane into the keyword order, the keyword
order otherwise. Rules pass through uncounted and are never cut. A
part below the keep count is never asked; it records `unassessed` with
reason `'pick'`. `c` must be a positive finite number, and an invalid
`c` throws a `TypeError` before any decide call, as does an
`everyRanked` combined with `stopWhenCold` or `feed`.

Measured on the tuning half's saved rankings (249 questions, 445 answer
messages) with the label gate on and `wholeLanes` on, over every part of
each history from 127 to 8,475 parts:

| Keep rule | Answer messages kept, of 445 | Parts kept at 850 parts | Parts kept at 8,475 |
| --- | --- | ---: | ---: |
| `2.173 × N^0.8` | 444–445 (99.8–100%) | 479 | 3,017 |
| `0.68 × N^0.8` | 437–442 (98–99%) | 150 | 944 |
| `0.471 × N^0.8` | 432–440 (97–99%) | 104 | 654 |

The table replays those saved rankings: they break equal fusion scores
by item id, where the package's fused order breaks them by keyword
position. It checks the study's coverage, not identical coverage for
the package's own ranking.

It is a dial, never the default, because no caller-chosen count is
safe everywhere: the default reads the whole fused order.
The dial's point is cost: the decide step's work grows sublinearly with
the history's size instead of with the whole ranking.

### Stop when the ratings go cold

`stopWhenCold` is off unless set. Without it the decide step rates
every part of the fused order: every part some search lane kept, so a
call's cost grows with the number of parts the lanes keep. Each part
rated cost about $0.00002 of decision questions on three benchmark
runs: about $0.0033 for a LoCoMo conversation's 170 parts, and $0.053
for the 2,361 parts a DolphinBench test rated on average.

The fused order gives each candidate the best of its keyword-lane
positions (a keyword lane is one `searchRanks` index across every
source) and its position in the history's own best-similarity
ranking. With `stopWhenCold` set, `{}` taking both defaults, the
decide step reads that order in the request-sized batches `limits`
forms, two batches at a time. When both replies land, it checks the
two batches in order and stops at the first one whose best decision
score is under `floor` (0.1), or under `share` (0.2) times the best
score of every batch before it, but never before the read has kept a
reference part on the bar the selection keeps it at (its source's bar,
or the bar `everyScored` sets, flat or by size; a rule kept at its own
bar does not count): until then it reads on, wave by wave. So
a question the history holds nothing for reads the whole order even
with the stop set, at the full cost of the stop off. The score is the
one the pick keeps parts on, after every question of the part's set. A part whose text
repeats an earlier part's takes that part's answer and does not count
toward its batch's best. The other batch of a pair that went cold is
rated and kept as usual, so the read passes the cold batch by at most
one batch. A stop never drops a part it rated: every rated part at or
above its source's keep bar is kept.

A part below the stop is never asked by the read and records
`unassessed` with reason `'stopWhenCold'`; the rare-word round can
still pull one in. A part no lane placed in the order records
`'feed'`. Pool members sit in the record the same way, so an unordered
member is unassessed rather than absent. A lane's candidate limit, not
the stop, leaves its cut parts unassessed with reason `'limits'`, and
`memory()` still rejects that collection; it accepts `'stopWhenCold'`
and `'feed'`.

`{ floor }` or `{ share }` changes one test for one call. A higher
floor or share stops sooner and asks fewer questions; a lower one
reads further and finds more. The stop applies only when `everyRanked`
is unset, and records under `levers.stopWhenCold` as `{ floor, share }`,
or `false` when off. The record's `pick` field keeps `n`, `sent`,
`questions`, `kept` and which ranking the feed followed (`'fusion'` or
`'keyword'`), and with the stop on, under `stopWhenCold`: the floor
and share, the `waves` of requests sent, the `batches` and parts
(`rated`) of the order it rated, the parts of the order it never rated
(`unread`), the rated parts at or above their keep bar (`kept`), and
what `ended` the read: `'order'` when it reached the order's end, with
`kept: 0` when nothing reached the keep bar; `'cold'` when the ratings
went cold; or the stopping dial that ended it first (`'limits'`,
`'time'`, `'cancelled'` or `'error'`). Under `cold` it keeps the batch that went cold, counted
from 1 down the order, its `best` score, the best score before it
(`bestBefore`) and the test it failed (`under`). Under
`everyRanked: { c }` the `pick` field keeps `n`, `sent`, `questions`,
`c`, `kept` and `ranking`, and a rare-word round adds `rare`.

```ts
const picked = await pick(candidates, { task, decide, stopWhenCold: { share: 0.1 } });
picked.record.pick?.stopWhenCold;
// { floor: 0.1, share: 0.1, waves: 2, batches: 4, rated: 520, unread: 1480, kept: 37, ended: 'cold',
//   cold: { batch: 3, best: 0.04, bestBefore: 0.92, under: 'floor' } }
```

The stop saves most on long histories and costs answers on short
ones. Two checks measured it, with no decision call.

- **Evidence kept, three runs' saved scores.** A replay read the saved
  decision scores of three finished benchmark runs (LoCoMo, 1,540
  questions over conversations of about 170 parts; DolphinBench, 30
  tests over Claude Code transcripts of about 5,800 parts; BEAM 128K,
  40 questions) down each question's fused order, in request-sized
  batches, and compared 80 stop rules with the parts the runs rated, at
  a fixed depth of 3,674. DolphinBench and BEAM saved their search
  lines, so their orders are the runs' own. LoCoMo's run saved none, so
  its order was rebuilt with the question's text standing in for every
  search line: its LoCoMo figures rest on that stand-in order, not the
  run's. A share of 0.2 was the cheapest rule that kept at least 98% of
  the runs' evidence on every tuning half. The floor of 0.1 ends a read
  after its first two batches when nothing in the history scores warm,
  for 0.8 points of LoCoMo evidence. These figures are evidence kept,
  not answers scored.
- **Answers, the two published benchmarks.** A score check rebuilt the
  published LoCoMo and LongMemEval texts with the stop on, from the
  runs' saved scores, and answered and marked the changed texts twice
  with the published runs' answering model, gpt-6.1-sol: all 403 on
  LongMemEval, a seeded 400 of the 952 on LoCoMo. LoCoMo's order is the
  same stand-in. With the stop off it rebuilt every published text
  byte for byte.

On the held-back halves of the replay, as a share of the parts the
runs rated and of the evidence they found:

| Read | LoCoMo | DolphinBench | BEAM |
| --- | --- | --- | --- |
| The defaults, one batch at a time | 61%, 98.1% | 50%, 95.2% | 82%, 100% |
| The defaults, two batches at a time, as `pick` reads | 64%, 98.5% | 55%, 95.2% | 83%, 100% |
| `share` 0.1, no floor, one batch at a time | 70%, 99.3% | 87%, 100% | 89%, 100% |
| `share` 0.3, no floor, one batch at a time | 58%, 98.2% | 34%, 95.2% | 75%, 95.2% |
| `share` 0.5, no floor, one batch at a time | 53%, 97.1% | 17%, 95.2% | 64%, 85.7% |

The second row is the built `pick` on the same saved scores. Its
batches are sized by characters rather than by a fixed count, which
moves where each batch starts; on DolphinBench that alone moved about 4
points. The held-back halves hold 770, 15 and 20 questions; on
DolphinBench and BEAM one evidence message moves a figure by about 5
points.

On the published runs' answers, with the defaults:

| Published benchmark | Parts rated | Right answers | Saved a question |
| --- | ---: | --- | ---: |
| LoCoMo, 1,540 questions (published 1,486 right) | 64% of the whole order | About 5 to 12 fewer: estimated 1,474 to 1,481; the same 4 questions lost in both answer runs, each because a gold evidence turn left the text | $0.0012 |
| LongMemEval S, 500 questions (published 471; six published sets 466 to 471) | 31% of every part | 468 and 470: inside the noise | $0.0067 |

- **LoCoMo:** the stop took a gold evidence turn out of 30 questions'
  texts (1.9%). The gentlest setting answered, no floor and a share of
  0.05, rated 82% of the order and still lost about 3 to 4 answers
  (1,482 and 1,483), on questions whose evidence left the text.
- **LongMemEval:** a gold turn left 10 texts (2.0%), and 2 texts came
  out empty: on each, every part of the first two batches scored under
  the keep bar, the floor ended the read, and every part the full read
  keeps sat lower in the order; on one of them the evidence part sat at
  place 505. These answer figures were measured on a stop that could
  fire before its read kept a part. The stop waits for a kept part, and
  only a read that ended with nothing kept changes under that rule:
  these two, which read on to the parts the full read keeps. No LoCoMo
  read ended with nothing kept.
- **Long histories:** on DolphinBench's 5,800-part transcripts the stop
  rated about half the parts, about $0.026 saved a test. Its effect on
  answers there is not measured.

The stop's weak point is a lone part that scores warm below a long cold
stretch: LoCoMo's worst evidence losses were turns at places 81 to 175
that scored 0.65 to 0.74 once read. Where the scores separate evidence
poorly, as on BEAM's broad questions, the stop reads most of the order
and saves little.

Two batches go out at a time to save round trips without reading far
past the stop: on the replay's saved scores, two at a time rated 3, 1
and 1 points more of LoCoMo's, DolphinBench's and BEAM's parts than one
at a time, for an estimated 45%, 16% and 48% less decide time from the
service's measured round trip and token allowance; three at a time
rated 14, 3 and 2 points more for little more speed.

### Feed

`feed` is off unless set. It changes the order the decide step reads,
and how far. `feed: { order: 'combsum' }` orders the fused order by the
sum of a part's lane places where the default takes its best place,
which favours a part several search lanes agree on over a part one lane
placed high. A keyword lane's place is the part's share of that lane across
every source, a meaning lane's place is its share among its own
source's members of that lane, and a names lane adds nothing. Equal
sums keep the queue's order. `size` is the most reference parts fed:
a rating stop still reads inside it and can end the read sooner; with
no `size` the whole order is fed.

```ts
const picked = await pick(candidates, {
  task, decide, feed: { order: 'combsum', size: 400 },
});
picked.record.pick?.feed; // { order: 'combsum', size: 400, unjudged: 2600 } when 3,000 parts were ranked
```

A shorter feed asks fewer decision questions and judges fewer parts: a
part the default order would have fed and scored can go unjudged. It
records `unassessed` with reason `'feed'`, and the record's
`pick.feed` keeps the order, the size and how many ranked parts the size
left unjudged. With a size, the rare-word round asks the parts it
pulls only while the size still has room. Rules are never cut. `feed`
with `everyRanked` throws a `TypeError` before any read, because
`everyRanked` has no fused feed to order.

### Optional rare-word round

A second, narrow round after selection, run within each source on its own.
Git and Markdown turn it on through their `rare` setting; chat leaves it off.
To turn it off for one source, build that source with `rare: false`:

```ts
const source = historySource({ reader: git('.'), ...gitSettings, rare: false });
```

`memory()` and `pickFromSources()` use each source's setting.
For direct `pick()` calls, pass `rareBySource`, keyed by each candidate's `sourceId`.
An omitted or false entry leaves that source's round off.
Explicit `rare: true`, `rare: false` or `rare: { share, bar }` overrides every source's setting for the whole pick.
The round only adds reference evidence. Rules keep their exact text and separate applicability check.
`rare: true` uses the round's default settings; `{ share, bar }` tunes them.
Each source's round reads only that source: its reference parts supply the seed words, count toward word frequency, and are the only parts it pulls in.
So one source's setting never changes another source's pick.
The parts that cleared their source's bar supply the seed words.
A seed word is rare when it appears in at most `share × N` of its source's reference parts, where N is that source's reference count.
N includes the source's pool members that the search lanes left out.
It can differ from `pick.n`, which counts references across every source for the top-k limit.
`share` defaults to `5/850`, the count of 5 fitted on an 850-part LongMemEval history.
On a source with fewer than 340 reference parts, the default share can pull nothing:
a shared word appears in at least 2 parts, and `5/850 × N` stays below 2.
Every unselected reference of the source that shares one of its rare words is pulled in, pool members included.
One the first pass never asked goes through the decide step; one already decided reuses its score.
With a rating stop set, the round reads the parts it asks in fused order, two batches at a time, under the same stop with a best score of its own, so a round whose answers go cold ends; a part it never reached keeps its reason.
No part is asked twice. A pulled part joins the selection at or
above `bar`, a separate bar defaulting to `0.0146`; the seeds keep
their source's own bar. `share` must be a positive finite number and `bar` between 0 and 1, both checked before
any decide call. The record's `pick.rare` keeps the share and bar
used, each source's N and rare words under `sources`, the parts pulled
in, and how many were asked and added.
The outer `pick.n` still counts references across every source.

Measured on the tuning half's saved decisions (249 questions): holding
the selection bar at 0.05 loses 15 answer messages, and the round at
its defaults recovers 6 of them while adding 12.9 parts a question,
matching the fixed-count study's 6 of 15 at about 15.

### Markdown candidate kinds

The Markdown package's `markdown({ paths, kind })` source adds a candidate
`kind`: `knowledge`, `docs`, `rules`, or `instructions`. This is separate from
the source's `questions` setting. A source without a question set asks the
candidate-kind question. Host candidates with
role `rule` retain rule questions; instruction candidates use the instruction
question. Decision questions and records keep the candidate kind.

`ranking: { docs: { bm25: 2 } }` weights signals by Markdown kind before the
candidate feed is chosen when candidates have no search ranks. Search ranks
retain their lane order. Omitted signal weights are 1. Weights must be finite;
negative weights are allowed. The record includes `ranking` when supplied.
Selection retains the default score order and 0.0146 score cut.

Sources can declare `maxQuestionText` as their preferred reader part size.
Infinity requests whole items by default. Explicit pick and read text budgets
take precedence. The Markdown source uses this to keep whole text; existing
readers retain their part sizes. A shared `CandidateReadContext` passes file
bytes between overlapping reads within one `pickFromSources` call.

## Curating

`curate(task, picked, { answerTokens?, sentenceCutoff?, decide?, signal? })`
accepts the result of `pick` or `pickFromSources` and lays out its
selected reference items for the working model to read. No model
writes the text: each item keeps its own words. It returns `{ log,
record }`, with the laid-out text in `log`. Selected rules stay out of
`log`; `memory()` returns them as `rules`.

The two items with the highest decision weight sit under
`### Most likely answer`, each under its own
`#### <source> (said <date>)` heading; equal weights keep the fused
order. Every other item is grouped by said date and source, under
`### <source> (said <date>)`, groups oldest first and items in weight
order inside a group. The said date is the first `YYYY-MM-DD` or
`YYYY/MM/DD` the item's date value writes, so date labels, ISO dates
and timestamps all read the same. An item with no date shows
`(said unknown)` and its group comes last. A date that is only the
file's last change shows `(file changed <date>)`. A heading names the
item's file when it has one, and its source otherwise, so two files of
one source stay apart. A commit with no body shows its title.

```text
### Most likely answer

#### docs/billing.md (said 2026-01-12)

Invoices must preserve the currency recorded when the order was placed.

#### git:/home/sam/shop (said 2026-01-14)

Keep the order currency on refunds.


### chat:claude-code:/home/sam/chat (said 2026-01-10)

user: Should refunds use today's rate?
```

- **Copies taken once:** an item whose text, trimmed, is the same as an
  item taken before it is not taken again, and the next item gets its
  room. The taken item's heading then also names where and when the copy
  was said, when that differs: `<heading>, also <source> (said <date>)`.
  A text that only sits inside a longer item stays: it may be a quote, a
  rejected plan or a later restatement, and the longer item's place and
  date are not its own. `record.collapsed` counts the copies.
- **Budget:** `answerTokens` keeps the whole text within that many
  estimated tokens, `DEFAULT_ANSWER_TOKENS` (2,000) when omitted. Items
  are taken in weight order, and the first item that would take the text
  over the budget stops the taking. The strongest item is always kept
  whole, even over the budget. The estimate needs no tokenizer: it counts
  words, digits in threes, runs of one punctuation mark, line ends and
  characters outside ASCII, fitted to a real tokenizer's counts and set
  about a tenth high. It is an approximate budget, not a ceiling: text
  full of rare names, such as products or medicines, can cost more real
  tokens than it counts. `record.leftOut` holds how many selected items
  the budget stopped before, the strongest weight among them and how
  many have a weight of 0.5 or more.
- **Sentence cutoff:** with `decide`, curate rates every sentence of the
  taken items in one more request and keeps a sentence when its rating
  is `sentenceCutoff` or more, `DEFAULT_SENTENCE_CUTOFF` (0.1) when
  omitted. `sentenceCutoff: false` rates no sentence and calls no model;
  without `decide` no sentence is rated either, and a number then throws
  a `TypeError`. Each sentence is asked "Does this sentence supply
  evidence, a constraint or a decision for this task?" with no id or
  title, the item's date on its first sentence. A sentence is the text up
  to a full stop, question mark or exclamation mark followed by a space,
  or to the line's end; blank lines go. Kept sentences stay in their own
  words and order under the same headings, and `…` marks each place text
  was left out. A line that opens `user: ` or `assistant: ` names its
  speaker, and the first kept sentence of that speaker's turn carries
  the name. An item with no sentence kept is left out, the strongest
  included, so the text can be empty. A sentence `decide` gives no rating
  stays. When the request fails, the whole text is returned as if no
  sentence were rated, and `record.sentences.failed` holds the message;
  a cancelled request throws. `answerTokens` bounds the text that is
  rated, so the returned text is usually far smaller. A kept sentence
  can lose the sentence that says what it refers to.

`record` holds the pick's `levers`; the `items` taken, in the order they
were taken, each with its full `id` (with the source beside it when two
items share an id), its `candidate` as shown and its exact `weight`;
`estimatedTokens`, the returned text's estimate; `answerTokens`;
`collapsed`; `leftOut`; and, when sentences were rated, `sentences`:
the `cutoff`, the sentences `kept` of how many (`of`), how many were
`unanswered`, the items that lost a sentence (`itemsTrimmed`) or every
sentence (`itemsLeftOut`), `estimatedTokensBefore`, and `failed` when
the request failed.

An unknown option, an `answerTokens` that is not a positive integer, a
`sentenceCutoff` that is neither `false` nor a number from 0 to 1, and
a `decide` that is not a function each throw a `TypeError` before any
call. A reference with no selected record entry and weight, or a pick
with no selected reference, throws too.

## Levers and source settings

Every cost and selection lever follows one rule: turning it on reads more
evidence or adds more guidance, at the risk of more cost; turning it
off saves cost and can lose quality. A lever lives in one of four
places: a source's own settings, the read request `pickFromSources`
takes, the options `pick` takes, or the options `curate` takes. The
pick's record keeps every lever's resolved state under `levers`, with
the settings each source ran with under `levers.sources`. Its `route`
records the questions asked. The curate record carries the same lever
set.
`meaning.wholeLanes` resolves the meaning lanes on their own, so when it disagrees with the read request's `wholeLanes` the
record holds `levers.wholeLanes: { keyword, meaning }`.

| Lever | What "on" does | Cost when on | Measured impact | Where measured |
| --- | --- | --- | --- | --- |
| Read `wholeLanes` | Keeps every candidate each keyword and meaning lane returned. Off, each lane cuts where its own score curve flattens (chat: the pre-merge keyword score; `searchPhrases` lanes are never cut, and kind lanes are never cut on phrase counts). | The decide feed grows by the parts the curves would have cut; kept counts vary with each lane's scores, and deciding is the expensive stage. | The cut the off state applies missed 6 of 445 answer messages on the tuning half: three shared no words with the question, three ranked below the cut. Its score and cost impact, and the loss under the label gate, are not yet measured. | Saved tuning-half lanes, 249 questions. |
| Pick `stopWhenCold` | Off unless set; off, the decide step rates every part of the fused order, so a call's cost grows with the parts the search lanes keep. Set (`{}` takes the defaults), it reads the order two batches at a time and stops at the first batch whose best decision score is under `floor` (0.1), or under `share` (0.2) times the best score before it, never before the read has kept a part. Parts below the stop record `unassessed` with reason `'stopWhenCold'`; the rare-word round can still pull one in. | The parts read before the scores go cold, and at most one batch past them; a question the history holds nothing for reads the whole order. A higher `floor` or `share` reads less; a lower one reads more. Saved $0.0012 a LoCoMo question and $0.0067 a LongMemEval question; about half the parts of a 5,800-part DolphinBench transcript. | On the replay's held-back halves the defaults rated 64%, 55% and 83% of the parts the runs rated on LoCoMo, DolphinBench and BEAM, and kept 98.5%, 95.2% and 100% of their evidence. On the published runs they cost about 5 to 12 of LoCoMo's 1,540 right answers and stayed inside the noise on LongMemEval. | Saved decision scores of three finished benchmark runs, replayed with no decision call, and the published LoCoMo and LongMemEval texts rebuilt and answered twice ([Stop when the ratings go cold](#stop-when-the-ratings-go-cold)). |
| Pick `everyRanked` | Unset by default: the decide step reads the whole fused order instead. `true` gives the earlier feed: every ranked reference part reaches the decide step. `{ c }` reads only the top `round(c × N^0.8)`, where N is the number of reference parts the pick received; rules pass through uncut and dropped parts record `unassessed` with reason `'pick'`. | With `true`, the decide step reads every ranked part, the whole ranking: all 850 of 850 parts at one measured size and all 8,475 of 8,475 at the largest. The off dial at c = 0.68 read 150 of the 850 and 944 of the 8,475. | On the keyword-and-label ranking the off dial at c = 0.68 kept 437–442 of 445 answer messages (98–99%) at every size from 127 to 8,475 parts (on keeps the whole ranking) and scored 229 of 249 at $0.18 a question; the on state's score and cost under the label gate are not yet measured. | Saved tuning-half rankings replayed, label gate on and `wholeLanes` on; the tuning dials in the root README. |
| Source `bar`, pick `everyScored` | Off by default: each source cuts its references below its own `bar`, 0.0146 for every reader. `everyScored` sets one cut for every source in place of their bars: `true` keeps every part with a valid decision probability, including zero; `{ bar }` cuts below a flat bar; `{ bySize }` cuts below a bar that rises with the decided count. | `curate` receives every scored part. At the 0.0146 bar it receives about 70 of a LongMemEval history's 850 parts. | At the 0.0146 bar: 225 of the 249 tuning questions at $0.13 a question (223 on the all-500 replay), and 458 of 500. A saved 0.6 bar removed every fed fragment of 183 labelled answer turns; a 0.05 bar lost 8 of 438 answer messages. 0.0146 is the highest cut that lost no answer message on the tuning questions. | Saved-decision sweep and the LongMemEval runs in the root README. |
| Source `labels` | Per source: a source that carries label kinds has its reference parts labelled with those kind questions, and the task is asked once per distinct kind set. Sources with no kinds receive no label questions. Stores each set under `directory` and adds a label lane so parts the keyword lanes dropped can reach decide on the `everyRanked` feed; under the fused order the lane reorders the order the decide step reads and admits none. Uses a default cache directory and decision-function ID; `pick.labels` overrides both. | One question per kind for each part and task, once per text, kind set and `deciderId`; later picks reuse the store. | Keyword alone reached 439 of the tuning half's 445 answer messages; with each part labelled, all 445 were reached at 38% of each history. Its score and cost impact is not yet measured. | Saved label run on the tuning half, in the root README. |
| Pick `route` | `route: 'jev'` on the pick asks the task the four route questions once and records the answers. | Four questions asked of the task once a pick, sharing the task's label request when that runs and asked in one separate request otherwise. | Not yet measured. | Not yet measured. |
| Source `rare`, pick `rare` | Per source: after the selection pass, pulls in the source's unselected references sharing a rare word with one of its selected references. Each source turns it on with its own `rare` setting; `pick.rare` sets it for every source. Each source's round counts word frequency over its own references only and pulls only its own parts, pool members included; parts at or above `rare.bar` (default `0.0146`) join the selection. A word is rare at a document frequency of at most `rare.share × N` (default `5/850`), where N is that source's reference count. | The parts it pulls are asked or their scores reused: 12.9 parts a question at the defaults on the tuning half. On a history under 340 parts the default share can pull nothing. | Holding the selection bar at 0.05 lost 15 answer messages and the round recovered 6 of them. Its score impact is not yet measured. | Saved tuning-half decisions, 249 questions. |

The decision cache is not a lever: it loses no quality, so it stays
available whenever the caller asks for it. It is on whenever the caller
passes one.

### Source settings

Each source carries seven settings, tuned for its kind of history:

- **`rare`:** run the rare-word round on this source's parts.
- **`labels`:** the label kinds asked of each part: `true` for `LABEL_KINDS`, a list for those kinds, `false` for none.
- **`labelBar`:** the label bar, from 0 to 1, for which kinds the task needs and which of this source's parts join the label lane; absent means 0.5.
- **`names`:** open one exact-phrase lane per name the task names ([names in the task](#names-in-the-task)). The reason is recall.
- **`bar`:** keep a reference part scored at or above this.
- **`ruleBar`:** keep a rule scored at or above this; absent means 0. Only sources whose parts are rules use it.
- **`questions`:** the decision questions asked of each reference part; absent means the built-in question for the part's kind.
- **`decay`:** rank older notes lower by their age at the task date, as `{ halfLife: '365 days' }`; absent or `false` is off, as in every preset. Markdown sources only; see the [Markdown reader](https://github.com/jonny981/curate/blob/main/packages/markdown/README.md#decay).

A source can also carry the look-back and path settings its reader ran
with (`since`, `paths` and `exclude`), which the record keeps beside
these under `levers.sources`. They are the reader's own options, not
`historySource` settings; each reader's README describes them.

Each reader package exports its settings as one plain object:

| Settings object | Value | Carried by |
| --- | --- | --- |
| `chatSettings` (`@curatejs/chat`) | `{ rare: false, labels: true, names: true, bar: 0.0146, questions: CHAT_CASCADE }` | `chat()` overrides questions with `AGENT_CHAT_CASCADE` |
| `gitSettings` (`@curatejs/git`) | `{ rare: true, labels: false, names: true, bar: 0.0146, questions: GIT_HISTORY_CASCADE }` | `git()` |
| `markdownSettings` (`@curatejs/markdown`) | `{ rare: true, labels: false, names: true, bar: 0.0146, questions: MARKDOWN_CASCADE }` | `markdown()`, `knowledgeBase()` |
| `rulesSettings` (`@curatejs/markdown`) | `{ ...markdownSettings, names: false, ruleBar: 0.5 }`; 0.5 is a starting value, not yet tuned; it will be fitted on the 160-task rules test | `rules()` |

Rules have no name lanes because they are chosen by where they apply, not by search.

The 0.0146 bar is the highest cut that lost no answer message on the tuning questions.
The levers for the whole call start at: `stopWhenCold` off, `wholeLanes` off, and `route` off; `everyRanked` is unset.
`everyScored` and `rare` are unset, so each source's own `bar` and `rare` apply.

A source's settings change only that source's pick, with one exception: a selected commit brings in a note it changed, through the changed-path link.
That holds only under `everyRanked: true` with no stopping limit set.
The fused order, the default, and `everyRanked: { c }` both rank every source's parts in one fused list before they read or cut, and a stopping limit in `limits` is shared by every source, so with either one, one source's settings can change another's pick.

The record's `levers.sources` maps each source id to the settings it ran with, a `SourceSettings`:

- **`kind`:** the source's kind, when it declares one.
- **`labels`:** whether the label gate ran on its parts.
- **`labelBar`:** the label bar its needs and label lane used, present when the source carries label kinds.
- **`rare`:** whether the rare-word round was on for its parts.
- **`bar`:** the bar its references were cut at, 0 when every scored part was kept.
- **`ruleBar`:** the bar its rules were cut at, present when the source produced rules.
- **`questions`:** the question set its reference parts were asked, present when the source carries one; absent, they were asked the built-in question.
- **`decay`:** the half-life its parts ranked with, present when the source has `decay` on. Only a record `pickFromSources()` produced carries it.

So a run reads as, for example, `{ kind: 'chat', labels: true, labelBar: 0.5, rare: false, bar: 0.0146 }`: a chat source with labels on.
`levers.rare` is `false` or `{ share, bar }`, and `levers.everyScored` is present only when the call gave it.
`levers.stopWhenCold` holds the stop's floor and share, or `false` when off, the default, whenever `everyRanked` is unset; `levers.everyRanked` is present only when the call gave it, and the two never appear together.

Set your own with `historySource()`.
`reader` is any source, a reader's or your own, and `rare`, `labels`, `names` and `bar` are required, so spread a settings object to start from its values:

```ts
import { historySource, pickFromSources } from '@curatejs/core';
import { chat, chatSettings, AGENT_CHAT_CASCADE } from '@curatejs/chat';
import { markdown, markdownSettings } from '@curatejs/markdown';

const sources = [
  historySource({ reader: chat(), ...chatSettings, labels: false, questions: AGENT_CHAT_CASCADE }),
  historySource({ reader: markdown({ paths: ['docs'], kind: 'docs' }), ...markdownSettings, rare: false, bar: 0.05 }),
];
const picked = await pickFromSources(sources, { task }, { task, decide });
```

A direct `pick()` takes the same settings by source id: `labelKindsBySource`, `labelBarBySource`, `rareBySource`, `barBySource`, `ruleBarBySource` and `questionsBySource`.

## What each setting did

`levers` says which settings were on. `effects` says what each one did.
Each pick record carries an `effects` list.
A pick entry names one setting that was on and the source it acted on.
It counts the parts the setting looked at and the kept parts it brought in or kept out.
When the setting brought in nothing and kept out nothing, its sentence says why.
A setting that was off has no entry, and every count comes from the one pick that ran.

A part reaches the decide step by one or more ways in: the task's own keyword lane, an extra lane (a search line, a phrase, a name or a meaning query), the label lane, a whole-lane read past the lane cut, the task's period, the rare-word round, or the commit-to-note link.
A setting that opens a way in counts a kept part as `added` only when that was the part's only way in and neither the link nor the rare-word round kept it.
A part two ways brought in counts for neither.
A lane is a way in only for the parts inside its candidate limit (`maxCandidates`).
A search line that repeats the task opens no lane, and its entry says so.

| Setting | Entry when | `actedOn` | `added` | `dropped` |
| --- | --- | --- | --- | --- |
| `labels` | The source carries label kinds; the summary names the source's label bar | The source's parts labelled this pick, asked or reused from the store | Kept parts whose only way in was the label lane | 0. The gate never removes a part a lane holds. `null` when a feed cut or a stop ended the feed early |
| `rare` | The round ran on the source | Parts the round pulled in | Pulled parts that joined the selection | 0 |
| `searchLines`, `searchPhrases`, `meaning` | The read request gave that option | Parts those lanes held | Kept parts whose only way in was those lanes | 0, or `null` when a feed cut or a stop ended the feed early |
| `names` | The source's `names` setting is on | Parts the name lanes held | Kept parts whose only way in was a name lane | 0, or `null` when a feed cut or a stop ended the feed early |
| `wholeLanes` | `read.wholeLanes` is on | Parts read past the lane cut | Kept parts whose only way in was the whole-lane read | 0, or `null` when a feed cut or a stop ended the feed early |
| `taskPeriod` | `taskPeriod` is on, the default | Reference parts dated inside the period; 0 when the task names none | Kept parts whose only way in was the period | 0, or `null` when the task named a period and a feed cut or a stop ended the feed early. When it added none, the summary says the task names no period, that none of the parts only the period brought in were kept, that every part from the period was already in a search lane, or that each part from the period also had another way in |
| `linkedPathBar` | The pick holds a reference part with a `path` and a `repository` | Reference parts rejected below their bar but at or above the link bar, with a `path` and a `repository` | Parts kept through the link | 0 |
| `bar` | Always, for a source with reference parts | The source's scored reference parts | 0 | Scored parts below the bar that no later pass kept. The changed-path link, the rare-word round and a typed question's `keepAt` can still keep a part below the bar |
| `ruleBar` | The source has rule parts and a bar above 0; the summary says how many rules were asked, picked and dropped | The source's rules asked | 0 | Rules below the bar |
| `decay` | The source has `decay` on | The dated parts the source's read ranked | Parts the source's search lanes, taken together, kept only because decay ranked others lower | Parts every search lane of the source left out only because decay ranked them lower. Both are counted in the read, before the decide step, from one set of scores |
| `alwaysOnSkipped` | The source's read skipped files the agent's harness loads every session; the summary names each file and why | The files skipped | 0 | `null`. A skipped file is never split into parts |
| `everyScored` | The call gave the override | As `bar`; it replaces the source's `bar` entry | 0 | As `bar` |
| `everyRanked` | The call gave `{ c }` | Ranked parts | 0 | `null`. The summary says how many parts the cut left undecided |
| `feed` | The call gave `feed` with a `size` | The source's ranked reference parts | 0 | `null`. The summary says how many ranked parts the size kept and how many it left undecided |
| `stopWhenCold` | The call set the stop | The source's parts in the fused order | 0 | `null`. The summary says what ended the read: the order's end, the ratings going cold (where and why), or a stopping limit, time-out or cancellation; and how many of the source's parts the read rated and left unread |
| `typed` | The source's question set has typed questions | Parts asked at least one typed question | Kept parts whose score reaches the source's bar only with the typed terms, and parts a typed question's `keepAt` kept | Parts below the bar only because of the typed terms that no later pass kept |
| `written` | The source's question set has `written` weights | Parts asked at least one written question | Kept parts whose score reaches the source's bar only with the written terms, other than parts a typed question's `keepAt` keeps | Parts below the bar only because of the written terms that no later pass kept |
| `named` | The source's question set has `named` | Parts asked at least one name question | Kept parts whose score reaches the source's bar only with the name terms, other than parts a typed question's `keepAt` keeps | Parts below the bar only because of the name terms that no later pass kept |

Labels, extra lanes, `wholeLanes` and the task's period also change the order of the decide feed.
That order matters only when something ends the feed early: an `everyRanked: { c }` cut, a `feed` size, a rating stop, or a stopping limit.
Then one of these settings can swap one kept part for another even when every part had two ways in.
One pick cannot say which parts would have been decided without the setting, so `dropped` is `null` and the summary says the feed ended early.

To know which parts lie past the lane cut, a read with `wholeLanes` on still finds the cut.
It marks each part that every lane holding it holds past the cut with `pastLaneCut: true`.
The mark is on the part and on its pick entry, and the read returns the same parts as before.

### Reading a record

A direct `pick()` over every part of a 400-part chat history, with labels on, decides every part.
Labels had nothing to add:

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

The same history through `pickFromSources`, where the keyword lane holds 60 parts, gives the label lane parts to add:

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

A benchmark or tuning run should check `effects` before it pays for answers.
A setting with `added` and `dropped` both 0, not `null`, brought in no part and kept out none.
It may still have changed the order of the kept parts, and `curate` breaks equal weights by that order.
To prove that two arms gave `curate` the same input, compare their kept parts in order.

### Record fields

- **`PickRecord.effects`:** a `PickSettingEffect[]`, one entry per setting that was on, per source it applied to.
- **`PickSettingEffect`:** `setting`, the setting's name as a caller writes it; `source`, the source the counts are for; `actedOn`, the parts it looked at; `added`, the kept parts kept only because of it; `dropped`, the parts kept out only because of it, or `null` when one pick cannot tell; and `summary`, one plain sentence.
- **`PickRecord.answerTypes`:** present when `answerTypes` was on: `bar`, `answers` with one answer per type, and `needed`, the types at or above the bar.
- **`PickRecord.writtenQuestions`:** present when `writeQuestions` ran: `questions`, the questions it wrote, keyed `task1` to `task4`.
- **`PickRecord.names`:** present when the pick looked for names: `found`, the names, and `by`, `'code'` when `taskNames` found them or `'caller'` when `findNames` did.
- **`PickRecord.pick`:** present on every pick. `n` is the history's size in reference parts; `sent` the reference parts the decide port was asked at least one task question about, where an answer the decision cache supplied does not count; `questions` the task question slots actually sent, where label questions keep their own count on `labels`; `stopWhenCold` what the rating stop read and what ended the read, present when the call set the stop; `feed` the `feed` option's order, size and unjudged count; `c` a scaled top-k cut's coefficient; `kept` the reference parts the feed sent to the decide step; `ranking` the order the feed read; and `rare` the rare-word round's numbers when it ran.
- **`keptBy`:** on a selected `PickRecordEntry`, the key of the typed question whose `keepAt` kept the part below its bar.
- **`pastLaneCut`:** on a part and its `PickRecordEntry`, true when a read with `wholeLanes` on returned the part although the lane cut would have dropped it.
- **`PickRecord.asOf`, `PickRecord.timeZone`, `PickRecord.taskPeriod`:** the moment and zone the pick read dates in, and the period the task named ([Time](#time)).
- **`dateWindow`:** on a part and its `PickRecordEntry`, `'task-period'` when the task's period brought it in.
- **`PickRecord.index`:** present when `pickFromSources` read a source from its [stored index](#stored-index). By source id: `parts`, the parts in the file after the update; `added`, the parts written this call, new or read again; `removed`, the parts deleted this call, including the old copies of parts read again; `rebuilt`, true when the file was emptied and every part read again; and `ms`, the milliseconds the update took. Sources read in parallel share the clock, so `ms` is elapsed time, not work.

`pickFromSources` tells `pick` how each source was read through the `readsBySource` option: the option each `searchRanks` position came from, the extra-lane options the read request gave, and whether the read kept whole lanes.
A direct `pick` without it gets no extra-lane or `wholeLanes` entries.

## Optional evidence limits

The defaults rate every part of the fused order and show each part's
full text.
Enabled labels can add more candidates on the `everyRanked` feed; under
the fused order the label lane reorders the order the decide step reads.
Reader parts are 700 characters by default;
every part is preserved. `DEFAULT_MAX_QUESTION_TEXT` names that reader size, not a
decision cut. A source can return more candidates than the union
keeps, since reference-source keyword and meaning lanes cut at their
own score curves before any decision. On the `everyRanked` feed, labels
can add parts those curves left out. Pass `wholeLanes: true` to keep
every returned candidate in its lane.

| Dial | Default | Cost and loss |
| --- | --- | --- |
| **`maxPerBatch`** | 150 questions | Changes request size only; all batches run. |
| **`maxBatchChars`** | Off | Sizes each request: a batch holds as many whole items as fit within N characters, counting the task's text, each item's id, title, date and text once per item in the batch, and each question's wording and true and false criteria per question. An item larger than the bound goes alone; nothing is dropped or cut. With `maxPerBatch` set too, a batch closes at whichever bound it reaches first. |
| **`maxCandidates`** | Off | Stops at N candidates per search lane. A saved tuning comparison at 100 parts lost 43 of 445 labelled answer-turn starts; 600 retained all 445 in that comparison. This does not prove a safe cut for other data. |
| **`maxBatches`** | Off | Stops after N requests; every unasked candidate is recorded. With 151 one-question candidates and one 150-question batch, one candidate remains unassessed. Cascades can use multiple requests per candidate. |
| **`maxInFlight`** | Off | Caps how many decision requests of one round are open at once; queued batches go out in dispatch order as earlier replies land. Omitted, every independent batch of a round goes out together. |
| **`maxElapsedMs`** | Off | Stops questions when the elapsed time is reached. Loss depends on response time; stopped and failed questions remain in the record. |
| **`maxQuestionText`** | Off | Cuts each decision item to N Unicode characters and records `truncated`. For a 1,000-character item at 700, 300 characters are hidden. Readers can split instead; direct `pick` callers must choose their own cut. |
| **Source read `limit`** | Off | Chat and Markdown keep ranked candidates; git keeps newest commits before ranking. Readers report partial coverage. A limit of 1 on 2 candidates drops 1. |
| **A source's `ruleBar`** | 0 | A user applicability cut omits that source's rules below its probability. Quality loss on labelled rule tasks is unmeasured; the default adds no cut loss. |

Unlimited inputs can require more decision requests and model context.
Reader failures, cancellation, missing answers and model failures still
need host handling; removing a numerical cut does not prove full recall.
