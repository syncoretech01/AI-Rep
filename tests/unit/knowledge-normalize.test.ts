import { describe, expect, it } from 'vitest';
import { normalizeKnowledgeText, normalizeLabel, normalizeQuery } from '@/server/domain/knowledge/normalize';
import { MAX_KNOWLEDGE_TEXT_CHARS } from '@/server/domain/knowledge/schemas';

const BOM = '\u{FEFF}';
// In unicode mode a valid pair is one code point, so any surrogate matched here is unpaired.
const LONE_SURROGATE = /[\u{D800}-\u{DFFF}]/u;

describe('normalizeKnowledgeText', () => {
  it('composes Unicode to NFC', () => {
    expect(normalizeKnowledgeText('Cafe\u{301} menu')).toBe('Caf\u{E9} menu');
  });

  it('strips byte order marks anywhere', () => {
    expect(normalizeKnowledgeText(`${BOM}Hello${BOM} world`)).toBe('Hello world');
  });

  it('turns every line break into LF', () => {
    expect(normalizeKnowledgeText('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
    expect(normalizeKnowledgeText('a\vb\fc\u{2028}d\u{2029}e\u{85}f')).toBe('a\nb\nc\nd\ne\nf');
  });

  it('removes control characters but keeps tabs (as spaces) and newlines', () => {
    const controls = String.fromCharCode(0, 7, 8, 0x1b, 0x1f, 0x7f, 0x9f);
    expect(normalizeKnowledgeText(`a${controls}b\tc\nd`)).toBe('ab c\nd');
  });

  it('trims trailing whitespace on every line and the text as a whole', () => {
    expect(normalizeKnowledgeText('\n\n  first  \nsecond\t\n third \n\n')).toBe('first\nsecond\n third');
  });

  it('keeps at most two consecutive blank lines (whitespace-only lines count as blank)', () => {
    expect(normalizeKnowledgeText('a\n\n\nb')).toBe('a\n\n\nb');
    expect(normalizeKnowledgeText('a\n\n\n\n\n\nb')).toBe('a\n\n\nb');
    expect(normalizeKnowledgeText('a\n  \n\t\n \n\nb')).toBe('a\n\n\nb');
  });

  it('preserves Markdown structure', () => {
    const markdown = '# Title\n\n- one\n- two\n\n    indented code\n\n## Next';
    expect(normalizeKnowledgeText(markdown)).toBe(markdown);
  });

  it('returns an empty string for whitespace or control characters only', () => {
    expect(normalizeKnowledgeText(` \n\t${BOM}${String.fromCharCode(0, 1)}\r\n `)).toBe('');
  });

  it('runs in linear time on long runs of spaces (maximum text size)', () => {
    const text = `a${' '.repeat(MAX_KNOWLEDGE_TEXT_CHARS - 2)}b\nc ${' '.repeat(1000)}`;
    const start = performance.now();
    expect(normalizeKnowledgeText(text)).toBe(`a${' '.repeat(MAX_KNOWLEDGE_TEXT_CHARS - 2)}b\nc`);
    // A backtracking trailing-whitespace regex took minutes on this input; linear work takes milliseconds.
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('normalizeLabel', () => {
  it('produces a single trimmed line', () => {
    expect(normalizeLabel(`  Price${String.fromCharCode(0)}list\n\t2026  `)).toBe('Price list 2026');
  });
});

describe('normalizeQuery', () => {
  it('collapses whitespace, trims and composes to NFC', () => {
    expect(normalizeQuery('  What   are\n\tyour  hours? ')).toBe('What are your hours?');
    expect(normalizeQuery('cafe\u{301}')).toBe('caf\u{E9}');
  });

  it('replaces control characters with spaces', () => {
    expect(normalizeQuery(`boiler${String.fromCharCode(0)}repair${BOM}`)).toBe('boiler repair');
  });

  it('caps the query at 500 characters', () => {
    expect(normalizeQuery('x'.repeat(600))).toHaveLength(500);
    expect(normalizeQuery(`${'word '.repeat(99)}abcd efgh`)).toBe(`${'word '.repeat(99)}abcd`);
  });

  it('never splits a surrogate pair when capping', () => {
    const query = normalizeQuery(`a${'\u{1F600}'.repeat(300)}`);
    expect(query.length).toBeLessThanOrEqual(500);
    expect(LONE_SURROGATE.test(query)).toBe(false);
    expect(query.endsWith('\u{1F600}')).toBe(true);
  });

  it('returns an empty string for blank input', () => {
    expect(normalizeQuery(' \n\t ')).toBe('');
  });
});
