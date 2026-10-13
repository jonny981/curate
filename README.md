# Curate

Curate selects the evidence an agent needs for a task. It ranks candidates,
asks your decision function which ones matter, and asks your writer to turn
selected evidence into a dated log. Both steps return a record. The host
chooses the model route; these packages import no model engine.

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
