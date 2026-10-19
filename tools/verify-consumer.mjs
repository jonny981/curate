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
import { pick, pickFromSources, curate, addMeaningRanks, SourceReadError } from '@curatejs/core';
import { asSourceReadError } from '@curatejs/core/internal';
import { chat, CHAT_CASCADE, CHAT_KEYWORD_SETTINGS, CHAT_SEARCH_LINE_REGISTER } from '@curatejs/chat';
import { gitHistory, GIT_HISTORY_CASCADE, GIT_KEYWORD_SETTINGS, GIT_SEARCH_LINE_REGISTER } from '@curatejs/git';
import { markdown, knowledgeBase, rules, MARKDOWN_CASCADE, MARKDOWN_KEYWORD_SETTINGS, MARKDOWN_SEARCH_LINE_REGISTER } from '@curatejs/markdown';
const cancelled = new SourceReadError('cancelled', 'Stopped');
assert.equal(asSourceReadError(cancelled), cancelled);
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
const picked = await pick(candidates, { task: 'Recall backups', decide: weighted });
assert.deepEqual(picked.selected.map(candidate => candidate.id), ['host-item-0', 'host-item-1', 'host-item-2']);
assert.equal(picked.record.thresholds.reference, 0);
const meaning = await addMeaningRanks(candidates, 'Recall backups', {
  embed: async texts => texts.map(() => [1, 0]),
});
assert.equal(meaning.length, candidates.length);
assert.ok(meaning.every(candidate => candidate.searchRanks.length === 2));
assert.deepEqual(meaning.map(candidate => candidate.text), candidates.map(candidate => candidate.text));
const cut = await pick(candidates, { task: 'Recall backups', decide: weighted, thresholds: { reference: 0.05 } });
assert.deepEqual(cut.selected.map(candidate => candidate.id), ['host-item-0']);
let prompt;
const curated = await curate('Recall backups', picked, { write: async p => { prompt = p; return '[2025-01-01] Backups are encrypted (said 2025-01-01; E1)'; } });
assert.equal(curated.log, '[2025-01-01] Backups are encrypted (said 2025-01-01; host-item-0)');
assert.ok(prompt.body.includes('Recovery uses offline keys.'));
assert.ok(prompt.body.includes('### E2 (2025-01-01, 0.049):'));
assert.ok(prompt.body.includes('### E3 (2025-01-01, 0):'));
mkdirSync('transcripts');
writeFileSync('transcripts/session.jsonl', JSON.stringify({ type: 'user', sessionId: 'example', timestamp: '2025-01-01T12:00:00Z', message: { content: 'Backups are encrypted.' } }) + '\\n');
mkdirSync('notes'); writeFileSync('notes/backup.md', '## Backup\\nBackups are encrypted.\\n');
mkdirSync('policy'); writeFileSync('policy/backup.md', '---\\napplies: always\\n---\\nEncrypt backups.\\n');
execFileSync('git', ['init', '-q']);
execFileSync('git', ['add', 'notes']);
execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Example', '-c', 'user.email=example@example.com', 'commit', '-qm', 'Document encrypted backups']);
for (const [source, cascade] of [
  [chat({ providers: ['claude-code'], paths: ['transcripts'] }), CHAT_CASCADE],
  [gitHistory('.'), GIT_HISTORY_CASCADE],
  [knowledgeBase('notes'), MARKDOWN_CASCADE],
  [rules('policy'), MARKDOWN_CASCADE],
  [markdown({ paths: ['notes/*.md'], kind: 'docs' }), MARKDOWN_CASCADE],
  [markdown({ paths: ['policy'], kind: 'rules' }), MARKDOWN_CASCADE],
]) {
  const result = await pickFromSources([source], { task: 'Recall encrypted backups' }, { task: 'Recall encrypted backups', decide, cascade });
  assert.ok(result.selected.length > 0, source.kind);
  assert.equal(result.reads[0].status, 'read');
}
assert.equal(CHAT_KEYWORD_SETTINGS.k1, 0.6);
assert.equal(GIT_KEYWORD_SETTINGS.recencyDays, 60);
assert.equal(MARKDOWN_KEYWORD_SETTINGS.b, 0.75);
assert.ok([CHAT_SEARCH_LINE_REGISTER, GIT_SEARCH_LINE_REGISTER, MARKDOWN_SEARCH_LINE_REGISTER].every(s => s.length > 0));
console.log('Clean consumer: core, chat, git, notes, rules and Markdown kinds passed.');
`);
  execFileSync(process.execPath, ['example.mjs'], { cwd: consumer, stdio: 'inherit' });
  writeFileSync(join(consumer, 'require.cjs'), `
const assert = require('node:assert/strict');
for (const name of ['core', 'chat', 'git', 'markdown']) {
  const mod = require('@curatejs/' + name);
  assert.ok(Object.keys(mod).length > 0, 'require("@curatejs/' + name + '") returned no exports');
}
console.log('Clean consumer: require() loaded all four packages.');
`);
  execFileSync(process.execPath, ['require.cjs'], { cwd: consumer, stdio: 'inherit' });
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
