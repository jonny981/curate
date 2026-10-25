/** A span of days a task names, from the start of its first day to the
 *  end of its last, each an ISO date-time with the zone's offset. */
export interface TaskPeriod {
  readonly from: string;
  readonly to: string;
}

const DAY = 86_400_000;
const TASK_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december'];
const PERIOD = new RegExp([
  String.raw`\b(?<iso>\d{4}-\d{2}-\d{2})\b`,
  String.raw`\b(?:(?<dayBefore>\d{1,2})\s+)?(?<month>${MONTHS.join('|')})(?:\s+(?<dayAfter>\d{1,2})(?!\d))?(?:,?\s+(?<year>\d{4}))?\b`,
  String.raw`\b(?:in|during)\s+(?<onlyYear>\d{4})\b`,
  String.raw`\b(?<relative>today|yesterday|(?:this|last)\s+(?:week|month|year))\b`,
  String.raw`\b(?<count>\d+)\s+(?<unit>days?|weeks?|months?)\s+ago\b`,
].join('|'), 'gi');

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The zone's formatter; a name Intl does not know throws a TypeError. */
function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (format === undefined) {
    if (typeof timeZone !== 'string' || !timeZone.trim()) {
      throw new TypeError('timeZone must be an IANA time zone name such as Europe/London.');
    }
    try {
      format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric',
        day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    } catch {
      throw new TypeError('timeZone must be an IANA time zone name such as Europe/London.');
    }
    formatters.set(timeZone, format);
  }
  return format;
}

/** The time zone a call reads dates in: the one given, checked, or the system's own. */
export function timeZoneOf(timeZone?: string): string {
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  formatter(zone);
  return zone;
}

/** The zone's wall clock at a moment, to the second. */
function wall(ms: number, timeZone: string) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(ms)
    .filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute!,
    second: parts.second! };
}

/** The last offset read, by zone and quarter hour: the zones in use
 *  change offset on a quarter hour, and a transcript's parts arrive mostly in
 *  time order, so most reads reuse it. */
let lastOffset: { zone: string; quarter: number; offset: number } | undefined;

/** The zone's offset from UTC at a moment, in minutes. */
function offsetAt(ms: number, timeZone: string): number {
  const quarter = Math.floor(ms / 900_000);
  if (lastOffset?.zone === timeZone && lastOffset.quarter === quarter) return lastOffset.offset;
  const at = wall(ms, timeZone);
  const second = Math.floor(ms / 1000) * 1000;
  const offset = Math.round((Date.UTC(at.year, at.month - 1, at.day, at.hour, at.minute, at.second) - second) / 60_000);
  lastOffset = { zone: timeZone, quarter, offset };
  return offset;
}

/** The moment a wall-clock time in the zone names. */
function zonedTime(year: number, month: number, day: number, hour: number, minute: number, second: number,
  ms: number, timeZone: string): number {
  const local = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const first = local - offsetAt(local, timeZone) * 60_000;
  const offset = offsetAt(first, timeZone);
  return local - offset * 60_000;
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** A moment as an ISO date-time with the zone's offset, such as
 *  `2025-06-02T00:30:00.000+01:00`. UTC is written `+00:00`. */
export function zonedIso(ms: number, timeZone: string): string {
  const offset = offsetAt(ms, timeZone);
  const local = new Date(ms + offset * 60_000).toISOString().slice(0, 23);
  const abs = Math.abs(offset);
  return `${local}${offset < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** The moment a task date names: an ISO 8601 date or date-time. A date
 *  without a time is the end of that day in the zone; a time without an
 *  offset is a wall-clock time in the zone. Absent means now. Anything
 *  else throws a TypeError. */
export function taskMoment(taskDate: string | undefined, timeZone?: string): number {
  const zone = timeZoneOf(timeZone);
  if (taskDate === undefined) return Date.now();
  const match = typeof taskDate === 'string' ? TASK_DATE.exec(taskDate) : null;
  const [year, month, day, hour, minute, second] = (match?.slice(1, 7) ?? []).map((part) => Number(part ?? 0));
  const offset = match?.[8];
  const digits = offset === undefined || offset === 'Z' ? '' : offset.slice(1).replace(':', '');
  if (match === null || month! < 1 || month! > 12 || day! < 1 || day! > daysIn(year!, month!)
    || hour! > 23 || minute! > 59 || second! > 59 || Number(digits.slice(0, 2)) > 23 || Number(digits.slice(2)) > 59) {
    throw new TypeError('taskDate must be an ISO 8601 date or date-time, such as 2025-06-02 or 2025-06-02T09:15:00+01:00.');
  }
  if (match[4] === undefined) return zonedTime(year!, month!, day!, 23, 59, 59, 999, zone);
  const ms = Number((match[7] ?? '0').padEnd(3, '0').slice(0, 3));
  if (offset === undefined) return zonedTime(year!, month!, day!, hour!, minute!, second!, ms, zone);
  const local = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!, ms);
  if (offset === 'Z') return local;
  const minutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || 0);
  return local - (offset.startsWith('-') ? -minutes : minutes) * 60_000;
}

/** True when a part's date value falls inside the period. A date
 *  without a time is a day, compared with the period's days. */
export function datedIn(value: string, period: TaskPeriod): boolean {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value >= period.from.slice(0, 10) && value <= period.to.slice(0, 10);
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= Date.parse(period.from) && ms <= Date.parse(period.to);
}

/**
 * The period a task names, or undefined. Reads only these English forms:
 * a month after "in", "during" or "of", or a month with a year or a day
 * ("in March", "March 2024", "3 March", "March 3"); a year after "in" or
 * "during"; "today", "yesterday", "this week", "last week", "this
 * month", "last month", "this year", "last year"; "N days ago", "N weeks
 * ago", "N months ago"; and an ISO date such as 2025-03-04. A month or a
 * day with no year is its latest occurrence on or before `asOf`. Weeks
 * start on Monday. Several periods give one span, from the earliest
 * start to the latest end. `asOf` takes the forms a task date takes and
 * defaults to now; `timeZone` defaults to the system's own.
 */
export function taskPeriod(
  task: string,
  options: { readonly asOf?: string; readonly timeZone?: string } = {},
): TaskPeriod | undefined {
  const zone = timeZoneOf(options.timeZone);
  const now = wall(taskMoment(options.asOf, zone), zone);
  const today = Date.UTC(now.year, now.month - 1, now.day) / DAY;
  const dayOf = (year: number, month: number, day: number) => Date.UTC(year, month - 1, day) / DAY;
  const valid = (year: number, month: number, day: number) => day >= 1 && day <= daysIn(year, month);
  const monday = (day: number) => day - ((new Date(day * DAY).getUTCDay() + 6) % 7);
  const monthSpan = (year: number, month: number): [number, number] =>
    [Date.UTC(year, month - 1, 1) / DAY, Date.UTC(year, month, 0) / DAY];
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  const add = ([from, to]: [number, number]) => { start = Math.min(start, from); end = Math.max(end, to); };
  for (const match of task.matchAll(PERIOD)) {
    const found = match.groups!;
    if (found.iso !== undefined) {
      const [year, month, day] = found.iso.split('-').map(Number) as [number, number, number];
      if (month >= 1 && month <= 12 && valid(year, month, day)) add([dayOf(year, month, day), dayOf(year, month, day)]);
    } else if (found.month !== undefined) {
      const month = MONTHS.indexOf(found.month.toLowerCase()) + 1;
      const day = found.dayBefore ?? found.dayAfter;
      const before = task.slice(0, match.index);
      if (day === undefined && found.year === undefined && !/\b(?:in|during|of)\s+$/i.test(before)) continue;
      if (day === undefined) {
        const year = found.year === undefined ? (month <= now.month ? now.year : now.year - 1) : Number(found.year);
        add(monthSpan(year, month));
        continue;
      }
      let year = found.year === undefined ? now.year : Number(found.year);
      if (found.year === undefined && dayOf(year, month, Number(day)) > today) year -= 1;
      if (valid(year, month, Number(day))) add([dayOf(year, month, Number(day)), dayOf(year, month, Number(day))]);
    } else if (found.onlyYear !== undefined) {
      const year = Number(found.onlyYear);
      add([dayOf(year, 1, 1), dayOf(year, 12, 31)]);
    } else if (found.relative !== undefined) {
      const [which, unit] = found.relative.toLowerCase().split(/\s+/) as [string, string | undefined];
      if (which === 'today') add([today, today]);
      else if (which === 'yesterday') add([today - 1, today - 1]);
      else if (unit === 'week') {
        const first = monday(today) - (which === 'last' ? 7 : 0);
        add([first, first + 6]);
      } else if (unit === 'month') add(monthSpan(now.year, now.month - (which === 'last' ? 1 : 0)));
      else {
        const year = now.year - (which === 'last' ? 1 : 0);
        add([dayOf(year, 1, 1), dayOf(year, 12, 31)]);
      }
    } else {
      const count = Number(found.count);
      const unit = found.unit!.toLowerCase();
      if (unit.startsWith('day')) add([today - count, today - count]);
      else if (unit.startsWith('week')) {
        const first = monday(today) - 7 * count;
        add([first, first + 6]);
      } else add(monthSpan(now.year, now.month - count));
    }
  }
  if (!Number.isFinite(start)) return undefined;
  const at = (day: number, last: boolean) => {
    const date = new Date(day * DAY);
    return zonedIso(zonedTime(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(),
      last ? 23 : 0, last ? 59 : 0, last ? 59 : 0, last ? 999 : 0, zone), zone);
  };
  return { from: at(start, false), to: at(end, true) };
}
