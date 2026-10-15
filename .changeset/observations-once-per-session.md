---
"@curatejs/core": minor
---

`observe(parts, options)` writes a dated observation log once per session instead of curating the whole history again for every task. For each session its store does not already hold, it calls the caller's `write` function with no task: the instructions ask for one line per fact, never merged and never dropped. Replies pass the dated-line check `curate` uses, plus one rule: a line may cite only its own session's item ids. A failing reply goes back once with the reason; a second failure stores nothing and that session's raw parts stand in as candidates instead. A session that states no fact answers `NO FACTS` and is stored with no lines, so it is not asked again.

Written lines are kept in an optional async `store` or a plain-file `directory`, keyed by a SHA-256 over the `observation` namespace, the instruction version, the caller's `writerId` and the session's parts in order, so a changed part rewrites only its own session. `batchTokens` packs whole sessions into one writer call within an estimated token budget; nothing is split or dropped. `observationCandidates(result)` returns one candidate per line: `<session>#L<n>` ids, the line as text, the event date, the session as `documentId` and the cited part ids in `cites`. `pick` and `curate` run on them unchanged. The option is off by default: nothing calls `observe` unless the host does.
