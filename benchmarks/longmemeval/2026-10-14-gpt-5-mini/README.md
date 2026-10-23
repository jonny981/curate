# LongMemEval S, all 500 questions, GPT-5-mini

Curate's packages at commit `aacb042`: the decision model scored every part of each history, only the references it
scored 0.0146 or more went to the curator (`everyScored: { bar: 0.0146 }` on the pick), and no labels were used.

| File | Answering model | Marker | Score |
| --- | --- | --- | --- |
| `mastra-gpt-5-mini.jsonl` | GPT-5-mini | GPT-4o, Mastra's marking prompt | 458/500 = 91.6% |
| `official-scorer/curate-gpt-5-mini.jsonl` | GPT-5-mini | GPT-4o, LongMemEval's own scorer | 454/500 = 90.8% |

The answering model read 485 tokens a question on average (median 414.5). On the held-out 251 the run scores 235
(93.6%), and on the tuning 249 it scores 223 (89.6%). `scores.json` holds all three, by question type, with context
tokens and the adjusted score.

## How the run worked

1. **Rank:** the chat package's ranking over every part of the question's history.
2. **Decide:** Jev scored every part with the chat package's fitted question set (`relevant`, `own`, `needed`). The
   replies were replayed from an earlier run's saved Jev replies, so no part was scored again; the `jev_calls` and
   `jev_input_tokens` fields are that run's figures.
3. **Keep:** only references scored 0.0146 or more went to the curator, about 70 of a history's 851 parts. 0.0146 is
   the highest cut that lost no answer message on Curate's earlier ranking, chosen on the tuning 249 only.
4. **Curate:** gpt-6.1-sol, at low reasoning effort, wrote one dated, cited log per question, strongest part first. A
   log that failed the format check went back once with the reason. The curator ran on a ChatGPT plan through the
   Codex CLI.
5. **Answer:** GPT-5-mini read only the log and the question.
6. **Mark:** GPT-4o compared each answer with LongMemEval's gold answer, with Mastra's marking prompt.

## Fields

Each line of `mastra-gpt-5-mini.jsonl` is one question.

| Field | Meaning |
| --- | --- |
| `id`, `type`, `abstention` | LongMemEval's question id, question type, and whether the right answer is that the history does not say |
| `split` | `held_out` (never used to tune Curate) or `tune` |
| `question`, `question_date`, `gold_answer` | from the dataset |
| `curated_log` | the exact text the answering model read as memory |
| `context_tokens_o200k` | that text's length in o200k tokens |
| `answer_model`, `answer` | the answering model and its answer |
| `marker_model`, `correct`, `marker_reply` | the marker, its verdict and its reply |
| `jev_calls`, `jev_input_tokens` | decision requests and their billed input tokens, from the run whose replies were replayed |
| `curator_input_tokens` | the curator's input tokens for this question, including a format repair when one ran |
| `answer_cost_usd`, `mark_cost_usd` | measured cost of the answer and the mark at OpenAI's list prices |
| `kept_parts` | the parts scored 0.0146 or more that went to the curator |

## Recount the score

```sh
python3 -c "import json,sys; r=[json.loads(l) for l in open(sys.argv[1])]; print(sum(x['correct'] for x in r), len(r))" mastra-gpt-5-mini.jsonl
```

## LongMemEval's own scorer

`official-scorer/` holds the answers in LongMemEval's hypothesis format (`curate-gpt-5-mini.jsonl`, one
`{"question_id", "hypothesis"}` line per question), the scorer's verdict for every question
(`curate-gpt-5-mini.jsonl.eval-results-gpt-4o`, judge `gpt-4o-2024-08-06`) and the output of its `print_qa_metrics.py`
(`metrics.txt`). Score them again with LongMemEval's code at commit `9e0b455f4ef0e2ab8f2e582289761153549043fc`:

```sh
python src/evaluation/evaluate_qa.py gpt-4o curate-gpt-5-mini.jsonl longmemeval_s_cleaned.json
python src/evaluation/print_qa_metrics.py curate-gpt-5-mini.jsonl.eval-results-gpt-4o longmemeval_s_cleaned.json
```

The GPT-4o judge is not fully deterministic, so a rerun can differ by a question or two.

## Inputs

- **Dataset:** LongMemEval S (`longmemeval_s_cleaned.json`), SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`. LongMemEval is MIT-licensed.
- **Held-out split:** 251 questions chosen before any tuning; the other 249 were used to tune Curate.
- **Harness:** a separate repository, not public. It records every model call; those request and reply bodies stay on the machine that ran it.
