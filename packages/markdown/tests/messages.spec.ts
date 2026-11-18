import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseWhatsapp, whatsapp } from '../src/index.js';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });
async function folder(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), 'curate-messages-'));
  folders.push(made);
  return made;
}

describe('a WhatsApp chat export', () => {
  it('reads the iOS lines: a bracketed date and time with seconds, a sender, and lines that continue a message', () => {
    const text = [
      '[13/05/2023, 14:02:51] Messages and calls are end-to-end encrypted.',
      '[13/05/2023, 14:03:10] Caroline: Hey Mel!',
      'How was the trip?',
      '[14/05/2023, 09:00:00] Melanie: ‎Great, thanks.',
      // The export ends with a line break, which is not part of the last message.
      '',
    ].join('\n');
    expect(parseWhatsapp(text).messages).toEqual([
      { day: '2023-05-13', time: Date.UTC(2023, 4, 13, 14, 3, 10), sender: 'Caroline', text: 'Hey Mel!\nHow was the trip?' },
      { day: '2023-05-14', time: Date.UTC(2023, 4, 14, 9, 0, 0), sender: 'Melanie', text: '‎Great, thanks.' },
    ]);
  });

  it('reads the Android lines: a dash after the time, a 12-hour clock, and dates with dots or two-digit years', () => {
    const text = ['5/13/23, 2:03 PM - Caroline: Hey Mel!', '5/14/23, 12:15 AM - Melanie: Late one.', '13.05.23, 09:30 - Caroline: Morning.'].join('\n');
    // The second number over 12 says the export writes the month first.
    const android = parseWhatsapp(text.split('\n').slice(0, 2).join('\n'));
    expect(android.messages.map(({ day, time }) => [day, time])).toEqual([
      ['2023-05-13', Date.UTC(2023, 4, 13, 14, 3)], ['2023-05-14', Date.UTC(2023, 4, 14, 0, 15)]]);
    expect(android).toMatchObject({ dates: 'month-first', settled: true });
    expect(parseWhatsapp(text.split('\n')[2]!).messages[0]).toMatchObject({ day: '2023-05-13', sender: 'Caroline', text: 'Morning.' });
    // An ambiguous date reads as the caller says.
    expect(parseWhatsapp('03/04/2023, 10:00 - A: hi', 'month-first')).toMatchObject({ messages: [{ day: '2023-03-04' }], dates: 'month-first', settled: true });
  });

  it('settles the order of day and month from the order of the dates, and says when nothing in the export settles it', () => {
    // Read day first these dates would go back from May to January.
    const us = parseWhatsapp(['3/4/23, 2:01 PM - Sam: one', '3/5/23, 9:12 AM - Ann: two', '4/1/23, 6:40 PM - Sam: three'].join('\n'));
    expect(us).toMatchObject({ dates: 'month-first', settled: true });
    expect(us.messages.map((message) => message.day)).toEqual(['2023-03-04', '2023-03-05', '2023-04-01']);
    // One date: a 12-hour clock with a two-digit year is how a month-first export writes it, but nothing settles it.
    expect(parseWhatsapp('3/4/23, 2:01 PM - Sam: one')).toMatchObject({ messages: [{ day: '2023-03-04' }], dates: 'month-first', settled: false });
    expect(parseWhatsapp('[03/04/2023, 14:01:00] Sam: one')).toMatchObject({ messages: [{ day: '2023-04-03' }], dates: 'day-first', settled: false });
    expect(parseWhatsapp('[03/04/2023, 14:01:00] Sam: one', 'day-first')).toMatchObject({ settled: true });
  });

  it('takes a sender from the names the export uses, longest first, not from the first colon', () => {
    const text = [
      '12/05/2023, 09:00 - Dr: Jones: the ferry leaves at ten.',
      '12/05/2023, 09:01 - Sam: Note: bring the tickets.',
      '12/05/2023, 09:02 - Dr: Jones: I will.',
      '12/05/2023, 09:03 - Alice changed the subject to "meet: at the ferry"',
      '12/05/2023, 09:04 - Sam: See you there.',
    ].join('\n');
    const { messages } = parseWhatsapp(text);
    expect(messages.map(({ sender, text: said }) => [sender, said])).toEqual([
      ['Dr: Jones', 'the ferry leaves at ten.'], ['Sam', 'Note: bring the tickets.'], ['Dr: Jones', 'I will.'], ['Sam', 'See you there.'],
    ]);
  });

  it('keeps a pasted line that looks like a message, and the line after it, inside the message they were pasted into', () => {
    const text = [
      '14/05/2023, 10:00 - Sam: Remember what you wrote:',
      '13/05/2023, 14:02 - don\'t be late',
      'and bring the map.',
      '14/05/2023, 10:05 - Ann: I will.',
    ].join('\n');
    expect(parseWhatsapp(text).messages.map(({ sender, text: said }) => [sender, said])).toEqual([
      ['Sam', 'Remember what you wrote:\n13/05/2023, 14:02 - don\'t be late\nand bring the map.'], ['Ann', 'I will.'],
    ]);
  });

  it('keeps each day as one session note, read through the Markdown reader, with both senders named on every part', async () => {
    const root = await folder();
    const file = join(root, '_chat.txt');
    const directory = join(root, 'notes');
    await writeFile(file, [
      '[08/05/2023, 13:56:00] Caroline: Hey Mel! Good to see you!',
      '[08/05/2023, 13:56:01] Melanie: # Hey Caroline!',
      '[25/05/2023, 10:00:00] Caroline: I went to the support group.',
    ].join('\n'));
    const source = whatsapp(file, { directory });
    expect(source).toMatchObject({ id: `whatsapp:${file}`, kind: 'markdown', role: 'reference', names: true, paths: [file] });
    expect(source.mode?.name).toBe('direct-messages');
    const result = await source.read({ task: 'support group', wholeLanes: true });
    if (result.status !== 'read') throw new Error('Expected a read');
    const [notes] = await readdir(directory);
    const sessions = join(directory, notes!);
    expect((await readdir(sessions)).sort()).toEqual(['session-001.md', 'session-002.md']);
    expect(await readFile(join(sessions, 'session-001.md'), 'utf8')).toBe('---\ndate: 2023-05-08\n---\n# session session-001\n\nDate: 2023-05-08\n\n'
      + 'Caroline: Hey Mel! Good to see you!\n\nMelanie:  Hey Caroline!\n');
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.every((part) => part.sourceId === `whatsapp:${file}`)).toBe(true);
    expect(result.candidates[0]!.speakers).toEqual(['Caroline', 'Melanie']);
    // A day the export no longer holds leaves no note.
    await writeFile(file, '[08/05/2023, 13:56:00] Caroline: Hey Mel! Good to see you!\n');
    await whatsapp(file, { directory }).read({ task: 'support group', wholeLanes: true });
    expect(await readdir(sessions)).toEqual(['session-001.md']);
  });

  it('names the sender on each piece of a message the notes reader cuts, and says when the dates leave the order open', async () => {
    const root = await folder();
    const file = join(root, '_chat.txt');
    const long = Array.from({ length: 40 }, (_, n) => `Word${n} of a long message about the ferry timetable.`).join(' ');
    await writeFile(file, [`[08/05/2023, 13:56:00] Sam: ${long}`, '[08/05/2023, 13:57:00] Ann: Short reply.'].join('\n'));
    const result = await whatsapp(file, { directory: join(root, 'notes') }).read({ task: 'ferry', wholeLanes: true });
    if (result.status !== 'read') throw new Error('Expected a read');
    // Past the note's heading, every piece opens with the sender of the line it starts in.
    const pieces = result.candidates.filter((part) => !part.text.trimStart().startsWith('# session'));
    expect(pieces.length).toBeGreaterThan(2);
    for (const piece of pieces) expect(piece.text.trimStart()).toMatch(/^(Sam|Ann): /);
    // Both numbers of 08/05 are 12 or under, and one day holds no order of dates to settle it.
    expect(result).toMatchObject({ complete: false, partial: expect.stringContaining('day first') });
    const said = await whatsapp(file, { directory: join(root, 'notes'), dates: 'day-first' }).read({ task: 'ferry', wholeLanes: true });
    expect(said).toMatchObject({ status: 'read', complete: true });
    expect(said).not.toHaveProperty('partial');
  });

  it('is absent when the export is missing', async () => {
    const root = await folder();
    expect(await whatsapp(join(root, 'none.txt'), { directory: join(root, 'notes') }).read({ task: 'x' }))
      .toEqual({ status: 'absent', reason: 'no-whatsapp-export' });
  });
});
