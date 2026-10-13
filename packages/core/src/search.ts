/** Remove only standalone, explicit answer-format and citation clauses.
 *  Counting, dates, comparisons and requests for newer facts stay intact. */
export function stripSearchInstructions(task: string): string {
  const format = /^(?:please\s+)?(?:(?:answer|respond|reply)(?:\s+(?:only|just))?\s+(?:in|with|as|using)|(?:return|output)(?:\s+only)?|format\s+(?:the|your)\s+answer\s+as)\s+(?:(?:one|a\s+single|\d+)\s+(?:line|sentence|paragraph)|plain\s+text|markdown|json|(?:a\s+)?(?:table|bullet\s+(?:points|list)|numbered\s+list))(?:\s+only)?$/i;
  const citation = /^(?:please\s+)?(?:cite\s+(?:both(?:\s+sources)?|(?:the|your)\s+sources|sources|the\s+evidence)|(?:include|provide|add)\s+(?:source\s+)?citations|(?:do\s+not|don't)\s+(?:(?:include|provide|add)\s+(?:source\s+)?citations|cite\s+(?:(?:the|your)\s+)?sources))$/i;
  const parts = task.split(/([.!?;\n,]+)/);
  let removed = false;
  for (let index = 0; index < parts.length; index += 2) {
    const clause = parts[index]!.trim();
    if (!format.test(clause) && !citation.test(clause)) continue;
    parts[index] = '';
    if (index + 1 < parts.length) parts[index + 1] = '';
    if (index > 0 && /^[,;]+$/.test(parts[index - 1]!)) parts[index - 1] = '';
    removed = true;
  }
  return removed ? parts.join('').replace(/[ \t]+/g, ' ').trim() : task;
}

/** Count whole-word, contiguous phrase occurrences. Punctuation and case
 *  do not matter; short words and word order do. No stemming is applied. */
export function phraseCount(text: string, phrase: string): number {
  const words = (value: string) => value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const wanted = words(phrase);
  if (!wanted.length) return 0;
  const tokens = words(text);
  let count = 0;
  for (let index = 0; index <= tokens.length - wanted.length; index++) {
    if (wanted.every((word, offset) => word === tokens[index + offset])) count++;
  }
  return count;
}
