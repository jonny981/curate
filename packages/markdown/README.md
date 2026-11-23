# @curatejs/markdown

Reads Markdown notes, docs and rule files, so Curate can pick evidence from them.
It depends only on `@curatejs/core` and calls no model or network service.

It has three readers:

| Reader | What it reads | Use it for |
| --- | --- | --- |
| `markdown({ paths, kind })` | Folders, files and glob patterns | Any Markdown. You say what [kind](#kinds) it is. |
| `knowledgeBase(dir)` | One folder of notes | A [knowledge base](#knowledge-bases), including an [Open Knowledge Format](#open-knowledge-format) bundle. |
| `rules(dir)` | One folder of rules | A [rule library](#rule-library): many small rules, of which a task needs a few. |

## Install

```bash
pnpm add @curatejs/core @curatejs/markdown
```

You need Node.js 22.20 or later.
Git on your `PATH` adds revision pins and dates from commits.
Without it, an unpinned read doesn't use commit dates.

## Example

```ts
import { pickFromSources } from '@curatejs/core';
import { knowledgeBase, rules } from '@curatejs/markdown';

const sources = [knowledgeBase('docs'), rules('rules')];
// Supply your own decision function.
const picked = await pickFromSources(sources, { task }, { task, decide });
```

## Options

`knowledgeBase(dir, options)` and `rules(dir, options)` take their folder first. `markdown(options)` takes it in `paths`.

| Option | Readers | Default | What it does |
| --- | --- | --- | --- |
| `paths` | `markdown()` | required | Folders, files or glob patterns. `~/` means your home folder. |
| `kind` | `markdown()` | required | `knowledge` or `docs` for reference material, `rules` or `instructions` for rules. See [Kinds](#kinds). |
| `since` | all | no limit | Only parts dated at or after an ISO date, or a duration such as `'14 days'`. See [Dates](#dates). |
| `exclude` | all | none | Files to skip. An excluded file is never opened. |
| `maxQuestionText` | `markdown()`, `knowledgeBase()` | none for `markdown()`, 700 for `knowledgeBase()` | The most characters in a part. Longer text is cut at line ends into parts that keep every character. |
| `keyword` | all | `MARKDOWN_KEYWORD_SETTINGS` | Your changes to the keyword ranking. See [Keyword settings](#keyword-settings). |
| `index` | all | on | `{ directory }` picks where the index file goes, and `false` reads the files directly every time. See [Stored index](#stored-index). |
| `repository` | `markdown()`, `knowledgeBase()` | the work tree's top folder | The key shared with `git()` that links a commit to the notes it changed. |

`exclude` is added to the read request's `exclude` for this source only, so another source over the same folder still reads those files.
The pick's levers record `since` and `exclude`.

## What it reads

`markdown()` reads `.md`, `.markdown`, `.mdc` and `.cursorrules` files.
It skips git-ignored paths, `.git` and `node_modules` before it opens anything.

### Kinds

`knowledge` and `docs` are reference material, and `rules` and `instructions` are rules.
A note can never declare itself a rule.
Candidate, question and selection records keep the declared kind, and a source without a question set asks a question suited to its kind.

```ts
import { markdown, rules } from '@curatejs/markdown';

const sources = [
  markdown({ paths: ['notes'], kind: 'knowledge' }),
  markdown({ paths: ['docs'], kind: 'docs' }),
  rules('.cursor/rules'),
];
```

`markdown()` keeps reference text whole: it has no default part size.
Set `maxQuestionText` on the source or the read request to split text into parts that keep every character, and a pick's text limit wins over the read request's.
Core's pick, too, shows a part's full text unless you set a cut.
Rules split as in the [rule library](#rule-library), with ids from the file and heading path.

Every `markdown()` kind can be pinned to a revision.
The reader then reads that revision's contents and dates, and still applies exclusions before it opens anything.

`knowledgeBase()` and `rules()` keep their own ids, date order, part handling and ranking signals, and each takes one folder.
For kinds and [instruction locations](#rule-scopes-and-locations), use `markdown()`.

### Knowledge bases

`knowledgeBase(dir)` reads a folder of notes, one `reference` part per `## ` section of each `.md` file.
A section longer than `maxQuestionText` (700 characters by default) is offered in parts cut at line ends, so every part is judged.
A note's own date comes first, from its frontmatter; [Dates](#dates) has the order.

A note that says it was replaced keeps its parts but ranks lower, with a negative signal.
It's never hidden.
The words that mark it are `superseded`, `retired`, `deprecated`, `obsolete` and `withdrawn`, in its frontmatter or body.

Notes inside a repository also carry `path`, their file relative to the repository, and `repository`.
That's what lets a selected commit link them in.

A `revision` pin reads the tree that revision names: the earlier contents, no later files, and the resolved SHA on the result.

### Rule library

`rules(dir)` reads a folder of many small rules, and the decision model picks the ones a task needs.
It reads plain `.md` rule files, Cursor `.mdc` files and Copilot `*.instructions.md` files.
It skips names that start with a dot, and the folder's `README.md`.

A heading or an unindented list item starts a rule, and each rule repeats the text of the heading above it.
A file with no heading or list item is one rule, and nested lists and fenced code stay whole.
Every part has role `rule`, and its id is the relative file name plus the heading path, as for `markdown()` rules.

A `.mdc` file's `description` goes into each of its rules' titles, as `<file name>: <description>`, so the decision model sees what the rule is for.
The rule's text stays its own.

A rule the decision model answers 0.5 or more for is kept, and it reaches the agent as its exact text.
The rest are dropped.
To change the bar, see [Defaults and overrides](#defaults-and-overrides).
`rules()` can't read a pinned revision: a pinned read returns `absent`.

### Rule scopes and locations

A `.mdc` file's `globs` and a `*.instructions.md` file's `applyTo` limit its rules to tasks whose paths match.
Inside a git repository, task paths and scopes are both read from the repository root; outside one, from the library folder.
When the task gives paths, rules whose scope doesn't match are removed before any decision call.
When it gives none, scoped rules are kept.

With kind `instructions`, `markdown()` records each file's real folder.
An instructions file in a folder that holds a file the task names gets an `instruction-location` signal, stronger the closer it is to that file.
Files in other folders get none.

## Always-on files

An agent harness loads its own always-on files every session, so Curate leaves them to it.
Every source that reads rules (`rules()`, and `markdown()` with kind `rules` or `instructions`) skips:

- **Files a harness loads by name:** `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `GEMINI.md`, `.cursorrules` and `.github/copilot-instructions.md`.
- **Files whose frontmatter says they're always on:** Cursor's `alwaysApply: true`, or `applies: always`.

A skipped file is never asked about and adds nothing to the laid-out text or the rules.
The read lists each one with its reason in `alwaysOnSkipped`, and the pick record's `effects` names them.
Knowledge and docs sources read these files as usual.

## Dates

Every file gets a date, and the date's `meaning` says where it came from.
Each reader picks it in its own order:

- **`markdown()` inside a repository:** the last committed change (`changed`), ahead of frontmatter. A file with no commit yet, or with uncommitted changes, gets its modified time (`modified`).
- **`markdown()` outside a repository:** a frontmatter date, else the file's modified time (`modified`).
- **`knowledgeBase()` and `rules()`:** a frontmatter date, else the last committed change (`changed`), else the modified time (`modified`) for a file with no commit yet, with uncommitted changes, or outside a repository. `rules()` reads no git history, so a rule with no frontmatter date gets its modified time.
- **A pinned read:** the revision's commit dates, never a modified time.

Frontmatter dates are checked in this order, and the first one set wins:

| Field | Meaning |
| --- | --- |
| `date` | `recorded` |
| `updated` (`markdown()` only) | `changed` |
| `written` | `recorded` |
| `effective` | `effective` |
| `applies-from` | `effective` |
| `generated.at` | `changed` |
| `timestamp` | `changed` |

`since` takes an ISO date, or a duration such as `'14 days'` counted back from the task date.
The task date is the read request's `taskDate`, else its `asOf`, else now.
A part dated before the cutoff isn't read.
A part with no date is read, and a bare day keeps the whole cutoff day.

## Open Knowledge Format

`knowledgeBase()` reads an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format) bundle, v0.1 and v0.2: a folder of Markdown pages with frontmatter, plus `index.md` and `log.md`.
A page with an unknown type, an unknown key, a missing field or a broken link is read like any other.

| Field or file | What Curate does |
| --- | --- |
| `generated.at` | The page's date, meaning `changed`. Read in block form (`generated:` with `at:` indented under it) and flow form (`generated: { by: x, at: y }`). |
| `timestamp` | The page's date, meaning `changed`, when `generated.at` is absent. |
| `title`, `type`, `description` | Each one set goes into every part title of the page, after its path: `decisions/db.md (Use Postgres; decision; Why billing uses Postgres.): Links`. `markdown()` does the same. |
| `status` | `deprecated` ranks the page lower with the `replaced` signal. `draft` and `stable` change nothing. |
| `stale_after` | At or before the task's moment, the page ranks lower with the `replaced` signal. The moment is `taskDate`, where a bare date means the end of that day, else now. The page is never removed for it. |
| `/` links | A link such as `[B](/tables/b.md)` is read from the folder the reader was given and counts toward `inbound-links`. `markdown()` does the same. |
| `index.md` | Not a page, at any level. It gives no parts, and its links don't count. `markdown()` still reads it as a page. |
| `log.md` | Read as a page. A section whose heading starts with a day (`## 2026-10-27`, `## [2026-10-28] update \| Title`, `## [2026-10-28 19:40:00] ingest \| Title`) carries that day, meaning `recorded`, ahead of the page's own date. A section without one keeps the page's date. |

Some fields have no handling of their own: `sources`, `verified`, `usage_window`, `resource`, `tags` and the Attested Computation fields.
Like all frontmatter, their words count toward the `file-words` signal, and a replaced word among them, such as `deprecated`, ranks the page lower.
They aren't part text, so the decision model doesn't read them.

## Decay

Decay ranks older notes lower, by their age at the task date.
It's off by default, because a knowledge base's most relied-on notes are often its oldest, and decay would rank them lower.
Turn it on for a folder that's a log, such as meeting notes or ops reports:

```ts
import { historySource } from '@curatejs/core';
import { knowledgeBase, markdownSettings } from '@curatejs/markdown';

const source = historySource({ reader: knowledgeBase('notes/ops'), ...markdownSettings, decay: { halfLife: '180 days' } });
```

`halfLife` is a positive number and one of seconds, minutes, hours, days or weeks: the age at which a note has lost half of the full decay.
Decay acts on the reads `pickFromSources()` and `memory()` make.
`historySource()` throws when the reader isn't a Markdown source.

Each dated part gets the signal `decay`, `replacedWeight × (1 − 2^(−age / halfLife))`.
With the default `replacedWeight` of −2, it starts at 0 and falls towards −2 as the note ages.
So decay alone never ranks a note lower than the replaced mark does.

The age runs from the part's date, as [Dates](#dates) lists, to the task date (`taskDate`, else now).
A bare date counts from the start of that day, and a bare task date means the end of that day, so a note dated on the task date has aged almost a day.
A part with no date doesn't decay, and nor does a note dated after the task date, such as one with a future `effective` date.

Decay changes the order of a read and its lane cut.
It never removes a part by itself, but a part the lane cut leaves out doesn't reach the decision model.
The pick record's `levers.sources[id].decay` holds the half-life, and its `effects` entry counts the parts the source's search lanes, taken together, kept or left out only because of decay.

## Reviewing notes

`reviewNotes()` asks the decision model which notes look retired and which parts state lasting rules.
It returns proposals and never edits a file.

```ts
import { reviewNotes } from '@curatejs/markdown';

// Supply your own decision function.
const { proposals, record } = await reviewNotes({ paths: ['notes'], kind: 'knowledge', decide, taskDate: '2025-06-02' });
```

It reads the notes `markdown()` reads with the same options, with the same parts, dates and replaced marks.
It asks each part two questions through the decide port `pick` uses, and each question carries the part's date and the review's date:

- **`stale`:** as of the review's date, does this part describe something that is no longer true, no longer done, or replaced by a later decision?
- **`lasting`:** does this part state a lasting rule, decision or fact that people rely on beyond one event?

It proposes two things:

- **Retire** a note when every part of it answers `stale` at or above the bar. A note with one current part isn't proposed.
- **Promote** parts when any part answers `lasting` at or above the bar. The proposal names those parts, so you can move them into the rules a `rules()` source reads. It makes no edit, because only you know where your rules live.

A note already marked replaced isn't asked `stale`, and a rules source (`kind: 'rules'` or `'instructions'`) isn't asked `lasting`.
The bar is 0.5 by default, the label lane's bar; set it with `bar`.
The record holds the review's date and time zone, the bar, the decider's `deciderId`, the notes, parts and questions, and each question a stop or a failed batch left unanswered.

The decision model sees one part at a time.
It can't see the newer note that replaced an old one, so look at a note before you mark it.

### Applying a retire

Add the proposal's `edit` line, `status: deprecated`, to the note's frontmatter.
`deprecated` is the Open Knowledge Format status word, and a note with no frontmatter needs the line inside a `---` block at its top.
`markdown()` and `knowledgeBase()` then rank the note lower with the `replaced` signal, and never remove it for the mark; `rules()` doesn't read the mark.
To undo it, delete the line.

## Memory use

One `pickFromSources` call reads a file's bytes once across overlapping sources and search lines, up to a 64 MB shared cap.
Past the cap, each pass reads from disk again, so a large corpus is never held whole.
Different kinds keep separate parts, and a later call reads the file again.

A keyword read parses each file once for keyword statistics, scores the parts on a second read, and builds candidates only for the parts its lane kept.
A pinned read fetches file contents from git in bounded batches the same way.

## Stored index

Every reader here keeps one local file per source by default, made on its first read.
Each call reads again only the notes that are new or changed in size or modified time, and every lane reads the file instead of parsing the notes again.
The folder walk and the git date lookups run once per call.

A read pinned to a revision reads the files as before.
The file goes in `~/.cache/curate/index`, or `$XDG_CACHE_HOME/curate/index` if that's set.
Set `index: { directory }` to choose the folder, or `index: false` to read the files directly every time.

Core's [Stored index](https://github.com/jonny981/curate/blob/main/packages/core/README.md#stored-index) has the detail.

## Defaults and overrides

`markdown()` and `knowledgeBase()` read with `markdownSettings`, `{ rare: true, labels: false, names: true, bar: 0.0146 }`:

- **Rare-word round on:** it finds unselected parts that share rare words with selected ones, counting words over this source only.
- **No labels.**
- **Name lanes:** one for each name the task names.
- **A bar of 0.0146:** references scoring 0.0146 or more are kept, ordered and weighted by decision probability.

`rules()` reads with `rulesSettings`, `{ ...markdownSettings, names: false, ruleBar: 0.5 }`.
It opens no name lane, because rules are chosen by where they apply, not by search.
0.5 is a starting value, not yet tuned; it will be fitted on the 160-task rules test.

`markdown()` with kind `rules` or `instructions` keeps every scored rule, since an absent rule bar is 0.
For a rule library, use `rules()`, or set `ruleBar` through `historySource()`.

Set `everyScored: true` on the pick to keep every scored reference from every source.
Core's `curate()` lays out the kept parts by their exact scores, strongest first.

To change a setting, build the source with core's `historySource()`:

```ts
import { historySource } from '@curatejs/core';
import { rules, rulesSettings } from '@curatejs/markdown';

const source = historySource({ reader: rules('rules'), ...rulesSettings, ruleBar: 0.7 });
```

Core's [Defaults and evidence](https://github.com/jonny981/curate/blob/main/docs/measurements.md#defaults-and-evidence) explains the 0.0146 bar: in its saved-decision sweep, higher bars dropped whole answer turns.

### Keyword settings

`MARKDOWN_KEYWORD_SETTINGS` holds the ranking defaults.
Pass a partial `keyword` object to the reader to change them:

```ts
import { knowledgeBase, MARKDOWN_KEYWORD_SETTINGS, MARKDOWN_CASCADE, MARKDOWN_SEARCH_LINE_REGISTER } from '@curatejs/markdown';

const source = knowledgeBase('docs', { keyword: { b: 0 } });
```

`rules(directory, { keyword })` takes the same changes.

To weight signals by kind, pass `ranking` to the pick, for example `ranking: { docs: { bm25: 2 } }`.
It applies when parts have no search ranks.
Weights you leave out are 1, and the pick record stores the weights.

### Question sets

`markdownSettings` carries `MARKDOWN_CASCADE`, the fitted question set `markdown()`, `knowledgeBase()` and `rules()` ask of each reference part.
Change it with `historySource({ reader: knowledgeBase('docs'), ...markdownSettings, questions: mySet })`.
Rule parts keep their own question, whether the rule applies.

The git and Markdown sets were fitted on saved answers about commits and notes.
No end-to-end score has measured them.

### Search wording and kind phrases

`MARKDOWN_SEARCH_LINE_REGISTER` describes how to word extra search lines your host writes.
Copy or replace the text in your host: the package writes no lines itself.

`MARKDOWN_KIND_PHRASES` holds phrases in note wording for `directions`, `decisions` and `corrections`.
Pass one list to core's `kindLanes` option, for example `{ markdown: MARKDOWN_KIND_PHRASES.corrections }`.
Kind lanes are off by default.

See [core](https://github.com/jonny981/curate/blob/main/packages/core/README.md) for selection, search lines, optional cuts and curation.
