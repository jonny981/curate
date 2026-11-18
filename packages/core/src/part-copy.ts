import type { MemoryCandidate } from './pick.js';

/** A copy of a part with some fields changed, as a spread makes it but
 *  keeping the part's prototype: a part that reads its text on demand
 *  (see `SETTLE_PART` in source.ts) still does, and still holds none. */
export function copyPart(candidate: MemoryCandidate, changes: Partial<MemoryCandidate>): MemoryCandidate {
  return Object.assign(Object.create(Object.getPrototypeOf(candidate)) as MemoryCandidate, candidate, changes);
}

/** A copy of a part without some of its fields, keeping its prototype. */
export function omitted(candidate: MemoryCandidate, keys: readonly (keyof MemoryCandidate)[]): MemoryCandidate {
  const rest = Object.create(Object.getPrototypeOf(candidate)) as Record<string | symbol, unknown>;
  for (const key of Reflect.ownKeys(candidate)) {
    if (!(keys as readonly (string | symbol)[]).includes(key)) rest[key] = (candidate as unknown as Record<string | symbol, unknown>)[key];
  }
  return rest as unknown as MemoryCandidate;
}
