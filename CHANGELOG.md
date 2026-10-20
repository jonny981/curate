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
- **Levers and presets.** Every cost and quality setting is a lever that
  turns on for more quality at more cost: `wholeLanes` (read each source's
  whole ranked list), `everyRanked` (decide every ranked part, or only the
  top round(c × N^0.8)), `everyScored` (keep every scored part), `labels`,
  `route: 'jev'` (the decision model chooses the curator's options per
  question) and the rare-word round (follow strong parts by their rare words
  to parts the first pass missed). `performance`, the default, and `economy`
  are exported presets; spread one and flip any lever for your own mode. The
  README's Levers section lists each lever's purpose and measured impact.
- **An optional decision cache** stores each answered decision per part, so
  a resumed run, a rerun or a repeated question asks only for what changed.
- **Short item ids in curator prompts.** The curator sees and cites short
  ids; the returned log carries full ids, so callers see no change.
- **`@curatejs/chat`** reads local Claude Code and Codex transcripts. It
  scrubs likely secrets before ranking.
- **`@curatejs/git`** reads commit history, with optional blame and co-change
  signals.
- **`@curatejs/markdown`** reads Markdown folders, files and globs as
  knowledge, docs, rules or instructions, including scoped rule files and
  git-pinned revisions.

Every package runs on Node.js 22.20 or later and loads through `import` or
`require`.
