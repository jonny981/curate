# Curate

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

See the [core package README](packages/core/README.md) for requirements, sources, and usage.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```
