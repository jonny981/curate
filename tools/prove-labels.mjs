// Offline check of the pick() label gate over a saved question set:
// the gate — the union of the keyword lanes' kept set and the label
// lane — must reach every saved answer message at a mean gate size far
// below the pool size. No model is called: saved label answers stand
// in for the decide port.
//
//   node tools/prove-labels.mjs <labels file> <questions file> <inputs directory> <parts module>
//
// <labels file>: .jsonl or .jsonl.gz rows of {question, part, labels},
//   plus one {question, part: null, kinds} row per question holding the
//   task's own seven kind answers.
// <questions file>: a JSON array of questions, each carrying
//   haystack_sessions, haystack_session_ids and haystack_dates.
// <inputs directory>: one <question_id>.json per question holding
//   {task, candidates}: the task text and the keyword lanes' kept set
//   in kept order.
// <parts module>: a module exporting parts(text) that splits a
//   session's rendered text into its part texts.
//
// The script imports the built core package: run `pnpm build` first.
// Each question gets a fresh store directory, so every label answer
// the stand-in returns is the saved one for that question.
import { createReadStream, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const [labelsFile, questionsFile, inputsDir, partsModule] = process.argv.slice(2);
if (!labelsFile || !questionsFile || !inputsDir || !partsModule) {
  console.error('usage: node tools/prove-labels.mjs <labels file> <questions file> <inputs directory> <parts module>');
  process.exit(2);
}
const root = dirname(fileURLToPath(import.meta.url));
const { pick } = await import(pathToFileURL(join(root, '../packages/core/dist/index.js')).href);
const { parts } = await import(pathToFileURL(partsModule).href);
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

// The saved labels: one task row (part: null, `kinds`) and one row per
// pool part (`labels`), keyed by question.
const saved = new Map();
{
  const stream = createReadStream(labelsFile);
  const lines = createInterface({
    input: labelsFile.endsWith('.gz') ? stream.pipe(createGunzip()) : stream,
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    const row = JSON.parse(line);
    const entry = saved.get(row.question) ?? { task: undefined, parts: new Map() };
    if (row.part === null) entry.task = row.kinds;
    else entry.parts.set(row.part, row.labels);
    saved.set(row.question, entry);
  }
}

// Each answer message and the part ids that carry it: sessions render
// to one document per session, split by parts(), and a part covering
// any slice of the answer turn carries the message.
function answerParts(q) {
  const messages = [], canonical = new Map();
  const sessions = [...new Map(q.haystack_sessions.map((turns, i) => [q.haystack_session_ids[i], { turns, i }])).entries()]
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [sid, { turns, i }] of sessions) {
    const prefix = `# session ${sid}\n\nDate: ${q.haystack_dates[i]}\n\n`;
    const rendered = turns.map((t) => `${t.role}: ${String(t.content).replace(/^#+/gm, '')}`);
    const text = (prefix + rendered.join('\n\n')).trim();
    let cursor = 0;
    const pieces = parts(text);
    const chunks = pieces.map((piece, j) => {
      const start = text.indexOf(piece, cursor);
      assert(start >= cursor);
      cursor = start + piece.length;
      const id = `tmp/sessions-whole/${q.question_id}/${sid}.md#1${pieces.length > 1 ? '.' + (j + 1) : ''}`;
      const key = piece.trim().replace(/\s+/g, ' ').trim();
      if (key && !canonical.has(key)) canonical.set(key, id);
      return { key, start, end: cursor };
    });
    let offset = prefix.length;
    turns.forEach((turn, j) => {
      if (turn.has_answer) messages.push({
        messageId: `${q.question_id}/${sid}/turn-${j}`,
        parts: [...new Set(chunks.filter((c) => c.end > offset + turn.role.length + 2 && c.start < offset + rendered[j].length)
          .map((c) => canonical.get(c.key)).filter(Boolean))],
      });
      offset += rendered[j].length + 2;
    });
  }
  return messages;
}

// The question's pool: every part its history splits into, deduplicated
// by text.
function poolOf(q) {
  const sessions = [...new Map(q.haystack_sessions.map((turns, index) => [q.haystack_session_ids[index], { turns, index }])).values()]
    .sort((a, b) => q.haystack_session_ids[a.index].localeCompare(q.haystack_session_ids[b.index]));
  const candidates = sessions.flatMap(({ turns, index }) => {
    const sid = q.haystack_session_ids[index], date = q.haystack_dates[index];
    const name = `${sid}.md`, heading = `session ${sid}`;
    const body = turns.map((turn) => `${turn.role}: ${String(turn.content).replace(/^#+/gm, '')}`).join('\n\n');
    const pieces = parts(`# ${heading}\n\nDate: ${date}\n\n${body}`.trim());
    return pieces.map((piece, part) => ({
      sourceId: `questions:${q.question_id}`, role: 'reference',
      id: `tmp/sessions-whole/${q.question_id}/${name}#1${pieces.length > 1 ? `.${part + 1}` : ''}`,
      title: `${name}: ${heading}${pieces.length > 1 ? ` (part ${part + 1} of ${pieces.length})` : ''}`,
      text: piece.trim(), date: { value: `dated ${date}`, meaning: 'recorded' },
      heading, name, score: 0, signals: {}, sessionKey: `session:${sid}`,
    })).filter((candidate) => candidate.text.length > 0);
  });
  const seen = new Map();
  for (const candidate of candidates) {
    const key = candidate.text.replace(/\s+/g, ' ').trim();
    if (!seen.has(key)) seen.set(key, candidate);
  }
  return [...seen.values()];
}

const questions = read(questionsFile)
  .sort((a, b) => a.question_id.localeCompare(b.question_id));
const totals = { questions: 0, messages: 0, reached: 0, pool: 0, kept: 0, gate: 0, asked: 0, reused: 0 };
const missed = [];
for (const q of questions) {
  const input = read(join(inputsDir, `${q.question_id}.json`));
  const entry = saved.get(q.question_id);
  assert(entry?.task, `no saved task labels for ${q.question_id}`);
  // Lane membership alone marks the kept set: kept parts hold their
  // kept order as lane-0 ranks and pool parts carry `poolOnly`, so the
  // pick's keyword lanes hold exactly the kept set — the same hand-off
  // a merged source read gives the gate.
  const kept = new Map(input.candidates.map((candidate, index) => [candidate.id, index]));
  const pool = poolOf(q);
  const candidates = pool.map((candidate) => kept.has(candidate.id)
    ? { ...candidate, searchRanks: [kept.get(candidate.id)] }
    : { ...candidate, poolOnly: true });
  const poolIds = new Set(pool.map((candidate) => candidate.id));
  const missing = input.candidates.filter((candidate) => !poolIds.has(candidate.id));
  assert.equal(missing.length, 0, `kept parts absent from the pool: ${missing.map((c) => c.id)}`);
  const directory = mkdtempSync(join(tmpdir(), 'prove-labels-'));
  try {
    const result = await pick(candidates, {
      task: input.task,
      labels: { directory, deciderId: 'saved-labels' },
      decide: async (batch) => Object.fromEntries(batch.questions.map((question) => {
        if (question.questionKey === undefined) return [question.key, { status: 'answered', probability: 0.9 }];
        const table = question.id === 'question' ? entry.task : entry.parts.get(question.id);
        const probability = table?.[question.questionKey];
        return [question.key, Number.isFinite(probability)
          ? { status: 'answered', probability }
          : { status: 'missing' }];
      })),
    });
    const gate = new Set(result.record.candidates
      .filter((candidate) => candidate.status !== 'unassessed')
      .map((candidate) => candidate.id));
    assert.equal(gate.size, result.record.labels.gate);
    const messages = answerParts(q);
    const reached = messages.filter((message) => message.parts.some((id) => gate.has(id)));
    for (const message of messages) {
      if (!message.parts.some((id) => gate.has(id))) {
        missed.push({ question: q.question_id, message: message.messageId, parts: message.parts });
      }
    }
    totals.questions += 1;
    totals.messages += messages.length;
    totals.reached += reached.length;
    totals.pool += pool.length;
    totals.kept += kept.size;
    totals.gate += gate.size;
    totals.asked += result.record.labels.asked;
    totals.reused += result.record.labels.reused;
    console.log(`${q.question_id} pool=${pool.length} kept=${kept.size} gate=${gate.size} `
      + `labels asked=${result.record.labels.asked} reused=${result.record.labels.reused} `
      + `messages ${reached.length}/${messages.length}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
const mean = (value) => (value / totals.questions).toFixed(1);
console.log(`\nquestions ${totals.questions}`);
console.log(`messages reached ${totals.reached} of ${totals.messages}`);
console.log(`mean pool ${mean(totals.pool)} | mean keyword set ${mean(totals.kept)} | mean gate ${mean(totals.gate)}`);
console.log(`mean label sets asked ${mean(totals.asked)} | reused ${mean(totals.reused)} per question`);
if (missed.length) {
  console.log(`\nMISSED ${missed.length}:`);
  for (const message of missed) console.log(JSON.stringify(message));
}
