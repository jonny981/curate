import { describe, expect, it } from 'vitest';
import { classifyTask, taskNames } from '../src/index.js';

describe('task words', () => {
  it.each([
    ['How many engineers did I lead? How many do I lead now?', ['count']],
    ['List every trip before June.', ['count', 'date']],
    ['How many days between my first and last visits?', ['count', 'date']],
    ['How long ago did I move?', ['date']],
    ['How much did I spend?', ['count']],
    ['What should I cook? Suggest a recipe.', ['advice']],
    ['Is another trip a good idea?', ['advice']],
    ['What is my current address?', ['other']],
    ['Is my sister\'s name still Anna?', ['named']],
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

describe('taskNames', () => {
  it.each([
    ['Who graduated first among Emma, Rachel and Alex?', ['Emma', 'Rachel', 'Alex']],
    ['What did I think of "The Nightingale"?', ['The Nightingale']],
    ['What did I post under #gardening?', ['#gardening']],
    ['When did I last see Dr. Johnson?', ['Dr. Johnson']],
    ['How often did I go to St. Mary\'s Church?', ['St. Mary\'s Church']],
    ['How many books did I read in March?', []],
    ['Book Lovers Unite meets on Tuesday. When did I join?', ['Book Lovers Unite']],
    ['Which book did I finish?', []],
    ['Yesterday I joined a club. Which one?', []],
  ] as const)('finds the names in %s', (task, names) => {
    expect(taskNames(task)).toEqual(names);
    expect(taskNames(`${task} (asked 2023/05/22 (Mon) 12:00)`)).toEqual(names);
  });

  it.each([
    'Who graduated first among Emma, Rachel and Alex?', 'How many books did I read in March?',
    'Book Lovers Unite meets on Tuesday. When did I join?', 'Which book did I finish?', 'What is my current address?',
    'What did I say about #gardening?', 'Is my sister\'s name still Anna?',
  ])('classifyTask says named exactly when taskNames finds a name: %s', (task) => {
    expect(classifyTask(task).includes('named')).toBe(taskNames(task).length > 0);
  });
});
