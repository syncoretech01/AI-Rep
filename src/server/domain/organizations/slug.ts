/**
 * URL-safe organization slugs (e.g. `/o/acme-plumbing`). Every result satisfies
 * the `organizations.slug` check constraint.
 */

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
export const MAX_SLUG_LENGTH = 48;
const FALLBACK_SLUG = 'org';
/** Latin letters with no Unicode decomposition (NFKD keeps them), spelled as usually written in ASCII. */
const LATIN_LETTERS: Readonly<Record<string, string>> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  ł: 'l',
  þ: 'th',
  ı: 'i',
};

/** Lowercase ASCII with diacritics stripped; any other run of characters becomes one '-'. */
function clean(value: string, maxLength: number): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\P{ASCII}/gu, (char) => LATIN_LETTERS[char] ?? char)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, maxLength)
    .replace(/-+$/, '');
}

export function slugify(name: string): string {
  return clean(name, MAX_SLUG_LENGTH) || FALLBACK_SLUG;
}

/** `${base}-${suffix}`, shortening the base so the result is still a valid slug. */
export function slugWithSuffix(base: string, suffix: string): string {
  const tail = clean(suffix, MAX_SLUG_LENGTH - 2);
  if (!tail) return slugify(base);
  // A valid slug starts with [a-z0-9], so the truncated head is never empty.
  const head = clean(slugify(base), MAX_SLUG_LENGTH - tail.length - 1);
  return `${head}-${tail}`;
}
