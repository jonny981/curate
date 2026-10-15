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
3. **Curate:** gpt-6.1-sol, at low reasoning effort, wrote one dated, cited log from every scored part, strongest first. A log that failed the format check went back once with the reason.
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

`SHA256SUMS` lists a checksum for every file in this folder.
