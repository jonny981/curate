# LongMemEval S, all 500 questions, gpt-6.1-sol answering, LongMemEval's own grader

Three Curate settings, answered by gpt-6.1-sol and marked by LongMemEval's own grader (`evaluate_qa.py`, unchanged, judge `gpt-4o-2024-08-06`). Mem0's published answers were marked by the same grader in the same session as the markup setting.

| File | Setting | Answering model | Marker | Score |
| --- | --- | --- | --- | --- |
| `markup-sol.jsonl` | Markup | gpt-6.1-sol | GPT-4o, LongMemEval's grader | 469/500 = 93.8% |
| `official-scorer/same-session-2026-11-05/markup-sol.jsonl` | Markup, the same answers marked again | gpt-6.1-sol | GPT-4o, LongMemEval's grader | 467/500 = 93.4% |
| `cited-only-sol.jsonl` | Cited-only markup | gpt-6.1-sol | GPT-4o, LongMemEval's grader | 465/500 = 93.0% |
| `log-sol.jsonl` | Log | gpt-6.1-sol | GPT-4o, LongMemEval's grader | 463/500 = 92.6% |
| `official-scorer/same-session-2026-11-05/mem0-platform.jsonl` | Mem0's published answers, marked in the same session as the markup setting | GPT-5 | GPT-4o, LongMemEval's grader | 455/500 = 91.0% |
| `official-scorer/mem0-2026-10-31/mem0-platform.jsonl` | Mem0's published answers, marked alone | GPT-5 | GPT-4o, LongMemEval's grader | 453/500 = 90.6% |

The same markup answers, marked twice by the same grader, scored 469 and 467.

These results are not an untouched held-out evaluation. The markup settings and the answering prompt were developed on questions from both halves of the 22 October split, and their results were examined across all 500.

`scores.json` holds every row above by question type, with the six-type average, the memory text's mean and median o200k tokens, the history's mean, each ratio and the [adjusted score](../../README.md#adjusted-score).

## Context sizes

The memory text is everything the answering model read about the person's history. Each history averages 102,580 o200k tokens (every turn's role and text).

| Setting | Mean tokens | Median tokens | Times less than the history |
| --- | ---: | ---: | ---: |
| Markup | 844.0 | 685 | 121.5 |
| Cited-only markup | 854.4 | 688 | 120.1 |
| Log | 448.6 | 380 | 228.7 |
| Mem0, as Mem0 reports it | 6,787 | | 15.1 |

## How each setting works

All three start from the same parts of each history: the parts the [22 October run](../2026-10-22/README.md) kept, chosen by the chat package's ranking and the decision model's saved decisions.

**Markup.** The markup setting runs outside Curate's published packages.

1. **Extract:** gpt-6.1-sol, at low reasoning effort, reads the kept parts and lists every event that could bear on the question, one row per event: who, what, its status (done, planned, wished or other), the day it happened, the day it was said, any amount or quantity, and the parts it comes from, with an exact quote.
2. **Decide:** the decision model answers, for each row, whether the row counts towards the question. A row counts when the model says yes with probability 0.5 or more.
3. **Count:** code adds up the counted rows (how many, and the sums of their amounts and quantities) and lists them by date. Code, not a model, does this arithmetic.
4. **Mark up:** gpt-6.1-sol, at low reasoning effort, rewrites each kept part in the person's own words with inline tags: who did something, whether it was done, planned or only wished, its date, amounts, counts, feelings and tone.
5. **Assemble:** the memory text is the code's figures and counted rows, then the marked-up words of only the parts that some extracted row cites.

**Cited-only markup.** The same as the markup setting, except that step 4 marks up only the parts that some extracted row cites, instead of every kept part. The figures and rows are byte-identical to the markup setting's on all 500 questions; only the marked-up words differ, because each part is marked up beside fewer neighbours. It reads and writes far less, which makes the markup step several times faster.

**Log.** The 22 October run's curated logs, byte for byte: the curator, gpt-6.1-sol at low reasoning effort, wrote one dated, cited log per question from the kept parts. This is what Curate's published packages write. Here gpt-6.1-sol answers from it in place of GPT-5.

## Answering

- **Model:** gpt-6.1-sol, at medium reasoning effort, on a ChatGPT plan through the Codex CLI.
- **Prompt:** Mem0's answering prompt from its benchmark, with its single-question rules removed. Every general rule stays: answer from the memories, compute relative dates from the question date, count completed items with their dates, prefer the most recent value, and decline when the memories do not cover the question. What was removed are lines written for one particular test question; examples whose subject appears in a LongMemEval question, answer or evidence session were replaced with invented ones.
- **Input:** the benchmark fields supplied to the answer prompt are the question, its date and the memory text. The prompt also holds the answering instructions, and the Codex CLI adds its own instructions. The context counts here measure only the memory text.

## Marking

LongMemEval's `evaluate_qa.py` at commit `9e0b455f4ef0e2ab8f2e582289761153549043fc`, unchanged, with judge `gpt-4o-2024-08-06`. Each setting's 500 answers were marked once. The markup setting's 500 were marked a second time, in the same session as Mem0's published answers.

## The same-session comparison with Mem0

- **Scores:** marked together, Curate's markup setting scored 467 (93.4%) and Mem0's published answers 455 (91.0%). Curate's answers are right on 27 questions where Mem0's are wrong, and wrong on 15 where Mem0's are right.
- **The answering models differ.** Mem0's answers come from GPT-5, in Mem0's published run. Curate's come from gpt-6.1-sol. This compares two published sets of answers under one grader, not two memory systems with one answering model.
- **Mem0's answers:** the generated answer in each entry of Mem0's published results file ([`results/platform/longmemeval_results.json`](https://github.com/mem0ai/memory-benchmarks/blob/4b61c5d31b9c668a12b4f5e78064248a02c82d2b/results/platform/longmemeval_results.json) at commit `4b61c5d31b9c668a12b4f5e78064248a02c82d2b`, SHA-256 `58bd6d8934a54d8cd568ef481bbd3e37270c2c74a5d59713b661d4c3ddb332a1`), taken from the text after "Generated answer: " in its `reason` field. All 500 entries have one. Marked alone, the same answers scored 453 (90.6%).

## Fields

Each line of `markup-sol.jsonl`, `cited-only-sol.jsonl` and `log-sol.jsonl` is one question, with the fields of the [22 October files](../2026-10-22/README.md#fields), except that `split` is renamed `original_log_split`.

| Field | Meaning |
| --- | --- |
| `id`, `type`, `abstention` | LongMemEval's question id, question type, and whether the right answer is that the history does not say |
| `original_log_split` | the 22 October run's split for this question: `held_out` (not used to tune the log setting) or `tune`. It does not hold for these settings, which were examined on all 500 |
| `question`, `question_date`, `gold_answer` | from the dataset |
| `curated_log` | the exact memory text the answering model read |
| `context_tokens_o200k` | that text's length in o200k tokens |
| `answer_model`, `answer` | the answering model and its answer |
| `marker_model`, `correct`, `marker_reply` | LongMemEval's grader, its verdict and its reply |
| `curator_input_tokens` | the log setting's curator input tokens; `null` for the markup settings, because this total is not reported for them. The markup settings include model-based extraction and rewriting |
| `answer_cost_usd` | `null`: the answers ran on a ChatGPT plan |
| `mark_cost_usd` | measured cost of the grader's call at OpenAI's list price |

## Recount the scores

```sh
python3 -c "import json,sys; r=[json.loads(l) for l in open(sys.argv[1])]; print(sum(x['correct'] for x in r), len(r))" markup-sol.jsonl
```

## LongMemEval's own grader

`official-scorer/` holds each setting's answers in LongMemEval's hypothesis format (`question_id`, `hypothesis`), the grader's verdict for every question (`autoeval_label`) and the output of `print_qa_metrics.py` (`*.metrics.txt`).

- `markup-sol.jsonl`, `cited-only-sol.jsonl`, `log-sol.jsonl`: each setting's 500 answers, marked once.
- `same-session-2026-11-05/`: the markup setting's answers and Mem0's published answers, marked in one session.
- `mem0-2026-10-31/`: Mem0's published answers marked alone.

Score them again with LongMemEval's code:

```sh
python src/evaluation/evaluate_qa.py gpt-4o markup-sol.jsonl longmemeval_s_cleaned.json
python src/evaluation/print_qa_metrics.py markup-sol.jsonl.eval-results-gpt-4o longmemeval_s_cleaned.json
```

## Inputs

- **Dataset:** LongMemEval S (`longmemeval_s_cleaned.json`), SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`. LongMemEval is MIT-licensed.
- **Checksums:** `SHA256SUMS`.
