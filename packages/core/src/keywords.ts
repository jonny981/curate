const TOKEN = /[\p{L}\p{N}]+/gu;
const CODE_FORM = /[@\w./-]*[./@][\w./-]+|[a-z]+[A-Z]\w+|`[^`]+`/g;

export function tokenize(value: string): readonly string[] {
  return value.normalize('NFKC').toLowerCase().match(TOKEN) ?? [];
}

export function taskTerms(task: string, paths: readonly string[], stopWords: readonly string[]): readonly string[] {
  const words = new Set<string>();
  const add = (value: string) => {
    for (const token of tokenize(value)) {
      if (token.length > 2 && !stopWords.includes(token)) words.add(token);
    }
  };
  for (const word of task.toLowerCase().split(/[^a-z0-9-]+/)) add(word);
  for (const form of task.match(CODE_FORM) ?? []) add(form.replace(/`/g, ''));
  for (const part of paths.flatMap((path) => path.split('/'))) {
    if (part.length >= 4) add(part);
  }
  return [...words];
}

export function hits(text: string, terms: readonly string[]): number {
  const words = new Set(tokenize(text));
  return terms.filter((term) => words.has(term)).length;
}
