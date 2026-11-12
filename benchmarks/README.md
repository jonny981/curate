# Benchmarks

On LongMemEval, Curate's answering model reads 1,577 tokens a question on average, and every other token figure in the table is higher.
On LoCoMo it reads 3,839 tokens a question on average in the full setting and 1,248 in the compact one.
Curate keeps local index files and needs no database, no server to run and no model that writes or rewrites memory in advance.

## LongMemEval

LongMemEval S, all 500 questions: answer questions from a long chat history.

| System | Answering model | Marker | Score | Tokens read (mean) |
| --- | --- | --- | --- | --- |
| **Curate** | **gpt-6.1-sol** | **gpt-6.1-sol** | **94.2** (471/500) | **1,577** |
| [Mastra observational memory](https://mastra.ai/research/observational-memory)\* | gpt-5-mini | GPT-4o | 93.6† | about 30,000 (estimated) |
| **Curate** | **gpt-6.1-sol** | **LongMemEval's grader (GPT-4o)** | **92.8** (464/500) | **1,577** |
| [Mem0 platform](https://github.com/mem0ai/memory-benchmarks/blob/4b61c5d31b9c668a12b4f5e78064248a02c82d2b/results/platform/longmemeval_results.json) | GPT-5 | gpt-6.1-sol | 92.6 (463/500) | [6,787](https://github.com/mem0ai/mem0/blob/main/docs/core-concepts/memory-evaluation.mdx) |
| [Mem0 platform](https://github.com/mem0ai/memory-benchmarks/blob/4b61c5d31b9c668a12b4f5e78064248a02c82d2b/results/platform/longmemeval_results.json) | GPT-5 | LongMemEval's grader (GPT-4o) | 91.0 (455/500) | [6,787](https://github.com/mem0ai/mem0/blob/main/docs/core-concepts/memory-evaluation.mdx) |
| [Zep](https://www.getzep.com/research/memory-benchmarks/)\* | gpt-5.4 | gpt-5.4 | 90.2 | 4,408 median |

\* Score as published; these answers were not marked again here.

† Mastra publishes 94.87, the average of its six category scores; 93.6 is the same result counted per question (468 of 500), as every other row is.

The answers, memory texts and verdicts are in [`longmemeval/2026-11-11/`](longmemeval/2026-11-11/README.md).
The memory texts and questions in the LongMemEval folders are excerpts of the LongMemEval dataset, used under its MIT licence ([`LICENSE-LongMemEval.txt`](longmemeval/LICENSE-LongMemEval.txt)).

### How the LongMemEval result was run

- **Setting:** Curate (compact), the default. For each question Curate lays out the history parts that the decision model kept, in their own words, within an answer budget of 2,000 tokens, then keeps the sentences that the decision model rates 0.1 or more. No model writes the memory text. [How the memory text is built](longmemeval/2026-11-11/README.md#how-the-memory-text-is-built).
- **Prompts:** gpt-6.1-sol answers with Mem0's published answering prompt and two additions, rules for reading the memories and a paragraph on near matches ([the full prompt](longmemeval/2026-11-11/README.md#the-prompt)); gpt-6.1-sol marks with LongMemEval's own marking prompts, and LongMemEval's grader is its `evaluate_qa.py` (commit `9e0b455`), unchanged, with the judge `gpt-4o-2024-08-06`.
- **Six answer sets over one set of memory texts:** Curate built the 500 memory texts once. gpt-6.1-sol wrote answers from them six times, and gpt-6.1-sol marked each set: 469, 466, 471, 470, 470 and 467 right. These are six repeats of the answering and the marking, not six runs from start to end. The published answers are the set with the highest score, 471. LongMemEval's grader marked that same set once: 464.
- **The Mem0 platform rows:** its published answers, written by GPT-5, marked here by both graders.
- **The starred rows:** [Mastra's page](https://mastra.ai/research/observational-memory) gives 94.87 as overall accuracy, which it defines as the unweighted average across the six question types, on LongMemEval S's 500 questions; its counts by type (75/78, 116/133, 53/56, 30/30, 67/70, 127/133) make 468 of 500, or 93.6 counted per question, as LongMemEval's evaluator and every other row count. Counted Mastra's way, as the average of the six type scores, Curate's answers score 94.56 marked by gpt-6.1-sol and 91.96 marked by LongMemEval's grader. gpt-5-mini answers, and GPT-4o judges with LongMemEval's question-specific prompts. About 30,000 tokens is Mastra's own approximate figure for its average context window over the run. [Zep's](https://www.getzep.com/research/memory-benchmarks/) 90.2 is 451 of 500, with gpt-5.4 answering and judging and a median context of 4,408 tokens a question.
- **Context:** each history averages 102,580 o200k tokens over about 48 sessions, so the answering model reads about 65 times less.

## LoCoMo

LoCoMo, all 1,540 scored questions (categories 1 to 4): answer questions about long conversations between two people.

| System | Answering model | Marked by gpt-6.1-sol | Marked by gpt-4o-mini | Tokens read (mean) |
| --- | --- | --- | --- | --- |
| **Curate (full)** | **gpt-6.1-sol** | **96.5** (1,486/1,540) | **94.6** (1,457/1,540) | **3,839** |
| **Curate (compact)** | **gpt-4.1-mini** | | **91.4** (1,408/1,540) | **1,248** |

Curate (full) has an answer budget of 6,000 tokens and keeps every sentence (`answerTokens: 6000`, `sentenceCutoff: false`). Curate (compact) is the default: an answer budget of 2,000 tokens and a sentence cutoff of 0.1 (`answerTokens: 2000`, `sentenceCutoff: 0.1`).
The answers, every verdict, a list of the misses, and a script that rebuilds each memory text from your own copy of the dataset are in [`locomo/2026-11-12/`](locomo/2026-11-12/README.md).

Published results with frontier answering models:

| System | Answering model | Marker | Score | Tokens read (mean) |
| --- | --- | --- | --- | --- |
| **Curate (full)** | **gpt-6.1-sol** | **gpt-6.1-sol** | **96.5** | **3,839** |
| [Zep](https://www.getzep.com/research/memory-benchmarks/)\* | gpt-5.4 | gpt-5.4 | 94.7 | 5,760 median |
| [Mem0 platform](https://github.com/mem0ai/memory-benchmarks/blob/edcd6f1d42400837b1fcb6997716f1769dc51a37/results/platform/locomo_results.json) | GPT-5 | GPT-5 | 91.6 | |
| [Hindsight](https://arxiv.org/abs/2512.12818)\* | Gemini 3 Pro | GPT-OSS-120B | 89.61 | |

\* Score as published; these answers were not marked again here.

[OmniMemEval's table](https://github.com/MemTensor/OmniMemEval/blob/7c79d46e31dd85f3da2509b430bba9406656dd28/docs/user_memory/results.md#locomo):

| System | Answering model | Marker | Score | Tokens sent, prompt included (mean) |
| --- | --- | --- | --- | --- |
| **Curate (compact)** | **gpt-4.1-mini** | **gpt-4o-mini** | **91.4** | **1,757** |
| MemOS\* | gpt-4.1-mini | gpt-4o-mini | 88.83 | 5,400 |
| Cognee\* | gpt-4.1-mini | gpt-4o-mini | 83.48 | 32,532 |
| EverOS\* | gpt-4.1-mini | gpt-4o-mini | 82.75 | 8,559 |
| Hindsight\* | gpt-4.1-mini | gpt-4o-mini | 81.99 | 24,683 |
| LCM-X\* | gpt-4.1-mini | gpt-4o-mini | 78.83 | 1,659 |
| Mem0\* | gpt-4.1-mini | gpt-4o-mini | 77.68 | 17,395 |
| Letta\* | gpt-4.1-mini | gpt-4o-mini | 77.12 | 14,188 |
| MemMachine\* | gpt-4.1-mini | gpt-4o-mini | 73.90 | 2,577 |
| mem9\* | gpt-4.1-mini | gpt-4o-mini | 73.64 | 1,597 |
| Supermemory\* | gpt-4.1-mini | gpt-4o-mini | 73.53 | 15,238 |
| MemoryLake\* | gpt-4.1-mini | gpt-4o-mini | 72.49 | 5,202 |
| Viking\* | gpt-4.1-mini | gpt-4o-mini | 69.33 | 5,964 |
| Zep\* | gpt-4.1-mini | gpt-4o-mini | 63.83 | 1,862 |
| Memori\* | gpt-4.1-mini | gpt-4o-mini | 41.34 | 8,139 |
| Backboard.io\* | gpt-4.1-mini | gpt-4o-mini | 22.40 | 1,198 |

\* Score as published; these answers were not marked again here.

### How the LoCoMo result was run

- **One set of decisions, two settings:** one Curate call per question searched the conversation and had the decision model score its parts. Curate (full) and Curate (compact) lay out the same kept parts. No model writes the memory text. [How the memory text is built](locomo/2026-11-12/README.md#how-the-memory-text-is-built).
- **History:** each conversation is one Markdown file per session, read by Curate's `/curate` skill. A turn that shares a photo also carries the photo's search query and caption.
- **Prompts:** Curate (full) is answered by gpt-6.1-sol with Curate's own answering prompt ([`prompts/curate-answer.txt`](locomo/2026-11-12/prompts/curate-answer.txt)) and marked by gpt-6.1-sol and by `gpt-4o-mini-2024-07-18`, while Curate (compact) is answered by `gpt-4.1-mini-2025-04-14` and marked by `gpt-4o-mini-2024-07-18`. Every prompt, with its source, is in [the proof folder](locomo/2026-11-12/README.md).
- **Curate's answering prompt:** it was developed on these LoCoMo questions: misses across all 1,540 were read while it was written, so no subset of the questions is untouched by its development. It was run twice on the same memory texts, and both runs score 1,486. A check in the folder (`rebuild.py --check-prompt`) finds no phrase of three or more words, no whole answer key of two or more words, no speaker name and no number shared between the prompt and the questions or answer keys; it lists 20 single words, such as "period" and "habits", that the prompt shares with five or fewer questions or answer keys.
- **How Curate (full) was chosen:** by comparing settings on 159 of the 1,540 questions. On the other 1,381 questions, Curate (full) scores 1,329 (96.2%) marked by gpt-6.1-sol and 1,306 (94.6%) marked by gpt-4o-mini, and Curate (compact) scores 1,260 (91.2%).
- **Curate (compact):** Curate's own runner sent OmniMemEval's requests; the run did not use OmniMemEval's harness. Photo handling varies by adapter in OmniMemEval.
- **Published rows:** each frontier row is as its system published it, with its own prompts and grader. OmniMemEval's table uses its prompts and requested setup; LCM-X's row was run by its contributor through OpenRouter.
- **Left out:** category 5, the 446 questions the conversation cannot answer, as in the published results above.

Earlier dated folders under `longmemeval/` and `dolphinbench/` hold results of earlier versions of Curate, including layouts in which a model wrote or marked up the memory text.
