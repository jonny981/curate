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

### Windows of parts, or each request alone

A request holds as many parts as fit the decision service's request limit, so its size follows how long the parts are: up to 150 short parts on the benchmarks where the floor and share were measured, and about ten of a coding agent's long parts.
Judged per request, one cold request of ten parts near the top of a mixed order ended the read: on one project's coding-agent history it stopped after 20 of 38,758 ranked parts.
That's why the stop judges windows of rated parts by default: runs of whole requests that hold at least 150 rated parts.

A window cut at exactly 150 parts, across request boundaries, could stop before the per-request rule would: with 720 parts in requests of 120 and warm parts at 0, 120, 359, 360, 480 and 600, the per-request rule rated all 720 and kept 6, and a cut 150-part window rated 480 and kept 4. A window of whole requests is cold only when every request in it would be, so it keeps every part the per-request rule keeps.

On the saved ratings of 23 coding-agent tasks (103 known answer parts the ratings keep), with the order restricted to rated parts:

| Window | Answers found, of 103 | Parts rated |
| --- | --- | --- |
| Each request alone, about ten parts | 36 | 3,280 |
| 100 parts | 97 | 41,370 |
| 150 parts | 100 | 48,399 |
| 200 parts | 103 | 52,765 |

Notes are the other way round. On 149 LongMemEval questions read in the `notes` mode, judged per request the read rated 110 parts a question and answered 145.33 right, over three answer sets. Windows of 150 rated 290 parts a question, at three times the decision cost, for no more right answers.
Every one of those 149 texts, made again through the `curate` command from the saved requests and replies, is byte for byte the measured run's, with each request byte for byte one the run had sent.

## The chat read

Every number in [the chat read](library.md#the-chat-read) is the measured one.
On about 116,000 parts of one person's history (Claude Code and Codex transcripts, notes and commits; eight tasks with 56 known answer parts), rated live with `AGENT_CHAT_CASCADE`, the read found 51 answers and kept 54 in 5,900 rated parts, 1.84% of the history.
A read of the ranked list in requests of 112, stopping on each request's best rating, replayed on saved ratings, rated 15,792 parts for 42.

The 0.3 stop was fitted on three of the eight tasks. On the other five it read 3,744 parts, where a stop on no new warm part read 6,155, with the same answers.
Each round waits for the one before it, so the rounds in a row are the crawl's requests and rings, one round of starts, and the longest single walk: the replay of those eight tasks made 14 to 37 rating rounds a task, where walking one segment at a time made 55 to 301, with the same parts rated.

The units of agent work were measured only on saved ratings, on 22 tasks of that history.
Without them the read found 39 of the person's 41 answers and 10 of the 16 answers agents wrote; with them, 39 and 15, for 4,386 more parts read, 3,620 of them with no saved rating, so they were counted cold.
Every agent-written answer's unit ranks in the top 13 of its kind by keyword or by meaning, where its best place in the fused order was 547 to 2,768.
Opening only the units above both cuts found 12 of the 16 for about a fifth of the added parts; opening above either cut reached 15 of 16, against 10 without the units.

On one person's coding-agent history, one task's call spent 3.1 seconds in the pick outside its reads and decisions. With the topic cuts and unit words read back from a `HistoryStore`, it spent 1.8 seconds, and the text was the same byte for byte.

## The facts the answer needs

Measured on eight tasks of one person's coding-agent history with the JSON state, with lists a separate model call wrote: parts that hold no answer but rate 0.1 or more fell from 10.8% to 3.8%, and the share of the history let through to keep 98% of the answers from 14.3% to 3.8%.
It isn't confirmed on tasks held out from that measurement.

With the agent's message beside them, a person's own questions and requests rated lower while the facts read `<name>'s statements about ...`.
Worded `What <name> said, asked or requested about ...`, 11 such messages that had fallen rose from a median of 0.21 to 0.39 of the read's best rating, while 15 of the person's messages that hold no answer stayed at 0.02.
A field saying which messages count as an answer, sent beside facts worded that way, moved no rating: on 39 labelled answer messages, each asked with and without it the same minute, the difference was a median of 0.000, with 4 apart by more than 0.05 against 7 for the same request sent twice. So no request carries one.

## The person's own words

A weight on the person's parts, fitted on tasks whose answers were the person's own, didn't hold on tasks held out from the fit: the ranking fell from 0.960 to 0.829, and for answers an agent wrote from 0.975 to 0.650.
So no question set weighs a part by who wrote it.

## Whole messages, hard facts and items per request

On 22 tasks of one person's coding-agent history (1,489 ranked pieces in 1,028 messages):

| Form | Request text, against pieces batched |
| --- | --- |
| Whole messages, batched | 2.47 times: the messages held 4.47 times the ranked pieces' text, and 32 reports carried their request |
| Whole messages with hard facts, batched | 2.84 times |
| Pieces, one a request | 1.38 times, in 1,489 requests in place of 27 |
| Whole messages, one a request | 2.72 times |
| Whole messages with hard facts, one a request | 3.11 times |

The decision model bills by the text, so the dollars follow these ratios.
At 80 requests and 100,000 tokens a second, a read of 1,000 items needs at least: pieces, 3.8 seconds batched and 12.5 one a request (bound by the requests); whole messages, 13.8 and 15.2 seconds; whole messages with hard facts, 15.8 and 17.3 seconds (bound by the tokens either way).
The service's own time comes on top: 182 whole messages with hard facts, one a request and four at a time, came back in 7.3 seconds with none refused, about 0.15 seconds a request.

With all three together, the form put 19 labelled answers in each needed fact's top five on held tasks, against 12 for pieces batched about 25 a request, and 14 without the `replies_to` and `answered_by` text.
Batched about 25 a request, the same fields didn't help.

Laid out one message at a time, strongest first, the text scored best on the 22 tasks when laid out by a test script: 16.4 of 22 answered right over five answer sets, against 13.8 for the uncut text.

On LongMemEval's histories read as notes, at 333 rated parts a question, where the notes mode's four questions batched cost 8 requests, USD 0.0077 and 1.4 seconds a question, one part a request sends 333 requests, 1.09 times the text (USD 0.0084), and needs at least 4.2 seconds at the client's default pace.
Those costs are worked from the requests a complete rating of 149 questions sent, at its measured 0.2842 billed tokens a character and USD 0.042 a million.
A note's `kind` alone adds about 20 characters a part, so a notes mode gains nothing from hard facts.

Turns of notes written as a conversation, judged whole, one a request, with hard facts and the "answers" set, scored LongMemEval's 149 questions under the notes mode's own pieces: 139.33 right at its bar, against 145.33.

## The narrow question in two

On the short lists of two tasks of one person's coding-agent history, the "answers" probabilities summed to 16.4 and 20.1 against 15 and 12 parts that state or restate the answer, where the single narrow question summed to 23.3 and 47.5.
That's a calibrated probability, which a keep bar can rest on.

Each bar below is a candidate until answers marked right confirm it:

- **Notes, rated one part a request:** 0.07 is the highest "answers" probability that keeps every labelled answer turn of 24 LongMemEval questions. It keeps a median of 2 parts and about 300 tokens a question.
- **Coding-agent transcripts, each whole message judged alone with its hard facts,** in the wording "Does this message state the answer to the task?" and "Does this message state this: {fact}?", scored by the highest answer: the highest bar that lost no labelled answer was 0.59 on the 12 one-decision tasks (a median of 27.5 messages and 5,738 tokens a task) and 0.04 on the 9 everything-said tasks (186 messages, 43,399 tokens), against 0.24 and 0.01 for the "answers" probability alone. Each task given the bar the others of its kind set loses one task in each kind.

A message's rating also moves from one call of a task to the next, mostly with the needed facts the search-line call writes.
Of 537 messages rated 0.5 or more in one run, rated again in another with other search lines or other facts, a quarter fell by more than 1.09 in logit (0.23 in rating) and a tenth by more than 2.07 (0.44), against 0.04 and 0.17 with the same lines.

The search-line call writes the needed facts at no cost to the decision model.
On LongMemEval's notes, at 333 rated parts a question, `ANSWER_CASCADE` with two needed facts in place of the four questions sends 7 requests and 0.90 times the text (USD 0.0070), in about the same time; one part a request, 333 requests and 1.06 times the text (USD 0.0082), at least 4.2 seconds.

## What each kept part is doing

Added after selection, on the kept parts only, batched: on LongMemEval's notes, at the median 19 kept parts a question, about one request, USD 0.0005 and 0.4 seconds more a question.

## A Choice per needed fact

On one task of one person's coding-agent history, 12 of its 20 options held an answer, and the top one took a probability of 0.20.
In that measurement it held its order across option orders (40 to 44 of 57 facts agreed), but didn't move answers marked right.

Its rounds run one after another: each asks one Choice per fact and, with `enough` on, the sufficiency question, about 0.33 seconds a round as measured (two option orders of 20 rounds each, 118 requests in 13.0 seconds).
On LongMemEval's notes with two needed facts, one round costs 3 requests, about USD 0.0002 and 0.3 seconds a question; five rounds, 14 requests, USD 0.0010 and 1.6 seconds; a loop that picks every candidate (at most 20 rounds, about 15 where a question keeps fewer parts), 44 requests, USD 0.0035 and 4.8 seconds.
The 20 candidates and the 0.7 sufficiency bar are the recipe's starting values, not measured bests.

## A second stage

On 20 tasks of one person's coding-agent history, five answer sets, each kind of message kept at the bar its labelled answers earned within its kind:

| Kind of message | One decision | Everything said |
| --- | --- | --- |
| The person's message | 0.76 | 0.04 |
| Subagent's final report | 0.59 | 0.95 |
| Subagent's prompt | | 0.05 |
| Compaction summary | | 0.37 |
| Tool output, at the bar its widened answers earned | 0.81 | 0.13 |

| Text | Right answers, of 20 |
| --- | --- |
| No second stage | 13.8 |
| The exchange form at those bars | 17.6 |
| The exchange form, each task's bars learned on the other tasks | 17.0 (+3.2, range −0.2 to +7.0) |
| The exchange form, cut to the paragraph nearest the person's message | 18.4 |

At those bars, 10.6 of 11 one-decision tasks were answered right, at 4,565 tokens against 59,125.
17.0 is the figure a new history can expect.

The paragraph cut kept the score and took one-decision texts from 4,171 to 2,087 tokens, and everything-said texts from 77,749 to 65,860, where tool output and compaction summaries, which it doesn't touch, are 43% of the text.

The person's answer message of one task, rated 0.76 where the bars were learned, rated 0.57 and 0.62 in two later calls with other needed facts.
The `curate` command's `exchange` set therefore keeps the person's message on one-decision tasks from 0.28, the learned 0.76 moved down by the tenth's fall of 2.07 in logit, and attaches the exchange only from 0.76.
It answered 18.2 right against 18.4 at the learned bars, the 0.2 being one task's answer noise (its answer was in every text), with one-decision text a median of 5,213 tokens against 2,087, 99% of the added text the person's own words.
Moving every one-decision bar down by that fall, the exchange's included, also answered 18.4, at 14,125 tokens.

A kind at a bar of 1 is never asked about. On three timed calls on one person's coding-agent history, those messages were 53% of the stage's request characters on a one-decision task, and 26% to 27% on two everything-said tasks.
Two cheaper forms of the stage were tried and aren't used:

- **At most three needed-fact questions,** the first three the search-line call wrote: it saved 12.5% of the stage's characters on seven everything-said tasks, and 4 of 30 labelled answer messages fell sharply (0.84 to 0.15 the furthest), each one whose best fact was the fourth. A dropped fact drops the answers only it matches.
- **Each quoted neighbour cut to 300 characters** (`replies_to`, `answered_by`, `asked`): it saved 2% to 4%, the quoted messages being mostly short already, and the lowest labelled answer fell from 0.06 to 0.03.

Cost, on 22 tasks: judging the read's kept list (13,982 whole messages, 636 a task) one message a request cost USD 0.808, 3.7 cents a task on average (median 3.1), in a median of 4.0 seconds a task at 16 requests at a time.
On the 11 held tasks, batching about 17 messages a request cost USD 0.280 against 0.379 alone (26% less), in a median of 0.7 seconds a task, and ranked the answers as well; hence batching is the default.
The read itself rated a median of 961 parts a task (mean 1,160), about 3.0 cents (mean 3.6) at a live run's USD 0.000031 a part, 112 parts a request.
So the whole call's decisions come to about 5.3 cents a task at the median (6.3 at the mean), and the second stage adds about a second to the call.

## The request's form

On the same 149 LongMemEval questions, search lines and layout, the JSON state rated the same notes lower than plain text did (46,092 of 49,024 parts).
At the notes bar, it answered 142.33 right against 145.33, over three answer sets. Lowering its bar to 0.005 reached 144.33, with 35% more text.
One part a request, rated alone, lowered every score the same way and needed 0.005 for the same parts, and the narrow question in two set its own bar.
So a form, a question set or a batching that changes what the model reads carries its own measured bar.

All 1,384 decision requests of a 149-question LongMemEval run in plain text, turned back into their batches and sent through `jev()` in the plain-text form, came out identical.

The JSON state, asked of the same parts with each history's own question set:

- **Coding-agent transcripts,** eight tasks with 56 known answer messages, the general relevance question: the share of the history let through to keep 98% of the answers fell from 40% to 13%. Random non-answers rated 0.1 or more fell from 85% to 46%, and ranking against the top of each task's list rose from 0.870 to 0.922.
- **LongMemEval,** 20 questions, the chat set: ranking from 0.951 to 0.990, parts kept at the 0.0146 bar from 62% to 29%, all 40 evidence units kept in both.
- **LoCoMo,** 24 questions, the Markdown set: ranking from 0.984 to 0.990, parts kept from 42% to 34%, and no evidence part under the bar that the plain text kept. Non-evidence rated 0.1 or more rose from 7% to 9%.
- **BEAM,** 40 questions: ranking level, 0.909 to 0.908.

The JSON state costs more input tokens: the service reported 14% more on LongMemEval and 16% more on LoCoMo, with the same output tokens.

## A keep bar set by measurement

On 22 tasks of one person's coding-agent history, three labelled answers had no score, so any bar above 0 loses them.
At a risk of 0.05 or 0.1 the bar is 0, which keeps every rated part; at 0.2 it's 0.050, which keeps a median 31% of the parts, with 3 tasks losing an answer.

## Text share

On LoCoMo, a share of 0.1 on `directMessages` cut the median text from 5,858 to 1,504 tokens, with 384 against 387 of 400 questions answered right.
On 150 LongMemEval questions read as notes, with no budget, a share of 0.1 kept 268 of the 271 labelled answer turns the whole selection held, and 0.2 kept 257.
A change that leaves out a kept part needs answers that show no loss, so no mode sets one.

## Sentence cutoff

Measured at 0.1 on 150 LongMemEval questions, the sentence step removed 9.2% of the sentences and 7.2% of the tokens, and cut 12 labelled answer turns that were whole in the text to partial or absent.

## Evidence limits

**`maxCandidates`.** A saved tuning comparison at 100 parts a lane lost 43 of 445 labelled answer-turn starts; 600 kept all 445. That doesn't prove a safe cut for other data.

**`ruleBar`.** Its quality loss on labelled rule tasks isn't measured. The default of 0 cuts nothing.

**`route`.** Not measured.
