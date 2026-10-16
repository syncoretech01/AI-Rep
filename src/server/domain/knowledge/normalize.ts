/**
 * Text normalization for knowledge. Pure and deterministic: the stored document
 * (and its content hash) is the normalized text, and queries are normalized the
 * same way every time so identical questions embed identically.
 */

// Line separators other than LF: CRLF, lone CR, VT, FF, NEL, LINE/PARAGRAPH SEPARATOR.
const LINE_BREAKS = /\r\n?|[\v\f\u{85}\u{2028}\u{2029}]/gu;
// C0/C1 control characters except TAB and LF (Postgres text cannot even hold NUL).
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
const ANY_CONTROL_CHAR = /[\u0000-\u001F\u007F-\u009F]/g;
const BOM = /\u{FEFF}/gu;
// Three or more consecutive blank lines.
const EXCESS_BLANK_LINES = /\n{4,}/g;

const MAX_QUERY_CHARS = 500;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Canonical form of knowledge text: NFC; BOMs and control characters removed
 * (TAB/LF kept); every line break becomes LF; tabs become spaces; trailing
 * whitespace trimmed per line; at most two consecutive blank lines; trimmed.
 * Markdown structure (headings, lists, indentation) is preserved for chunking.
 */
export function normalizeKnowledgeText(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(BOM, '')
    .replace(LINE_BREAKS, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(/\t/g, ' ')
    // Per line, not a `[^\S\n]+$` regex: that backtracks quadratically on long runs of spaces.
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(EXCESS_BLANK_LINES, '\n\n\n')
    .trim();
}

/** Single-line text (titles, file names): NFC, control characters and whitespace runs become one space, trimmed. */
export function normalizeLabel(raw: string): string {
  return raw.normalize('NFC').replace(ANY_CONTROL_CHAR, ' ').replace(/\s+/g, ' ').trim();
}

/** A retrieval query: single line, at most 500 characters (never splitting a surrogate pair). */
export function normalizeQuery(raw: string): string {
  const text = normalizeLabel(raw);
  if (text.length <= MAX_QUERY_CHARS) return text;
  const end = isHighSurrogate(text.charCodeAt(MAX_QUERY_CHARS - 1)) ? MAX_QUERY_CHARS - 1 : MAX_QUERY_CHARS;
  return text.slice(0, end).trimEnd();
}
