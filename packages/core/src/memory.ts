import { curate, type CurateLowOptions, type CurateMarkupResult, type CurateOptions, type CurateResult, type CurateWrite } from './curate.js';
import { checkCompression } from './options.js';
import type { PickDecide, PickOptions } from './pick.js';
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

/** Memory options with `curate.compression: 'low'`: the curator also
 *  asks `decide` whether each extracted row counts. */
export interface MemoryLowOptions extends Omit<MemoryOptions, 'curate'> {
  readonly curate: Omit<CurateLowOptions, 'write' | 'signal' | 'decide'>;
}

export interface RecallResult<R extends CurateResult | CurateMarkupResult = CurateResult> {
  /** The log, or under `compression: 'low'` the marked-up memory text. */
  readonly log: string;
  /** Selected rules joined with blank lines, without rewriting their text. */
  readonly rules: string;
  readonly picked: PickSourcesResult;
  readonly result: R;
}

export interface Memory<R extends CurateResult | CurateMarkupResult = CurateResult> {
  /** `taskDate` is the moment every read measures from, and `timeZone`
   *  the zone dates are read in (see the read request's fields of the
   *  same names). With `taskDate` and no `curate.taskDate`, the curator
   *  gets `taskDate` as the task's date label. */
  recall(task: string, options?: {
    readonly taskDate?: string;
    readonly timeZone?: string;
    readonly signal?: AbortSignal;
  }): Promise<RecallResult<R>>;
}

/** Read, select and curate with the question sets carried by the sources.
 *  Incomplete collection throws before writing; its cause holds the pick. */
export function memory(options: MemoryLowOptions): Memory<CurateMarkupResult>;
export function memory(options: MemoryOptions): Memory<CurateResult>;
export function memory(options: MemoryOptions | MemoryLowOptions): Memory<CurateResult | CurateMarkupResult> {
  return {
    async recall(task, { taskDate, timeZone, signal } = {}) {
      // Before any read, so a compression setting the curator rejects
      // costs no decision call.
      checkCompression({ ...options.curate, write: options.write,
        ...(options.curate?.compression === 'low' ? { decide: options.decide } : {}) } as CurateOptions | CurateLowOptions);
      const time = { ...(taskDate === undefined ? {} : { taskDate }), ...(timeZone === undefined ? {} : { timeZone }) };
      const picked = await pickFromSources(options.sources, { ...options.read, ...time, task, signal }, {
        ...options.pick, task, decide: options.decide, signal,
      });
      if (picked.reads.some((read) => read.status !== 'read' || !read.complete)
        || picked.record.candidates.some((item) => item.status === 'unanswered'
          || (item.status === 'unassessed' && item.reason !== 'gate' && item.reason !== 'thoroughness'))) {
        throw new Error('Context collection did not finish; inspect the source and decision records.', { cause: picked });
      }
      const dated = taskDate === undefined ? {} : { taskDate };
      const result = options.curate?.compression === 'low'
        ? await curate(task, picked, { ...dated, ...options.curate, write: options.write, decide: options.decide, signal })
        : await curate(task, picked, { ...dated, ...(options as MemoryOptions).curate, write: options.write, signal });
      const rules = picked.selected.filter((item) => item.role === 'rule').map((item) => item.text).join('\n\n');
      return { log: result.log, rules, picked, result };
    },
  };
}
