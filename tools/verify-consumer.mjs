import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const packed = resolve(process.argv[2] ?? 'packed');
const packages = ['core', 'chat', 'git', 'markdown'];
const tarballs = packages.map((name) => {
  const file = readdirSync(packed).find((file) => file.startsWith(`curatejs-${name}-`) && file.endsWith('.tgz'));
  assert.ok(file, `Missing ${name} tarball`);
  return join(packed, file);
});
const consumer = mkdtempSync(join(tmpdir(), 'curate-consumer-'));
try {
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs], { cwd: consumer, stdio: 'pipe' });
  for (const name of packages) {
    const manifest = JSON.parse(readFileSync(join(consumer, 'node_modules', '@curatejs', name, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.dependencies ?? {}, name === 'core' ? {} : { '@curatejs/core': '^0.1.0' });
  }
  writeFileSync(join(consumer, 'example.mjs'), `
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pick, pickFromSources, curate, addMeaningRanks, historySource, SourceReadError, LABEL_KINDS, ANSWER_TYPES, DEFAULT_BATCH_TOKENS, COUNT_MARKER, taskQuestionWriter, taskNames } from '@curatejs/core';
import { asSourceReadError } from '@curatejs/core/internal';
import { chat, chatSettings, CHAT_CASCADE, CHAT_KEYWORD_SETTINGS, CHAT_SEARCH_LINE_REGISTER, PERSONAL_CHAT_CASCADE, PERSONAL_CHAT_WRITTEN_CASCADE } from '@curatejs/chat';
import { git, gitSettings, GIT_HISTORY_CASCADE, GIT_KEYWORD_SETTINGS, GIT_SEARCH_LINE_REGISTER } from '@curatejs/git';
import { markdown, knowledgeBase, rules, reviewNotes, markdownSettings, rulesSettings, MARKDOWN_CASCADE, MARKDOWN_KEYWORD_SETTINGS, MARKDOWN_SEARCH_LINE_REGISTER } from '@curatejs/markdown';
const cancelled = new SourceReadError('cancelled', 'Stopped');
assert.equal(asSourceReadError(cancelled), cancelled);
assert.equal(ANSWER_TYPES.length, 10);
assert.equal(DEFAULT_BATCH_TOKENS, 150000);
assert.equal(COUNT_MARKER.keepAt, 0.5);
assert.equal(PERSONAL_CHAT_CASCADE.first, 'personal_fact');
assert.equal(PERSONAL_CHAT_WRITTEN_CASCADE.written.highest > 0, true);
assert.deepEqual(taskNames('Who graduated first among Emma, Rachel and Alex?'), ['Emma', 'Rachel', 'Alex']);
const writer = taskQuestionWriter(async () => JSON.stringify([{ instructions: 'a?', true: 'yes', false: 'no' }, { instructions: 'b?', true: 'yes', false: 'no' }]));
assert.deepEqual((await writer('task')).map(q => q.key), ['task1', 'task2']);
const decide = async ({ questions }) => Object.fromEntries(questions.map(q => [q.key, { status: 'answered', probability: q.questionKey === 'offtopic' ? 0 : 1 }]));
const candidates = [1, 0.049, 0].map((probability, index) => ({
  sourceId: 'host', role: 'reference', id: 'host-item-' + index, title: 'Backup',
  text: 'Backups are encrypted. ' + 'Details. '.repeat(100) + 'Recovery uses offline keys.', signals: { probability }, date: { value: '2025-01-01', meaning: 'recorded' },
}));
const weighted = async ({ questions }) => {
  assert.ok(questions.every(q => q.text.endsWith('Recovery uses offline keys.')));
  return Object.fromEntries(questions.map(q => [q.key, {
    status: 'answered', probability: candidates.find(candidate => candidate.id === q.id).signals.probability,
  }]));
};
const defaults = await pick(candidates, {
  task: 'Recall backups',
  decide: async (batch) => batch.questions.some(q => q.questionKey !== undefined) ? decide(batch) : weighted(batch),
});
assert.deepEqual(defaults.selected.map(candidate => candidate.id), ['host-item-0', 'host-item-1']);
assert.deepEqual(defaults.record.levers.sources, { host: { labels: false, rare: false, bar: 0.0146 } });
assert.equal(defaults.record.labels, undefined);
assert.deepEqual(defaults.record.labelKindsBySource.host, []);
const uncutPick = { everyRanked: true, everyScored: true, rare: false };
const picked = await pick(candidates, { ...uncutPick, task: 'Recall backups', decide: weighted });
assert.deepEqual(picked.selected.map(candidate => candidate.id), ['host-item-0', 'host-item-1', 'host-item-2']);
assert.deepEqual(picked.record.levers.sources, { host: { labels: false, rare: false, bar: 0 } });
const labelled = await pick(candidates, { task: 'Recall backups', decide, labelKindsBySource: { host: LABEL_KINDS } });
assert.deepEqual(labelled.record.levers.sources, { host: { labels: true, labelBar: 0.5, rare: false, bar: 0.0146 } });
assert.equal(labelled.record.labels.deciderId, 'custom');
assert.ok(labelled.record.labels.asked > 0);
const meaning = await addMeaningRanks(candidates, 'Recall backups', {
  embed: async texts => texts.map(() => [1, 0]),
});
assert.equal(meaning.length, candidates.length);
assert.ok(meaning.every(candidate => candidate.searchRanks.length === 2));
assert.deepEqual(meaning.map(candidate => candidate.text), candidates.map(candidate => candidate.text));
const cut = await pick(candidates, { ...uncutPick, task: 'Recall backups', decide: weighted, everyScored: { bar: 0.05 } });
assert.deepEqual(cut.selected.map(candidate => candidate.id), ['host-item-0']);
let prompt;
const curated = await curate('Recall backups', picked, { write: async p => { prompt = p; return '[2025-01-01] Backups are encrypted (said 2025-01-01; E1)'; } });
assert.equal(curated.log, '[2025-01-01] Backups are encrypted (said 2025-01-01; host-item-0)');
assert.ok(prompt.body.includes('Recovery uses offline keys.'));
assert.ok(prompt.body.includes('### E2 (2025-01-01, 0.049):'));
assert.ok(prompt.body.includes('### E3 (2025-01-01, 0):'));
mkdirSync('transcripts');
writeFileSync('transcripts/session.jsonl', JSON.stringify({ type: 'user', sessionId: 'example', timestamp: '2025-01-01T12:00:00Z', message: { content: 'Backups are encrypted.' } }) + '\\n');
mkdirSync('queued');
writeFileSync('queued/session.jsonl', JSON.stringify({ type: 'attachment', sessionId: 'example', timestamp: '2025-01-01T12:00:00Z', attachment: { type: 'queued_command', prompt: 'Keep backups encrypted.', origin: { kind: 'human' } } }) + '\\n');
const queued = await chat({ providers: ['claude-code'], paths: ['queued'] }).read({ task: 'backups' });
assert.deepEqual(queued.candidates.map(c => [c.text, c.chat.role, c.chat.author]), [['Keep backups encrypted.', 'user', 'person']]);
mkdirSync('notes'); writeFileSync('notes/backup.md', '## Backup\\nBackups are encrypted.\\n');
mkdirSync('policy'); writeFileSync('policy/backup.md', 'Encrypt backups.\\n');
execFileSync('git', ['init', '-q']);
execFileSync('git', ['add', 'notes']);
execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Example', '-c', 'user.email=example@example.com', 'commit', '-qm', 'Document encrypted backups']);
for (const [source, questions] of [
  [chat({ providers: ['claude-code'], paths: ['transcripts'] }), CHAT_CASCADE],
  [git('.'), GIT_HISTORY_CASCADE],
  [knowledgeBase('notes'), MARKDOWN_CASCADE],
  [rules('policy'), MARKDOWN_CASCADE],
  [markdown({ paths: ['notes/*.md'], kind: 'docs' }), MARKDOWN_CASCADE],
  [markdown({ paths: ['policy'], kind: 'rules' }), MARKDOWN_CASCADE],
]) {
  const result = await pickFromSources([source], { task: 'Recall encrypted backups' }, { task: 'Recall encrypted backups', decide });
  assert.ok(result.selected.length > 0, source.kind);
  assert.deepEqual(result.record.levers.sources[source.id].questions, questions, source.id);
  assert.equal(result.reads[0].status, 'read');
}
mkdirSync('library'); writeFileSync('library/AGENTS.md', 'Read by the harness every session.\\n');
writeFileSync('library/backup.md', 'Encrypt backups.\\n'); writeFileSync('library/keys.md', 'Keep keys offline.\\n');
const library = await pickFromSources([rules('library')], { task: 'Recall encrypted backups' }, { task: 'Recall encrypted backups', decide });
assert.deepEqual(library.selected.map(candidate => candidate.text).sort(), ['Encrypt backups.\\n', 'Keep keys offline.\\n']);
const effectSources = [chat({ providers: ['claude-code'], paths: ['transcripts'] }), git('.'), knowledgeBase('notes')];
const effects = await pickFromSources(effectSources, { task: 'Recall encrypted backups' }, { task: 'Recall encrypted backups', decide });
assert.ok(Array.isArray(effects.record.effects));
assert.deepEqual(effectSources.map(source => effects.record.effects
  .filter(entry => entry.setting === 'bar' && entry.source === source.id).length), effectSources.map(() => 1));
assert.deepEqual([chatSettings, gitSettings, markdownSettings, rulesSettings].map(s => [s.rare, s.labels, s.bar, s.ruleBar]),
  [[false, true, 0.0146, undefined], [true, false, 0.0146, undefined], [true, false, 0.0146, undefined], [true, false, 0.0146, 0.5]]);
assert.deepEqual(chat({ paths: ['transcripts'] }).labelKinds, LABEL_KINDS);
assert.equal(historySource({ reader: chat({ paths: ['transcripts'] }), ...chatSettings, labels: false }).labelKinds, undefined);
assert.equal(CHAT_KEYWORD_SETTINGS.k1, 0.6);
assert.equal(GIT_KEYWORD_SETTINGS.recencyDays, 60);
assert.equal(MARKDOWN_KEYWORD_SETTINGS.b, 0.75);
assert.ok([CHAT_SEARCH_LINE_REGISTER, GIT_SEARCH_LINE_REGISTER, MARKDOWN_SEARCH_LINE_REGISTER].every(s => s.length > 0));
mkdirSync('review'); writeFileSync('review/plan.md', 'Ship the beta in March.\\n'); writeFileSync('review/rule.md', 'Every deploy needs two approvals.\\n');
const reviewDecide = async ({ questions }) => Object.fromEntries(questions.map(q => [q.key, { status: 'answered',
  probability: (q.questionKey === 'stale') === q.id.includes('plan.md') ? 0.9 : 0.1 }]));
const review = await reviewNotes({ paths: ['review'], kind: 'knowledge', decide: reviewDecide, taskDate: '2025-06-02', timeZone: 'UTC' });
assert.deepEqual(review.proposals.map(p => [p.path.slice(p.path.lastIndexOf('/') + 1), p.action, p.edit]), [['plan.md', 'retire', 'status: deprecated'], ['rule.md', 'promote', undefined]]);
assert.equal(review.record.questions, 4);
mkdirSync('okf'); writeFileSync('okf/a.md', '---\\ntype: decision\\ntimestamp: "2026-05-28T14:30:00Z"\\n---\\n## Use Postgres\\nBilling uses Postgres. See [B](/b.md).\\n');
writeFileSync('okf/b.md', '---\\ntype: concept\\ntimestamp: "2026-05-28T14:30:00Z"\\n---\\n## B\\nOne row per account.\\n');
const okf = await knowledgeBase('okf').read({ task: '', wholeLanes: true });
assert.equal(okf.status, 'read');
assert.equal(okf.candidates.length, 2);
assert.ok(okf.candidates.every(c => c.date.value === '2026-05-28T14:30:00Z' && c.date.meaning === 'changed'));
console.log('Clean consumer: core, chat, git, notes, rules, Markdown kinds, the note review and an OKF bundle passed.');
`);
  execFileSync(process.execPath, ['example.mjs'], { cwd: consumer, stdio: 'inherit', env: { ...process.env, XDG_CACHE_HOME: join(consumer, 'cache') } });
  writeFileSync(join(consumer, 'require.cjs'), `
const assert = require('node:assert/strict');
for (const name of ['core', 'chat', 'git', 'markdown']) {
  const mod = require('@curatejs/' + name);
  assert.ok(Object.keys(mod).length > 0, 'require("@curatejs/' + name + '") returned no exports');
}
console.log('Clean consumer: require() loaded all four packages.');
`);
  execFileSync(process.execPath, ['require.cjs'], { cwd: consumer, stdio: 'inherit', env: { ...process.env, XDG_CACHE_HOME: join(consumer, 'cache') } });
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
