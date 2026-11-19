import { describe, expect, it } from 'vitest';
// @ts-expect-error The standalone JavaScript command has no type declarations.
import { CHAT_LEVERS, CHAT_MODES, NOTE_MODES, neededFrom, parseSources, searchLinesPrompt, wantedFrom } from '../skills/curate/run.mjs';
import { ANSWER_CASCADE } from '@curatejs/core';

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
    const parsed = parseSources({ person: 'Ada', sources: [{ type: 'claude-code', levers: { hardFacts: true, wholeMessages: false, itemsPerRequest: 1 } }] });
    expect(parsed.person).toBe('Ada');
    expect(parsed.sources[0].levers).toEqual({ hardFacts: true, wholeMessages: false, itemsPerRequest: 1 });
    expect(CHAT_LEVERS).toEqual(['wholeMessages', 'hardFacts', 'roles', 'choicePerFact', 'itemsPerRequest']);
  });

  it('refuse a blank name, an unknown lever, a lever of the wrong type, and levers on a non-chat source', () => {
    expect(() => parseSources({ sources: [{ type: 'claude-code', levers: { itemsPerRequest: 0 } }] }))
      .toThrow('itemsPerRequest, a positive whole number;');
    expect(() => parseSources({ sources: [{ type: 'claude-code', levers: { choicePerFact: { candidates: 0 } } }] }))
      .toThrow('choicePerFact may instead be { candidates, enough }');
    expect(() => parseSources({ person: ' ', sources: [] })).toThrow('person must be your name as your tasks word it.');
    expect(() => parseSources({ sources: [{ type: 'claude-code', levers: { faster: true } }] }))
      .toThrow('levers must be an object of booleans named wholeMessages, hardFacts, roles, choicePerFact; itemsPerRequest, a positive whole number;');
    expect(() => parseSources({ sources: [{ type: 'claude-code', levers: { hardFacts: 'yes' } }] }))
      .toThrow('levers must be an object of booleans named wholeMessages, hardFacts, roles, choicePerFact; itemsPerRequest, a positive whole number;');
    expect(() => parseSources({ sources: [{ type: 'git', path: '.', levers: { hardFacts: true } }] }))
      .toThrow('Unknown key "levers" on a git source');
  });
});

describe('values on a chat source\'s levers, and the narrow question in two as its keep question', () => {
  it('take the Choice\'s candidates and sufficiency question, and items per request', () => {
    const parsed = parseSources({ sources: [{ type: 'claude-code',
      levers: { choicePerFact: { candidates: 10, enough: false }, itemsPerRequest: 1 } }] });
    expect(parsed.sources[0].levers).toEqual({ choicePerFact: { candidates: 10, enough: false }, itemsPerRequest: 1 });
  });

  it('name the two-question set "answers", read as the default mode reads', () => {
    expect(parseSources({ sources: [{ type: 'claude-code', questions: 'answers' }] }).sources[0].questions).toBe('answers');
    expect(CHAT_MODES.answers).toMatchObject({ name: 'answers', questions: ANSWER_CASCADE, needed: true });
    expect(CHAT_MODES.answers.read).toBe(CHAT_MODES.default.read);
  });
});

describe('a Markdown entry\'s question set and levers', () => {
  it('takes the narrow question in two and the levers that act on notes', () => {
    const parsed = parseSources({ sources: [{ type: 'markdown', path: '/notes', questions: 'answers',
      levers: { itemsPerRequest: 1, roles: true, choicePerFact: { candidates: 20 } } }] });
    expect(parsed.sources[0]).toMatchObject({ questions: 'answers', levers: { itemsPerRequest: 1, roles: true, choicePerFact: { candidates: 20 } } });
    expect(NOTE_MODES.answers).toMatchObject({ name: 'answers', questions: ANSWER_CASCADE, needed: true, bar: 0.07 });
    expect(NOTE_MODES.answers.read).toBe(NOTE_MODES.default.read);
  });

  it('refuses the chat question sets and the levers that read a conversation\'s messages', () => {
    expect(() => parseSources({ sources: [{ type: 'markdown', path: '/notes', questions: 'judgments' }] }))
      .toThrow('Unknown questions "judgments"; allowed names are default, answers.');
    expect(() => parseSources({ sources: [{ type: 'markdown', path: '/notes', levers: { wholeMessages: true } }] }))
      .toThrow('levers must be an object of booleans named roles, choicePerFact;');
  });
});
