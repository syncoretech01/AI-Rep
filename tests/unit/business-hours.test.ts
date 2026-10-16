import { describe, expect, it } from 'vitest';
import { computeHoursStatus, zonedTime } from '@/server/domain/business/hours';
import type { HoursInterval } from '@/server/domain/business/types';

const interval = (dayOfWeek: number, opensAt: string, closesAt: string): HoursInterval => ({ dayOfWeek, opensAt, closesAt });

/** Monday–Friday 09:00–17:00. */
const WEEKDAYS = [1, 2, 3, 4, 5].map((day) => interval(day, '09:00', '17:00'));
const NEW_YORK = 'America/New_York';
const KARACHI = 'Asia/Karachi';

// October 2026: Sunday the 4th … Saturday the 10th. New York is on EDT (UTC-4); Karachi is UTC+5 all year.
const at = (iso: string) => new Date(iso);

describe('zonedTime', () => {
  it('reads the weekday and minutes in the given timezone', () => {
    expect(zonedTime(at('2026-10-06T18:05:00Z'), NEW_YORK)).toEqual({ dayOfWeek: 2, minutes: 14 * 60 + 5 });
    expect(zonedTime(at('2026-10-06T18:05:00Z'), KARACHI)).toEqual({ dayOfWeek: 2, minutes: 23 * 60 + 5 });
    expect(zonedTime(at('2026-10-06T18:05:00Z'), 'UTC')).toEqual({ dayOfWeek: 2, minutes: 18 * 60 + 5 });
  });

  it('rolls over to the next local day', () => {
    expect(zonedTime(at('2026-10-06T20:30:00Z'), KARACHI)).toEqual({ dayOfWeek: 3, minutes: 90 });
  });

  it('handles offsets that are not whole hours', () => {
    // Kathmandu is UTC+05:45.
    expect(zonedTime(at('2026-10-06T18:05:00Z'), 'Asia/Kathmandu')).toEqual({ dayOfWeek: 2, minutes: 23 * 60 + 50 });
  });

  it('reports midnight as minute 0, never 24:00', () => {
    expect(zonedTime(at('2026-10-07T04:00:00Z'), NEW_YORK)).toEqual({ dayOfWeek: 3, minutes: 0 });
  });

  it('throws for an unknown timezone', () => {
    expect(() => zonedTime(at('2026-10-06T18:05:00Z'), 'Mars/Phobos')).toThrow(RangeError);
  });
});

describe('computeHoursStatus', () => {
  it('reports open hours with the next closing time', () => {
    expect(computeHoursStatus(WEEKDAYS, NEW_YORK, at('2026-10-06T18:05:00Z'))).toEqual({
      timezone: NEW_YORK,
      localTime: 'Tuesday 14:05',
      isOpenNow: true,
      weekly: [
        { day: 'Sunday', hours: [] },
        { day: 'Monday', hours: ['09:00-17:00'] },
        { day: 'Tuesday', hours: ['09:00-17:00'] },
        { day: 'Wednesday', hours: ['09:00-17:00'] },
        { day: 'Thursday', hours: ['09:00-17:00'] },
        { day: 'Friday', hours: ['09:00-17:00'] },
        { day: 'Saturday', hours: [] },
      ],
      nextChange: { kind: 'closes', at: 'Tuesday 17:00' },
    });
  });

  it('treats the opening minute as open and the closing minute as closed', () => {
    const opening = computeHoursStatus(WEEKDAYS, NEW_YORK, at('2026-10-06T13:00:00Z'));
    expect(opening).toMatchObject({ localTime: 'Tuesday 09:00', isOpenNow: true, nextChange: { kind: 'closes', at: 'Tuesday 17:00' } });

    const before = computeHoursStatus(WEEKDAYS, NEW_YORK, at('2026-10-06T12:59:00Z'));
    expect(before).toMatchObject({ localTime: 'Tuesday 08:59', isOpenNow: false, nextChange: { kind: 'opens', at: 'Tuesday 09:00' } });

    const closing = computeHoursStatus(WEEKDAYS, NEW_YORK, at('2026-10-06T21:00:00Z'));
    expect(closing).toMatchObject({ localTime: 'Tuesday 17:00', isOpenNow: false, nextChange: { kind: 'opens', at: 'Wednesday 09:00' } });
  });

  it('evaluates the same instant in each business timezone', () => {
    const instant = at('2026-10-06T13:30:00Z');
    expect(computeHoursStatus(WEEKDAYS, NEW_YORK, instant)).toMatchObject({ localTime: 'Tuesday 09:30', isOpenNow: true });
    expect(computeHoursStatus(WEEKDAYS, KARACHI, instant)).toMatchObject({
      localTime: 'Tuesday 18:30',
      isOpenNow: false,
      nextChange: { kind: 'opens', at: 'Wednesday 09:00' },
    });
    expect(computeHoursStatus(WEEKDAYS, KARACHI, at('2026-10-07T04:00:00Z'))).toMatchObject({
      localTime: 'Wednesday 09:00',
      isOpenNow: true,
    });
  });

  it('wraps from Saturday past a closed Sunday to Monday', () => {
    expect(computeHoursStatus(WEEKDAYS, NEW_YORK, at('2026-10-10T16:00:00Z'))).toMatchObject({
      localTime: 'Saturday 12:00',
      isOpenNow: false,
      nextChange: { kind: 'opens', at: 'Monday 09:00' },
    });
    // Friday evening also skips the weekend.
    expect(computeHoursStatus(WEEKDAYS, NEW_YORK, at('2026-10-09T23:00:00Z'))).toMatchObject({
      localTime: 'Friday 19:00',
      nextChange: { kind: 'opens', at: 'Monday 09:00' },
    });
  });

  it('finds the next opening a full week ahead when the only hours were earlier today', () => {
    const tuesdayMorning = [interval(2, '09:00', '10:00')];
    expect(computeHoursStatus(tuesdayMorning, NEW_YORK, at('2026-10-06T16:00:00Z'))).toMatchObject({
      localTime: 'Tuesday 12:00',
      isOpenNow: false,
      nextChange: { kind: 'opens', at: 'Tuesday 09:00' },
    });
  });

  it('follows local wall-clock time across the spring-forward DST change', () => {
    // 2026-03-08: New York jumps from 02:00 EST to 03:00 EDT (07:00Z). Opening 09:00 local is 13:00Z that day.
    const sunday = [interval(0, '01:00', '03:30'), interval(0, '09:00', '17:00')];
    expect(computeHoursStatus(sunday, NEW_YORK, at('2026-03-08T12:59:00Z'))).toMatchObject({
      localTime: 'Sunday 08:59',
      isOpenNow: false,
      nextChange: { kind: 'opens', at: 'Sunday 09:00' },
    });
    expect(computeHoursStatus(sunday, NEW_YORK, at('2026-03-08T13:00:00Z'))).toMatchObject({
      localTime: 'Sunday 09:00',
      isOpenNow: true,
    });
    // One real minute apart, across the skipped hour: 01:59 EST, then 03:00 EDT — both inside 01:00-03:30.
    expect(computeHoursStatus(sunday, NEW_YORK, at('2026-03-08T06:59:00Z'))).toMatchObject({
      localTime: 'Sunday 01:59',
      isOpenNow: true,
      nextChange: { kind: 'closes', at: 'Sunday 03:30' },
    });
    expect(computeHoursStatus(sunday, NEW_YORK, at('2026-03-08T07:00:00Z'))).toMatchObject({
      localTime: 'Sunday 03:00',
      isOpenNow: true,
    });
  });

  it('follows local wall-clock time across the fall-back DST change', () => {
    // 2026-11-01: 01:30 happens twice in New York (EDT at 05:30Z, EST at 06:30Z).
    const sunday = [interval(0, '01:00', '02:00')];
    for (const iso of ['2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z']) {
      expect(computeHoursStatus(sunday, NEW_YORK, at(iso))).toMatchObject({
        localTime: 'Sunday 01:30',
        isOpenNow: true,
        nextChange: { kind: 'closes', at: 'Sunday 02:00' },
      });
    }
  });

  it('treats 22:00-24:00 followed by 00:00-06:00 as one overnight opening', () => {
    const overnight = [interval(5, '22:00', '24:00'), interval(6, '00:00', '06:00')];
    expect(computeHoursStatus(overnight, NEW_YORK, at('2026-10-10T03:30:00Z'))).toMatchObject({
      localTime: 'Friday 23:30',
      isOpenNow: true,
      nextChange: { kind: 'closes', at: 'Saturday 06:00' },
    });
    expect(computeHoursStatus(overnight, NEW_YORK, at('2026-10-10T09:00:00Z'))).toMatchObject({
      localTime: 'Saturday 05:00',
      isOpenNow: true,
      nextChange: { kind: 'closes', at: 'Saturday 06:00' },
    });
    expect(computeHoursStatus(overnight, NEW_YORK, at('2026-10-10T10:00:00Z'))).toMatchObject({
      localTime: 'Saturday 06:00',
      isOpenNow: false,
      nextChange: { kind: 'opens', at: 'Friday 22:00' },
    });
  });

  it('joins Saturday night to Sunday morning across the end of the week', () => {
    const overnight = [interval(6, '22:00', '24:00'), interval(0, '00:00', '06:00')];
    expect(computeHoursStatus(overnight, NEW_YORK, at('2026-10-11T03:00:00Z'))).toMatchObject({
      localTime: 'Saturday 23:00',
      isOpenNow: true,
      nextChange: { kind: 'closes', at: 'Sunday 06:00' },
    });
    expect(computeHoursStatus(overnight, NEW_YORK, at('2026-10-11T05:00:00Z'))).toMatchObject({
      localTime: 'Sunday 01:00',
      isOpenNow: true,
      nextChange: { kind: 'closes', at: 'Sunday 06:00' },
    });
  });

  it('reports a midnight closing as the next day at 00:00', () => {
    expect(computeHoursStatus([interval(1, '18:00', '24:00')], NEW_YORK, at('2026-10-05T23:00:00Z'))).toMatchObject({
      localTime: 'Monday 19:00',
      isOpenNow: true,
      nextChange: { kind: 'closes', at: 'Tuesday 00:00' },
    });
  });

  it('lists several intervals per day in order', () => {
    const split = [interval(2, '13:00', '17:00'), interval(2, '08:00', '12:00')];
    const status = computeHoursStatus(split, NEW_YORK, at('2026-10-06T16:30:00Z'));
    expect(status.weekly[2]).toEqual({ day: 'Tuesday', hours: ['08:00-12:00', '13:00-17:00'] });
    expect(status).toMatchObject({ localTime: 'Tuesday 12:30', isOpenNow: false, nextChange: { kind: 'opens', at: 'Tuesday 13:00' } });
  });

  it('is never open without hours', () => {
    const status = computeHoursStatus([], KARACHI, at('2026-10-06T08:00:00Z'));
    expect(status).toMatchObject({ timezone: KARACHI, localTime: 'Tuesday 13:00', isOpenNow: false, nextChange: null });
    expect(status.weekly.every((day) => day.hours.length === 0)).toBe(true);
  });

  it('is always open around the clock, with no next change', () => {
    const always = [0, 1, 2, 3, 4, 5, 6].map((day) => interval(day, '00:00', '24:00'));
    expect(computeHoursStatus(always, NEW_YORK, at('2026-10-10T03:59:00Z'))).toMatchObject({
      localTime: 'Friday 23:59',
      isOpenNow: true,
      nextChange: null,
    });
  });
});
