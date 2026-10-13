import type { PickCascade } from '@curatejs/core';

/** Questions and fitted weights for chat evidence. */
export const CHAT_CASCADE: PickCascade = {
  bias: -1.7305,
  first: 'relevant',
  band: [0.1, 0.9],
  firstOnly: { bias: -0.6674, weight: 1.2882 },
  questions: [
    {
      key: 'relevant',
      instructions: 'Does this item supply useful evidence, a constraint or a decision for this task?',
      true: 'It changes, explains or constrains the code, decisions or rules the task touches',
      false: 'It is about something else',
      weight: 0.7031,
    },
    {
      key: 'own',
      instructions: 'Is this the person or team speaking about their own life, work or decisions, as opposed to general advice or information?',
      true: 'It is about their own situation',
      false: 'It is general advice or information',
      weight: 0.8588,
    },
    {
      key: 'needed',
      instructions: 'Does the answer to this question, or the work this task asks for, depend on something this item says?',
      true: 'Without this item, the answer or the work would be missing a fact it needs',
      false: 'The answer or the work does not depend on anything here',
      weight: 0.5134,
    },
  ],
};
