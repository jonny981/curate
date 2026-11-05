# Benchmarks

## Results at a glance

On LongMemEval's own grader (`evaluate_qa.py`, GPT-4o), all 500 questions, answered by gpt-6.1-sol:

| Curate setting | Score | Memory tokens a question (mean) | Less than the raw history |
| --- | --- | --- | --- |
| **Markup** | **93.8** (469/500) | **844** | **121x** |
| Cited-only markup | 93.0 (465/500) | 854 | 120x |
| Log | 92.6 (463/500) | 449 | 229x |

- **Against Mem0's published answers, marked by the same grader in the same session:** Curate's markup setting 467 (93.4), Mem0 455 (91.0). The same Curate answers scored 469 when marked the day before. Mem0's answers come from GPT-5, Curate's from gpt-6.1-sol.
- **Against the context other systems report on LongMemEval:** about 6 to 35 times less than Zep (4,408 median, against Curate's 685 median), Mem0 (6,787 mean) and Mastra (about 30,000 mean).
- **The packages write the log setting and the cited-only markup setting.** The log is `compression: 'high'`, the default, and cited-only markup is `compression: 'low'`. The markup setting's published results, including 93.8%, came from runs outside the packages. The answers, memory texts and grader output are in [`benchmarks/longmemeval/2026-11-04/`](longmemeval/2026-11-04/README.md).

The packages' published results beside other systems' published results, with up to 62 times fewer tokens. Answering models and markers differ:

| Benchmark | System | Task model | Score | Task model tokens |
| --- | --- | --- | --- | --- |
| **LongMemEval S** | **Curate** | **GPT-5** | **93.4** | **449** |
| LongMemEval S | [Mem0 platform](https://github.com/mem0ai/memory-benchmarks/blob/4b61c5d31b9c668a12b4f5e78064248a02c82d2b/results/platform/longmemeval_results.json) | GPT-5 | 93.4 | 6,787 mean (15x more) |
| **LongMemEval S** | **Curate** | **GPT-5-mini** | **91.6** | **485** |
| LongMemEval S | [Mastra observational memory](https://mastra.ai/research/observational-memory) | GPT-5-mini | 93.6 | ~30,000 mean (62x more) |
| LongMemEval S | [Zep](https://getzep.com/research) | GPT-5.4 | 90.2 | 4,408 median (10x more) |

The task model does the work (here, answering the question), and you do not want to flood its context with noise.

*Each multiplier compares with Curate on the same task model, or on GPT-5 for Zep's GPT-5.4: 449 tokens with GPT-5, 485 with GPT-5-mini. See the [full comparison](#against-published-systems) for scoring methods and costs.*

DolphinBench: **22 of 30 tests passed**, at $0.24 a test at list prices. [See the results](#dolphinbench-mem0s-benchmark-a-30-test-slice).

## Results

LongMemEval tests whether a model can answer questions from a long chat history.
Curate ran all 500 LongMemEval S questions twice, and the curator wrote one log per question.

The answering model read only the log.

| System | Answering model and marker | All 500 | Context tokens (mean) | [Adjusted score](#adjusted-score) | Cost per question (list, est.) |
| --- | --- | --- | --- | --- | --- |
| **Curate** | GPT-5 answers, GPT-5 marks | **93.4** (467/500) | 449 | **98.9** | $0.16 |
| **Curate** | GPT-5-mini answers, GPT-4o marks | **91.6** (458/500) | 485 | **96.9** | **$0.12** |

The GPT-5 row's curator read about 34,000 tokens a question, the GPT-5-mini row's about 51,000.

How these runs were set up: [How each result was run](#how-each-result-was-run).

### LongMemEval's own scorer

The same answers, judged by LongMemEval's own `evaluate_qa.py` (commit `9e0b455`) with its dated GPT-4o judge, `gpt-4o-2024-08-06`:

| Answering model | Overall | Average of the six types | Abstention questions |
| --- | --- | --- | --- |
| **GPT-5** | **91.8** (459/500) | 92.8 | 26/30 |
| **GPT-5-mini** | **90.8** (454/500) | 89.3 | 23/30 |

The answers are in LongMemEval's own format (`question_id`, `hypothesis`), with the scorer's output for every question, in [`official-scorer/`](longmemeval/2026-10-22/official-scorer/) for the GPT-5 run and [`official-scorer/`](longmemeval/2026-10-14-gpt-5-mini/official-scorer/) for the GPT-5-mini run. Anyone with the dataset and an OpenAI key can score them again.

With gpt-6.1-sol answering, the same scorer gives the markup setting 93.8 (469/500), the cited-only markup setting 93.0 (465/500) and the log setting 92.6 (463/500). Mem0's published answers score 90.6 (453/500) on it, and 91.0 (455/500) when marked in the same session as Curate's markup answers, which then scored 467. Files: [`benchmarks/longmemeval/2026-11-04/`](longmemeval/2026-11-04/README.md).

### Against published systems

| System | What you run | Answering model | Score | Answering context | Answering input cost | Full pipeline cost |
| --- | --- | --- | --- | --- | --- | --- |
| **Curate** | A TypeScript library: plain files, no database | GPT-5-mini | 91.6 | 485 | $0.0001 | **$0.12** at list prices (est.) |
| **Curate** | A TypeScript library: plain files, no database | GPT-5 | 93.4 | **449** | **$0.0006** | $0.16 at list prices (est.) |
| [Mem0 platform](https://github.com/mem0ai/memory-benchmarks/blob/4b61c5d31b9c668a12b4f5e78064248a02c82d2b/results/platform/longmemeval_results.json) | Mem0's hosted platform | GPT-5 | 93.4 | 6,787 mean | $0.0085 | not published |
| [Mastra observational memory](https://mastra.ai/research/observational-memory) | A TypeScript framework you run, with a storage provider | GPT-5-mini | 93.6 (94.87 by type) | ~30,000 mean | $0.0075 | ~$0.045 (est.) |
| [Zep](https://getzep.com/research) | Zep's hosted service is its recommended setup | GPT-5.4 | 90.2 | 4,408 median | not priced | not published |
| No memory: GPT-5 reads the whole history | Nothing | GPT-5 | not run | ~122,000 | $0.153 | $0.153 |

Costs are per question.

- **On LongMemEval's own grader, Curate is ahead of Mem0's published answers:** 467 against 455, both marked in one session, with Curate's markup setting reading 844 tokens a question against Mem0's 6,787. The answering models differ: gpt-6.1-sol for Curate, GPT-5 for Mem0.
- **On GPT-5, Curate matches Mem0 with 15 times less context** (93.4 against 93.4, both marked by GPT-5; 449 tokens against 6,787).
- **On GPT-5-mini, Mastra's raw score is higher:** 93.6 against Curate's 91.6 per question, and 94.87 against 90.22 as an equal average of the six question types. Its answering model reads about 62 times more context.
- **Curate has the highest adjusted score** of these systems, because its answering model reads the least context.
- **On LoCoMo, Curate scores 93.7 (149/159) with GPT-5,** against Mem0's own published answers on the same 159 questions, 94.3 (150/159), and 91.6 across all 1,540 ([proof files](locomo/2026-10-22/README.md)).

**Notes on the table**

- **Answering input cost** = the answering context × the answering model's input price. It prices every system the same way.
- **Curate's full pipeline costs are estimates from the runs' call records:**
  - Jev decisions: $0.0097 a question.
  - Curation, on a ChatGPT subscription, priced at gpt-6.1-sol's list price of $2.00 per million input tokens and $10 per million output tokens (third-party price list, 11 October 2026): about 51,000 input tokens a question in the GPT-5-mini run, about 34,000 in the GPT-5 run.
  - The GPT-5 row's estimate is the GPT-5-mini row's $0.12, plus the GPT-5 answer ($0.014 a question) and chat labels (about $0.025 a question).
- **Mastra's full pipeline cost is an estimate:** its observer reads each history once with gemini-2.5-flash, at $0.30 per million input tokens (about $0.037), plus the answer. Observer output is not counted.
- **What you run:** Mem0's result file comes from Mem0 Platform, its hosted service. Zep recommends its hosted service; its research page does not say which setup produced 90.2. Mastra's observational memory runs in its TypeScript framework with a storage provider. Curate needs no database and no server: it is a package that writes plain files and calls the decision model, curator and answering model you choose.
- **Mem0 and Zep do not publish** their ingestion models or calls.
- **Marking models differ:** GPT-5 for Curate's GPT-5 row and for Mem0, GPT-4o for Curate's GPT-5-mini row and for Mastra, GPT-5.4 for Zep.
- **Token counting differs** too, including Zep's median in place of a mean. The rows compare roughly; they are not one controlled run.
- **Prices:** OpenAI's list prices, checked 13 October 2026. Jev: $0.042 per million input tokens, output free.

### Adjusted score

```text
adjusted score = answer score − 5 × log10(context tokens ÷ 5,698)
```

The 5,698-token reference is the mean context of only the sessions containing the answer, over all 500 questions, counted with GPT-4o's token counter.
This is LongMemEval's oracle setting: perfect selection of sessions, rather than the shortest possible answer.
Halving the context adds about 1.5 points; doubling it removes about 1.5.
Adjusted score is a custom measure, not LongMemEval's official score.
It counts the answering model's context, excluding decisions, curation and ingestion work.

### DolphinBench: Mem0's benchmark, a 30-test slice\*

[DolphinBench](https://dolphinbench.ai/) is Mem0's agent-memory benchmark.
An agent gets a request and real app tools (email, calendar, Slack, CRM and more), and the benchmark grades what the agent does, using facts from up to five years of one person's messages.
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

The published systems' results are their own per-test files in the DolphinBench repository; their costs are each published run's total over 600 tests.
Every Curate log, app call and verdict is in [the proof files](dolphinbench/2026-10-22/README.md).
How this run was set up: [How each result was run](#how-each-result-was-run).

\* **Small print**

- **Unofficial.** This is not a DolphinBench submission. The model-judged checks ran on gpt-5.6-sol through the Codex CLI, not the benchmark's own judge setup. On Mem0's published tool calls for these 30 tests, this judge agreed with Mem0's published verdicts on all 30.
- **A slice.** 30 of 600 tests: every 20th test for each of the three people. One test is 3.3 points, and published systems change order on slices this small.
- **A different agent harness.** The agent ran in the Codex CLI with only the test's app tools, not in Hermes, with the same model and reasoning setting as the published runs.
- **One run.** Each test ran once.
- **Cost.** The curator read about 93,000 tokens a test, priced at gpt-6.1-sol's list price; it ran on a ChatGPT plan. Jev's decisions were replayed from a saved cache of an earlier run on these tests; deciding fresh would add about $0.009 a test. Mem0's published cost includes its one-off memory building.

### Where the cost goes

Every memory system reads the whole history with some model. Mem0 and Zep read it once, as messages arrive; Mastra's observer reads it once; Curate reads it for each question.
Curate reads it twice per question: once with the decision model, at $0.042 per million tokens, and once with the curator.
The 0.0146 cut keeps the curator's input to about 51,000 tokens a question in the LongMemEval GPT-5-mini run and about 34,000 in the GPT-5 run, for a list cost of $0.12 and $0.16 a question, while the answering model, usually the most capable and costly one, reads 449 to 485 tokens.

### How each result was run

The runs used the settings described below. This section says how each run was set up, built and fed.

**LongMemEval, GPT-5.** The benchmark harness gave the decision model every part of each history, and only parts it scored 0.0146 or more reached the curator: about 70 of a history's 851 parts. Chat labels were asked, as they are by default, and changed nothing here: every part was already going to the decide step, and the curator's input was the same as without them on all 500 questions ([how this was checked](longmemeval/2026-10-22/README.md#labels-changed-nothing)). Answers, verdicts and build details are in [its proof files](longmemeval/2026-10-22/README.md).

**LongMemEval, GPT-5-mini.** The same decide and keep settings, at commit `aacb042`, a build from before labels existed. Its answers, verdicts and logs are in [its proof files](longmemeval/2026-10-14-gpt-5-mini/README.md).

**Both LongMemEval runs.** 0.0146 is the chat reader's decision-score bar. In a measurement on 249 of the 500 questions, 0.0146 was the highest cut that lost no answer message.
Both runs replay the same saved decisions, so no part was scored again for them.
No answer was cut short by an output limit: two answers of the GPT-5 run that ran into the 4,096-token cap of Mem0's client were answered again with no cap, and no other answer reached it.

**LoCoMo.** The LoCoMo slice used Curate's presets as they come. The benchmark harness gave the decision model every part of each conversation, and only parts it scored 0.0146 or more reached the curator. Its chat labels changed nothing the curator received ([how this was checked](locomo/2026-10-22/README.md#labels-changed-nothing)).

**DolphinBench.** The DolphinBench run used the presets as they come, with chat labels turned off, so the chat reader's keyword lanes chose the parts and only parts scored 0.0146 or more reached the curator.
From a history of about 5,500 parts, Jev scored about 525 that the keyword lanes chose, and about 330 scored 0.0146 or more went to the curator.
Replayed on the release build, Curate `8e37c76`, with the same settings and saved decisions, every test selects the same parts and gives the curator a byte-identical prompt: 30 of 30.

### Settings: dials for cost, speed and score

Curate's options let each use set its own balance of cost, speed and score.
A host can send every scored part to the curator or choose a score cut that sends fewer parts.
These dials were measured on 249 of the 500 questions, with gpt-6.1-sol curating unless named, GPT-5-mini answering and GPT-4o marking:

| Dial | Parts the curator reads | Correct of 249 | Cost per question (list, est.) |
| --- | --- | --- | --- |
| Decision score 0.0146 or more | 70 | 225, then 223 in the all-500 run | $0.13 |
| Decision score 0.05 or more | 10 | 231, then 223 on a repeat | $0.11 |
| Scaled top-k: the top 0.68 × N^0.8 of the keyword-and-label ranking | 150 | 229 | $0.18 |
| gpt-6-luna as the curator, at two of these inputs | 10 to 150 | 217 to 221 | $0.015 to $0.037 |

- **N** is the number of parts in the history.
