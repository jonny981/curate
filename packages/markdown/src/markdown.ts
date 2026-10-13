import { MARKDOWN_KEYWORD_SETTINGS, type MarkdownKeywordSettings } from './defaults.js';
import { hits, taskTerms, tokenize } from '@curatejs/core/internal';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, matchesGlob, relative, resolve, sep } from 'node:path';

import {
  asSourceReadError,
  canonicalPath,
  commitDate,
  GitFailure,
  pathNames,
  probeWorkTree,
  resolveCommit,
  runGit,
  runGitBytes,
  type WorkTreeProbe,
} from '@curatejs/core/internal';
import { DEFAULT_MAX_QUESTION_TEXT, type MemoryCandidate, type MemoryKind } from '@curatejs/core';
import {
  SourceReadError,
  type CandidateReadContext,
  type CandidateReadRequest,
  type CandidateReadResult,
  type CandidateSource,
} from '@curatejs/core';

export interface RulesOptions {
  /** Override the exported MARKDOWN_KEYWORD_SETTINGS. */
  readonly keyword?: Partial<MarkdownKeywordSettings>;
}

export interface KnowledgeBaseOptions extends RulesOptions {
  /** Characters per part. A section longer than this is offered in
   *  parts cut at line ends, preserving every character for judging. The
   *  read request's own `maxQuestionText`, filled by `pickFromSources`
   *  from the pick limits, tightens the cut further. */
  readonly maxQuestionText?: number;
  /** The repository key notes declare for the commit-to-note link when
   *  the corpus sits inside a work tree; defaults to the toplevel. */
  readonly repository?: string;
}
export interface MarkdownOptions extends RulesOptions {
  /** Folders, files, or glob patterns; ~/ resolves against the user's home. */
  readonly paths: readonly string[];
  readonly kind: MemoryKind;
  /** Optional part size; omitted keeps text whole. */
  readonly maxQuestionText?: number;
  /** Repository key shared with gitHistory for changed-path links. */
  readonly repository?: string;
}
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;
const SECTION_BREAK = /\n(?=## )/g;
const HEADING = /^#{1,6} +(.+)$/m;
// A note declares it has been replaced through a frontmatter match or a
// marker in its body; a negative signal, not
// removal.
const REPLACED_WORDS = '(superseded|retired|deprecated|obsolete|withdrawn)';
const REPLACED_FRONTMATTER = new RegExp(`\\b${REPLACED_WORDS}\\b`, 'i');
const REPLACED_LINE = new RegExp(`^>?\\s*\\**${REPLACED_WORDS}\\b`, 'im');
const LINK = /\[\[([^\]|#]+)|\]\(([^)#]+\.md)\b[^)]*\)/g;
const DATE_FIELDS: ReadonlyArray<readonly [string, 'recorded' | 'effective' | 'changed']> = [
  ['date', 'recorded'],
  ['updated', 'changed'],
  ['written', 'recorded'],
  ['effective', 'effective'],
  ['applies-from', 'effective'],
];

interface Walked {
  readonly files: readonly string[];
  /** Entries that looked like content but were not walked or read; each
   *  a symbolic link. Skipped items make the read incomplete. */
  readonly skipped: number;
}

async function walkMarkdown(
  root: string,
  signal: AbortSignal | undefined,
  exclude: ReadonlySet<string>,
  toplevel?: string,
  select: (file: string) => boolean = () => true,
  legacy = false,
): Promise<Walked> {
  const files: string[] = [];
  let skipped = 0;
  async function walk(directory: string): Promise<void> {
    if (signal?.aborted) throw new SourceReadError('cancelled', 'The read was cancelled.');
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw new SourceReadError('failed', `Could not list ${directory}: ${message(error)}`);
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    const ignored = legacy ? new Set<string>()
      : await ignoredPaths(directory, entries.map((entry) => join(directory, entry.name)), toplevel, signal);
    for (const entry of entries) {
      if (legacy ? entry.name.startsWith('.') : entry.name === '.git' || entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (ignored.has(path) || isExcluded(path, root, exclude, toplevel)) continue;
      if (entry.isSymbolicLink()) {
        skipped += 1;
      } else if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && (legacy ? entry.name.endsWith('.md') : markdownFile(path)) && select(path)) {
        files.push(path);
      }
    }
  }
  await walk(root);
  return { files, skipped };
}

function markdownFile(file: string): boolean {
  return /\.(?:md|mdc|markdown)$/i.test(file) || basename(file) === '.cursorrules';
}

async function ignoredPaths(
  directory: string,
  paths: readonly string[],
  toplevel: string | undefined,
  signal: AbortSignal | undefined,
): Promise<ReadonlySet<string>> {
  if (toplevel === undefined || paths.length === 0) return new Set();
  try {
    const output = await runGit(directory, ['check-ignore', '--no-index', '-z', '--stdin'], {
      input: `${paths.join('\0')}\0`, signal,
    });
    return new Set(output.split('\0').filter(Boolean));
  } catch (error) {
    if (error instanceof GitFailure && error.kind === 'exit' && error.code === 1) return new Set();
    throw asSourceReadError(error);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCancel(error: unknown): boolean {
  return (error instanceof GitFailure && error.kind === 'cancelled')
    || (error instanceof SourceReadError && error.code === 'cancelled');
}

function isExcluded(
  path: string,
  root: string,
  exclude: ReadonlySet<string>,
  toplevel?: string,
): boolean {
  if (exclude.size === 0) return false;
  const within = relative(root, path).split(sep).join('/');
  const fromCwd = relative(process.cwd(), path).split(sep).join('/');
  const fromRepo = toplevel === undefined
    ? undefined
    : relative(toplevel, path).split(sep).join('/');
  for (const entry of exclude) {
    // The root marker: every path beneath an anchor sits under it, the
    // same set the commit reader refuses for a root exclusion.
    if (entry === '.') return true;
    if (path === entry || path.startsWith(`${entry}${sep}`)) return true;
    if (within === entry || within.startsWith(`${entry}/`)) return true;
    if (fromCwd === entry || fromCwd.startsWith(`${entry}/`)) return true;
    if (fromRepo !== undefined && (fromRepo === entry || fromRepo.startsWith(`${entry}/`))) {
      return true;
    }
  }
  return false;
}

interface Note {
  readonly fields: ReadonlyMap<string, string>;
  readonly frontmatter: string;
  readonly body: string;
  /** File lines the frontmatter block occupies; body line 1 sits this
   *  many lines into the file. */
  readonly bodyOffset: number;
}

function parseNote(raw: string): Note {
  const match = FRONTMATTER.exec(raw);
  if (!match) return { fields: new Map(), frontmatter: '', body: raw, bodyOffset: 0 };
  const frontmatter = match[1] ?? '';
  const fields = new Map<string, string>();
  let listField: string | undefined;
  for (const line of frontmatter.split(/\r?\n/)) {
    const field = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    if (field) {
      listField = field[1]!.toLowerCase();
      fields.set(listField, field[2]!.trim().replace(/^(['"])(.*)\1$/, '$2'));
    } else {
      const item = /^\s+-\s+(.+)$/.exec(line);
      if (item && listField !== undefined) {
        fields.set(listField, `${fields.get(listField) ?? ''}\n${item[1]}`);
      } else if (line.trim() !== '') listField = undefined;
    }
  }
  return {
    fields,
    frontmatter,
    body: raw.slice(match[0].length),
    bodyOffset: (match[0].match(/\n/g)?.length ?? 0),
  };
}

function declaredDate(fields: ReadonlyMap<string, string>, updated = true): MemoryCandidate['date'] {
  for (const [name, meaning] of DATE_FIELDS) {
    if (name === 'updated' && !updated) continue;
    const value = fields.get(name);
    if (value !== undefined && value !== '') return { value, meaning };
  }
  return undefined;
}

interface Section {
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly heading?: string;
}

function sections(body: string, bodyOffset: number): readonly Section[] {
  const starts = [0];
  for (const match of body.matchAll(SECTION_BREAK)) starts.push(match.index + 1);
  starts.push(body.length);
  const result: Section[] = [];
  for (let index = 0; index < starts.length - 1; index += 1) {
    const text = body.slice(starts[index], starts[index + 1]);
    if (text.trim() === '') continue;
    const before = body.slice(0, starts[index]);
    const startLine = bodyOffset + (before.match(/\n/g)?.length ?? 0) + 1;
    const endLine = startLine + (text.match(/\n/g)?.length ?? 0) - (text.endsWith('\n') ? 1 : 0);
    const heading = HEADING.exec(text)?.[1]?.trim();
    result.push({ text, startLine, endLine, ...(heading === undefined ? {} : { heading }) });
  }
  return result;
}

function scopePatterns(value: string): readonly string[] {
  const scalar = value.trim().replace(/^\[([\s\S]*)\]$/, '$1');
  // Split commas outside quotes and brace groups (e.g. **/*.{ts,tsx}).
  const patterns: string[] = [];
  let start = 0;
  let quote = '';
  let braces = 0;
  for (let index = 0; index <= scalar.length; index += 1) {
    const char = scalar[index];
    if (quote !== '') {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '{') braces += 1;
    else if (char === '}') braces -= 1;
    else if (index === scalar.length || ((char === ',' || char === '\n') && braces === 0)) {
      const part = scalar.slice(start, index).trim().replace(/^(['"])(.*)\1$/, '$2');
      if (part !== '') patterns.push(part);
      start = index + 1;
    }
  }
  return patterns;
}

function ruleScope(file: string, note: Note): readonly string[] | undefined {
  const field = file.endsWith('.mdc') ? note.fields.get('globs')
    : file.endsWith('.instructions.md') ? note.fields.get('applyto') : undefined;
  return field === undefined || field.trim() === '' ? undefined : scopePatterns(field);
}

interface RuleSection extends Section {
  readonly key: string;
}

/** Headings and unindented list items start rules; nested lists and code stay whole.
 * Parent text is repeated so a child keeps the constraints above its heading. */
function ruleSections(body: string, bodyOffset: number): readonly RuleSection[] {
  const lines = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const result: RuleSection[] = [];
  const parents: { level: number; name: string; text: string }[] = [];
  let heading: { level: number; name: string } | undefined;
  let own: string[] = [];
  let item: string | undefined;
  let startLine = bodyOffset + 1;
  let fence: { char: string; length: number } | undefined;
  const seen = new Map<string, number>();
  const emit = () => {
    const text = own.join('');
    const prose = heading === undefined ? text : text.slice((own[0] ?? '').length);
    if (prose.trim() === '' && item === undefined) return;
    const names = [...parents.map((parent) => parent.name),
      ...(heading === undefined ? [] : [heading.name]), ...(item === undefined ? [] : [item])];
    const path = names.map(encodeURIComponent).join('/');
    const count = (seen.get(path) ?? 0) + 1;
    seen.set(path, count);
    result.push({
      text: parents.map((parent) => parent.text).join('') + text,
      startLine, endLine: startLine + own.length - 1,
      ...(heading === undefined ? {} : { heading: heading.name }),
      key: `${path}${count === 1 ? '' : `~${count}`}`,
    });
  };
  for (const [index, line] of lines.entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) fence = { char: marker[0]!, length: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.length
        && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = undefined;
      own.push(line);
      continue;
    }
    const nextHeading = fence === undefined ? /^(#{1,6}) +(.+?)(?: +#+)?\s*$/.exec(line) : null;
    const nextItem = fence === undefined ? /^(?:[-+*]|\d+[.)]) +(.+)/.exec(line) : null;
    if (nextHeading !== null) {
      emit();
      const level = nextHeading[1]!.length;
      if (heading !== undefined && heading.level < level) {
        parents.push({ ...heading, text: own.join('') });
      }
      while (parents.length > 0 && parents[parents.length - 1]!.level >= level) parents.pop();
      heading = { level, name: nextHeading[2]!.trim() };
      item = undefined;
      own = [line];
      startLine = bodyOffset + index + 1;
    } else if (nextItem !== null) {
      emit();
      // A heading's introductory text also applies to every list rule below it.
      if (item === undefined && heading !== undefined) {
        parents.push({ ...heading, text: own.join('') });
        heading = undefined;
      }
      item = nextItem[1]!.trim();
      own = [line];
      startLine = bodyOffset + index + 1;
    } else own.push(line);
  }
  emit();
  return result;
}

function instructionLocation(directory: string, paths: readonly string[], root: string): number {
  let best = 0;
  for (const path of paths) {
    const target = resolve(root, path);
    const within = relative(directory, target);
    if (within === '..' || within.startsWith(`..${sep}`)) continue;
    const distance = relative(directory, dirname(target)).split(sep).filter(Boolean).length;
    best = Math.max(best, 1 / (1 + distance));
  }
  return best;
}

/** Cut text into parts of at most `limit` characters at line ends, so the
 *  parts joined exactly reproduce the text. A single line longer than the
 *  limit is hard-cut; every part must still be judged. */
function splitParts(text: string, limit: number): readonly string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    const windowEnd = Math.min(start + limit, text.length);
    if (windowEnd === text.length) {
      parts.push(text.slice(start));
      break;
    }
    const newline = text.lastIndexOf('\n', windowEnd - 1);
    const end = newline > start ? newline + 1 : windowEnd;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

function bm25Scores(docs: readonly string[], terms: readonly string[], keyword: MarkdownKeywordSettings): readonly number[] {
  const count = docs.length;
  const tokens = docs.map(tokenize);
  const lengths = tokens.map((doc) => doc.length);
  const avgLength = count === 0 ? 0 : lengths.reduce((sum, n) => sum + n, 0) / count;
  if (avgLength === 0) return docs.map(() => 0);
  const documentFrequency = new Map<string, number>();
  for (const doc of tokens) {
    const seen = new Set(doc);
    for (const term of terms) {
      if (seen.has(term)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  return tokens.map((doc, index) => {
    const counts = new Map<string, number>();
    for (const token of doc) counts.set(token, (counts.get(token) ?? 0) + 1);
    let score = 0;
    for (const term of terms) {
      const n = documentFrequency.get(term) ?? 0;
      const f = counts.get(term) ?? 0;
      if (n === 0 || f === 0) continue;
      const idf = Math.log(1 + (count - n + 0.5) / (n + 0.5));
      score += idf * (f * (keyword.k1 + 1))
        / (f + keyword.k1 * (1 - keyword.b + keyword.b * (lengths[index]! / avgLength)));
    }
    return score;
  });
}

function withBm25(
  candidates: readonly MemoryCandidate[],
  terms: readonly string[],
  keyword: MarkdownKeywordSettings,
): MemoryCandidate[] {
  const scores = bm25Scores(candidates.map((candidate) => candidate.text), terms, keyword);
  return candidates.map((candidate, index) =>
    scores[index] === 0
      ? candidate
      : { ...candidate, signals: { ...candidate.signals, bm25: scores[index]! } });
}

interface ReadState {
  readonly root: string;
  readonly files: readonly string[];
  readonly skipped: number;
  /** Set when the corpus sits inside a work tree: the repository the
   *  notes belong to and the corpus's path inside it. */
  readonly repo?: { readonly toplevel: string; readonly prefix: string };
  /** Set for a pinned read: the resolved SHA and each file's content at
   *  that revision, so a candidate's text is what the snapshot held and
   *  a note absent there stays absent. */
  readonly pinned?: {
    readonly revision: string;
    readonly contents: ReadonlyMap<string, string>;
  };
}

const PIN_REASON = 'a working-tree Markdown read cannot resolve a pinned revision';
const NO_HISTORY = /Needed a single revision|does not have any commits|bad default revision|ambiguous argument|unknown revision/i;

/** Every blob under `prefix` at `revision`, from one `ls-tree` pass:
 *  the repository-relative name, the object id for the batched content
 *  read, and whether the entry is a committed symbolic link. */
async function listTree(
  toplevel: string,
  prefix: string,
  revision: string,
  signal: AbortSignal | undefined,
): Promise<readonly { name: string; oid: string; symlink: boolean }[]> {
  const output = await runGit(toplevel, [
    'ls-tree', '-r', '-z', revision,
    ...(prefix === '' ? [] : ['--', prefix]),
  ], { signal });
  const entries: { name: string; oid: string; symlink: boolean }[] = [];
  for (const record of output.split('\0')) {
    if (record === '') continue;
    const match = /^(\d+) (\w+) ([0-9a-f]{40})\t([\s\S]*)$/.exec(record);
    if (match === null) throw new SourceReadError('failed', `Could not parse ${record}`);
    const [, mode, type, oid, name] = match;
    if (type !== 'blob') continue;
    entries.push({ name: name!, oid: oid!, symlink: mode === '120000' });
  }
  return entries;
}

/** The contents of the listed blobs, in list order, from one
 *  `cat-file --batch` stream. */
async function readBlobs(
  toplevel: string,
  files: readonly { oid: string }[],
  signal: AbortSignal | undefined,
): Promise<readonly string[]> {
  if (files.length === 0) return [];
  const stream = await runGitBytes(
    toplevel,
    ['cat-file', '--batch'],
    { input: `${files.map((file) => file.oid).join('\n')}\n`, signal },
  );
  const texts: string[] = [];
  let offset = 0;
  for (const file of files) {
    const end = stream.indexOf(0x0a, offset);
    if (end < 0) throw new SourceReadError('failed', 'cat-file output ended early.');
    const parts = stream.subarray(offset, end).toString('utf8').split(' ');
    offset = end + 1;
    if (parts[1] === 'missing' || parts[1] !== 'blob') {
      throw new SourceReadError('failed', `The repository is missing ${file.oid}.`);
    }
    const size = Number(parts[2]);
    texts.push(stream.subarray(offset, offset + size).toString('utf8'));
    offset += size + 1;
  }
  return texts;
}

/** The last committed change date of every file under `prefix`, from
 *  one `git log --name-only` pass; newest first means the first date a
 *  path meets is its last-change date. `--cc` lets a merge commit count
 *  the paths its resolution changed, which a default log leaves out. A
 *  repository with no commits yet is not an error: there is no history
 *  to read. */
async function logDates(
  toplevel: string,
  prefix: string,
  revision: string | undefined,
  signal: AbortSignal | undefined,
): Promise<ReadonlyMap<string, string>> {
  const args = ['log', '-z', '--cc', '--format=%x1e%cI', '--name-only'];
  if (revision !== undefined) args.push(revision);
  if (prefix !== '') args.push('--', prefix);
  let output: string;
  try {
    output = await runGit(toplevel, args, { signal });
  } catch (error) {
    if (error instanceof GitFailure && error.kind === 'exit' && NO_HISTORY.test(error.stderr)) {
      return new Map();
    }
    throw error;
  }
  const dates = new Map<string, string>();
  for (const block of output.split('\x1e')) {
    if (block.trim() === '') continue;
    const parts = block.split('\0');
    const date = commitDate(parts[0]!.trim());
    for (const path of pathNames(parts.slice(1).join('\0'))) {
      if (!dates.has(path)) dates.set(path, date);
    }
  }
  return dates;
}

/** The corpus root rebuilt on the deepest existing ancestor directory,
 *  realpath'd, and that ancestor for the work-tree probe. A pinned read
 *  reaches a corpus the working tree no longer holds (deleted, moved,
 *  replaced by a file) through the commit the pin names. */
async function existingAnchor(
  directory: string,
): Promise<{ readonly anchor: string; readonly root: string } | undefined> {
  let pending = resolve(directory);
  const tail: string[] = [];
  for (;;) {
    try {
      if ((await lstat(pending)).isDirectory()) {
        const anchor = await realpath(pending);
        return { anchor, root: join(anchor, ...tail) };
      }
    } catch {
      // A missing or unreadable level: the next one up may still sit in a tree.
    }
    const parent = dirname(pending);
    if (parent === pending) return undefined;
    tail.unshift(basename(pending));
    pending = parent;
  }
}

/** Resolve the directory, enumerate its Markdown files without opening
 *  content, and refuse a pinned revision a read cannot honour. An
 *  excluded entry is refused here, before its file is ever read.
 *  The git tier records the repository for every source except the older
 *  directory rules reader. A corpus inside a work tree learns
 *  its repository, and a pinned `revision` resolves once so every path
 *  and byte comes from the tree that revision names — including a corpus
 *  the working tree no longer holds, found through an existing ancestor.
 *  A corpus outside any repository cannot resolve a pin and reports
 *  absent. On an unpinned read the tier is extra: a git failure it meets
 *  (other than a cancel) skips it, and the corpus carries what the walk
 *  found. */
async function openDirectory(
  directory: string,
  request: CandidateReadRequest,
  select: (file: string) => boolean,
  context: CandidateReadContext,
  legacy?: 'knowledge' | 'rules',
): Promise<ReadState | CandidateReadResult> {
  if (legacy === 'rules' && request.revision !== undefined) return { status: 'absent', reason: PIN_REASON };
  if (request.signal?.aborted) throw new SourceReadError('cancelled', 'The read was cancelled.');
  let absentReason: string | undefined;
  let root: string | undefined;
  try {
    root = await realpath(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      absentReason = `there is no directory at ${directory}`;
    } else {
      throw new SourceReadError('failed', `Could not resolve ${directory}: ${message(error)}`);
    }
  }
  if (root !== undefined) {
    let stat;
    try {
      stat = await lstat(root);
    } catch (error) {
      throw new SourceReadError('failed', `Could not inspect ${directory}: ${message(error)}`);
    }
    if (!stat.isDirectory()) {
      absentReason = `${directory} is not a directory`;
      root = undefined;
    }
  }
  // Exclusion is resolved before any file's content is opened: each entry
  // is matched as a real path (the walk's paths are realpath'd), as the
  // lexical absolute form the caller would write, and as a path relative
  // to the source root or the working directory. The real form resolves
  // through the deepest existing ancestor — canonicalPath, the same walk
  // the commit reader runs — so an entry written through a symlinked
  // workspace still matches when the file it names is gone from the
  // working tree but held at the pinned revision. When the corpus sits
  // inside a work tree the entry also matches relative to the repository
  // root, so one relative exclusion means the same thing to this reader
  // and to gitHistory. An entry naming a root — '.', './', '/' — keeps
  // the marker the commit reader's repoPath resolves for it, and every
  // path beneath an anchor is refused.
  const exclude = new Set<string>();
  for (const entry of request.exclude ?? []) {
    if (typeof entry !== 'string' || entry.trim() === '') continue;
    const absolute = resolve(entry);
    exclude.add(absolute);
    exclude.add(await canonicalPath(absolute));
    const cleaned = entry.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    exclude.add(cleaned === '' ? '.' : cleaned);
  }
  let repo: { readonly toplevel: string; readonly prefix: string };
  if (root === undefined) {
    // Only a pinned read can still reach the corpus: the commit the pin
    // names may hold a directory the working tree lost (deleted, moved,
    // replaced by a file). The deepest existing ancestor locates the
    // work tree it belonged to.
    if (request.revision === undefined) {
      return { status: 'absent', reason: absentReason! };
    }
    const anchor = await existingAnchor(directory);
    if (anchor === undefined) return { status: 'absent', reason: PIN_REASON };
    let probe: WorkTreeProbe;
    try {
      probe = await probeWorkTree(anchor.anchor, request.signal);
    } catch (error) {
      throw asSourceReadError(error);
    }
    if (probe.status === 'absent') return { status: 'absent', reason: PIN_REASON };
    const toplevel = await realpath(probe.toplevel);
    root = anchor.root;
    repo = { toplevel, prefix: relative(toplevel, root).split(sep).join('/') };
  } else {
    if (legacy === 'rules') {
      const { files, skipped } = await walkMarkdown(root, request.signal, exclude, undefined, select, true);
      return { root, files, skipped };
    }
    let probe: WorkTreeProbe;
    try {
      probe = await probeWorkTree(root, request.signal);
    } catch (error) {
      // The git tier is extra on an unpinned read: a repository git
      // cannot inspect (an unsafe-ownership refusal, a failing config)
      // is skipped like no repository at all, and the corpus carries
      // what the walk found. A pinned read still throws, and a cancel
      // always does.
      if (request.revision !== undefined || isCancel(error)) {
        throw asSourceReadError(error);
      }
      probe = { status: 'absent', reason: 'no-history' };
    }
    if (probe.status === 'absent') {
      if (request.revision !== undefined) return { status: 'absent', reason: PIN_REASON };
      const { files, skipped } = await walkMarkdown(root, request.signal, exclude, undefined, select, legacy !== undefined);
      return { root, files, skipped };
    }
    const toplevel = await realpath(probe.toplevel);
    repo = { toplevel, prefix: relative(toplevel, root).split(sep).join('/') };
  }
  if (request.revision === undefined) {
    const { files, skipped } = await walkMarkdown(root, request.signal, exclude, repo.toplevel, select, legacy !== undefined);
    return { root, files, skipped, repo };
  }
  try {
    // The pin resolves once here; the tree, the contents and the dates
    // all come from the SHA it returned, so a later commit cannot move
    // the snapshot under the read.
    const revision = await resolveCommit(repo.toplevel, request.revision, request.signal);
    const tree = await listTree(repo.toplevel, repo.prefix, revision, request.signal);
    const wanted: { abs: string; name: string; oid: string }[] = [];
    let skipped = 0;
    for (const entry of tree) {
      if (legacy ? !entry.name.endsWith('.md') : !markdownFile(entry.name)) continue;
      const within = repo.prefix === '' ? entry.name : entry.name.slice(repo.prefix.length + 1);
      if (legacy ? within.split('/').some((part) => part.startsWith('.'))
        : entry.name.split('/').some((part) => part === '.git' || part === 'node_modules')) continue;
      const abs = join(root, within);
      if (!select(abs) || isExcluded(abs, root, exclude, repo.toplevel)) continue;
      if (entry.symlink) {
        skipped += 1;
      } else {
        wanted.push({ abs, name: entry.name, oid: entry.oid });
      }
    }
    const keys = wanted.map((entry) => `${revision}:${entry.abs}`);
    const missing = wanted.filter((_, index) => !context.files.has(keys[index]!));
    const pending = readBlobs(repo.toplevel, missing, request.signal);
    missing.forEach((entry, index) => context.files.set(`${revision}:${entry.abs}`, pending.then((texts) => texts[index]!)));
    const texts = await Promise.all(keys.map((key) => context.files.get(key)!));
    return {
      root,
      files: wanted.map((entry) => entry.abs).sort(),
      skipped,
      repo,
      pinned: {
        revision,
        contents: new Map(wanted.map((entry, index) => [entry.abs, texts[index]!])),
      },
    };
  } catch (error) {
    if (error instanceof GitFailure && error.kind === 'exit'
      && error.stderr !== '' && NO_HISTORY.test(error.stderr)) {
      throw new SourceReadError(
        'failed',
        `The pinned revision ${request.revision} is not in this repository.`,
      );
    }
    throw asSourceReadError(error);
  }
}

async function readTexts(
  state: ReadState,
  signal: AbortSignal | undefined,
  context: CandidateReadContext,
): Promise<ReadonlyMap<string, Note>> {
  const notes = new Map<string, Note>();
  for (const file of state.files) {
    if (signal?.aborted) throw new SourceReadError('cancelled', 'The read was cancelled.');
    let raw: string;
    if (state.pinned !== undefined) {
      raw = state.pinned.contents.get(file)!;
    } else {
      try {
        let pending = context.files.get(`working:${file}`);
        if (pending === undefined) {
          pending = readFile(file, 'utf8');
          context.files.set(`working:${file}`, pending);
        }
        raw = await pending;
      } catch (error) {
        throw new SourceReadError('failed', `Could not read ${file}: ${message(error)}`);
      }
    }
    notes.set(file, parseNote(raw));
  }
  return notes;
}

function finish(
  request: CandidateReadRequest,
  candidates: MemoryCandidate[],
  skipped: number,
  revision?: string,
): CandidateReadResult {
  candidates.sort((left, right) => {
    const score = (candidate: MemoryCandidate) =>
      Object.values(candidate.signals).reduce((sum, value) => sum + value, 0);
    return score(right) - score(left) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  });
  const limit = request.limit;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    throw new TypeError('limit must be a positive safe integer.');
  }
  const reasons: string[] = [];
  let emitted = candidates;
  if (limit !== undefined && candidates.length > limit) {
    emitted = candidates.slice(0, limit);
    reasons.push(`the limit kept ${limit} of ${candidates.length} candidates`);
  }
  if (skipped > 0) reasons.push(`skipped ${skipped} symbolic-link ${skipped === 1 ? 'entry' : 'entries'}`);
  return {
    status: 'read',
    ...(revision === undefined ? {} : { revision }),
    candidates: emitted,
    complete: reasons.length === 0,
    ...(reasons.length === 0 ? {} : { partial: reasons.join('; ') }),
  };
}

/** Markdown from folders, files or glob patterns, classified by the caller. */
export function markdown(options: MarkdownOptions): CandidateSource {
  return markdownSource(options);
}

function markdownSource(options: MarkdownOptions, legacy?: 'knowledge' | 'rules'): CandidateSource {
  if (!Array.isArray(options.paths) || options.paths.length === 0
    || options.paths.some((path) => typeof path !== 'string' || path.trim() === '')) {
    throw new TypeError('paths must contain non-empty strings.');
  }
  if (!['knowledge', 'docs', 'rules', 'instructions'].includes(options.kind)) {
    throw new TypeError('kind must be knowledge, docs, rules or instructions.');
  }
  const maxQuestionText = options.maxQuestionText ?? Number.POSITIVE_INFINITY;
  if (options.maxQuestionText !== undefined && (!Number.isSafeInteger(maxQuestionText) || maxQuestionText < 1)) {
    throw new TypeError('maxQuestionText must be a positive safe integer.');
  }
  const paths = options.paths.map((path) => resolve(path === '~' ? homedir()
    : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path));
  const id = legacy === 'knowledge' ? `knowledge-base:${paths[0]}`
    : legacy === 'rules' ? `rules:${paths[0]}` : `markdown:${options.kind}:${JSON.stringify(paths)}`;
  const keyword = { ...MARKDOWN_KEYWORD_SETTINGS, ...options.keyword };
  const role = options.kind === 'rules' || options.kind === 'instructions' ? 'rule' : 'reference';
  return {
    id, role, kind: 'markdown',
    ...(legacy === undefined ? { maxQuestionText: options.maxQuestionText ?? Number.POSITIVE_INFINITY } : {}),
    async read(request, context = { files: new Map() }) {
      if (request.maxQuestionText !== undefined
        && (!Number.isSafeInteger(request.maxQuestionText) || request.maxQuestionText < 1)) {
        throw new TypeError('maxQuestionText must be a positive safe integer.');
      }
      const partBudget = Math.min(maxQuestionText, request.maxQuestionText ?? maxQuestionText);
      const candidates: MemoryCandidate[] = [];
      const seen = new Set<string>();
      const reasons: string[] = [];
      let skipped = 0;
      let present = false;
      let revision: string | undefined;
      const terms = taskTerms(request.task, request.paths ?? [], keyword.stopWords);
      for (const path of paths) {
        const pattern = legacy === undefined && /[*?{}[\]]/.test(path);
        const prefix = pattern ? path.slice(0, path.search(/[*?{}[\]]/)) : path;
        let root = pattern ? (prefix.endsWith(sep) ? prefix.slice(0, -1) : dirname(prefix)) : path;
        let select: (file: string) => boolean = () => true;
        if (pattern) {
          const realRoot = await canonicalPath(root);
          const realPattern = join(realRoot, relative(root, path));
          select = (file) => matchesGlob(file, realPattern);
        } else if (legacy === undefined && markdownFile(path)) {
          try {
            if (!(await lstat(path)).isDirectory()) root = dirname(path);
          } catch {
            root = dirname(path);
          }
          if (root !== path) {
            const realFile = await canonicalPath(path);
            select = (file) => file === realFile;
          }
        }
        const state = await openDirectory(root, request, select, context, legacy);
        if ('status' in state) {
          if (state.status === 'absent') reasons.push(state.reason);
          continue;
        }
        present = true;
        skipped += state.skipped;
        revision = state.pinned?.revision;
        const files = state.files.filter((file) => {
          if (legacy === 'rules' && basename(file).toLowerCase() === 'readme.md') return false;
          if (seen.has(file)) return false;
          seen.add(file);
          return true;
        });
        const notes = await readTexts({ ...state, files }, request.signal, context);
        // Resolve inbound links by their source-relative path; a wiki link
        // without a path matches only a unique note name across folders.
        const inbound = new Map<string, number>();
        const notePaths = new Set<string>();
        const notesByName = new Map<string, string[]>();
        for (const file of notes.keys()) {
          const name = relative(state.root, file).split(sep).join('/');
          notePaths.add(name);
          const leaf = name.slice(name.lastIndexOf('/') + 1);
          const same = notesByName.get(leaf);
          if (same === undefined) notesByName.set(leaf, [name]);
          else same.push(name);
        }
        for (const [file, note] of notes) {
          const from = relative(state.root, file).split(sep).join('/');
          for (const match of note.body.matchAll(LINK)) {
            const raw = (match[1] ?? match[2] ?? '').trim();
            if (raw === '') continue;
            let target: string | undefined;
            if (match[1] === undefined) {
              target = relative(state.root, resolve(dirname(file), raw)).split(sep).join('/');
              if (target.startsWith('..')) continue;
            } else {
              const linked = raw.endsWith('.md') ? raw : `${raw}.md`;
              const rooted = relative(state.root, resolve(state.root, linked)).split(sep).join('/');
              if (notePaths.has(rooted)) {
                target = rooted;
              } else {
                const same = notesByName.get(linked.slice(linked.lastIndexOf('/') + 1));
                target = same?.length === 1 ? same[0] : undefined;
              }
            }
            if (target === undefined || target === from) continue;
            inbound.set(target, (inbound.get(target) ?? 0) + 1);
          }
        }


        let lastChanged: ReadonlyMap<string, string> = new Map();
        let repo = state.repo;
        if (repo !== undefined && (legacy === undefined
          || [...notes.values()].some((note) => declaredDate(note.fields, legacy === undefined) === undefined))) {
          try {
            lastChanged = await logDates(repo.toplevel, repo.prefix, state.pinned?.revision, request.signal);
          } catch (error) {
            if (state.pinned !== undefined || isCancel(error)) throw asSourceReadError(error);
            repo = undefined;
          }
        }
        for (const [file, note] of notes) {
          if (request.signal?.aborted) throw new SourceReadError('cancelled', 'The read was cancelled.');
          const name = relative(state.root, file).split(sep).join('/');
          const repoPath = repo === undefined ? undefined : relative(repo.toplevel, file).split(sep).join('/');
          const always = role === 'rule' && ((legacy === undefined && note.fields.get('alwaysapply') === 'true')
            || note.fields.get('applies') === 'always');
          const scope = legacy === undefined && role === 'rule' ? ruleScope(file, note) : undefined;
          const taskPaths = (request.paths ?? []).map((path) =>
            relative(repo?.toplevel ?? state.root, resolve(repo?.toplevel ?? state.root, path)).split(sep).join('/'));
          if (!always && scope !== undefined && taskPaths.length > 0
            && !taskPaths.some((path) => scope.some((pattern) => matchesGlob(path, pattern)))) continue;
          const changed = repoPath === undefined ? undefined : lastChanged.get(repoPath);
          const date: MemoryCandidate['date'] = legacy !== undefined
            ? declaredDate(note.fields, legacy === undefined) ?? (changed === undefined ? undefined : { value: changed, meaning: 'changed' })
            : repo === undefined
            ? declaredDate(note.fields, legacy === undefined) ?? { value: (await stat(file)).mtime.toISOString(), meaning: 'modified' }
            : changed === undefined ? undefined : { value: changed, meaning: 'changed' };
          const replaced = REPLACED_FRONTMATTER.test(note.frontmatter) || REPLACED_LINE.test(note.body);
          const directory = dirname(file);
          const location = options.kind === 'instructions'
            ? instructionLocation(directory, request.paths ?? [], repo?.toplevel ?? state.root) : 0;
          const items: readonly (Section | RuleSection)[] = legacy === 'rules'
            ? [{ text: note.body, startLine: note.bodyOffset + 1, endLine: note.bodyOffset + note.body.split('\n').length, key: '' }]
            : role === 'rule' ? ruleSections(note.body, note.bodyOffset) : sections(note.body, note.bodyOffset);
          for (const [sectionIndex, section] of items.entries()) {
            const parts = legacy === 'rules' ? [section.text] : splitParts(section.text, partBudget);
            const key = 'key' in section ? (section as RuleSection).key : String(sectionIndex + 1);
            const fileId = legacy === undefined ? file : name;
            const sectionId = key === '' ? fileId : `${fileId}#${key}`;
            for (const [partIndex, text] of parts.entries()) {
              const heading = section.heading ?? basename(file);
              const signals: Record<string, number> = {};
              const headingHits = hits(heading, terms);
              if (legacy !== 'rules' && headingHits > 0) signals['heading-words'] = Math.min(keyword.headingCap, headingHits * keyword.headingWeight);
              const fileHits = hits(`${name} ${note.frontmatter}`, terms);
              if (legacy !== 'rules' && fileHits > 0) signals['file-words'] = Math.min(keyword.fileCap, fileHits);
              if ((request.paths ?? []).some((path) => text.includes(path))) signals['names-path'] = keyword.namedPathWeight;
              const linked = inbound.get(name) ?? 0;
              if (legacy !== 'rules' && linked > 0) signals['inbound-links'] = Math.min(keyword.inboundLinkCap, Math.log10(1 + linked));
              if (legacy !== 'rules' && replaced) signals['replaced'] = keyword.replacedWeight;
              if (location > 0) signals['instruction-location'] = location;
              candidates.push({
                sourceId: id, role, ...(legacy === undefined ? { kind: options.kind } : {}),
                id: parts.length === 1 ? sectionId : `${sectionId}.${partIndex + 1}`,
                title: legacy === 'rules' ? name : parts.length === 1 ? `${name}: ${heading}` : `${name}: ${heading} (part ${partIndex + 1})`,
                text, contentRef: legacy === 'rules' ? name : `${legacy === undefined ? file : name}#L${section.startLine}-L${section.endLine}`,
                ...(date === undefined ? {} : { date }),
                ...(repoPath === undefined ? {} : { path: repoPath, repository: options.repository ?? repo!.toplevel }),
                ...(options.kind === 'instructions' ? { directory } : {}),
                ...(always ? { applies: 'always' as const } : {}), signals,
              });
            }
          }
        }
      }
      if (!present) return { status: 'absent', reason: reasons.join('; ') };
      const result = finish(request, withBm25(candidates, terms, keyword), skipped, revision);
      if (result.status !== 'read' || reasons.length === 0) return result;
      return { ...result, complete: false, partial: [...reasons, ...(result.partial === undefined ? [] : [result.partial])].join('; ') };
    },
  };
}

/** Directory notes with the original section ids, date precedence, and part size. */
export function knowledgeBase(directory: string, options: KnowledgeBaseOptions = {}): CandidateSource {
  if (typeof directory !== 'string' || directory.trim() === '') throw new TypeError('directory must be a non-empty string.');
  return markdownSource({ ...options, paths: [directory], kind: 'knowledge',
    maxQuestionText: options.maxQuestionText ?? DEFAULT_MAX_QUESTION_TEXT }, 'knowledge');
}

/** Directory rules with the original file ids and README exclusion. */
export function rules(directory: string, options: RulesOptions = {}): CandidateSource {
  if (typeof directory !== 'string' || directory.trim() === '') throw new TypeError('directory must be a non-empty string.');
  return markdownSource({ ...options, paths: [directory], kind: 'rules' }, 'rules');
}
