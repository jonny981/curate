# @curatejs/core

Curate selects the memory an agent needs for a task from typed sources. Its RDC process ranks candidates, asks your decision function which ones matter, and asks your writer to turn the selected evidence into a short dated log. Selection and curation each return a record.

## RDC process

- **Rank:** Order memory candidates by their signals.
- **Decide:** Ask your decision function which candidates the task needs.
- **Curate:** Call `curate(task, picked, { write })` to write the dated log the working model reads.

[Obversa](https://github.com/jonny981/obversa) uses Curate as its memory.

## Install

```bash
pnpm add @curatejs/core
```

The host supplies its own sources, decision function, and writer. The package imports no model engine.

## Requirements

- Node.js 22.12 or later
- git on the `PATH` for `gitHistory` and for the repository tiers of
  `knowledgeBase`; without it `gitHistory` reports `absent`, a pinned
  `knowledgeBase` cannot resolve its revision, and an unpinned one just
  skips the git tier

## Sources

A source implements `CandidateSource`: it has an `id`, a declared `role`
(`reference`, `rule` or `mixed`), and a `read` that takes a
`CandidateReadRequest` and returns a `CandidateReadResult`.

`read` answers one of three outcomes:

- **`status: 'read'`**: candidates, plus `complete: false` whenever
  enumeration stopped early or skipped anything.
- **`status: 'absent'`**: the expected nothing: no directory, no store.
  Non-fatal, with its reason.
- **A thrown `SourceReadError`**: a real failure: an unreadable file, a
  corrupt store, or `code: 'cancelled'` when the read was aborted.

The request's `exclude` paths are refused before any content is opened,
so excluded text never reaches signals or a model. A `revision` pin is
resolved once and used for every operation that read performs; a source
that cannot honour a pin answers `absent` rather than guess. A
candidate's `text` is the retained snapshot of the exact text scored.

## Markdown sources

`knowledgeBase(dir)` reads a directory of notes: one candidate per
`## ` section of each `.md` file, all role `reference`. A section longer
than `maxQuestionText` (700 characters by default, the budget `pick`
shows the decision model) is offered in parts cut at line ends so every
part is judged. A note that says it was replaced (`superseded`,
`retired`, `deprecated`, `obsolete`, `withdrawn` in frontmatter or the
first 400 characters of its body) keeps its candidates at a negative
signal: ranked lower, never hidden. A note's declared date (frontmatter `date`, `written`,
`effective` or `applies-from`) is carried with its meaning. When the
corpus sits inside a work tree and the note declares none, its last
committed change date is carried with meaning `changed` instead; outside
a repository, or for a note git has never tracked, there is no date.
Notes inside a work tree also carry `path` (their repository-relative
file) and `repository`, which is what lets a selected commit link them
in. A `revision` pin on `knowledgeBase` reads the tree that revision
names: the earlier contents, no later files, and the resolved SHA on the
result.

`rules(dir)` reads a folder of rules: one candidate per `.md` file, all
role `rule`, the folder's `README.md` excluded. Frontmatter
`applies: always` marks a rule that every task follows: `pick` selects
it without asking. Only a rules source emits role `rule`; a note can
never declare itself one.

## Git history

`gitHistory(repo)` reads a repository's commits: one candidate per
non-merge commit, newest first, with the subject as `title`, the body as
`text`, the commit date with meaning `recorded`, and `changedPaths`
holding every file the commit changed relative to the repository root.
`contentRef` keeps the full commit SHA and `id` shows the short one.
Git runs with no shell, a scrubbed environment, a time limit and an
output cap. Missing git, a path that is not a directory, or a directory
outside a work tree reports `absent`; a pin the repository does not have
throws.

With no exclusions, one `git log` pass carries everything. With
exclusions, paths are listed first and a commit that touched an excluded
path is dropped before its body is ever fetched. `blame: true` adds a
signal for commits that wrote lines still live in the task's named
paths; `coChange: true` adds one for commits that touched files which
historically change with them. Both are off unless asked for.

## Chat transcripts

`chat(options)` reads local JSONL transcripts as reference candidates.

```ts
import { chat, gitHistory, knowledgeBase } from '@curatejs/core';

const sources = [
  gitHistory('.'),
  knowledgeBase('docs'),
  chat({ providers: ['claude-code', 'codex'], since: '14 days' }),
];
```

- **Providers:** Claude Code reads `~/.claude/projects/`; Codex reads
  `~/.codex/sessions/`. Both folders are scanned recursively. `providers`
  defaults to both. `paths: ['/path/to/transcripts']` replaces the default
  folders for each selected provider.
- **Dates:** `since` accepts an ISO date or a duration such as `'14 days'`
  or `'12 hours'`, measured from read start. Only messages at or after
  that date are emitted. Omit it to read all dated messages.
- **Parts:** Each user or assistant text block becomes a candidate. Text
  is split at line ends into at most 700 characters. Longer lines are
  hard-cut. `maxQuestionText` and the request's text budget can tighten
  that limit. Joining the parts reproduces the scrubbed block.
- **Metadata:** `candidate.chat` carries `provider`, `sessionId` and the
  message `role`. The candidate's own `role` stays `'reference'`. `date`
  holds the message timestamp with meaning `'recorded'`. `contentRef`
  names the provider, session, JSONL line, block and part.
- **Tools:** Tool calls and results are excluded by default.
  `includeTools: true` includes them with message roles `'tool-call'` and
  `'tool-result'`. Thinking blocks and Codex event copies are excluded.
- **Scrubbing:** Full message blocks and tool arguments are scrubbed
  before splitting or ranking. Patterns cover private keys, common API
  keys and tokens, named passwords and credentials, credentials in URLs,
  and long strings that look like secrets. A 40-character hex commit id
  is retained. Pattern matching is not a guarantee that arbitrary secret
  text will be recognized.
- **Ranking:** Chat uses the LongMemEval settings: BM25 with `k1: 0.6`
  and `b: 0`, Porter word stems, short identifiers, noun weights, and
  merged rankings for the full query, content words and names. Markdown
  and git use their own settings. No model or network call is made.
- **Read results:** Missing folders return `absent` when none can be read.
  Missing folders alongside readable folders, skipped symbolic links,
  undated messages, and a candidate limit make the read incomplete.
  Excluded paths are refused before opening content. Cancellation and
  file or JSON failures throw `SourceReadError`. Revision pins return
  `absent` because transcripts have no git revision.

## Picking

`pick(candidates, { task, decide })` ranks the candidates, asks `decide`
in bounded batches, and returns the selected candidates with a
`PickRecord`. `pickFromSources(sources, request, options)` reads the
sources first, then picks over the combined candidates; a rule source
that returned `complete: false` or was absent makes the record's
`rulesCoverage` `'incomplete'`, even when every supplied rule was
answered. `rulesEnumerationComplete: false` in the options is honoured
the same way.

Each candidate's `changedPaths` names the repository paths it changed;
`gitHistory` fills it from the commit's diff, never from paths the text
mentions. After the threshold pass one more pass runs: a reference
candidate answered at or above `linkedPathBar` (0.4 by default, below
the reference threshold on purpose) still passes when a
threshold-selected commit from the same `repository` names its `path` in
`changedPaths`. The record entry names the commit that carried it over
in `link`, and a linked candidate never carries another. The bar is a
chosen default, not a measured best; `PickThresholds.linkedPathBar`
overrides it.

## Curating

`curate(task, picked, { write })` accepts the result of `pick` or
`pickFromSources`. It calls your `write(prompt, signal)` function once.
`prompt.instructions` contains the v4 dated-log wording and three weight
bands: 0.6 or more, 0.1 to 0.6, and below 0.1. `prompt.body` contains the
task and selected reference items in their selected order. Each header
keeps the full item id, the candidate's date value, and its decision
weight rounded to two decimal places. A missing date stays missing.
When ids clash across sources, their headers use `[sourceId, id]` as a
JSON string so the writer can tell them apart.

```ts
import { curate, pick, type CurateWrite, type MemoryCandidate, type PickDecide } from '@curatejs/core';

// The host supplies both functions, using its chosen model route.
async function recall(task: string, candidates: MemoryCandidate[], decide: PickDecide, write: CurateWrite) {
  const picked = await pick(candidates, { task, decide });
  const curated = await curate(task, picked, { write });
  return { log: curated.log, pickRecord: picked.record, curateRecord: curated.record };
}
```

The returned `log` is the text for the working model to read. Its lines
have this form:

```text
[2023-05-13] Visited York (said 2023-05-20; trips.md#2)
```

The event date and the date it was said are separate. The prompt asks
the writer to keep exact names and amounts, merge repeated events with
both full ids, and mark later observations that replace earlier ones.
Selected rules stay in `picked.selected` for the host to pass as exact
instructions; the curator reads only reference items.

`record` holds `promptVersion: 'v4'`, `weights: 'tiers'`, `working`, and
`items`. Each item includes its prompt `id`, the full `candidate`, and
the exact decision `weight` before rounding.

`working: true` asks the writer to add numbered instances inside the
task's period, computed time gaps or order, and latest values under
`Working (the curator's; check it against the log):`. It is off by
default. The reader should check these notes against the log.

An empty log, a log longer than 3500 characters after trimming, or a
malformed observation throws a clear error. Each observation must have
valid calendar dates in its event and `said` fields and full ids of items
given to the writer. Merged sources can separate ids with commas,
semicolons, `and`, or `&`. Optional
suffixes are `(when not stated)` and `(replaces [YYYY-MM-DD])`; replacement
dates must also be valid. These checks verify the format and source ids;
they do not prove the writer's
facts or date calculations. Worked notes share the same length limit.
There is no retry, truncation, or fallback to raw items. Missing selected
weights and a selection with no reference items fail before `write`.
Writer failures propagate to the caller. `signal` reaches the writer;
the host must make its model call honour cancellation.
