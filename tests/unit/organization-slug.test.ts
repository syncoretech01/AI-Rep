import { describe, expect, it } from 'vitest';
import { MAX_SLUG_LENGTH, SLUG_PATTERN, slugWithSuffix, slugify } from '@/server/domain/organizations/slug';

/** Deterministic PRNG (mulberry32) so the generated cases are reproducible. */
function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const CHARS = ['a', 'Z', '0', '9', '-', '_', ' ', '.', '&', '/', 'é', 'Ø', 'ß', 'İ', '日', '🙂', '́', 'Ａ', '\t'];

function randomName(random: () => number): string {
  const length = Math.floor(random() * 80);
  return Array.from({ length }, () => CHARS[Math.floor(random() * CHARS.length)]).join('');
}

describe('slugify', () => {
  it.each([
    ['Acme Plumbing', 'acme-plumbing'],
    ['  Acme   Plumbing & Heating, LLC.  ', 'acme-plumbing-heating-llc'],
    ['Crème Brûlée Bakery', 'creme-brulee-bakery'],
    ['İstanbul Kebab', 'istanbul-kebab'],
    ['ＡＣＭＥ １２３', 'acme-123'],
    ['24/7 Locksmiths', '24-7-locksmiths'],
    ['--Hello--World--', 'hello-world'],
    // Letters that Unicode does not decompose into a base letter + accent.
    ['Łódź Pizza', 'lodz-pizza'],
    ['Straße Ørsted', 'strasse-orsted'],
    ['ĐÀ NẴNG Œuvre Æsir Þór', 'da-nang-oeuvre-aesir-thor'],
  ])('%j -> %j', (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });

  it.each(['', '   ', '!!!', '日本語', '🙂🙂'])('falls back to "org" for %j', (name) => {
    expect(slugify(name)).toBe('org');
  });

  it('caps the length without leaving a separator at the cut', () => {
    expect(slugify(`${'a'.repeat(47)} b c`)).toBe('a'.repeat(47));
    expect(slugify('x'.repeat(200))).toBe('x'.repeat(MAX_SLUG_LENGTH));
  });

  it('always returns a slug the database accepts', () => {
    const random = prng(20261008);
    for (let i = 0; i < 2000; i += 1) {
      const slug = slugify(randomName(random));
      expect(slug).toMatch(SLUG_PATTERN);
      expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    }
  });
});

describe('slugWithSuffix', () => {
  it('appends the suffix to the base slug', () => {
    expect(slugWithSuffix('acme-plumbing', 'x7k2')).toBe('acme-plumbing-x7k2');
    expect(slugWithSuffix('Acme Plumbing', 'ab12')).toBe('acme-plumbing-ab12');
  });

  it('shortens a long base so the result fits', () => {
    const slug = slugWithSuffix('b'.repeat(MAX_SLUG_LENGTH), 'q9z1');
    expect(slug).toBe(`${'b'.repeat(43)}-q9z1`);
    expect(slug).toHaveLength(MAX_SLUG_LENGTH);
  });

  it('does not leave a double separator where the base is cut', () => {
    const base = `${'a'.repeat(42)}-bbbbb`;
    expect(slugWithSuffix(base, 'q9z1')).toBe(`${'a'.repeat(42)}-q9z1`);
  });

  it('normalizes the suffix and ignores an empty one', () => {
    expect(slugWithSuffix('acme', ' X-Y ')).toBe('acme-x-y');
    expect(slugWithSuffix('acme', '!!')).toBe('acme');
  });

  it('always returns a slug the database accepts', () => {
    const random = prng(42);
    for (let i = 0; i < 2000; i += 1) {
      const slug = slugWithSuffix(randomName(random), randomName(random));
      expect(slug).toMatch(SLUG_PATTERN);
      expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    }
  });
});
