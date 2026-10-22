# Changelog

## 0.1.0

The first release of Curate, a TypeScript library that gives an agent the
context it needs for a task. It ranks the sources you point it at, asks your
decision function narrow questions about each item, and asks your writer for a
dated, cited log. There is no database and nothing to deploy.

Four packages:

- **`@curatejs/core`** holds selection and curation: `pick`, `pickFromSources`
  and `curate`. Keyword search lanes, host-written search lines and phrases,
  fitted question sets per source kind, decision tags, optional score cuts,
  rank and batch dials, and one log format repair. Optional local meaning
  search adds embedding ranks through a host-supplied function or the shipped
  `node-llama-cpp` adapter. An optional `labels` gate labels every reference
  part and the task once against seven kind questions, keeps the answers in a
  directory you choose, and adds the parts whose labels match a kind the task
  needs to the parts keyword search already found for the decide step. It is
  off by default.
- **Task memory.** Recall a dated, cited log and exact rule text with
  `memory({ sources, decide, write }).recall(task)`. The entry point uses each
  reader's question set and rejects incomplete reads and unanswered or
  unassessed candidates before writing. Presets and explicit read, selection
  and writer options pass through to the existing APIs. Use `jev()`,
  `openAIDecisions()` and `chatWriter()` from `@curatejs/core/models` to
  connect models with Node's built-in `fetch`. Plain `decide` and `write`
  functions remain supported.
- **Levers and presets.** Every cost and quality setting is a lever that
  turns on for more quality at more cost: `wholeLanes` (read each source's
  whole ranked list), `everyRanked` (decide every ranked part, or only the
  top round(c × N^0.8)), `everyScored` (keep every scored part), `labels`,
  `route: 'jev'` (the decision model chooses the curator's options per
  question) and the rare-word round (follow strong parts by their rare words
  to parts the first pass missed). `defaultMode` supports agents working
  from chat, git and docs; `conversationRecall` adds labels for questions
  about past conversations. Spread one and flip any lever for your own mode.
  The core README lists each lever's purpose and measured impact.
- **Unknown options are rejected.** `pick`, `pickFromSources` and `curate`
  throw a `TypeError` before any model call when an options object, or a
  nested one such as `thresholds` or `everyRanked`, holds a key Curate does
  not know. The error names the key's path and the keys allowed there, and a
  key from an earlier draft of the levers names the option that replaced it.
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
