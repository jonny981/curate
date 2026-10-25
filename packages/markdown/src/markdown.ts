import { MARKDOWN_KEYWORD_SETTINGS, markdownSettings, rulesSettings, type MarkdownKeywordSettings } from './defaults.js';
import {
  hits,
  taskTerms,
  tokenize,
  phraseCount,
  laneBend,
  sharedFileText,
  sharedFileStore,
  embedQuery,
  embedSimilarities,
} from '@curatejs/core/internal';
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
  legacy?: 'knowledge' | 'rules',
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
      // rules() still lists .cursorrules, only so the read can record that it skipped it.
      if (legacy !== undefined ? entry.name.startsWith('.') && !(legacy === 'rules' && entry.name === '.cursorrules')
        : entry.name === '.git' || entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (ignored.has(path) || isExcluded(path, root, exclude, toplevel)) continue;
      if (entry.isSymbolicLink()) {
        skipped += 1;
      } else if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && (legacy === 'knowledge' ? entry.name.endsWith('.md')
        : legacy === 'rules' ? /\.mdc?$/.test(entry.name) || entry.name === '.cursorrules'
          : markdownFile(path)) && select(path)) {
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
  // and to git(). An entry naming a root — '.', './', '/' — keeps
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
  for (const [sectionIndex, section] of items.entries()) {
    const parts = legacy === 'rules' ? [section.text] : splitParts(section.text, partBudget);
    const key = 'key' in section ? (section as RuleSection).key : String(sectionIndex + 1);
    const sectionId = key === '' ? fileId : `${fileId}#${key}`;
    for (const [partIndex, text] of parts.entries()) {
      const heading = section.heading ?? basename(file);
      yield {
        id: parts.length === 1 ? sectionId : `${sectionId}.${partIndex + 1}`,
        title: description !== undefined && description !== '' ? `${name}: ${description}`
          : parts.length === 1 ? `${name}: ${heading}` : `${name}: ${heading} (part ${partIndex + 1})`,
        text,
        heading,
        contentRef: `${fileId}#L${section.startLine}-L${section.endLine}`,
      };
    }
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

/** Markdown from folders, files or glob patterns, classified by the caller. */
export function markdown(options: MarkdownOptions): CandidateSource {
  return historySource({ reader: markdownSource(options), ...markdownSettings });
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
      const parts: PartStat[] = [];
      const documentFrequency = new Map<string, number>();
      let totalLength = 0;

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
          const harness = role === 'rule' ? harnessFile(file) : undefined;
          if (harness !== undefined) {
            alwaysOn.push({ file: relative(state.root, file).split(sep).join('/'), reason: `a harness loads ${harness} every session` });
            return false;
          }
          return true;
        });
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
        const group: CorpusGroup = { state, files, metas: [] };
        const linksByMeta: string[][] = [];
        let anyUndeclared = false;
        for await (const { file, text } of fileTexts(state, files, context, request.signal)) {
          const note = parseNote(text);
          const name = relative(state.root, file).split(sep).join('/');
          // Links count from every file, including ones a scope rule
          // skips, like the old read's notes map.
          const links: string[] = [];
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
            if (target === undefined || target === name) continue;
            links.push(target);
          }
          const marker = role !== 'rule' ? undefined
            : note.fields.get('alwaysapply') === 'true' ? 'alwaysApply: true'
              : note.fields.get('applies') === 'always' ? 'applies: always' : undefined;
          const always = marker === undefined ? undefined
            : `declared always-on (${marker}): the agent's harness loads always-on rules`;
          if (always !== undefined) alwaysOn.push({ file: name, reason: always });
          const scope = role === 'rule' && always === undefined ? ruleScope(file, note) : undefined;
          // The scope gate reads request paths against the repository
          // root, which the date lookup below can still unset; a file
          // the gate could skip defers its part count until it resolves.
          const deferred = scope !== undefined && (request.paths ?? []).length > 0;
          const declared = declaredDate(note.fields, legacy === undefined);
          if (legacy !== undefined && declared === undefined) anyUndeclared = true;
          const meta: FileMeta = {
            index: metas.length,
            file, name, directory: dirname(file),
            ...(always === undefined ? {} : { alwaysOn: always }), scope, deferred,
            scopeSkipped: false,
            replaced: REPLACED_FRONTMATTER.test(note.frontmatter) || REPLACED_LINE.test(note.body),
            fileHits: hits(`${name} ${note.frontmatter}`, terms),
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
            for (const part of noteParts(note, file, name, legacy, role === 'rule', partBudget)) {
              if (meaningLane) {
                parts.push({ file: meta.index, id: part.id, len: 0, headingHits: 0, namedPath: false });
                continue;
              }
              const tokens = tokenize(part.text);
              totalLength += tokens.length;
              for (const term of new Set(tokens)) {
                if (termSet.has(term)) {
                  documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
                }
              }
              parts.push({
                file: meta.index,
                id: part.id,
                len: tokens.length,
                headingHits: hits(part.heading, terms),
                namedPath: (request.paths ?? []).some((hint) => part.text.includes(hint)),
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
        const inbound = new Map<string, number>();
        for (const links of linksByMeta) {
          for (const target of links) inbound.set(target, (inbound.get(target) ?? 0) + 1);
        }
        let lastChanged: ReadonlyMap<string, string> = new Map();
        group.repo = state.repo;
        if (state.repo !== undefined && (legacy === undefined || anyUndeclared)) {
          try {
            lastChanged = await logDates(state.repo.toplevel, state.repo.prefix, state.pinned?.revision, request.signal);
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
          meta.date = legacy !== undefined
            ? meta.declared ?? (changed === undefined ? undefined : { value: changed, meaning: 'changed' })
            : group.repo === undefined
            ? meta.declared ?? { value: (await stat(meta.file)).mtime.toISOString(), meaning: 'modified' }
            : changed === undefined ? undefined : { value: changed, meaning: 'changed' };
          meta.location = options.kind === 'instructions'
            ? instructionLocation(meta.directory, request.paths ?? [], group.repo?.toplevel ?? group.state.root) : 0;
        }
        // The scope gate has resolved; files it deferred re-read once to
        // count their parts into the statistics.
        if (!phraseLane || kindLane) {
          for (const meta of deferredFiles) {
            meta.partStart = parts.length;
            for await (const { text } of fileTexts(group.state, [meta.file], context, request.signal)) {
              const note = parseNote(text);
              for (const part of noteParts(note, meta.file, meta.name, legacy, role === 'rule', partBudget)) {
                if (meaningLane) {
                  parts.push({ file: meta.index, id: part.id, len: 0, headingHits: 0, namedPath: false });
                  continue;
                }
                const tokens = tokenize(part.text);
                totalLength += tokens.length;
                for (const term of new Set(tokens)) {
                  if (termSet.has(term)) {
                    documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
                  }
                }
                parts.push({
                  file: meta.index,
                  id: part.id,
                  len: tokens.length,
                  headingHits: hits(part.heading, terms),
                  namedPath: (request.paths ?? []).some((hint) => part.text.includes(hint)),
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
      alwaysOn.sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
      const skippedAlwaysOn = alwaysOn.length === 0 ? {} : { alwaysOnSkipped: alwaysOn };
      const limit = request.limit;
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
        throw new TypeError('limit must be a positive safe integer.');
      }

      const emit = (meta: FileMeta, part: EnumeratedPart, signals: Record<string, number>): MemoryCandidate => ({
        sourceId: id, role, ...(legacy === undefined ? { kind: options.kind } : {}),
        id: part.id,
        title: part.title,
        text: part.text,
        contentRef: part.contentRef,
        ...(meta.date === undefined ? {} : { date: meta.date }),
        ...(meta.repoPath === undefined ? {} : { path: meta.repoPath, repository: meta.repository }),
        ...(options.kind === 'instructions' ? { directory: meta.directory } : {}),
        signals,
      });

      // A meaning lane embeds each part in bounded batches and keeps
      // the parts the similarity curve keeps; the corpus's text is
      // never held, and the keyword scoring pass is skipped.
      if (meaningLane) {
        const embed = request.meaningLane!.embed;
        const query = await embedQuery(embed, request.task, request.signal);
        const simOf = new Map<number, number>();
        let pending: { index: number; text: string }[] = [];
        const flush = async () => {
          if (pending.length === 0) return;
          const scores = await embedSimilarities(embed, query, pending.map((part) => part.text), request.signal);
          pending.forEach((part, at) => simOf.set(part.index, scores[at]!));
          pending = [];
        };
        for (const group of groups) {
          let cursor = 0;
          for await (const { file, text } of fileTexts(group.state, group.files, context, request.signal)) {
            const meta = group.metas[cursor++]!;
            if (meta.partCount === 0) continue;
            const note = parseNote(text);
            let local = 0;
            for (const part of noteParts(note, file, meta.name, legacy, role === 'rule', partBudget)) {
              // A file that grew between passes emits extra parts; they
              // have no slot in the part list, so they are skipped.
              if (local >= meta.partCount) break;
              pending.push({ index: meta.partStart + local, text: part.text });
              local += 1;
              if (pending.length === 32) await flush();
            }
          }
        }
        await flush();
        const order = parts.map((_, index) => index)
          .sort((left, right) => (simOf.get(right) ?? 0) - (simOf.get(left) ?? 0)
            || (parts[left]!.id < parts[right]!.id ? -1 : parts[left]!.id > parts[right]!.id ? 1 : 0));
        const cut = request.wholeLanes === false;
        // With `wholeLanes` on the read keeps every part and marks each
        // one the cut would have dropped.
        const mark = request.wholeLanes === true;
        const bend = cut || mark ? laneBend(order.map((index) => simOf.get(index) ?? 0)) : undefined;
        // A cut lane where nothing scored above zero matched nothing:
        // it keeps no parts rather than read back every body.
        const matched = order.some((index) => (simOf.get(index) ?? 0) > 0);
        const passes = (index: number) => bend === undefined ? matched : (simOf.get(index) ?? 0) > bend;
        const keptAll = cut ? order.filter(passes) : order;
        // `limit` carries the caller's `nearest` cap: it slices the kept
        // set after the curve, not the enumeration before it.
        const kept = limit === undefined ? keptAll : keptAll.slice(0, limit);
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
          for await (const { file, text } of fileTexts(group.state, needed.map((meta) => meta.file), context, request.signal)) {
            const meta = needed[cursor++]!;
            const note = parseNote(text);
            let local = 0;
            for (const part of noteParts(note, file, meta.name, legacy, role === 'rule', partBudget)) {
              const index = meta.partStart + local;
              local += 1;
              if (!wanted.has(index)) continue;
              const similarity = simOf.get(index) ?? 0;
              byIndex.set(index, {
                ...emit(meta, part, { similarity }),
                laneScore: similarity,
                ...(mark && !passes(index) ? { pastLaneCut: true as const } : {}),
              });
            }
          }
        }
        const emitted = kept.map((index) => byIndex.get(index))
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
          ...skippedAlwaysOn,
          complete: partial.length === 0 && reasons.length === 0,
          ...(partial.length === 0 && reasons.length === 0
            ? {}
            : { partial: [...reasons, ...partial].join('; ') }),
          matched: parts.length,
          ...(cut ? { laneCutApplied: true as const } : {}),
        };
      }

      // A phrase lane keeps the parts whose text or title holds
      // the exact phrase; keyword statistics are skipped for it.
      if (phraseLane && !kindLane) {
        const matched: { candidate: MemoryCandidate; count: number }[] = [];
        for (const group of groups) {
          let cursor = 0;
          for await (const { file, text } of fileTexts(group.state, group.files, context, request.signal)) {
            const meta = group.metas[cursor++]!;
            if (meta.scopeSkipped) continue;
            const note = parseNote(text);
            for (const part of noteParts(note, file, meta.name, legacy, role === 'rule', partBudget)) {
              const count = phraseCount(part.text, request.task) + phraseCount(part.title, request.task);
              if (count === 0) continue;
              matched.push({ candidate: emit(meta, part, { phrase: count }), count });
            }
          }
        }
        matched.sort((left, right) => right.count - left.count || left.candidate.id.localeCompare(right.candidate.id));
        const limited = limit !== undefined && matched.length > limit;
        const kept = limited ? matched.slice(0, limit) : matched;
        const partial: string[] = [];
        if (limited) partial.push(`the phrase limit kept ${limit} of ${matched.length} candidates`);
        if (skipped > 0) partial.push(`skipped ${skipped} symbolic-link ${skipped === 1 ? 'entry' : 'entries'}`);
        const candidates = kept.map(({ candidate, count }) => ({ ...candidate, laneScore: count }));
        if (reasons.length === 0) {
          return {
            status: 'read',
            ...(revision === undefined ? {} : { revision }),
            candidates,
            ...skippedAlwaysOn,
            complete: partial.length === 0,
            ...(partial.length === 0 ? {} : { partial: partial.join('; ') }),
          };
        }
        return {
          status: 'read',
          ...(revision === undefined ? {} : { revision }),
          candidates,
          ...skippedAlwaysOn,
          complete: false,
          partial: [...reasons, ...partial].join('; '),
        };
      }

      // The scoring pass re-reads each file and BM25-scores its parts
      // against the corpus statistics the first pass collected.
      const scores = new Float64Array(parts.length);
      const count = parts.length;
      const average = count === 0 ? 0 : totalLength / count;
      if (average > 0) {
        for (const group of groups) {
          let cursor = 0;
          for await (const { file, text } of fileTexts(group.state, group.files, context, request.signal)) {
            const meta = group.metas[cursor++]!;
            if (meta.partCount === 0) continue;
            const note = parseNote(text);
            let local = 0;
            for (const part of noteParts(note, file, meta.name, legacy, role === 'rule', partBudget)) {
              // A file that grew between passes emits extra parts; they
              // never had statistics, so they are skipped.
              if (local >= meta.partCount) break;
              const tokens = tokenize(part.text);
              const counts = new Map<string, number>();
              for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
              let score = 0;
              for (const term of terms) {
                const n = documentFrequency.get(term) ?? 0;
                const f = counts.get(term) ?? 0;
                if (n === 0 || f === 0) continue;
                const idf = Math.log(1 + (count - n + 0.5) / (n + 0.5));
                score += idf * (f * (keyword.k1 + 1))
                  / (f + keyword.k1 * (1 - keyword.b + keyword.b * (tokens.length / average)));
              }
              scores[meta.partStart + local] = score;
              local += 1;
            }
          }
        }
      }

      // Rank by the same signal sum the candidates report, slice the
      // read's limit, then — when the lane cut is on — keep what the
      // score curve keeps.
      const sums = parts.map((part, index) => {
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
      const ranked = parts.map((_, index) => index)
        .sort((left, right) => sums[right]! - sums[left]!
          || (parts[left]!.id < parts[right]!.id ? -1 : parts[left]!.id > parts[right]!.id ? 1 : 0));
      // A kind lane's lane is its exact-phrase matches, ranked by the
      // topic's signal sum — never by how often the phrase occurs, so a
      // direction said once survives a phrase everyone says.
      const laneRanked = kindLane
        ? ranked.filter((index) => (parts[index]!.phrased ?? 0) > 0)
        : ranked;
      // A keyword read's limit bounds the read itself; a kind lane's
      // caps what the score curve keeps.
      const pool = kindLane || limit === undefined ? laneRanked : laneRanked.slice(0, limit);
      const cut = request.wholeLanes === false;
      // With `wholeLanes` on the read keeps every part and marks each one
      // the cut would have dropped.
      const mark = request.wholeLanes === true;
      const bend = cut || mark ? laneBend(pool.map((index) => sums[index]!)) : undefined;
      // A cut keyword lane where nothing scored above zero matched
      // nothing: it keeps no parts rather than read back every body. A
      // kind lane still keeps its phrase matches, scored or not.
      const matched = kindLane || pool.some((index) => sums[index]! > 0);
      const passes = (index: number) => bend === undefined ? matched : sums[index]! > bend;
      const curveKept = cut ? pool.filter(passes) : pool;
      const kept = kindLane && limit !== undefined ? curveKept.slice(0, limit) : curveKept;
      const limitBase = kindLane ? curveKept.length : laneRanked.length;

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
        for await (const { file, text } of fileTexts(group.state, needed.map((meta) => meta.file), context, request.signal)) {
          const meta = needed[cursor++]!;
          const note = parseNote(text);
          let local = 0;
          for (const part of noteParts(note, file, meta.name, legacy, role === 'rule', partBudget)) {
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
        ...skippedAlwaysOn,
        complete: partial.length === 0 && reasons.length === 0,
        ...(partial.length === 0 && reasons.length === 0
          ? {}
          : { partial: [...reasons, ...partial].join('; ') }),
        ...(cut ? { laneCutApplied: true as const, matched: kindLane ? laneRanked.length : pool.length } : {}),
      };
    },
  };
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
