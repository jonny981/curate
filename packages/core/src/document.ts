import type { MemoryCandidate } from './pick.js';

/** The document or session a candidate belongs to, with a display name:
 *  a host-supplied part's is its `documentId`, a chat part's is its
 *  `chat.sessionId`, a note part's is its file, and anything else stands
 *  alone as its own item. `pick`'s bestPartFirst grouping and `observe`'s
 *  session grouping share it; the caller's grouping key is
 *  [sourceId, sourceRevision, document]. */
export function candidateDocument(candidate: MemoryCandidate): {
  readonly document: readonly unknown[];
  readonly name: string;
} {
  if (candidate.documentId !== undefined) {
    return { document: ['document', candidate.documentId], name: candidate.documentId };
  }
  if (candidate.chat) {
    return { document: ['chat', candidate.chat.provider, candidate.chat.sessionId], name: candidate.chat.sessionId };
  }
  if (candidate.contentRef?.includes('#L')) {
    return { document: ['note', candidate.contentRef.split('#L')[0]], name: candidate.contentRef.split('#L')[0]! };
  }
  if (candidate.path) return { document: ['note', candidate.path], name: candidate.path };
  return { document: ['item', candidate.id], name: candidate.id };
}
