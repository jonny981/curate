# LongMemEval S, all 500 questions, GPT-5

Curate's presets as they come: the decision model scored every ranked part, and only references it scored 0.0146 or more reached the curator. Chat labels were asked, as they are by default, and changed nothing the curator received (see [Labels changed nothing](#labels-changed-nothing)).

| File | Answering model | Marker | Score |
| --- | --- | --- | --- |
| `mem0-gpt-5.jsonl` | GPT-5 | GPT-5, Mem0's marking prompt | 467/500 = 93.4% |
| `official-scorer/curate-gpt-5.jsonl` | GPT-5 | GPT-4o, LongMemEval's own scorer | 459/500 = 91.8% |

`scores.json` holds the combined scores for all 500, the held-out 251 and the tuning 249, by question type, with context tokens, curator input tokens and the adjusted score.

## How the run worked

1. **Rank:** the chat package's ranking over every part of the question's history.
2. **Decide:** Jev's saved decisions from the 14 October run, replayed request for request, with the chat package's question set (`relevant`, `own`, `needed`).
3. **Label:** Jev also answered the chat package's seven label kinds (personal, owns, acquired, event, preference, habit, decision) for every part. Every part was already going to the decide step, so labels added no part.
4. **Keep:** only references scored 0.0146 or more went to the curator, about 70 of a history's 851.
5. **Curate:** gpt-6.1-sol, at low reasoning effort, wrote one dated, cited log per question. It ran on a ChatGPT plan through the Codex CLI.
6. **Answer:** GPT-5 read only the log and the question.
7. **Mark:** GPT-5 compared each answer with LongMemEval's gold answer, with Mem0's marking prompt.

## Labels changed nothing

The run asked the decision model the chat label questions, and its records show labels on. They changed nothing the curator received.

- **No part was left for labels to add.** Labels add parts that the keyword lanes left out. Here every part of every history went to the decide step, and the label gate admitted every part on all 500 questions.
- **Byte replay.** Both settings, the run's own and the same without labels, were replayed on the run's build from its saved decision-model answers, with no model call and a stub curator that recorded each prompt. On 500 of 500 questions the curator's prompt was byte-identical with and without labels, and each question kept as many parts as its published log was written from. The same comparison catches a one-byte change in one prompt.

## Builds

- 499 logs were written with Curate at commit `6796c72`. The release build gives the curator a byte-identical prompt and the same selection for all 500 questions.
- One log (question `d905b33f`) was written with the release build. At `6796c72` the curator wrote an observation that cited two messages, the format check rejected it, and the log came out empty. The release build accepts that observation.

## Two answers re-run with no output limit

- **Which:** `88432d0a` and `gpt4_2f91af09`. GPT-5 answered them again from the same logs, with the same prompt and no output limit. GPT-5 marked them again, and LongMemEval's scorer scored them again. Their lines in every file here come from that re-run.
- **Why:** the run sent `max_completion_tokens: 4096` with every answer. That is the default of Mem0's benchmark client, not a rule of LongMemEval's scoring. On these two questions GPT-5 spent all 4,096 tokens reasoning and returned an empty answer.
- **With no limit:** `88432d0a` used 4,502 output tokens and answered "6 times.", still wrong against the gold answer of 4. `gpt4_2f91af09` used 3,734 and answered 23 (adding that it is 22 if one titled piece is among the stories), now right.
- **The other 498:** no other answer reached the limit; the longest used 3,581 output tokens. No mark reached it either; the longest used 1,598. The limit cut off no other result, so the merged file holds no answer the limit shaped.
- **Other runs:** Mem0's published run has no empty answers, so it stands as it is.

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
