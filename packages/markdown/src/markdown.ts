import { MARKDOWN_KEYWORD_SETTINGS, markdownSettings, rulesSettings, type MarkdownKeywordSettings } from './defaults.js';
import {
  bm25Term,
  hits,
  taskTerms,
  tokenize,
  phraseCount,
  laneBend,
  sharedFileText,
  sharedFileStore,
  normalized,
  similarity,
  datedIn,
  decayWeight,
  sinceCutoff,
  taskMoment,
  timeZoneOf,
  zonedIso,
  checkIndexOption,
  indexDirectory,
  indexFilePath,
  openIndexFile,
  updateIndex,
  wordBag,
  bagCount,
  bagEntries,
  eachPartVector,
  textKey,
  type IndexDatabase,
  type IndexStatement,
  type StoredIndexOptions,
  type StoredIndexReport,
} from '@curatejs/core/internal';
import { existsSync } from 'node:fs';
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
  historySource,
  SourceReadError,
  type CandidateReadContext,
  type CandidateReadRequest,
  type CandidateReadResult,
  type CandidateSource,
} from '@curatejs/core';

export interface RulesOptions {
  /** Override the exported MARKDOWN_KEYWORD_SETTINGS. */
  readonly keyword?: Partial<MarkdownKeywordSettings>;
  /** Read only parts whose emitted date is at or after an ISO date or a
   *  duration before the task date (for example, '14 days'); the task
   *  date is the read request's `taskDate`, else its `asOf`, else now.
   *  A part emitted with no date is read. Omitted means no lower
   *  bound. */
  readonly since?: string;
  /** Paths this source alone refuses, joined onto the read request's
   *  `exclude` for its reads only: an excluded file is never opened. */
  readonly exclude?: readonly string[];
  /** The stored index: one local file for this source, made on its
   *  first read and brought up to date at the start of each call. Every
   *  lane then reads each note's parts from the file instead of parsing
   *  it again. `false` reads the files directly on every read. A read
   *  pinned to a revision reads git as before. */
  readonly index?: StoredIndexOptions | false;
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
  /** Repository key shared with git() for changed-path links. */
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
  // Open Knowledge Format: v0.2's last meaningful change, then v0.1's.
  ['generated.at', 'changed'],
  ['timestamp', 'changed'],
];
/** A log section heading that starts with its day: `2026-10-27`,
 *  `[2026-10-28] update | Title` or `[2026-10-28 19:40:00] ingest | Title`. */
const LOG_HEADING = /^\[?(\d{4}-\d{2}-\d{2})/;

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
  legacy?: 'knowledge' | 'rules',
): Promise<Walked> {
  const files: string[] = [];
  let skipped = 0;
  async function walk(directory: string): Promise<void> {
    if (signal?.aborted) throw new SourceReadError('cancelled', 'The read was cancelled.');
    let entries;
    try {
      entries = (await readdir(directory, { withFileTypes: true }))
        // A file that is not markdown is dropped before the sort, the
        // path work and the ignore check: directories still descend.
        .filter((entry) => !entry.isFile() || (legacy === 'knowledge' ? entry.name.endsWith('.md')
          : legacy === 'rules' ? /\.mdc?$/.test(entry.name) || entry.name === '.cursorrules'
            : markdownFile(entry.name)));
    } catch (error) {
      throw new SourceReadError('failed', `Could not list ${directory}: ${message(error)}`);
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    const ignored = legacy ? new Set<string>()
      : await ignoredPaths(directory, entries.map((entry) => join(directory, entry.name)), toplevel, signal);
    for (const entry of entries) {
      // rules() still lists .cursorrules, only so the read can record that it skipped it.
      if (legacy !== undefined ? entry.name.startsWith('.') && !(legacy === 'rules' && entry.name === '.cursorrules')
        : entry.name === '.git' || entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (ignored.has(path) || isExcluded(path, root, exclude, toplevel)) continue;
      if (entry.isSymbolicLink()) {
        skipped += 1;
      } else if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && select(path)) {
        files.push(path);
      }
    }
  }
  await walk(root);
  return { files, skipped };
}

/** Files an agent harness loads every session on its own. */
const HARNESS_FILES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules'];

/** The name a harness loads the file by, when it loads it every session. */
function harnessFile(file: string): string | undefined {
  if (HARNESS_FILES.includes(basename(file))) return basename(file);
  return file.endsWith(`${sep}.github${sep}copilot-instructions.md`) ? '.github/copilot-instructions.md' : undefined;
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
  const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, '$2');
  let listField: string | undefined;
  // A key with an empty value opens a block mapping: its indented
  // `key: value` lines are stored as `parent.key`, one level deep.
  let mapField: string | undefined;
  for (const line of frontmatter.split(/\r?\n/)) {
    const field = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    const nested = /^\s+([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    if (field) {
      listField = field[1]!.toLowerCase();
      const value = unquote(field[2]!);
      fields.set(listField, value);
      mapField = value === '' ? listField : undefined;
      // A flow mapping, `{ by: x, at: y }`, stores each pair the same way.
      const flow = /^\{(.*)\}$/.exec(value)?.[1];
      for (const pair of flow === undefined ? [] : scopePatterns(flow)) {
        const [key, ...rest] = pair.split(':');
        if (/^[A-Za-z_][\w-]*$/.test(key!.trim())) fields.set(`${listField}.${key!.trim().toLowerCase()}`, unquote(rest.join(':')));
      }
    } else if (nested && mapField !== undefined) {
      fields.set(`${mapField}.${nested[1]!.toLowerCase()}`, unquote(nested[2]!));
    } else {
      mapField = undefined;
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

function ruleScope(file: string, note: Pick<Note, 'fields'>): readonly string[] | undefined {
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

interface ReadState {
  readonly root: string;
  readonly files: readonly string[];
  readonly skipped: number;
  /** Set when the corpus sits inside a work tree: the repository the
   *  notes belong to and the corpus's path inside it. */
  readonly repo?: { readonly toplevel: string; readonly prefix: string };
  /** Set for a rules() read inside a work tree: the repository root its
   *  globs and applyTo scopes match task paths against. */
  readonly scopeRoot?: string;
  /** Set for a pinned read: the resolved SHA and each file's blob id at
   *  that revision. Texts are fetched in bounded batches on each pass,
   *  so a large pinned corpus is never held whole. A candidate's text
   *  is what the snapshot held and a note absent there stays absent. */
  readonly pinned?: {
    readonly revision: string;
    readonly oids: ReadonlyMap<string, string>;
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
    const [, fileMode, type, oid, name] = match;
    if (type !== 'blob') continue;
    entries.push({ name: name!, oid: oid!, symlink: fileMode === '120000' });
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

/** `logDates` for the head, kept in the source's stored index: the log
 *  runs again only when the head has moved. The dates depend on the
 *  commits the log can walk from the head, and those change without the
 *  head moving when a shallow clone is deepened or replacement refs or
 *  grafts are set, so such a repository's dates are never stored or
 *  reused: its log runs on every call, as before. So does a repository
 *  whose head does not resolve. */
async function storedLogDates(
  path: string, directory: string, toplevel: string, prefix: string, signal: AbortSignal | undefined,
): Promise<ReadonlyMap<string, string>> {
  let head: string;
  let whole: boolean;
  try {
    const [resolved, facts, replaced] = await Promise.all([
      resolveCommit(toplevel, 'HEAD', signal),
      runGit(toplevel, ['rev-parse', '--is-shallow-repository', '--git-path', 'info/grafts'], { signal }),
      runGit(toplevel, ['for-each-ref', '--count=1', '--format=x', 'refs/replace/'], { signal }),
    ]);
    const [shallow = '', grafts = ''] = facts.trim().split('\n');
    head = resolved;
    whole = shallow === 'false' && !existsSync(resolve(toplevel, grafts)) && replaced.trim() === '';
  } catch (error) {
    if (error instanceof GitFailure && error.kind === 'cancelled') throw error;
    return logDates(toplevel, prefix, undefined, signal);
  }
  if (!whole) return logDates(toplevel, prefix, undefined, signal);
  const database = await openIndexFile(path, directory);
  try {
    return await updateIndex(path, database, async () => {
      database.exec(`CREATE TABLE IF NOT EXISTS dates (toplevel TEXT NOT NULL, prefix TEXT NOT NULL, head TEXT NOT NULL,
        dates TEXT NOT NULL, PRIMARY KEY (toplevel, prefix)) WITHOUT ROWID`);
      const row = database.prepare('SELECT head, dates FROM dates WHERE toplevel = ? AND prefix = ?')
        .get(toplevel, prefix) as { head: string; dates: string } | undefined;
      if (row?.head === head) return new Map(JSON.parse(row.dates) as [string, string][]);
      const dates = await logDates(toplevel, prefix, head, signal);
      database.prepare(`INSERT INTO dates (toplevel, prefix, head, dates) VALUES (?, ?, ?, ?)
        ON CONFLICT (toplevel, prefix) DO UPDATE SET head = excluded.head, dates = excluded.dates`)
        .run(toplevel, prefix, head, JSON.stringify([...dates]));
      return dates;
    });
  } finally {
    database.close();
  }
}

/** The files under `prefix` with uncommitted changes, staged or not, and
 *  the files with no commit yet, as repository paths, from one `git
 *  status` pass over the pathspecs. `specs` names the reader's Markdown
 *  names case-insensitively; the set is a superset of what the read can
 *  ask about, and only listed files are ever looked up in it. */
async function uncommitted(
  toplevel: string,
  prefix: string,
  specs: readonly string[],
  signal: AbortSignal | undefined,
): Promise<ReadonlySet<string>> {
  if (specs.length === 0) return new Set();
  // Without this flag, `git status` rewrites the repository's index when a
  // file's times have moved, and a read must not change what it reads.
  const output = await runGit(toplevel, ['--no-optional-locks', 'status', '--porcelain', '-z', '--no-renames', '--untracked-files=all',
    '--', ...specs.map((spec) => `:(icase)${prefix === '' ? '' : `${prefix}/`}${spec}`)], { signal });
  // Each entry is two status letters, a space and the path.
  return new Set(output.split('\0').filter((entry) => entry.length > 3).map((entry) => entry.slice(3)));
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
  own: readonly string[] = [],
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
  // and to git(). An entry naming a root — '.', './', '/' — keeps
  // the marker the commit reader's repoPath resolves for it, and every
  // path beneath an anchor is refused.
  const exclude = new Set<string>();
  for (const entry of [...own, ...(request.exclude ?? [])]) {
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
      const { files, skipped } = await walkMarkdown(root, request.signal, exclude, undefined, select, legacy);
      // Scopes name paths from the repository root, as Cursor and Copilot
      // read them; a repository git cannot inspect leaves the library folder.
      let probe: WorkTreeProbe | undefined;
      try {
        probe = await probeWorkTree(root, request.signal);
      } catch (error) {
        if (isCancel(error)) throw asSourceReadError(error);
      }
      return { root, files, skipped,
        ...(probe?.status === 'worktree' ? { scopeRoot: await realpath(probe.toplevel) } : {}) };
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
      const { files, skipped } = await walkMarkdown(root, request.signal, exclude, undefined, select, legacy);
      return { root, files, skipped };
    }
    const toplevel = await realpath(probe.toplevel);
    repo = { toplevel, prefix: relative(toplevel, root).split(sep).join('/') };
  }
  if (request.revision === undefined) {
    const { files, skipped } = await walkMarkdown(root, request.signal, exclude, repo.toplevel, select, legacy);
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
    return {
      root,
      files: wanted.map((entry) => entry.abs).sort(),
      skipped,
      repo,
      pinned: {
        revision,
        oids: new Map(wanted.map((entry) => [entry.abs, entry.oid])),
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

/** Pinned blobs per batch: one `cat-file --batch` call covers this many
 *  files, so a pass over a pinned tree never holds more than a batch. */
const PINNED_BATCH = 256;

/** The text of each listed file, one at a time: the shared pick cache
 *  while it has room, disk or a batched blob read otherwise. Pinned
 *  files arrive in batches so a pass never holds the whole tree. */
async function* fileTexts(
  state: ReadState,
  files: readonly string[],
  context: CandidateReadContext | undefined,
  signal: AbortSignal | undefined,
): AsyncGenerator<{ readonly file: string; readonly text: string }> {
  if (state.pinned === undefined) {
    for (const file of files) {
      if (signal?.aborted) throw new SourceReadError('cancelled', 'The read was cancelled.');
      try {
        yield { file, text: await sharedFileText(context, `working:${file}`, () => readFile(file, 'utf8')) };
      } catch (error) {
        throw new SourceReadError('failed', `Could not read ${file}: ${message(error)}`);
      }
    }
    return;
  }
  const { revision, oids } = state.pinned;
  for (let start = 0; start < files.length; start += PINNED_BATCH) {
    if (signal?.aborted) throw new SourceReadError('cancelled', 'The read was cancelled.');
    const chunk = files.slice(start, start + PINNED_BATCH);
    const fresh = new Map<string, string>();
    const missing = chunk.filter((file) => context?.files.get(`${revision}:${file}`) === undefined);
    if (missing.length > 0) {
      const texts = await readBlobs(
        state.repo!.toplevel,
        missing.map((file) => ({ oid: oids.get(file)! })),
        signal,
      );
      missing.forEach((file, index) => {
        sharedFileStore(context, `${revision}:${file}`, texts[index]!);
        fresh.set(file, texts[index]!);
      });
    }
    for (const file of chunk) {
      const cached = context?.files.get(`${revision}:${file}`);
      const text = fresh.get(file) ?? (cached === undefined ? undefined : await cached);
      if (text === undefined) {
        throw new SourceReadError('failed', `The repository is missing ${file}.`);
      }
      yield { file, text };
    }
  }
}

/** A part as the candidates know it: identity, title, text and source
 *  pointer, with the heading the keyword signals score. */
interface EnumeratedPart {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly heading: string;
  readonly contentRef: string;
  /** A knowledge-base log entry's own day, which outranks the page's date. */
  readonly date?: MemoryCandidate['date'];
}

/** The note's candidate parts in their stable order: body sections cut
 *  to the part budget, or rules, which `rules()` never cuts. */
function* noteParts(
  note: Note,
  file: string,
  name: string,
  legacy: 'knowledge' | 'rules' | undefined,
  rule: boolean,
  partBudget: number,
): Generator<EnumeratedPart> {
  const items: readonly (Section | RuleSection)[] = rule ? ruleSections(note.body, note.bodyOffset) : sections(note.body, note.bodyOffset);
  const fileId = legacy === undefined ? file : name;
  // A Cursor rule's description tells the decision model what the rule is for.
  const description = legacy === 'rules' && file.endsWith('.mdc') ? note.fields.get('description') : undefined;
  // A page's title, type and description say what each of its sections belongs to.
  const page = legacy === 'rules' ? [] : ['title', 'type', 'description'].map((field) => note.fields.get(field)).filter(Boolean);
  const label = page.length === 0 ? name : `${name} (${page.join('; ')})`;
  const log = legacy === 'knowledge' && basename(file) === 'log.md';
  for (const [sectionIndex, section] of items.entries()) {
    const parts = legacy === 'rules' ? [section.text] : splitParts(section.text, partBudget);
    const key = 'key' in section ? (section as RuleSection).key : String(sectionIndex + 1);
    const sectionId = key === '' ? fileId : `${fileId}#${key}`;
    const day = log ? LOG_HEADING.exec(section.heading ?? '')?.[1] : undefined;
    for (const [partIndex, text] of parts.entries()) {
      const heading = section.heading ?? basename(file);
      yield {
        id: parts.length === 1 ? sectionId : `${sectionId}.${partIndex + 1}`,
        title: description !== undefined && description !== '' ? `${name}: ${description}`
          : parts.length === 1 ? `${label}: ${heading}` : `${label}: ${heading} (part ${partIndex + 1})`,
        text,
        heading,
        contentRef: `${fileId}#L${section.startLine}-L${section.endLine}`,
        ...(day === undefined ? {} : { date: { value: day, meaning: 'recorded' as const } }),
      };
    }
  }
}

/** A part and, when it came from the stored index, its text's tokens
 *  (how many there are and a `wordBag` of them) and the key of the
 *  vector a meaning lane finds for its text. */
type NotePart = EnumeratedPart & { readonly tokens?: { readonly length: number; readonly words: string }; readonly vec?: string };

/** What the passes read from one note, from its text or from the
 *  stored index. */
interface NoteEntry {
  readonly fields: ReadonlyMap<string, string>;
  readonly frontmatter: string;
  /** Each link's two capture groups, as LINK matches them. */
  links(): Iterable<readonly [string | undefined, string | undefined]>;
  /** Whether the frontmatter or a body line marks the note replaced. */
  replaced(): boolean;
  parts(): Iterable<NotePart>;
}

/** A note as the stored index holds it, with each part's tokens worked
 *  out once when it was stored. */
interface StoredNote {
  readonly fields: readonly (readonly [string, string])[];
  readonly frontmatter: string;
  readonly links: readonly (readonly [string | null, string | null])[];
  readonly replaced: boolean;
  readonly parts: readonly (EnumeratedPart & { readonly tokens: { readonly length: number; readonly words: string };
    readonly vec: string })[];
}

/** A note read from its text: its parts are cut only when a pass asks. */
function textEntry(
  text: string, file: string, name: string, legacy: 'knowledge' | 'rules' | undefined, rule: boolean, partBudget: number,
): NoteEntry {
  const note = parseNote(text);
  return {
    fields: note.fields,
    frontmatter: note.frontmatter,
    links: () => [...note.body.matchAll(LINK)].map((match) => [match[1], match[2]] as const),
    replaced: () => REPLACED_FRONTMATTER.test(note.frontmatter) || REPLACED_LINE.test(note.body),
    parts: () => noteParts(note, file, name, legacy, rule, partBudget),
  };
}

/** The stored form of a note read from its text. */
function storeEntry(entry: NoteEntry): StoredNote {
  return {
    fields: [...entry.fields],
    frontmatter: entry.frontmatter,
    links: [...entry.links()].map(([wiki, path]) => [wiki ?? null, path ?? null] as const),
    replaced: entry.replaced(),
    parts: [...entry.parts()].map((part) => {
      const tokens = tokenize(part.text);
      return { ...part, tokens: { length: tokens.length, words: wordBag(tokens) }, vec: textKey(part.text) };
    }),
  };
}

function storedEntry(stored: StoredNote): NoteEntry {
  return {
    fields: new Map(stored.fields),
    frontmatter: stored.frontmatter,
    links: () => stored.links.map(([wiki, path]) => [wiki ?? undefined, path ?? undefined] as const),
    replaced: () => stored.replaced,
    parts: () => stored.parts,
  };
}

/** A part's BM25 inputs: its token count and how often a term occurs. */
function measurePart(part: NotePart): { readonly length: number; count(term: string): number } {
  if (part.tokens !== undefined) {
    const { words } = part.tokens;
    return { length: part.tokens.length, count: (term) => bagCount(words, term) };
  }
  const tokens = tokenize(part.text);
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return { length: tokens.length, count: (term) => counts.get(term) ?? 0 };
}

/** What bringing one root's notes up to date did, and each note's
 *  modified time as its file reported it. */
interface NotesUpdate {
  readonly added: number;
  readonly removed: number;
  readonly ms: number;
  readonly modified: ReadonlyMap<string, string>;
}

/** Bring one root's notes in a source's stored index up to date, in one
 *  write transaction. A note with its stored size and modification time
 *  is kept; a new or changed one is read again, and its parts and their
 *  tokens are stored. With `prune`, a stored note the walk no longer
 *  met is deleted. */
async function syncNotes(
  path: string, directory: string, root: string, files: readonly string[], prune: boolean,
  build: (file: string, text: string) => NoteEntry, context: CandidateReadContext, signal: AbortSignal | undefined,
): Promise<NotesUpdate> {
  const database = await openIndexFile(path, directory);
  try {
    return await updateIndex(path, database, async () => {
      const started = performance.now();
      database.exec(`CREATE TABLE IF NOT EXISTS notes (path TEXT PRIMARY KEY, root TEXT NOT NULL,
        size INTEGER NOT NULL, mtime TEXT NOT NULL, modified TEXT NOT NULL, entry TEXT NOT NULL,
        parts INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS postings (term TEXT NOT NULL, path TEXT NOT NULL,
        ordinal INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (term, path, ordinal)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS postingsPath ON postings (path);
      CREATE TABLE IF NOT EXISTS counts (name TEXT PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID`);
      // The file's part total, kept beside the notes so no call sums the
      // `parts` column, which sits after each note's whole text. A file
      // written before the count existed is summed once.
      let total = (database.prepare("SELECT n FROM counts WHERE name = 'parts'").get() as { n: number } | undefined)?.n
        ?? (database.prepare('SELECT COALESCE(SUM(parts), 0) AS n FROM notes').get() as { n: number }).n;
      const insertPosting = database.prepare('INSERT OR IGNORE INTO postings (term, path, ordinal, count) VALUES (?, ?, ?, ?)');
      const wipePostings = database.prepare('DELETE FROM postings WHERE path = ?');
      // A note's posting list is its parts' stored words with their
      // counts; the same rows give a part's length and each term's
      // document frequency at score time.
      const postParts = (file: string, stored: StoredNote) => {
        stored.parts.forEach((part, ordinal) => {
          const words = part.tokens?.words ?? wordBag(tokenize(part.text));
          for (const [term, count] of bagEntries(words)) insertPosting.run(term, file, ordinal, count);
        });
      };
      // `parts` is stored after the note's whole text, so reading it for
      // every note would walk every stored text. It is read only for a
      // note that changed or went.
      const rows = new Map((database.prepare('SELECT path, size, mtime, modified FROM notes WHERE root = ?')
        .all(root) as { path: string; size: number; mtime: string; modified: string }[])
        .map((row) => [row.path, row]));
      // A note's stored parts, under whichever root of the file stored it:
      // rewriting it here replaces them.
      const partsOf = database.prepare('SELECT parts FROM notes WHERE path = ?');
      const storedParts = (file: string) => (partsOf.get(file) as { parts: number } | undefined)?.parts ?? 0;
      const write = database.prepare(`INSERT INTO notes (path, root, size, mtime, modified, entry, parts)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (path) DO UPDATE SET root = excluded.root, size = excluded.size,
        mtime = excluded.mtime, modified = excluded.modified, entry = excluded.entry, parts = excluded.parts`);
      const modified = new Map<string, string>();
      let added = 0;
      let removed = 0;
      for (const file of files) {
        if (signal?.aborted) throw new SourceReadError('cancelled', 'The read was cancelled.');
        let info;
        try {
          info = await stat(file, { bigint: true });
        } catch (error) {
          throw new SourceReadError('failed', `Could not read ${file}: ${message(error)}`);
        }
        const row = rows.get(file);
        const size = Number(info.size);
        const mtime = String(info.mtimeNs);
        if (row !== undefined && row.size === size && row.mtime === mtime) {
          modified.set(file, row.modified);
          continue;
        }
        let text: string;
        // The modified time a candidate carries, as a plain stat gives it.
        let changed: string;
        try {
          text = await sharedFileText(context, `working:${file}`, () => readFile(file, 'utf8'));
          changed = (await stat(file)).mtime.toISOString();
        } catch (error) {
          throw new SourceReadError('failed', `Could not read ${file}: ${message(error)}`);
        }
        const stored = storeEntry(build(file, text));
        const old = storedParts(file);
        if (row !== undefined) removed += old;
        total -= old;
        write.run(file, root, size, mtime, changed, JSON.stringify(stored), stored.parts.length);
        wipePostings.run(file);
        postParts(file, stored);
        modified.set(file, changed);
        added += stored.parts.length;
        total += stored.parts.length;
      }
      if (prune) {
        const walked = new Set(files);
        const remove = database.prepare('DELETE FROM notes WHERE path = ?');
        for (const file of rows.keys()) {
          if (walked.has(file)) continue;
          const old = storedParts(file);
          removed += old;
          total -= old;
          remove.run(file);
          wipePostings.run(file);
        }
      }
      database.prepare("INSERT INTO counts (name, n) VALUES ('parts', ?) ON CONFLICT (name) DO UPDATE SET n = excluded.n").run(total);
      return { added, removed, ms: Math.round(performance.now() - started), modified };
    });
  } finally {
    database.close();
  }
}

/** What a pass knows about one file without holding its text: the
 *  fields the emitted candidates and their signals need, gathered on
 *  the statistics pass. */
interface FileMeta {
  /** Its slot in the flat file list, which a part descriptor names. */
  readonly index: number;
  readonly file: string;
  readonly name: string;
  readonly directory: string;
  /** Why the file was skipped as always-on, when its frontmatter declares it. */
  readonly alwaysOn?: string;
  /** Scope glob patterns when the file's rule scopes it; the skip
   *  decision waits on the resolved repository root. */
  readonly scope?: readonly string[];
  /** Its parts could not be counted on the first pass because the scope
   *  gate needed the repository resolved; a short second pass fills
   *  them in. */
  readonly deferred: boolean;
  scopeSkipped: boolean;
  readonly replaced: boolean;
  readonly fileHits: number;
  readonly declared?: MemoryCandidate['date'];
  repoPath?: string;
  repository?: string;
  location: number;
  inbound: number;
  date?: MemoryCandidate['date'];
  /** Where this file's parts sit in the flat part list. */
  partStart: number;
  partCount: number;
}

/** What a pass knows about one part without holding its text. */
interface PartStat {
  /** Index into the flat file list. */
  readonly file: number;
  readonly id: string;
  /** Token count: the BM25 document length. */
  readonly len: number;
  readonly headingHits: number;
  readonly namedPath: boolean;
  /** The part's own date when it has one apart from its file's. */
  readonly date?: MemoryCandidate['date'];
  /** A kind lane's exact-phrase count in this part's text and title;
   *  recorded during the statistics pass so the lane can rank its
   *  matches without holding their texts. */
  readonly phrased?: number;
}

/** One corpus root's files with the per-file knowledge its parts need. */
interface CorpusGroup {
  readonly state: ReadState;
  readonly files: readonly string[];
  readonly metas: FileMeta[];
  /** The repository after the date-lookup fallback: undefined when the
   *  log failed, so paths and dates degrade like the old read's. */
  repo?: { readonly toplevel: string; readonly prefix: string };
}

/** Internal to this package and not part of its public surface: the
 *  one-pass read's switch and a count of the reads it served. A test
 *  turns it off to get the per-read path as its oracle. */
export const onePass = { on: true, served: 0 };

/** What one call knows about a reader's whole corpus, built once and
 *  shared by every read of the call. It holds nothing a request sets:
 *  each read derives its own word hits from it. */
interface Corpus {
  readonly groups: readonly CorpusGroup[];
  readonly metas: readonly FileMeta[];
  /** Each file's `stale_after` moment, NaN without one. */
  readonly stale: readonly number[];
  /** The words of each file's name and frontmatter. */
  readonly fileWords: readonly ReadonlySet<string>[];
  /** Every part with no request-set hit on it. */
  readonly parts: readonly PartStat[];
  /** Each part as stored, for its title and text. */
  readonly refs: readonly NotePart[];
  /** The parts whose heading holds a word. */
  readonly headings: ReadonlyMap<string, readonly number[]>;
  readonly totalLength: number;
  /** Each part's place in id order; equal ids share a place. */
  readonly rank: Uint32Array;
  /** Each word's postings as part indexes, read from the index once. */
  readonly postings: Map<string, { readonly hitsOf: readonly { readonly index: number; readonly f: number }[]; readonly held: number }>;
  /** Each embedded part's unit vector, kept for the call when the
   *  embedder keeps no store, so a later query list scores the same
   *  vectors without embedding again. */
  readonly units: Map<number, Float64Array>;
}

/** Markdown from folders, files or glob patterns, classified by the caller. */
export function markdown(options: MarkdownOptions): CandidateSource {
  return historySource({ reader: markdownSource(options), ...markdownSettings });
}

export function markdownSource(options: MarkdownOptions, legacy?: 'knowledge' | 'rules'): CandidateSource {
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
  sinceCutoff(options.since, Date.now());
  const exclude = options.exclude?.map((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '') throw new TypeError('exclude must contain non-empty strings.');
    return entry;
  });
  checkIndexOption(options.index);
  // With the index on, the walk, the git date lookups and the update run
  // once per call: every read of one pick shares its read context.
  const calls = new WeakMap<object, Map<string, Promise<unknown>>>();
  const once = <T>(context: object, key: string, work: () => Promise<T>): Promise<T> => {
    let byKey = calls.get(context);
    if (byKey === undefined) calls.set(context, byKey = new Map());
    let promise = byKey.get(key) as Promise<T> | undefined;
    if (promise === undefined) byKey.set(key, promise = work());
    return promise;
  };
  // With a caller's read context, each stored note is parsed once per
  // update, so once per call for each index file: a later read of the
  // call reuses it. The parsed notes go when the context does.
  const parsedNotes = new WeakMap<NotesUpdate, Map<string, NoteEntry>>();
  const reader: CandidateSource = {
    id, role, kind: 'markdown',
    ...(legacy === undefined ? { maxQuestionText: options.maxQuestionText ?? Number.POSITIVE_INFINITY } : {}),
    ...(options.since === undefined ? {} : { since: options.since }),
    ...(exclude === undefined ? {} : { exclude }),
    async read(request, given) {
      const context: CandidateReadContext = given ?? { files: new Map() };
      if (request.maxQuestionText !== undefined
        && (!Number.isSafeInteger(request.maxQuestionText) || request.maxQuestionText < 1)) {
        throw new TypeError('maxQuestionText must be a positive safe integer.');
      }
      const partBudget = Math.min(maxQuestionText, request.maxQuestionText ?? maxQuestionText);
      // The stored index, for every read that is not pinned to a revision.
      const indexFolder = request.revision === undefined ? indexDirectory(options.index) : undefined;
      const indexPath = indexFolder === undefined ? undefined
        : indexFilePath(indexFolder, id, { kind: options.kind, legacy, budget: partBudget, exclude: exclude ?? [] });
      const requestExclude = JSON.stringify(request.exclude ?? []);
      const updates = new Map<string, NotesUpdate>();
      const nameOf = (state: ReadState, file: string) => relative(state.root, file).split(sep).join('/');
      /** Each listed note, from the stored index when this call brought
       *  its root up to date, else from its text. */
      const entries = async function* (state: ReadState, files: readonly string[]) {
        const update = indexPath === undefined ? undefined : updates.get(state.root);
        if (update !== undefined) {
          let parsed = given === undefined ? undefined : parsedNotes.get(update);
          if (given !== undefined && parsed === undefined) parsedNotes.set(update, parsed = new Map());
          // A pass that parses a note opens its own connection and closes
          // it when it ends.
          let database: IndexDatabase | undefined;
          let get: IndexStatement | undefined;
          try {
            for (const file of files) {
              if (request.signal?.aborted) throw new SourceReadError('cancelled', 'The read was cancelled.');
              let entry = parsed?.get(file);
              if (entry === undefined) {
                database ??= await openIndexFile(indexPath!, indexFolder!);
                get ??= database.prepare('SELECT entry FROM notes WHERE path = ?');
                const row = get.get(file) as { entry: string } | undefined;
                if (row === undefined) throw new SourceReadError('failed', `The stored index is missing ${file}.`);
                entry = storedEntry(JSON.parse(row.entry) as StoredNote);
                parsed?.set(file, entry);
              }
              yield { file, entry };
            }
          } finally {
            database?.close();
          }
          return;
        }
        for await (const { file, text } of fileTexts(state, files, context, request.signal)) {
          yield { file, entry: textEntry(text, file, nameOf(state, file), legacy, role === 'rule', partBudget) };
        }
      };
      const seen = new Set<string>();
      const reasons: string[] = [];
      // The agent's harness loads always-on files itself; a rule read skips them and says which.
      const alwaysOn: { readonly file: string; readonly reason: string }[] = [];
      let skipped = 0;
      let present = false;
      let revision: string | undefined;
      // A kind lane's `task` is the phrase; its `topic` is the task the
      // lane serves, and that is what the matches are scored on.
      const terms = taskTerms(request.topic ?? request.task, request.paths ?? [], keyword.stopWords);
      const termSet = new Set(terms);
      const phraseLane = request.phraseLane === true;
      const kindLane = phraseLane && request.topic !== undefined;
      const meaningLane = request.meaningLane !== undefined;
      const groups: CorpusGroup[] = [];
      const metas: FileMeta[] = [];
      let parts: PartStat[] = [];
      const documentFrequency = new Map<string, number>();
      let totalLength = 0;
      let taskNow: number | undefined;
      const selected: { readonly state: ReadState; readonly files: readonly string[] }[] = [];
      /** The notes a link can name: each by its path, and by its file name. */
      const namesOf = (state: ReadState, files: readonly string[]) => {
        const notePaths = new Set<string>();
        const notesByName = new Map<string, string[]>();
        for (const file of files) {
          const name = relative(state.root, file).split(sep).join('/');
          notePaths.add(name);
          const leaf = name.slice(name.lastIndexOf('/') + 1);
          const same = notesByName.get(leaf);
          if (same === undefined) notesByName.set(leaf, [name]);
          else same.push(name);
        }
        return { notePaths, notesByName };
      };

      // The statistics pass reads each file once: it keeps the fields the
      // emitted parts will need, counts the query terms' document
      // frequencies and lengths, and records each part's identity — never
      // the texts themselves.
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
        const state = indexPath === undefined
          ? await openDirectory(root, request, select, context, legacy, exclude)
          : await once(context, JSON.stringify(['open', path, requestExclude]),
            () => openDirectory(root, request, select, context, legacy, exclude));
        if ('status' in state) {
          if (state.status === 'absent') reasons.push(state.reason);
          continue;
        }
        present = true;
        skipped += state.skipped;
        revision = state.pinned?.revision;
        const files = state.files.filter((file) => {
          if (legacy === 'rules' && basename(file).toLowerCase() === 'readme.md') return false;
          // A knowledge base's index.md, at any level, lists pages and is not one.
          if (legacy === 'knowledge' && basename(file) === 'index.md') return false;
          if (seen.has(file)) return false;
          seen.add(file);
          const harness = role === 'rule' ? harnessFile(file) : undefined;
          if (harness !== undefined) {
            alwaysOn.push({ file: relative(state.root, file).split(sep).join('/'), reason: `a harness loads ${harness} every session` });
            return false;
          }
          return true;
        });
        selected.push({ state, files });
      }
      if (indexPath !== undefined) {
        // Several paths can share a root, so each root is brought up to
        // date once with every note any of them selects. A note a request
        // excludes is never opened; stored notes no path meets are deleted
        // on a read that excludes none.
        const byRoot = new Map<string, { state: ReadState; files: string[] }>();
        for (const { state, files } of selected) {
          if (state.pinned !== undefined) continue;
          const root = byRoot.get(state.root);
          if (root === undefined) byRoot.set(state.root, { state, files: [...files] });
          else root.files.push(...files);
        }
        for (const [root, { state, files }] of byRoot) {
          // The update is keyed by the index file it writes, which the
          // part budget names.
          updates.set(root, await once(context, JSON.stringify(['notes', indexPath, root, requestExclude]),
            () => syncNotes(indexPath, indexFolder!, root, files, requestExclude === '[]',
              (file, text) => textEntry(text, file, nameOf(state, file), legacy, role === 'rule', partBudget),
              context, request.signal)));
        }
      }
      /** The notes one note links to, by path. Links count from every
       *  file, including ones a scope rule skips, like the old read's
       *  notes map. */
      const linksOf = (
        entry: NoteEntry, state: ReadState, file: string, name: string,
        notePaths: ReadonlySet<string>, notesByName: ReadonlyMap<string, readonly string[]>,
      ): string[] => {
        const links: string[] = [];
        for (const match of entry.links()) {
          const raw = (match[0] ?? match[1] ?? '').trim();
          if (raw === '') continue;
          let target: string | undefined;
          if (match[0] === undefined) {
            // A link that starts with `/` is written from the source root.
            target = relative(state.root, raw.startsWith('/') ? join(state.root, raw) : resolve(dirname(file), raw)).split(sep).join('/');
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
          if (target === undefined || target === name) continue;
          links.push(target);
        }
        return links;
      };
      /** What a group's files need once every note is read: inbound link
       *  counts, the scope gate, and each file's repository path and
       *  date. Returns the files the scope gate deferred and kept. */
      const finishGroup = async (group: CorpusGroup, linksByMeta: readonly (readonly string[])[], anyUndeclared: boolean): Promise<FileMeta[]> => {
        const state = group.state;
        const inbound = new Map<string, number>();
        for (const links of linksByMeta) {
          for (const target of links) inbound.set(target, (inbound.get(target) ?? 0) + 1);
        }
        let lastChanged: ReadonlyMap<string, string> = new Map();
        let dirty: ReadonlySet<string> = new Set();
        group.repo = state.repo;
        if (state.repo !== undefined && (legacy === undefined || anyUndeclared)) {
          try {
            const repo = state.repo;
            lastChanged = indexPath === undefined
              ? await logDates(repo.toplevel, repo.prefix, state.pinned?.revision, request.signal)
              : await once(context, JSON.stringify(['dates', repo.toplevel, repo.prefix]),
                () => storedLogDates(indexPath, indexFolder!, repo.toplevel, repo.prefix, request.signal));
            if (state.pinned === undefined) {
              // Only the reader's Markdown names are checked for
              // uncommitted work, so status never scans the rest of the
              // repository; a superset of the listed files is fine.
              const dirtySpecs = legacy === 'knowledge' ? ['*.md']
                : legacy === 'rules' ? ['*.md', '*.mdc', '*.cursorrules']
                  : ['*.md', '*.mdc', '*.markdown', '*.cursorrules'];
              dirty = indexPath === undefined ? await uncommitted(repo.toplevel, repo.prefix, dirtySpecs, request.signal)
                : await once(context, JSON.stringify(['dirty', repo.toplevel, repo.prefix, dirtySpecs]),
                  () => uncommitted(repo.toplevel, repo.prefix, dirtySpecs, request.signal));
            }
          } catch (error) {
            if (state.pinned !== undefined || isCancel(error)) throw asSourceReadError(error);
            group.repo = undefined;
          }
        }
        const scopeRoot = group.repo?.toplevel ?? state.scopeRoot ?? state.root;
        const taskPaths = (request.paths ?? []).map((hint) =>
          relative(scopeRoot, resolve(scopeRoot, hint)).split(sep).join('/'));
        const deferredFiles: FileMeta[] = [];
        for (const meta of group.metas) {
          meta.inbound = inbound.get(meta.name) ?? 0;
          meta.scopeSkipped = meta.alwaysOn !== undefined || (meta.scope !== undefined && taskPaths.length > 0
            && !taskPaths.some((hint) => meta.scope!.some((glob) => matchesGlob(hint, glob))));
          if (meta.deferred && !meta.scopeSkipped) deferredFiles.push(meta);
          if (meta.scopeSkipped) continue;
          meta.repoPath = group.repo === undefined ? undefined
            : relative(group.repo.toplevel, meta.file).split(sep).join('/');
          meta.repository = meta.repoPath === undefined ? undefined
            : options.repository ?? group.repo!.toplevel;
          const changed = meta.repoPath === undefined ? undefined : lastChanged.get(meta.repoPath);
          // A declared date wins outside a repository and for the older
          // readers. Otherwise the last commit dates the file, unless the
          // file sits outside a repository, has no commit yet or has
          // uncommitted changes: then its modified time does. A pinned
          // read never uses a modified time.
          const modified = state.pinned === undefined
            && (meta.repoPath === undefined || changed === undefined || dirty.has(meta.repoPath));
          meta.date = (legacy !== undefined || group.repo === undefined) && meta.declared !== undefined ? meta.declared
            : modified ? { value: updates.get(state.root)?.modified.get(meta.file)
              ?? (await stat(meta.file)).mtime.toISOString(), meaning: 'modified' }
            : changed === undefined ? undefined : { value: changed, meaning: 'changed' };
          meta.location = options.kind === 'instructions'
            ? instructionLocation(meta.directory, request.paths ?? [], group.repo?.toplevel ?? group.state.root) : 0;
        }
        return deferredFiles;
      };
      // One pass for the whole call: with the stored index on and a shared
      // read context, a reference reader walks its notes once and every
      // read of the call derives its own statistics from that walk. A
      // read that names paths, decay or a period, a rule reader and a
      // pinned read take the per-read pass below.
      const onePassRead = onePass.on && given !== undefined && indexPath !== undefined && role !== 'rule'
        && (request.paths ?? []).length === 0 && request.decayHalfLife === undefined && request.taskPeriod === undefined
        && selected.every(({ state }) => state.pinned === undefined && updates.has(state.root));
      const corpus = !onePassRead ? undefined
        : await once(context, JSON.stringify(['corpus', indexPath, requestExclude]), async (): Promise<Corpus> => {
          const corpusGroups: CorpusGroup[] = [];
          const corpusMetas: FileMeta[] = [];
          const stale: number[] = [];
          const fileWords: Set<string>[] = [];
          const corpusParts: PartStat[] = [];
          const refs: NotePart[] = [];
          const headings = new Map<string, number[]>();
          let total = 0;
          for (const { state, files } of selected) {
            const { notePaths, notesByName } = namesOf(state, files);
            const group: CorpusGroup = { state, files, metas: [] };
            const linksByMeta: string[][] = [];
            let anyUndeclared = false;
            for await (const { file, entry } of entries(state, files)) {
              const name = nameOf(state, file);
              const declared = declaredDate(entry.fields, legacy === undefined);
              if (legacy !== undefined && declared === undefined) anyUndeclared = true;
              const meta: FileMeta = {
                index: corpusMetas.length,
                file, name, directory: dirname(file), scope: undefined, deferred: false, scopeSkipped: false,
                replaced: entry.replaced(), fileHits: 0, declared,
                partStart: corpusParts.length, partCount: 0, inbound: 0, location: 0,
              };
              stale.push(Date.parse(entry.fields.get('stale_after') ?? ''));
              fileWords.push(new Set(tokenize(`${name} ${entry.frontmatter}`)));
              for (const part of entry.parts()) {
                const len = part.tokens?.length ?? 0;
                total += len;
                for (const word of new Set(tokenize(part.heading))) {
                  const held = headings.get(word);
                  if (held === undefined) headings.set(word, [corpusParts.length]);
                  else held.push(corpusParts.length);
                }
                corpusParts.push({ file: meta.index, id: part.id, len, headingHits: 0, namedPath: false,
                  ...(part.date === undefined ? {} : { date: part.date }) });
                refs.push(part);
              }
              meta.partCount = corpusParts.length - meta.partStart;
              corpusMetas.push(meta);
              group.metas.push(meta);
              linksByMeta.push(linksOf(entry, state, file, name, notePaths, notesByName));
            }
            await finishGroup(group, linksByMeta, anyUndeclared);
            corpusGroups.push(group);
          }
          // Ties in a lane order by id; each part's place in id order
          // stands in for the comparison.
          const byId = corpusParts.map((_, index) => index).sort((left, right) =>
            (corpusParts[left]!.id < corpusParts[right]!.id ? -1 : corpusParts[left]!.id > corpusParts[right]!.id ? 1 : 0));
          const rank = new Uint32Array(corpusParts.length);
          for (let place = 1; place < byId.length; place += 1) {
            rank[byId[place]!] = corpusParts[byId[place]!]!.id === corpusParts[byId[place - 1]!]!.id
              ? rank[byId[place - 1]!]! : place;
          }
          return { groups: corpusGroups, metas: corpusMetas, stale, fileWords, parts: corpusParts, refs, headings,
            totalLength: total, rank, postings: new Map(), units: new Map() };
        });
      if (corpus !== undefined) {
        onePass.served += 1;
        for (const [index, meta] of corpus.metas.entries()) {
          const staleAfter = corpus.stale[index]!;
          const words = corpus.fileWords[index]!;
          metas.push({
            ...meta,
            replaced: meta.replaced
              || (Number.isFinite(staleAfter) && staleAfter <= (taskNow ??= taskMoment(request.taskDate ?? request.asOf, timeZoneOf(request.timeZone)))),
            fileHits: terms.filter((term) => words.has(term)).length,
          });
        }
        let first = 0;
        for (const group of corpus.groups) {
          groups.push({ ...group, metas: metas.slice(first, first + group.metas.length) });
          first += group.metas.length;
        }
        if (meaningLane) parts = corpus.parts as PartStat[];
        else if (!phraseLane || kindLane) {
          parts = corpus.parts.slice();
          totalLength = corpus.totalLength;
          const headingHits = new Map<number, number>();
          for (const term of terms) {
            for (const index of corpus.headings.get(term) ?? []) headingHits.set(index, (headingHits.get(index) ?? 0) + 1);
          }
          for (const [index, hit] of headingHits) parts[index] = { ...parts[index]!, headingHits: hit };
          if (kindLane) {
            for (const [index, part] of corpus.refs.entries()) {
              const phrased = phraseCount(part.text, request.task) + phraseCount(part.title, request.task);
              if (phrased > 0) parts[index] = { ...parts[index]!, phrased };
            }
          }
        }
      }
      /** The notes of some of a group's files, in that order: from the
       *  call's one walk when there is one, else read again. */
      const walk = (group: CorpusGroup, list: readonly FileMeta[]): AsyncIterable<{ readonly entry: Pick<NoteEntry, 'parts'> }> =>
        corpus === undefined ? entries(group.state, list.map((meta) => meta.file)) : (async function* () {
          for (const meta of list) {
            if (request.signal?.aborted) throw new SourceReadError('cancelled', 'The read was cancelled.');
            yield { entry: { parts: () => corpus.refs.slice(meta.partStart, meta.partStart + meta.partCount) } };
          }
        })();
      /** Ties order by id. */
      const byPartId = corpus === undefined
        ? (left: number, right: number) => (parts[left]!.id < parts[right]!.id ? -1 : parts[left]!.id > parts[right]!.id ? 1 : 0)
        : (left: number, right: number) => corpus.rank[left]! - corpus.rank[right]!;
      for (const { state, files } of corpus === undefined ? selected : []) {
        const { notePaths, notesByName } = namesOf(state, files);
        const group: CorpusGroup = { state, files, metas: [] };
        // A group the index covers reads its BM25 inputs from the
        // postings at score time, so its parts enumerate without
        // tokenizing.
        const indexStats = indexPath !== undefined && updates.has(group.state.root);
        const linksByMeta: string[][] = [];
        let anyUndeclared = false;
        for await (const { file, entry } of entries(state, files)) {
          const name = nameOf(state, file);
          const links = linksOf(entry, state, file, name, notePaths, notesByName);
          const marker = role !== 'rule' ? undefined
            : entry.fields.get('alwaysapply') === 'true' ? 'alwaysApply: true'
              : entry.fields.get('applies') === 'always' ? 'applies: always' : undefined;
          const always = marker === undefined ? undefined
            : `declared always-on (${marker}): the agent's harness loads always-on rules`;
          if (always !== undefined) alwaysOn.push({ file: name, reason: always });
          const scope = role === 'rule' && always === undefined ? ruleScope(file, entry) : undefined;
          // The scope gate reads request paths against the repository
          // root, which the date lookup below can still unset; a file
          // the gate could skip defers its part count until it resolves.
          const deferred = scope !== undefined && (request.paths ?? []).length > 0;
          const declared = declaredDate(entry.fields, legacy === undefined);
          if (legacy !== undefined && declared === undefined) anyUndeclared = true;
          // A page is stale at or after its `stale_after`, measured at the task's moment.
          const staleAfter = Date.parse(entry.fields.get('stale_after') ?? '');
          const meta: FileMeta = {
            index: metas.length,
            file, name, directory: dirname(file),
            ...(always === undefined ? {} : { alwaysOn: always }), scope, deferred,
            scopeSkipped: false,
            replaced: entry.replaced()
              || (Number.isFinite(staleAfter) && staleAfter <= (taskNow ??= taskMoment(request.taskDate ?? request.asOf, timeZoneOf(request.timeZone)))),
            fileHits: hits(`${name} ${entry.frontmatter}`, terms),
            declared,
            partStart: parts.length,
            partCount: 0,
            inbound: 0,
            location: 0,
          };
          // A meaning lane needs each part's slot for materialization
          // but no keyword statistics; a kind lane needs both the
          // statistics for its topic score and each part's phrase count.
          if (always === undefined && !deferred && (!phraseLane || kindLane)) {
            for (const part of entry.parts()) {
              if (meaningLane) {
                parts.push({ file: meta.index, id: part.id, len: 0, headingHits: 0, namedPath: false,
                  ...(part.date === undefined ? {} : { date: part.date }) });
                continue;
              }
              if (indexStats) {
                const len = part.tokens?.length ?? 0;
                totalLength += len;
                parts.push({
                  file: meta.index,
                  id: part.id,
                  len,
                  headingHits: hits(part.heading, terms),
                  namedPath: (request.paths ?? []).some((hint) => part.text.includes(hint)),
                  ...(part.date === undefined ? {} : { date: part.date }),
                  ...(kindLane
                    ? { phrased: phraseCount(part.text, request.task) + phraseCount(part.title, request.task) }
                    : {}),
                });
                continue;
              }
              const measured = measurePart(part);
              totalLength += measured.length;
              for (const term of termSet) {
                if (measured.count(term) > 0) {
                  documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
                }
              }
              parts.push({
                file: meta.index,
                id: part.id,
                len: measured.length,
                headingHits: hits(part.heading, terms),
                namedPath: (request.paths ?? []).some((hint) => part.text.includes(hint)),
                ...(part.date === undefined ? {} : { date: part.date }),
                ...(kindLane
                  ? { phrased: phraseCount(part.text, request.task) + phraseCount(part.title, request.task) }
                  : {}),
              });
            }
            meta.partCount = parts.length - meta.partStart;
          }
          metas.push(meta);
          group.metas.push(meta);
          linksByMeta.push(links);
        }
        const deferredFiles = await finishGroup(group, linksByMeta, anyUndeclared);
        // The scope gate has resolved; files it deferred re-read once to
        // count their parts into the statistics.
        if (!phraseLane || kindLane) {
          for (const meta of deferredFiles) {
            meta.partStart = parts.length;
            for await (const { entry } of entries(group.state, [meta.file])) {
              for (const part of entry.parts()) {
                if (meaningLane) {
                  parts.push({ file: meta.index, id: part.id, len: 0, headingHits: 0, namedPath: false,
                    ...(part.date === undefined ? {} : { date: part.date }) });
                  continue;
                }
                if (indexStats) {
                  const len = part.tokens?.length ?? 0;
                  totalLength += len;
                  parts.push({
                    file: meta.index,
                    id: part.id,
                    len,
                    headingHits: hits(part.heading, terms),
                    namedPath: (request.paths ?? []).some((hint) => part.text.includes(hint)),
                    ...(part.date === undefined ? {} : { date: part.date }),
                    ...(kindLane
                      ? { phrased: phraseCount(part.text, request.task) + phraseCount(part.title, request.task) }
                      : {}),
                  });
                  continue;
                }
                const measured = measurePart(part);
                totalLength += measured.length;
                for (const term of termSet) {
                  if (measured.count(term) > 0) {
                    documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
                  }
                }
                parts.push({
                  file: meta.index,
                  id: part.id,
                  len: measured.length,
                  headingHits: hits(part.heading, terms),
                  namedPath: (request.paths ?? []).some((hint) => part.text.includes(hint)),
                  ...(part.date === undefined ? {} : { date: part.date }),
                  ...(kindLane
                    ? { phrased: phraseCount(part.text, request.task) + phraseCount(part.title, request.task) }
                    : {}),
                });
              }
            }
            meta.partCount = parts.length - meta.partStart;
          }
        }
        groups.push(group);
      }
      if (!present) return { status: 'absent', reason: reasons.join('; ') };
      // What this call's update did, summed over the roots it brought up
      // to date; every read of the call reports the same.
      let indexed: { readonly index?: StoredIndexReport } = {};
      if (indexPath !== undefined && updates.size > 0) {
        const done = [...updates.values()];
        // The total is read once per call from the count the updates keep;
        // every read of the call reports the same update.
        const total = await once(context, JSON.stringify(['parts', indexPath, [...updates.keys()], requestExclude]), async () => {
          const database = await openIndexFile(indexPath, indexFolder!);
          try {
            return (database.prepare("SELECT n FROM counts WHERE name = 'parts'").get() as { n: number }).n;
          } finally {
            database.close();
          }
        });
        indexed = { index: {
          parts: total,
          added: done.reduce((sum, update) => sum + update.added, 0),
          removed: done.reduce((sum, update) => sum + update.removed, 0),
          rebuilt: false,
          ms: done.reduce((sum, update) => sum + update.ms, 0),
        } };
      }
      alwaysOn.sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
      const skippedAlwaysOn = alwaysOn.length === 0 ? {} : { alwaysOnSkipped: alwaysOn };
      const limit = request.limit;
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
        throw new TypeError('limit must be a positive safe integer.');
      }

      // The source's own `since` bounds the history from below on the
      // date each part carries as the reader emits it: a part emitted
      // with no date is read; a bare day compares as a day, as the task
      // period's check does.
      const zone = timeZoneOf(request.timeZone);
      const sinceMs = sinceCutoff(options.since,
        taskNow ??= taskMoment(request.taskDate ?? request.asOf, zone));
      const keepDate = (date: MemoryCandidate['date']) => date === undefined
        || !Number.isFinite(sinceMs)
        || (/^\d{4}-\d{2}-\d{2}$/.test(date.value)
          ? date.value >= zonedIso(sinceMs, zone).slice(0, 10)
          : Date.parse(date.value) >= sinceMs);
      // A part's own date, else its file's, the same date `emit` gives
      // it. The bound applies before any limit or lane cut, so an old
      // high-scoring part can never spend a newer part's place.
      const dateOf = (index: number) => parts[index]!.date ?? metas[parts[index]!.file]!.date;
      const inside = (index: number) => keepDate(dateOf(index));
      const emit = (meta: FileMeta, part: EnumeratedPart, signals: Record<string, number>): MemoryCandidate => ({
        sourceId: id, role, ...(legacy === undefined ? { kind: options.kind } : {}),
        id: part.id,
        title: part.title,
        text: part.text,
        contentRef: part.contentRef,
        ...((part.date ?? meta.date) === undefined ? {} : { date: part.date ?? meta.date }),
        ...(meta.repoPath === undefined ? {} : { path: meta.repoPath, repository: meta.repository }),
        ...(options.kind === 'instructions' ? { directory: meta.directory } : {}),
        signals,
      });

      // A meaning lane embeds each part in bounded batches and keeps
      // the parts the similarity curve keeps; the corpus's text is
      // never held, and the keyword scoring pass is skipped. The first
      // meaning lane of a call scores every part against the call's
      // whole query list at once, and the lanes after it read the held
      // scores; a read outside a shared context scores its own query
      // alone, as before.
      if (meaningLane) {
        const embed = request.meaningLane!.embed;
        const queries = request.meaningQueries ?? [request.task];
        interface Lite {
          queries: readonly string[];
          sims: Map<number, number[]>;
        }
        const box = context.shared;
        let shared = box?.get(reader) as { meaning?: Lite } | undefined;
        if (box !== undefined && shared === undefined) box.set(reader, shared = {});
        const compute = async (list: readonly string[]): Promise<Lite> => {
          const queryVectors = (await embed(list, request.signal)).map((vector) => normalized(vector));
          const lite: Lite = { queries: list, sims: new Map() };
          // With the call's one walk, each in-window part's vector is
          // found by its stored key. A store hands its vectors out again,
          // so only an embedder with no store has them kept for the call:
          // a part embedded earlier in the call is then scored from its
          // held vector, and a part not yet held sends every part through
          // the embedder as before.
          const stored = 'eachVector' in embed;
          if (corpus !== undefined && stored) {
            const inWindow = parts.map((_, index) => index).filter(inside);
            await eachPartVector(embed, inWindow.length,
              (at) => corpus.refs[inWindow[at]!]!.vec ?? textKey(corpus.refs[inWindow[at]!]!.text),
              (at) => corpus.refs[inWindow[at]!]!.text,
              (at, vector) => {
                const unit = normalized(vector, queryVectors[0]!.length);
                lite.sims.set(inWindow[at]!, queryVectors.map((query) => similarity(unit, query)));
              }, request.signal);
            return lite;
          }
          if (corpus !== undefined && corpus.units.size > 0) {
            const dimensions = queryVectors[0]!.length;
            let every = true;
            for (let index = 0; index < parts.length && every; index += 1) {
              if (!inside(index)) continue;
              const unit = corpus.units.get(index);
              every = unit !== undefined && unit.length === dimensions;
            }
            if (every) {
              for (let index = 0; index < parts.length; index += 1) {
                if (!inside(index)) continue;
                const unit = corpus.units.get(index)!;
                lite.sims.set(index, queryVectors.map((query) => similarity(unit, query)));
              }
              return lite;
            }
          }
          let pending: { key: number; text: string }[] = [];
          const flush = async () => {
            if (pending.length === 0) return;
            const vectors = await embed(pending.map((part) => part.text), request.signal);
            if (vectors.length !== pending.length) throw new TypeError('embed must return one vector per input text.');
            pending.forEach((part, index) => {
              const unit = normalized(vectors[index]!, queryVectors[0]!.length);
              corpus?.units.set(part.key, unit);
              lite.sims.set(part.key, queryVectors.map((query) => similarity(unit, query)));
            });
            pending = [];
          };
          for (const group of groups) {
            let cursor = 0;
            for await (const { entry } of walk(group, group.metas)) {
              const meta = group.metas[cursor++]!;
              if (meta.partCount === 0) continue;
              let local = 0;
              for (const part of entry.parts()) {
                // A file that grew between passes emits extra parts; they
                // have no slot in the part list, so they are skipped.
                if (local >= meta.partCount) break;
                const index = meta.partStart + local;
                local += 1;
                // A part outside the look-back is never embedded.
                if (!inside(index)) continue;
                pending.push({ key: index, text: part.text });
                if (pending.length === 32) await flush();
              }
            }
          }
          await flush();
          return lite;
        };
        let lite = shared?.meaning;
        if (lite === undefined || lite.queries.length !== queries.length
          || lite.queries.some((query, index) => query !== queries[index])) {
          lite = await compute(queries);
          if (shared !== undefined) shared.meaning = lite;
        }
        let at = lite.queries.indexOf(request.task);
        if (at === -1) { lite = await compute([request.task]); at = 0; }
        // Each part's similarity to this lane's query; zero when unscored.
        const sim = new Float64Array(parts.length);
        for (let index = 0; index < parts.length; index += 1) {
          const scores = lite.sims.get(index);
          if (scores !== undefined) sim[index] = scores[at]!;
        }
        const order = parts.map((_, index) => index)
          .filter(inside)
          .sort((left, right) => sim[right]! - sim[left]! || byPartId(left, right));
        const cut = request.wholeLanes === false;
        // With `wholeLanes` on the read keeps every part and marks each
        // one the cut would have dropped.
        const mark = request.wholeLanes === true;
        const bend = cut || mark ? laneBend(order.map((index) => sim[index]!)) : undefined;
        // A cut lane where nothing scored above zero matched nothing:
        // it keeps no parts rather than read back every body.
        const matched = order.some((index) => sim[index]! > 0);
        const passes = (index: number) => bend === undefined ? matched : sim[index]! > bend;
        const keptAll = cut ? order.filter(passes) : order;
        // `limit` carries the caller's `nearest` cap: it slices the kept
        // set after the curve, not the enumeration before it.
        const kept = limit === undefined ? keptAll : keptAll.slice(0, limit);
        // The lane reports its whole scored list as ids and scores in
        // `meaningScores`; `candidates` still holds every kept part —
        // under `wholeLanes` that is the whole list, with the parts a
        // cut would drop marked. A caller that uses whole candidates only
        // inside the bend gets those alone, so the marked parts are
        // never read back.
        const bodies = mark && request.keptBodiesOnly === true ? kept.filter(passes) : kept;
        const wanted = new Set<number>(bodies);
        const byIndex = new Map<number, MemoryCandidate>();
        for (const group of groups) {
          const needed = group.metas.filter((meta) => {
            for (let index = meta.partStart; index < meta.partStart + meta.partCount; index += 1) {
              if (wanted.has(index)) return true;
            }
            return false;
          });
          if (needed.length === 0) continue;
          let cursor = 0;
          for await (const { entry } of walk(group, needed)) {
            const meta = needed[cursor++]!;
            let local = 0;
            for (const part of entry.parts()) {
              const index = meta.partStart + local;
              local += 1;
              if (!wanted.has(index)) continue;
              const similarity = sim[index]!;
              byIndex.set(index, {
                ...emit(meta, part, { similarity }),
                laneScore: similarity,
                ...(mark && !passes(index) ? { pastLaneCut: true as const } : {}),
              });
            }
          }
        }
        const emitted = bodies.map((index) => byIndex.get(index))
          .filter((candidate): candidate is MemoryCandidate => candidate !== undefined);
        const partial: string[] = [];
        if (limit !== undefined && keptAll.length > limit) {
          partial.push(`the limit kept ${limit} of ${keptAll.length} candidates`);
        }
        if (skipped > 0) partial.push(`skipped ${skipped} symbolic-link ${skipped === 1 ? 'entry' : 'entries'}`);
        return {
          status: 'read' as const,
          ...(revision === undefined ? {} : { revision }),
          candidates: emitted,
          meaningLane: true as const,
          meaningScores: (mark ? order : kept).map((index) => ({
            id: parts[index]!.id, similarity: sim[index]!,
            ...(mark && !passes(index) ? { pastLaneCut: true as const } : {}),
          })),
          ...indexed,
          ...skippedAlwaysOn,
          complete: partial.length === 0 && reasons.length === 0,
          ...(partial.length === 0 && reasons.length === 0
            ? {}
            : { partial: [...reasons, ...partial].join('; ') }),
          matched: order.length,
          ...(cut ? { laneCutApplied: true as const } : {}),
        };
      }

      // A phrase lane keeps the parts whose text or title holds
      // the exact phrase; keyword statistics are skipped for it.
      if (phraseLane && !kindLane) {
        const matched: { candidate: MemoryCandidate; count: number }[] = [];
        for (const group of groups) {
          let cursor = 0;
          for await (const { entry } of walk(group, group.metas)) {
            const meta = group.metas[cursor++]!;
            if (meta.scopeSkipped) continue;
            for (const part of entry.parts()) {
              const count = phraseCount(part.text, request.task) + phraseCount(part.title, request.task);
              if (count === 0) continue;
              matched.push({ candidate: emit(meta, part, { phrase: count }), count });
            }
          }
        }
        matched.sort((left, right) => right.count - left.count || left.candidate.id.localeCompare(right.candidate.id));
        const inLookBack = matched.filter(({ candidate }) => keepDate(candidate.date));
        const limited = limit !== undefined && inLookBack.length > limit;
        const kept = limited ? inLookBack.slice(0, limit) : inLookBack;
        const partial: string[] = [];
        if (limited) partial.push(`the phrase limit kept ${limit} of ${inLookBack.length} candidates`);
        if (skipped > 0) partial.push(`skipped ${skipped} symbolic-link ${skipped === 1 ? 'entry' : 'entries'}`);
        const candidates = kept.map(({ candidate, count }) => ({ ...candidate, laneScore: count }));
        if (reasons.length === 0) {
          return {
            status: 'read',
            ...(revision === undefined ? {} : { revision }),
            candidates,
            ...indexed,
            ...skippedAlwaysOn,
            complete: partial.length === 0,
            ...(partial.length === 0 ? {} : { partial: partial.join('; ') }),
          };
        }
        return {
          status: 'read',
          ...(revision === undefined ? {} : { revision }),
          candidates,
          ...indexed,
          ...skippedAlwaysOn,
          complete: false,
          partial: [...reasons, ...partial].join('; '),
        };
      }

      // The scoring pass BM25-scores each part against the corpus
      // statistics the first pass collected. With the index the
      // postings alone carry a covered group: its stored counts give
      // each term's per-part frequency, its per-part sums the lengths,
      // and its distinct parts the document frequencies; a group
      // without it is walked and measured as before.
      const scores = new Float64Array(parts.length);
      const count = parts.length;
      const posted: CorpusGroup[] = [];
      const walked: CorpusGroup[] = [];
      for (const group of groups) {
        if (indexPath !== undefined && updates.get(group.state.root) !== undefined) posted.push(group);
        else walked.push(group);
      }
      let database: IndexDatabase | undefined;
      const byFile = new Map<string, FileMeta>();
      try {
        if (posted.length > 0 && (corpus === undefined || terms.some((term) => !corpus.postings.has(term)))) {
          database = await openIndexFile(indexPath!, indexFolder!);
          for (const group of posted) for (const meta of group.metas) byFile.set(meta.file, meta);
        }
        const average = count === 0 ? 0 : totalLength / count;
        if (average > 0) {
          if (posted.length > 0) {
            const postingOf = database?.prepare('SELECT path, ordinal, count FROM postings WHERE term = ?');
            const postingsFor = (term: string) => {
              const held = new Set<number>();
              const hitsOf: { index: number; f: number }[] = [];
              for (const row of postingOf!.all(term) as { path: string; ordinal: number; count: number }[]) {
                const meta = byFile.get(row.path);
                if (meta === undefined || row.ordinal >= meta.partCount) continue;
                const index = meta.partStart + row.ordinal;
                held.add(index);
                hitsOf.push({ index, f: row.count });
              }
              return { hitsOf, held: held.size };
            };
            for (const term of terms) {
              let posting = corpus?.postings.get(term);
              if (posting === undefined) {
                posting = postingsFor(term);
                corpus?.postings.set(term, posting);
              }
              const { hitsOf, held } = posting;
              const n = (documentFrequency.get(term) ?? 0) + held;
              documentFrequency.set(term, n);
              if (n === 0) continue;
              for (const { index, f } of hitsOf) {
                scores[index] = scores[index]! + bm25Term(f, n, count, parts[index]!.len, average, keyword.k1, keyword.b);
              }
            }
          }
          for (const group of walked) {
            let cursor = 0;
            for await (const { entry } of entries(group.state, group.files)) {
              const meta = group.metas[cursor++]!;
              if (meta.partCount === 0) continue;
              let local = 0;
              for (const part of entry.parts()) {
                // A file that grew between passes emits extra parts; they
                // never had statistics, so they are skipped.
                if (local >= meta.partCount) break;
                const measured = measurePart(part);
                let score = 0;
                for (const term of terms) {
                  const n = documentFrequency.get(term) ?? 0;
                  const f = measured.count(term);
                  if (n === 0 || f === 0) continue;
                  score += bm25Term(f, n, count, measured.length, average, keyword.k1, keyword.b);
                }
                scores[meta.partStart + local] = score;
                local += 1;
              }
            }
          }
        }
      } finally {
        database?.close();
      }

      // Decay ranks each dated part lower by its age at the task date;
      // undefined for an undated part or one dated after it.
      const halfLife = request.decayHalfLife;
      const aged = halfLife === undefined ? undefined : (() => {
        const zone = timeZoneOf(request.timeZone);
        const asOf = taskMoment(request.taskDate ?? request.asOf, zone);
        return parts.map((_, index) => decayWeight(dateOf(index)?.value, asOf, halfLife, keyword.replacedWeight, zone));
      })();
      // Rank by the same signal sum the candidates report, slice the
      // read's limit, then — when the lane cut is on — keep what the
      // score curve keeps.
      const plain = parts.map((part, index) => {
        const meta = metas[part.file]!;
        let sum = scores[index]!;
        if (legacy !== 'rules' && part.headingHits > 0) sum += Math.min(keyword.headingCap, part.headingHits * keyword.headingWeight);
        if (legacy !== 'rules' && meta.fileHits > 0) sum += Math.min(keyword.fileCap, meta.fileHits);
        if (part.namedPath) sum += keyword.namedPathWeight;
        if (legacy !== 'rules' && meta.inbound > 0) sum += Math.min(keyword.inboundLinkCap, Math.log10(1 + meta.inbound));
        if (legacy !== 'rules' && meta.replaced) sum += keyword.replacedWeight;
        if (meta.location > 0) sum += meta.location;
        return sum;
      });
      const sums = aged === undefined ? plain : plain.map((sum, index) => sum + (aged[index] ?? 0));
      // A period read keeps only the parts dated inside the task's period.
      const period = request.taskPeriod;
      const dated = (index: number) => inside(index)
        && (period === undefined || datedIn(dateOf(index)?.value ?? '', period));
      const cut = request.wholeLanes === false;
      // With `wholeLanes` on the read keeps every part and marks each one
      // the cut would have dropped.
      const mark = request.wholeLanes === true;
      const select = (totals: readonly number[]) => {
        const ranked = parts.map((_, index) => index)
          .sort((left, right) => totals[right]! - totals[left]! || byPartId(left, right));
        // A kind lane's lane is its exact-phrase matches, ranked by the
        // topic's signal sum — never by how often the phrase occurs, so a
        // direction said once survives a phrase everyone says.
        const laneRanked = kindLane
          ? ranked.filter((index) => (parts[index]!.phrased ?? 0) > 0 && dated(index))
          : ranked.filter(dated);
        // A keyword read's limit bounds the read itself; a kind lane's
        // caps what the score curve keeps.
        const pool = kindLane || limit === undefined ? laneRanked : laneRanked.slice(0, limit);
        const bend = cut || mark ? laneBend(pool.map((index) => totals[index]!)) : undefined;
        // A cut keyword lane where nothing scored above zero matched
        // nothing: it keeps no parts rather than read back every body. A
        // kind lane still keeps its phrase matches, scored or not.
        const matched = kindLane || pool.some((index) => totals[index]! > 0);
        const passes = (index: number) => bend === undefined ? matched : totals[index]! > bend;
        const curveKept = cut ? pool.filter(passes) : pool;
        const kept = kindLane && limit !== undefined ? curveKept.slice(0, limit) : curveKept;
        return { laneRanked, pool, passes, curveKept, kept };
      };
      const { laneRanked, pool, passes, curveKept, kept } = select(sums);
      const limitBase = kindLane ? curveKept.length : laneRanked.length;
      // What the same limit and cut keep without decay, from the same
      // scores. A kind lane's limit applies after the read, by score and
      // then id, so both sets pass through it before they are compared.
      let decayCounts: { actedOn: number; added: string[]; dropped: string[] } | undefined;
      if (aged !== undefined) {
        const afterLimit = (indexes: readonly number[], totals: readonly number[]) =>
          !kindLane || request.decayLimit === undefined ? indexes : [...indexes]
            .sort((left, right) => totals[right]! - totals[left]! || parts[left]!.id.localeCompare(parts[right]!.id))
            .slice(0, request.decayLimit);
        const withDecay = new Set(afterLimit(kept, sums));
        const without = new Set(afterLimit(select(plain).kept, plain));
        decayCounts = {
          actedOn: laneRanked.filter((index) => aged[index] !== undefined).length,
          added: [...withDecay].filter((index) => !without.has(index)).map((index) => parts[index]!.id),
          dropped: [...without].filter((index) => !withDecay.has(index)).map((index) => parts[index]!.id),
        };
      }

      // The materializing pass reads back only the files that kept a
      // part and builds their candidates.
      const wanted = new Set<number>(kept);
      const byIndex = new Map<number, MemoryCandidate>();
      for (const group of groups) {
        const needed = group.metas.filter((meta) => {
          for (let index = meta.partStart; index < meta.partStart + meta.partCount; index += 1) {
            if (wanted.has(index)) return true;
          }
          return false;
        });
        if (needed.length === 0) continue;
        let cursor = 0;
        for await (const { entry } of walk(group, needed)) {
          const meta = needed[cursor++]!;
          let local = 0;
          for (const part of entry.parts()) {
            const index = meta.partStart + local;
            local += 1;
            if (!wanted.has(index)) continue;
            const descriptor = parts[index]!;
            const signals: Record<string, number> = {};
            if (legacy !== 'rules' && descriptor.headingHits > 0) signals['heading-words'] = Math.min(keyword.headingCap, descriptor.headingHits * keyword.headingWeight);
            if (legacy !== 'rules' && meta.fileHits > 0) signals['file-words'] = Math.min(keyword.fileCap, meta.fileHits);
            if (descriptor.namedPath) signals['names-path'] = keyword.namedPathWeight;
            if (legacy !== 'rules' && meta.inbound > 0) signals['inbound-links'] = Math.min(keyword.inboundLinkCap, Math.log10(1 + meta.inbound));
            if (legacy !== 'rules' && meta.replaced) signals['replaced'] = keyword.replacedWeight;
            const decay = aged?.[index];
            if (decay !== undefined && decay !== 0) signals['decay'] = decay;
            if (meta.location > 0) signals['instruction-location'] = meta.location;
            if (scores[index] !== 0) signals['bm25'] = scores[index]!;
            if (kindLane) signals['phrase'] = descriptor.phrased!;
            const candidate = {
              ...emit(meta, part, signals),
              ...(mark && !passes(index) ? { pastLaneCut: true as const } : {}),
            };
            byIndex.set(index, kindLane ? { ...candidate, laneScore: sums[index]! } : candidate);
          }
        }
      }
      // A file that shrank mid-read leaves a kept index with no part to
      // materialize; it simply emits fewer.
      const emitted = kept.map((index) => byIndex.get(index))
        .filter((candidate): candidate is MemoryCandidate => candidate !== undefined);
      const partial: string[] = [];
      if (limit !== undefined && limitBase > limit) {
        partial.push(`the limit kept ${limit} of ${limitBase} candidates`);
      }
      if (skipped > 0) partial.push(`skipped ${skipped} symbolic-link ${skipped === 1 ? 'entry' : 'entries'}`);
      return {
        status: 'read',
        ...(revision === undefined ? {} : { revision }),
        candidates: emitted,
        ...indexed,
        ...skippedAlwaysOn,
        complete: partial.length === 0 && reasons.length === 0,
        ...(partial.length === 0 && reasons.length === 0
          ? {}
          : { partial: [...reasons, ...partial].join('; ') }),
        ...(cut ? { laneCutApplied: true as const, matched: kindLane ? laneRanked.length : pool.length } : {}),
        ...(decayCounts === undefined ? {} : { decay: decayCounts }),
      };
    },
  };
  return reader;
}

/** Directory notes with the original section ids, date precedence, and part size. */
export function knowledgeBase(directory: string, options: KnowledgeBaseOptions = {}): CandidateSource {
  if (typeof directory !== 'string' || directory.trim() === '') throw new TypeError('directory must be a non-empty string.');
  const reader = markdownSource({ ...options, paths: [directory], kind: 'knowledge',
    maxQuestionText: options.maxQuestionText ?? DEFAULT_MAX_QUESTION_TEXT }, 'knowledge');
  return historySource({ reader, ...markdownSettings });
}

/** Directory rules with ids of the relative file name and heading path, and README exclusion. */
export function rules(directory: string, options: RulesOptions = {}): CandidateSource {
  if (typeof directory !== 'string' || directory.trim() === '') throw new TypeError('directory must be a non-empty string.');
  return historySource({ reader: markdownSource({ ...options, paths: [directory], kind: 'rules' }, 'rules'), ...rulesSettings });
}
