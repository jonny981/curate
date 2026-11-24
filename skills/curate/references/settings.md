# Curate settings reference

This page covers every setting of the `/curate` skill and what Curate does with it. [SKILL.md](../SKILL.md) covers running the skill and using its result.

## Setup

Install the command with `npm install -g @curatejs/cli`. The agent runs `curate check`, `curate "<question>"` and `curate prepare`. In a built checkout of the Curate repository (`pnpm install --frozen-lockfile`, then `pnpm build`), `node <the skill's folder>/run.mjs` takes the same arguments, with `--check` and `--prepare` instead of `check` and `prepare`.

A question needs each of these, in this order:

1. **Node.js 22.20 or later.** Curate's packages support Node.js 22.20 and later. Fix: Install it, for example with `nvm install 22 && nvm alias default 22`.
2. **The embedding engine (`node-llama-cpp`).** It runs the local embedding model that ranks the history by meaning. Fix: Install the command with `npm install -g @curatejs/cli`, which installs `node-llama-cpp` with it. In a Curate checkout, run `pnpm install --frozen-lockfile`.
3. **An embedding model file.** A call downloads none, and any embedding model in GGUF form works. Stored vectors are kept per model, so a different model embeds the history again. Fix: Put EmbeddingGemma 300M in 8-bit GGUF (about 330 MB) at `~/.cache/curate/models/embeddinggemma-300M-Q8_0.gguf`, or under `$XDG_CACHE_HOME/curate/models` when `XDG_CACHE_HOME` is set: `curate setup` offers to download it, or run `mkdir -p ~/.cache/curate/models && curl -L -o ~/.cache/curate/models/embeddinggemma-300M-Q8_0.gguf https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf`. Or name the model file you chose with `embeddingModel` in `~/.curate/sources.json`.
4. **The decision key (`TYPESAFE_API_KEY`).** It is a paid Jev key from TypeSafe. Jev decides which parts of the history answer the question, at about $0.00002 for each part it rates. Fix: Get a key from TypeSafe (https://typesafe.ai), then set `TYPESAFE_API_KEY` in the environment, or put `TYPESAFE_API_KEY=<key>` in a private file and name that file with `envFile` in `~/.curate/sources.json`. Never put the key in `curate.json`.
5. **A login for the search lines.** One small call on a subscription writes the search lines: Claude Haiku on the Claude login, or GPT-6 Luna through Codex on the ChatGPT login. `searchModel` picks one. Fix: Run `claude auth login` to use Claude Haiku, or `codex login` to use GPT-6 Luna.
6. **History to read.** A call searches the git repository it runs in and the sources its settings list. Fix: Run inside a git repository, put a `curate.json` in or above the working folder, or list sources in `~/.curate/sources.json`.

### Before any work

Curate checks every requirement before it starts. If any are missing, it stops with one message that lists them all, each with why Curate needs it and the fix, and exits with code 3.

It finds the embedding engine and the model file without loading them, then loads the model while the search lines are written. If something else is missing, it waits for that load too, so a model file that won't load shows up in the same message. A run given a stand-in for the search-line model needs no login.

The Mac GPU isn't a requirement. On macOS, if the embedding engine doesn't get it, Curate runs on the processor and prints one line on standard error saying the embedding step will be slower, with the fix.

### `curate check`

It runs the same checks and waits for the model to load. It prints each requirement as `ready` or `missing`, with what it found and the fix, plus a `warning` line if the embedding step would run on the processor without the Mac GPU. It ends by saying whether a question would run.

It makes no search-line or decision call and writes no run record. It exits 0 when a question would run, and 3 otherwise.

### `curate setup`

It runs `curate check`. Then, in a terminal only, it offers these steps, each answered no unless you type `y`:

1. **Download EmbeddingGemma 300M** to the model path, if no file is there. It streams to `<path>.part` and renames it when complete.
2. **Create `~/.curate/sources.json`**, naming `~/.curate/credentials.env` as the key file, and create that file with mode 0600, holding only a comment. It offers this when the key is missing and no settings file exists, and never overwrites either file.
3. **Prepare the project,** when every other requirement it uses is met.

It never asks for or prints the key. It then checks again, prints the line that installs this skill, and exits 0 or 3. Without a terminal it only checks: it writes nothing and fetches nothing.

### `curate prepare`

It builds every source a question from this folder would read, brings its index and embeddings up to date, prints one line saying how many sources it prepared, and exits. It writes no search lines and asks for no decisions, so it needs no `TYPESAFE_API_KEY` or login and makes no paid call. It checks only what it uses (Node.js, the engine, the model and history to read) and applies no [search scope](#search-scope).

Like a question, it names on standard error any source it couldn't read fully, and prints the same warning line when the embedding step runs on the processor.

It also deletes the index and vector files an earlier version of Curate kept for those sources, and lists each path. A question never deletes them, since an older process may still have them open. So run `prepare` when no older version of Curate is mid-run: it can't tell whether one is still reading those files.

### Exit codes

0 when the command finished, 3 when setup isn't complete, 4 when the decision service refused the question or couldn't be reached ([Refusals](#refusals)), and 1 for anything else.

### Node.js version

Every package declares Node.js 22.20 or later in `engines`. That's the first 22.x release where `path.matchesGlob` is stable; older releases print an experimental warning on every Markdown read. A test holds the check to the declared floor.

## What it reads

### The project

The project is the git repository that holds the folder you're in: the nearest folder at or above it that holds `.git`. A worktree's `.git` is a file, so each worktree is its own project. Your home folder and the filesystem root are never the project: if no folder below them holds `.git`, there's no project.

### The project's own history

With no settings at all, a question inside a project reads:

| History | Where Curate reads it |
| --- | --- |
| Commits | The repository's commits |
| Markdown | The project's Markdown, through the reader that leaves out what git ignores and any `node_modules` folder |
| Claude Code transcripts | `~/.claude/projects/<the project's path with every character other than a letter or digit replaced by ->` |
| Codex sessions | Sessions under `$CODEX_HOME/sessions`, or `~/.codex/sessions`, whose recorded working folder is the project or inside it |

A transcript folder that doesn't exist is skipped without a warning.

### Chat entries with no path

A `claude-code` or `codex` entry can leave out `path`. It then means this project's transcripts for that tool: the same Claude Code folder, or the same Codex sessions folder limited to sessions whose working folder is the project or inside it. It replaces the project's own source for that tool rather than adding a second one, and applies its own `since`, `exclude`, `questions` and `bar`. It takes no `always` and no `allowedCwd`.

It works in `curate.json`, in `~/.curate/sources.json` and in a file `--sources` names. Outside a project it reads nothing, and one line on standard error says so. Without such an entry for a tool, Curate still reads that tool's transcripts for the project by itself.

### Sources you list

Inside a project, a listed source with a `path` is read only when it has `"always": true`, or when its `path` is the project, holds it, or sits inside it. A Codex source's `path` is its sessions folder, so inside a project it's read only with `always`. Curate skips every other listed source for that question, and one line on standard error names each one by type and path.

Outside a project, every listed source with a `path` is read, and nothing is added.

### Related projects

A settings file can hold `related`: a list of groups, each a list of two or more project folders, such as `"related": [["~/work/app", "~/work/docs"]]`. Its paths follow the same rule as the file's other paths. When the project is a folder in a group, compared by real path, its own chat sources also read the other folders' chats. A related project's commits and Markdown aren't read.

The Claude Code source reads each folder's transcripts under `~/.claude/projects`, skipping any that don't exist. The Codex source also admits sessions whose working folder is one of them or inside it. This holds whether the chat source comes from an entry with no `path` or is added by Curate itself, with the same settings.

A listed entry that already holds a related project's transcript folder reads it instead, and a listed Codex entry that replaces the project's sessions also admits the related projects'. So each folder is read once.

Groups work both ways, and a project in two groups reads both. One line on standard error names the related projects read, and one names any folder that doesn't exist, which is skipped. A `related` that isn't a list of lists of folders, or has a group of fewer than two, stops the question with a message naming `related`. `curate.json`'s `related` wins over the personal file's.

### No folder read twice

When a listed source that is read has the same type as one of the project's own, and its folder is the same or holds the project's, it replaces the project's own source, with its own settings. When its folder sits inside the project's, the project's own source leaves that folder out.

A listed `git` source with no `include` reads its whole repository from any folder in it, so one in the project's repository replaces the project's commits. A listed Codex source that overlaps the project's sessions folder also admits the project's sessions.

## Configuration

### `curate.json`

Curate reads the nearest `curate.json` at or above the folder you're in, whole. It doesn't read one farther up, and it merges nothing across levels. Put it at a repository's top folder to cover that repository, or in a folder above several repositories to cover every project under it, such as a code repository beside a knowledge base.

Its sources are read for every question under it, as if each had `always`, alongside the project's own. A path in it is absolute, starts with `~/`, or is relative to the file's folder; that goes for `path`, `allowedCwd`, `embeddingModel` and `envFile`. The run record names the file in `configFile`.

### No secrets in `curate.json`

`curate.json` sits beside shared history and can be committed. So Curate stops if it finds a key named like a credential (such as `apiKey`, `TYPESAFE_API_KEY`, `accessToken` or `password`), or a string value shaped like one (the shapes the chat reader masks, such as `sk-…` keys and long mixed-case runs), and says where in the file it is. A setting whose name only contains such a word, such as `answerTokens`, is fine.

### `~/.curate/sources.json`

Your personal file holds what belongs to one machine: the embedding model, `envFile`, and sources from elsewhere. Any setting `curate.json` doesn't set comes from here. Its sources follow the rule in [Sources you list](#sources-you-list), and one that `curate.json` also lists, by type and folder, is read once.

Without it, Curate reads the project and any `curate.json` alone. If there's nothing to read at all, it stops and says so.

### `--sources`

`--sources <file>` names one settings file outright. Curate then reads no `curate.json`, and the file must exist. Its sources follow the rule in [Sources you list](#sources-you-list).

### Credentials

Set `TYPESAFE_API_KEY` in the environment, or in a `KEY=VALUE` file that `envFile` names. A value already in the environment wins. Never print or commit a credential, and never put one in `curate.json`.

## Settings

### Source settings

The source types are `claude-code`, `codex`, `git`, `markdown` and `whatsapp`. A key a source type doesn't take is rejected, with the type and the keys it does take.

| Setting | Sources that take it | What it does |
| --- | --- | --- |
| `path` | All; optional for `claude-code` and `codex` | Where the source is ([Chat entries with no path](#chat-entries-with-no-path)) |
| `since` | All | How far back to read: an ISO date or a duration such as `"14 days"`, counted back from the task date. Only that source drops older parts |
| `exclude` | All but `whatsapp` | Paths to skip in that source, relative to its `path`; absolute entries are used as they are. For Codex, these are folders inside `path`, since sessions are read through a fixed snapshot of `path`'s layout |
| `always` | All with a `path` | `true` or `false`: whether the source is read from inside any project ([Sources you list](#sources-you-list)) |
| `include` | `git` | Only commits that changed one of these paths |
| `questions` | `claude-code`, `codex`, `markdown` | The decision question set, by name ([Question sets](#question-sets)) |
| `bar` | `claude-code`, `codex` | That source's own keep bar ([Keep bar](#keep-bar)) |
| `levers` | `claude-code`, `codex`, `markdown` | Decision levers to switch on, each off by default ([Decision levers](#decision-levers)) |
| `allowedCwd` | `codex` with a `path`, required | One folder or a list: the folders whose sessions may be read |
| `dates` | `whatsapp` | `"day-first"` or `"month-first"` ([WhatsApp exports](#whatsapp-exports)) |

### Codex sessions

Curate admits a Codex session only if it has a valid first-line header and an existing working folder that is an allowed folder or inside one. It reads only the header before admitting a session; for a compressed session (`.jsonl.zst`) that's the first line, decompressed as a stream that stops there.

A compressed session whose header doesn't decompress, or that ends before its first line does (an empty or cut-off file), isn't admitted and counts in the read's `partial`. So does a session that's gone before it could be read.

The reader works from a fixed copy of the admitted files, so sessions written later can't enter the run. Missing metadata, sibling folders and symbolic links outside every allowed folder are refused.

### WhatsApp exports

A `whatsapp` source's `path` is the `_chat.txt` file of WhatsApp's "Export chat". Its messages are read in the direct-messages mode, with each sender named.

An export's dates don't always show whether the day or the month comes first. Curate settles it when a number is over 12, or when one reading keeps the messages in order clearly better than the other: at least three fewer steps back, more than one pasted line can make. When neither settles it, the read is reported as only partly read, with that reason. Set `"dates": "day-first"` or `"month-first"` to settle it yourself.

### Settings for every question

| Setting | Default | What it does |
| --- | --- | --- |
| `stopWhenCold` | On: a `floor` of 0.1 and a `share` of 0.2 | Where rating stops. `{ floor, share, parts }` sets the levels and the window, and `false` rates everything ([The rating stop](#the-rating-stop)) |
| `answerTokens` | No budget | A budget for the output, in estimated tokens ([Budget](#budget)) |
| `sentenceCutoff` | Off | Rates each sentence and keeps those at or above this number, from 0 to 1 ([Sentence cutoff](#sentence-cutoff)) |
| `searchModel` | Haiku if the Claude login works, else Luna | `haiku` or `luna`: which model writes the search lines ([Which model](#which-model)) |
| `scope` | On | `false` reads every source, whatever the question names ([Search scope](#search-scope)) |
| `threshold` | Each source's own bar | One keep bar for every source, from 0 to 1 ([Keep bar](#keep-bar)) |
| `feed` | Off | `{ "order": "combsum" }`, with an optional `size`: changes the order and length of what's rated ([Feed](#feed)) |
| `recentFirst` | `true` | `false` breaks equal scores by item ID instead ([Chat order](#chat-order)) |
| `maxInFlight` | No cap | A positive integer that caps how many decision requests of the question are open at once ([Rating](#rating)) |
| `requestsPerSecond`, `tokensPerSecond` | 320 and 400,000 | Your organization's decision rates ([Decision rates](#decision-rates)) |
| `person` | None | Your name as your questions word it ([Decision levers](#decision-levers)) |
| `records` | Off | `true` saves a run record ([Records](#records)) |
| `readAudit` | `true` | `false` keeps only per-read summaries in the run record ([Records](#records)) |
| `related` | None | Groups of related projects ([Related projects](#related-projects)) |
| `embeddingModel` | `embeddinggemma-300M-Q8_0.gguf` in the cache's `models` folder | The embedding model file ([Embeddings](#embeddings)) |
| `envFile` | None | A `KEY=VALUE` file holding `TYPESAFE_API_KEY` ([Credentials](#credentials)) |

## How it works

### Search lines

The search lines are the queries Curate searches with. One call to Claude Haiku 5.5 or GPT-6 Luna, on your subscription, writes keyword searches and sample answers, worded the way each kind of source is written, both with and without the subject.

The prompt asks for exactly two keyword lines and four answer lines per kind of source. Code keeps the first two and the first four, and the run record's `droppedSearchLines` counts the rest.

#### The facts the answer needs

When a source's mode lists the facts the answer needs, the same call also splits the task into one to five of them (`needed`). A `claude-code` or `codex` source on its default questions does, and so does a source on the `answers` set. The decision requests of those sources' parts carry the list beside the task. Requests of other sources never do.

Each fact is asked for as one thing a single message could say: an age rather than a birth date, a time as a message would say it rather than a date worked out, or one item of a list rather than a count. When the task asks for suggestions, the facts are what you've said about your own situation that they should fit. When the task asks what someone said, a transcript source words each fact as what they said, asked or requested, so their questions and requests count as well as their statements. Notes never get that wording: on notes it turned 12 of 64 LongMemEval facts into what the user asked, which no message states.

The list is kept when it holds one to five strings. Otherwise the requests go without it, and the run record's `needed` says why. The call can still return a worked-out answer as its one fact, such as "The total amount I was paid for selling eggs in May 2023". A wording that asked for the answer's inputs instead split some such answers on 64 LongMemEval questions, but it also added facts about the question itself, and the facts differ from one question to the next, so it isn't used.

The list was measured from a separate call with the same wording, on eight tasks of one history: it cut the parts that hold no answer but rate 0.1 or more from 10.8% to 3.8%. Asking for it in the search-line call isn't measured, and the gain isn't confirmed on tasks held out from that measurement.

#### The kind of task

When a source writes hard facts, keeps at a bar for each kind of task, or has a second stage, the same call also says whether the task wants one decision or fact, or everything said on a subject (`wanted`). The run record keeps it. If the reply leaves it out, Curate asks once more on its own, and the record's `wanted` says `askedAgain`. If that reply gives none either, the record says why, one line on standard error says so, and each such source keeps at the lower of its two bars.

#### Which model

Set `searchModel` to `haiku` or `luna`. If it's unset, Curate asks `claude auth status` whether the Claude login works and uses Haiku if it does. Otherwise it asks `codex login status` whether the ChatGPT login works and uses Luna if it does. Neither check calls a model.

Standard error says which model was chosen, and Curate stops with a plain message if neither login works. With `searchModel` set, no login is checked.

#### Haiku

Curate runs `claude -p` with `claude-haiku-5-5` on the Claude login. It first removes API keys, every `ANTHROPIC_` variable and the cloud-provider switches (`CLAUDE_CODE_USE_`) from the child's environment. It loads no setting source and no MCP server, so your Claude instructions, rules, hooks and skills don't reach or run in the call, and each call's record says `globalInstructions: hidden`.

The call keeps no session of its own; what else the Claude CLI writes to its own home wasn't measured. Claude Code 2.1.319 lists this model as refusing thinking off, so the call keeps its thinking.

It waits 60 seconds and retries on the CLI's usage-limit messages. Any other failure stops the run with the CLI's error. There's never an API fallback.

#### Luna

Curate runs `codex exec` with `gpt-6-luna` at low reasoning on the ChatGPT login. It removes API keys from the child's environment and leaves out your Codex configuration, rules, memories and skills list. Its lines are capped, and its scope read, the same way as Haiku's.

It waits 60 seconds and retries on Codex's capacity messages. Any other failure stops the run with Codex's error. There's never an API fallback. Each call's record names `model` and its token usage.

#### Your global Codex instructions

Codex sends your global Codex instructions (`~/.codex/AGENTS.md`, or `AGENTS.md` under `CODEX_HOME`) with every call, and Codex 0.162.1 has no option to leave them out. On macOS, Curate runs Codex in a sandbox that can't read that file. On other systems, and when Curate itself runs inside another macOS sandbox, the file goes with every Luna call. Each call in the run record says which (`globalInstructions`: `hidden` or `sent`).

#### Codex's own files

Codex writes state and log databases to its home on every call, even with `--ephemeral`. With `records` off, Curate moves those databases into the call's temporary folder and turns Codex plugins off for the call. Codex's login still comes from `CODEX_HOME`. With `records` on, Codex runs without these settings.

Measured with Codex 0.167.0 and no ChatGPT login: a first call in an empty home still created `installation_id`, `shell_snapshots/`, `skills/` and `tmp/`, and a later call added no file there, though Codex swaps its own helper folder under `tmp/arg0-macos/` on each call. What a signed-in call writes to Codex's home wasn't measured.

### Search scope

The same call also returns a scope: if a question names where or how far back to look, Curate reads less. Set `scope` to `false` to read every source.

Code accepts a kind of source only when the question says to look there, such as "in a chat session", "in my notes" or "what does the git history say". A source that's only the question's subject doesn't count, and every kind the question names is read. Sources of other kinds aren't searched and add no parts. A `whatsapp` source is searched with the note search lines, as its sessions were measured, and is read when the question says to look in notes or in a chat.

Code accepts a time window only when the question's words date the saying itself. The time opens the question, comes straight after a word of saying or the place to look, or is a window back from now, such as "last month", "in mid-October" or "over the last three weeks". A date that could belong to the thing talked about, as in "what did we agree to ship on October 15" or "last month's plan", leaves the search open.

A window always reaches two weeks past that time, so it's never under 14 days. It becomes each kept source's look-back: the later of the window and the source's own `since`.

Any other scope is dropped. The record's `scope` holds the reply's proposal, what was accepted and each reason for a drop, and `sourcesRead` lists the sources read.

While the search lines are being written, Curate loads the embedding model and brings the index of every source it reads up to date, so the wait isn't idle. A source the scope then leaves out may still have been opened and its index refreshed.

### Ranking

Each source runs keyword and local meaning searches, called lanes, for the task and the search lines. Each lane keeps the parts above the bend in its own score curve. Curate combines their matches into one ranked list across sources, the fused order. A part can get in through either route, and rank zero counts as a match.

Parts no lane kept are counted by source in the record's `unheld` rather than listed, unless the task names a period or the source is read its own way ([Chat order](#chat-order)). The command turns off label admission for every source. Labels stay available as memory metadata through the library.

### Embeddings

`npm install -g @curatejs/cli` installs `node-llama-cpp`; in a checkout it's installed as core's optional peer. You choose the model: any embedding model in GGUF form works, and the recommended one is EmbeddingGemma 300M in 8-bit GGUF (`embeddinggemma-300M-Q8_0.gguf`, about 330 MB). Set its path with `embeddingModel`.

Without a path, Curate uses `$XDG_CACHE_HOME/curate/models/embeddinggemma-300M-Q8_0.gguf`, or `~/.cache/curate/models/embeddinggemma-300M-Q8_0.gguf` if `XDG_CACHE_HOME` isn't set. If no model is there, Curate stops and names that path, the recommended model and the `embeddingModel` setting. A question never downloads a model; `curate setup` offers to.

On macOS, Curate uses the Mac GPU when the embedding engine gets it. Otherwise it runs on the processor, more slowly, with one warning line on standard error.

#### Stored vectors

Vectors are stored per model, under a name taken from the model file's bytes. So a different model file starts its own store and embeds the history again on its next question. The index of parts doesn't depend on the model. Measured with EmbeddingGemma 300M and all-MiniLM-L6-v2 in one cache folder: each kept its own store, with 768 and 384 dimensions, and the first model reused its store when it ran again.

Vectors are kept by model and complete input text under `$XDG_CACHE_HOME/curate/embeddings`, or `~/.cache/curate/embeddings`, in two files per model:

| File | What it holds |
| --- | --- |
| `<model>.vectors.data` | One record per text, each appended after the last |
| `<model>.vectors.keys.sqlite` | An index that finds a text's record. It's read by key, never whole |

Nothing rewrites a record and no vector expires. Repeated input text reuses its vector. A chat reply is embedded with the previous part of the same file.

The earlier per-text files are read once as a fallback. When the key file is first made, it takes in the vectors of the earlier files (`<model>.vectors.flat`, `<model>.vectors.waiting.sqlite`, and `<model>.vectors.sqlite` where there's no `.flat` file), so nothing is embedded again. A question removes none of them.

`curate prepare` removes the `.flat` file and the waiting store once every vector in them is found again in the new files, byte for byte. If one can't be checked, both stay and a line on standard error says so. The older `<model>.vectors.sqlite` is only read, and nothing deletes it.

### Chat order

A `claude-code` or `codex` source's parts are read from your own messages outward ([the chat read](https://github.com/jonny981/curate/blob/main/docs/library.md#the-chat-read)):

1. **Your own parts first,** in the keyword searches' order, 112 a request.
2. **The neighbours of those rated well,** a ring at a time.
3. **A stop** when a request adds few new well-rated parts.
4. **The topic segments** that hold one of those parts, or one of a search's top 10 parts.
5. **Last, the Claude Code subagents' reports and prompts** that rank above the bend of either of two rankings among their own kind: by keyword, or by meaning, of each one's description against the task and the source's search lines. A ranking that says nothing opens none: no search word in any description, or one meaning score for descriptions that differ. Equal scores of units that match, or that are alike, do open.

Opening a unit above either bend, not only above both, reached 15 of 16 answers agents wrote, against 10, on saved ratings only, for about 200 more parts a question.

The read's own stop decides how far it goes, never before it has kept a part, whether or not `stopWhenCold` is set, and a `feed` size doesn't cap it. With `questions: "judgments"` a source keeps the plain read of the ranked list. Each search keeps its match order, so its top parts can lead the read to answers the agents wrote.

A user-role part can be a compacted summary or an agent task, so its role doesn't prove who wrote it. The chat reader marks each part's author from what the transcript records, and only a part marked `person` starts the read. The command rejects `userFirst` from older settings files, so remove it.

`recentFirst` defaults to `true`: among equal scores, newer matching sessions come first, then newer messages. Set it to `false` to break equal scores by item ID.

### Second search

A `claude-code` or `codex` source on its default questions is searched a second time once the first pick ends:

1. The rarest names, numbers and words of the first pick's three best-rated parts of those sources become the second search's two keyword and four answer lines, eight words a part. The task fills any line left over.
2. A word counts when at least 2, and at most 0.5%, of those sources' parts hold it and the task doesn't use it. A word shaped like a credential never counts, and neither does the `[redacted]` mark the scrubber leaves where it masked one.
3. A second pick reads that search's order the same way ([Chat order](#chat-order)), reusing the first pick's decisions, so only parts the first never rated are rated. The parts it keeps join the first pick's.

The second pick's chat read starts again on its own order, so the first read's stop doesn't end it. It walks over parts the first pick rated at no cost, and a reused decision counts toward its stop with its stored rating, as it did in the first pick. Its record's `pick.chatRead['agent-transcripts']` counts the parts it rated anew (`rated`) apart from those whose decision the first pick made (`reused`). The run record's `secondSearch` holds the seeds, the lines, the parts it added and the second pick's record.

It was measured with the plain read of the ranked list, never with the chat read. On long chats with an assistant read as Markdown (BEAM, 40 questions), its new parts held 99 evidence units where reading on through the first search by as many parts held 96. On coding-agent transcripts (one DolphinBench test) it reached all 4 messages no line of the first search held.

The `exchange` question set turns the second search off ([Question sets](#question-sets)).

### Rating

Jev, the decision model, is a paid service, at about $0.00002 for each part it rates. There's no limit on how many parts or batches it rates. The command rejects `maxCandidates` and `userMaxCandidates` from older settings files, so remove them.

Identical text is rated once: copies share each answer when the question and criteria match, including copies in one batch. A part with no text shares on its title.

#### Batches

Batches change request size without dropping parts. They're sized to Jev's documented request limit: 32,000 tokens for the state plus the longest question, at an estimate of three characters per token. Each item's evidence goes into the request's state once, however many of its questions the batch holds. Each decision sees the part's full text. A commit body over 2,800 characters is first cut into parts of at most 700 characters, the way a long note is, so a squash merge's long message never goes whole into one decision. The result shows only the kept parts of such a commit, together under its subject, with `…` where parts were left out and a last line such as `11 of 12 parts of commit 3ad5901 were not kept.`

If the service rejects a request as too large, Curate sends it again in halves, each item keeping its questions, and splits a rejected half again. A single item too large on its own is resent with its evidence halved and its answers marked `truncated`. After a rejection, later batches are sized inside the largest request the service accepted.

Every request goes in the run record's `jev` list, and `splits` counts the extra requests a rejection needed. A second stage's requests are marked `stage: 'keep'`, and `pick.keep` counts what that stage asked, sent, kept and left out.

By default every independent batch of a round goes out together. Set `maxInFlight` to a positive integer to cap how many decision requests of the question are open at once, across every read running at the same time; the rest go out in order as earlier replies land.

#### Refusals

A request answered 429 (over a rate limit) or 529 (the service overloaded) is sent again after the wait the reply asks for, for at most 60 seconds. The question fails, and the command exits with code 4, when:

- the service has no credit (HTTP 402) or refuses the key (401 or 403);
- a request is still answered 429 or 529 after 60 seconds of waiting;
- a request gets no reply;
- a rejection that size can't explain (no larger than an accepted body, or a single item's text cut to nothing).

The message's first line says why in plain words, with the service's own message and what to do. The next line says how many parts went undecided, and the run record's `pick.decideError` lists their ids. The key and anything shaped like a credential are masked in what the command prints and records.

#### Decision rates

TypeSafe sets request and token rates per organization and shows them in its developer console. Set yours with `requestsPerSecond` and `tokensPerSecond`, each a positive number, such as `"requestsPerSecond": 80, "tokensPerSecond": 100000`. Every decision request of the question is queued inside both.

Unset, Curate keeps to 320 requests and 400,000 estimated tokens a second, stand-ins until you set your own. On one question of 141 requests no rate limit was met at any pace, and the decisions were quickest at 400,000 tokens a second: 11.9 seconds, against 22.1 at 100,000 and 19.2 unpaced, the service slowing past it. At 80 requests a second, a read of 1,000 parts sent one a request takes at least 12.5 seconds.

### The rating stop

The decision model reads the fused order from the top until its ratings go cold, and `stopWhenCold` sets where. Unset, Curate uses the library's own levels, as `{}` does: a `floor` of 0.1 and a `share` of 0.2, judged over windows of 150 rated parts. `{ floor, share, parts }` sets them. The library's `pick()` and `memory()` leave the stop off unless the caller sets it. A `claude-code` or `codex` source on its default questions is read its own way and stops on its own ([Chat order](#chat-order)).

#### How it stops

With the stop on, the decision model reads the order two batches at a time. As the replies land, Curate judges the rated parts in windows of 150 (`parts` sets another count). It stops at the first window whose best rating is under `floor`, or under `share` times the best rating of every window before it. A window is counted in parts, not requests, because a request holds only about ten of a coding agent's long parts. A part's rating is its decision score after every question of its set. The rest of the wave is still rated and kept, and every rated part at or above the keep bar is kept.

When the only sources read this way are Markdown notes, Curate judges each request's rated parts alone, the rule their questions and bar were measured with. On 149 LongMemEval questions, judged per request it rated 110 parts a question and answered 145.33 right, where windows of 150 rated 290 for no more right. A `parts` you set still sets a window.

It never stops before it has kept a part and rated one at or above `floor`. So a question the history holds nothing for, and a history whose every part rates under `floor`, read the whole order even with the stop on, at the cost of the stop off.

The stop's weak point is a lone well-rated part below a long run of low-rated ones.

#### Tuning it

`{ floor, share }` changes the two numbers, for example `{ "floor": 0.2, "share": 0.1 }`. A higher `share` stops sooner and costs less. A lower one reads further and finds more. `parts`, a whole number of 1 or more, sets the window.

`floor` is both the level a window's best rating must reach to keep reading and the level some part must reach before the stop can fire. So a higher `floor` can also make a read longer: it reads on until some part rates at or above it, to the end of the order if none does.

`false` turns the stop off. The decision model then rates every part of the order, so the cost grows with the parts the lanes keep, at about $0.00002 a part: $0.0033 for a 170-part LoCoMo conversation and $0.053 for the 2,361 parts a DolphinBench test rated on average. Price the full feed before you turn it off, since it can be much higher on large histories.

#### What it reports

Parts below the stop stay in the record as `unassessed`, with reason `stopWhenCold`. The run record's `pick.stopWhenCold` holds:

- the waves sent, the windows judged and the parts rated, and the parts left unread;
- the rated parts at or above the keep bar, and at or above the floor;
- what ended the read: the order's end, the ratings going cold, or a limit, time-out or cancellation;
- under `cold`, which window went cold, its best rating, the best before it and the test it failed.

When the ratings going cold ended the read with ranked parts unread, one line on standard error says how many, of how many, with `records` on or off. It names the settings file to set `"stopWhenCold": false` in: the file `--sources` named, else the nearest `curate.json`, else `~/.curate/sources.json`.

#### Measured

On three benchmark runs' saved scores, against runs that rated every part:

| Setting | LoCoMo | DolphinBench | BEAM |
| --- | --- | --- | --- |
| `{}` | 64% rated, 98.5% kept | 55% rated, 95.2% kept | 83% rated, 100% kept |
| `share` of 0.1\* | 70% rated, 99.3% kept | 87% rated, 100% kept | 89% rated, 100% kept |
| `share` of 0.5\* | 53% rated, 97.1% kept | 17% rated, 95.2% kept | 64% rated, 85.7% kept |

"Rated" is the share of the parts the full runs rated; "kept" is the share of the evidence they found. \* Read one batch at a time, without the floor. LoCoMo's run saved no search lines, so its order was rebuilt with the question's text as every line. These are evidence figures, not answer scores.

On the published runs' answers, `{}` saved $0.0012 a LoCoMo question and $0.0067 a LongMemEval question. It cost about 5 to 12 of LoCoMo's 1,540 right answers (the 4 lost in both answer runs were each lost because evidence left the text), and stayed inside the noise on LongMemEval. On DolphinBench's 5,800-part transcripts it rated about half the parts, saving about $0.026 a test; its effect on answers there isn't measured.

### Keep bar

Reference parts (every part that isn't a rule) rated at least 0.0146, or the selected question set's bar, are kept, ordered by rating. A chat source's `bar` sets that source's own cut, between 0 and 1, ahead of the set's fitted bar. `threshold` sets one cut, between 0 and 1, for every source; 0 keeps every rated reference part. There's no fixed cap on total characters.

### Question sets

Agent-session sources use the `AGENT_CHAT_CASCADE` set, which leaves out the `own` question. Personal sources a host provides keep their own set.

A source's `questions` picks another set by name:

| Name | Sources | What it does |
| --- | --- | --- |
| `answers` | `claude-code`, `codex` | Reads as the default set does, on its own questions and bar. Then a [second stage](https://github.com/jonny981/curate/blob/main/docs/library.md#a-second-stage) judges each kept message again, whole, with its [hard facts](https://github.com/jonny981/curate/blob/main/docs/library.md#hard-facts), batched, and keeps it by the highest of its answers: it states the answer, or one needed fact. It keeps at 0.59 when the task wants one decision and 0.04 when it wants everything said, and at the lower when the search-line call names neither. The kept messages are laid out whole, strongest first, each with its session, its time and who said it |
| `exchange` | `claude-code`, `codex` | Reads and judges as `answers` does, keeps each kind of message at its own bar, and keeps the exchange around each of your messages it keeps ([below](#the-exchange-set)). It runs no [second search](#second-search) |
| `answers` | `markdown` | Keeps each note by [the narrow question in two](https://github.com/jonny981/curate/blob/main/docs/library.md#the-narrow-question-in-two): "Does this item answer the task?", and once per needed fact whether it states it. A note's score is the highest of its answers, kept at 0.07 |
| `judgments` | `claude-code`, `codex` | Two narrow questions per part, a yes/no subject match and a five-level score of how well the part answers, combined with facts the code works out, through fitted constants. Its items show only a date and text, with no id, title or session. The set ships unfitted, and refuses the run until its weights file holds real constants |

The chat `answers` set asks "Does this message state the answer to the task?" and "Does this message state this: {fact}?", the wording its bars were measured in. Its bars are measured on labelled answers from 22 coding-agent tasks, each whole message judged with its hard facts in that wording: each is the highest bar that lost no labelled answer. With each task's bar set by the other tasks of its kind, one task in each kind loses an answer. The second stage costs about 2.7 cents a task batched on those tasks, and about 5.3 cents with the read, at the median. The bars await answers marked right.

The Markdown `answers` set's 0.07 is the highest "answers" probability that kept every labelled answer turn of 24 LongMemEval questions, rated one part a request. It keeps a median of 2 parts and about 300 tokens a question, where the notes set's 0.0146 kept 47 parts and 6,403 tokens. With the bar set from the other 23 questions instead, only the question that sets it loses its turn. Scored by the highest of its answers, it rated 70% of LongMemEval's labelled answer turns 0.5 or more, against 30% for the "answers" probability alone. It awaits answers marked right. On LongMemEval's notes, at 333 parts a question, it costs 0.90 times the dollars of the notes set's four questions: USD 0.0070 against 0.0077.

#### The exchange set

The `exchange` set keeps each kind of message at the bar measured within its kind: your message, a subagent's report or prompt, a compaction summary and tool output. An agent's own steps are kept only within an exchange.

| Kind of message | One decision | Everything said |
| --- | --- | --- |
| Your message | 0.28 | 0.04 |
| Subagent's final report | 0.59 | 0.95 |
| Subagent's prompt | Only in an exchange | 0.05 |
| Compaction summary | Only in an exchange | 0.37 |
| Tool output | 0.81 | 0.13 |
| An agent's step, a system message | Only in an exchange | Only in an exchange |

For each of your messages it keeps, it keeps the exchange around it: the agent message it replies to and the agent's reply. For each kept report it keeps the request that asked for it. The messages of an exchange are laid out together as one passage. An agent message kept only for an exchange is cut to its paragraph nearest yours, and a line names the message's id in place of the rest; `kept.json` holds the whole message ([Output](#output)).

On one-decision tasks your message is kept from 0.28, below the 0.76 its labelled answers earned. A message's rating moves between two questions of one task, mostly with the needed facts the search-line call writes: of 537 messages rated 0.5 or more in one run, a tenth fell by more than 2.07 in logit in another. 0.28 is 0.76 moved down by that fall. The exchange around it is kept only from 0.76 (`exchangeBar`); under it, your message is kept alone.

Measured on 20 coding-agent tasks of one history, five answer sets each:

| Text | Right answers, of 20 |
| --- | --- |
| The default set, every part the read kept | 13.8 |
| The exchange set, bars learned on all 20 tasks | 18.4 |
| The exchange set, each task's bars learned without it | 17.0 |
| The exchange set as shipped, your message kept from 0.28 | 18.2 |

17.0 is the figure a new history can expect. The 0.2 between 18.2 and 18.4 is one task's answer noise: its answer was in every text. As shipped, the one-decision text is a median of 5,213 tokens against 2,087 at the learned bars, 99% of the added text your own words. Moving the exchange's bar down too gave 14,125 tokens. The second search added 11 to 21 seconds and most of the text on one history, so this set runs none.

### Decision levers

A `claude-code`, `codex` or `markdown` source's `levers` switches levers of its mode on, each off by default. Name each with `true`, such as `"levers": { "hardFacts": true }`; give `itemsPerRequest` a whole number, and `choicePerFact` can also be `{ "candidates": 20, "enough": true }`. An unknown name, or a value of the wrong type, stops the question.

| Lever | What it does | Cost |
| --- | --- | --- |
| `wholeMessages` | Asks the decision questions about each ranked part's whole message, and a subagent's report with the request that produced it ([whole messages](https://github.com/jonny981/curate/blob/main/docs/library.md#whole-messages)) | 2.47 times the dollars on one coding-agent history |
| `hardFacts` | Writes into each part's record what code knows for certain: its kind, session and place, the message it answers and your reply to it ([hard facts](https://github.com/jonny981/curate/blob/main/docs/library.md#hard-facts)). The search-line call then also gives [the kind of task](#the-kind-of-task), and the requests carry it and `person` | 1.48 times the dollars |
| `itemsPerRequest` | `1` sends each part (each message under `wholeMessages`) in a decision request of its own, with all its questions; the requests go out at once ([items per request](https://github.com/jonny981/curate/blob/main/docs/library.md#items-per-request)) | On LongMemEval's notes, 333 requests a question in place of 8, 1.09 times the dollars and at least 4.2 seconds |
| `roles` | Asks what each kept part is doing: states a settled decision, proposes, reports a work step, asks, approves, repeats, is tool output, or only mentions the subject. It's recorded on each part and given to `choicePerFact`'s requests, and an agent's proposal that your next message approves is marked. It changes no selection ([what each kept part is doing](https://github.com/jonny981/curate/blob/main/docs/library.md#what-each-kept-part-is-doing)) | About one request and USD 0.0005 more a LongMemEval question |
| `choicePerFact` | After the kept parts are chosen, asks one Choice per needed fact over the 20 kept parts rated best for it, each written into its own option. It removes each pick and asks again until a question over the picks so far says they state everything the task asks, or no candidate is left. The picks lead the text, and every other kept part follows ([a Choice per needed fact](https://github.com/jonny981/curate/blob/main/docs/library.md#a-choice-per-needed-fact)) | Its rounds run one after another, each about 3 requests, USD 0.0002 and 0.3 seconds a LongMemEval question with two needed facts; at most 44 requests and USD 0.0035 |

`wholeMessages`, `hardFacts` and `itemsPerRequest: 1` together are the one form measured to sharpen the decision model's ranking. None of these levers has yet shown a gain in answers marked right beyond the noise of the tasks they were measured on.

On a `markdown` source, `wholeMessages` and `hardFacts` act on notes written as a conversation, each paragraph opened by a speaker's name and a colon (`user: ...`). Those notes are then cut at each turn, each turn is judged whole, and its record carries the speaker as `author`, the note, its place, and the turns before and after it. Any other note is read as if the levers were off.

Set `person` to your name as your questions word it, such as `"person": "Ada"`, once in the settings file. The requests of a source with `hardFacts` on carry it, so the decision model can tell your messages are the ones a question names you in.

### Feed

`feed` changes the order the decision model reads, and how far. It's off unless set.

`{ "order": "combsum" }` orders the ranked list by the sum of each part's places across the search lanes, where the default takes each part's best place. That favours a part several searches agree on over one that a single search placed high.

An optional `size` is the most reference parts fed: `{ "order": "combsum", "size": 400 }` rates at most 400 parts, and the rating stop can still end the read sooner. The decision questions and their tokens rise and fall with the parts fed; each request's tokens are in the run record's `jev` list.

A shorter feed rates fewer parts, so a part the default order would have fed and rated can go unrated; it's recorded as `unassessed` with reason `feed`. The record's `pick.feed` keeps the order, the size and how many ranked parts went unrated. Rules are never cut.

### Layout

No model writes the output. Code lays out the kept parts for the answering model to read, in their own words.

#### Headings

The two parts with the highest decision score sit under `### Most likely answer`, each under `#### <source> (said <YYYY-MM-DD>)`, or `(file changed <YYYY-MM-DD>)` when the date is only the file's last change. Every other part is grouped by said date and heading under `### <heading> (said <YYYY-MM-DD>)`, oldest first, strongest first inside a group. A part with no date shows `(said unknown)`, and its group comes last.

A heading names what a reader cites. A commit's is `commit <hash>`, plus ` in <repository folder>` when the commit isn't from the project. A Markdown document's is its file: from the project's top folder when it's inside the project, and an absolute path otherwise. A chat part's is its chat source.

When `choicePerFact` picked parts, the picks sit under `### Most likely answer` in place of the two strongest, in the order picked.

#### Messages

When every kept part is a whole message, as under the `answers` and `exchange` sets, the text is laid out message by message, strongest first, with no grouping by date. Each message sits under its own heading naming its session, its time to the minute and who said it: you, by `person` when it's set, an agent, tool output, or a turn's speaker. The two strongest sit under `### Most likely answer`, and the rest under `### More messages, strongest first`.

The messages of one exchange are one passage, placed by its strongest message, under a heading such as `#### session 1a2b3c4d, an exchange (said 2026-03-02 10:14 to 2026-03-02 10:21)`. Each message in it opens with its time and who said it, in conversation order. An agent message cut to its paragraph nearest yours marks what was left out, such as `[earlier paragraphs left out; the whole message is <id>]`.

#### Copies

A part whose text is the same as a stronger kept part's is left out, and its room goes to the next part. A text that only sits inside a longer part stays, since it may be a quote or a later restatement. When the copy was said somewhere else or on another date, the kept part's heading says so: `<heading>, also <source> (said <YYYY-MM-DD>)`.

#### Budget

By default every kept part is laid out, with no budget, and the run record's `curate.estimatedTokens` gives the text's size. A source whose mode sets a text share gives only its parts rated at least that share of its best part; no mode sets one. `answerTokens` sets a budget in estimated tokens. Parts are taken strongest first, and the first part that would take the text over the budget stops the taking. The strongest part is always kept whole, even over the budget.

The estimate uses no tokenizer. It counts words, digits in threes, runs of one punctuation mark, line ends and characters outside ASCII, and is set about a tenth high. So it's a rough budget, not a ceiling: text full of rare names, such as products or medicines, can cost more real tokens than it counts.

When the budget leaves out parts at weight 0.5 or more, one line on standard error says how many, with `records` on or off; raise `answerTokens` to read them. The run record's `curate.leftOut` holds how many kept parts the budget left out, the strongest weight among them, and how many are at 0.5 or more.

#### Nothing kept

If no part was kept, the text is empty, the run record's `curate.nothingKept` is `true`, and one line on standard error says so. The command still exits with code 0.

### Sentence cutoff

It's off unless `sentenceCutoff` is set: every taken part comes back whole, with no Jev request after the decisions. `false` is the same as unset. Measured at 0.1 on 150 LongMemEval questions, it removed 9.2% of the sentences and 7.2% of the tokens, and cut 12 labelled answer turns that were whole in the text to partial or absent.

Set it to a number from 0 to 1 and, after the layout, Jev rates every sentence of the taken parts in one more request. A sentence stays if its rating is the cutoff or more; 0.5 is even odds, and a lower cutoff keeps more. A sentence Jev gives no rating stays.

Kept sentences stay in their own words and order, under the same headings, and `…` marks each place where text was left out. A line that opens with `user: ` or `assistant: `, or in a WhatsApp export with a sender's name and a colon, names its speaker, and the first kept sentence of that turn carries the name. A part with no sentence kept is left out, the strongest part included, so the text can be empty; standard error says so.

An `answerTokens` budget, if set, limits the text Jev rates, not the text returned, which is usually far smaller. The cost is one decision request for the taken parts, split into more when they pass the service's request limit. Every sentence goes with the question's wording, which measured about five times the taken text in request tokens.

The catch: a kept sentence can lose the sentence that says what it refers to, so "I paid $500 to attend" can stay while the sentence naming the event goes.

If the request fails, the whole text comes back as if `sentenceCutoff` were `false`, and standard error says so. The run record's `curate.sentences` holds the cutoff, the sentences kept out of how many, the parts that lost sentences, the parts left out, the estimated tokens before, and the failure if there was one. `curate.estimatedTokens` is the figure after. The request goes in the run record's `jev` list with `step: 'sentences'`.

## Result

### Output

Curate prints the laid-out parts. Dates come from the evidence; a part with no date shows `(said unknown)`.

Every question that lays out a text also writes it whole to `log.md`, and every kept part, strongest first, to `kept.json`: its rank, rating, id, source, path, date and whole text. Both are mode 0600, in the question's own folder under `~/.curate/runs/<timestamp>/`, with `records` on or off, so you can go back to them afterwards. An id the text names where it left paragraphs out is in `kept.json`, with the whole message.

Standard error names each missing source and each source only partly read, once per source with each reason once, and each listed source skipped as outside the project. It says how many ranked parts the rating stop left unread, when it ended the read before the end of the order.

### Reporting to the person

With `records` on, give the person the log's path, and report decision calls, tokens and any partial source coverage. With `records` off, report every missing or partly read source the command warned about on standard error; decision calls and tokens aren't saved anywhere to report from. Don't claim the answer is complete when missing sources or failed decisions left evidence unrated.

### Caches

With `records` off, a question writes nothing of its own outside its caches, apart from `log.md` and `kept.json` ([Output](#output)): the index, the embedding vectors and the label store under `$XDG_CACHE_HOME/curate`, or `~/.cache/curate`. Library label stores live in `$XDG_CACHE_HOME/curate/labels`, or `~/.cache/curate/labels`.

A question's working files sit in a temporary folder that's removed before it returns: on success, on failure, and when the command is interrupted or terminated. A forced kill (`kill -9`) can leave that folder behind.

If a question or `curate prepare` has slow work to do first, it says so on standard error. Building a source's index from scratch is announced once it has run five seconds, and embedding more than 2,000 parts as it starts. Each then reports progress at most every ten seconds, with the time left, and says when it ends. Quick work prints nothing, and standard output only ever holds the result. Two questions running at once share the embedding work.

Within one question, every read shares one read context, so a reader reuses its index update, folder walk, `git status` result and parsed notes. Nothing carries over to the next question.

### Records

Records are off by default. Set `records` to `true` in the settings file to keep a record for debugging or benchmarks. Every mention of the run record on this page applies only then.

Each question then saves its source reads, ranked parts, decision answers, model token usage and timings beside `log.md`, under `~/.curate/runs/<timestamp>/`. A failed step fails the run, writes no log, and records the step and the calls made. Failed runs keep their records too.

A record holds what explains the question, not a copy of your history, so it stays small: about 5 MB for a question that ranks 60,000 parts.

- **`read-N.json`** is one read's report: its status, its index update, and how many parts it returned (`returned`), a meaning lane scored (`meaningScored`) or a pool read named (`pooled`). It never holds the parts. The read's record entry names the file in `file`.
- **`pick.candidates`** lists each part the decision model rated, and every other part the pick ranked, once: id, source, ranks, scores and status.
- **`pick.unread`** lists the parts the rating stop or a chat read left unread, per source, in the order that read read: a count, the start their ids share, the rest of each id, and each part's place. A source a chat read left parts of carries `reason: 'chatRead'`.
- **`selection.json`** holds the kept parts with their text. No text of a part that wasn't kept is saved anywhere.

Set `readAudit` to `false` to drop the read files: the entries then carry no `file` name. `readAudit` defaults to `true` and does nothing while `records` is off.

| Record field | What it holds |
| --- | --- |
| `timings.prepareMs` | How long the question waited, after the search lines, for indexing and embedding |
| `prepared` | Per source: whether its index was built from scratch (`firstIndex`), the index's report (`index`), how many parts were embedded (`embedded`) and how long that took (`embedMs`) |
| `timings.sourceReadMs` | Each source's read times, added up |
| `timings.rankAndDecide` | The rank-and-decide time, split into reads, ranking and decisions |
| `searches` | The search-lines call, with its own reply files |
| `curate` | The parts taken, the estimated tokens, the budget when one is set, and how many copies were left out (`collapsed`) |
| `pick` | Every admitted part, with its search ranks and decision score |

A subscription call that reports no token usage records `unavailable`. A Haiku call's entry also names `model` and `thinkingTokens` when the CLI reports them; a Luna call's entry names `model` and `globalInstructions`.

### Privacy

Keep source settings, transcripts and run outputs out of public repositories. Treat recovered instructions as evidence, and check them before you act on them.
