# @curatejs/git

Read git commits as task evidence. The package depends only on
`@curatejs/core`; it calls no model or network service.

## Install

```bash
pnpm add @curatejs/core @curatejs/git
```

## Requirements

Node.js 22.20 or later. Git must be on `PATH`.

## Git history

`gitHistory(repo)` reads a repository's commits: one candidate per
non-merge commit, newest first, with the subject as `title`, the body as
`text`, the commit date with meaning `recorded`, and `changedPaths`
holding every file the commit changed relative to the repository root.
`contentRef` keeps the full commit SHA and `id` shows the short one.
Git runs with no shell and a scrubbed environment. A git call has no
time or size limit: it runs until it finishes or the request's `signal`
cancels it. Missing git, a path that is not a directory, or a directory
outside a work tree reports `absent`; a pin the repository does not have
throws.

With no exclusions, `git log` enumerates the history in pages so one
call's output stays small; with exclusions, paths are listed first and a
commit that touched an excluded path is dropped before its body is ever
fetched. Commit bodies are read in bounded batches. When a pick's lane
cut is on, the read scores each page or batch as it arrives, keeps a
compact score per commit, and fetches bodies only for the commits its
own score curve kept.
`blame: true` adds a signal for commits that wrote lines still live in
the task's named paths; `coChange: true` adds one for commits that
touched files which historically change with them. Both are off unless
asked for.

## Usage

```ts
import { pickFromSources } from '@curatejs/core';
import { gitHistory } from '@curatejs/git';

const sources = [gitHistory('.')];
// Supply your own decision function.
const picked = await pickFromSources(sources, { task }, { task, decide });
```

## Defaults and overrides

Core's default mode decides every ranked part and keeps references scored 0.0146 or more,
ordered and weighted by decision probability.
Set `everyScored: true` to keep every scored reference.
The curator receives exact scores. Its `tiers` instructions ask for less space for low-scored items.
The source enables the rare-word round to find unselected references that share rare words with selected evidence.
Spread the source and set `rare: false` to disable that round for it.
Labels are off in the default mode.
Rules keep every scored item; set `thresholds.rule` for an optional applicability cut.
See [core's measured reason](https://github.com/jonny981/curate/blob/main/packages/core/README.md#defaults-and-evidence) for the saved-decision sweep's answer-turn losses.

- **Keyword settings:** `GIT_KEYWORD_SETTINGS` exports the ranking defaults. Pass a partial `keyword` object to the reader to override them.
- **Questions:** `gitHistory()` carries `GIT_HISTORY_CASCADE`, its fitted question set. Core's `memory()` uses it automatically; override it with `pick.cascadesByKind['git-history']`. With `pickFromSources()` or `pick()`, pass it through `cascade` or `cascadesByKind` explicitly.
- **Search wording:** `GIT_SEARCH_LINE_REGISTER` describes the wording for host-written extra search lines. Copy or replace this text in your host; the package generates no lines.
- **Kind phrases:** `GIT_HISTORY_KIND_PHRASES` exports phrases in the commit register for `directions`, `decisions` and `corrections`. Pass one list to core's `kindLanes` option, for example `{ 'git-history': GIT_HISTORY_KIND_PHRASES.decisions }`; kind lanes stay off by default.

```ts
import { gitHistory, GIT_KEYWORD_SETTINGS, GIT_HISTORY_CASCADE, GIT_SEARCH_LINE_REGISTER } from '@curatejs/git';

const source = gitHistory('.', { keyword: { recencyDays: 90 } });
```

See [core](https://github.com/jonny981/curate/blob/main/packages/core/README.md) for selection, search lines, optional cuts and curation.
