import { describe, expect, it } from 'vitest';
// @ts-expect-error The standalone JavaScript command has no type declarations.
import { neededFrom, searchLinesPrompt } from '../skills/curate/run.mjs';

describe('the facts the answer needs, from the search-line call', () => {
  it('are asked in the same call only when a mode in the call lists them', () => {
    const asked = searchLinesPrompt('Which database did we choose?', ['chat'], undefined, true);
    expect(asked).toContain('split the task into the separate facts that a complete answer needs');
    expect(asked).toContain('"needed"');
    expect(searchLinesPrompt('Which database did we choose?', ['chat'])).not.toContain('"needed"');
  });

  it('keep one to five strings, and say why there are none otherwise', () => {
    expect(neededFrom([' Which database was chosen ', 'Why'])).toEqual({ facts: ['Which database was chosen', 'Why'] });
    expect(neededFrom(undefined)).toEqual({ missing: 'the reply gave no facts' });
    for (const bad of [[], ['a', 'b', 'c', 'd', 'e', 'f'], ['ok', ''], 'one fact', [1]]) {
      expect(neededFrom(bad)).toEqual({ missing: 'the reply\'s facts were not one to five strings' });
    }
  });
});
