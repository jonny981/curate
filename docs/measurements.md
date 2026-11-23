# Measurements

The numbers behind the library's defaults and dials.
You don't need them to choose an option: the [library reference](library.md) says what each option does.
They're here so you can see why a default is what it is, and how far to trust it.

Most of these checks use the tuning half of LongMemEval: 249 questions with 445 labelled answer messages (the turns where the answer starts).
They measure whether evidence reaches the decision step, not whether the final answer was right, unless a section says otherwise.

## Defaults and evidence

The union comparisons below use a budget per search.

| Option | Default | Why |
| --- | --- | --- |
| **Reference selection** | Keep references scored 0.0146 or more | In the saved-decision sweep, 0.05/0.5 removed every fed fragment of 50 answer turns, 0.2/0.6 removed 70, and a single 0.6 cut removed 183. Keeping everything added no selection losses. Seven of 445 labelled turns were absent from the feed. This measures what survives before curation, not final answer accuracy. |
| **Extra search lines** | Run when supplied | With the chat package, five subject lines plus five alternate-name lines at 100 parts reach 440 of 445 turns and add 207.3 decisions a question. At 200, five subject lines reach 442 of 445 and add 214.2. At 600, the task alone reaches all 445; extra lines add no labelled evidence. |
| **Phrase searches** | Off unless supplied | One event phrase recovers one extra labelled turn at 100 parts, for 0.9 extra decisions a question on average. Keyword lines also recover that turn. On its sports-event order question, the phrase adds two parts, against 58 for one subject line. At 200 and 600 it adds no labelled turns. |
| **Local meaning search** | Off | On the 249 tuning questions, 200 keyword parts plus the 48 nearest task-meaning matches reach all 445 labelled turn starts and all their surviving parts, adding 19.5 decisions a question. Keyword search alone at 600 parts reaches the same evidence. The 48-part depth fits that tuning setup; it isn't a cutoff for other histories. Final-answer accuracy isn't measured. |
| **Instruction removal** | Off | It changed no tuning question and no rank. Its benefit on tasks with output instructions isn't measured. |
| **Rank protection** | Off | In a 60-question cached sample, recall in the first four items fell from 94.09% to 84.68%, and in the first eight from 100% to 99.71%. Full-feed packing isn't measured. |
| **Best part first** | Off | One part per session reached 259 of 445 answer turns. Even an optimistic continuation at 0.4 reached only 423 of 445. This doesn't show a safe way to skip parts. |

The line comparison wrote five subject lines, five alternate-name lines and five subject-free event phrases for each tuning question with a subscription model, then tested the first one, three and five of each.
Keywords used the chat package's default ranking, and core joined the feeds and applied the budget per search.
These settings kept every labelled turn, and every complete labelled turn found with all fifteen lines, checked question by question:

| Parts per search | Subject lines | Alternate-name lines | Event phrases |
| --- | --- | --- | --- |
| 100 | 5 | 5 | 0 |
| 200 | 5 | 0 | 0 |
| 600 | 0 | 0 | 0 |

You can keep event phrases for a cheaper way to find specific events.
The sports-event order example uses "watched" to recover its third labelled turn, and a route for count and list questions only would leave that question out.
The keyword settings above also find that turn, so leaving phrases out of them keeps its evidence.

The line gains come from keyword and phrase search, not vector search.
The rank sample uses saved "needed" answers rather than a complete decision feed.
The best-part check uses a 0.4 continuation gate; the package itself uses none.

## Lane cut

Measured on the tuning half's saved lanes (249 questions).
The cut each search lane makes where its scores level off missed 6 of the 445 answer messages: three shared no words with the question, and three ranked below the cut.
Its effect on scores and cost, and its loss with labels on, aren't measured.

## Keep bar

Measured with the saved-decision sweep and the LongMemEval runs.
0.0146 is the highest bar that lost no answer message on the tuning questions.
At that bar, the layout gets about 70 of a LongMemEval history's 850 parts.

It scored 225 of the 249 tuning questions at $0.13 a question (223 on the all-500 replay), and 458 of 500.
A saved 0.6 bar removed every fed fragment of 183 labelled answer turns, and a 0.05 bar lost 8 of 438 answer messages.

## Labels

Measured with a saved label run on the tuning half.
Keyword search alone reached 439 of the 445 answer messages.
With each part labelled, all 445 were reached at 38% of each history.
Its effect on scores and cost isn't measured.

## Scaled top-k

Measured on the tuning half's saved rankings (249 questions, 445 answer messages), with labels on and `wholeLanes` on, over every part of each history, from 127 to 8,475 parts:

| Keep rule | Answer messages kept, of 445 | Parts kept at 850 parts | Parts kept at 8,475 |
| --- | --- | ---: | ---: |
| `2.173 × N^0.8` | 444–445 (99.8–100%) | 479 | 3,017 |
| `0.68 × N^0.8` | 437–442 (98–99%) | 150 | 944 |
| `0.471 × N^0.8` | 432–440 (97–99%) | 104 | 654 |

The table replays those saved rankings, which break equal fusion scores by item id; the package's fused order breaks them by keyword position.
So it checks the study's coverage, not identical coverage for the package's own ranking.

At c = 0.68, the keyword-and-label ranking kept 437–442 of 445 answer messages (98–99%) at every size from 127 to 8,475 parts, and scored 229 of 249 at $0.18 a question.
`everyRanked: true` decides the whole ranking instead: all 850 of 850 parts at one measured size and all 8,475 at the largest, against 150 and 944 at c = 0.68.
Its score and cost with labels on aren't measured.

## The rating stop

The stop saves most on long histories and costs answers on short ones.
Two checks measured it, without calling the decision model.

1. **Evidence kept, on three runs' saved scores.** A replay read the saved decision scores of three finished benchmark runs down each question's fused order, in request-sized batches, and compared 80 stop rules with the parts the runs rated, at a fixed depth of 3,674. The runs were LoCoMo (1,540 questions over conversations of about 170 parts), DolphinBench (30 tests over Claude Code transcripts of about 5,800 parts) and BEAM 128K (40 questions). DolphinBench and BEAM saved their search lines, so their orders are the runs' own. LoCoMo's run saved none, so its order was rebuilt with the question standing in for every search line, and its LoCoMo figures rest on that stand-in order.
2. **Answers, on the two published benchmarks.** A score check rebuilt the published LoCoMo and LongMemEval texts with the stop on, from the runs' saved scores. It answered and marked the changed texts twice with the published runs' answering model, gpt-6.1-sol: all 403 on LongMemEval, and a seeded 400 of the 952 on LoCoMo. LoCoMo's order is the same stand-in. With the stop off, it rebuilt every published text byte for byte.

A share of 0.2 was the cheapest rule that kept at least 98% of the runs' evidence on every tuning half.
In that replay, the floor of 0.1 ended a read after its first two batches when nothing in the history scored warm, for 0.8 points of LoCoMo evidence; the stop waits for a part at or above the floor, so such a read goes on until one scores there.
These figures are evidence kept, not answers scored.

On the held-back halves of the replay, as a share of the parts the runs rated and of the evidence they found:

| Read | LoCoMo | DolphinBench | BEAM |
| --- | --- | --- | --- |
| The defaults, one batch at a time | 61%, 98.1% | 50%, 95.2% | 82%, 100% |
| The defaults, two batches at a time, as `pick` reads | 64%, 98.5% | 55%, 95.2% | 83%, 100% |
| `share` 0.1, no floor, one batch at a time | 70%, 99.3% | 87%, 100% | 89%, 100% |
| `share` 0.3, no floor, one batch at a time | 58%, 98.2% | 34%, 95.2% | 75%, 95.2% |
| `share` 0.5, no floor, one batch at a time | 53%, 97.1% | 17%, 95.2% | 64%, 85.7% |

The second row is the built `pick` on the same saved scores.
Its batches are sized by characters rather than by a fixed count, which moves where each batch starts; on DolphinBench that alone moved about 4 points.
The held-back halves hold 770, 15 and 20 questions, so on DolphinBench and BEAM one evidence message moves a figure by about 5 points.

On the published runs' answers, with the defaults:

| Published benchmark | Parts rated | Right answers | Saved a question |
| --- | ---: | --- | ---: |
| LoCoMo, 1,540 questions (published 1,486 right) | 64% of the whole order | About 5 to 12 fewer: estimated 1,474 to 1,481; the same 4 questions lost in both answer runs, each because a gold evidence turn left the text | $0.0012 |
| LongMemEval S, 500 questions (published 471; six published sets 466 to 471) | 31% of every part | 468 and 470: inside the noise | $0.0067 |

On LoCoMo, the stop took a gold evidence turn out of 30 questions' texts (1.9%).
The gentlest setting answered, no floor and a share of 0.05, rated 82% of the order and still lost about 3 to 4 answers (1,482 and 1,483), on questions whose evidence left the text.

On LongMemEval, a gold turn left 10 texts (2.0%), and 2 texts came out empty.
On each of those two, every part of the first two batches scored under the keep bar, the floor ended the read, and every part the full read keeps sat lower in the order; on one, the evidence part sat at place 505.

These answer figures were measured on a stop that could fire before its read kept a part, and before any part scored at or above the floor.
The stop waits for both, which only ever reads further.
Waiting for a kept part changes only a read that ended with nothing kept: those two, which read on to the parts the full read keeps.
No LoCoMo read ended with nothing kept.

Waiting for a part at the floor changes a little more.
On LongMemEval's saved scores, 11 of 470 first waves had a best score under the floor, and 1 of those held its answer further down: waiting reaches it for 4% more parts rated.
On questions whose answer isn't in the history at all, waiting rates 14% more parts, and never the whole order.

On DolphinBench's 5,800-part transcripts, the stop rated about half the parts, saving about $0.026 a test.
Its effect on answers there isn't measured.

The stop's weak point is a lone warm part below a long cold stretch: LoCoMo's worst evidence losses were turns at places 81 to 175 that scored 0.65 to 0.74 once read.
Where the scores separate evidence poorly, as on BEAM's broad questions, the stop reads most of the order and saves little.

The stop sends two batches at a time to save round trips without reading far past the stop.
On the replay's saved scores, two at a time rated 3, 1 and 1 points more of LoCoMo's, DolphinBench's and BEAM's parts than one at a time, for an estimated 45%, 16% and 48% less decision time, from the service's measured round trip and token allowance.
Three at a time rated 14, 3 and 2 points more for little more speed.

## Rare-word round

Measured on the tuning half's saved decisions (249 questions).
Holding the keep bar at 0.05 loses 15 answer messages.
The round at its defaults recovers 6 of them while adding 12.9 parts a question, which matches the fixed-count study's 6 of 15 at about 15.
Its effect on scores isn't measured.

## Evidence limits

**`maxCandidates`.** A saved tuning comparison at 100 parts a lane lost 43 of 445 labelled answer-turn starts; 600 kept all 445. That doesn't prove a safe cut for other data.

**`ruleBar`.** Its quality loss on labelled rule tasks isn't measured. The default of 0 cuts nothing.

**`route`.** Not measured.
