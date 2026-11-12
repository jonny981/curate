"""Rebuild every memory text in this folder from LoCoMo's own file, check each against its SHA-256, and recount the scores.

Usage:
  python3 rebuild.py locomo10.json                     rebuild and check all 3,080 texts, then recount
  python3 rebuild.py locomo10.json --misses            also print each miss of Curate (full) with the dataset's words
  python3 rebuild.py locomo10.json --text ID           print both settings' memory texts for one question, such as conv-26:0
  python3 rebuild.py locomo10.json --write             also rewrite the counts in scores.json and misses-6000.md from the records
  python3 rebuild.py locomo10.json --check-prompt FILE  list what an answering prompt shares with the scored questions and answer key

locomo10.json is LoCoMo's data file. This folder does not hold the dataset's text.
Curate (full) is the files ending 6000 (answerTokens 6000, sentenceCutoff false); Curate (compact) is the files ending 2000 (the defaults).
"""
import gzip, hashlib, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATASET_SHA256 = '79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4'
CATEGORIES = {1: 'multi-hop', 2: 'temporal', 3: 'open-domain', 4: 'single-hop'}

raw = open(sys.argv[1], 'rb').read()
if hashlib.sha256(raw).hexdigest() != DATASET_SHA256: sys.exit('This is not the LoCoMo file the run read (SHA-256 differs).')
data = {c['sample_id']: c for c in json.loads(raw)}

def photo(t):
    q, c = t.get('query'), t.get('blip_caption')
    if q and c: return f'[Sharing image - query: {q}. The image shows: {c}]'
    if q: return f'[Sharing image - query for: {q}]'
    return f'[Sharing image that shows: {c}]' if c else ''

# Each turn as Curate's history held it: "speaker: words", with any photo text, and no "#" at the start of a line.
turns, dates = {}, {}
for sid, conv in data.items():
    c = conv['conversation']
    for key in (k for k in c if re.fullmatch(r'session_\d+', k)):
        for t in c[key]:
            said, tag = str(t.get('text') or ''), photo(t)
            text = f'{said} {tag}' if said and tag else said or tag
            turns[(sid, t['dia_id'])] = f"{t['speaker']}: {re.sub(r'^#+', '', text, flags=re.M)}"
            dates[(sid, t['dia_id'])] = c.get(f'{key}_date_time')

if '--check-prompt' in sys.argv:
    # What an answering prompt shares with the 1,540 scored questions and answer keys: every phrase of three to eight
    # words (phrases made only of common words left out), every answer key of two or more words, every speaker name,
    # every number, every capitalised word inside a sentence, and every word shared with five or fewer questions or
    # answers that the conversations use 20 times or fewer (plain words about reading and answering are not counted).
    STOP = set('a about above after again against all also am an and any are as at be because been before being below between both but by can could did do does doing done down during each even ever every few for from further had has have having he her here hers him his how i if in into is it its just like made make many may me might more most much must my never no nor not now of off on once one only or other our out over own per same say said says she should so some such than that the their them then there these they this those through to too under until up upon us very was we well were what when where which while who whom whose why will with would yes you your'.split())
    INSTRUCTION = set('answer answers question questions item items list lists detail details specific specifically number numbers information topic position multiple combine compare extract single beginning end past across action conversations conversation attributes memory memories evidence text part parts heading headings date dates speaker speakers turn turns line lines rule rules step steps person people event events count counting fact facts statement statements order recent recently latest earlier later week weeks month months year years day days today yesterday tomorrow weekend kind type name names place places title titles photo photos image images shared sharing query search words'.split())
    words = lambda s: re.findall(r"[a-z0-9']+", str(s).lower().replace('’', "'"))
    items = [(f"{sid}:{i}", kind, words(qa[kind])) for sid, conv in data.items() for i, qa in enumerate(conv['qa']) if qa.get('category') in CATEGORIES for kind in ('question', 'answer')]
    in_chats = {}
    for conv in data.values():
        for v in conv['conversation'].values():
            if isinstance(v, list):
                for t in v:
                    for w in words(f"{t.get('text') or ''} {t.get('blip_caption') or ''} {t.get('query') or ''}"): in_chats[w] = in_chats.get(w, 0) + 1
    names = sorted({conv['conversation'][k] for conv in data.values() for k in ('speaker_a', 'speaker_b')})
    text = open(sys.argv[sys.argv.index('--check-prompt') + 1], encoding='utf-8').read()
    pw = words(text)
    grams = {' '.join(pw[i:i + n]) for n in range(3, 9) for i in range(len(pw) - n + 1) if any(w not in STOP for w in pw[i:i + n])}
    shared = {g: [f'{i} {k}' for i, k, w in items if f" {g} " in f" {' '.join(w)} "] for g in grams}
    shared = {g: v for g, v in shared.items() if v}
    phrases = [g for g in shared if not any(o != g and g in o for o in shared)]
    whole = sorted({' '.join(w) for i, k, w in items if k == 'answer' and len(w) >= 2 and f" {' '.join(w)} " in f" {' '.join(pw)} "})
    rare = []
    for w in dict.fromkeys(x for x in pw if x not in STOP and not x.isdigit()):
        hits = [f'{i} {k}' for i, k, ws in items if w in ws]
        if w not in INSTRUCTION and 1 <= len(hits) <= 5 and in_chats.get(w, 0) <= 20: rare.append((w, in_chats.get(w, 0), hits))
    found_names = [n for n in names if re.search(rf'\b{re.escape(n)}\b', text, re.I)]
    capitals = sorted({w.lower() for w in re.findall(r'(?<=[a-z,;:] )[A-Z][a-z]{2,}', text)} & {x for _, _, ws in items for x in ws})
    numbers = sorted({x for x in pw if re.search(r'\d', x)} & {x for _, _, ws in items for x in ws})
    print(f'{len(phrases)} shared phrases of three to eight words, {len(whole)} whole answer keys of two or more words, {len(found_names)} speaker names, {len(numbers)} shared numbers, {len(capitals)} shared capitalised words, {len(rare)} rare shared words')
    for g in phrases: print(f'  phrase "{g}": {"; ".join(shared[g][:6])}')
    for a in whole: print(f'  whole answer key "{a}"')
    for n in found_names: print(f'  speaker name: {n}')
    for n in numbers: print(f'  number "{n}"')
    for c in capitals: print(f'  capitalised word "{c}"')
    for w, n, hits in rare: print(f'  rare word "{w}" ({n} uses in the conversations): {"; ".join(hits)}')
    sys.exit()

def text_of(r):
    return ''.join(x if isinstance(x, str) else turns[(r['sample_id'], x[0])][x[1]:x[2]] for x in r['text'])
def read(name):
    return [json.loads(l) for l in gzip.open(os.path.join(HERE, name), 'rt', encoding='utf-8')]
def joined(texts, answers):
    by = {a['id']: a for a in read(answers)}
    return [{**t, **by[t['id']]} for t in read(texts)]

six, two = joined('texts-6000.jsonl.gz', 'answers-6000.jsonl.gz'), joined('texts-2000.jsonl.gz', 'answers-2000.jsonl.gz')
repeat, mem0 = joined('texts-6000.jsonl.gz', 'answers-6000-repeat.jsonl.gz'), joined('texts-6000.jsonl.gz', 'answers-6000-mem0-prompt.jsonl.gz')
scores_file = os.path.join(HERE, 'scores.json')
scores = json.load(open(scores_file))
chosen = set(scores['settings_chosen_on']['ids'])

if '--text' in sys.argv:
    want = sys.argv[sys.argv.index('--text') + 1]
    for name, rows in (('Curate (full)', six), ('Curate (compact)', two)):
        print(f'===== {name}\n{text_of(next(r for r in rows if r["id"] == want))}')
    sys.exit()

for name, rows in (('Curate (full)', six), ('Curate (compact)', two)):
    same = sum(hashlib.sha256(text_of(r).encode()).hexdigest() == r['text_sha256'] for r in rows)
    print(f'{name}: {same} of {len(rows)} memory texts rebuild to their SHA-256')

def qa(r):
    q = data[r['sample_id']]['qa'][r['qa_index']]
    assert q['category'] == r['category'] in CATEGORIES, r['id']
    return q
def tally(rows, field):
    right = sum(r[field] for r in rows)
    other = [r for r in rows if r['id'] not in chosen]
    by = {n: f"{sum(r[field] for r in rows if qa(r)['category'] == c)}/{sum(qa(r)['category'] == c for r in rows)}" for c, n in CATEGORIES.items()}
    return {'correct': right, 'questions': len(rows), 'accuracy': round(100 * right / len(rows), 1), 'by_category': by,
            'outside_the_159': {'correct': sum(r[field] for r in other), 'questions': len(other), 'accuracy': round(100 * sum(r[field] for r in other) / len(other), 1)}}
counts = {('six_thousand_tokens_every_sentence', 'marked_by_sol'): ('Curate (full), Curate\'s answering prompt, gpt-6.1-sol marks', tally(six, 'sol_correct')),
          ('six_thousand_tokens_every_sentence', 'marked_by_gpt_4o_mini'): ('Curate (full), Curate\'s answering prompt, gpt-4o-mini marks', tally(six, 'second_correct')),
          ('six_thousand_tokens_every_sentence_repeat', 'marked_by_sol'): ('Curate (full), Curate\'s answering prompt, run again, gpt-6.1-sol marks', tally(repeat, 'sol_correct')),
          ('six_thousand_tokens_every_sentence_mem0_answer_prompt', 'marked_by_sol'): ('Curate (full), Mem0\'s answering prompt, gpt-6.1-sol marks', tally(mem0, 'sol_correct')),
          ('six_thousand_tokens_every_sentence_mem0_answer_prompt', 'marked_by_gpt_4o_mini'): ('Curate (full), Mem0\'s answering prompt, gpt-4o-mini marks', tally(mem0, 'second_correct')),
          ('two_thousand_tokens_sentence_cutoff', 'marked_by_gpt_4o_mini'): ('Curate (compact), gpt-4o-mini marks', tally(two, 'correct'))}
for label, t in counts.values():
    o = t['outside_the_159']
    print(f"{label}: {t['correct']}/{t['questions']} = {t['accuracy']}% ({', '.join(f'{k} {v}' for k, v in t['by_category'].items())}); outside the 159: {o['correct']}/{o['questions']} = {o['accuracy']}%")
print(f"The two markers of Curate (full)'s answers differ on {sum(r['sol_correct'] != r['second_correct'] for r in six)}: "
      f"gpt-6.1-sol right and gpt-4o-mini wrong on {sum(r['sol_correct'] and not r['second_correct'] for r in six)}, the reverse on {sum(r['second_correct'] and not r['sol_correct'] for r in six)}.")
print(f"The two runs of Curate's answering prompt agree on {sum(a['sol_correct'] and b['sol_correct'] for a, b in zip(six, repeat))} right and "
      f"{sum(not a['sol_correct'] and not b['sol_correct'] for a, b in zip(six, repeat))} wrong, and differ on {sum(a['sol_correct'] != b['sol_correct'] for a, b in zip(six, repeat))}.")

misses = [r for r in six if not r['sol_correct']]
if '--write' in sys.argv:
    for (setting, marker), (_, t) in counts.items(): scores.setdefault(setting, {}).setdefault(marker, {}).update(t)
    open(scores_file, 'w').write(json.dumps(scores, indent=2) + '\n')
    cell = lambda s: ' '.join(s.split()).replace('|', '\\|')
    lines = ['# Misses of Curate (full)', '',
             f'The {len(misses)} questions that gpt-6.1-sol marked wrong in `answers-6000.jsonl.gz` (Curate\'s answering prompt), in dataset order, with the answer given and the evidence turns LoCoMo names.',
             "`python3 rebuild.py locomo10.json --misses` prints each one with its question, LoCoMo's answer key and the evidence turns in the conversation's own words, read from your copy of the dataset.", '',
             '| Question | Category | Answer given | Marked by gpt-4o-mini | Evidence turns |', '| --- | --- | --- | --- | --- |']
    lines += [f"| `{r['id']}` | {CATEGORIES[r['category']]} | {cell(r['answer'])} | {'right' if r['second_correct'] else 'wrong'} | {', '.join(f'`{e}`' for e in qa(r).get('evidence', []))} |" for r in misses]
    open(os.path.join(HERE, 'misses-6000.md'), 'w').write('\n'.join(lines) + '\n')
    print('Wrote scores.json and misses-6000.md')

if '--misses' in sys.argv:
    for r in misses:
        q = qa(r)
        print(f"\n{r['id']} ({CATEGORIES[q['category']]})\nQuestion: {q['question']}\nAnswer key: {q['answer']}\nAnswer given: {r['answer']}")
        print(f"Marked by gpt-4o-mini: {'right' if r['second_correct'] else 'wrong'}")
        for d in q.get('evidence', []):
            print(f"  {d}, {dates.get((r['sample_id'], d))}: {turns.get((r['sample_id'], d), '(not in the conversation)')}")
