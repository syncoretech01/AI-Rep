import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_KNOWLEDGE_EXTENSIONS,
  MAX_KNOWLEDGE_FILE_BYTES,
  MAX_KNOWLEDGE_TEXT_CHARS,
  decodeKnowledgeFile,
  textSourceInputSchema,
  validateKnowledgeFile,
} from '@/server/domain/knowledge/schemas';

function firstIssue(input: unknown): string | undefined {
  const result = textSourceInputSchema.safeParse(input);
  return result.success ? undefined : result.error.issues[0]?.message;
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe('limits', () => {
  it('match the product rules', () => {
    expect(MAX_KNOWLEDGE_TEXT_CHARS).toBe(200_000);
    expect(MAX_KNOWLEDGE_FILE_BYTES).toBe(1_000_000);
    expect(ALLOWED_KNOWLEDGE_EXTENSIONS).toEqual(['.txt', '.md', '.markdown']);
  });
});

describe('textSourceInputSchema', () => {
  it('accepts a valid text source and normalizes the title to one trimmed line', () => {
    const agentId = randomUUID();
    const result = textSourceInputSchema.parse({
      title: `  Price${String.fromCharCode(0)}list \n 2026 `,
      text: 'Our call-out fee is $89.',
      agentId,
    });
    expect(result).toEqual({ title: 'Price list 2026', text: 'Our call-out fee is $89.', agentId });
    expect(textSourceInputSchema.parse({ title: 'Shared', text: 'x', agentId: null }).agentId).toBeNull();
  });

  it('requires a title of at most 200 characters', () => {
    expect(firstIssue({ title: '   ', text: 'x', agentId: null })).toBe('Enter a title.');
    expect(firstIssue({ title: 'a'.repeat(200), text: 'x', agentId: null })).toBeUndefined();
    expect(firstIssue({ title: 'a'.repeat(201), text: 'x', agentId: null })).toBe(
      'Keep the title to 200 characters or fewer.',
    );
  });

  it('requires non-blank text within the size limit', () => {
    expect(firstIssue({ title: 't', text: '', agentId: null })).toBe('Enter some text.');
    expect(firstIssue({ title: 't', text: ' \n\t ', agentId: null })).toBe('Enter some text.');
    expect(firstIssue({ title: 't', text: 'a'.repeat(MAX_KNOWLEDGE_TEXT_CHARS), agentId: null })).toBeUndefined();
    expect(firstIssue({ title: 't', text: 'a'.repeat(MAX_KNOWLEDGE_TEXT_CHARS + 1), agentId: null })).toBe(
      'The text is too long (maximum 200,000 characters).',
    );
  });

  it('requires a valid agent id or null', () => {
    expect(firstIssue({ title: 't', text: 'x', agentId: 'front-desk' })).toBe('Choose a valid agent.');
    expect(firstIssue({ title: 't', text: 'x' })).toBeDefined();
  });
});

describe('validateKnowledgeFile', () => {
  it('accepts TXT and Markdown files and derives the MIME type from the extension', () => {
    expect(validateKnowledgeFile({ name: 'faq.txt', type: 'text/plain', size: 10 })).toEqual({
      ok: true,
      mimeType: 'text/plain',
    });
    expect(validateKnowledgeFile({ name: 'faq.md', type: '', size: 10 })).toEqual({ ok: true, mimeType: 'text/markdown' });
    expect(validateKnowledgeFile({ name: 'Guide.MARKDOWN', type: 'application/octet-stream', size: 10 })).toEqual({
      ok: true,
      mimeType: 'text/markdown',
    });
    expect(validateKnowledgeFile({ name: 'notes.md', type: 'text/x-markdown', size: 10 }).ok).toBe(true);
  });

  it('rejects other extensions', () => {
    for (const name of ['brochure.pdf', 'README', '.md', 'archive.md.zip', 'notes.docx']) {
      expect(validateKnowledgeFile({ name, type: '', size: 10 })).toEqual({
        ok: false,
        message: 'Upload a .txt, .md or .markdown file.',
      });
    }
  });

  it('rejects empty and oversized files', () => {
    expect(validateKnowledgeFile({ name: 'a.txt', type: 'text/plain', size: 0 })).toEqual({
      ok: false,
      message: 'The file is empty.',
    });
    expect(validateKnowledgeFile({ name: 'a.txt', type: 'text/plain', size: Number.NaN }).ok).toBe(false);
    expect(validateKnowledgeFile({ name: 'a.txt', type: 'text/plain', size: MAX_KNOWLEDGE_FILE_BYTES }).ok).toBe(true);
    expect(validateKnowledgeFile({ name: 'a.txt', type: 'text/plain', size: MAX_KNOWLEDGE_FILE_BYTES + 1 })).toEqual({
      ok: false,
      message: 'The file is too large (maximum 1 MB).',
    });
  });

  it('rejects files whose reported type is clearly not text', () => {
    expect(validateKnowledgeFile({ name: 'renamed.md', type: 'application/pdf', size: 10 })).toEqual({
      ok: false,
      message: 'The file does not look like plain text or Markdown.',
    });
    expect(validateKnowledgeFile({ name: 'photo.txt', type: 'image/png', size: 10 }).ok).toBe(false);
  });

  it('rejects over-long file names', () => {
    const result = validateKnowledgeFile({ name: `${'n'.repeat(260)}.txt`, type: 'text/plain', size: 10 });
    expect(result).toEqual({ ok: false, message: 'The file name is too long (maximum 255 characters).' });
  });
});

describe('decodeKnowledgeFile', () => {
  it('decodes UTF-8 text, including multi-byte characters', () => {
    const text = 'Caf\u{E9} open 7 days \u{2615}\nSecond line';
    expect(decodeKnowledgeFile(bytes(text))).toEqual({ ok: true, text });
  });

  it('consumes a UTF-8 byte order mark', () => {
    expect(decodeKnowledgeFile(new Uint8Array([0xef, 0xbb, 0xbf, 0x48, 0x69]))).toEqual({ ok: true, text: 'Hi' });
  });

  it('rejects invalid UTF-8', () => {
    expect(decodeKnowledgeFile(new Uint8Array([0x48, 0xc3, 0x28, 0x49]))).toEqual({
      ok: false,
      message: 'The file is not valid UTF-8 text.',
    });
  });

  it('rejects binary content (NUL bytes)', () => {
    expect(decodeKnowledgeFile(new Uint8Array([0x48, 0x00, 0x49]))).toEqual({
      ok: false,
      message: 'The file contains binary data, not text.',
    });
  });

  it('asks for UTF-8 when the file is UTF-16', () => {
    const expected = { ok: false, message: 'Save the file as UTF-8 text and upload it again.' };
    expect(decodeKnowledgeFile(new Uint8Array([0xff, 0xfe, 0x48, 0x00]))).toEqual(expected);
    expect(decodeKnowledgeFile(new Uint8Array([0xfe, 0xff, 0x00, 0x48]))).toEqual(expected);
  });

  it('rejects files that are too large, too long or blank', () => {
    expect(decodeKnowledgeFile(new Uint8Array(MAX_KNOWLEDGE_FILE_BYTES + 1).fill(0x61))).toEqual({
      ok: false,
      message: 'The file is too large (maximum 1 MB).',
    });
    expect(decodeKnowledgeFile(new Uint8Array(MAX_KNOWLEDGE_TEXT_CHARS + 1).fill(0x61))).toEqual({
      ok: false,
      message: 'The text is too long (maximum 200,000 characters).',
    });
    expect(decodeKnowledgeFile(bytes('  \n\t \r\n'))).toEqual({ ok: false, message: 'The file has no readable text.' });
  });
});
