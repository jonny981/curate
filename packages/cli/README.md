# @curatejs/cli

The `curate` command. It recalls what was decided, tried or said before, from the history of the project you are in: its commits, its Markdown, and its Claude Code and Codex transcripts. It prints the strongest evidence in the speakers' own words, each part headed by where and when it was said.

## Install

```sh
npm install -g @curatejs/cli
curate setup
npx skills add jonny981/curate -g -a claude-code -a codex -y
```

The last line installs the `/curate` skill for Claude Code and Codex. The skill calls this command.

## Requirements

- **Node.js 22.20 or later.** Tested on macOS and Linux; Windows is untested.
- **A paid decision key.** Curate asks TypeSafe's Jev to rate the parts of your history, at a few pence a call. Get a key at [typesafe.ai](https://typesafe.ai) and set `TYPESAFE_API_KEY`, or put it in the private file `curate setup` creates.
- **A Claude or ChatGPT login.** One small call writes the search lines, through `claude auth login` or `codex login`.
- **An embedding model file.** `curate setup` offers to download EmbeddingGemma 300M (about 330 MB).

## Commands

- **`curate "<question>"`** prints the evidence for the question, from the project the working folder is in.
- **`curate check`** lists each need as ready or missing, with its fix. It makes no model or decision call. It exits 0 when a call would run, and 3 when it would not.
- **`curate setup`** runs the check. In a terminal it then offers, each answered no unless you type y: to download the embedding model, streaming to a `.part` file that takes the model's name only when complete; to create `~/.curate/sources.json` and a private `~/.curate/credentials.env` (mode 0600) for your key, never overwriting either; and to prepare the project. It never prompts for or prints your key. It then checks again and exits 0 or 3. Without a terminal it only prints the check, writes nothing and downloads nothing.
- **`curate prepare`** brings the stored index and embeddings of the project's history up to date, with no model call and no key. The first run reads and embeds the whole history.
- **`--sources <file>`** reads that settings file in place of `~/.curate/sources.json`. `--version` and `--help` print the version and the usage.

A word names a step only when it is the whole command line: `curate "check the retry decision"` is a question.
Any other failure exits 1.
The command hides Node's experimental-feature warning for SQLite, which the stored index uses, and no other warning.

## Settings and data

The settings, the history a call reads, and what each setting does are in the skill's [settings reference](https://github.com/jonny981/curate/blob/main/skills/curate/references/settings.md).
What a call sends to the decision service and to the search-line model is in [What leaves your machine](https://github.com/jonny981/curate#what-leaves-your-machine).

The command runs the skill's script, `skills/curate/run.mjs`, which this package ships as `dist/run.mjs`.

## License

[MIT](LICENSE).
