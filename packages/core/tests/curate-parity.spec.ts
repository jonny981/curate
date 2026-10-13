import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { curate, type CuratePrompt, type PickResult } from '../src/index.js';

const directory = new URL('./fixtures/curate/', import.meta.url);
const fixtures = readdirSync(directory).filter((file) => file.endsWith('.json')).map((file) => ({
  file,
  input: JSON.parse(readFileSync(new URL(file, directory), 'utf8')) as {
    task: string;
    picked: PickResult;
    prompts: { working: boolean; prompt: CuratePrompt }[];
  },
}));

describe('prototype curator prompt parity', () => {
  for (const { file, input } of fixtures) {
    for (const { working, prompt } of input.prompts) {
      it(`matches ${file} byte for byte with working=${working}`, async () => {
        const calls: CuratePrompt[] = [];
        await curate(input.task, input.picked, {
          working,
          write: async (received) => {
            calls.push(received);
            return `[2023-05-13] Stand-in observation (said 2023-05-20; ${input.picked.selected[0]!.id})`;
          },
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.instructions).toBe(prompt.instructions);
        expect(calls[0]!.body).toBe(prompt.body);
      });
    }
  }
});
