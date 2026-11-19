import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { curate, pick, type MemoryCandidate, type Mode, type PickBatch, type PickDecide } from '@curatejs/core';
import { knowledgeBase } from '../src/index.js';
import { conversationTurns } from '../src/index.js';
import { splitParts, turnParts } from '../src/markdown.js';
import { notes } from '../src/mode.js';

/** A session written as a note, as a conversation export writes one: a
 *  dated preamble, then each turn a paragraph opened by its speaker. */
const session = (turns: readonly (readonly [string, string])[]) =>
  `---\ndate: 2026-03-02\n---\n# session one\n\nDate: 2026-03-02\n\n${turns.map(([who, said]) => `${who}: ${said}`).join('\n\n')}\n`;
const long = (words: string) => Array.from({ length: 6 }, (_, line) => `${words} line ${line + 1}.`).join('\n');
const talk = [
  ['user', 'Which bread did I bake for the office party?'],
  ['assistant', `Let me think about bakes that travel well.\n${long('A note on sourdough')}`],
  ['user', 'I baked a rye loaf with caraway, it went down well.'],
  ['assistant', 'Rye with caraway is a fine choice for a crowd.'],
] as const;

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });
async function notesFolder(files: Record<string, string>): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'curate-turns-'));
  folders.push(folder);
  await Promise.all(Object.entries(files).map(([name, text]) => writeFile(join(folder, name), text)));
  return folder;
}
const readAll = async (folder: string, turns: boolean) => {
  const result = await knowledgeBase(folder, { index: false, maxQuestionText: 120, ...(turns ? { turns } : {}) })
    .read({ task: 'Which bread did I bake for the office party?' });
  if (result.status !== 'read') throw new Error(result.status);
  return [...result.candidates].sort((left, right) => left.id.localeCompare(right.id, 'en', { numeric: true }));
};

describe('notes written as a conversation', () => {
  it('finds the turns by the speakers that open its paragraphs, and leaves an ordinary note alone', () => {
    const text = session(talk);
    expect(conversationTurns(text)?.map(({ speaker }) => speaker)).toEqual(['user', 'assistant', 'user', 'assistant']);
    // A short exchange: each speaker opens one paragraph; the preamble's "Date" is no speaker.
    expect(conversationTurns(session(talk.slice(0, 2)))?.map(({ speaker }) => speaker)).toEqual(['user', 'assistant']);
    expect(conversationTurns('# Setup\n\nInstall the tool.\n\nNote: it needs Node 22.\n\nRun it.\n')).toBeUndefined();
  });

  it('cuts a conversation at each turn, then each turn to the part size, so no part holds two turns', () => {
    const text = session(talk);
    const parts = turnParts(text, 120);
    expect(parts.join('')).toBe(text);
    // The first turn opens with what comes before its speaker, so only later turns are boundaries.
    const turns = conversationTurns(text)!.slice(1);
    let at = 0;
    for (const part of parts) {
      expect(turns.filter((turn) => turn.at > at && turn.at < at + part.length)).toEqual([]);
      at += part.length;
    }
    // An ordinary section is cut as before.
    expect(turnParts('Install the tool.\nRun it.\n', 10)).toEqual(splitParts('Install the tool.\nRun it.\n', 10));
  });

  it('marks each part with its turn: speaker, whole text, number, pieces and the turns either side', async () => {
    const parts = await readAll(await notesFolder({ 'session-001.md': session(talk) }), true);
    const reply = parts.find((part) => part.text.startsWith('user: I baked a rye loaf'))!;
    expect(reply.turn).toEqual({ speaker: 'user', session: 'session-001.md', position: 3, pieces: 1,
      text: 'user: I baked a rye loaf with caraway, it went down well.',
      before: { id: expect.any(String), text: expect.stringMatching(/^assistant: Let me think about bakes[\s\S]*line 6\.$/) },
      after: { id: expect.any(String), text: 'assistant: Rye with caraway is a fine choice for a crowd.' } });
    expect(reply.place).toEqual({ container: reply.contentRef, at: [3, 1, 1] });
    // The long assistant turn is cut into pieces that each know the whole turn.
    const pieces = parts.filter((part) => part.turn?.position === 2);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((part) => part.turn!.pieces === pieces.length && part.turn!.text === pieces.map((piece) => piece.text).join('').trimEnd())).toBe(true);
    // What comes before the first speaker opens the first turn: no part stands alone on a date line.
    expect(parts.every((part) => part.turn !== undefined)).toBe(true);
    const first = parts.filter((part) => part.turn!.position === 1);
    expect(first[0]!.turn!.text).toMatch(/^# session one\n\nDate: 2026-03-02\n\nuser: Which bread did I bake for the office party\?$/);
  });

  it('reads every note exactly as before when the setting is off, and ordinary notes alike with it on', async () => {
    const folder = await notesFolder({ 'session-001.md': session(talk), 'guide.md': '# Setup\n\nInstall the tool.\n\nRun it.\n' });
    const off = await readAll(folder, false);
    expect(off.some((part) => part.turn !== undefined || part.place !== undefined)).toBe(false);
    const fresh = await readAll(await notesFolder({ 'session-001.md': session(talk), 'guide.md': '# Setup\n\nInstall the tool.\n\nRun it.\n' }), false);
    expect(off.map(({ id, text }) => [id, text])).toEqual(fresh.map(({ id, text }) => [id, text]));
    const on = await readAll(folder, true);
    expect(on.filter((part) => part.id.startsWith('guide.md')).map(({ id, text, turn }) => [id, text, turn]))
      .toEqual(off.filter((part) => part.id.startsWith('guide.md')).map(({ id, text }) => [id, text, undefined]));
  });

  it('judges each turn whole and alone, with its speaker and the turns either side, and lays it out once', async () => {
    const parts = await readAll(await notesFolder({ 'session-001.md': session(talk) }), true);
    const requests: PickBatch[] = [];
    const decide: PickDecide = async (batch) => {
      requests.push(batch);
      return Object.fromEntries(batch.questions.map((question) => [question.key, { status: 'answered', probability: 0.9 }]));
    };
    const mode: Mode = { ...notes, wholeMessages: true, hardFacts: true, itemsPerRequest: 1 };
    // The search found only the long turn's first piece: the turn still goes, and is laid out, whole.
    const firstPiece = parts.find((part) => part.turn?.position === 2)!;
    const candidates: MemoryCandidate[] = parts.filter((part) => part.turn?.position !== 2 || part === firstPiece)
      .map((part) => ({ ...part, searchRanks: [0] }));
    const picked = await pick(candidates, { task: 'Which bread did I bake for the office party?', decide, everyRanked: true, everyScored: true,
      modesBySource: { [parts[0]!.sourceId]: mode } });
    expect(requests.every((request) => request.alone === true)).toBe(true);
    const items = requests.flatMap((request) => request.questions).filter((question, index, all) => all.findIndex((other) => other.id === question.id) === index);
    const long = items.filter((question) => question.text.startsWith('assistant: Let me think'));
    expect(long).toHaveLength(1);
    expect(long[0]!.text).toContain('line 6.');
    expect(items.find((question) => question.text.startsWith('user: I baked'))!.facts).toMatchObject({
      author: 'user', session: 'session-001.md', position: 3, pieces: 1,
      replies_to: { text: expect.stringMatching(/^assistant: Let me think/) },
      answered_by: { text: 'assistant: Rye with caraway is a fine choice for a crowd.' } });
    const text = (await curate('Which bread did I bake for the office party?', picked)).log;
    expect(text.split('assistant: Let me think').length).toBe(2);
    expect(text).toContain('A note on sourdough line 6.');
  });
});
