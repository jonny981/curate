import { describe, expect, it } from 'vitest';
// @ts-expect-error The standalone JavaScript command has no type declarations.
import { CHAT_LEVERS, CHAT_MODES, NOTE_MODES, countsFrom, neededFrom, parseSources, searchLinesPrompt, wantedFrom } from '../skills/curate/run.mjs';
import { ANSWER_CASCADE } from '@curatejs/core';
import { MESSAGE_ANSWER_CASCADE } from '@curatejs/chat';

describe('the facts the answer needs, from the search-line call', () => {
  it('are asked in the same call only when a mode in the call lists them', () => {
    const asked = searchLinesPrompt('Which database did we choose?', ['chat'], undefined, true);
    expect(asked).toContain('split the task into the separate facts that a complete answer needs');
    expect(asked).toContain('"needed"');
    expect(searchLinesPrompt('Which database did we choose?', ['chat'])).not.toContain('"needed"');
  });

  it('words a fact about what someone said to cover their questions and requests when a transcript mode asks, and asks which messages count', () => {
    const asked = searchLinesPrompt('Everything Ana said about the release modes', ['chat'], undefined, true, true, true);
    expect(asked).toContain('word each fact as what they said, asked or requested about it');
    // Notes: the facts are asked without it. On 64 LongMemEval questions it turned 12 facts into what the user asked,
    // such as "What the user asked on November 10, 2023 about how often they see their therapist".
    const notes = searchLinesPrompt('How often do I see my therapist, Dr. Smith?', ['markdown'], undefined, true);
    expect(notes).toContain('split the task into the separate facts that a complete answer needs, where each fact may be stated in a different message. Write each');
    expect(notes).not.toContain('asked or requested');
    expect(asked).toContain('"counts": exactly "statements by the person", "statements, questions and requests by the person" or "anything anyone said"');
    expect(searchLinesPrompt('Everything Ana said about the release modes', ['chat'], undefined, true)).not.toContain('"counts"');
    expect(countsFrom('statements, questions and requests by the person')).toEqual({ value: 'statements, questions and requests by the person' });
    expect(countsFrom('questions')).toEqual({ missing: 'the reply was not one of "statements by the person", "statements, questions and requests by the person", "anything anyone said"' });
    expect(countsFrom(undefined)).toEqual({ missing: 'the reply gave no answer' });
  });

  it('asks for each fact as one thing a single message could say, never a computed, listed or compared value', () => {
    const asked = searchLinesPrompt('How old was I when Alex was born?', ['markdown'], undefined, true);
    for (const words of ['an age rather than a birth date', 'rather than a date worked out',
      'rather than the list, a count or a comparison', 'what the user has said about their own situation, likes, plans or past attempts',
      'Return them as one more JSON key, "needed": a list of short strings.']) expect(asked).toContain(words);
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
    // The read stays the default mode's; a second stage judges each kept message in the measured wording.
    expect(CHAT_MODES.answers).toMatchObject({ name: 'answers', questions: CHAT_MODES.default.questions, bar: CHAT_MODES.default.bar, needed: true,
      keep: { questions: MESSAGE_ANSWER_CASCADE, bar: { 'one decision': 0.59, 'everything said': 0.04 }, wholeMessages: true, hardFacts: true } });
    expect(MESSAGE_ANSWER_CASCADE.questions[0]!.instructions).toBe('Does this message state the answer to the task?');
    // The exchange form: the same two stages, each kind at its own bar, and the exchange around what the person said.
    expect(CHAT_MODES.exchange).toMatchObject({ name: 'exchange', questions: CHAT_MODES.default.questions,
      keep: { questions: MESSAGE_ANSWER_CASCADE, bar: 1, exchange: { nearest: 'paragraph' }, wholeMessages: true, hardFacts: true,
        barByKind: { 'person message': { 'one decision': 0.28, 'everything said': 0.04 }, 'agent step': 1,
          'tool output': { 'one decision': 0.81, 'everything said': 0.13 } }, exchangeBar: { 'one decision': 0.76, 'everything said': 0.04 } } });
    expect(parseSources({ sources: [{ type: 'claude-code', questions: 'exchange' }] }).sources[0].questions).toBe('exchange');
    expect(MESSAGE_ANSWER_CASCADE.facts!.question.instructions).toBe('Does this message state this: {fact}?');
    expect(CHAT_MODES.answers.read).toBe(CHAT_MODES.default.read);
  });
});

describe('a Markdown entry\'s question set and levers', () => {
  it('takes the narrow question in two and the levers that act on notes', () => {
    const parsed = parseSources({ sources: [{ type: 'markdown', path: '/notes', questions: 'answers',
      levers: { itemsPerRequest: 1, roles: true, choicePerFact: { candidates: 20 } } }] });
    expect(parsed.sources[0]).toMatchObject({ questions: 'answers', levers: { itemsPerRequest: 1, roles: true, choicePerFact: { candidates: 20 } } });
    expect(NOTE_MODES.answers).toMatchObject({ name: 'answers', questions: { ...ANSWER_CASCADE, combine: 'highest' }, needed: true, bar: 0.07 });
    expect(NOTE_MODES.answers.read).toBe(NOTE_MODES.default.read);
  });

  it('refuses the chat question sets, and takes whole messages and hard facts for notes written as a conversation', () => {
    expect(() => parseSources({ sources: [{ type: 'markdown', path: '/notes', questions: 'judgments' }] }))
      .toThrow('Unknown questions "judgments"; allowed names are default, answers.');
    expect(parseSources({ sources: [{ type: 'markdown', path: '/notes', levers: { wholeMessages: true, hardFacts: true } }] })
      .sources[0].levers).toEqual({ wholeMessages: true, hardFacts: true });
    expect(() => parseSources({ sources: [{ type: 'markdown', path: '/notes', levers: { readEverything: true } }] }))
      .toThrow('levers must be an object of booleans named wholeMessages, hardFacts, roles, choicePerFact;');
  });
});
