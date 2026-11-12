# LoCoMo, all 1,540 scored questions, two settings

Curate built a memory text for each of LoCoMo's 1,540 scored questions (categories 1 to 4) in two settings, from one set of decisions:

| System | Answering model | Marker | Score | Tokens read (mean) |
| --- | --- | --- | --- | --- |
| Curate (full) | gpt-6.1-sol | gpt-6.1-sol | 1,486/1,540 = 96.5% | 3,838.7 |
| Curate (full), the same answers | gpt-6.1-sol | `gpt-4o-mini-2024-07-18` | 1,457/1,540 = 94.6% | 3,838.7 |
| Curate (compact) | `gpt-4.1-mini-2025-04-14` | `gpt-4o-mini-2024-07-18` | 1,408/1,540 = 91.4% | 1,247.6 |

Curate (full) has an answer budget of 6,000 tokens and keeps every sentence (`answerTokens: 6000`, `sentenceCutoff: false`); its files end in `6000`. Curate (compact) is the default, an answer budget of 2,000 tokens and a sentence cutoff of 0.1 (`answerTokens: 2000`, `sentenceCutoff: 0.1`); its files end in `2000`.
Curate (full) is answered with Curate's answering prompt and marked with Mem0's published platform judge prompt and OmniMemEval's judge prompt; Curate (compact) is answered and marked with OmniMemEval's prompts.

Two more answer files hold other answers from Curate (full)'s memory texts. `answers-6000-repeat.jsonl.gz` holds a second run of Curate's answering prompt: 1,486/1,540 = 96.5%, marked by gpt-6.1-sol. `answers-6000-mem0-prompt.jsonl.gz` holds the answers from Mem0's answering prompt, unchanged: 1,481/1,540 = 96.2% marked by gpt-6.1-sol, and 1,459/1,540 = 94.7% marked by gpt-4o-mini.

LoCoMo is published under CC BY-NC 4.0, and this folder does not redistribute its text: the records point at the dataset's turns, and `rebuild.py` rebuilds every memory text from a copy of the dataset that you download yourself.

`scores.json` holds these results by category, with the sizes of the memory texts and the scores outside the questions used to choose the settings.
`misses-6000.md` lists every question that gpt-6.1-sol marked wrong in Curate (full).
The folder is 1.7 MB.

## By category

| Category | Questions | Curate (full), marked by gpt-6.1-sol | Curate (full), marked by gpt-4o-mini | Curate (compact), marked by gpt-4o-mini |
| --- | ---: | ---: | ---: | ---: |
| 1 multi-hop | 282 | 271 | 266 | 252 |
| 2 temporal | 321 | 310 | 296 | 283 |
| 3 open-domain | 96 | 83 | 77 | 70 |
| 4 single-hop | 841 | 822 | 818 | 803 |
| All | 1,540 | 1,486 | 1,457 | 1,408 |

Category 5, the 446 questions the conversation cannot answer, is left out, as in the published results it is compared with.

## Two settings of the same dials

One Curate call per question chose the parts of the conversation, and the decision model's answers were saved.
Both settings lay out those same kept parts, with the same scores and in the same order.
Only two layout settings differ:

| Setting | `answerTokens` | `sentenceCutoff` |
| --- | ---: | --- |
| Curate (full) | 6,000 | `false`: every sentence of a laid-out part stays |
| Curate (compact) | 2,000 (the default) | 0.1 (the default) |

Curate (full)'s texts were laid out again from the saved decisions, with no model call.

Curate (full) was chosen by comparing settings on 159 of the 1,540 questions, listed in `scores.json` under `settings_chosen_on`.
On the other 1,381 questions the scores are:

| Setting and marker | Right of 1,381 |
| --- | ---: |
| Curate (full), marked by gpt-6.1-sol | 1,329 = 96.2% |
| Curate (full), marked by gpt-4o-mini | 1,306 = 94.6% |
| Curate (compact), marked by gpt-4o-mini | 1,260 = 91.2% |

Curate's answering prompt was developed on all 1,540 questions; see [Curate's answering prompt](#curates-answering-prompt).

## Context sizes

The memory text is everything the answering model read about the conversation.
Each question's conversation averages 21,154.5 o200k tokens (every turn's speaker and words, with its photo text).

| Setting | Mean tokens | Median | 90th percentile | Longest | Times less than the conversation |
| --- | ---: | ---: | ---: | ---: | ---: |
| Curate (full) | 3,838.7 | 4,921 | 5,128 | 5,341 | 5.5 |
| Curate (compact) | 1,247.6 | 1,349 | 1,562 | 1,735 | 17.0 |

OmniMemEval counts the tokens sent to the answering model, prompt included.
By that count Curate (compact) sends 1,756.5 tokens a question on average (`answer_prompt_tokens`, as OpenAI reported them).

## How the memory text is built

1. **History:** each conversation is one folder of Markdown files, one file per session: the session's date, then each turn as `speaker: words`. A turn that shares a photo also carries the photo's search query and caption in brackets, as Mem0's platform reads them.
2. **Search:** Curate's `/curate` skill at commit `55cc728` reads the conversation's folder as one Markdown source. Claude Haiku writes the search lines. Keyword search and meaning search (EmbeddingGemma 300M, 8-bit GGUF, run locally) rank the conversation's parts. Settings: `thoroughness: 'normal'`, `answerTokens: 2000`, `sentenceCutoff: 0.1`, and the question's scope off.
3. **Decide:** Jev, the decision model, answers the Markdown package's `MARKDOWN_CASCADE` questions about each part. A conversation has 99 to 202 parts, so Jev scored nearly every part: 260,125 of the 262,889 parts across the 1,540 questions. Parts with a score of 0.0146 or more are kept, 62.7 a question on average.
4. **Lay out:** Curate's `curate()` lays out the kept parts in their own words, strongest first, within the setting's budget. The two strongest parts come first, under `### Most likely answer`. In Curate (compact) Jev rates each sentence, and the text keeps those rated 0.1 or more. `…` marks where text was left out.

No model writes, shortens or rewrites the memory text.

- **The task:** LoCoMo questions carry no date of asking, so Curate's task is the question followed by `(conversation ended <date of the last session>; question date not supplied)`.
- **Headings:** the skill names each part's source by its folder. In the text the answering models read, that name is replaced with `conversation`. Nothing else changes.

## Answering and marking

### Curate (full)

- **Answering:** gpt-6.1-sol, at medium reasoning effort, on a ChatGPT plan through the Codex CLI, with Curate's answering prompt (`prompts/curate-answer.txt`). The memory text fills its memories, and the date of the conversation's last session fills its reference date, as Mem0's runner sets it. The answer is the text after the reply's last `ANSWER:`, as Mem0's runner takes it.
- **Run twice:** Curate's answering prompt was run twice on the same memory texts, and both runs score 1,486 marked by gpt-6.1-sol. The two runs agree on 1,482 answers marked right and 50 marked wrong, and differ on 8.
- **Mem0's answering prompt:** with Mem0's answering prompt unchanged on the same memory texts the score is 96.2% (1,481).
- **Marked by gpt-6.1-sol:** at medium reasoning effort, through the Codex CLI, with Mem0's platform judge prompts (`JUDGE_SYSTEM_PROMPT`, `JUDGE_PROMPT`). For category 3 the answer key is cut at its first semicolon, as Mem0's `preprocess_answer` does. A reply labelled `CORRECT` is right.
- **Marked by gpt-4o-mini:** the same answers, marked by `gpt-4o-mini-2024-07-18` through OpenAI's API with OmniMemEval's judge prompts and the whole answer key, at temperature 0. The label is read with OmniMemEval's own pattern.
- **What each judge prompt accepts:** Mem0's judge prompt marks a list answer right when it holds at least one item of the answer key, and accepts dates within 14 days of the key and durations within half of it. OmniMemEval's judge prompt asks for generous marking when the answer touches the same topic as the key, and accepts a date given in other words; it has no rule for list items or for a window of days.
- **Where the markers differ:** gpt-6.1-sol marks 34 answers right that gpt-4o-mini marks wrong, and 5 answers wrong that gpt-4o-mini marks right.
- **Same input checked:** every answer request is Curate's answering prompt filled with the memory text that `rebuild.py` rebuilds, and every mark request is Mem0's judge prompt filled with the answer in this folder, on all 1,540 questions and in both runs.

### Curate (compact)

- **Answering:** `gpt-4.1-mini-2025-04-14` through OpenAI's API, with OmniMemEval's `LOCOMO_ANSWER_PROMPT`, at temperature 0 with no output limit. The memory text fills both speakers' places in OmniMemEval's `DUAL_SPEAKER_TEMPLATE`, as OmniMemEval does for a memory that both speakers share, and OmniMemEval's merge step turns the two into one shared block.
- **Marked by gpt-4o-mini:** `gpt-4o-mini-2024-07-18` with OmniMemEval's judge prompts and the whole answer key, at temperature 0.
- **Same input checked:** for every question, OpenAI's reported prompt tokens equal the o200k count of OmniMemEval's prompt filled with the rebuilt memory text, plus 7.
- **Harness:** Curate's own runner sent OmniMemEval's prompts with OmniMemEval's models and request settings. The run did not use OmniMemEval's harness.
- **Photo text:** photo handling varies by adapter in OmniMemEval. Curate's history includes each shared photo's search query and caption.

### Prompts

`prompts/` holds the prompts as published, each file with its source block:

- **`prompts/mem0-platform.json`:** `ANSWER_GENERATION_PROMPT`, `JUDGE_SYSTEM_PROMPT` and `JUDGE_PROMPT` from [`benchmarks/locomo/prompts.py`](https://github.com/mem0ai/memory-benchmarks/blob/4b61c5d31b9c668a12b4f5e78064248a02c82d2b/benchmarks/locomo/prompts.py) in Mem0's memory-benchmarks repository at commit `4b61c5d`, SHA-256 `8ebac1ef60e9ab5caf99079fdaac038b85472e81491ed35e2d2655f3927c76c2`. Apache 2.0.
- **`prompts/omnimemeval-locomo.json`:** `LOCOMO_ANSWER_PROMPT`, `DUAL_SPEAKER_TEMPLATE`, `JUDGE_SYSTEM_PROMPT` and `JUDGE_PROMPT` from [`scripts/utils/prompts.py`](https://github.com/MemTensor/OmniMemEval/blob/7c79d46e31dd85f3da2509b430bba9406656dd28/scripts/utils/prompts.py) in OmniMemEval at commit `7c79d46`, SHA-256 `0e0eadc6a476a89f8d5f8b60e37a0139585b998e228152e66a95109bedb71bbe`. Apache 2.0.

Each prompt in these files is the same text as in its source file at that commit.

- **`prompts/curate-answer.txt`:** Curate's answering prompt, SHA-256 `7503a72571c8897dd735e6f078a5e81ba5849b52ccb8e4c47ba6d3ba451655b4`.

### Curate's answering prompt

Curate's answering prompt was developed on these LoCoMo questions: misses across all 1,540 were read while it was written, so no subset of the questions is untouched by its development.
`python3 rebuild.py locomo10.json --check-prompt prompts/curate-answer.txt` compares the prompt with the 1,540 scored questions and their answer keys. It finds no phrase of three or more words, no whole answer key of two or more words, no speaker name and no number shared between them. Leaving out common words and plain words about reading and answering, it lists 20 single words, such as "period", "habits" and "oldest", that the prompt shares with five or fewer questions or answer keys and that the conversations use 20 times or fewer:

```text
0 shared phrases of three to eight words, 0 whole answer keys of two or more words, 0 speaker names, 0 shared numbers, 0 shared capitalised words, 20 rare shared words
```

## Fields

Each setting has a text file (`texts-6000.jsonl.gz`, `texts-2000.jsonl.gz`) and an answer file (`answers-6000.jsonl.gz`, `answers-2000.jsonl.gz`). Curate (full) also has `answers-6000-repeat.jsonl.gz` and `answers-6000-mem0-prompt.jsonl.gz`. All are gzipped JSON lines, one line a question, in dataset order, joined on `id`. Read one record with `gzip -dc texts-6000.jsonl.gz | head -n 1`.
They hold no conversation text, question text or answer-key text.

Both text files hold:

| Field | Meaning |
| --- | --- |
| `id` | `sample_id:qa_index` |
| `sample_id`, `qa_index` | the conversation's `sample_id` and the question's position in that conversation's `qa` list, as the dataset has them |
| `category` | LoCoMo's category number |
| `parts` | the parts of the conversation the memory text shows, in its order: each part's session (`session_1` and so on), its turns (`D1:3` and so on, as the dataset names them) and its decision score |
| `text` | how to rebuild the memory text: the layout's own strings (headings, session dates, line breaks and `…`) and, for the conversation's words, `[turn, start, end]`, a character range of that turn's line. In Curate (compact) these ranges show which sentences of each turn the text keeps |
| `text_sha256` | the SHA-256 of the exact memory text the answering model read |
| `context_tokens_o200k` | that text's length in o200k tokens |

A turn's line is the speaker's name, a colon and a space, then the turn's words. A turn that shares a photo adds the photo's search query and caption, in the bracketed form `rebuild.py` shows.

`answers-6000.jsonl.gz` and `answers-6000-mem0-prompt.jsonl.gz` hold the fields below; `answers-6000-repeat.jsonl.gz` holds all but the gpt-4o-mini verdict:

| Field | Meaning |
| --- | --- |
| `id` | the question, as in the text file |
| `answer_model`, `answer_prompt`, `answer` | the answering model, the prompt it answered with (a file in `prompts/` and the prompt's name), and the scored text after its reply's last `ANSWER:` |
| `sol_marker_model`, `sol_correct` | the gpt-6.1-sol judge and its verdict |
| `second_marker_model`, `second_correct` | the gpt-4o-mini judge and its verdict |

`answers-2000.jsonl.gz` holds:

| Field | Meaning |
| --- | --- |
| `id` | the question, as in the text file |
| `answer_model`, `answer_prompt`, `answer` | the answering model, the prompt it answered with, and its reply |
| `answer_prompt_tokens` | the answer request's prompt tokens, as OpenAI reported them |
| `marker_model`, `correct` | the gpt-4o-mini judge and its verdict |

## Rebuild the texts and recount the scores

Download LoCoMo's `locomo10.json` (see Inputs), then run, with Python 3 and nothing else installed:

```sh
python3 rebuild.py locomo10.json
```

It checks the dataset file's SHA-256, rebuilds all 3,080 memory texts and checks each against its `text_sha256`, then reads each question's category from the dataset and recounts every score, overall, by category and on the 1,381 questions outside the 159 used to choose the settings:

```text
Curate (full): 1540 of 1540 memory texts rebuild to their SHA-256
Curate (compact): 1540 of 1540 memory texts rebuild to their SHA-256
Curate (full), Curate's answering prompt, gpt-6.1-sol marks: 1486/1540 = 96.5% (multi-hop 271/282, temporal 310/321, open-domain 83/96, single-hop 822/841); outside the 159: 1329/1381 = 96.2%
Curate (full), Curate's answering prompt, gpt-4o-mini marks: 1457/1540 = 94.6% (multi-hop 266/282, temporal 296/321, open-domain 77/96, single-hop 818/841); outside the 159: 1306/1381 = 94.6%
Curate (full), Curate's answering prompt, run again, gpt-6.1-sol marks: 1486/1540 = 96.5% (multi-hop 270/282, temporal 311/321, open-domain 82/96, single-hop 823/841); outside the 159: 1329/1381 = 96.2%
Curate (full), Mem0's answering prompt, gpt-6.1-sol marks: 1481/1540 = 96.2% (multi-hop 271/282, temporal 309/321, open-domain 83/96, single-hop 818/841); outside the 159: 1323/1381 = 95.8%
Curate (full), Mem0's answering prompt, gpt-4o-mini marks: 1459/1540 = 94.7% (multi-hop 264/282, temporal 300/321, open-domain 79/96, single-hop 816/841); outside the 159: 1306/1381 = 94.6%
Curate (compact), gpt-4o-mini marks: 1408/1540 = 91.4% (multi-hop 252/282, temporal 283/321, open-domain 70/96, single-hop 803/841); outside the 159: 1260/1381 = 91.2%
The two markers of Curate (full)'s answers differ on 39: gpt-6.1-sol right and gpt-4o-mini wrong on 34, the reverse on 5.
The two runs of Curate's answering prompt agree on 1482 right and 50 wrong, and differ on 8.
```

- **`--misses`** also prints each miss of Curate (full) with its question, LoCoMo's answer key, the answer given and the evidence turns in the conversation's own words, with their dates.
- **`--text conv-26:0`** prints both settings' memory texts for one question.
- **`--write`** also rewrites the counts in `scores.json` and the list in `misses-6000.md` from the record files.
- **`--check-prompt FILE`** lists what an answering prompt shares with the scored questions and answer keys.

The memory texts' o200k tokens (mean, median, 90th percentile, longest) and Curate (compact)'s mean prompt tokens are in `scores.json`. The conversations' mean o200k tokens over the 1,540 questions needs `tiktoken` and the dataset:

```sh
python3 -c "import json,sys,statistics,tiktoken; e=tiktoken.get_encoding('o200k_base'); P=lambda t: '[Sharing image - query: %s. The image shows: %s]' % (t['query'], t['blip_caption']) if t.get('query') and t.get('blip_caption') else '[Sharing image - query for: %s]' % t['query'] if t.get('query') else '[Sharing image that shows: %s]' % t['blip_caption'] if t.get('blip_caption') else ''; W=lambda t: ' '.join(x for x in (str(t.get('text') or ''), P(t)) if x); S=lambda c: sorted((k for k in c if k.startswith('session_') and k[8:].isdigit()), key=lambda k: int(k[8:])); d=json.load(open(sys.argv[1])); h={c['sample_id']: len(e.encode('\n'.join(t['speaker'] + ': ' + W(t) for k in S(c['conversation']) for t in c['conversation'][k] if W(t)), disallowed_special=())) for c in d}; print(round(statistics.mean(h[c['sample_id']] for c in d for q in c['qa'] if q['category'] in (1, 2, 3, 4)), 1))" locomo10.json
```

## Inputs

- **Dataset:** LoCoMo, by Maharana and others ([Evaluating Very Long-Term Conversational Memory of LLM Agents](https://arxiv.org/abs/2402.17753), ACL 2024), published under [CC BY-NC 4.0](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/LICENSE.txt). Download `locomo10.json` from [snap-research/locomo](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/data/locomo10.json); its SHA-256 is `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`.
- **Checksums:** `SHA256SUMS`.
