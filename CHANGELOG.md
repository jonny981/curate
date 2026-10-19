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
- **`@curatejs/chat`** reads local Claude Code and Codex transcripts. It
  scrubs likely secrets before ranking.
- **`@curatejs/git`** reads commit history, with optional blame and co-change
  signals.
- **`@curatejs/markdown`** reads Markdown folders, files and globs as
  knowledge, docs, rules or instructions, including scoped rule files and
  git-pinned revisions.

Every package runs on Node.js 22.20 or later and loads through `import` or
`require`.
