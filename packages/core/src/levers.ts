import type { CurateOptions } from './curate.js';
import type { PickOptions } from './pick.js';
import type { CandidateReadRequest } from './source.js';

/** Every cost-and-quality lever points one way: on adds evidence or
 *  guidance at the risk of more cost, and off spends less and may keep
 *  less. A lever that holds a value keeps it inside the lever:
 *  `everyRanked: { c }` turns the read-every-part lever off at the
 *  scaled top-k coefficient c, and `everyScored: { bar }` turns the
 *  keep-every-part lever off below that decision bar. `labels` and
 *  `route` are on by their option's presence; `rare` takes `true` or
 *  its own share and bar. The decision cache and the curator's short
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
  /** Read every ranked part, on by default. `{ c }` turns it off and
   *  keeps only the top `round(c × N^0.8)` reference parts of the
   *  ranking the decide step reads, where N is every reference part
   *  the pick received. */
  readonly everyRanked: true | { readonly c: number };
  /** Keep every scored part, on by default. `{ bar }` cuts references
   *  below a flat decision bar; `{ bySize }` cuts below a bar that
   *  rises with the decided set's size. */
  readonly everyScored: true | {
    readonly bar?: number;
    readonly bySize?: readonly (readonly [number, number])[];
  };
  /** The label gate: the union of the keyword lanes and the label
   *  lane reaches the decide step. Off by default; needs a
   *  caller-supplied store and `deciderId`, so no preset carries it. */
  readonly labels: boolean;
  /** The route questions: `route: 'jev'` asks the task's four route
   *  questions once per pick and `curate`'s own `route: 'jev'` applies
   *  the answers. A pick record holds the asked state; a curate
   *  record keeps it as `asked` beside the curator's `applied`. */
  readonly route: boolean;
  /** The rare-word round, with the share and bar it ran or would run
   *  with: a second pass that pulls unselected parts sharing a rare
   *  word with a selected one. */
  readonly rare: false | { readonly share: number; readonly bar: number };
}

/** The mode a resolved lever set matches: one of the two exported
 *  presets, or 'custom' for any other combination. */
export type PresetName = 'performance' | 'economy' | 'custom';

/** The lever set a curate record carries: the pick's resolved states
 *  with `route` holding its two stages apart — `asked`, whether the
 *  pick ran the task's route questions, and `applied`, whether this
 *  curate ran `route: 'jev'` and used the answers. Applied needs the
 *  pick's recorded answers, so it is never true with asked false. */
export interface CurateLeverStates extends Omit<LeverStates, 'route'> {
  readonly route: { readonly asked: boolean; readonly applied: boolean };
}

/** The bar the `economy` preset cuts scored references below. It is
 *  the highest cut that lost no answer message in the measurement on
 *  the tuning questions. */
const ECONOMY_BAR = 0.0146;

/** The preset a lever set resolves to. `wholeLanes` unset counts as
 *  off, the default both presets carry; a keyword–meaning split counts
 *  as on, since no preset reads one side's lanes whole and cuts the
 *  other's. */
export function presetName(states: LeverStates): PresetName {
  const wholeLanes = states.wholeLanes ?? false;
  if ((typeof wholeLanes === 'boolean' ? wholeLanes : wholeLanes.keyword || wholeLanes.meaning)
    || states.everyRanked !== true
    || states.labels !== false
    || states.route !== false
    || states.rare !== false) {
    return 'custom';
  }
  if (states.everyScored === true) return 'performance';
  if (states.everyScored.bySize === undefined && states.everyScored.bar === ECONOMY_BAR) {
    return 'economy';
  }
  return 'custom';
}

/** One mode's settings for all three calls a lever can live in:
 *  `read` spreads into the `pickFromSources` request, `pick` into its
 *  options, and `curate` into `curate`'s options. A caller applies a
 *  preset with `{ ...preset.read }`, `{ ...preset.pick }` and
 *  `{ ...preset.curate }`, or spreads one and flips a lever for a
 *  mode of its own. Labels sit in no preset: they need a
 *  caller-supplied store and `deciderId`, added as
 *  `{ ...preset.pick, labels: { directory, deciderId } }`. */
export interface Preset {
  readonly read: Pick<CandidateReadRequest, 'wholeLanes'>;
  readonly pick: Pick<PickOptions, 'everyRanked' | 'everyScored' | 'labels' | 'route' | 'rare'>;
  readonly curate: Pick<CurateOptions, 'route'>;
}

/** The package default: lanes are cut at their own score curves,
 *  every ranked part is decided, every scored part reaches the
 *  curator, and the label gate, route questions and rare-word round
 *  are off. Omitting every lever is `performance`. */
export const performance: Preset = {
  read: { wholeLanes: false },
  pick: { everyRanked: true, everyScored: true },
  curate: {},
};

/** The economic setting: `performance` with `everyScored` off at the
 *  0.0146 bar, so only references the decision model scored at or
 *  above it reach the curator. */
export const economy: Preset = {
  read: { wholeLanes: false },
  pick: { everyRanked: true, everyScored: { bar: ECONOMY_BAR } },
  curate: {},
};
