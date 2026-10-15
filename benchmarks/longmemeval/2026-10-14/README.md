# LongMemEval S, all 500 questions, 14 October 2026

Curate's packages at their default settings, Curate commit `aacb042`. Later commits change only request sizing.

| File | Answering model | Marker | Score |
| --- | --- | --- | --- |
| `mem0-gpt-5.jsonl` | GPT-5 | GPT-5, Mem0's marking prompt | 470/500 = 94.0% |
| `mastra-gpt-5-mini.jsonl` | GPT-5-mini | GPT-4o, Mastra's marking prompt | 460/500 = 92.0% |

`scores.json` holds every combined score: all 500, the held-out 251 and the tuning 249, by question type, with context tokens and the adjusted score.

## How the run worked

1. **Rank:** the chat package's ranking over every part of the question's history.
2. **Decide:** Jev scored every part with the chat package's fitted question set (`relevant`, `own`, `needed`). Every scored part was kept.
3. **Curate:** gpt-6.1-sol, at low reasoning effort, wrote one dated, cited log from every scored part, strongest first. A log that failed the format check went back once with the reason. The curator ran on a ChatGPT plan through the Codex CLI. Every curator call also carried the CLI's own instructions and the operator's global Codex instructions file (about 6,500 tokens), which `--ignore-user-config` does not exclude.
4. **Answer:** the answering model read only the log and the question.
5. **Mark:** the marker compared each answer with LongMemEval's gold answer.

The GPT-5-mini file answers the same logs as the GPT-5 file; it asks no new decisions and writes no new logs.

## Fields

Each line is one question.

| Field | Meaning |
| --- | --- |
| `id`, `type`, `abstention` | LongMemEval's question id, question type, and whether the right answer is that the history does not say |
| `split` | `held_out` (never used to tune Curate) or `tune` |
| `question`, `question_date`, `gold_answer` | from the dataset |
| `curated_log` | the exact text the answering model read as memory |
| `context_tokens_o200k` | that text's length in o200k tokens |
| `answer_model`, `answer` | the answering model and its answer |
| `marker_model`, `correct`, `marker_reply` | the marker, its verdict and its reply |
| `jev_calls`, `jev_input_tokens` | decision requests and their billed input tokens |
| `curator_input_tokens` | the curator's input tokens for this question, including a format repair when one ran |
| `answer_cost_usd`, `mark_cost_usd` | measured cost of the answer and the mark at OpenAI's list prices |

## Recount the score

```sh
python3 -c "import json,sys; r=[json.loads(l) for l in open(sys.argv[1])]; print(sum(x['correct'] for x in r), len(r))" mem0-gpt-5.jsonl
```

## Inputs

- **Dataset:** LongMemEval S (`longmemeval_s_cleaned.json`), SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`. LongMemEval is MIT-licensed.
- **Held-out split:** 251 questions chosen before any tuning; the other 249 were used to tune Curate.
- **Harness:** a separate repository, not public. It records every model call; those request and reply bodies (about 3.3 GB) stay on the machine that ran it.

## LongMemEval's own scorer

`official-scorer/` holds the answers in LongMemEval's hypothesis format and the output of its own scorer:

- `curate-gpt-5.jsonl`, `curate-gpt-5-mini.jsonl`: one `{"question_id", "hypothesis"}` line per question.
- `*.eval-results-gpt-4o`: the scorer's verdict for every question (`autoeval_label`, judge `gpt-4o-2024-08-06`).
- `metrics.txt`: the output of LongMemEval's `print_qa_metrics.py`.

Score the answers again with LongMemEval's own code at commit `9e0b455f4ef0e2ab8f2e582289761153549043fc`:

```sh
python src/evaluation/evaluate_qa.py gpt-4o curate-gpt-5.jsonl longmemeval_s_cleaned.json
python src/evaluation/print_qa_metrics.py curate-gpt-5.jsonl.eval-results-gpt-4o longmemeval_s_cleaned.json
```

The GPT-4o judge is not fully deterministic, so a rerun can differ by a question or two.

## Economic setting

`economic/` holds the same run with one option changed: the decide step keeps only the parts Jev scored at 0.0146 or above.

```js
pick(candidates, { thresholds: { reference: 0.0146 } })
```

- **Score:** 458/500 = 91.6% with GPT-5-mini answering and GPT-4o marking (Mastra's marking prompt), against 460/500 = 92.0% when every scored part is kept. On the held-out 251 both score 235. LongMemEval's own scorer gives 90.8% (`economic/official-scorer/metrics.txt`).
- **Where 0.0146 comes from:** it is the highest cut that lost no answer message on Curate's earlier ranking, chosen on the tuning 249 only.
- **Selection:** made by Curate's package at commit `aacb042`, the same commit as the run above.
- **Decisions:** replayed from the run above's saved Jev replies, so no part was scored again. The `jev_calls` and `jev_input_tokens` fields in `economic/mastra-gpt-5-mini.jsonl` are therefore that run's figures.
- **Curator:** unchanged. gpt-6.1-sol, at low reasoning effort, reads about 70 parts a question instead of about 850.
- **One extra field:** `kept_parts` lists the parts at 0.0146 or above that went to the curator.

`scores.json` holds the economic scores under `economic.all_500`, `economic.held_out_251` and `economic.tune_249`. `economic/official-scorer/` holds the hypothesis file, the scorer's verdicts and its metrics, named as in `official-scorer/`.

## Luna curates, Sol answers

`luna-sol/` holds a pairing chosen for everyday use: gpt-6-luna writes the log and gpt-6.1-sol answers, scored by LongMemEval's own scorer.

| Questions | Luna and Sol | GPT-5 above (same scorer) | GPT-5-mini above (same scorer) |
| --- | --- | --- | --- |
| All 500 | 441 = 88.2% | 465 = 93.0% | 461 = 92.2% |
| Held-out 251 | 218 = 86.9% | 235 = 93.6% | 236 = 94.0% |
| Tuning 249 | 223 = 89.6% | 230 = 92.4% | 225 = 90.4% |

- **Curator:** gpt-6-luna, at low reasoning effort, reads every scored part, the package default, with Curate commit `aacb042` and the same decisions as the run above (replayed, so no part was scored again). Its logs are short: 158 tokens on average, against 580 for gpt-6.1-sol. Multi-session (79%) and temporal (85%) questions lose the most.
- **Answerer:** gpt-6.1-sol at its default reasoning effort, with the same answer prompt as the GPT-5 file above, through Codex with no personal instructions or skills. Codex's own event shows it could not read the global instructions file (`luna-sol/isolation-event.json`).
- **Marker:** LongMemEval's own scorer only. `luna-sol/official-scorer/metrics.txt` holds its output for all 500 and for each half.
- **Speed:** the median question took 14.0 seconds to a finished log (90th percentile 28.4), measured on the 252 questions curated in this run; deciding is timed from the run above, which made the same decisions. The median answer took 5.4 seconds (90th percentile 13.3), over all 500.

`luna-sol/mem0-gpt-6.1-sol.jsonl` has the fields of the files above, with these differences: `curator_model` names the curator; `marker_model` and `correct` come from LongMemEval's scorer, which keeps no reply text, so there is no `marker_reply`; the answers ran on a ChatGPT plan, so `answer_input_tokens` and `answer_output_tokens` replace the cost fields; `curate_seconds` and `answer_seconds` give the timings (`curate_seconds` is empty for the tuning questions whose log was written in an earlier Luna run). `scores.json` holds the pairing under `luna_sol.all_500`, `luna_sol.held_out_251` and `luna_sol.tune_249`, scored by LongMemEval's scorer.

`SHA256SUMS` lists a checksum for every file in this folder.
