import type { CandidateSourceKind, PickCascade } from './pick.js';

/** Every cost-and-quality lever points one way: on adds evidence or
 *  guidance at the risk of more cost, and off spends less and may keep
 *  less. A lever that holds a value keeps it inside the lever:
 *  `everyRanked: { c }` turns the read-every-part lever off at the
 *  scaled top-k coefficient c, and `everyScored: { bar }` turns the
 *  keep-every-part lever off below that decision bar. `route` is on by
 *  its option's presence; `rare` takes `true` or its own share and bar.
 *  Labels, the rare-word round's on state and the decision-score bars
 *  belong to each source and are recorded per source in `sources`;
 *  `everyScored` and `rare`, when given, override every source. The decision cache and the curator's short
 *  item ids are not levers: they lose no quality, so they are always
 *  available — the cache whenever the caller passes `cache`. */
export interface LeverStates {
  /** Read the whole of each search lane's ranked list, off by default:
   *  the lanes are cut where each lane's own score curve flattens.
   *  `pickFromSources` resolves the read request's `wholeLanes` for the
   *  keyword lanes and `meaning.wholeLanes` for the meaning lanes —
   *  which follows the keyword state when unset — and records both
   *  here: one boolean when they agree, `{ keyword, meaning }` when a
   *  meaning override split them. A direct `pick` never sees it. */
  readonly wholeLanes?: boolean | {
    readonly keyword: boolean;
    readonly meaning: boolean;
  };
  /** Read every ranked part. `{ c }` turns it off and keeps only the
   *  top `round(c × N^0.8)` reference parts of the ranking the decide
   *  step reads, where N is every reference part the pick received.
   *  Present only when the call gave it; a pick without it records
   *  `thoroughness` instead, 'deep' when no level was named. */
  readonly everyRanked?: true | { readonly c: number };
  /** The appetite for look-back the pick ran with: the level whose
   *  `THOROUGHNESS` depth cut the fused order's short list. Present
   *  whenever `everyRanked` was not given; 'deep' unless the call
   *  chose a level. */
  readonly thoroughness?: 'quick' | 'normal' | 'deep';
  /** Present only when the call gave it, in place of every source's
   *  own `bar`: `true` keeps every scored part, `{ bar }` cuts references
   *  below a flat decision bar, `{ bySize }` cuts below a bar that rises
   *  with the decided set's size. */
  readonly everyScored?: true | {
    readonly bar?: number;
    readonly bySize?: readonly (readonly [number, number])[];
  };
  /** The route questions: `route: 'jev'` asks the task's four route
   *  questions once per pick and `curate`'s own `route: 'jev'` applies
   *  the answers. A pick record holds the asked state; a curate
   *  record keeps it as `asked` beside the curator's `applied`. */
  readonly route: boolean;
  /** The rare-word round, with the share and bar it ran with: a second
   *  pass that pulls unselected parts sharing a rare word with a selected
   *  one, from the sources `sources` marks `rare`. False when no source
   *  ran it. */
  readonly rare: false | {
    readonly share: number;
    readonly bar: number;
  };
  /** The settings each source ran with, by source id. */
  readonly sources: Readonly<Record<string, SourceSettings>>;
}

/** One source's own settings as a pick applied them. */
export interface SourceSettings {
  /** The source's kind, when it declares one. */
  readonly kind?: CandidateSourceKind;
  /** The label gate ran on this source's parts with its label kinds. */
  readonly labels: boolean;
  /** The label bar this source's needs and label lane used, present
   *  when the source carries label kinds. */
  readonly labelBar?: number;
  /** The rare-word round was on for this source's parts. */
  readonly rare: boolean;
  /** The decision-score bar this source's references were cut at: 0
   *  when every scored part was kept. */
  readonly bar: number;
  /** The bar this source's rules were cut at, present when the source
   *  produced rules. */
  readonly ruleBar?: number;
  /** The decision questions this source's reference parts were asked,
   *  present when the source carries a set; absent, they were asked the
   *  built-in question for their kind. */
  readonly questions?: PickCascade;
  /** The decay half-life this source's Markdown parts ranked with,
   *  present when the source has `decay` on. Only a record
   *  pickFromSources produced carries it. */
  readonly decay?: { readonly halfLife: string };
}

/** The lever set a curate record carries: the pick's resolved states
 *  with `route` holding its two stages apart — `asked`, whether the
 *  pick ran the task's route questions, and `applied`, whether this
 *  curate ran `route: 'jev'` and used the answers. Applied needs the
 *  pick's recorded answers, so it is never true with asked false. */
export interface CurateLeverStates extends Omit<LeverStates, 'route'> {
  readonly route: { readonly asked: boolean; readonly applied: boolean };
}
