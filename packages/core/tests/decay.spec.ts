import { describe, expect, it } from 'vitest';

import { decayWeight, durationMs, taskMoment } from '../src/time.js';

const DAY = 86_400_000;
const asOf = taskMoment('2025-06-02', 'UTC');

describe('decayWeight', () => {
  it('gives no decay to a part with no date', () => {
    expect(decayWeight(undefined, asOf, 365 * DAY, -2, 'UTC')).toBeUndefined();
  });

  it('gives no decay to a part with an unreadable date or one after the task date', () => {
    expect(decayWeight('June 2020', asOf, 365 * DAY, -2, 'UTC')).toBeUndefined();
    expect(decayWeight('2025-06-03', asOf, 365 * DAY, -2, 'UTC')).toBeUndefined();
  });

  it('is half the weight at one half-life and 0 at the task moment', () => {
    expect(decayWeight(new Date(asOf - 365 * DAY).toISOString(), asOf, 365 * DAY, -2, 'UTC')).toBeCloseTo(-1, 10);
    expect(decayWeight(new Date(asOf).toISOString(), asOf, 365 * DAY, -2, 'UTC')).toBeCloseTo(0, 12);
  });

  it('reads a bare date as the start of that day in the zone', () => {
    const london = taskMoment('2025-06-02', 'Europe/London');
    const age = (london - Date.parse('2025-05-31T23:00:00Z')) / DAY;
    expect(decayWeight('2025-06-01', london, 365 * DAY, -2, 'Europe/London')).toBeCloseTo(-2 * (1 - 2 ** (-age / 365)), 12);
  });
});

describe('durationMs', () => {
  it('reads the form chat\'s since takes', () => {
    expect(durationMs('365 days', 'decay.halfLife')).toBe(365 * DAY);
    expect(durationMs('2 weeks', 'decay.halfLife')).toBe(14 * DAY);
  });

  it.each(['a year', '0 days', '365', 365, undefined])('refuses %s', (text) => {
    expect(() => durationMs(text, 'decay.halfLife')).toThrow('decay.halfLife must be a duration such as "365 days".');
  });
});
