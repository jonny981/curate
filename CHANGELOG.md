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
  `historySource({ reader: chat(), ...chatSettings, labels: false })`. Pick
  and curate records name each source's settings under `levers.sources`.
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
