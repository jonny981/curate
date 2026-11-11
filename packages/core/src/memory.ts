import { curate, type CurateOptions, type CurateResult } from './curate.js';
import { checkCurateOptions } from './options.js';
import type { PickDecide, PickOptions } from './pick.js';
import { pickFromSources, type CandidateReadRequest, type CandidateSource, type PickSourcesResult } from './source.js';

export interface MemoryOptions {
  readonly sources: readonly CandidateSource[];
  /** Rates each part for the pick and, unless `curate.sentenceCutoff`
   *  is `false`, each sentence of the parts laid out. */
  readonly decide: PickDecide;
  /** Read, pick and layout options for the whole call; each source
   *  carries its own settings. */
  readonly read?: Omit<CandidateReadRequest, 'task' | 'signal'>;
  readonly pick?: Omit<PickOptions, 'task' | 'decide' | 'signal'>;
  readonly curate?: Omit<CurateOptions, 'decide' | 'signal'>;
}

export interface RecallResult {
  /** The kept parts laid out in their own words. */
  readonly log: string;
  /** Selected rules joined with blank lines, without rewriting their text. */
  readonly rules: string;
  readonly picked: PickSourcesResult;
  readonly result: CurateResult;
}

export interface Memory {
  /** `taskDate` is the moment every read measures from, and `timeZone`
   *  the zone dates are read in (see the read request's fields of the
   *  same names). */
  recall(task: string, options?: {
    readonly taskDate?: string;
    readonly timeZone?: string;
    readonly signal?: AbortSignal;
  }): Promise<RecallResult>;
}

/** Read and select with the question sets carried by the sources, then
 *  lay out the kept parts with `curate`, rating their sentences with the
 *  same `decide`. Incomplete collection throws before the layout; its
 *  cause holds the pick. */
export function memory(options: MemoryOptions): Memory {
  return {
    async recall(task, { taskDate, timeZone, signal } = {}) {
      const layout = { ...options.curate, decide: options.decide };
      // Before any read, so a layout option curate rejects costs no decision call.
      checkCurateOptions(layout);
      const time = { ...(taskDate === undefined ? {} : { taskDate }), ...(timeZone === undefined ? {} : { timeZone }) };
      const picked = await pickFromSources(options.sources, { ...options.read, ...time, task, signal }, {
        ...options.pick, task, decide: options.decide, signal,
      });
      if (picked.reads.some((read) => read.status !== 'read' || !read.complete)
        || picked.record.candidates.some((item) => item.status === 'unanswered'
          || (item.status === 'unassessed' && item.reason !== 'gate' && item.reason !== 'thoroughness'))) {
        throw new Error('Context collection did not finish; inspect the source and decision records.', { cause: picked });
      }
      const result = await curate(task, picked, { ...layout, signal });
      const rules = picked.selected.filter((item) => item.role === 'rule').map((item) => item.text).join('\n\n');
      return { log: result.log, rules, picked, result };
    },
  };
}
