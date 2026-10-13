# Curate

Curate selects the memory an agent needs for a task from typed sources. Its RDC process ranks candidates, asks your decision function which ones matter, and asks your writer to turn the selected evidence into the dated log the task needs. Selection and curation each return a record.

## RDC process

- **Rank:** Order memory candidates by their signals.
- **Decide:** Ask your decision function which candidates the task needs. Optional `cascade` combines a fitted set of narrow questions. Selected items are ordered by decision probability, with no fixed size cap. `keepTop` moves selected keyword hits to the front.
- **Curate:** Call `curate(task, picked, { write })` to write the dated log the working model reads. There is no fixed length cap. An optional `contextLimit` in characters asks the writer to condense an oversized log once, reducing the weakest signals first and keeping the strongest whole. The record reports both lengths and whether the result still exceeds the limit. Optional `working` adds working notes; `preferenceAdvice` and `preferenceChange` gather stated preferences with source ids. `taskDate` supplies the date the task was asked.

Curate started as the memory package inside [Obversa](https://github.com/jonny981/obversa).

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
