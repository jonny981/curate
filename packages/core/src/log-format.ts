// The dated log's line format: the pattern an observation line must
// match and the check a writer reply passes. `curate` checks task logs
// with it and `observe` checks per-session observation logs with it.

export const WORKING_HEADING = "Working (the curator's; check it against the log):";

function isDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function logPatterns(ids: readonly string[]) {
  // Longest ids first, so an id that prefixes another never matches
  // part-way through the longer one.
  const sources = [...ids].sort((left, right) => right.length - left.length)
    .map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const date = '\\d{4}-\\d{2}-\\d{2}';
  const separator = '(?:,\\s*(?:and\\s+)?|;\\s*|\\s+(?:and|&)\\s+)';
  const sourceGroup = `(?:${sources})(?:${separator}(?:${sources}))*`;
  return {
    observation: new RegExp(`^(?<lineId>L\\d+ )?\\[(?<event>${date})\\] (?<text>.+?) \\((?<citations>said ${date}; ${sourceGroup}(?:;\\s*said ${date}; ${sourceGroup})*)\\)(?: \\(when not stated\\))?(?: \\(replaces (?:\\[(?<replacesDate>${date})\\]|(?<replacesId>L\\d+)(?::\\s*(?<replacesReason>[^()]+?))?)\\))?$`),
    preference: new RegExp(`(?:\\((?:${sources})(?:${separator}(?:${sources}))*\\)|\\[(?:${sources})(?:${separator}(?:${sources}))*\\])`),
    /** Matches each cited id inside a checked line's citation group. */
    source: new RegExp(sources, 'g'),
  };
}

export function checkLog(raw: unknown, working: boolean, ids: readonly string[], preferenceAdvice: boolean, preferenceChange: boolean): string {
  if (typeof raw !== 'string') throw new TypeError('curate: malformed log; write must return text.');
  const log = raw.trim();
  if (!log) throw new Error('curate: empty log.');

  const lines = log.split('\n').map((line) => line.trim()).filter(Boolean);
  const heading = lines.findIndex((line) => line.replace(/^#{1,6}\s+/, '') === WORKING_HEADING);
  if (heading !== -1 && (!working || heading === 0 || heading === lines.length - 1)) {
    throw new Error('curate: malformed log; unexpected or empty working section.');
  }
  const { observation, preference } = logPatterns(ids);
  let observations = 0;
  for (const [index, line] of lines.entries()) {
    if (line.startsWith('Advice preferences:') || line.startsWith('Changed preference:')) {
      if ((line.startsWith('Advice preferences:') && !preferenceAdvice)
        || (line.startsWith('Changed preference:') && !preferenceChange)) {
        throw new Error('curate: malformed log; unexpected preference line.');
      }
      const text = line.slice(line.indexOf(':') + 1).trim();
      if (!preference.test(text) || !text.replace(preference, '').replace(/[.!]/g, '').trim()) {
        throw new Error('curate: malformed log; preference lines need text and full source item ids in parentheses or brackets.');
      }
      continue;
    }
    if (heading !== -1 && index >= heading) continue;
    observations += 1;
    const match = observation.exec(line)?.groups;
    const saidDates = match?.citations?.matchAll(/(?:^|;\s*)said (\d{4}-\d{2}-\d{2});/g) ?? [];
    if (!match || !isDate(match.event!) || !match.text!.trim()
      || [...saidDates].some((entry) => !isDate(entry[1]!))
      || (match.replacesDate !== undefined && !isDate(match.replacesDate))) {
      throw new Error('curate: malformed log; each observation needs an event date, a said date, and a full item id.');
    }
  }
  if (!observations) throw new Error('curate: malformed log; at least one dated observation is required.');
  return log;
}
