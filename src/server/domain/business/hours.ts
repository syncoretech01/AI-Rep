import { DAY_NAMES, type HoursInterval } from './types';

/**
 * Opening-hours status in the agent's timezone. Everything is computed on local
 * wall-clock time (weekday + minutes since midnight), never by adding durations
 * to UTC instants, so DST transitions need no special handling: 09:00-17:00
 * means 09:00-17:00 local time on every day.
 */

const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;
const WEEKDAYS: Readonly<Record<string, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface HoursStatus {
  timezone: string;
  /** e.g. 'Tuesday 14:05' */
  localTime: string;
  isOpenNow: boolean;
  /** Sunday..Saturday; hours like ['09:00-17:00']; [] = closed. */
  weekly: Array<{ day: string; hours: string[] }>;
  /** e.g. { kind: 'opens', at: 'Wednesday 09:00' }; null when never open (or open around the clock). */
  nextChange: { kind: 'opens' | 'closes'; at: string } | null;
}

/** Minutes since Sunday 00:00 local time; `end` is exclusive and at most one week. */
interface Span {
  start: number;
  end: number;
}

type Change = { kind: 'opens' | 'closes'; at: number };

export function zonedTime(now: Date, timezone: string): { dayOfWeek: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  const dayOfWeek = WEEKDAYS[part('weekday')];
  const hour = Number.parseInt(part('hour'), 10);
  const minute = Number.parseInt(part('minute'), 10);
  if (dayOfWeek === undefined || Number.isNaN(hour) || Number.isNaN(minute)) {
    throw new Error(`Could not read the local time in ${timezone}`);
  }
  return { dayOfWeek, minutes: (hour % 24) * 60 + minute };
}

export function computeHoursStatus(intervals: readonly HoursInterval[], timezone: string, now: Date): HoursStatus {
  const local = zonedTime(now, timezone);
  const nowMinute = local.dayOfWeek * MINUTES_PER_DAY + local.minutes;
  const spans = openSpans(intervals);
  return {
    timezone,
    localTime: `${dayName(local.dayOfWeek)} ${formatMinutes(local.minutes)}`,
    isOpenNow: spans.some((span) => span.start <= nowMinute && nowMinute < span.end),
    weekly: DAY_NAMES.map((day, dayOfWeek) => ({
      day,
      hours: intervals
        .filter((interval) => interval.dayOfWeek === dayOfWeek)
        .sort((a, b) => toMinutes(a.opensAt) - toMinutes(b.opensAt))
        .map((interval) => `${interval.opensAt}-${interval.closesAt}`),
    })),
    nextChange: nextChange(spans, nowMinute),
  };
}

/** Intervals as week spans, merged when they overlap or touch (e.g. 22:00-24:00 + next day 00:00-06:00). */
function openSpans(intervals: readonly HoursInterval[]): Span[] {
  const spans = intervals
    .map((interval) => {
      const dayStart = interval.dayOfWeek * MINUTES_PER_DAY;
      return { start: dayStart + toMinutes(interval.opensAt), end: dayStart + toMinutes(interval.closesAt) };
    })
    .filter((span) => span.start >= 0 && span.end <= MINUTES_PER_WEEK && span.end > span.start)
    .sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

/** The first open/close change strictly after now, wrapping into next week. */
function nextChange(spans: readonly Span[], nowMinute: number): HoursStatus['nextChange'] {
  // Saturday 24:00 runs straight into Sunday 00:00: those two edges are not changes.
  const wraps = spans[0]?.start === 0 && spans.at(-1)?.end === MINUTES_PER_WEEK;
  const changes: Change[] = [];
  for (const span of spans) {
    if (!(wraps && span.start === 0)) changes.push({ kind: 'opens', at: span.start });
    if (!(wraps && span.end === MINUTES_PER_WEEK)) changes.push({ kind: 'closes', at: span.end % MINUTES_PER_WEEK });
  }

  let next: (Change & { ahead: number }) | null = null;
  for (const change of changes) {
    const delta = (change.at - nowMinute + MINUTES_PER_WEEK) % MINUTES_PER_WEEK;
    // A change exactly at "now" has already happened; its next occurrence is a week away.
    const ahead = delta === 0 ? MINUTES_PER_WEEK : delta;
    if (!next || ahead < next.ahead) next = { ...change, ahead };
  }
  if (!next) return null;
  const day = Math.floor(next.at / MINUTES_PER_DAY);
  return { kind: next.kind, at: `${dayName(day)} ${formatMinutes(next.at % MINUTES_PER_DAY)}` };
}

/** 'HH:MM' -> minutes since midnight ('24:00' -> 1440); NaN when malformed. */
function toMinutes(time: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN;
}

function formatMinutes(minutes: number): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

function dayName(dayOfWeek: number): string {
  return DAY_NAMES[dayOfWeek] ?? 'Unknown day';
}
