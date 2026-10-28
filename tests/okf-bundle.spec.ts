import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { knowledgeBase, markdown, MARKDOWN_KEYWORD_SETTINGS } from '@curatejs/markdown';
import type { CandidateReadRequest, CandidateSource, MemoryCandidate } from '@curatejs/core';

const BUNDLE = join(__dirname, 'fixtures/okf-bundle');
const time = { taskDate: '2026-10-28', timeZone: 'UTC' };

/** Every part the reader gives, uncut, with no task words. */
async function read(source: CandidateSource, extra: Partial<CandidateReadRequest> = {}): Promise<readonly MemoryCandidate[]> {
  const result = await source.read({ task: '', wholeLanes: true, ...time, ...extra });
  if (result.status !== 'read') throw new Error('Expected a read.');
  return result.candidates;
}
const of = (parts: readonly MemoryCandidate[], page: string) => parts.filter((part) => part.id.startsWith(`${page}#`));
const dates = (parts: readonly MemoryCandidate[], page: string) => [...new Set(of(parts, page).map((part) => JSON.stringify(part.date)))]
  .map((date) => JSON.parse(date) as MemoryCandidate['date']);

describe('knowledgeBase() reads an Open Knowledge Format bundle', () => {
  it('dates a v0.1 page by its timestamp', async () => {
    const parts = await read(knowledgeBase(BUNDLE));
    expect(of(parts, 'decisions/use-postgres.md').length).toBeGreaterThan(0);
    expect(dates(parts, 'decisions/use-postgres.md')).toEqual([{ value: '2026-05-28T14:30:00Z', meaning: 'changed' }]);
  });

  it('dates a v0.2 page by generated.at, in block and flow form, ahead of timestamp', async () => {
    const parts = await read(knowledgeBase(BUNDLE));
    const at = [{ value: '2026-06-30T14:00:00Z', meaning: 'changed' }];
    expect(dates(parts, 'concepts/generated-block.md')).toEqual(at);
    expect(dates(parts, 'concepts/generated-flow.md')).toEqual(at);
    expect(dates(parts, 'concepts/both.md')).toEqual(at);
  });

  it('counts a link written from the bundle root', async () => {
    const parts = await read(knowledgeBase(BUNDLE));
    expect(of(parts, 'tables/b.md')[0]!.signals['inbound-links']).toBeGreaterThan(0);
  });

  it("puts the page's title, type and description in every part title", async () => {
    const parts = await read(knowledgeBase(BUNDLE));
    const titled = of(parts, 'decisions/use-postgres.md');
    expect(titled.length).toBe(2);
    for (const part of titled) {
      expect(part.title.startsWith('decisions/use-postgres.md')).toBe(true);
      for (const value of ['Use Postgres for billing', 'decision', 'Why billing writes invoices to Postgres.']) {
        expect(part.title).toContain(value);
      }
    }
    expect(of(parts, 'notes/colon.md')[0]!.title).toContain('Plans: the next step');
  });

  it('keeps the part title of a page with none of the three', async () => {
    const parts = await read(knowledgeBase(BUNDLE));
    expect(of(parts, 'notes/plain.md').map((part) => part.title)).toEqual(['notes/plain.md: Plain']);
  });

  it('reads index.md as no page', async () => {
    const parts = await read(knowledgeBase(BUNDLE));
    expect(of(parts, 'index.md')).toEqual([]);
    expect(of(parts, 'tables/orders.md')[0]!.signals['inbound-links']).toBeUndefined();
  });

  it('still reads index.md as a page in markdown()', async () => {
    const parts = await read(markdown({ paths: [BUNDLE], kind: 'docs' }));
    expect(parts.some((part) => part.id.startsWith(join(BUNDLE, 'index.md#')))).toBe(true);
  });

  it("dates each log entry by its heading, and the rest of the log by the page's date", async () => {
    const parts = await read(knowledgeBase(BUNDLE));
    const log = of(parts, 'log.md');
    const dated = (heading: string) => log.find((part) => part.title.includes(heading))!.date;
    expect(dated('[2026-10-28 19:40:00] ingest | Accounts')).toEqual({ value: '2026-10-28', meaning: 'recorded' });
    expect(dated('[2026-10-28] update | Orders table')).toEqual({ value: '2026-10-28', meaning: 'recorded' });
    expect(dated('2026-10-27')).toEqual({ value: '2026-10-27', meaning: 'recorded' });
    expect(dated('How to read this log')).toEqual({ value: '2026-10-01T00:00:00Z', meaning: 'changed' });

    const period = { from: '2026-10-27T00:00:00.000+00:00', to: '2026-10-27T23:59:59.999+00:00' };
    const inPeriod = of(await read(knowledgeBase(BUNDLE), { taskPeriod: period }), 'log.md');
    expect(inPeriod.map((part) => part.title)).toEqual([log.find((part) => part.title.includes('2026-10-27'))!.title]);
  });

  it('ranks a page past its stale_after as a replaced page', async () => {
    const parts = await read(knowledgeBase(BUNDLE));
    expect(of(parts, 'runbooks/stale.md')[0]!.signals['replaced']).toBe(MARKDOWN_KEYWORD_SETTINGS.replacedWeight);
    expect(of(parts, 'runbooks/fresh.md')[0]!.signals['replaced']).toBeUndefined();
  });
});

describe('the reader keeps what it read before', () => {
  it('reads the other fields and the date of a page whose title has an unquoted colon', async () => {
    const parts = await read(knowledgeBase(BUNDLE));
    expect(dates(parts, 'notes/colon.md')).toEqual([{ value: '2026-03-01', meaning: 'recorded' }]);
  });

  it('ignores updated in knowledgeBase()', async () => {
    const parts = await read(knowledgeBase(BUNDLE));
    const [date] = dates(parts, 'notes/updated-only.md');
    expect(date).not.toEqual({ value: '2026-01-01', meaning: 'changed' });
    expect(['changed', 'modified']).toContain(date!.meaning);
  });
});
