import { describe, expect, it } from 'vitest';

import { taskPeriod } from '../src/index.js';

const asOf = '2025-06-02T12:00:00+01:00';
const timeZone = 'Europe/London';
const GMT = '+00:00';
const BST = '+01:00';

describe('taskPeriod', () => {
  it.each([
    ['What did I decide in March?', `2025-03-01T00:00:00.000${GMT}`, `2025-03-31T23:59:59.999${BST}`],
    ['What did we ship in March 2024?', `2024-03-01T00:00:00.000${GMT}`, `2024-03-31T23:59:59.999${BST}`],
    ['What changed in 2024?', `2024-01-01T00:00:00.000${GMT}`, `2024-12-31T23:59:59.999${GMT}`],
    ['What did I say yesterday?', `2025-06-01T00:00:00.000${BST}`, `2025-06-01T23:59:59.999${BST}`],
    ['What happened last week?', `2025-05-26T00:00:00.000${BST}`, `2025-06-01T23:59:59.999${BST}`],
    ['What did I do 3 days ago?', `2025-05-30T00:00:00.000${BST}`, `2025-05-30T23:59:59.999${BST}`],
    ['Did we fix it on 2025-03-04?', `2025-03-04T00:00:00.000${GMT}`, `2025-03-04T23:59:59.999${GMT}`],
    ['Was it in March or in April?', `2025-03-01T00:00:00.000${GMT}`, `2025-04-30T23:59:59.999${BST}`],
  ])('%s', (task, from, to) => {
    // Each bound is the start or the end of that day in London, with that day's offset.
    expect(taskPeriod(task, { asOf, timeZone })).toEqual({ from, to });
  });

  it.each(['May I ask what we chose?', 'Which database did we choose?'])('%s names no period', (task) => {
    expect(taskPeriod(task, { asOf, timeZone })).toBeUndefined();
  });
});
