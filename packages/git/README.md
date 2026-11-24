# @curatejs/git

Reads a repository's commits, so Curate can pick evidence from your git history.
It depends only on `@curatejs/core` and calls no model or network service.

## Install

```bash
pnpm add @curatejs/core @curatejs/git
```

You need Node.js 22.20 or later, and git on your `PATH`.

## Example

```ts
import { pickFromSources } from '@curatejs/core';
import { git } from '@curatejs/git';

const sources = [git('.')];
// Supply your own decision function.
const picked = await pickFromSources(sources, { task }, { task, decide });
```

## Options

`git(repo, options)` takes the repository's folder, or a `file:` URL, and these options:

| Option | Default | What it does |
| --- | --- | --- |
| `since` | the whole history | How far back to read: an ISO date, or a duration such as `'14 days'` counted back from the [task date](#dates). |
| `paths` | every commit | Only commits that changed one of these paths. Unlike the read request's `paths`, which only hints at ranking, this is a filter. |
| `exclude` | none | Drops any commit that touched one of these paths, even if it also touched an allowed one. Its body is never fetched. |
| `blame` | `false` | `true` adds the `live_lines` signal. See [Optional signals](#optional-signals). |
| `coChange` | `false` | `true` adds the `co_change` signal. See [Optional signals](#optional-signals). |
| `keyword` | `GIT_KEYWORD_SETTINGS` | Your changes to the keyword ranking. See [Keyword settings](#keyword-settings). |
| `index` | on | `{ directory }` picks where the index file goes, and `false` runs git on every read. See [Stored index](#stored-index). |
| `repository` | the work tree's top folder | The key that links a commit to Markdown notes from the same repository. A link needs the same key on both sides. |
| `id` | `git:` plus the repository's resolved path | The source's id. |

`paths` and `exclude` take paths relative to the repository, or absolute paths inside the work tree.
`exclude` is added to the read request's `exclude` for this source only, so another source over the same repository still reads those commits.
The pick's levers record `since`, `paths` and `exclude`.

## What it reads

The reader gives one candidate per commit, newest first, and leaves out merges.
A long commit message is cut into parts: see [Long commit messages](#long-commit-messages).
Each candidate holds:

- **`title`:** the subject.
- **`text`:** the body.
- **`date`:** the commit date, with meaning `recorded`. It keeps the committer's own offset.
- **`changedPaths`:** every file the commit changed, relative to the repository root.
- **`contentRef` and `id`:** `contentRef` keeps the full commit SHA, and `id` shows the short one.

Git runs with no shell and a scrubbed environment.
A git call has no time or size limit: it runs until it finishes or the request's `signal` cancels it.

If git is missing, the path isn't a folder, or the folder is outside a work tree, the read returns `absent`.
A pin to a revision the repository doesn't have throws.

## Long commit messages

A squash merge can put a whole pull request description in one commit.
You don't want all of it because one sentence matches. So the reader cuts
a long body into parts, the way the Markdown reader cuts a long note.
The decision model rates each part, and only the parts that bear on the
task are laid out.

- **When:** a body longer than four part sizes is cut. `pickFromSources` reads with a part size of 700 characters, so a body over 2,800 characters is cut. A shorter commit stays whole: one candidate.
- **Squash merges first:** a squash merge is cut at the commits it squashed, one part each, starting with that commit's own subject line. The reader knows two forms from the text:
  - **GitHub's:** each commit starts with a `* <subject>` line that has a blank line above and below it, the body opens with one, and there are at least two. A bullet list inside prose doesn't count: its items sit on lines next to each other, or prose opens the body.
  - **`git merge --squash`:** each commit starts with a `commit <sha>` line followed by an `Author:` or `Merge:` line, and there are at least two.
- **Where else:** a body that is not a squash merge, or one squashed commit longer than a part, is cut at blank lines and before each Markdown heading outside a code block. A paragraph longer than one part is cut at its last sentence end that fits, else at a space.
- **Each part:** has the commit's subject as its `title`, and the commit's date, SHA, changed files and signals. Its `id` is the commit's with `#<n>` added, for example `commit 3ad5901#4`. `documentId` names the commit, and `part` gives its place, for example `{ index: 4, of: 12 }`.
- **Scoring:** each part is scored on its own words. The subject counts once, with the first part.
- **Layout:** core's `curate()` shows the kept parts of one commit together, under its subject, in their own order. `…` marks parts left out, and a last line says how many, for example `11 of 12 parts of commit 3ad5901 were not kept.` Run `git show 3ad5901` to read the whole commit.
- **Part size:** `git(repo, { maxQuestionText: 1000 })` sets another size. The read request's own `maxQuestionText` makes it smaller still. `maxQuestionText: Infinity` keeps every commit whole. A read given no size at all keeps every commit whole too.

## Dates

The task date is the read request's `taskDate`, else its `asOf`, else now.
The `recency` signal counts back from it, so a replay with the same task date scores the same.
With a `taskDate`, a commit dated after it isn't read.

`since` counts back from the same task date.
The reader passes it to `git log`, so an older commit is never listed.

## Ranking

A keyword search ranks each commit by adding up its signals.
The weights live in [`GIT_KEYWORD_SETTINGS`](#keyword-settings):

| Signal | Setting (default) | What it adds |
| --- | --- | --- |
| `bm25` | `k1` (1.2), `b` (0.75) | A score for the task's words in the subject and body together. |
| `recency` | `recencyDays` (60) | Up to 1, falling as the commit gets older. |
| `named_path_touch` | `namedPathWeight` (3) | Its weight, when the commit touched a path the task names. |
| `co_change` | `coChangeWeight` (1) | Its weight, when [`coChange`](#optional-signals) finds the commit. |
| `live_lines` | `liveLinesWeight` (2) | Its weight plus the base-10 log of the commit's live lines, when [`blame`](#optional-signals) finds them. |

For `bm25`, a word scores more the rarer it is, each repeated mention adds less than the one before, and a long message counts each mention for less than a short one.
The counts cover only the commits the search ranks.
For the main search, that's the commits left after `since`, `paths`, `exclude` and the task's date or period, up to the read's `limit`.
For a kind lane, it's the commits that contain its phrase.

The subject gets no extra weight.
On a test repository of about 2,900 commits, weighting it as a title kept no more of the expected commits than plain BM25.

### Optional signals

Both are off unless you ask for them, because each costs extra git calls:

- **`blame: true`** adds `live_lines` for commits that wrote lines still live in the files the task names. It runs one blame call per named file.
- **`coChange: true`** adds `co_change` for commits that touched files which historically change together with the files the task names. It runs extra log passes.

## Memory use

Without exclusions, `git log` lists the history in pages, so one call's output stays small.
With exclusions, the reader lists the paths first.
It reads commit bodies in bounded batches.

When the pick's lane cut is on, the reader counts each task word in each page or batch as it arrives and keeps those counts per commit.
It then fetches bodies only for the commits its own score curve kept.

## Stored index

By default the reader keeps one local file for this source, made on its first read.
Every lane in a call takes each commit's subject, body and paths from that file.
Git only lists the commit names, once per call and date range, and the reader reads only the commits the file doesn't hold yet.
If the history was rewritten, the file is built again.

A read pinned to a revision other than the one this call indexed runs git as before.
The file goes in `~/.cache/curate/index`, or `$XDG_CACHE_HOME/curate/index` if that's set.
Set `index: { directory }` to choose the folder, or `index: false` to run git on every read.

Core's [Stored index](https://github.com/jonny981/curate/blob/main/packages/core/README.md#stored-index) has the detail.
The file also keeps each long commit's parts and their word counts. Each part size has its own file.

## Defaults and overrides

`git()` reads with `gitSettings`, `{ labels: false, names: true, mode: commits }`:

- **No labels.**
- **Name lanes:** one for each name the task names.
- **The `commits` mode:** each commit is asked `GIT_HISTORY_CASCADE`, and commits scoring 0.0146 or more are kept, ordered and weighted by decision probability.

Set `everyScored: true` on the pick to keep every scored reference candidate from every source.
Core's `curate()` lays out the kept candidates by their exact scores, strongest first.

To change a setting, build the source with core's `historySource()`:

```ts
import { historySource } from '@curatejs/core';
import { commits, git, gitSettings } from '@curatejs/git';

const source = historySource({ reader: git('.'), ...gitSettings, mode: { ...commits, bar: 0.05 } });
```

Core's [Defaults and evidence](https://github.com/jonny981/curate/blob/main/docs/measurements.md#defaults-and-evidence) explains the 0.0146 bar: in its saved-decision sweep, higher bars dropped whole answer turns.

### Keyword settings

`GIT_KEYWORD_SETTINGS` holds the [ranking](#ranking) defaults.
Pass a partial `keyword` object to the reader to change them:

```ts
import { git, GIT_KEYWORD_SETTINGS, GIT_HISTORY_CASCADE, GIT_SEARCH_LINE_REGISTER } from '@curatejs/git';

const source = git('.', {
  keyword: {
    k1: 1.2,
    b: 0.75,
    recencyDays: 90,
  },
});
```

### Question set

`gitSettings` carries the `commits` mode, and with it `GIT_HISTORY_CASCADE`, the fitted question set `git()` asks of each commit.
Change it with `historySource({ reader: git('.'), ...gitSettings, mode: { ...commits, questions: mySet } })`.

The git and Markdown sets were fitted on saved answers about commits and notes.
No end-to-end score has measured them.

### Search wording and kind phrases

`GIT_SEARCH_LINE_REGISTER` describes how to word extra search lines your host writes.
Copy or replace the text in your host: the package writes no lines itself.

`GIT_HISTORY_KIND_PHRASES` holds phrases in commit wording for `directions`, `decisions` and `corrections`.
Pass one list to core's `kindLanes` option, for example `{ 'git-history': GIT_HISTORY_KIND_PHRASES.decisions }`.
Kind lanes are off by default.

See [core](https://github.com/jonny981/curate/blob/main/packages/core/README.md) for selection, search lines, optional cuts and curation.
