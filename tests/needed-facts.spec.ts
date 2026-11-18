import { describe, expect, it } from 'vitest';
// @ts-expect-error The standalone JavaScript command has no type declarations.
import { CHAT_LEVERS, neededFrom, parseSources, searchLinesPrompt, wantedFrom } from '../skills/curate/run.mjs';

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

describe('how many answers the task wants, from the search-line call', () => {
  it('keeps "one decision" or "everything said", and says why there is none otherwise', () => {
    expect(wantedFrom('one decision')).toEqual({ value: 'one decision' });
    expect(wantedFrom('everything said')).toEqual({ value: 'everything said' });
    expect(wantedFrom(undefined)).toEqual({ missing: 'the reply gave no answer' });
    expect(wantedFrom('all')).toEqual({ missing: 'the reply was not "one decision" or "everything said"' });
  });
});

describe('the person and a chat source\'s levers in the settings', () => {
  it('take a name and named boolean levers on a chat source', () => {
    const parsed = parseSources({ person: 'Ada', sources: [{ type: 'claude-code', levers: { hardFacts: true, wholeMessages: false } }] });
    expect(parsed.person).toBe('Ada');
    expect(parsed.sources[0].levers).toEqual({ hardFacts: true, wholeMessages: false });
    expect(CHAT_LEVERS).toEqual(['wholeMessages', 'hardFacts', 'roles', 'choicePerFact']);
  });

  it('refuse a blank name, an unknown lever, a lever that is not a boolean, and levers on a non-chat source', () => {
    expect(() => parseSources({ person: ' ', sources: [] })).toThrow('person must be your name as your tasks word it.');
    expect(() => parseSources({ sources: [{ type: 'claude-code', levers: { faster: true } }] }))
      .toThrow('levers must be an object of booleans named wholeMessages, hardFacts, roles, choicePerFact.');
    expect(() => parseSources({ sources: [{ type: 'claude-code', levers: { hardFacts: 'yes' } }] }))
      .toThrow('levers must be an object of booleans named wholeMessages, hardFacts, roles, choicePerFact.');
    expect(() => parseSources({ sources: [{ type: 'git', path: '.', levers: { hardFacts: true } }] }))
      .toThrow('Unknown key "levers" on a git source');
  });
});
