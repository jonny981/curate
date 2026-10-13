const STEP2: Record<string, string> = {
  ational: 'ate', tional: 'tion', enci: 'ence', anci: 'ance', izer: 'ize',
  bli: 'ble', alli: 'al', entli: 'ent', eli: 'e', ousli: 'ous',
  ization: 'ize', ation: 'ate', ator: 'ate', alism: 'al', iveness: 'ive',
  fulness: 'ful', ousness: 'ous', aliti: 'al', iviti: 'ive', biliti: 'ble', logi: 'log',
};
const STEP3: Record<string, string> = {
  icate: 'ic', ative: '', alize: 'al', iciti: 'ic', ical: 'ic', ful: '', ness: '',
};

// Count vowel-to-consonant transitions (Porter's m). Initial y is a consonant;
// each later y has the opposite kind to the character before it.
function measure(word: string): number {
  let previousConsonant = true, count = 0;
  for (const [i, c] of [...word].entries()) {
    const consonant: boolean = !(/[aeiou]/.test(c) || (c === 'y' && i > 0 && previousConsonant));
    if (consonant && !previousConsonant) count++;
    previousConsonant = consonant;
  }
  return count;
}
function endsCvc(word: string): boolean {
  let previousConsonant = true, mask = 0;
  for (const [i, c] of [...word].entries()) {
    const consonant: boolean = !(/[aeiou]/.test(c) || (c === 'y' && i > 0 && previousConsonant));
    mask = ((mask << 1) + Number(consonant)) & 7;
    previousConsonant = consonant;
  }
  return word.length >= 3 && mask === 5 && !/[wxy]$/.test(word);
}
// Match the old tokenizer's vowel test, including noninitial y.
const hasVowel = (word: string) => /[aeiou]/.test(word) || word.slice(1).includes('y');

function replaceSuffix(word: string, rules: Record<string, string>, minimum: number): string {
  for (const [suffix, replacement] of Object.entries(rules)) {
    if (word.length > suffix.length && word.endsWith(suffix)) {
      const base = word.slice(0, -suffix.length);
      return measure(base) >= minimum ? base + replacement : word;
    }
  }
  return word;
}

/** Porter (1980) for lowercase ASCII tokens, matching FTS5 Porter.
 * Reference: https://github.com/sqlite/sqlite/blob/master/ext/fts5/fts5_tokenize.c
 */
export function porterStem(word: string): string {
  // FTS5 passes tokens outside this length range through unchanged.
  if (word.length < 3 || word.length > 64) return word;

  // 1a: plurals.
  if ((word.length > 4 && word.endsWith('sses')) || (word.length > 3 && word.endsWith('ies'))) word = word.slice(0, -2);
  else if (word.endsWith('s') && !word.endsWith('ss')) word = word.slice(0, -1);

  // 1b: past tense and gerunds.
  if (word.length > 3 && word.endsWith('eed')) {
    if (measure(word.slice(0, -3)) > 0) word = word.slice(0, -1);
  } else {
    const suffix = word.endsWith('ed') ? 'ed' : word.endsWith('ing') ? 'ing' : '';
    const base = suffix ? word.slice(0, -suffix.length) : '';
    if (hasVowel(base)) {
      word = base;
      if (word.length > 2 && /(at|bl|iz)$/.test(word)) word += 'e';
      else if (/([^aeioulsz])\1$/.test(word)) word = word.slice(0, -1);
      else if (measure(word) === 1 && endsCvc(word)) word += 'e';
    }
  }

  // 1c, then 2 and 3: terminal y and longer suffixes.
  if (word.endsWith('y') && hasVowel(word.slice(0, -1))) word = word.slice(0, -1) + 'i';
  word = replaceSuffix(word, STEP2, 1);
  word = replaceSuffix(word, STEP3, 1);

  // 4: remove a suffix only after two vowel-to-consonant transitions.
  const suffix = word.match(/(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ion|ou|ism|ate|iti|ous|ive|ize)$/)?.[0];
  if (suffix) {
    const base = word.slice(0, -suffix.length);
    if (measure(base) > 1 && (suffix !== 'ion' || /[st]$/.test(base))) word = base;
  }

  // 5: terminal e and doubled l.
  if (word.endsWith('e')) {
    const base = word.slice(0, -1), m = measure(base);
    if (m > 1 || (m === 1 && !endsCvc(base))) word = base;
  }
  if (word.endsWith('ll') && measure(word.slice(0, -1)) > 1) word = word.slice(0, -1);
  return word;
}
