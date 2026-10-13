# @curatejs/markdown

Read Markdown notes and rule files as task evidence. The package depends only on
`@curatejs/core`; it calls no model or network service.

## Install

```bash
pnpm add @curatejs/core @curatejs/markdown
```

## Requirements

Node.js 22.12 or later. Git on `PATH` enables revision pins and committed change dates. An unpinned read without git skips the repository date tier.

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

## Usage

```ts
import { pickFromSources } from '@curatejs/core';
import { knowledgeBase, rules } from '@curatejs/markdown';

const sources = [knowledgeBase('docs'), rules('rules')];
// Supply your own decision function.
const picked = await pickFromSources(sources, { task }, { task, decide });
```

## Defaults and overrides

Core keeps every scored reference by default, ordered and weighted by
decision probability. Set `thresholds.reference` for an optional single
cut, for example 0.05. The curator receives exact scores. Its `tiers`
instructions ask for less space for low-scored items.
Rules retain their separate applicability bar. See
[core's measured reason](../core/README.md#defaults-and-evidence) for the
saved-decision sweep's answer-turn losses.

- **Keyword settings:** `MARKDOWN_KEYWORD_SETTINGS` exports the ranking defaults. Pass a partial `keyword` object to the reader to override them.
- **Questions:** `MARKDOWN_CASCADE` exports the fitted questions. Pass the cascade to core’s `cascade` or `cascadesByKind` option. The defaults are opt-in.
- **Search wording:** `MARKDOWN_SEARCH_LINE_REGISTER` describes the wording for host-written extra search lines. Copy or replace this text in your host; the package generates no lines.

```ts
import { knowledgeBase, MARKDOWN_KEYWORD_SETTINGS, MARKDOWN_CASCADE, MARKDOWN_SEARCH_LINE_REGISTER } from '@curatejs/markdown';

const source = knowledgeBase('docs', { keyword: { b: 0 } });
```

`rules(directory, { keyword })` accepts the same overrides.

See [core](../core/README.md) for selection, search lines, optional cuts and curation.
