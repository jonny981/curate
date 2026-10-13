export type TaskKind = 'count' | 'date' | 'advice' | 'changed' | 'named' | 'other';

/** Classify only the task's words. A task can need more than one kind of answer. */
export function classifyTask(task: string): readonly TaskKind[] {
  const text = task.replace(/\s*\(asked .*\)\s*$/, '');
  const kinds: TaskKind[] = [];
  if (/\b(how many|how much|total|count|list|enumerate|every|all (?:the|my|of))\b/i.test(text)) kinds.push('count');
  if (/\b(when|how long|how (?:many|much) (?:days?|weeks?|months?|years?|time)|before|after|earlier|later|first|last|latest|oldest|newest|order|since|until|ago)\b/i.test(text)) kinds.push('date');
  if (/\b(advice|suggest\w*|recommend\w*|should|good idea|ideas?|what (?:can|could|would) (?:i|we)|help me (?:choose|pick|decide|plan))\b/i.test(text)) kinds.push('advice');
  if (/\b(now|current\w*|latest|updated?|changed?|instead|anymore|no longer|still|new (?:job|role|plan|habit))\b/i.test(text)) kinds.push('changed');
  const names = text.replace(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|I)\b/g, '');
  if (/(?<![\p{L}\p{N}])['"“‘][^'"”’]+['"”’](?![\p{L}\p{N}])|#[\p{L}\p{N}_]+/u.test(names)
    || /(?<![\p{L}\p{N}])\p{Lu}[\p{L}\p{N}_-]+/u.test(names.replace(/(?:^|[.!?]\s+)\S+/g, ''))) kinds.push('named');
  return kinds.length ? kinds : ['other'];
}
