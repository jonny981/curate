import { describe, expect, it } from 'vitest';
import { classifyTask } from '../src/index.js';

describe('task words', () => {
  it.each([
    ['How many engineers did I lead? How many do I lead now?', ['count', 'changed']],
    ['List every trip before June.', ['count', 'date']],
    ['How many days between my first and last visits?', ['count', 'date']],
    ['How long ago did I move?', ['date']],
    ['How much did I spend?', ['count']],
    ['What should I cook? Suggest a recipe.', ['advice']],
    ['Is another trip a good idea?', ['advice']],
    ['What is my current address?', ['changed']],
    ['What did Alice recommend?', ['advice', 'named']],
    ['What was the name of “Little Women”?', ['named']],
    ['What did I say about #gardening?', ['named']],
    ['What did I eat on Monday in June?', ['other']],
    ['What was the price?', ['other']],
  ] as const)('classifies %s without outside data', (task, kinds) => {
    expect(classifyTask(task)).toEqual(kinds);
    expect(classifyTask(`${task} (asked 2023/05/22 (Mon) 12:00)`)).toEqual(kinds);
  });
});
