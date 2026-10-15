// Offline proof for `observe`: it writes each session once, then never
// calls the writer again for the same sessions.
//
// Reads saved LongMemEval tuning histories (the benchmark's own records:
// question id, session ids, session dates and the turns of every session)
// and renders each history into candidates the way the benchmark feed
// does (one part per ~700 characters of a session's turns), with the
// session id as the part's `documentId`. A stand-in writer counts its
// calls and returns one format-valid line per evidence item, citing only
// that session's own ids. Two `observe` passes run against a plain-file
// store in a temporary directory, which is removed afterwards.
//
// The proof prints, per history: writer calls on the first pass, calls on
// the second, the lines kept and their characters, and confirms every
// cited id resolves to that history's parts.
//
//   node tools/prove-observe.mjs <tuning.json> [first,count]

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observe, observationCandidates } from '../packages/core/dist/index.js';

const [records, first, count] = (() => {
  const file = process.argv[2];
  assert.ok(file, 'usage: node tools/prove-observe.mjs <tuning.json> [first,count]');
  const [at = 0, take = 3] = (process.argv[3] ?? '0,3').split(',').map(Number);
  return [JSON.parse(readFileSync(file, 'utf8')).slice(at, at + take), at, take];
})();
assert.equal(records.length, 3, `the proof needs three histories, ${records.length} given`);

// One ~700-character piece per candidate, as the benchmark feed renders
// sessions; the session id is the part's documentId so `observe` groups
// the pieces into that session.
function pieces(text, size = 700) {
  const out = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current && current.length + line.length + 1 > size) {
      out.push(current);
      current = '';
    }
    current = current ? `${current}\n${line}` : line;
    while (current.length > size) {
      out.push(current.slice(0, size));
      current = current.slice(size);
    }
  }
  if (current.trim()) out.push(current);
  return out;
}

function partsOf(history) {
  const parts = [];
  for (const [index, sessionId] of history.haystack_session_ids.entries()) {
    const text = `# session ${sessionId}\n\nDate: ${history.haystack_dates[index]}\n\n`
      + history.haystack_sessions[index]
        .map((turn) => `${turn.role}: ${String(turn.content).replace(/^#+/gm, '')}`)
        .join('\n\n');
    const chunk = pieces(text.trim());
    chunk.forEach((piece, at) => {
      parts.push({
        sourceId: 'saved',
        role: 'reference',
        id: `tmp/sessions-whole/${history.question_id}/${sessionId}.md#1${chunk.length > 1 ? `.${at + 1}` : ''}`,
        title: `${sessionId}.md: session ${sessionId}${chunk.length > 1 ? ` (part ${at + 1} of ${chunk.length})` : ''}`,
        date: { value: history.haystack_dates[index], meaning: 'recorded' },
        text: piece.trim(),
        documentId: sessionId,
        signals: {},
      });
    });
  }
  return parts;
}

// A counting stand-in writer: it reads the sessions and items from the
// prompt body and answers one format-valid line per item, citing only
// the item's own id. Dates in the headers are LongMemEval's
// `YYYY/MM/DD …` form; the line carries them as `YYYY-MM-DD`.
function standIn() {
  let calls = 0;
  const write = async (prompt) => {
    calls += 1;
    const out = [];
    for (const line of prompt.body.split('\n')) {
      // A repair body appends the rejected reply after the evidence; only
      // the evidence is answered.
      if (line.startsWith('REJECTED REPLY')) break;
      if (line.startsWith('SESSION ')) {
        out.push(line);
        continue;
      }
      const item = /^### (.+?) \((.*)\): /.exec(line);
      if (!item) continue;
      const date = /(\d{4})\/(\d{2})\/(\d{2})/.exec(item[2]);
      const said = date ? `${date[1]}-${date[2]}-${date[3]}` : '2023-01-01';
      out.push(`[${said}] A fact the item ${item[1]} states (said ${said}; ${item[1]})`);
    }
    return out.join('\n');
  };
  return { write, calls: () => calls };
}

const storeRoot = mkdtempSync(join(tmpdir(), 'curate-observe-proof-'));
try {
  for (const [index, history] of records.entries()) {
    const parts = partsOf(history);
    const ids = new Set(parts.map((part) => part.id));
    const directory = join(storeRoot, history.question_id);
    const writer = standIn();

    const written = await observe(parts, { write: writer.write, writerId: 'proof-stand-in', directory });
    const firstCalls = writer.calls();
    const reused = await observe(parts, { write: writer.write, writerId: 'proof-stand-in', directory });

    assert.equal(reused.record.calls, 0);
    assert.ok(reused.record.sessions.every((session) => session.outcome === 'reused'));
    assert.deepEqual(
      reused.sessions.map((session) => session.lines),
      written.sessions.map((session) => session.lines),
    );

    const candidates = observationCandidates(written);
    const unresolved = candidates.flatMap((candidate) => candidate.cites ?? [])
      .filter((cited) => !ids.has(cited));
    assert.deepEqual(unresolved, []);
    const lines = written.sessions.flatMap((session) => session.lines);
    const characters = lines.reduce((total, line) => total + line.length, 0);
    console.log(`history ${index + 1} (${history.question_id}): `
      + `${parts.length} parts, ${written.sessions.length} sessions, `
      + `${firstCalls} writer calls then ${reused.record.calls}, `
      + `${lines.length} lines, ${characters} characters, `
      + `${candidates.length} candidates, every cited id resolves`);
  }
} finally {
  rmSync(storeRoot, { recursive: true, force: true });
}
