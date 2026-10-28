# @curatejs/markdown

Read Markdown notes and rule files as task evidence. The package depends only on
`@curatejs/core`; it calls no model or network service.

## Install

```bash
pnpm add @curatejs/core @curatejs/markdown
```

## Requirements

Node.js 22.20 or later. Git on `PATH` enables revision pins and committed change dates. An unpinned read without git skips the repository date tier.

## Markdown sources

`knowledgeBase(dir)` reads a directory of notes: one candidate per
`## ` section of each `.md` file, all role `reference`. A section longer
than `maxQuestionText` (700 characters by default) is offered in parts
cut at line ends so every part is judged. A note that says it was replaced (`superseded`,
`retired`, `deprecated`, `obsolete`, `withdrawn` in frontmatter or the
body) keeps its candidates at a negative
signal: ranked lower, never hidden. A note's declared date (frontmatter `date`, `written`,
`effective` or `applies-from`) is carried with its meaning. When the
corpus sits inside a work tree and the note declares none, its last
committed change date is carried with meaning `changed` instead. A note
with no commit yet or with uncommitted changes, and an undeclared note
outside a repository, carries its file's modified time with meaning
`modified`.
Notes inside a work tree also carry `path` (their repository-relative
file) and `repository`, which is what lets a selected commit link them
in. A `revision` pin on `knowledgeBase` reads the tree that revision
names: the earlier contents, no later files, and the resolved SHA on the
result.

`rules(dir)` is the rule library: a folder of many small rules, from
which the decision model picks the ones a task needs.

- **Files:** plain `.md` rule files, Cursor `.mdc` files and Copilot
  `*.instructions.md` files. Names that start with a dot and the folder's
  `README.md` are skipped.
- **One candidate per rule:** a heading or an unindented list item starts a
  rule, and a rule repeats the text of the heading above it. A file with no
  heading or list item is one rule. Every candidate has role `rule`.
- **Scope:** a `.mdc` file's `globs` and a `*.instructions.md` file's
  `applyTo` limit its rules to tasks whose paths match. Inside a git
  repository, task paths and scopes are both read from the repository root.
  Outside one, they are read from the library folder.
- **Description:** a `.mdc` file's `description` goes into each of its rules'
  titles, as `<file name>: <description>`, so the decision model sees what
  the rule is for. The rule's text stays its own.
- **The bar:** a rule the decision model answers 0.5 or more for is kept,
  and it reaches the agent as its exact text. The rest are dropped. 0.5 is a
  starting value, not yet tuned; it will be fitted on the 160-task rules
  test. See [Defaults and overrides](#defaults-and-overrides) to change it.

Rules and instruction sources emit role `rule`; a note can never declare
itself one.

## Always-on files

An agent harness loads its own always-on files every session, so Curate
leaves them to it. Every source that reads rules (`rules()`, and
`markdown()` with kind `rules` or `instructions`) skips:

- **files a harness loads by name:** `CLAUDE.md`, `CLAUDE.local.md`,
  `AGENTS.md`, `GEMINI.md`, `.cursorrules` and
  `.github/copilot-instructions.md`;
- **files whose frontmatter says they are always-on:** Cursor's
  `alwaysApply: true`, or `applies: always`.

A skipped file is never asked about and puts nothing in the log or the
rules. The read lists each one with its reason in `alwaysOnSkipped`, and
the pick record's `effects` names them. Knowledge and docs sources read
these files as usual.

## Files, globs, and kinds

`markdown({ paths, kind })` reads folders, individual files, or glob patterns.
Paths beginning with `~/` resolve against the user's home directory. Git-ignored
paths, `.git`, and `node_modules` are skipped before file contents are opened.
Markdown files include `.md`, `.markdown`, `.mdc`, and `.cursorrules`.

```ts
import { markdown, rules } from '@curatejs/markdown';

const sources = [
  markdown({ paths: ['notes'], kind: 'knowledge' }),
  markdown({ paths: ['docs'], kind: 'docs' }),
  rules('.cursor/rules'),
];
```

- **Kinds:** Knowledge and docs are references; rules and instructions are
  rules. Candidate, question, and selection records retain the declared kind.
  A source without a question set asks a question suited to that kind.
- **Shared reads:** One `pickFromSources` call reads a file's bytes once across
  overlapping sources and search lines, up to a 64 MB shared cap; past the
  cap each pass reads from disk again, so a large corpus is never held
  whole. Different kinds retain separate candidates. A later call reads
  the file again.
- **Passes:** A keyword read parses each file once for keyword
  statistics, scores the parts on a second read, and builds candidates
  only for the parts its lane kept. A pinned read fetches blob contents
  in bounded batches the same way.
- **Whole text:** The source has no default part-size cap. Set
  `maxQuestionText` on the source or read request to split text into parts that
  preserve every character. A pick text limit takes precedence over the read
  request. Core keeps its existing full-text default.
- **Rules:** Headings and top-level list items form separate rules with ids
  based on the file and heading path. Parent text stays with child rules.
  Nested lists and fenced code remain whole.
- **Scopes:** Cursor `.mdc` files use `globs`; Copilot
  `*.instructions.md` files use `applyTo`. Nonmatching scopes are removed
  before decision calls when task paths are supplied. Unknown task paths keep
  scoped rules. Files marked `alwaysApply: true` or `applies: always` are
  skipped ([Always-on files](#always-on-files)).
- **Locations:** Instructions record their real directory. Named task files
  give closer parent instruction files a stronger `instruction-location`
  signal. Other directories receive no location signal.
- **Dates:** Every file gets a date. Each reader chooses it in its own
  order, and the date's `meaning` records which source it came from:
  - **`markdown()` inside git:** the last committed change, `changed`,
    ahead of frontmatter. A file with no commit yet, or with uncommitted
    changes, gets its modified time, `modified`.
  - **`markdown()` outside git:** a declared date (`date` supplies
    `recorded`, `updated` supplies `changed`, and `written`, `effective`
    and `applies-from` keep their meanings), else the file's modified
    time, `modified`.
  - **`knowledgeBase()` and `rules()`:** a declared date, else the last
    committed change, `changed`, else the modified time, `modified`, for
    a file with no commit yet, with uncommitted changes, or outside a
    repository. `rules()` reads no git history, so a rule with no
    declared date gets its modified time.
  - **A pinned read:** the revision's commit dates, never a modified time.
- **Pins:** Every kind reads the requested revision's contents and dates.
  Explicit exclusions still apply before content is opened.
- **Ranking:** `pick` accepts `ranking: { docs: { bm25: 2 } }` to weight signals
  by candidate kind when candidates have no search ranks. Omitted weights are 1. The pick record stores these weights.
  The source's `keyword` settings retain the exported Markdown defaults.

`knowledgeBase()` retains its directory interface, ids, date precedence,
part handling, and ranking signals. `rules()` keeps its directory interface
and ranking signals. Its rule ids are the relative file name plus the heading
path, as for `markdown()` rules. Use `markdown()` for the
kinds and location behaviour described here.

## Usage

```ts
import { pickFromSources } from '@curatejs/core';
import { knowledgeBase, rules } from '@curatejs/markdown';

const sources = [knowledgeBase('docs'), rules('rules')];
// Supply your own decision function.
const picked = await pickFromSources(sources, { task }, { task, decide });
```

## Defaults and overrides

`markdown()` and `knowledgeBase()` read with `markdownSettings`, `{ rare: true, labels: false, names: true, bar: 0.0146 }`: a name lane for each name the task names, references kept when scored 0.0146 or more,
ordered and weighted by decision probability, and no label kinds.
Set `everyScored: true` on the pick to keep every scored reference from every source.
`rules()` reads with `rulesSettings`, `{ ...markdownSettings, names: false, ruleBar: 0.5 }`, so it keeps a rule scored 0.5 or more and opens no name lane: rules are chosen by where they apply, not by search.
0.5 is a starting value, not yet tuned; it will be fitted on the 160-task rules test.
`markdown()` with kind `rules` or `instructions` keeps every scored rule, since an absent rule bar is 0.
For a rule library, use `rules()`, or set `ruleBar` through `historySource()`.
The curator receives exact scores. Its `tiers` instructions ask for less space for low-scored items.
The rare-word round finds unselected notes that share rare words with selected notes, counting words over this source only.
To change a setting, build the source with core's `historySource()`:

```ts
import { historySource } from '@curatejs/core';
import { rules, rulesSettings } from '@curatejs/markdown';

const source = historySource({ reader: rules('rules'), ...rulesSettings, ruleBar: 0.7 });
```

See [core's measured reason](https://github.com/jonny981/curate/blob/main/packages/core/README.md#defaults-and-evidence) for the saved-decision sweep's answer-turn losses.

- **Keyword settings:** `MARKDOWN_KEYWORD_SETTINGS` exports the ranking defaults. Pass a partial `keyword` object to the reader to override them.
- **Questions:** `markdownSettings` carries `MARKDOWN_CASCADE`, the fitted question set `markdown()`, `knowledgeBase()` and `rules()` ask of each reference part. Core's `memory()` and `pickFromSources()` ask it. Change it with `historySource({ reader: knowledgeBase('docs'), ...markdownSettings, questions: mySet })`. Rule candidates keep their separate applicability question. The git and Markdown sets were fitted on saved answers about commits and notes. No end-to-end score has measured them.
- **Search wording:** `MARKDOWN_SEARCH_LINE_REGISTER` describes the wording for host-written extra search lines. Copy or replace this text in your host; the package generates no lines.
- **Kind phrases:** `MARKDOWN_KIND_PHRASES` exports phrases in the note register for `directions`, `decisions` and `corrections`. Pass one list to core's `kindLanes` option, for example `{ markdown: MARKDOWN_KIND_PHRASES.corrections }`; kind lanes stay off by default.

```ts
import { knowledgeBase, MARKDOWN_KEYWORD_SETTINGS, MARKDOWN_CASCADE, MARKDOWN_SEARCH_LINE_REGISTER } from '@curatejs/markdown';

const source = knowledgeBase('docs', { keyword: { b: 0 } });
```

`rules(directory, { keyword })` accepts the same overrides.

See [core](https://github.com/jonny981/curate/blob/main/packages/core/README.md) for selection, search lines, optional cuts and curation.

## Decay

Decay ranks older notes lower, by their age at the task date.
It is off out of the box.

- **The signal:** each dated part gets the signal `decay`, `replacedWeight × (1 − 2^(−age / halfLife))`.
  With the default `replacedWeight` of −2 it starts at 0 and falls towards −2 as the note ages.
  So decay alone never ranks a note lower than the replaced mark does.
- **The age:** the time from the note's date to the task date (`taskDate`, else now).
  A bare date counts from the start of that day, and a bare task date means the end of that day, so a note dated on the task date has aged almost a day.
- **The note's date:** the one the reader gives the part.
  `knowledgeBase()` and `rules()` prefer a declared date, and `markdown()` in a repository prefers the last commit date.
  A file with no commit or with uncommitted edits gets its modified time.
- **No decay:** for a part with no date, and for a note dated after the task date, such as one with a future `effective` date.
- **What it changes:** the order of a read and its lane cut.
  It never removes a part by itself, but a part the lane cut leaves out does not reach the decision model.

It is off because a knowledge base's most relied-on pages are often its oldest, and decay would rank them lower.
It also shapes the lane cut, so it can drop an old page before the decision model sees it.
Turn it on for a folder that is a log, such as meeting notes or ops reports:

```ts
import { historySource } from '@curatejs/core';
import { knowledgeBase, markdownSettings } from '@curatejs/markdown';

const source = historySource({ reader: knowledgeBase('notes/ops'), ...markdownSettings, decay: { halfLife: '180 days' } });
```

`halfLife` is a positive number and one of seconds, minutes, hours, days or weeks: the age at which a note has lost half of the full decay.
Decay acts on the reads `pickFromSources()` and `memory()` make.
`historySource()` throws when the reader is not a Markdown source.
The record's `levers.sources[id].decay` holds the half-life.
Its `effects` entry counts the parts the source's search lanes, taken together, kept or left out only because of decay.

## Reviewing notes

`reviewNotes()` asks the decision model which notes look retired and which parts state lasting rules.
It returns proposals and never edits a file.

```ts
import { reviewNotes } from '@curatejs/markdown';

// Supply your own decision function.
const { proposals, record } = await reviewNotes({ paths: ['notes'], kind: 'knowledge', decide, taskDate: '2025-06-02' });
```

It reads the notes `markdown()` reads with the same options, with the same parts, dates and replaced marks.
It asks each part two questions through the decide port `pick` uses:

- **`stale`:** as of the review's date, does this part describe something that is no longer true, no longer done, or replaced by a later decision?
- **`lasting`:** does this part state a lasting rule, decision or fact that people rely on beyond one event?

Each question carries the part's date and the review's date.

- **Retire:** proposed when every part of a note answers `stale` at or above the bar.
  A note with one current part is not proposed.
- **Promote:** proposed when any part answers `lasting` at or above the bar.
  It names those parts, so you can move them into the rules a `rules()` source reads.
  It makes no edit, because only you know where your rules live.
- **Questions not asked:** a note already marked replaced is not asked `stale`.
  A rules source (`kind: 'rules'` or `'instructions'`) is not asked `lasting`.
- **The bar:** 0.5 by default, the label lane's bar. Set it with `bar`.
- **The record:** the review's date and time zone, the bar, the decider's `deciderId`, the notes, parts and questions, and each question a stop or a failed batch left unanswered.

The decision model sees one part at a time.
It cannot see the newer note that replaced an old one, so look at a note before you mark it.

### Applying a retire

Add the proposal's `edit` line, `status: retired`, to the note's front matter.
A note with no front matter needs the line inside a `---` block at its top.
`markdown()` and `knowledgeBase()` then rank the note lower with the `replaced` signal, and never remove it for the mark.
`rules()` does not read the mark.
Delete the line to undo it.
