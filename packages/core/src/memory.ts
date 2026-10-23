import { curate, type CurateOptions, type CurateResult, type CurateWrite } from './curate.js';
import type { CandidateSourceKind, PickCascade, PickDecide, PickOptions } from './pick.js';
import { pickFromSources, type CandidateReadRequest, type CandidateSource, type PickSourcesResult } from './source.js';

export interface MemoryOptions {
  readonly sources: readonly CandidateSource[];
  readonly decide: PickDecide;
  readonly write: CurateWrite;
  /** Read, pick and writer options for the whole call; each source
   *  carries its own settings. */
  readonly read?: Omit<CandidateReadRequest, 'task' | 'signal'>;
  readonly pick?: Omit<PickOptions, 'task' | 'decide' | 'signal'>;
  readonly curate?: Omit<CurateOptions, 'write' | 'signal'>;
}

export interface RecallResult {
  readonly log: string;
  /** Selected rules joined with blank lines, without rewriting their text. */
  readonly rules: string;
  readonly picked: PickSourcesResult;
  readonly result: CurateResult;
}

/** Read, select and curate with the question sets carried by the sources.
 *  Incomplete collection throws before writing; its cause holds the pick. */
export function memory(options: MemoryOptions) {
  const cascadesByKind: Partial<Record<CandidateSourceKind, PickCascade>> = {};
  for (const source of options.sources) {
    if (source.kind !== undefined && source.cascade !== undefined) {
      cascadesByKind[source.kind] = source.cascade;
    }
  }
  return {
    async recall(task: string, { signal }: { readonly signal?: AbortSignal } = {}): Promise<RecallResult> {
      const picked = await pickFromSources(options.sources, { ...options.read, task, signal }, {
        ...options.pick, task, decide: options.decide, signal,
        cascadesByKind: { ...cascadesByKind, ...options.pick?.cascadesByKind },
      });
      if (picked.reads.some((read) => read.status !== 'read' || !read.complete)
        || picked.record.candidates.some((item) => item.status === 'unanswered'
          || (item.status === 'unassessed' && item.reason !== 'gate'))) {
        throw new Error('Context collection did not finish; inspect the source and decision records.', { cause: picked });
      }
      const result = await curate(task, picked, { ...options.curate, write: options.write, signal });
      const rules = picked.selected.filter((item) => item.role === 'rule').map((item) => item.text).join('\n\n');
      return { log: result.log, rules, picked, result };
    },
  };
}
