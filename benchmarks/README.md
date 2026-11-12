# Benchmarks

On LongMemEval, Curate's answering model reads 1,577 tokens a question on average, against Mem0's 6,787, and a median of 1,692, against Zep's 4,408: fewer than every other system in the LongMemEval table that gives a figure.
On LoCoMo, the 6,000-token setting's median is 4,921 tokens, against Zep's median of 5,760, and the 2,000-token setting sends 1,757 tokens a question, prompt included, where OmniMemEval's table runs from 1,198 to 32,532.
Curate keeps local index files and needs no database, no server to run and no model that writes or rewrites memory in advance; each question is one Curate call, in which a paid decision model rates the history's parts.

## LongMemEval

LongMemEval tests whether a model can answer questions from a long chat history.
Curate answered all 500 questions of LongMemEval S, and two graders marked every answer.
The same two graders marked Mem0's published answers. Mastra's and Zep's figures are as each published them:

| System | Answering model | Marked by gpt-6.1-sol | Marked by LongMemEval's grader | As published, with the vendor's grader | Answering context (tokens) |
| --- | --- | --- | --- | --- | --- |
| **Curate** | **gpt-6.1-sol** | **94.2** (471/500) | **92.8** (464/500) | | **1,577 mean, 1,692 median** |
| [Mem0 platform](https://github.com/mem0ai/memory-benchmarks/blob/4b61c5d31b9c668a12b4f5e78064248a02c82d2b/results/platform/longmemeval_results.json) | GPT-5 | 92.6 (463/500) | 91.0 (455/500) | | [6,787 mean](https://github.com/mem0ai/mem0/blob/main/docs/core-concepts/memory-evaluation.mdx) |
| [Mastra observational memory](https://mastra.ai/research/observational-memory)\* | gpt-5-mini | | | 94.87 (GPT-4o) | |
| [Zep](https://www.getzep.com/research/memory-benchmarks/)\* | gpt-5.4 | | | 90.2 (gpt-5.4) | 4,408 median |

\* Score as published; these answers were not marked again here. Mem0's answers are published, and both of its figures above were marked here from that file.

The answers, the memory texts and the verdicts of both graders are in [`longmemeval/2026-11-11/`](longmemeval/2026-11-11/README.md).
The memory texts and questions in the LongMemEval folders are excerpts of the LongMemEval dataset, used under its MIT licence ([`LICENSE-LongMemEval.txt`](longmemeval/LICENSE-LongMemEval.txt)).

### How the LongMemEval result was run

- **Memory text:** for each question, Curate lays out the history parts that the decision model kept, in their own words, within 2,000 estimated tokens. Then it keeps the sentences that the decision model rates 0.1 or more. These are Curate's defaults. No model writes the memory text. [How the memory text is built](longmemeval/2026-11-11/README.md#how-the-memory-text-is-built).
- **Answering model:** gpt-6.1-sol, at medium reasoning effort, with Mem0's answering prompt from its benchmark and two additions: rules for reading the memories, and a paragraph on near matches. [The full prompt](longmemeval/2026-11-11/README.md#the-prompt).
- **Marked by gpt-6.1-sol:** LongMemEval's own marking prompts, with gpt-6.1-sol as the judge.
- **Marked by LongMemEval's grader:** `evaluate_qa.py` (commit `9e0b455`), unchanged, with its dated GPT-4o judge, `gpt-4o-2024-08-06`.
- **Six answer sets over one set of memory texts:** Curate built the 500 memory texts once. gpt-6.1-sol wrote answers from them six times, and gpt-6.1-sol marked each set: 469, 466, 471, 470, 470 and 467 right. These are six repeats of the answering and the marking, not six runs from start to end. The published answers are the set with the highest score, 471. LongMemEval's grader marked that same set once: 464.
- **Mem0's answers:** the answers in Mem0's published results, written by GPT-5, marked by the same two graders. Mem0 reports 93.4 for them, marked by GPT-5 in its own run.
- **Mastra's and Zep's figures:** Mastra's 94.87 is what [its page](https://mastra.ai/research/observational-memory) calls overall accuracy, which the page defines as the unweighted average across the six question types, on LongMemEval S's 500 questions; gpt-5-mini answers, and GPT-4o judges with LongMemEval's question-specific prompts. [Zep's](https://www.getzep.com/research/memory-benchmarks/) 90.2 is 451 of 500, with gpt-5.4 answering and judging and a median context of 4,408 tokens a question.
- **Context:** the memory text averages 1,577 o200k tokens a question. Each history averages 102,580 o200k tokens over about 48 sessions, so the answering model reads about 65 times less. 6,787 is the mean that [Mem0 reports](https://github.com/mem0ai/mem0/blob/main/docs/core-concepts/memory-evaluation.mdx) for its answering context.

## LoCoMo

LoCoMo tests whether a model can answer questions about long conversations between two people.
Curate answered all 1,540 scored questions (categories 1 to 4) in two settings of the same layout dials, from one set of decisions:

| Curate setting | Answering model | Marked by gpt-6.1-sol, Mem0's prompt | Marked by gpt-4o-mini, OmniMemEval's prompt | Memory text (tokens, mean) |
| --- | --- | --- | --- | --- |
| **6,000 tokens, every sentence** | **gpt-6.1-sol** | **96.2** (1,481/1,540) | **94.7** (1,459/1,540) | **3,839** |
| **2,000 tokens, sentence cutoff 0.1** | **gpt-4.1-mini** | | **91.4** (1,408/1,540) | **1,248** |

The answers, every verdict, a list of the 6,000-token setting's misses, and a script that rebuilds each memory text from your own copy of the dataset are in [`locomo/2026-11-12/`](locomo/2026-11-12/README.md).

Published results with frontier answering models, each marked by its own grader:

| System | Answering model | Marker | Score | Tokens a question |
| --- | --- | --- | --- | --- |
| **Curate, 6,000 tokens** | **gpt-6.1-sol** | **gpt-6.1-sol** | **96.2** | **3,839 mean, 4,921 median** |
| [Zep](https://www.getzep.com/research/memory-benchmarks/)\* | gpt-5.4 | gpt-5.4 | 94.7 | 5,760 median |
| [Mem0 platform](https://github.com/mem0ai/memory-benchmarks/blob/edcd6f1d42400837b1fcb6997716f1769dc51a37/results/platform/locomo_results.json) | GPT-5 | GPT-5 | 91.6 | |
| [Hindsight](https://arxiv.org/abs/2512.12818)\* | Gemini 3 Pro | GPT-OSS-120B | 89.61 | |

\* Score as published; these answers were not marked again here. Mem0's figure is Mem0's own marking of the answers in its published results file.

[OmniMemEval's table](https://github.com/MemTensor/OmniMemEval/blob/7c79d46e31dd85f3da2509b430bba9406656dd28/docs/user_memory/results.md#locomo)\*, with OmniMemEval's prompts. Its context tokens count everything sent to the answering model, prompt included, and Curate's row is counted the same way:

| System | Answering model | Marker | Score | Context tokens |
| --- | --- | --- | --- | --- |
| **Curate, 2,000 tokens** | **gpt-4.1-mini** | **gpt-4o-mini** | **91.4** | **1,757** |
| MemOS | gpt-4.1-mini | gpt-4o-mini | 88.83 | 5,400 |
| Cognee | gpt-4.1-mini | gpt-4o-mini | 83.48 | 32,532 |
| EverOS | gpt-4.1-mini | gpt-4o-mini | 82.75 | 8,559 |
| Hindsight | gpt-4.1-mini | gpt-4o-mini | 81.99 | 24,683 |
| LCM-X | gpt-4.1-mini | gpt-4o-mini | 78.83 | 1,659 |
| Mem0 | gpt-4.1-mini | gpt-4o-mini | 77.68 | 17,395 |
| Letta | gpt-4.1-mini | gpt-4o-mini | 77.12 | 14,188 |
| MemMachine | gpt-4.1-mini | gpt-4o-mini | 73.90 | 2,577 |
| mem9 | gpt-4.1-mini | gpt-4o-mini | 73.64 | 1,597 |
| Supermemory | gpt-4.1-mini | gpt-4o-mini | 73.53 | 15,238 |
| MemoryLake | gpt-4.1-mini | gpt-4o-mini | 72.49 | 5,202 |
| Viking | gpt-4.1-mini | gpt-4o-mini | 69.33 | 5,964 |
| Zep | gpt-4.1-mini | gpt-4o-mini | 63.83 | 1,862 |
| Memori | gpt-4.1-mini | gpt-4o-mini | 41.34 | 8,139 |
| Backboard.io | gpt-4.1-mini | gpt-4o-mini | 22.40 | 1,198 |

\* Score as published; these answers were not marked again here.

### How the LoCoMo result was run

- **One set of decisions, two settings:** one Curate call per question searched the conversation and had the decision model score its parts. Both settings lay out the same kept parts. The 6,000-token setting keeps every sentence within 6,000 estimated tokens. The 2,000-token setting is Curate's defaults: 2,000 estimated tokens, then the sentences the decision model rates 0.1 or more. No model writes the memory text. [How the memory text is built](locomo/2026-11-12/README.md#how-the-memory-text-is-built).
- **History:** each conversation is one Markdown file per session, read by Curate's `/curate` skill. A turn that shares a photo also carries the photo's search query and caption, as Mem0's platform reads them.
- **6,000 tokens:** gpt-6.1-sol answers with Mem0's platform answer prompt, unchanged. gpt-6.1-sol marks with Mem0's platform judge prompt, unchanged. `gpt-4o-mini-2024-07-18` marks the same answers a second time with OmniMemEval's judge prompt.
- **What each judge prompt accepts:** Mem0's judge prompt marks a list answer right when it holds at least one item of the answer key, and accepts dates within 14 days of the key and durations within half of it. OmniMemEval's judge prompt asks for generous marking when the answer touches the same topic as the key, and accepts a date given in other words; it has no rule for list items or for a window of days.
- **How the 6,000-token setting was chosen:** by comparing settings on 159 of the 1,540 questions. On the other 1,381 questions the scores are 95.8% marked by gpt-6.1-sol with Mem0's prompt and 94.6% marked by gpt-4o-mini with OmniMemEval's prompt, and the 2,000-token setting scores 91.2%.
- **2,000 tokens:** `gpt-4.1-mini-2025-04-14` answers and `gpt-4o-mini-2024-07-18` marks, with OmniMemEval's prompts and request settings, unchanged. Curate's own runner sent these requests; the run did not use OmniMemEval's harness. Photo handling varies by adapter in OmniMemEval; Curate's history includes each shared photo's search query and caption.
- **Published rows:** Zep's, Mem0's and Hindsight's scores are as each published them, with their own prompts and graders. OmniMemEval's table uses its prompts and requested setup; LCM-X's row was run by its contributor through OpenRouter.
- **Left out:** category 5, the 446 questions the conversation cannot answer, as in Zep's, Mem0's and OmniMemEval's results.

Earlier dated folders under `longmemeval/` and `dolphinbench/` hold results of earlier versions of Curate, including layouts in which a model wrote or marked up the memory text.
