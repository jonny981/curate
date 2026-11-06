# Benchmarks

## LongMemEval on the official grader

LongMemEval tests whether a model can answer questions from a long chat history.
These scores come from LongMemEval's own grader, `evaluate_qa.py` (commit `9e0b455`), with its dated GPT-4o judge, `gpt-4o-2024-08-06`.
gpt-6.1-sol answered all 500 questions in three Curate settings:

| Curate setting | Score | Context tokens a question (mean) | Less than the raw history |
| --- | --- | --- | --- |
| **Markup** | **93.8** (469/500) | **844** | **121x** |
| Cited-only markup | 93.0 (465/500) | 854 | 120x |
| Log | 92.6 (463/500) | 449 | 229x |

- **The packages produce memory in two formats: log and cited-only markup.** The log is `compression: 'high'`, the default. Cited-only markup is `compression: 'low'`.
- **The markup setting ran outside the packages.** Its published results, including 93.8, came from those runs.
- **The answers, memory texts and grader output** are in [`longmemeval/2026-11-04/`](longmemeval/2026-11-04/README.md).

The same grader also scored Curate's GPT-5 and GPT-5-mini runs, which are [compared with published systems](#against-published-systems) below:

| Answering model | Overall | Average of the six types | Abstention questions |
| --- | --- | --- | --- |
| **GPT-5** | **91.8** (459/500) | 92.8 | 26/30 |
| **GPT-5-mini** | **90.8** (454/500) | 89.3 | 23/30 |

These answers are in LongMemEval's own format (`question_id`, `hypothesis`), with the grader's output for every question.
They're in [`official-scorer/`](longmemeval/2026-10-22/official-scorer/) for the GPT-5 run and [`official-scorer/`](longmemeval/2026-10-14-gpt-5-mini/official-scorer/) for the GPT-5-mini run.
Anyone with the dataset and an OpenAI key can score them again.
How these runs were set up: [How each result was run](#how-each-result-was-run).

## Against published systems

Curate's packages answered all 500 LongMemEval S questions in two runs, one with GPT-5 and one with GPT-5-mini.
In each run the curator wrote one log per question, and the answering model read only that log.
The answering model does the work, so you don't want to flood its context with noise.

| System | What you run | Answering model | Score | Answering context (tokens) | Answering input cost | Full pipeline cost |
| --- | --- | --- | --- | --- | --- | --- |
| **Curate** | A TypeScript library: plain files, no database | GPT-5-mini | 91.6 (458/500) | 485 | $0.0001 | **$0.12** (est.) |
| **Curate** | A TypeScript library: plain files, no database | GPT-5 | 93.4 (467/500) | **449** | **$0.0006** | $0.16 (est.) |
| [Mem0 platform](https://github.com/mem0ai/memory-benchmarks/blob/4b61c5d31b9c668a12b4f5e78064248a02c82d2b/results/platform/longmemeval_results.json) | Mem0's hosted platform | GPT-5 | 93.4 | 6,787 mean | $0.0085 | not published |
| [Mastra observational memory](https://mastra.ai/research/observational-memory) | A TypeScript framework you run, with a storage provider | GPT-5-mini | 93.6 | ~30,000 mean | $0.0075 | ~$0.045 (est.) |
| [Zep](https://getzep.com/research) | Zep's hosted service is its recommended setup | GPT-5.4 | 90.2 | 4,408 median | not priced | not published |
| No memory: GPT-5 reads the whole history | Nothing | GPT-5 | not run | ~122,000 | $0.153 | $0.153 |

Costs are per question, at list prices.

- **On GPT-5, Curate matches Mem0's score with 15 times less context.** Both were marked by GPT-5.
- **On GPT-5-mini, Mastra's score is higher.** It's 93.6 against Curate's 91.6 per question, and 94.87 against 90.22 as an equal average of the six question types. Mastra's answering model reads about 62 times more context.
- **Zep scores 90.2 on GPT-5.4** and reads about 10 times more context than Curate on GPT-5.
- **On LongMemEval's official grader, Curate is ahead of Mem0's published answers.** Marked in the same session, Curate's markup answers scored 467 (93.4) and Mem0's scored 455 (91.0). The same Curate answers scored 469 when marked the day before. In a separate marking, Mem0's answers score 90.6 (453/500). Mem0's answers come from GPT-5 and Curate's from gpt-6.1-sol.
- **On the official grader runs, Curate's context is about 6 to 35 times smaller** than what other systems report. That's against Zep's 4,408 median (Curate's median is 685), Mem0's 6,787 mean and Mastra's mean of about 30,000.

**Notes on the table**

- **Answering input cost** is the answering context times the answering model's input price. It prices every system the same way.
- **Curate's full pipeline costs are estimates from the runs' call records:**
  - Jev, the decision model, costs $0.0097 a question.
  - Curation ran on a ChatGPT subscription. It's priced at gpt-6.1-sol's list price of $2.00 per million input tokens and $10 per million output tokens (third-party price list, 11 October 2026).
  - The GPT-5 row's estimate is the GPT-5-mini row's $0.12, plus the GPT-5 answer ($0.014 a question) and chat labels (about $0.025 a question).
- **Mastra's full pipeline cost is an estimate.** Its observer reads each history once with gemini-2.5-flash, at $0.30 per million input tokens (about $0.037), plus the answer. Observer output is not counted.
- **What you run:** Mem0's result file comes from Mem0 Platform. Zep's research page does not say which setup produced 90.2. Curate needs no server either. It calls the decision model, curator and answering model you choose.
- **Mem0 and Zep do not publish** their ingestion models or calls.
- **Marking models differ:** GPT-5 for Curate's GPT-5 row and for Mem0, GPT-4o for Curate's GPT-5-mini row and for Mastra, GPT-5.4 for Zep.
- **Each context multiple compares with Curate on the same answering model:** 449 tokens with GPT-5, 485 with GPT-5-mini. Zep's GPT-5.4 compares with Curate on GPT-5.
- **Token counting differs** too, including Zep's median in place of a mean. The rows compare roughly. They are not one controlled run.
- **Prices:** OpenAI's list prices, checked 13 October 2026.

## Adjusted score

The adjusted score is a custom measure, not LongMemEval's official score.
It rewards an answering model that reads less context:

```text
adjusted score = answer score − 5 × log10(context tokens ÷ 5,698)
```

The 5,698-token reference is the mean context of only the sessions containing the answer, over all 500 questions, counted with GPT-4o's token counter.
This is LongMemEval's oracle setting: perfect selection of sessions, rather than the shortest possible answer.
Halving the context adds about 1.5 points, and doubling it removes about 1.5.
It counts only the answering model's context, not decisions, curation or ingestion work.

Curate's GPT-5 run has an adjusted score of 98.9, and its GPT-5-mini run 96.9.
That's the highest of the systems above, because Curate's answering model reads the least context.

## LoCoMo

On 159 LoCoMo questions, Curate scores 93.7 (149/159) with GPT-5.
Mem0's own published answers score 94.3 (150/159) on the same questions, and 91.6 across all 1,540.
The answers and verdicts are in the [proof files](locomo/2026-10-22/README.md).

## DolphinBench: a 30-test slice\*

[DolphinBench](https://dolphinbench.ai/) is Mem0's agent-memory benchmark.
An agent gets a request and real app tools (email, calendar, Slack, CRM and more).
The benchmark grades what the agent does, using facts from up to five years of one person's messages.
Curate ran 30 of its 600 tests: the curator wrote a dated log, and the agent read only that log.

| System | Agent | Passed, of these 30 | List cost a test |
| --- | --- | --- | --- |
| **Curate** | GPT-5.6 Luna, high, through the Codex CLI | **22** | $0.24 (est.) |
| Honcho | GPT-5.6 Luna, high, in Hermes | 21 | $0.24 |
| Mem0 | GPT-5.6 Luna, high, in Hermes | 20 | $0.16 |
| Hindsight | GPT-5.6 Luna, high, in Hermes | 19 | $0.14 |
| Hermes built-in memory | GPT-5.6 Luna, high, in Hermes | 17 | $0.10 |
| No memory | GPT-5.6 Luna, high, through the Codex CLI | 0 | |
| The test's own fact messages, given directly | GPT-5.6 Luna, high, through the Codex CLI | 29 | |

The published systems' results are their own per-test files in the DolphinBench repository.
Their costs per test are each published run's total cost divided by 600.
Every Curate log, app call and verdict is in [the proof files](dolphinbench/2026-10-22/README.md).
How this run was set up: [How each result was run](#how-each-result-was-run).

\* **Small print**

- **Unofficial.** This is not a DolphinBench submission. The model-judged checks ran on gpt-5.6-sol through the Codex CLI, not the benchmark's own judge setup. On Mem0's published tool calls for these 30 tests, this judge agreed with Mem0's published verdicts on all 30.
- **A slice.** The 30 tests are every 20th test for each of the three people. One test is 3.3 points, and published systems change order on slices this small.
- **A different agent harness.** The agent ran in the Codex CLI with only the test's app tools, not in Hermes. It used the same model and reasoning setting as the published runs.
- **One run.** Each test ran once.
- **Cost.** The curator read about 93,000 tokens a test, priced at gpt-6.1-sol's list price. It ran on a ChatGPT plan. Jev's decisions were replayed from a saved cache of an earlier run on these tests, and deciding fresh would add about $0.009 a test. Mem0's published cost includes its one-off memory building.

## Where the cost goes

A small answering context doesn't show the full cost. Preparing the memory costs money too.
Mem0 and Zep read the whole history once, as messages arrive, and Mastra's observer reads it once.
For LongMemEval, Jev, the decision model, scored the whole history. Its list price is $0.042 per million input tokens, with no charge for output.
The curator reads only the parts Jev scores 0.0146 or higher.
That keeps the curator's input to about 51,000 tokens a question in the LongMemEval GPT-5-mini run and about 34,000 in the GPT-5 run.
The answering model is usually the most capable and costly one, and it reads only the curator's log.

## How each result was run

**LongMemEval, GPT-5.** The benchmark harness gave the decision model every part of each history. Only parts it scored 0.0146 or more reached the curator: about 70 of a history's 851 parts. By default, the decision model also sorts each part into label kinds, such as preferences, habits and events. That did not change which parts the curator received. Every part was already going to the decide step, and the curator's input was the same as without them on all 500 questions ([how this was checked](longmemeval/2026-10-22/README.md#labels-changed-nothing)). Answers, verdicts and build details are in [its proof files](longmemeval/2026-10-22/README.md).

**LongMemEval, GPT-5-mini.** The GPT-5-mini run used the same settings as the GPT-5 run, at commit `aacb042`, before chat labels were added. Its answers, verdicts and logs are in [its proof files](longmemeval/2026-10-14-gpt-5-mini/README.md).

**Both LongMemEval runs.** The curator received only parts that the decision model scored 0.0146 or higher. Across 249 of the 500 questions, 0.0146 was the highest score threshold that kept every message containing an answer.
Both runs replay the same saved decisions, so no part was scored again for them.
No answer was cut short by an output limit. Two GPT-5 answers ran into the 4,096-token cap of Mem0's client and were answered again with no cap. No other answer reached it.

**LoCoMo.** The LoCoMo slice used Curate's presets as they come. The benchmark harness gave the decision model every part of each conversation, and only parts it scored 0.0146 or more reached the curator. Its chat labels changed nothing the curator received ([how this was checked](locomo/2026-10-22/README.md#labels-changed-nothing)).

**DolphinBench.** The DolphinBench run used the presets as they come, with chat labels turned off. Keyword searches chose which parts of the history Jev scored. Only parts scoring 0.0146 or more went to the curator.
Keyword searches selected about 525 of a history's 5,500 parts for Jev to score. About 330 of them scored 0.0146 or more and went to the curator.
Replayed on the release build, Curate `8e37c76`, with the same settings and saved decisions, every test selects the same parts and gives the curator a byte-identical prompt: 30 of 30.

## Dials for cost, speed and score

Curate's options let each use set its own balance of cost, speed and score.
A host can send every scored part to the curator, or choose a score cut that sends fewer parts.
These dials were measured on 249 of the 500 questions, with gpt-6.1-sol curating unless named, GPT-5-mini answering and GPT-4o marking:

| Dial | Parts the curator reads | Correct of 249 | Cost per question (list, est.) |
| --- | --- | --- | --- |
| Decision score 0.0146 or more | 70 | 225, then 223 in the all-500 run | $0.13 |
| Decision score 0.05 or more | 10 | 231, then 223 on a repeat | $0.11 |
| Scaled top-k: the top 0.68 × N^0.8 of the keyword-and-label ranking | 150 | 229 | $0.18 |
| gpt-6-luna as the curator, at two of these inputs | 10 to 150 | 217 to 221 | $0.015 to $0.037 |

N is the number of parts in the history.
