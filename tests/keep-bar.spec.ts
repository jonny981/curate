import { describe, expect, it } from 'vitest';
// @ts-expect-error The standalone JavaScript script has no type declarations.
import { keepBar, rateRange } from '../scripts/keep-bar.mjs';

/** n tasks, each with one marked answer scored at its low and two other
 *  parts scored 0.05 and 0.9. */
const tasks = (lows: readonly number[]) => Object.fromEntries(lows.map((low, index) => [`t${index}`, {
  scores: { answer: low, quiet: 0.05, loud: 0.9 }, answers: ['answer'], tokens: { answer: 100, quiet: 10, loud: 1000 },
}]));
const nineteen = Array.from({ length: 19 }, (_, index) => 0.1 + index * 0.04);

describe('the keep bar by conformal risk control', () => {
  it('lets no task lose when the bound allows none: the bar is the lowest answer of all', () => {
    const result = keepBar(tasks(nineteen), { risk: 0.05 });
    expect(result).toMatchObject({ tasks: 19, needed: 19, allowed: 0, bar: 0.1, calibration: { losing: 0 } });
    expect(result.bound).toBeCloseTo(0.05, 12);
    // With one task left out, the other 18 cannot reach 0.05.
    expect(result.leaveOneOut).toEqual({ losing: 19, of: 19 });
    expect(result.kept.medianShare).toBeCloseTo(2 / 3, 12);
    expect(result.kept.medianTokens).toBe(1100);
  });

  it('lets one task in twenty lose at a risk of 0.1: the bar is the second-lowest answer', () => {
    const result = keepBar(tasks(nineteen), { risk: 0.1 });
    expect(result).toMatchObject({ allowed: 1, bar: nineteen[1], calibration: { losing: 1 } });
    expect(result.bound).toBeCloseTo(0.1, 12);
    expect(result.calibration.range95[1]).toBeGreaterThan(0.1);
  });

  it('says how many tasks it needs when there are too few', () => {
    expect(keepBar(tasks(nineteen.slice(0, 10)), { risk: 0.05 }))
      .toEqual({ risk: 0.05, tasks: 10, needed: 19, bar: undefined, why: 'With 10 tasks the bound cannot reach a risk of 0.05: it needs at least 19.' });
  });

  it('reads each score as a share of its task\'s best with --relative, and an unscored answer as 0', () => {
    const relative = keepBar(tasks(nineteen), { risk: 0.05, relative: true });
    expect(relative.bar).toBeCloseTo(0.1 / 0.9, 12);
    const unscored = { ...tasks(nineteen), t0: { scores: { other: 0.5 }, answers: ['answer'] } };
    expect(keepBar(unscored, { risk: 0.05 }).bar).toBe(0);
  });

  it('gives the exact 95% range of a rate', () => {
    expect(rateRange(0, 20).map((value: number) => Number(value.toFixed(4)))).toEqual([0, 0.1684]);
    expect(rateRange(1, 20).map((value: number) => Number(value.toFixed(4)))).toEqual([0.0013, 0.2487]);
  });
});
