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

/** Bytes of file text the shared `context.files` cache holds before it
 *  stops taking new entries. Within the cap, one file is still read once
 *  across lanes and overlapping sources; beyond it each pass re-reads
 *  from disk, so a large corpus's contents are never all held at once. */
export const SHARED_FILE_CACHE_BYTES = 64 * 1024 * 1024;

/** Read one file's text through the pick's shared cache while it has
 *  room, or straight from the reader once the cache is full. Over-cap
 *  entries are dropped again after resolving so a later pass re-reads
 *  the file instead of keeping its text. */
export function sharedFileText(
  context: { files: Map<string, Promise<string>>; fileBytes?: number } | undefined,
  key: string,
  read: () => Promise<string>,
): Promise<string> {
  if (context === undefined) return read();
  const cached = context.files.get(key);
  if (cached !== undefined) return cached;
  const fetched = read().then((text) => {
    context.fileBytes = (context.fileBytes ?? 0) + text.length;
    if (context.fileBytes > SHARED_FILE_CACHE_BYTES) context.files.delete(key);
    return text;
  });
  context.files.set(key, fetched);
  return fetched;
}

/** Store text a caller already holds — for example a blob fetched in a
 *  batch — under the shared cache's byte cap. Over the cap the text is
 *  not kept, so a later pass fetches it again rather than the corpus
 *  staying resident. */
export function sharedFileStore(
  context: { files: Map<string, Promise<string>>; fileBytes?: number } | undefined,
  key: string,
  text: string,
): void {
  if (context === undefined) return;
  context.fileBytes = (context.fileBytes ?? 0) + text.length;
  if (context.fileBytes > SHARED_FILE_CACHE_BYTES) return;
  context.files.set(key, Promise.resolve(text));
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
