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
it without asking. Rules and instruction sources emit role `rule`; a note can
never declare itself one.

## Files, globs, and kinds

`markdown({ paths, kind })` reads folders, individual files, or glob patterns.
Paths beginning with `~/` resolve against the user's home directory. Git-ignored
paths, `.git`, and `node_modules` are skipped before file contents are opened.
Markdown files include `.md`, `.markdown`, `.mdc`, and `.cursorrules`.

```ts
import { markdown } from '@curatejs/markdown';

const sources = [
  markdown({ paths: ['notes'], kind: 'knowledge' }),
  markdown({ paths: ['docs'], kind: 'docs' }),
  markdown({ paths: ['.agents/rules'], kind: 'rules' }),
  markdown({ paths: ['**/AGENTS.md'], kind: 'instructions' }),
];
```

- **Kinds:** Knowledge and docs are references; rules and instructions are
  rules. Candidate, question, and selection records retain the declared kind.
  Without a fitted cascade, core asks a question suited to that kind.
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
- **Scopes:** Cursor `.mdc` files use `globs` and `alwaysApply`; Copilot
  `*.instructions.md` files use `applyTo`. Nonmatching scopes are removed
  before decision calls when task paths are supplied. Unknown task paths keep
  scoped rules. `alwaysApply: true` and `applies: always` keep rules without
  a decision call.
- **Locations:** Instructions record their real directory. Named task files
  give closer parent instruction files a stronger `instruction-location`
  signal. Other directories receive no location signal.
- **Dates:** Inside git, the last committed change supplies meaning `changed`,
  ahead of frontmatter. Untracked files have no commit date. Outside git,
  `date` supplies `recorded`, `updated` supplies `changed`, and file modification
  time supplies `modified` when no date field is declared. Existing `written`,
  `effective`, and `applies-from` meanings remain supported.
- **Pins:** Every kind reads the requested revision's contents and dates.
  Explicit exclusions still apply before content is opened.
- **Ranking:** `pick` accepts `ranking: { docs: { bm25: 2 } }` to weight signals
  by candidate kind when candidates have no search ranks. Omitted weights are 1. The pick record stores these weights.
  The source's `keyword` settings retain the exported Markdown defaults.

`knowledgeBase()` and `rules()` retain their directory interface, ids, date
precedence, part handling, and ranking signals. Use `markdown()` for the kinds,
scopes, and location behaviour described here.

## Usage

```ts
import { pickFromSources } from '@curatejs/core';
import { knowledgeBase, rules } from '@curatejs/markdown';

const sources = [knowledgeBase('docs'), rules('rules')];
// Supply your own decision function.
const picked = await pickFromSources(sources, { task }, { task, decide });
```

## Defaults and overrides

Core's `agent-tasks` mode, which runs when no mode is chosen, decides every ranked part and keeps references scored 0.0146 or more,
ordered and weighted by decision probability.
Set `everyScored: true` to keep every scored reference.
The curator receives exact scores. Its `tiers` instructions ask for less space for low-scored items.
The source enables the rare-word round to find unselected references that share rare words with selected evidence.
Spread the source and set `rare: false` to disable that round for it.
Labels are off in the `agent-tasks` mode.
Rules keep every scored item; set `thresholds.rule` for an optional applicability cut.
See [core's measured reason](https://github.com/jonny981/curate/blob/main/packages/core/README.md#defaults-and-evidence) for the saved-decision sweep's answer-turn losses.

- **Keyword settings:** `MARKDOWN_KEYWORD_SETTINGS` exports the ranking defaults. Pass a partial `keyword` object to the reader to override them.
- **Questions:** `markdown()` carries `MARKDOWN_CASCADE`, its fitted question set. Core's `memory()` uses it automatically; override it with `pick.cascadesByKind.markdown`. With `pickFromSources()` or `pick()`, pass it through `cascade` or `cascadesByKind` explicitly. Rule candidates keep their separate applicability question.
- **Search wording:** `MARKDOWN_SEARCH_LINE_REGISTER` describes the wording for host-written extra search lines. Copy or replace this text in your host; the package generates no lines.
- **Kind phrases:** `MARKDOWN_KIND_PHRASES` exports phrases in the note register for `directions`, `decisions` and `corrections`. Pass one list to core's `kindLanes` option, for example `{ markdown: MARKDOWN_KIND_PHRASES.corrections }`; kind lanes stay off by default.

```ts
import { knowledgeBase, MARKDOWN_KEYWORD_SETTINGS, MARKDOWN_CASCADE, MARKDOWN_SEARCH_LINE_REGISTER } from '@curatejs/markdown';

const source = knowledgeBase('docs', { keyword: { b: 0 } });
```

`rules(directory, { keyword })` accepts the same overrides.

See [core](https://github.com/jonny981/curate/blob/main/packages/core/README.md) for selection, search lines, optional cuts and curation.
