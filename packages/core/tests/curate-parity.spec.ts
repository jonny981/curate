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
      it(`matches ${file} except fixed character caps, score rounding and the short-id edits with working=${working}`, async () => {
        const calls: CuratePrompt[] = [];
        const result = await curate(input.task, input.picked, {
          working,
          write: async (received) => {
            calls.push(received);
            return '[2023-05-13] Stand-in observation (said 2023-05-20; E1)';
          },
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.instructions).toBe(prompt.instructions
          .replace('At most 3500 characters.\n', '')
          .replace(' Keep the log and the working together within 3500 characters.', '')
          .replaceAll('the full item id from its header', 'the item id from its header')
          .replace('with its date and id', 'with its date and the item ids in brackets')
          .replace('- Include what the assistant said only when the task asks about it.\n', '- Include what the assistant said only when the task asks about it.\n- If no evidence bears on the task, return an empty reply: no lines, and no note that nothing was found.\n'));
        let body = prompt.body;
        for (const [index, item] of result.record.items.entries()) {
          const entry = input.picked.record.candidates.find((candidate) => candidate.sourceId === item.candidate.sourceId && candidate.id === item.candidate.id)!;
          const weight = entry.status === 'selected' ? entry.probability! : 0;
          const date = item.candidate.date ? `${item.candidate.date.value}, ` : '';
          body = body.replace(`### ${item.id} (${date}${weight.toFixed(2)}):`, `### E${index + 1} (${date}${weight}):`);
        }
        expect(calls[0]!.body).toBe(body);
      });
    }
  }
});
