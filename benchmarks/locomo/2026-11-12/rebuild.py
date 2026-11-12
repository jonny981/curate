"""Rebuild every memory text in this folder from LoCoMo's own file, check each against its SHA-256, and recount the scores.

Usage:
  python3 rebuild.py locomo10.json            rebuild and check all 3,080 texts, then recount
  python3 rebuild.py locomo10.json --misses   also print each miss of the 6,000-token setting with the dataset's words
  python3 rebuild.py locomo10.json --text ID  print both settings' memory texts for one question, such as conv-26:0
  python3 rebuild.py locomo10.json --write    also rewrite the counts in scores.json and misses-6000.md from the records

locomo10.json is LoCoMo's data file. This folder does not hold the dataset's text.
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

def text_of(r):
    return ''.join(x if isinstance(x, str) else turns[(r['sample_id'], x[0])][x[1]:x[2]] for x in r['text'])
def read(name):
    return [json.loads(l) for l in gzip.open(os.path.join(HERE, name), 'rt', encoding='utf-8')]
def joined(texts, answers):
    by = {a['id']: a for a in read(answers)}
    return [{**t, **by[t['id']]} for t in read(texts)]

six, two = joined('texts-6000.jsonl.gz', 'answers-6000.jsonl.gz'), joined('texts-2000.jsonl.gz', 'answers-2000.jsonl.gz')
scores_file = os.path.join(HERE, 'scores.json')
scores = json.load(open(scores_file))
chosen = set(scores['settings_chosen_on']['ids'])

if '--text' in sys.argv:
    want = sys.argv[sys.argv.index('--text') + 1]
    for name, rows in (('6,000 tokens, every sentence', six), ('2,000 tokens, sentence cutoff 0.1', two)):
        print(f'===== {name}\n{text_of(next(r for r in rows if r["id"] == want))}')
    sys.exit()

for name, rows in (('6,000 tokens', six), ('2,000 tokens', two)):
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
counts = {('six_thousand_tokens_every_sentence', 'marked_by_sol'): tally(six, 'sol_correct'),
          ('six_thousand_tokens_every_sentence', 'marked_by_gpt_4o_mini'): tally(six, 'second_correct'),
          ('two_thousand_tokens_sentence_cutoff', 'marked_by_gpt_4o_mini'): tally(two, 'correct')}
labels = ['6,000 tokens, gpt-6.1-sol marks', '6,000 tokens, gpt-4o-mini marks', '2,000 tokens, gpt-4o-mini marks']
for label, t in zip(labels, counts.values()):
    o = t['outside_the_159']
    print(f"{label}: {t['correct']}/{t['questions']} = {t['accuracy']}% ({', '.join(f'{k} {v}' for k, v in t['by_category'].items())}); outside the 159: {o['correct']}/{o['questions']} = {o['accuracy']}%")
print(f"The two markers of the 6,000-token answers differ on {sum(r['sol_correct'] != r['second_correct'] for r in six)}: "
      f"gpt-6.1-sol right and gpt-4o-mini wrong on {sum(r['sol_correct'] and not r['second_correct'] for r in six)}, the reverse on {sum(r['second_correct'] and not r['sol_correct'] for r in six)}.")

misses = [r for r in six if not r['sol_correct']]
if '--write' in sys.argv:
    for (setting, marker), t in counts.items(): scores[setting][marker].update(t)
    open(scores_file, 'w').write(json.dumps(scores, indent=2) + '\n')
    cell = lambda s: ' '.join(s.split()).replace('|', '\\|')
    lines = ['# Misses of the 6,000-token setting', '',
             f'The {len(misses)} questions that gpt-6.1-sol marked wrong in `answers-6000.jsonl.gz`, in dataset order, with the answer given and the evidence turns LoCoMo names.',
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
