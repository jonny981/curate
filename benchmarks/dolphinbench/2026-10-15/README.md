# Curate on DolphinBench: every part decided and kept, 30-test slice

Curate's package, with every part decided and kept, wrote a dated, cited memory log for each test from the person's whole history.
An agent (GPT-5.6 Luna, high reasoning, through the Codex CLI) read the log and used the test's app tools. The
benchmark's own grader checked the app calls; its model-judged checks ran on gpt-5.6-sol (medium) through Codex.

**Result: 23 of 30.** On the same tests Mem0's published run passed 20. The agent with no
memory passed 0; with the test's own fact messages it passed 29.

## Small print

- **Unofficial.** Not a DolphinBench submission. The judge is gpt-5.6-sol through Codex, not the benchmark's Azure
  judge. On Mem0's published tool calls for these 30 tests it agreed with Mem0's published verdicts on 30 of 30 test verdicts and 29 of 29 judged checks.
- **A slice, not the benchmark.** 30 of the 600 tests: every 20th test for each of the three people. One test is 3.3
  points. On small slices like this, published systems move several points and change order.
- **A different harness.** The agent runs in the Codex CLI, not Hermes, with the same model and reasoning setting as
  the published runs. Codex's settings: the test's app tools only (no shell, file, web or sub-agent tools), no
  personal instructions, and a short assistant identity. Usage is recorded per turn, not per model response.
- **One run.** Each test ran once. An earlier repeat of the fact-message control changed six of 26 results.
- **Same curation settings for every test.** Every log was written in batches of 150,000
  estimated tokens. Curator calls that ended with no reply were retried from the same saved decisions and batches: morgan/020 (1x), morgan/040 (1x), alex/180 (1x), alex/200 (1x), riley/120 (2x), riley/160 (2x).
- **List cost.** Jev at the price paid; the curator (gpt-6.1-sol, on a ChatGPT plan here) at $2 per million input and
  $10 per million output tokens; the agent at DolphinBench's own GPT-5.6 Luna rates. The judge is left out, as in the
  published costs. Total $97.29 for 30 tests, $3.24 a test; Mem0's published run cost
  $96.21 for 600, $0.16 a test, including its one-off memory building.
- **Scrubbed.** Local folder paths, account names, private terms and key shapes were removed before writing; the
  bundle was scanned again afterwards and is clean. Part IDs in the logs lost their local folder prefix, so each log
  here differs from the one the agent read only in those IDs; `figures.json` keeps the SHA-256 of the log as read. A
  control file with 14 planted items was scrubbed first: the scan caught 14 before and
  0 after.

## Files

- `results.md`, `results.json`: per test and in total.
- `tests/<person>-<test>/`: `request.json`, `curated-log.md`, `app-calls.json` (from the app server's own log),
  `agent-reply.md`, `verdict.json` (every check, with the judge's reasons and prompts), `figures.json`.
- `SHA256SUMS`: check with `shasum -a 256 -c SHA256SUMS`.

The benchmark (DolphinBench, Apache 2.0) is at release commit 81cb6f8.
