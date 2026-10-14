# Curate

Curate keeps every scored reference item by default, strongest decision
probability first. The decision function orders and weights the evidence;
it does not drop low scores. Your writer turns the evidence into a dated
log. Both steps return a record. The host chooses the model route; these
packages import no model engine.

Before any decision, `pickFromSources` cuts each search lane where its own
score curve flattens. Pass `laneCut: false` in the read request to decide
every candidate a source returns.

## Reference defaults

The reference bar is zero. A saved-decision sweep over 249 LongMemEval
questions and 445 labelled answer turns found that bars of 0.05/0.5 lost
50 whole answer turns, 0.2/0.6 lost 70, and a single 0.6 cut lost 183.
Keeping every fed item added no selection losses. That sweep decided the
full feed with no lane cut. Seven labelled turns
were absent from that feed; this check measures retention before curation,
not final answer accuracy.

Set `thresholds.reference` for an optional single cut, for example 0.05.
Rules also keep every scored item; `thresholds.rule` enables an optional
applicability cut. References with no valid
decision answer remain unanswered; limits can leave items unassessed. Selection and curation have no fixed total
character cap.

The curator receives every item’s exact decision score. Its `tiers`
instructions ask it to retain observations at 0.6 or more, include useful
facts from 0.1 to below 0.6, and use items below 0.1 only when they clearly
state a needed fact. The prompt asks for less space for low scores.

## Packages

| Package | What it supplies |
| --- | --- |
| [**@curatejs/core**](packages/core/README.md) | Selection, curation, source contracts, shared types and rank blending. No reader. |
| [**@curatejs/chat**](packages/chat/README.md) | Claude Code and Codex transcripts, secret scrubbing, chat ranking and questions. |
| [**@curatejs/git**](packages/git/README.md) | Git commit history, keyword settings and questions. |
| [**@curatejs/markdown**](packages/markdown/README.md) | Markdown notes and rules, keyword settings and questions. |

Each source package depends only on core and exports its keyword settings,
question set and wording guidance for extra searches.

## Install only what you need

```bash
# Supply your own sources.
pnpm add @curatejs/core

# Read transcripts.
pnpm add @curatejs/core @curatejs/chat

# Read commits and notes.
pnpm add @curatejs/core @curatejs/git @curatejs/markdown
```

## Usage

```ts
import { pickFromSources, curate } from '@curatejs/core';
import { chat, CHAT_CASCADE } from '@curatejs/chat';

const picked = await pickFromSources(
  [chat({ paths: ['transcripts'] })],
  { task },
  { task, decide, cascade: CHAT_CASCADE },
);
const result = await curate(task, picked, { write });
```

The host supplies `task`, `decide` and `write`. See each package’s README
for reader options and core’s README for the decision and writer contracts.

## Agent skill

The [curate skill](skills/curate/SKILL.md) runs the four packages over local
history with source-specific searches, Jev decisions and subscription
curation. Source settings and run records stay outside the repository.

```sh
node skills/curate/run.mjs "Which decisions and tried ideas bear on this task?"
```

## Development

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

Build first so dependent packages and workspace integration tests can use
core’s declarations and the package exports. Each package also supports
`pnpm --filter @curatejs/<name> build`, `test`, `typecheck` and `pack`.

## Markdown paths

`@curatejs/markdown` reads folders, files, and globs with explicit kinds.

```ts
import { markdown } from '@curatejs/markdown';

const sources = [
  markdown({ paths: ['docs'], kind: 'docs' }),
  markdown({ paths: ['.agents/rules'], kind: 'rules' }),
  markdown({ paths: ['**/AGENTS.md'], kind: 'instructions' }),
];
```

See the [Markdown package](packages/markdown/README.md) for rule scopes,
instruction locations, shared reads, dates, and whole-text defaults.
