# Changelog

## 0.1.0

The first release of Curate, a TypeScript library that gives an agent the
context it needs for a task. It ranks the sources you point it at, asks your
decision function narrow questions about each item, and asks your writer for a
dated, cited log. There is no database and nothing to deploy.

Four packages:

- **`@curatejs/core`** holds selection and curation: `pick`, `pickFromSources`
  and `curate`. Keyword search lanes, host-written search lines and phrases,
  fitted question sets that each source carries as `questions`, decision tags, optional score cuts,
  rank and batch dials, and one log format repair. Optional local meaning
  search adds embedding ranks through a host-supplied function or the shipped
  `node-llama-cpp` adapter. An optional label gate labels every reference
  part of a source that carries label kinds, and the task once, against the
  kind questions, keeps the answers in a directory you choose, and adds the
  parts whose labels match a kind the task needs to the parts keyword search
  already found for the decide step. Chat asks its seven label kinds by
  default; git and Markdown carry none.
- **Task memory.** Recall a dated, cited log and exact rule text with
  `memory({ sources, decide, write }).recall(task)`. The entry point uses each
  reader's question set and rejects incomplete reads and unanswered or
  unassessed candidates before writing. Each source's settings and explicit
  read, selection and writer options pass through to the existing APIs. Use `jev()`,
  `openAIDecisions()` and `chatWriter()` from `@curatejs/core/models` to
  connect models with Node's built-in `fetch`. Plain `decide` and `write`
  functions remain supported.
- **Settings by source.** Each source carries its own settings, so a setting
  chosen for one kind of history never changes what Curate picks from
  another: `rare` (follow strong parts by their rare words to parts the first
  pass missed, within that source), `labels` (the label kinds asked of each
  part), `bar` (the decision-score bar for its references), `ruleBar` (the
  bar for its rules) and `questions` (the decision questions asked of its
  references; the presets carry `CHAT_CASCADE`, `GIT_HISTORY_CASCADE` and
  `MARKDOWN_CASCADE`). The presets `chat()`, `git()`, `markdown()`,
  `knowledgeBase()` and `rules()` carry their package's tuned settings
  objects, `chatSettings`, `gitSettings`, `markdownSettings` and
  `rulesSettings`. `historySource({ reader, ...settings })` builds a source
  with any settings, for example a chat source with labels off:
  `historySource({ reader: chat(), ...chatSettings, labels: false, questions: AGENT_CHAT_CASCADE })`. Pick
  and curate records name each source's settings under `levers.sources`.
- **A rule library.** `rules(dir)` reads `.md`, Cursor `.mdc` and Copilot
  `*.instructions.md` rule files, one candidate per rule, with `globs` and
  `applyTo` scopes and a `.mdc` file's `description` in the rule's title. It
  keeps the rules the decision model answers 0.5 or more for, word for word;
  0.5 is a starting value, not yet tuned. Every source that reads rules skips
  the always-on files a harness loads itself (`CLAUDE.md`, `AGENTS.md`,
  `alwaysApply: true` and the like), and the record's `effects` names them.
- **Every bar can be set.** A source's `labelBar` sets its label bar, 0.5
  by default. `curate.weightBands` sets the curator's two weight bands,
  `[0.1, 0.6]` by default. With neither `batchTokens` nor `contextLimit`,
  evidence over `DEFAULT_BATCH_TOKENS` (150,000 estimated tokens) is written
  as a layered log in batches of that size; smaller evidence is written in
  one call.
- **Levers for the whole call.** Every other cost and quality setting is a
  lever that turns on for more quality at more cost: `wholeLanes` (read each
  source's whole ranked list), `everyRanked` (decide every ranked part, or
  only the top round(c × N^0.8)) and `route: 'jev'` (the decision model
  chooses the curator's options per question). `everyScored` and `rare` set
  one value for every source in place of their own.
  The core README lists each lever's purpose and measured impact.
- **Records say what each setting did.** Each pick and curate record
  carries `effects`: one entry per setting that was on, per source, with the
  parts it looked at, the kept parts it brought in or kept out, and one plain
  sentence that says why when it changed nothing. A read with `wholeLanes`
  on marks the parts past the lane cut with `pastLaneCut`.
- **Answer types.** `pick.answerTypes` asks the task the ten questions in
  `ANSWER_TYPES` (a date, a number, a specific name and so on) in one
  request per pick and records the types it needs in
  `record.answerTypes`. A source's question set can carry `typed`
  questions, asked of its parts only when the task needs their type, and
  `curate.answerHint` names the needed types to the curator in one line
  under the task. All of it is off by default, and no preset carries a
  typed question.
- **More decision questions, all optional.** `PERSONAL_CHAT_CASCADE` is a
  chat question set for histories of a person's own life. `COUNT_MARKER` is
  a typed question that keeps a part reporting one instance of what a count
  task counts, through the new `keepAt`. `pick.writeQuestions` writes two to
  four questions for each task, `taskQuestionWriter(write)` builds it, and a
  set's `written` weights fold their answers into the score, as
  `PERSONAL_CHAT_WRITTEN_CASCADE` does. No preset's default questions change.
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
  not know. The error names the key's path and the keys allowed there, and a
  key from an earlier draft of the levers names the option that replaced it.
- **Labels cost one copy of each part.** `jev()` sends each item once per
  request, in the state, and each question names its item by number. It
  splits a batch into several requests to keep each one inside Jev's
  documented limits, estimated at three characters a token. Picks running at the same time in one process ask for
  each part's labels once, and `labels.waited` counts the parts a pick took
  from another pick's request in flight.
- **A decision batch too large never stops a run.** `jev()` sends a request
  the service rejects as too large again in halves, each item keeping its
  questions, and resends a lone item with its evidence text halved and its
  answers marked `truncated`. The largest whole body accepted so far bounds
  later batches, and a rejection it cannot explain — or a lone item cut to
  no text — throws with the reply's whole body. `jev({ onCall })` reports
  every request with its size, status, milliseconds, usage and `splits`, the
  extra requests its rejection produced. The `/curate` skill decides through
  `jev()` and records each request; a Codex source's `allowedCwd` takes one
  folder or a list and admits a session run in it or below it; and a read
  the skill's cache does not hold, such as a name lane, is read from the
  source.
- **One moment for every read.** `recall(task, { taskDate, timeZone })`,
  the read request and `pick` take the task's date, an ISO 8601 date or
  date-time; anything else throws a `TypeError` before any read. Absent
  means now. The pick record names the moment as `asOf`, with its
  `timeZone`, so a replay can pass the same values back, and `recall`
  gives `taskDate` to the curator as the task's date label.
- **Readers measure from the task date.** Git recency and a chat `since`
  duration count back from it. With `taskDate`, a chat message or a git commit
  dated after it is not read; Markdown keeps notes dated ahead.
- **Chat dates in the person's time zone.** Each chat date carries the
  offset of `timeZone`, the system's zone by default, so a message sent
  just after midnight is dated that day.
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
- **Short item ids in curator prompts.** The curator sees and cites short
  ids; the returned log carries full ids, so callers see no change.
- **An empty log when nothing bears on the task.** The writer returns an
  empty reply. Curate asks once more, and when the second reply is empty
  too, the record marks the log with `empty: true`. A format
  error quotes the line that failed, and the one repair shows that line to
  the writer. One citation may list several said dates, as in
  `(said 2023-05-26 and 2023-05-29; E3, E4)`.
- **Format slips preserve cited evidence.** Observations can cite several
  dates and items with a terminal period. After one failed repair, Curate
  keeps valid lines and malformed lines naming a supplied item, and records
  retained malformed lines and discarded lines under `formatRecovery`.
  Empty repairs and unusable condensed replies cannot erase a cited log.
- **`@curatejs/chat`** reads local Claude Code and Codex transcripts. It
  scrubs likely secrets before ranking.
- **Chat parts say who wrote them.** The chat reader reads messages typed
  while an agent works, and marks each part's `chat.author` as the person,
  an agent, a tool, the system or unmarked, from what the transcript records.
  The curator then sees the author in each item header and quotes the person
  only from the person's own parts.
- **`@curatejs/git`** reads commit history, with optional blame and co-change
  signals.
- **`@curatejs/markdown`** reads Markdown folders, files and globs as
  knowledge, docs, rules or instructions, including scoped rule files and
  git-pinned revisions.
- **Git reads have no time or size limit.** Each `git` call the git and
  Markdown readers make runs until it finishes or the request's `signal`
  cancels it, so a long history read on a large repository is not cut off.

Every package runs on Node.js 22.20 or later and loads through `import` or
`require`.
