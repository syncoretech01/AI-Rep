import { z } from 'zod';
import { normalizeLabel } from './normalize';

/**
 * Input rules for knowledge sources. V1 accepts manual text and TXT/Markdown
 * files (PDF/document extraction is a later phase). Isomorphic: the admin UI
 * may reuse these checks for early feedback; the server always re-validates.
 * Messages are safe to show to an admin user.
 */

export const MAX_KNOWLEDGE_TEXT_CHARS = 200_000;
export const MAX_KNOWLEDGE_FILE_BYTES = 1_000_000;
export const ALLOWED_KNOWLEDGE_EXTENSIONS = ['.txt', '.md', '.markdown'] as const;

const MAX_TITLE_CHARS = 200;
/** Matches the knowledge_sources.file_name check constraint. */
const MAX_FILE_NAME_CHARS = 255;

const TEXT_TOO_LONG = `The text is too long (maximum ${MAX_KNOWLEDGE_TEXT_CHARS.toLocaleString('en-US')} characters).`;

export const textSourceInputSchema = z.object({
  // Titles are single-line labels: control characters and whitespace runs collapse to one space.
  title: z
    .string()
    .transform(normalizeLabel)
    .pipe(
      z
        .string()
        .min(1, 'Enter a title.')
        .max(MAX_TITLE_CHARS, `Keep the title to ${MAX_TITLE_CHARS} characters or fewer.`),
    ),
  text: z
    .string()
    .min(1, 'Enter some text.')
    .max(MAX_KNOWLEDGE_TEXT_CHARS, TEXT_TOO_LONG)
    .refine((value) => /\S/.test(value), 'Enter some text.'),
  agentId: z.uuid('Choose a valid agent.').nullable(),
});

export type TextSourceInput = z.output<typeof textSourceInputSchema>;

export type KnowledgeFileMimeType = 'text/plain' | 'text/markdown';

export type KnowledgeFileCheck = { ok: true; mimeType: KnowledgeFileMimeType } | { ok: false; message: string };

function fileExtension(name: string): string | null {
  const dot = name.lastIndexOf('.');
  // No dot, or a bare dotfile such as ".md": no usable extension.
  return dot > 0 ? name.slice(dot).toLowerCase() : null;
}

/**
 * Checks upload metadata before reading the bytes. The stored MIME type is
 * derived from the extension: browsers often report '' or
 * application/octet-stream for Markdown, so the reported type only vetoes
 * files that clearly are not text (e.g. a renamed PDF).
 */
export function validateKnowledgeFile(file: { name: string; type: string; size: number }): KnowledgeFileCheck {
  const name = file.name.trim();
  const extension = fileExtension(name);
  if (extension === null || !ALLOWED_KNOWLEDGE_EXTENSIONS.some((allowed) => allowed === extension)) {
    return { ok: false, message: 'Upload a .txt, .md or .markdown file.' };
  }
  if (name.length > MAX_FILE_NAME_CHARS) {
    return { ok: false, message: `The file name is too long (maximum ${MAX_FILE_NAME_CHARS} characters).` };
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return { ok: false, message: 'The file is empty.' };
  }
  if (file.size > MAX_KNOWLEDGE_FILE_BYTES) {
    return { ok: false, message: 'The file is too large (maximum 1 MB).' };
  }
  const type = file.type.trim().toLowerCase();
  const textual = type === '' || type === 'application/octet-stream' || type.startsWith('text/') || type.includes('markdown');
  if (!textual) {
    return { ok: false, message: 'The file does not look like plain text or Markdown.' };
  }
  return { ok: true, mimeType: extension === '.txt' ? 'text/plain' : 'text/markdown' };
}

export type KnowledgeFileDecode = { ok: true; text: string } | { ok: false; message: string };

/** Decodes UTF-8 bytes strictly (fatal); rejects binary content (NUL bytes) with a safe message. */
export function decodeKnowledgeFile(bytes: Uint8Array): KnowledgeFileDecode {
  if (bytes.byteLength > MAX_KNOWLEDGE_FILE_BYTES) {
    return { ok: false, message: 'The file is too large (maximum 1 MB).' };
  }
  // UTF-16 byte order marks (e.g. Notepad's "Unicode" encoding) would otherwise be reported as binary.
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    return { ok: false, message: 'Save the file as UTF-8 text and upload it again.' };
  }
  if (bytes.includes(0)) {
    return { ok: false, message: 'The file contains binary data, not text.' };
  }
  let text: string;
  try {
    // The default ignoreBOM: false consumes a leading UTF-8 byte order mark.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, message: 'The file is not valid UTF-8 text.' };
  }
  if (text.length > MAX_KNOWLEDGE_TEXT_CHARS) return { ok: false, message: TEXT_TOO_LONG };
  if (!/\S/.test(text)) return { ok: false, message: 'The file has no readable text.' };
  return { ok: true, text };
}
