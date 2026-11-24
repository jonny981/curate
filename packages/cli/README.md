# @curatejs/cli

The `curate` command answers a question from the history of the project you're in: its commits, its Markdown, and its Claude Code and Codex transcripts.
You get back the passages that answer it, word for word, each under a heading with its source and date.

## Install

```sh
npm install -g @curatejs/cli
curate setup
npx skills add jonny981/curate -g -a claude-code -a codex -y
```

`curate setup` checks what you need and offers to sort out what it can.
The last line installs the `/curate` skill, which lets Claude Code and Codex run the command and turn the result into a cited summary.

## Requirements

You need Node.js 22.20 or later. It's tested on macOS and Linux; Windows is untested.

You also need a paid key from [TypeSafe](https://typesafe.ai). Curate has TypeSafe's Jev rate passages from your history, at about $0.00002 a passage, and stops once the ratings go cold. Set the key as `TYPESAFE_API_KEY`, or put it in the private file `curate setup` creates.

A Claude or ChatGPT login (`claude auth login` or `codex login`) covers one small call that writes the search lines, the queries Curate searches with.
And you need an embedding model file, which `curate setup` offers to download (EmbeddingGemma 300M, about 330 MB).

The full list, with the fix for each, is in the root README's [Requirements](https://github.com/jonny981/curate#requirements).

## Commands

| Command | What it does |
| --- | --- |
| `curate "<question>"` | Prints the passages that answer the question, from the project you're in. |
| `curate check` | Shows each requirement as ready or missing, with the fix. It calls no model. |
| `curate setup` | Runs the check, then offers to fix what's missing ([below](#curate-setup)). |
| `curate prepare` | Brings the project's index and embeddings up to date. It needs no model, key or login. |
| `--sources <file>` | Uses that settings file alone, in place of `~/.curate/sources.json` and any `curate.json`. |
| `--version`, `--help` | Prints the version, or the usage. |

`check`, `setup` and `prepare` count as commands only when they're the whole command line, so `curate "check the retry decision"` is a question.

Exit codes are 0 on success, 3 when a requirement is missing, 4 when the decision service refused the call or couldn't be reached, and 1 for anything else. On exit 4 the message's first line says why and what to do.

### `curate setup`

In a terminal, `curate setup` runs the check, then asks before each of these steps. The answer is no unless you type `y`.

1. **Download the embedding model.** It streams to a `.part` file and only takes the model's name once it's complete.
2. **Create `~/.curate/sources.json` and a private `~/.curate/credentials.env`** (mode 0600) for your key. It never overwrites either file, and it never asks for or prints your key.
3. **Prepare the project.**

It then checks again and exits 0 or 3. Without a terminal it only prints the check: it writes nothing and downloads nothing.

### `curate prepare`

The first run reads and embeds the whole history, which can take a while. Run it from a hook or a scheduled job to make the next question faster.

It also deletes index files left by older versions of Curate, and lists them. A question never deletes them, since an older process might still be reading them. So don't run `prepare` while an older version of Curate is mid-run: it can't tell.

## Configuration and privacy

The root README covers [what Curate reads](https://github.com/jonny981/curate#what-it-reads), its [configuration](https://github.com/jonny981/curate#configuration), its [caches](https://github.com/jonny981/curate#caches) and [logs](https://github.com/jonny981/curate#logs), and what it sends where, in [Privacy](https://github.com/jonny981/curate#privacy).

Every setting is explained in full in the [settings reference](https://github.com/jonny981/curate/blob/main/skills/curate/references/settings.md). That includes [the rating stop](https://github.com/jonny981/curate/blob/main/skills/curate/references/settings.md#the-rating-stop): how Curate decides when to stop rating, how to tune or turn it off, and what it saved and cost on benchmarks.

## How it runs

If a question, or `curate prepare`, has slow work to do first, it tells you on standard error: what it's doing, how far it's got and roughly how long is left. That happens when it builds a source's index from scratch or embeds more than 2,000 parts. Standard output only ever holds the result.

The command runs the skill's script, `skills/curate/run.mjs`, which this package ships as `dist/run.mjs`.
It hides Node's experimental-feature warning for SQLite, which the index uses, and no other warning.

## License

[MIT](LICENSE).
