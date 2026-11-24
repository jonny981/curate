// The keep bar set by measurement, not by hand: conformal risk control
// (Angelopoulos and others, 2022) on saved decision scores and marked
// answers. A task loses when any of its marked answer parts scores under
// the bar. Over n tasks the bar is the highest one at which
// (n / (n + 1)) × (the share of tasks that lose) + 1 / (n + 1) stays at or
// under the chosen risk; for a new task like these, the chance that it
// loses an answer is then at most that risk. No default changes: this
// only reports a bar and what it would keep.
//
//   node scripts/keep-bar.mjs <ratings.json> [--risk 0.05] [--relative]
//
// <ratings.json>: { "<task>": { "scores": { "<part id>": 0.83, ... },
//   "answers": ["<part id>", ...], "tokens": { "<part id>": 120, ... } } }.
//   `tokens` is optional. An answer part with no score scores 0: no bar
//   above 0 keeps it. A task with no marked answer cannot lose and is
//   left out, so the bound holds for tasks that have an answer.
// --risk: the most tasks' share that may lose an answer, above 0 and
//   below 1; 0.05 unless set.
// --relative: each score as a share of its task's best score.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The binomial probability of at most `k` successes in `n` at `p`. */
function atMost(k, n, p) {
  let term = (1 - p) ** n;
  let sum = term;
  for (let i = 1; i <= k; i += 1) {
    term *= ((n - i + 1) / i) * (p / (1 - p));
    sum += term;
  }
  return sum;
}

/** The p at which a decreasing function of p crosses `target`, by halving. */
function crossing(fn, target) {
  let low = 0;
  let high = 1;
  for (let step = 0; step < 60; step += 1) {
    const middle = (low + high) / 2;
    if (fn(middle) > target) low = middle; else high = middle;
  }
  return (low + high) / 2;
}

/** The exact (Clopper-Pearson) 95% range of a rate seen `k` times in `n`. */
export function rateRange(k, n) {
  const lower = k === 0 ? 0 : crossing((p) => atMost(k - 1, n, p), 0.975);
  const upper = k === n ? 1 : crossing((p) => atMost(k, n, p), 0.025);
  return [lower, upper];
}

/** Each task's lowest marked answer score: the bar above which it loses. */
function lowest(tasks, relative) {
  return Object.entries(tasks).flatMap(([name, task]) => {
    if (!task.answers?.length) return [];
    const best = Math.max(0, ...Object.values(task.scores));
    const scale = relative && best > 0 ? best : 1;
    return [{ name, low: Math.min(...task.answers.map((id) => (task.scores[id] ?? 0) / scale)), task, scale }];
  });
}

/** The highest bar at which at most `allowed` of the lows sit under it:
 *  the (allowed + 1)-th lowest. Undefined when no task may lose and none
 *  can be lost. */
function barFor(lows, risk) {
  const n = lows.length;
  const allowed = Math.floor(risk * (n + 1) - 1 + 1e-12);
  if (allowed < 0) return { allowed };
  const sorted = lows.map((task) => task.low).sort((left, right) => left - right);
  return { allowed, bar: sorted[Math.min(allowed, n - 1)] };
}

/** The bar conformal risk control sets, with what it rests on and what it
 *  keeps. */
export function keepBar(tasks, { risk = 0.05, relative = false } = {}) {
  if (!(risk > 0 && risk < 1)) throw new TypeError('risk must be above 0 and below 1.');
  const lows = lowest(tasks, relative);
  const n = lows.length;
  const { allowed, bar } = barFor(lows, risk);
  // The fewest tasks that let the bound reach this risk at all.
  const needed = Math.ceil(1 / risk - 1);
  if (bar === undefined) {
    return { risk, tasks: n, needed, bar: undefined,
      why: `With ${n} tasks the bound cannot reach a risk of ${risk}: it needs at least ${needed}.` };
  }
  const losing = lows.filter((task) => task.low < bar).length;
  // Each task judged by the bar the other tasks set.
  const leftOut = lows.filter((task, index) => {
    const others = barFor(lows.filter((_, other) => other !== index), risk).bar;
    return others === undefined || task.low < others;
  }).length;
  const shares = lows.map(({ task, scale }) => {
    const scores = Object.values(task.scores).map((score) => score / scale);
    return scores.filter((score) => score >= bar).length / Math.max(1, scores.length);
  });
  const tokens = lows.filter(({ task }) => task.tokens !== undefined).map(({ task, scale }) =>
    Object.entries(task.scores).reduce((sum, [id, score]) => sum + (score / scale >= bar ? task.tokens[id] ?? 0 : 0), 0));
  const median = (values) => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted.length === 0 ? undefined : sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  };
  return {
    risk, relative, tasks: n, needed, allowed, bar,
    bound: (n / (n + 1)) * (losing / n) + 1 / (n + 1),
    calibration: { losing, range95: rateRange(losing, n) },
    leaveOneOut: { losing: leftOut, of: n },
    kept: { medianShare: median(shares), meanShare: shares.reduce((sum, share) => sum + share, 0) / Math.max(1, n),
      ...(tokens.length === 0 ? {} : { medianTokens: median(tokens) }) },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, ...flags] = process.argv.slice(2);
  if (!file) {
    console.error('usage: node scripts/keep-bar.mjs <ratings.json> [--risk 0.05] [--relative]');
    process.exit(2);
  }
  const at = flags.indexOf('--risk');
  const risk = at >= 0 ? Number(flags[at + 1]) : undefined;
  console.log(JSON.stringify(keepBar(JSON.parse(readFileSync(file, 'utf8')),
    { ...(risk === undefined ? {} : { risk }), relative: flags.includes('--relative') }), null, 1));
}
