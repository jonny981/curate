# LongMemEval S, all 500 questions, gpt-6.1-sol answering

Curate built one memory text for each of the 500 questions, and gpt-6.1-sol answered from that text.
Two graders marked every answer: gpt-6.1-sol with LongMemEval's own marking prompts, and LongMemEval's own grader (`evaluate_qa.py`, unchanged, judge `gpt-4o-2024-08-06`).
The same two graders marked Mem0's published answers.

| File | Answers | Answering model | Marked by gpt-6.1-sol | Marked by LongMemEval's grader |
| --- | --- | --- | --- | --- |
| `curate-sol.jsonl` | Curate | gpt-6.1-sol | 471/500 = 94.2% | 464/500 = 92.8% |
| `mem0-platform.jsonl` | Mem0's published answers | GPT-5 | 463/500 = 92.6% | 455/500 = 91.0% |

`scores.json` holds these results by question type, with the six-type average, the abstention questions and the sizes of the memory texts.

## Six answer sets

Curate built the 500 memory texts once.
gpt-6.1-sol then wrote answers from them six times, and gpt-6.1-sol marked each set of answers.
These are six repeats of the answering and the marking over one set of memory texts, not six runs from start to end.

| Answer set | 1 | 2 | 3 | 4 | 5 | 6 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Right of 500, marked by gpt-6.1-sol | 469 | 466 | 471 | 470 | 470 | 467 |

The published answers are set 3, the set with the highest score.
LongMemEval's grader marked set 3 once.
`answer-sets.jsonl` holds all six sets, with the verdict of gpt-6.1-sol on each answer.

## Context sizes

The memory text is everything the answering model read about the person's history.
Each history has about 48 sessions and 102,580 o200k tokens on average (every turn's role and text).

| Mean tokens | Median | 90th percentile | Longest | Shortest | Times less than the history |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,576.6 | 1,691.5 | 1,793 | 1,967 | 294 | 65.1 |

[Mem0 reports](https://github.com/mem0ai/mem0/blob/main/docs/core-concepts/memory-evaluation.mdx) a mean of 6,787 tokens for the context its answering model read.

## How the memory text is built

1. **Decide:** Jev, the decision model, answered the chat package's `CHAT_CASCADE` questions (`relevant`, `own`, `needed`) about every part of each history. The answers combine into a weight for each part: the probability that the part bears on the question. Parts with a weight of 0.0146 or more are kept, about 70 a history. The decisions were made once and saved, and every memory text here is built from the saved decisions.
2. **Lay out:** Curate's `curate()` takes the kept parts in weight order, strongest first. It stops before the part that would take the text over 2,000 estimated tokens (`answerTokens`, the default). The two strongest parts come first, under `### Most likely answer`. The other parts follow, grouped by session and by the date they were said, oldest first. Each part is the history's own text, the person's turns and the assistant's, word for word.
3. **Keep the sentences that bear on the question:** Jev (`jev-latest`) rates each sentence of the laid-out parts, in one request a question. The text keeps the sentences rated 0.1 or more (`sentenceCutoff`, the default). `…` marks where text was left out.

No model writes, shortens or rewrites the memory text. The sentence step only leaves sentences out.

- **The estimate:** it counts words, digits, punctuation and line ends, with weights fitted to a real tokenizer and a margin on top. It needs no tokenizer.
- **Session names:** each session's LongMemEval id is replaced with a neutral name, `session-001` onward in date order, because some LongMemEval ids name the sessions that hold the answer.
- **Build:** Curate at commit `cb7edc3` built the 500 memory texts. Curate at commit `89fe3f8` rebuilds all 500 byte for byte from the kept parts, their saved weights and the saved sentence ratings, with no model call.

## Answering

- **Model:** gpt-6.1-sol, at medium reasoning effort, on a ChatGPT plan through the Codex CLI.
- **Prompt:** Mem0's answering prompt from its benchmark, with the lines written for one particular test question removed. Examples whose subject appears in a LongMemEval question, answer or evidence session were replaced with invented ones. Two additions come before the memories: rules for reading the memories, and a paragraph on near matches. The full prompt is below.
- **Input:** the benchmark fields supplied to the prompt are the question, its date and the memory text. The Codex CLI received the prompt after one line, "Answer from the text below only. Do not run any command and do not read any file.", and adds its own instructions. The context sizes above measure only the memory text.
- **Same input every time:** each of the six answer sets sent the same request for each question, byte for byte.
- **Answer:** the model's reply, unchanged. Four replies in set 3 start with a short `<mem_thinking>` block.

### The prompt

`{question_date}`, `{question}` and `{memories}` are replaced with the question's date, the question and the memory text.

```text
You are a personal assistant with access to memories from past conversations with a user. Answer the question using information from the memories below. Be direct and concise.

IMPORTANT: Today's date is {question_date}. All relative time expressions MUST be computed relative to this date.

IMPORTANT: If memories indicate the user wants to avoid something, your answer must NOT contain it — not as primary, secondary, or context.

IMPORTANT: If memories contain the numbers needed to compute the answer (ages to subtract, prices, dates to diff), DO the computation. NEVER abstain when the raw data exists — even scattered across different conversations.

IMPORTANT: Keep your responses short. No need to go into too much detail, no need to describe things at the lowest level. You can generally describe events and ideas abstractly.

IMPORTANT: Look closely at the EXACT entity in the question. If the question asks about a specific variant and memories only mention a DIFFERENT variant (e.g., a "folding kayak" vs an "inflatable kayak"), abstain — these are talking about different things!

IMPORTANT: For comparison/savings questions, BOTH costs must come from USER-stated facts (or relayed by the user from someone else). Do NOT use assistant-provided general info. If only one side has a user-stated cost, abstain.

IMPORTANT: If the query uses a specific but WRONG role/title/entity (e.g., asks about experience as a "Head Gardener" but memories say "Senior Horticulturist"), do NOT answer as if they match — instead say you don't have the information! Always lean towards abstention in these cases! Do not mix up different role titles, they are not the same roles and you should say you don't have information.

Before answering, reason step-by-step inside <mem_thinking> tags:
- List every relevant memory; try to list all memories relevant to what the user wants to do! Eg. List memory of Payment management apps if query is about paying someone; list memory of travel management apps if query is about going somewhere.

- For counting: enumerate each item with date. Apply the question's EXACT verb/qualifier strictly (e.g., a question about what the user "varnished" counts only varnishing the user finished; a question about money the user "collected" includes the totals of events the user took part in). Count multiple items in a single memory separately. Do a SECOND full scan of all memories after initial count — items at positions 30-200 are commonly missed. Verify each item is a completed action (past tense), not a plan ("plans to", "intends to").
- For cross-topic computation: scan ALL memories for each needed fact independently — they're often in unrelated conversations. List: (a) what you need, (b) where each appears, (c) the computation.
- For temporal questions: identify dates, compute intervals from {question_date}
- CONTEXT CHECK: Before using a memory's value, verify it applies to the SAME context as the question. A bedtime "while on night shifts" is NOT the same as a regular weekday bedtime. A "general daily" schedule may conflict with a "specific weekday" schedule — always prefer the more specific memory that matches the question's context. List the context of each memory (weekday routine vs. travel vs. weekend vs. specific day) and only use values from the matching context.
- For time-bounded counting: compute the INCLUSIVE date window first, then check EVERY item's date. Err on inclusion for ambiguous dates.
- For "where is X": trace location chronologically through memories
- For suggestions: list (a) what user has/does, (b) what they avoid/dislike, (c) what they want to explore. Check every suggestion against (b) before including.
- State your conclusion

The user will only see text outside the <mem_thinking> tags.

Rules:

1. **Always try to answer**: If the topic appears in any memory — even indirectly — answer using what you have. Don't refuse for one missing detail.

2. **Most recent wins**: For conflicting values of the same fact, use the most recent memory. But: (a) memories about different people/contexts aren't conflicting; (b) for historical event dates, use the memory recorded closest to the event; (c) for current counts/scores/status, the latest value REPLACES all earlier ones — don't sum or average.

Similarly, when memories give two numbers for the same metric (e.g., "has 410 subscribers" and "close to 450 subscribers") on the same date, treat the HIGHER/UPDATED value as current — "close to 450" means the count has grown from 410 to approximately 450.

3. **Time-bounded questions**: Compute the date window from {question_date}. Show date arithmetic in <mem_thinking>. Scan EVERY memory for events in range. "Last weekend" is imprecise — could mean up to 10 days ago as people sometimes mean weekend before the latest one. "Last 3 months" can include boundary days of the 4th month back.

"Last month" includes the current month so far as well as the previous month. Eg. "last month" in Late May includes all of April. If the literal window yields nothing, check the immediately preceding period.

4. **Temporal reference points**: When a question asks how long before Y something X happened, compute the interval between X and Y, NOT between X and today.

5. **Counting and ordering**: Scan ALL memories first to last. Build a numbered list in <mem_thinking> with date and position. Deduplicate by matching dates/descriptions. Count items in a single memory separately.
Any addition to a list on the same day as a stated count is already included in the count

When asked to count all instances of an event *before* a specific one, obviously don't include the specific one in the count. Eg. "how many restaurants did i visit before eating at the Larkspur Diner?". Obviously don't include the Larkspur Diner in the count

6. **Use only the memories**: Don't invent numbers, prices, or addresses.

7. **When to abstain**: Say "The information provided is not enough" when:
   - The topic is genuinely unmentioned

- The question asks about a specific event that doesn't exist, even if a related topic does

- IMPORTANT: If the query uses a specific but WRONG role/title/entity (e.g., asks about experience as a "Head Gardener" but memories say "Senior Horticulturist"), do NOT answer as if they match — instead say you don't have the information! Always lean towards abstention in these cases! Do not mix up different role titles, they are not the same roles and you should say you don't have information.

   - For comparison/ordering, BOTH items must be present as completed events
   If query asks to compare timings of two tasks and one of them did not even happen, abstain.
   Before abstaining, do a keyword scan of ALL memories (they're chronological, not relevance-sorted — check positions 1-200). Only abstain if NO keywords match.
   EXCEPTIONS: For suggestion questions, don't abstain for lack of real-time info — recommend based on known preferences. If you lack exact brand but have the store, output the store.

8. **Yes/no and comparison**: "Did I ever do X?" with no matching memory = "No." For comparisons, find both values across all memories and compare directly.

9. **Actions vs intentions**: Use the date of actual execution, not the plan date. "Decided to" or "took X for servicing" = action initiated. Only treat as plan if explicit future-tense ("plans to", "will"). A plan with a specified date and no update = assume completed on that date. If a later memory confirms execution, use the execution date — it supersedes the earlier plan.

When a query asks: "when I decided to do X", it means they are asking when X was actually done.

10. **User facts vs assistant advice**: "User..." = actual experience. "Assistant..." = advice. Prefer user-stated facts for personal questions. Don't convert currencies unless user stated the conversion.

11. **Connect memories across topics**: Facts needed for computation are often in unrelated conversations (a discount rate mentioned in one chat + a price mentioned in another). Search ALL memories for each fact independently.

12. **Personalization**: For suggestions/recommendations:
   - Prioritize personal preferences over informational content
   - Apply known preferences to new contexts — don't abstain for unfamiliar destinations
   - Acknowledge prior work before suggesting next steps
   - Respect anti-preferences — check every suggestion against known dislikes
   - Reference existing tools owned, not to acquire
   - Lead with personalization, don't pad with generic alternatives
   - Suggest similar things to the user as their habits. Eg. Logging chess results in an app they already use. Eg. Adding hiking notes to a journal app they already use.
   - IMPORTANT: Scan ALL top memories for user-owned tools, apps, and resources relevant to the question. If the user has a transit card, a trip planner app, a budgeting tool, etc., mention ALL of them — not just the most obvious one. Do a SECOND pass of the top 30 memories specifically looking for apps, tools, and resources the user has mentioned owning or using.

13. **Reasonable deduction**:
- Infer from patterns
IMPORTANT: Assume that similar items referenced in the same sentence have the same type.
Eg. "User ate dinner, which was the second meal from this mushroom risotto". This means the other meals from this mushroom risotto were dinners too, and should be treated as explicit dinners.

14. IMPORTANT: If two pieces of memory directly contradict each other (not just an update, a direct contradiction), then assume that the memory that was created later is true. Doesn't matter if a different one "appears" more reliable. If on the same day, trust the one at a later time.

- Chronological actions:
If the user is reading the 7th chapter of a book in order, assume they have read the earlier 6 too.

- If you lack a name but have a description, answer with the description.

**Memory grouping rules**: Memories under the same date heading are from the same conversation.
- A count + "added X items" on the SAME date = count already includes them
- "Aims to beat X" = X is the current value
- "Previous" = the value superseded by a more recent one
- Events described as just completed ("attended", "went to", "just got back from", "completed") = happened on/near that date. Undated actions = assume the event happened on the memory's date.

How to read the memories (the curator's own reading rules):
- Count each event once. An event is one thing that happened, was done, bought, made, attended, planned or wished for. When two memories tell the same event, it is one event.
- An event counts only when it is the right person, the right kind of event, done or planned as the question asks, and inside any period the question names. It does not count when it is about another person or another kind of thing, is a plan or wish when the question asks what happened, falls outside the period, or repeats another event.
- Who said it: "user:" lines are the user. From the assistant, use only the specific names, places, numbers or dates it gave as an answer or a recommendation, for example a restaurant or a book it recommended. Leave out its general advice.
- Status of each event: "done" (it happened), "planned" (intended or scheduled), "wished" (wanted, considered or hoped for), or "other".
- What replaced what: when a later memory is a newer correction or decision about the same subject, the later value is the current one; an earlier value is out of date.
- Preferences and tone: note each liking or dislike (loves, likes, dislikes, hates, prefers, avoids, wants) and whether it is strong or mild. Note words whose tone changes their meaning, for example joking, wishful, unsure.
- Dates: work out the day an event happened from the date it was said ("last Friday" said on 2024-02-16 is 2024-02-09). Each memory gives the date it was said.
- Amounts and quantities: money with its currency sign, for example "$38"; a number and its unit as the memory gives it, for example "4 laps", "35 minutes", "140 slides". Take every value from the memories; never guess.

Near matches: when the memories hold something close to what the question names but one detail differs (another name, kind, title, person or date), do not stop at a refusal. First say plainly what the memories do not record, then give the answer for the closest matching memory and name the detail that differs. Decline with nothing more only when no memory is close.

Memories (sorted newest-first, grouped by date):
{memories}

Today's Date: {question_date}
Question: {question}

IMPORTANT: You MUST provide your full thinking in <mem_thinking> tags BEFORE giving your answer.; Reasoning and answer:
```

## Marking

- **gpt-6.1-sol:** LongMemEval's own marking prompts, from `evaluate_qa.py` at commit `9e0b455f4ef0e2ab8f2e582289761153549043fc`: the prompt for each question type, and the prompt for questions the history does not answer. gpt-6.1-sol, at medium reasoning effort, through the Codex CLI, is the judge. An answer is right when the judge replies yes. The judge reads each answer with any `<mem_thinking>` block removed. Each answer set was marked once.
- **LongMemEval's grader:** `evaluate_qa.py` at commit `9e0b455f4ef0e2ab8f2e582289761153549043fc`, unchanged, with judge `gpt-4o-2024-08-06`. It reads each answer whole. It marked set 3 once.
- **Where the graders differ:** on Curate's 500 answers, gpt-6.1-sol marks 9 answers right that LongMemEval's grader marks wrong, and 2 answers wrong that LongMemEval's grader marks right.

## Mem0's answers

- **Source:** the generated answer in each entry of Mem0's published results file ([`results/platform/longmemeval_results.json`](https://github.com/mem0ai/memory-benchmarks/blob/4b61c5d31b9c668a12b4f5e78064248a02c82d2b/results/platform/longmemeval_results.json) at commit `4b61c5d31b9c668a12b4f5e78064248a02c82d2b`, SHA-256 `58bd6d8934a54d8cd568ef481bbd3e37270c2c74a5d59713b661d4c3ddb332a1`), taken from the text after "Generated answer: " in its `reason` field. All 500 entries have one. Mem0's answering model is GPT-5.
- **gpt-6.1-sol's verdicts:** one marking, with the same prompts and settings as Curate's answers.
- **LongMemEval's grader's verdicts:** the grader marked these answers twice, and its output for both markings is in [`../2026-11-04/official-scorer/`](../2026-11-04/official-scorer/): 455 right in `same-session-2026-11-05/` and 453 in `mem0-2026-10-31/`. `mem0-platform.jsonl` holds the verdicts of the marking that scored 455.
- **Mem0's own figure:** Mem0 reports 93.4% for these answers, marked by GPT-5 in its own run.

## Fields

Each line of `curate-sol.jsonl` is one question:

| Field | Meaning |
| --- | --- |
| `id`, `type`, `abstention` | LongMemEval's question id, question type, and whether the right answer is that the history does not say |
| `question`, `question_date`, `gold_answer` | from the dataset |
| `memory_text` | the exact memory text the answering model read |
| `context_tokens_o200k` | that text's length in o200k tokens |
| `answer_model`, `answer` | the answering model and its answer in set 3 |
| `sol_marker_model`, `sol_correct`, `sol_marker_reply` | the gpt-6.1-sol judge, its verdict and its reply |
| `official_marker_model`, `official_correct` | LongMemEval's grader and its verdict |

Each line of `mem0-platform.jsonl` is one question, with `id`, `type`, `abstention`, `answer_model`, `answer` and the same verdict fields.

Each line of `answer-sets.jsonl` is one question: `id`, `answers` (the six answers, in set order) and `sol_correct` (the six verdicts of gpt-6.1-sol, in the same order).

## Recount the scores

The verdicts of both graders, for Curate and then for Mem0:

```sh
python3 -c "import json,sys; r=[json.loads(l) for l in open(sys.argv[1])]; print(sum(x['sol_correct'] for x in r), sum(x['official_correct'] for x in r), len(r))" curate-sol.jsonl
python3 -c "import json,sys; r=[json.loads(l) for l in open(sys.argv[1])]; print(sum(x['sol_correct'] for x in r), sum(x['official_correct'] for x in r), len(r))" mem0-platform.jsonl
```

The six answer sets, and a check that set 3 holds the published answers and verdicts:

```sh
python3 -c "import json,sys; r=[json.loads(l) for l in open(sys.argv[1])]; print([sum(x['sol_correct'][k] for x in r) for k in range(6)])" answer-sets.jsonl
python3 -c "import json,sys; a=[json.loads(l) for l in open(sys.argv[1])]; c=[json.loads(l) for l in open(sys.argv[2])]; print(len(a) == len(c) and all(x['id'] == y['id'] and x['answers'][2] == y['answer'] and x['sol_correct'][2] == y['sol_correct'] for x, y in zip(a, c)))" answer-sets.jsonl curate-sol.jsonl
```

Count the memory texts' o200k tokens (mean, median, 90th percentile, longest, shortest), and the histories' mean. These need `tiktoken`, and the second needs the dataset:

```sh
python3 -c "import json,sys,statistics,tiktoken; e=tiktoken.get_encoding('o200k_base'); t=sorted(len(e.encode(json.loads(l)['memory_text'], disallowed_special=())) for l in open(sys.argv[1])); print(round(statistics.mean(t), 1), statistics.median(t), t[int(0.9 * len(t))], t[-1], t[0])" curate-sol.jsonl
python3 -c "import json,sys,statistics,tiktoken; e=tiktoken.get_encoding('o200k_base'); print(round(statistics.mean(len(e.encode('\n'.join(t['role'] + ': ' + t['content'] for s in q['haystack_sessions'] for t in s), disallowed_special=())) for q in json.load(open(sys.argv[1]))), 1))" longmemeval_s_cleaned.json
```

## LongMemEval's own grader

- **`official-scorer/curate-sol.jsonl`:** set 3's 500 answers in LongMemEval's hypothesis format, one `question_id` and `hypothesis` a line. This is the file the grader reads. The `curate-sol.jsonl` beside this README has other fields and no `question_id`, so the grader cannot read it.
- **`official-scorer/curate-sol.jsonl.eval-results-gpt-4o`:** the grader's verdict for every question (`autoeval_label`).
- **`official-scorer/curate-sol.metrics.txt`:** the output of `print_qa_metrics.py`: overall accuracy 0.928, task-averaged accuracy 0.9196 and abstention accuracy 0.9667.

The commands below run from the `src/evaluation` folder of a [LongMemEval](https://github.com/xiaowu0162/LongMemEval) checkout at commit `9e0b455f4ef0e2ab8f2e582289761153549043fc`. LongMemEval's README downloads the dataset into the `data` folder at the top of that checkout, so the dataset is `../../data/longmemeval_s_cleaned.json`. `CURATE` is the path of your Curate checkout.

Print the metrics again from the committed verdicts. This makes no model call:

```sh
python3 print_qa_metrics.py "$CURATE/benchmarks/longmemeval/2026-11-11/official-scorer/curate-sol.jsonl.eval-results-gpt-4o" ../../data/longmemeval_s_cleaned.json
```

Grade the answers again. This calls GPT-4o through OpenAI's API, so it needs `OPENAI_API_KEY`. The grader writes its verdicts to a file beside the answers it reads, and it empties that file first. Copy the answers out of this folder before you grade, so the committed verdicts stay:

```sh
cp "$CURATE/benchmarks/longmemeval/2026-11-11/official-scorer/curate-sol.jsonl" .
python3 evaluate_qa.py gpt-4o curate-sol.jsonl ../../data/longmemeval_s_cleaned.json
python3 print_qa_metrics.py curate-sol.jsonl.eval-results-gpt-4o ../../data/longmemeval_s_cleaned.json
```

## Inputs

- **Dataset:** LongMemEval S (`longmemeval_s_cleaned.json`, from [LongMemEval's Hugging Face page](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)), SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`.
- **Licence:** the memory texts and questions in the LongMemEval folders are excerpts of the LongMemEval dataset, used under its MIT licence ([`LICENSE-LongMemEval.txt`](../LICENSE-LongMemEval.txt)).
- **Checksums:** `SHA256SUMS`.
