import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LABEL_KINDS, curate, historySource, pick, pickFromSources,
  type CandidateReadRequest, type CandidateSource, type HistorySettings, type MemoryCandidate,
  type PickDecide, type PickQuestion, type PickRecord, type PickResult,
} from '../src/index.js';
import { decide, fixtureSource, parts, task } from './fixtures/source-settings.js';

// Each source's settings as the settings-by-source baseline ran them, written out in full.
const chatSettings: HistorySettings = { rare: false, labels: false, bar: 0.0146 };
const gitSettings: HistorySettings = { rare: true, labels: false, bar: 0.0146 };
const markdownSettings: HistorySettings = { rare: true, labels: false, bar: 0.0146 };

const chat = (settings: Partial<HistorySettings> = {}, pool = parts('chat', 'chatword')) =>
  historySource({ reader: fixtureSource('chat', pool, { rare: false }), ...chatSettings, ...settings });
const git = (settings: Partial<HistorySettings> = {}, pool = parts('git', 'gitword')) =>
  historySource({ reader: fixtureSource('git', pool, { rare: false }), ...gitSettings, ...settings });
const markdown = (settings: Partial<HistorySettings> = {}, pool = parts('markdown', 'noteword')) =>
  historySource({ reader: fixtureSource('markdown', pool, { rare: false }), ...markdownSettings, ...settings });

// A fresh label store for every pick.
let cache: string;
beforeEach(() => { cache = mkdtempSync(join(tmpdir(), 'curate-setting-effects-')); vi.stubEnv('XDG_CACHE_HOME', cache); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(cache, { recursive: true, force: true }); });

const effect = (record: PickRecord, setting: string, source: string) =>
  record.effects.find((entry) => entry.setting === setting && entry.source === source);
const selectedFrom = (picked: PickResult, sourceId: string) =>
  picked.selected.filter((candidate) => candidate.sourceId === sourceId);
const fixed = (probability: (question: PickQuestion) => number): PickDecide => async ({ questions }) =>
  Object.fromEntries(questions.map((q) => [q.key, { status: 'answered', probability: probability(q) }]));
const part = (sourceId: string, id: string, fields: Partial<MemoryCandidate> = {}): MemoryCandidate => ({
  sourceId, id, title: id, text: `deploy billing ${id}`, role: 'reference', signals: { keyword: 1 }, ...fields,
});

describe('the record says what each pick setting did', () => {
  it('labels on every part a direct pick decides add no part', async () => {
    const picked = await pick(parts('chat', 'chatword'), { task, decide, labelKindsBySource: { chat: LABEL_KINDS } });
    expect(effect(picked.record, 'labels', 'chat')).toEqual({
      setting: 'labels',
      source: 'chat',
      actedOn: 400,
      added: 0,
      dropped: 0,
      summary: 'labels on chat at the label bar 0.5: labelled 400 parts, but every part was already going to the decide step, so labels added none. It added no part.',
    });
  });

  it('labels count the kept parts only the label lane brought in', async () => {
    const picked = await pickFromSources([chat({ labels: true })], { task }, { task, decide });
    expect(effect(picked.record, 'labels', 'chat')).toEqual({
      setting: 'labels',
      source: 'chat',
      actedOn: 400,
      added: 56,
      dropped: 0,
      summary: 'labels on chat at the label bar 0.5: labelled 400 parts; 70 reached the decide step only through the label lane, and 56 of them were kept.',
    });
  });

  describe('rare', () => {
    it.each([
      ['git', () => git(), 1],
      ['markdown', () => markdown(), 5],
    ] as const)('counts the parts the round added on %s', async (id, source, added) => {
      const picked = await pickFromSources([source()], { task }, { task, decide });
      const rare = picked.record.pick!.rare!;
      expect(effect(picked.record, 'rare', id)).toMatchObject({
        actedOn: rare.pulled.filter((entry) => entry.sourceId === id).length, added, dropped: 0,
      });
      expect(selectedFrom(picked, id).filter((c) => Number(c.id.split('#')[1]) >= 60)).toHaveLength(added);
      expect(picked.record.effects.filter((entry) => entry.setting === 'rare')
        .reduce((sum, entry) => sum + entry.added, 0)).toBe(rare.added);
    });

    it('says no pulled part cleared the rare bar when every part was already decided', async () => {
      const picked = await pickFromSources([git()], { task, wholeLanes: true }, { task, decide });
      const entry = effect(picked.record, 'rare', 'git')!;
      expect(entry.actedOn).toBeGreaterThan(0);
      expect(entry).toMatchObject({ added: 0, dropped: 0 });
      expect(entry.summary).toBe(`rare on git: pulled in ${entry.actedOn} parts, but none answered at or above the rare bar 0.0146, so the round added none. It added no part.`);
    });

    it('sums each source\'s added count to the round\'s total', async () => {
      const picked = await pickFromSources([git(), markdown()], { task }, { task, decide });
      const entries = picked.record.effects.filter((entry) => entry.setting === 'rare');
      expect(entries.map((entry) => entry.source)).toEqual(['git', 'markdown']);
      expect(entries.reduce((sum, entry) => sum + entry.added, 0)).toBe(picked.record.pick!.rare!.added);
      expect(entries.reduce((sum, entry) => sum + entry.actedOn, 0)).toBe(picked.record.pick!.rare!.pulled.length);
    });
  });

  describe('bar', () => {
    it('counts the scored parts the bar kept out', async () => {
      const picked = await pickFromSources([chat()], { task }, { task, decide });
      expect(effect(picked.record, 'bar', 'chat')).toEqual({
        setting: 'bar', source: 'chat', actedOn: 60, added: 0, dropped: 9,
        summary: 'bar on chat: of 60 scored parts, 9 fell below the bar 0.0146 and no later pass kept them.',
      });
    });

    it('says when no scored part fell below the bar', async () => {
      const picked = await pickFromSources([chat({ bar: 0 })], { task }, { task, decide });
      expect(effect(picked.record, 'bar', 'chat')).toEqual({
        setting: 'bar', source: 'chat', actedOn: 60, added: 0, dropped: 0,
        summary: 'bar on chat: no scored part of 60 fell below the bar 0, so the bar kept out none. It kept out no part.',
      });
    });

    it('gives everyScored in place of each source\'s bar when the call sets it', async () => {
      const cut = await pickFromSources([chat()], { task }, { task, decide, everyScored: { bar: 0.5 } });
      expect(effect(cut.record, 'bar', 'chat')).toBeUndefined();
      expect(effect(cut.record, 'everyScored', 'chat')).toMatchObject({ actedOn: 60, added: 0 });
      expect(effect(cut.record, 'everyScored', 'chat')!.dropped).toBe(
        cut.record.candidates.filter((c) => c.status === 'rejected').length);
      expect(effect(cut.record, 'everyScored', 'chat')!.dropped).toBeGreaterThan(0);
      const kept = await pickFromSources([chat()], { task }, { task, decide, everyScored: true });
      expect(effect(kept.record, 'everyScored', 'chat')).toMatchObject({ actedOn: 60, added: 0, dropped: 0 });
      expect(effect(kept.record, 'everyScored', 'chat')!.summary).toMatch(/It kept out no part\.$/);
    });
  });

  describe('ruleBar', () => {
    const rules = [part('rules', 'strict', { role: 'rule' }), part('rules', 'loose', { role: 'rule' })];
    it('counts the rules asked, picked and dropped below the bar, and says when none fell below it', async () => {
      const cut = await pick(rules, { task, decide: fixed((q) => q.id === 'loose' ? 0.3 : 0.9), ruleBarBySource: { rules: 0.5 } });
      expect(effect(cut.record, 'ruleBar', 'rules')).toEqual({
        setting: 'ruleBar', source: 'rules', actedOn: 2, added: 0, dropped: 1,
        summary: 'ruleBar on rules: asked 2 rules, picked 1, dropped 1 below the bar 0.5.',
      });
      const kept = await pick(rules, { task, decide: fixed(() => 0.9), ruleBarBySource: { rules: 0.5 } });
      expect(effect(kept.record, 'ruleBar', 'rules')).toMatchObject({ actedOn: 2, added: 0, dropped: 0,
        summary: 'ruleBar on rules: asked 2 rules, picked 2, dropped 0 below the bar 0.5. It kept out no part.' });
      const off = await pick(rules, { task, decide: fixed(() => 0.9) });
      expect(effect(off.record, 'ruleBar', 'rules')).toBeUndefined();
    });
  });

  describe('wholeLanes', () => {
    it('counts the kept parts only the whole-lane read brought in', async () => {
      const picked = await pickFromSources([chat()], { task, wholeLanes: true }, { task, decide });
      const past = selectedFrom(picked, 'chat').filter((c) => Number(c.id.split('#')[1]) >= 60).length;
      expect(past).toBeGreaterThan(0);
      expect(effect(picked.record, 'wholeLanes', 'chat')).toEqual({
        setting: 'wholeLanes', source: 'chat', actedOn: 340, added: past, dropped: 0,
        summary: `wholeLanes on chat: read 340 parts past the lane cut; 340 reached the decide step only through the whole-lane read, and ${past} of them were kept.`,
      });
      expect(picked.record.candidates.filter((c) => c.pastLaneCut === true)).toHaveLength(340);
    });

    it('says when the read held no part past the cut', async () => {
      const picked = await pickFromSources([chat({}, parts('chat', 'chatword').slice(0, 60))],
        { task, wholeLanes: true }, { task, decide });
      expect(effect(picked.record, 'wholeLanes', 'chat')).toEqual({
        setting: 'wholeLanes', source: 'chat', actedOn: 0, added: 0, dropped: 0,
        summary: 'wholeLanes on chat: the read held no part past the lane cut, so it added none. It added no part.',
      });
    });

    it('says when every part past the cut lay past the candidate limit', async () => {
      // The read returns a and b inside its cut and x past it; one candidate a lane keeps a and b only.
      const reader: CandidateSource = {
        id: 'notes', role: 'reference',
        read: async (request: CandidateReadRequest) => ({ status: 'read', complete: true, laneCutApplied: !request.wholeLanes,
          candidates: [part('notes', 'a'), part('notes', 'b'), part('notes', 'x', request.wholeLanes ? { pastLaneCut: true } : {})] }),
      };
      const picked = await pickFromSources([reader], { task, wholeLanes: true },
        { task, decide: fixed(() => 0.9), rare: false, limits: { maxCandidates: 2 } });
      expect(picked.selected.map((c) => c.id)).toEqual(['a', 'b']);
      expect(effect(picked.record, 'wholeLanes', 'notes')).toEqual({
        setting: 'wholeLanes', source: 'notes', actedOn: 1, added: 0, dropped: 0,
        summary: 'wholeLanes on notes: read 1 part past the lane cut, but every one of them lay past the candidate limit, so it added none. It added no part.',
      });
    });

    it('gives no entry when the read cut its lanes', async () => {
      const picked = await pickFromSources([chat()], { task }, { task, decide });
      expect(effect(picked.record, 'wholeLanes', 'chat')).toBeUndefined();
    });
  });

  describe('linkedPathBar', () => {
    const reader = (id: string, candidates: readonly MemoryCandidate[]): CandidateSource => ({
      id, role: 'reference', read: async () => ({ status: 'read', complete: true, candidates }) });
    const commits = reader('git', [part('git', 'commit', { repository: 'repo-1', changedPaths: ['docs/ops.md'] })]);
    const notes = historySource({ reader: reader('markdown', [
      part('markdown', 'ops', { repository: 'repo-1', path: 'docs/ops.md' }),
      part('markdown', 'other', { repository: 'repo-1', path: 'docs/other.md' })]), ...markdownSettings, bar: 0.6 });
    const answers: Record<string, number> = { commit: 0.9, ops: 0.45, other: 0.45 };
    const run = (gitBar: number) => pickFromSources([historySource({ reader: commits, ...gitSettings, bar: gitBar }), notes],
      { task }, { task, decide: fixed((q) => answers[q.id]!) });

    it('counts the note the commit link kept', async () => {
      const picked = await run(0.0146);
      expect(effect(picked.record, 'linkedPathBar', 'markdown')).toEqual({
        setting: 'linkedPathBar', source: 'markdown', actedOn: 2, added: 1, dropped: 0,
        summary: 'linkedPathBar on markdown: 2 parts fell below the bar but answered at or above the link bar 0.4, and 1 of them was kept through a selected part that changed its path.',
      });
      expect(effect(picked.record, 'linkedPathBar', 'git')).toBeUndefined();
    });

    it('says why no part was kept through the link', async () => {
      const picked = await run(0.95);
      expect(effect(picked.record, 'linkedPathBar', 'markdown')).toEqual({
        setting: 'linkedPathBar', source: 'markdown', actedOn: 2, added: 0, dropped: 0,
        summary: 'linkedPathBar on markdown: no selected part\'s changed paths include the path of a part rejected at or above the link bar 0.4, so the link added none. It added no part.',
      });
    });
  });

  describe('a feed cut', () => {
    // The fixture of the fused-order test in labels.spec.ts: p3 is the only part in the label lane, and the
    // fused feed is a, p3, b. With everyRanked c 1 the feed holds two of three parts: a, p3 with labels on.
    const labelled = (question: { readonly id: string; readonly questionKey?: string }) =>
      question.questionKey === undefined ? 0.9
        : question.id === 'question' ? (question.questionKey === 'event' ? 0.9 : 0.1)
          : question.questionKey === 'event' ? (question.id === 'p3' ? 0.9 : 0.1) : 0.1;
    const threeParts = () => [part('notes', 'a', { searchRanks: [0] }), part('notes', 'b', { searchRanks: [1] }),
      part('notes', 'p3', { searchRanks: [2] })];
    const labelPick = (everyRanked: true | { c: number }, labels = true) => pick(threeParts(), {
      task: 'Recall the plan', decide: fixed(labelled), everyRanked, everyScored: true, rare: false,
      ...(labels ? { labelKindsBySource: { notes: LABEL_KINDS } } : {}),
    });

    it('labels: says the cut ended the feed early and the order may have changed which parts were decided', async () => {
      const on = await labelPick({ c: 1 });
      const off = await labelPick({ c: 1 }, false);
      const decided = (picked: PickResult) => picked.record.candidates.filter((c) => c.status === 'selected').map((c) => c.id);
      expect(decided(on)).toEqual(['a', 'p3']);
      expect(decided(off)).toEqual(['a', 'b']);
      expect(effect(on.record, 'labels', 'notes')).toEqual({
        setting: 'labels', source: 'notes', actedOn: 3, added: 0, dropped: null,
        summary: 'labels on notes at the label bar 0.5: labelled 3 parts; none reached the decide step only through the label lane. A feed cut (everyRanked c 1) ended the feed early, and labels change its order, so they may also have changed which parts were decided.',
      });
      const uncut = await labelPick(true);
      expect(effect(uncut.record, 'labels', 'notes')).toMatchObject({ added: 0, dropped: 0 });
      expect(effect(uncut.record, 'labels', 'notes')!.summary).toMatch(/It added no part\.$/);
    });

    // a, b and c rank 0, 1, 2 in the task's lane and 1, 2, 0 on the search line: the task's lane alone
    // admits a, b under the cut; with the search line the feed is a, c.
    const ranked = (ids: readonly string[]): CandidateSource => ({
      id: 'notes', role: 'reference',
      read: async (request: CandidateReadRequest) => ({ status: 'read', complete: true, laneCutApplied: true,
        candidates: (request.task === 'line' ? ['c', 'a', 'b'] : ids).map((id) => part('notes', id)) }),
    });
    const linePick = (everyRanked: true | { c: number }, searchLines?: string[]) =>
      pickFromSources([ranked(['a', 'b', 'c'])], { task, ...(searchLines === undefined ? {} : { searchLines }) },
        { task, decide: fixed(() => 0.9), everyRanked, rare: false });

    it('a search line: says the cut ended the feed early', async () => {
      const on = await linePick({ c: 1 }, ['line']);
      const off = await linePick({ c: 1 });
      expect(on.selected.map((c) => c.id)).toEqual(['a', 'c']);
      expect(off.selected.map((c) => c.id)).toEqual(['a', 'b']);
      const entry = effect(on.record, 'searchLines', 'notes')!;
      expect(entry).toMatchObject({ actedOn: 3, added: 0, dropped: null });
      expect(entry.summary).toMatch(/A feed cut \(everyRanked c 1\) ended the feed early/);
      expect(entry.summary).not.toMatch(/It added no part/);
      const uncut = await linePick(true, ['line']);
      expect(effect(uncut.record, 'searchLines', 'notes')).toEqual({
        setting: 'searchLines', source: 'notes', actedOn: 3, added: 0, dropped: 0,
        summary: 'searchLines on notes: the lanes held 3 parts, but every part they held was also in another lane, so they added none. It added no part.',
      });
    });
  });

  describe('everyRanked', () => {
    it.each([0.2, 1])('with c %s, gives how many ranked parts the cut left undecided', async (c) => {
      const picked = await pickFromSources([chat()], { task }, { task, decide, everyRanked: { c } });
      const undecided = picked.record.candidates.filter((entry) => entry.status === 'unassessed' && entry.reason === 'pick').length;
      const entry = effect(picked.record, 'everyRanked', 'chat')!;
      expect(entry).toMatchObject({ actedOn: 60, added: 0, dropped: null });
      expect(entry.summary).toBe(undecided === 0
        ? `everyRanked on chat: the cut (c ${c}) kept every one of 60 ranked parts, so it left 0 undecided.`
        : `everyRanked on chat: the cut (c ${c}) kept ${60 - undecided} of 60 ranked parts and left ${undecided} undecided.`);
      expect(undecided).toBe(c === 1 ? 0 : 36);
    });

    it('gives no entry when every ranked part is read', async () => {
      const picked = await pickFromSources([chat()], { task }, { task, decide });
      expect(effect(picked.record, 'everyRanked', 'chat')).toBeUndefined();
    });
  });

  describe('extra lanes', () => {
    // The task's lane holds a and b; the extra lane holds `held`.
    const source = (held: string): CandidateSource => ({
      id: 'notes', role: 'reference',
      read: async (request: CandidateReadRequest) => ({ status: 'read', complete: true, laneCutApplied: true,
        candidates: request.task === task ? [part('notes', 'a'), part('notes', 'b')]
          : [part('notes', held, { text: `the extra phrase ${held}` })] }),
    });

    it.each([
      ['searchLines', { searchLines: ['line'] }],
      ['searchPhrases', { searchPhrases: ['extra phrase'] }],
    ] as const)('%s: counts a kept part only that lane held', async (setting, extra) => {
      const picked = await pickFromSources([source('x')], { task, ...extra }, { task, decide: fixed(() => 0.9), rare: false });
      expect(picked.selected.map((c) => c.id)).toContain('x');
      expect(effect(picked.record, setting, 'notes')).toEqual({
        setting, source: 'notes', actedOn: 1, added: 1, dropped: 0,
        summary: `${setting} on notes: the lanes held 1 part; 1 reached the decide step only through them, and 1 of them was kept.`,
      });
    });

    it.each([
      ['searchLines', { searchLines: ['line'] }],
      ['searchPhrases', { searchPhrases: ['extra phrase'] }],
    ] as const)('%s: says every part it held was also in another lane', async (setting, extra) => {
      const picked = await pickFromSources([source('a')], { task, ...extra }, { task, decide: fixed(() => 0.9), rare: false });
      expect(effect(picked.record, setting, 'notes')).toEqual({
        setting, source: 'notes', actedOn: 1, added: 0, dropped: 0,
        summary: `${setting} on notes: the lanes held 1 part, but every part they held was also in another lane, so they added none. It added no part.`,
      });
    });

    it('searchLines: credits a part that reached the decide step only inside the line\'s candidate limit', async () => {
      // The task's lane orders a, x and the line's orders x, a. With one candidate per lane, the task's lane
      // admits a and the line admits x, though both lanes rank both parts.
      const crossed: CandidateSource = {
        id: 'notes', role: 'reference',
        read: async (request: CandidateReadRequest) => ({ status: 'read', complete: true, laneCutApplied: true,
          candidates: (request.task === 'line' ? ['x', 'a'] : ['a', 'x']).map((id) => part('notes', id)) }),
      };
      const picked = await pickFromSources([crossed], { task, searchLines: ['line'] },
        { task, decide: fixed(() => 0.9), rare: false, limits: { maxCandidates: 1 } });
      expect(picked.selected.map((c) => c.id).sort()).toEqual(['a', 'x']);
      expect(effect(picked.record, 'searchLines', 'notes')).toEqual({
        setting: 'searchLines', source: 'notes', actedOn: 2, added: 1, dropped: 0,
        summary: 'searchLines on notes: the lanes held 2 parts; 1 reached the decide step only through them, and 1 of them was kept.',
      });
    });

    it('searchLines: scopes the reason to the candidate limit when only the line held a part past it', async () => {
      // The task's lane holds a and b; the line orders a, b, x. Two candidates a lane keep x out of the line's lane.
      const past: CandidateSource = {
        id: 'notes', role: 'reference',
        read: async (request: CandidateReadRequest) => ({ status: 'read', complete: true, laneCutApplied: true,
          candidates: (request.task === 'line' ? ['a', 'b', 'x'] : ['a', 'b']).map((id) => part('notes', id)) }),
      };
      const picked = await pickFromSources([past], { task, searchLines: ['line'] },
        { task, decide: fixed(() => 0.9), rare: false, limits: { maxCandidates: 2 } });
      expect(picked.selected.map((c) => c.id)).toEqual(['a', 'b']);
      expect(effect(picked.record, 'searchLines', 'notes')).toEqual({
        setting: 'searchLines', source: 'notes', actedOn: 3, added: 0, dropped: 0,
        summary: 'searchLines on notes: the lanes held 3 parts, but every part they held inside the candidate limit was also in another lane, so they added none. It added no part.',
      });
    });

    it('searchLines: says no extra lane opened when every line repeats the task', async () => {
      const picked = await pickFromSources([source('x')], { task, searchLines: [task] },
        { task, decide: fixed(() => 0.9), rare: false });
      expect(effect(picked.record, 'searchLines', 'notes')).toEqual({
        setting: 'searchLines', source: 'notes', actedOn: 0, added: 0, dropped: 0,
        summary: 'searchLines on notes: every line was blank or repeated the task or an earlier line, so no extra lane opened and they added none. It added no part.',
      });
    });

    // A reader that answers a meaning read as a keyword read: the pick scores meaning itself. Its keyword lane
    // keeps a and b; the uncut pool adds x. `near` is the part nearest the task's meaning.
    const meaningSource = (near: string): CandidateSource => ({
      id: 'notes', role: 'reference',
      read: async (request: CandidateReadRequest) => ({ status: 'read', complete: true, laneCutApplied: true,
        candidates: (request.wholeLanes ? ['a', 'b', 'x'] : ['a', 'b']).map((id) => part('notes', id)) }),
    });
    const embed = (near: string) => async (texts: readonly string[]) =>
      texts.map((text) => text === task || text.endsWith(` ${near}`) ? [1, 0] : [0, 1]);

    it.each([['x', 1], ['a', 0]] as const)('meaning nearest %s: added %s', async (near, added) => {
      const picked = await pickFromSources([meaningSource(near)], { task, meaning: { embed: embed(near) } },
        { task, decide: fixed(() => 0.9), rare: false });
      const entry = effect(picked.record, 'meaning', 'notes')!;
      expect(entry).toMatchObject({ actedOn: 1, added, dropped: 0 });
      expect(entry.summary).toMatch(added ? /and 1 of them was kept\.$/ : /every part they held was also in another lane/);
    });
  });

  describe('taskPeriod', () => {
    // m is dated in March and no search lane held it: the period and the label lane both bring it in.
    const periodPick = (labels: boolean) => pick([part('notes', 'a', { searchRanks: [0] }),
      part('notes', 'm', { poolOnly: true, dateWindow: 'task-period', date: { value: '2025-03-15', meaning: 'recorded' } })], {
      task: 'What did I decide in March?', taskDate: '2025-06-02', timeZone: 'Europe/London',
      decide: fixed(() => 0.9), rare: false, ...(labels ? { labelKindsBySource: { notes: LABEL_KINDS } } : {}),
    });
    const head = 'taskPeriod on notes: 1 part dated from 2025-03-01T00:00:00.000+00:00 to 2025-03-31T23:59:59.999+01:00';

    it('counts the kept part only the period brought in', async () => {
      expect(effect((await periodPick(false)).record, 'taskPeriod', 'notes')).toEqual({
        setting: 'taskPeriod', source: 'notes', actedOn: 1, added: 1, dropped: 0,
        summary: `${head}; 1 reached the decide step only through the period, and 1 of them was kept.`,
      });
    });

    it('says when each part from the period also had another way in', async () => {
      const picked = await periodPick(true);
      expect(picked.selected.map((c) => c.id)).toContain('m');
      expect(effect(picked.record, 'taskPeriod', 'notes')).toEqual({
        setting: 'taskPeriod', source: 'notes', actedOn: 1, added: 0, dropped: 0,
        summary: `${head}, but each of them also had another way in, so it added none. It added no part.`,
      });
    });
  });

  it('gives no entry for a setting that was off', async () => {
    const picked = await pickFromSources([chat()], { task }, { task, decide });
    expect(picked.record.effects.map((entry) => `${entry.setting} ${entry.source}`)).toEqual(['bar chat', 'taskPeriod chat']);
  });
});

describe('the record says what each curate option did', () => {
  const candidate: MemoryCandidate = { sourceId: 'notes', id: 'notes#1', title: 'Plan', text: 'The plan.',
    role: 'reference', signals: {}, date: { value: '2026-01-02', meaning: 'recorded' } };
  const observation = '[2026-01-02] The plan was set (said 2026-01-02; E1)';
  const writing = (log: string) => ({ write: async () => log });
  const picked = (route = false) => pick([candidate], {
    task: 'How many plans?', everyScored: true,
    decide: fixed((q) => q.id === 'question' ? (q.questionKey === 'count' ? 0.9 : 0.1) : 0.9),
    ...(route ? { route: 'jev' as const } : {}),
  });
  const entry = (record: { effects: readonly { setting: string }[] }, setting: string) =>
    record.effects.find((item) => item.setting === setting);

  it('working: counts the worked-notes lines', async () => {
    const heading = "Working (the curator's; check it against the log):";
    const notes = await curate('How many plans?', await picked(), {
      ...writing([observation, heading, '1. one [E1]', '2. two [E1]', '3. three [E1]'].join('\n')), working: true });
    expect(entry(notes.record, 'working')).toEqual({ setting: 'working', lines: 3,
      summary: 'working: the curator wrote 3 lines of worked notes.' });
    const none = await curate('How many plans?', await picked(), { ...writing(observation), working: true });
    expect(entry(none.record, 'working')).toEqual({ setting: 'working', lines: 0,
      summary: 'working: the curator wrote no worked notes, so it added no line.' });
  });

  it('preference lines: counts them, and each option gives the total when both are on', async () => {
    const log = [observation, 'Advice preferences: likes plans (E1)', 'Changed preference: moved to tea (E1)'].join('\n');
    const both = await curate('How many plans?', await picked(), { ...writing(log), preferenceAdvice: true, preferenceChange: true });
    for (const setting of ['preferenceAdvice', 'preferenceChange']) {
      expect(entry(both.record, setting)).toEqual({ setting, lines: 2,
        summary: `${setting}: the curator wrote 2 preference lines; preferenceAdvice and preferenceChange both write them, so this is their total.` });
    }
    const none = await curate('How many plans?', await picked(), { ...writing(observation), preferenceAdvice: true });
    expect(entry(none.record, 'preferenceAdvice')).toEqual({ setting: 'preferenceAdvice', lines: 0,
      summary: 'preferenceAdvice: the curator wrote no preference lines, so it added no line.' });
    expect(entry(none.record, 'preferenceChange')).toBeUndefined();
  });

  it('route: names the options it switched on', async () => {
    const heading = "Working (the curator's; check it against the log):";
    const routed = await curate('How many plans?', await picked(true), {
      ...writing([observation, heading, '1. one [E1]'].join('\n')), route: 'jev' });
    expect(entry(routed.record, 'route')).toEqual({ setting: 'route', lines: 1,
      summary: 'route: the route answers switched on working, which wrote 1 line.' });
    expect(entry(routed.record, 'working')).toMatchObject({ lines: 1 });
  });

  it('gives no entry for an option that was off', async () => {
    // With no batch option the default batch size applies, so its entry is the only one.
    const plain = await curate('How many plans?', await picked(), writing(observation));
    expect(plain.record.effects.map((item) => item.setting)).toEqual(['batchTokens']);
  });
});
