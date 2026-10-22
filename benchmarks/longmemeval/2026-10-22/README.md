# LongMemEval S, all 500 questions, conversation-recall

Curate's `conversation-recall` mode: decide every ranked part, keep references the decision model scored 0.0146 or more, and add chat labels.

| File | Answering model | Marker | Score |
| --- | --- | --- | --- |
| `mem0-gpt-5.jsonl` | GPT-5 | GPT-5, Mem0's marking prompt | 466/500 = 93.2% |
| `official-scorer/curate-gpt-5.jsonl` | GPT-5 | GPT-4o, LongMemEval's own scorer | 458/500 = 91.6% |

`scores.json` holds the combined scores for all 500, the held-out 251 and the tuning 249, by question type, with context tokens, curator input tokens and the adjusted score.

## How the run worked

1. **Rank:** the chat package's ranking over every part of the question's history.
2. **Decide:** Jev's saved decisions from the 14 October run, replayed request for request, with the chat package's question set (`relevant`, `own`, `needed`).
3. **Label:** Jev's answers to the chat package's seven label kinds (personal, owns, acquired, event, preference, habit, decision) for every part. A part that a label marks as likely evidence joins the keyword lanes at the decide step.
4. **Keep:** only references scored 0.0146 or more went to the curator, about 70 of a history's 851.
5. **Curate:** gpt-6.1-sol, at low reasoning effort, wrote one dated, cited log per question. It ran on a ChatGPT plan through the Codex CLI.
6. **Answer:** GPT-5 read only the log and the question.
7. **Mark:** GPT-5 compared each answer with LongMemEval's gold answer, with Mem0's marking prompt.

## Builds

- 499 logs were written with Curate at commit `6796c72`. The release build gives the curator a byte-identical prompt and the same selection for all 500 questions.
- One log (question `d905b33f`) was written with the release build. At `6796c72` the curator wrote an observation that cited two messages, the format check rejected it, and the log came out empty. The release build accepts that observation.

## Fields

Each line of `mem0-gpt-5.jsonl` is one question.

| Field | Meaning |
| --- | --- |
| `id`, `type`, `abstention` | LongMemEval's question id, question type, and whether the right answer is that the history does not say |
| `split` | `held_out` (never used to tune Curate) or `tune` |
| `question`, `question_date`, `gold_answer` | from the dataset |
| `curated_log` | the exact text the answering model read as memory |
| `context_tokens_o200k` | that text's length in o200k tokens |
| `answer_model`, `answer` | the answering model and its answer |
| `marker_model`, `correct`, `marker_reply` | the marker, its verdict and its reply |
| `curator_input_tokens` | the curator's input tokens for this question |
| `answer_cost_usd`, `mark_cost_usd` | measured cost of the answer and the mark at OpenAI's list prices |

## Recount the score

```sh
python3 -c "import json,sys; r=[json.loads(l) for l in open(sys.argv[1])]; print(sum(x['correct'] for x in r), len(r))" mem0-gpt-5.jsonl
```

## LongMemEval's own scorer

`official-scorer/` holds the answers in LongMemEval's hypothesis format, the scorer's verdict for every question (`autoeval_label`, judge `gpt-4o-2024-08-06`) and the output of `print_qa_metrics.py` in `metrics.txt`. Score them again with LongMemEval's code at commit `9e0b455f4ef0e2ab8f2e582289761153549043fc`:

```sh
python src/evaluation/evaluate_qa.py gpt-4o curate-gpt-5.jsonl longmemeval_s_cleaned.json
python src/evaluation/print_qa_metrics.py curate-gpt-5.jsonl.eval-results-gpt-4o longmemeval_s_cleaned.json
```

## Inputs

- **Dataset:** LongMemEval S (`longmemeval_s_cleaned.json`), SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`. LongMemEval is MIT-licensed.
- **Held-out split:** 251 questions chosen before any tuning; the other 249 were used to tune Curate.
