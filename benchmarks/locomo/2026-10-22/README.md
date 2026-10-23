# LoCoMo, a 159-question slice

Curate's presets as they come, on a slice of LoCoMo, answered and marked the way Mem0 ran its platform result.

| File | Memory | Answering model | Marker | Score |
| --- | --- | --- | --- | --- |
| `mem0-gpt-5.jsonl` | Curate | GPT-5 | GPT-5, Mem0's marking prompt | 149/159 = 93.7% |
| `mem0-same-questions.jsonl` | Mem0 platform, from Mem0's published file | GPT-5 | GPT-5, Mem0's marking prompt | 150/159 = 94.3% |

`scores.json` holds both scores by category, Curate's context tokens, output tokens and cost, and Mem0's score on all 1,540 questions: 1,410/1,540 = 91.6%.

## The slice

- **Rule:** in each of LoCoMo's 10 conversations, take the scored questions (categories 1 to 4) in dataset order, and keep the 1st, the 11th, the 21st and so on. That gives 159 of the 1,540 scored questions. Category 5 (unanswerable) is not scored, as in Mem0's run.
- **By category:** multi-hop 28, temporal 36, open-domain 13, single-hop 82.
- **Ids:** `id` is the conversation's `sample_id` and the question's position in that conversation's `qa` list. `vendor_id` is Mem0's id for the same question, `conv{conversation}_q{question}`. The question text matches on all 159.

## How the run worked

1. **Rank:** each question reads only its own conversation, split into 700-character session parts. The chat package ranks every part.
2. **Decide:** Jev (`jev-1.13.0`) scored every part for the question with the chat package's question set (`relevant`, `own`, `needed`).
3. **Label:** Jev also answered the chat package's seven label kinds for every part. Every part was already going to the decide step, so labels added no part.
4. **Keep:** only parts scored 0.0146 or more went to the curator.
5. **Curate:** the curator wrote one dated, cited log per question, with the package's own instructions. The curator model and its reasoning effort are those of the [LongMemEval GPT-5 run](../../longmemeval/2026-10-22/README.md). LoCoMo has no question date, so the task names the last session's date as the end of the conversation.
6. **Answer:** GPT-5 read only the log and the question, with Mem0's answer prompt.
7. **Mark:** GPT-5 compared each answer with LoCoMo's gold answer, with Mem0's marking prompt. For category 3, the gold is cut at its first semicolon, as Mem0's client does.

## Labels changed nothing

The run asked the decision model the chat label questions, and its records show labels on. They changed nothing the curator received.

- **No part was left for labels to add.** Labels add parts that the keyword lanes left out. Here every part of every history went to the decide step, and the label gate admitted every part on all 159 questions.
- **Byte replay.** Both settings, the run's own and the same without labels, were replayed on the run's build from its saved decision-model answers, with no model call and a stub curator that recorded each prompt. On 159 of 159 questions the curator's prompt was byte-identical with and without labels, and each question kept the same parts, in the same order, as the run. The same comparison catches a one-byte change in one prompt.

## Mem0's protocol, and the differences

- **Prompts:** Mem0's answer and marking prompts from its memory-benchmarks repository at commit `4b61c5d31b9c668a12b4f5e78064248a02c82d2b`. GPT-5 for both, with no temperature, as Mem0's client sends.
- **No output limit was sent.** Mem0's client asks GPT-5 for at most 4,096 output tokens. That is the client's default, not a rule of LoCoMo, so no `max_completion_tokens` was sent. One answer, `conv-50:110`, used 4,174 output tokens and was marked correct. No answer was empty or cut off.
- **Memory input:** Curate read the spoken text of each turn. Mem0's platform also reads the caption and search query of each shared photo. At least 30 of the 1,540 gold answers appear only in a caption, 5 of them among these 159. This run got 4 of those 5 right.

## Builds

- **Logs:** written by Curate's packed 0.1.0 `@curatejs/core` and `@curatejs/chat`, with the presets as they come.
  - 150 logs were written by an earlier packed build with the same curator prompt and the same selection. Replaying their saved curator replies on 0.1.0 gives byte-identical logs.
  - The other 9 come out differently on 0.1.0, which accepts a full stop after an observation's citation, so they were curated again with it.
- **Empty-reply retry:** Curate later gained one more curator call when a log comes back empty. No log here was empty, so it would change none of them.

## Fields

Each line of `mem0-gpt-5.jsonl` is one question.

| Field | Meaning |
| --- | --- |
| `id`, `vendor_id` | the question's id in this run and in Mem0's file |
| `category`, `category_name` | LoCoMo's category number and its name |
| `question`, `gold_answer` | from the dataset |
| `curated_log` | the exact text the answering model read as memory |
| `context_tokens_o200k` | that text's length in o200k tokens |
| `answer_model`, `answer_reply`, `answer` | the answering model, its whole reply, and the scored text after its last `ANSWER:` |
| `marker_model`, `correct`, `marker_reply` | the marker, its verdict and its reply |
| `answer_input_tokens`, `answer_output_tokens`, `answer_reasoning_tokens` | the answer call's usage as OpenAI reported it |
| `mark_input_tokens`, `mark_output_tokens` | the mark call's usage |
| `answer_cost_usd`, `mark_cost_usd` | that usage at GPT-5's list prices ($1.25 in, $10 out per million tokens), with no cached-input discount |

Each line of `mem0-same-questions.jsonl` gives one question's `id`, `vendor_id`, category, Curate's verdict (`curate_correct`) and Mem0's (`mem0_correct`, `mem0_judgment`).

## Recount the scores

```sh
python3 -c "import json,sys; r=[json.loads(l) for l in open(sys.argv[1])]; print(sum(x['correct'] for x in r), len(r))" mem0-gpt-5.jsonl
python3 -c "import json,sys; r=[json.loads(l) for l in open(sys.argv[1])]; print(sum(x['mem0_correct'] for x in r), len(r))" mem0-same-questions.jsonl
```

## Inputs

- **Dataset:** LoCoMo (`locomo10.json` from [snap-research/locomo](https://github.com/snap-research/locomo/blob/main/data/locomo10.json)), SHA-256 `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`. LoCoMo is licensed [CC BY-NC 4.0](https://github.com/snap-research/locomo/blob/main/LICENSE); the logs and questions here carry that licence.
- **Mem0's results:** [`results/platform/locomo_results.json`](https://github.com/mem0ai/memory-benchmarks/blob/edcd6f1d42400837b1fcb6997716f1769dc51a37/results/platform/locomo_results.json) at commit `edcd6f1`, SHA-256 `36338fa6c1ca38bcf9e3fc33a5cbc3b6e53bdc4bafaeeaee0947cf13b5527911`. It covers all 1,540 scored questions, with GPT-5 answering and marking: 1,410 correct, 129 wrong and 1 error, which counts as wrong.
- **Mem0's prompts** are Apache 2.0-licensed.
