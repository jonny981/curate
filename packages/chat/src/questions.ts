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

/** Coding-agent transcripts use relevance and needed evidence without
 *  treating a person's own situation as a selection signal. */
export const AGENT_CHAT_CASCADE: PickCascade = {
  ...CHAT_CASCADE,
  questions: CHAT_CASCADE.questions.filter((question) => question.key !== 'own'),
};

/** Questions and fitted weights for histories of a person's own life:
 *  events, purchases, people, ages, places and numbers. Not `chat()`'s
 *  default, whose main input is coding-agent transcripts: a clear "no"
 *  on `personal_fact` settles a part without asking the rest. */
export const PERSONAL_CHAT_CASCADE: PickCascade = {
  bias: -1.2246,
  first: 'personal_fact',
  band: [0.1, 0.9],
  firstOnly: { bias: -1.9052, weight: 2.0426 },
  questions: [
    {
      key: 'personal_fact',
      instructions: 'Does the user say something here about their own life (an event, a purchase, a person, an age, a place or a number) that bears on what the task asks?',
      true: 'The user states a personal fact the task needs',
      false: 'Nothing the user says here bears on the task',
      weight: 0.9222,
    },
    {
      key: 'needed',
      instructions: 'Does the answer to this question, or the work this task asks for, depend on something this item says?',
      true: 'Without this item, the answer or the work would be missing a fact it needs',
      false: 'The answer or the work does not depend on anything here',
      weight: 0.5728,
    },
    {
      key: 'aside',
      instructions: 'Does this item mention, even in passing, a fact about the person that the task asks about, even when the conversation is mostly about something else?',
      true: 'It mentions such a fact, even as an aside',
      false: 'It mentions nothing the task asks about',
      weight: 0.5201,
    },
    {
      key: 'preference',
      instructions: 'Does this item show a preference, opinion, habit or limit of the person or team that should shape the answer or the work?',
      true: 'It shows such a preference, habit or limit that bears on the task',
      false: 'It shows nothing of the kind that bears on the task',
      weight: 0.1001,
    },
  ],
};

/** The same questions, fitted together with two to four questions
 *  written for each task and a question asked once per name the task
 *  names. Use it with `writeQuestions`, for example
 *  `taskQuestionWriter(write)`; a pick without one throws. */
export const PERSONAL_CHAT_WRITTEN_CASCADE: PickCascade = {
  bias: -2.405528458290732,
  first: 'personal_fact',
  band: [0.1, 0.9],
  firstOnly: { bias: -1.9052235580885941, weight: 2.04264388982124 },
  questions: [
    { ...PERSONAL_CHAT_CASCADE.questions[0]!, weight: 0.7538853838718605 },
    { ...PERSONAL_CHAT_CASCADE.questions[1]!, weight: 0.07869996707893219 },
    { ...PERSONAL_CHAT_CASCADE.questions[2]!, weight: 0.5153881946025891 },
    { ...PERSONAL_CHAT_CASCADE.questions[3]!, weight: 0.130222278825567 },
  ],
  written: { highest: 0.4235428027761504, second: 0.18564016475115125 },
  named: {
    question: {
      key: 'name',
      instructions: 'Does this part mention {name}?',
      true: 'The part names {name}, or refers to it in a way that can only mean {name}',
      false: 'The part does not name {name} or clearly refer to it, even if it is about the same topic',
    },
    highest: 0.1655479793453193,
    hasNames: -0.1646894012324575,
  },
};
