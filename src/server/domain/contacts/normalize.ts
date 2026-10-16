import { z } from 'zod';

/**
 * Canonical forms used to match contacts within an organization
 * (`contacts.phone_normalized` / `contacts.email_normalized`).
 */

const PHONE_PATTERN = /^\+?[0-9]{7,15}$/;
const PHONE_FORMATTING = /[\s\-.()]/g;
// 254 = the contacts.email column limit (and the practical SMTP path limit).
const emailSchema = z.email().max(254);

/**
 * Digits with an optional single leading '+' (7–15 digits, the E.164 maximum).
 * Spaces, dashes, dots and parentheses are dropped; anything else (letters,
 * extensions, stray '+') is rejected rather than guessed at.
 */
export function normalizePhone(raw: string): string | null {
  const compact = raw.trim().replace(PHONE_FORMATTING, '');
  return PHONE_PATTERN.test(compact) ? compact : null;
}

/** Trimmed, lower-cased address, or null when it is not a valid email. */
export function normalizeEmail(raw: string): string | null {
  const candidate = raw.trim().toLowerCase();
  return emailSchema.safeParse(candidate).success ? candidate : null;
}
