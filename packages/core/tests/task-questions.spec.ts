import { describe, expect, it } from 'vitest';

import { TASK_QUESTION_PROMPT, taskQuestionWriter, type CuratePrompt } from '../src/index.js';

describe('taskQuestionWriter', () => {
  it('sends the prompt with the task and keys the parsed questions task1 to task3', async () => {
    const prompts: CuratePrompt[] = [];
    const reply = [
      { instructions: 'Does this part name a trip?', true: 'It names one', false: 'It names none' },
      { instructions: 'Does this part give a date for a trip?', true: 'It gives one', false: 'It gives none' },
      { instructions: 'Does the user book a trip here?', true: 'The user books one', false: 'No booking' },
    ];
    const write = async (prompt: CuratePrompt) => {
      prompts.push(prompt);
      return `Here are the questions:\n${JSON.stringify(reply)}`;
    };
    const task = 'How many trips did I take this year?';
    const questions = await taskQuestionWriter(write)(task);
    expect(questions).toEqual(reply.map((q, i) => ({ key: `task${i + 1}`, ...q })));
    expect(prompts).toHaveLength(1);
    const sent = `${prompts[0]!.instructions}\n${prompts[0]!.body}`;
    expect(sent).toContain(TASK_QUESTION_PROMPT);
    expect(sent).toContain(task);
  });
});
