import type { PickCascade, PickTagSet } from '@curatejs/core';

/** Commit-kind tag set for `tagsByKind`: fix, feature or revert. A
 *  revert also counts as a correction for the displacement rule. */
export const GIT_HISTORY_TAGS: readonly PickTagSet[] = [
  {
    key: 'commit-kind',
    questions: [
      { key: 'fix', instructions: 'Does this commit fix a bug, defect or regression?',
        true: 'It fixes something broken.', false: 'It is not a fix.' },
      { key: 'feature', instructions: 'Does this commit add or change behaviour on purpose: a feature, refactor or improvement?',
        true: 'It adds or improves.', false: 'It is not a feature.' },
      { key: 'revert', instructions: 'Does this commit undo or roll back an earlier change?',
        true: 'It reverts an earlier change.', false: 'It is not a revert.' },
    ],
  },
];

/** Questions and fitted weights shared by commits and Markdown evidence. */
export const GIT_HISTORY_CASCADE: PickCascade = {
  bias: -1.791976206589222,
  questions: [
    {
      key: 'current',
      instructions: 'Does this item supply useful evidence, a constraint or a decision for this task?',
      true: 'It changes, explains or constrains the code, decisions or rules the task touches',
      false: 'It is about something else',
      weight: 0.2883556883703515,
    },
    {
      key: 'needed',
      instructions: 'Does the answer to this question, or the work this task asks for, depend on something this item says?',
      true: 'Without this item, the answer or the work would be missing a fact it needs',
      false: 'The answer or the work does not depend on anything here',
      weight: -0.11653353033164764,
    },
    {
      key: 'when',
      instructions: 'Does this item say when something the task asks about happened, or put such events in order?',
      true: 'It gives a time, a date or an order for something the task asks about',
      false: 'It gives no timing for what the task asks about',
      weight: 0.7033775909289888,
    },
    {
      key: 'offtopic',
      instructions: 'Is this item about a different subject that only shares some words with the task?',
      true: 'It is about a different subject',
      false: 'It is about the subject the task asks about',
      weight: -0.8565227256154501,
    },
  ],
};
