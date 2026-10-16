import { z } from 'zod';
import { DAY_NAMES } from './types';

/**
 * Business profile and opening hours rules. Lengths mirror the
 * business_profiles / business_hours checks in supabase/migrations. Isomorphic:
 * the admin UI may reuse them; the server always re-validates. Messages are safe
 * to show to an admin user.
 */

/** Optional text input: trimmed; missing or blank -> null. */
function blankToNull() {
  return z
    .string()
    .trim()
    .nullish()
    .transform((value) => (value === '' ? null : (value ?? null)));
}

function optionalText(maxChars: number, label: string) {
  return blankToNull().pipe(
    z.string().max(maxChars, `Keep the ${label} to ${maxChars.toLocaleString('en-US')} characters or fewer.`).nullable(),
  );
}

export const businessProfileSchema = z.object({
  businessName: optionalText(160, 'business name'),
  description: optionalText(1000, 'description'),
  phone: optionalText(40, 'phone number'),
  email: blankToNull().pipe(
    z.email('Enter a valid email address.').max(254, 'Keep the email address to 254 characters or fewer.').nullable(),
  ),
  website: blankToNull().pipe(
    z
      .httpUrl('Enter a full web address starting with https://')
      .max(300, 'Keep the web address to 300 characters or fewer.')
      .nullable(),
  ),
  address: optionalText(500, 'address'),
  serviceArea: optionalText(500, 'service area'),
});

export type BusinessProfileInput = z.output<typeof businessProfileSchema>;

/** 'HH:MM' from 00:00 to 24:00 (end of day). Zero-padded, so string order is time order. */
const TIME_OF_DAY = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/;
const TIME_MESSAGE = 'Use a time between 00:00 and 24:00 (HH:MM).';

function compareTimes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Times are compared as strings, which is only meaningful for well-formed 'HH:MM' values ('9:00'
 * sorts after '17:00'). A malformed time already has its own issue, so the ordering and overlap
 * checks skip it instead of adding a misleading second error.
 */
function hasValidTimes(interval: { opensAt: string; closesAt: string }): boolean {
  return TIME_OF_DAY.test(interval.opensAt) && TIME_OF_DAY.test(interval.closesAt);
}

export const hoursIntervalSchema = z
  .object({
    dayOfWeek: z.int('Choose a day of the week.').min(0, 'Choose a day of the week.').max(6, 'Choose a day of the week.'),
    opensAt: z.string().regex(TIME_OF_DAY, TIME_MESSAGE),
    closesAt: z.string().regex(TIME_OF_DAY, TIME_MESSAGE),
  })
  .refine((interval) => !hasValidTimes(interval) || interval.closesAt > interval.opensAt, {
    error: 'Closing time must be after opening time.',
    path: ['closesAt'],
  });

export const weeklyHoursSchema = z
  .array(hoursIntervalSchema)
  .max(28, 'Add at most 28 opening intervals.')
  .superRefine((intervals, ctx) => {
    const ordered = intervals
      .map((interval, index) => ({ interval, index }))
      // Intervals that are invalid on their own are already reported; comparing them would invent overlaps.
      .filter(({ interval }) => hasValidTimes(interval) && interval.closesAt > interval.opensAt)
      .sort((a, b) => a.interval.dayOfWeek - b.interval.dayOfWeek || compareTimes(a.interval.opensAt, b.interval.opensAt));
    // Compare against the latest closing time so far: an interval can overlap one that is not its neighbour.
    let day = -1;
    let latestClose = '';
    for (const { interval, index } of ordered) {
      if (interval.dayOfWeek !== day) {
        day = interval.dayOfWeek;
        latestClose = interval.closesAt;
        continue;
      }
      if (interval.opensAt < latestClose) {
        ctx.addIssue({
          code: 'custom',
          message: `${DAY_NAMES[day] ?? 'This day'} has overlapping opening hours.`,
          path: [index],
        });
      }
      if (interval.closesAt > latestClose) latestClose = interval.closesAt;
    }
  });
