# Curate

Curate selects the memory an agent needs for a task from typed sources. Its RDC process ranks candidates, asks your decision function which ones matter, and returns the selected memory with a record of the decisions.

## RDC process

- **Rank:** Order memory candidates by their signals.
- **Decide:** Ask your decision function which candidates the task needs.
- **Curate:** Return the selected candidates and a record of answers, rejections, and unasked items.

[Obversa](https://github.com/jonny981/obversa) uses Curate as its memory.

## Install

```bash
pnpm add @curatejs/core
```

The host supplies its own sources and decision function.

See the [core package README](packages/core/README.md) for requirements, sources, and usage.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```
