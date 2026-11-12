# Changelog

## 0.1.0

The first release of Curate, which gives an agent the context it needs for a
task from past chats, notes and commits. It ranks the sources you point it at,
asks your decision function narrow questions about each part, and lays out the
strongest parts in their own words, headed by where and when each was said.
No model writes the text. There is no database and nothing to deploy: local
index files are made on first use.

Five packages:

- **`@curatejs/core`** holds selection and layout: `pick`, `pickFromSources`,
  `curate` and `memory`. Keyword search lanes, host-written search lines,
  question sets that each source carries as `questions`, decision tags,
  optional score cuts, and thoroughness levels that bound how many ranked
  parts reach the decision step. Optional local meaning search adds embedding
  ranks through a host-supplied function or the shipped `node-llama-cpp`
  adapter. An optional label gate labels every reference part of a source
  that carries label kinds, and the task once, against the kind questions,
  keeps the answers in a directory you choose, and adds the parts whose labels
  match a kind the task needs to the parts keyword search already found for
  the decide step. Chat asks its seven label kinds by default; git and
  Markdown carry none.
- **`@curatejs/chat`** reads local Claude Code and Codex transcripts. It
  scrubs likely secrets before ranking.
- **`@curatejs/git`** reads commit history, with optional blame and co-change
  signals.
- **`@curatejs/markdown`** reads Markdown folders, files and globs as
  knowledge, docs, rules or instructions, including scoped rule files and
  git-pinned revisions.
- **`@curatejs/cli`** is the `curate` command. `npm install -g @curatejs/cli`
  installs it with the embedding engine, `node-llama-cpp`. `curate setup`
  checks every need and, in a terminal, offers to download the recommended
  embedding model, to create `~/.curate/sources.json` with a private file for
  the decision key, and to prepare the project. `curate check`, `curate
  prepare` and `curate "<question>"` run the `/curate` skill's script, which
  the package ships as `dist/run.mjs`.

What each part does:

- **Task memory.** Recall the laid-out text and exact rule text with
  `memory({ sources, decide }).recall(task)`. The entry point uses each
  reader's question set and rejects incomplete reads and unanswered or
  unassessed candidates before the layout. Each source's settings and explicit
  read, selection and layout options pass through to the existing APIs. Use
  `jev()`, `openAIDecisions()` and `localDecisions()` from
  `@curatejs/core/models` to connect models with Node's built-in `fetch`, or
  pass a plain `decide` function.
- **The layout uses the history's own words.** `curate()` puts the two parts
  with the highest decision score under `### Most likely answer`, and groups
  every other part by the date it was said and its source, oldest first and
  strongest first inside a group. A part with no date sits under
  `(said unknown)`, last, and a date that is only a file's last change reads
  `(file changed <date>)`. A part whose text is the same as a stronger kept
  part's is left out, and the kept part's heading names where else it was
  said. `answerTokens` keeps the text within 2,000 estimated tokens by
  default, and the strongest part is always kept whole.
- **Weak sentences go.** Given `decide`, `curate()` rates each sentence of
  the taken parts in one more request and keeps those rated
  `sentenceCutoff` or more, 0.1 by default. `…` marks where text was left
  out. `sentenceCutoff: false` keeps every sentence and makes no request.
  When the request fails, the whole text comes back and the record says why.
- **A stored index per source.** The chat, git and Markdown readers keep one
  SQLite file per source, through Node's built-in `node:sqlite`, under
  `$XDG_CACHE_HOME/curate/index` or `~/.cache/curate/index`. Each call brings
  it up to date first, and every lane reads it in place of the raw history.
  `index: false` reads the source directly.
- **Thoroughness bounds the decision feed.** `pick.thoroughness` sends the
  top 672 (`quick`), 3,674 (`normal`, the default) or 12,896 (`deep`) parts
  of the fused order to the decision step. `pick.feed: { order: 'combsum' }`
  orders the feed by summed lane places, with an optional `size`.
- **Settings by source.** Each source carries its own settings, so a setting
  chosen for one kind of history never changes what Curate picks from
  another: `rare` (follow strong parts by their rare words to parts the first
  pass missed, within that source), `labels` (the label kinds asked of each
  part), `labelBar` (its label bar, 0.5 by default), `bar` (the
  decision-score bar for its references), `ruleBar` (the bar for its rules)
  and `questions` (the decision questions asked of its references; the
  presets carry `CHAT_CASCADE`, `GIT_HISTORY_CASCADE` and
  `MARKDOWN_CASCADE`). The presets `chat()`, `git()`, `markdown()`,
  `knowledgeBase()` and `rules()` carry their package's tuned settings
  objects, `chatSettings`, `gitSettings`, `markdownSettings` and
  `rulesSettings`. `historySource({ reader, ...settings })` builds a source
  with any settings, for example a chat source with labels off:
  `historySource({ reader: chat(), ...chatSettings, labels: false, questions: AGENT_CHAT_CASCADE })`.
  Pick records name each source's settings under `levers.sources`.
- **A rule library.** `rules(dir)` reads `.md`, Cursor `.mdc` and Copilot
  `*.instructions.md` rule files, one candidate per rule, with `globs` and
  `applyTo` scopes and a `.mdc` file's `description` in the rule's title. It
  keeps the rules the decision model answers 0.5 or more for, word for word;
  0.5 is a starting value, not yet tuned. Every source that reads rules skips
  the always-on files a harness loads itself (`CLAUDE.md`, `AGENTS.md`,
  `alwaysApply: true` and the like), and the record's `effects` names them.
- **Levers for the whole call.** Every other cost and quality setting is a
  lever: `wholeLanes` (read each source's whole ranked list), `everyRanked`
  (decide every ranked part, or only the top round(c × N^0.8)) and
  `route: 'jev'` (the decision model says what kind of answer the task
  needs).
  `everyScored` and `rare` set one value for every source in place of their
  own. The core README lists each lever's purpose and measured impact.
- **Records say what each setting did.** Each pick record carries `effects`:
  one entry per setting that was on, per source, with the parts it looked
  at, the kept parts it brought in or kept out, and one plain sentence that
  says why when it changed nothing. A read with `wholeLanes` on marks the
  parts past the lane cut with `pastLaneCut`.
- **Answer types.** `pick.answerTypes` asks the task the ten questions in
  `ANSWER_TYPES` (a date, a number, a specific name and so on) in one
  request per pick and records the types it needs in `record.answerTypes`.
  A source's question set can carry `typed` questions, asked of its parts
  only when the task needs their type. All of it is off by default, and no
  preset carries a typed question.
- **More decision questions, all optional.** `PERSONAL_CHAT_CASCADE` is a
  chat question set for histories of a person's own life. `COUNT_MARKER` is
  a typed question that keeps a part reporting one instance of what a count
  task counts, through `keepAt`. `pick.writeQuestions` writes two to four
  questions for each task, `taskQuestionWriter(write)` builds it, and a
  set's `written` weights fold their answers into the score, as
  `PERSONAL_CHAT_WRITTEN_CASCADE` does. No preset's default questions
  change.
- **Tasks that name people or things search for those names.**
  `taskNames(task)` finds the names in a task with code, and `findNames`
  replaces it for one call. A source's `names` setting, on for chat, git and
  Markdown and off for rules, searches each name as an exact phrase, so every
  part that mentions it reaches the decision step within the caller's limits.
  A set's `named` question asks whether a part mentions each name and weighs
  the highest answer, as `PERSONAL_CHAT_WRITTEN_CASCADE` does. The record
  lists the names in `record.names`.
- **Unknown options are rejected.** `pick`, `pickFromSources` and `curate`
  throw a `TypeError` before any model call when an options object, or a
  nested one such as `thresholds` or `everyRanked`, holds a key Curate does
  not know. The error names the key's path and the keys allowed there.
- **Labels cost one copy of each part.** `jev()` sends each item once per
  request, in the state, and each question names its item by number. It
  splits a batch into several requests to keep each one inside Jev's
  documented limits, estimated at three characters a token. Picks running
  at the same time in one process ask for each part's labels once, and
  `labels.waited` counts the parts a pick took from another pick's request
  in flight.
- **A decision batch too large never stops a run.** `jev()` sends a request
  the service rejects as too large again in halves, each item keeping its
  questions, and resends a lone item with its evidence text halved and its
  answers marked `truncated`. The largest whole body accepted so far bounds
  later batches, and a rejection it cannot explain, or a lone item cut to no
  text, throws with the reply's whole body. `jev({ onCall })` reports every
  request with its size, status, milliseconds, usage and `splits`, the extra
  requests its rejection produced.
- **Decisions on your own machine.** `localDecisions({ url, model })` asks an
  OpenAI-compatible chat server each yes/no question and reads the answer
  from the log-probabilities of "yes" and "no"; a reply with none throws.
  `jev({ url, model })` decides through any server that speaks Jev's format.
- **One moment for every read.** `recall(task, { taskDate, timeZone })`,
  the read request and `pick` take the task's date, an ISO 8601 date or
  date-time; anything else throws a `TypeError` before any read. Absent
  means now. The pick record names the moment as `asOf`, with its
  `timeZone`, so a replay can pass the same values back.
- **Readers measure from the task date.** Git recency and a chat `since`
  duration count back from it. With `taskDate`, a chat message or a git
  commit dated after it is not read; Markdown keeps notes dated ahead.
- **Chat dates in the person's time zone.** Each chat date carries the
  offset of `timeZone`, the system's zone by default, so a message sent
  just after midnight is dated that day.
- **Chat parts say who wrote them.** The chat reader reads messages typed
  while an agent works, and marks each part's `chat.author` as the person,
  an agent, a tool, the system or unmarked, from what the transcript records.
- **Every Markdown file gets a date.** A file with no commit yet or with
  uncommitted changes, and an undeclared `knowledgeBase()` or `rules()`
  note outside a repository, is dated by its modified time with meaning
  `modified`. A pinned read never uses a modified time.
- **The task's period is a way in.** `taskPeriod(task, { asOf, timeZone })`
  finds a period a task names, such as "in March" or "last week". With
  `pick.taskPeriod`, on by default, the parts dated inside it reach the
  decide step even when no search lane kept them, marked `dateWindow`.
  Nothing is dropped for its date. The record holds `taskPeriod`, and
  `effects` says what the period added.
- **Decay, off by default.** `historySource({ ..., decay: { halfLife: '180 days' } })`
  ranks a Markdown source's older notes lower by their age at the task date,
  never by more than the replaced mark. The record holds the half-life, and
  `effects` counts the parts the read kept or left out only because of it.
- **Note review.** `reviewNotes()` asks the decision model which notes look
  stale and which parts state lasting rules, and returns proposals to retire
  or promote them. It never edits a file.
- **Open Knowledge Format bundles.** `knowledgeBase()` dates a page by its
  `generated.at` or `timestamp`, puts its `title`, `type` and `description`
  in each part title, counts `/` links from the bundle root, skips `index.md`,
  dates each `log.md` entry by its heading, and ranks a page past its
  `stale_after` lower. A retire proposal's edit is `status: deprecated`.
- **An optional decision cache** stores each answered decision per part, so
  a resumed run, a rerun or a repeated question asks only for what changed.
- **Git reads have no time or size limit.** Each `git` call the git and
  Markdown readers make runs until it finishes or the request's `signal`
  cancels it, so a long history read on a large repository is not cut off.
- **The `/curate` skill.** `skills/curate` reads the history of the project
  it runs in: its commits, its Markdown, its Claude Code transcripts and its
  Codex sessions, plus the sources `curate.json` and `~/.curate/sources.json`
  list. One call on a Claude or ChatGPT login writes the search lines, Jev
  decides, and the laid-out parts are printed for the agent to summarise.
  `--check` lists each need as ready or missing with its fix, `--prepare`
  brings the stored index and embeddings up to date, and a call that misses
  a need exits with code 3.

Every library package runs on Node.js 22.20 or later and loads through
`import` or `require`. The `curate` command needs Node.js 22.20 or later.
