/**
 * Report periods (L27): UTC calendar periods only. There is no timezone setting in the product,
 * so a week is one ISO-8601 week (Monday 00:00 → next Monday 00:00 UTC) and a month is one calendar
 * month. `from` is inclusive and `to` exclusive.
 */

const DAY = 86_400_000;

export interface ReportPeriod {
  from: string;
  to: string;
}

export interface WeeklyPeriod extends ReportPeriod {
  /** `YYYY-Www`, numbered by the ISO year of the week, not by the calendar year of the day. */
  id: string;
  firstDay: string;
  lastDay: string;
}

export interface MonthlyPeriod extends ReportPeriod {
  /** `YYYY-MM`. */
  id: string;
  firstDay: string;
  lastDay: string;
}

const iso = (ms: number) => new Date(ms).toISOString();
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const pad = (value: number) => String(value).padStart(2, "0");

function instant(ms: number): number {
  if (!Number.isFinite(ms)) throw new Error("invalid report instant");
  return ms;
}

/** Monday 00:00 UTC of the week that contains `ms`. */
export function startOfWeek(ms: number): number {
  const midnight = Math.floor(instant(ms) / DAY) * DAY;
  // getUTCDay(): Sunday = 0; ISO weeks start on Monday.
  const weekday = (new Date(midnight).getUTCDay() + 6) % 7;
  return midnight - weekday * DAY;
}

/** 1st 00:00 UTC of the month that contains `ms`. */
export function startOfMonth(ms: number): number {
  const date = new Date(instant(ms));
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/** The Thursday of a week identifies its ISO year (the week belongs to the year of its Thursday). */
export function isoWeekId(ms: number): string {
  const thursday = startOfWeek(ms) + 3 * DAY;
  const year = new Date(thursday).getUTCFullYear();
  const firstThursday = startOfWeek(Date.UTC(year, 0, 4)) + 3 * DAY;
  const week = Math.round((thursday - firstThursday) / (7 * DAY)) + 1;
  return `${year}-W${pad(week)}`;
}

/** The ISO week that contains `anchor`. */
export function weekPeriod(anchor: number): WeeklyPeriod {
  const from = startOfWeek(anchor);
  const to = from + 7 * DAY;
  return {
    id: isoWeekId(anchor),
    from: iso(from),
    to: iso(to),
    firstDay: day(from),
    lastDay: day(to - DAY),
  };
}

/** The last week that ended before `now`; the week in progress is never reported. */
export function lastEndedWeek(now: number): WeeklyPeriod {
  return weekPeriod(startOfWeek(now) - DAY);
}

/** The calendar month that contains `anchor`. */
export function monthPeriod(anchor: number): MonthlyPeriod {
  const from = startOfMonth(anchor);
  const date = new Date(from);
  const to = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  return {
    id: `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`,
    from: iso(from),
    to: iso(to),
    firstDay: day(from),
    lastDay: day(to - DAY),
  };
}

/** The last month that ended before `now`; the month in progress is never reported. */
export function lastEndedMonth(now: number): MonthlyPeriod {
  return monthPeriod(startOfMonth(now) - DAY);
}
