/** Small helpers shared by repositories. */

/** First row or `null`. */
export function maybeOne<T>(rows: readonly T[]): T | null {
  return rows[0] ?? null;
}

/** Exactly one row expected; throws otherwise (a programming/consistency error). */
export function one<T>(rows: readonly T[], what = 'row'): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`Expected ${what} but the query returned no rows`);
  return row;
}

// An escape that is not itself escaped (even run of backslashes before it): `\u0000` or a UTF-16
// surrogate. JSON.stringify writes valid surrogate pairs literally, so an escaped one is always lone.
const UNSTORABLE_JSON_ESCAPE = /(?<!\\)((?:\\\\)*)\\u(0000|d[89a-f][0-9a-f]{2})/gi;
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

/**
 * Serializes a value for a `$n::jsonb` parameter. Postgres jsonb rejects NUL and lone surrogates
 * (which model output can contain), and the error would abort the caller's transaction, so NUL is
 * dropped and lone surrogates become U+FFFD.
 */
export function jsonParam(value: unknown): string {
  return JSON.stringify(value ?? null).replace(
    UNSTORABLE_JSON_ESCAPE,
    (_match, backslashes: string, code: string) =>
      code === '0000' ? backslashes : `${backslashes}${REPLACEMENT_CHARACTER}`,
  );
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Check ids from outside the server before using them as `uuid` parameters (a bad cast aborts the transaction). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Fits text into a column: drops NUL (Postgres text cannot store it) and truncates to `maxChars`
 * UTF-16 units without splitting a surrogate pair, appending `suffix` when cut.
 */
export function truncateText(text: string, maxChars: number, suffix = ''): string {
  const clean = text.replaceAll('\u0000', '');
  if (clean.length <= maxChars) return clean;
  let end = Math.max(0, maxChars - suffix.length);
  const last = clean.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${clean.slice(0, end)}${suffix}`;
}

/** pgvector text literal for a `$n::extensions.vector` parameter. */
export function vectorParam(vector: readonly number[]): string {
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error('Embedding contains a non-finite value');
  }
  return `[${vector.join(',')}]`;
}

/** Postgres array literal for a `$n::text[]` / `$n::uuid[]` parameter. */
export function pgTextArray(values: readonly string[]): string {
  const escaped = values.map((value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return `{${escaped.join(',')}}`;
}

function isPgError(error: unknown, sqlState: string, constraint?: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { code?: unknown; constraint?: unknown; constraint_name?: unknown; message?: unknown };
  if (record.code !== sqlState) return false;
  if (!constraint) return true;
  const name = record.constraint ?? record.constraint_name;
  if (typeof name === 'string') return name === constraint;
  return typeof record.message === 'string' && record.message.includes(constraint);
}

/** Postgres unique_violation (23505), optionally for a specific constraint/index. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  return isPgError(error, '23505', constraint);
}

/** Postgres foreign_key_violation (23503) — e.g. a composite (id, organization_id) key naming another tenant's row. */
export function isForeignKeyViolation(error: unknown, constraint?: string): boolean {
  return isPgError(error, '23503', constraint);
}

/** Postgres insufficient_privilege (42501) — e.g. an RLS policy rejected a user-scope write. */
export function isPermissionDenied(error: unknown): boolean {
  return isPgError(error, '42501');
}

/** Converts a driver value (Date | string) to a Date. */
export function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') return new Date(value);
  throw new Error('Expected a timestamp value');
}

/** Converts a driver numeric (number | string | bigint) to a JS number. */
export function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  throw new Error('Expected a numeric value');
}
