import { estimateTokens } from '@/server/ai/tokens';

/**
 * Structure-aware chunker for normalized knowledge text (Markdown or plain).
 *
 * Sections start at Markdown ATX headings (`#`..`######`, ignored inside fenced
 * code). Each chunk records its section's heading and is prefixed with it, so a
 * chunk is self-describing when retrieved on its own. Within a section,
 * paragraphs are packed up to `targetTokens`; a paragraph over `maxTokens` is
 * split into sentences, a sentence over `maxTokens` into words, and a word over
 * `maxTokens` into fixed-size pieces (hard cap). Consecutive chunks of a section
 * overlap by ~`overlapTokens` so a fact that straddles a boundary stays retrievable.
 *
 * Guarantee: a chunk body never exceeds `maxTokens`, so `tokenCount` is at most
 * `maxTokens` plus the heading prefix.
 */

export interface ChunkOptions {
  targetTokens: number;
  maxTokens: number;
  overlapTokens: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = Object.freeze({ targetTokens: 300, maxTokens: 450, overlapTokens: 40 });

export interface TextChunk {
  /** 0-based position within the document. */
  index: number;
  /** `"<heading>\n\n<body>"` when the chunk has a heading, otherwise the body. */
  content: string;
  tokenCount: number;
  /** Nearest preceding Markdown heading (text only), or null. */
  heading: string | null;
}

interface Section {
  heading: string | null;
  paragraphs: string[];
}

/** Text that fits in one chunk, with the separator that precedes it in the source. */
interface Unit {
  text: string;
  joiner: string;
}

/** Mirrors estimateTokens (~4 characters per token); the hard cap relies on it. */
const CHARS_PER_TOKEN = 4;
const PARAGRAPH_BREAK = '\n\n';
/** Longer "headings" are treated as body text so a stray `#` line never inflates every chunk. */
const MAX_HEADING_CHARS = 200;
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]+(.*))?$/;
const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})/;
const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });

export function chunkText(text: string, options: Partial<ChunkOptions> = {}): TextChunk[] {
  const resolved = resolveOptions(options);
  const chunks: TextChunk[] = [];
  for (const section of parseSections(text)) {
    for (const body of packSection(section.paragraphs, resolved)) {
      const content = section.heading === null ? body : `${section.heading}${PARAGRAPH_BREAK}${body}`;
      chunks.push({ index: chunks.length, content, tokenCount: estimateTokens(content), heading: section.heading });
    }
  }
  return chunks;
}

function resolveOptions(options: Partial<ChunkOptions>): ChunkOptions {
  const resolved: ChunkOptions = {
    targetTokens: options.targetTokens ?? DEFAULT_CHUNK_OPTIONS.targetTokens,
    maxTokens: options.maxTokens ?? DEFAULT_CHUNK_OPTIONS.maxTokens,
    overlapTokens: options.overlapTokens ?? DEFAULT_CHUNK_OPTIONS.overlapTokens,
  };
  const { targetTokens, maxTokens, overlapTokens } = resolved;
  const valid =
    [targetTokens, maxTokens, overlapTokens].every((value) => Number.isSafeInteger(value)) &&
    targetTokens >= 1 &&
    maxTokens >= targetTokens &&
    overlapTokens >= 0 &&
    overlapTokens < targetTokens;
  if (!valid) {
    throw new RangeError('Invalid chunk options: need integers with 1 <= targetTokens <= maxTokens and 0 <= overlapTokens < targetTokens');
  }
  return resolved;
}

/** Heading text for an ATX heading line ('' for an empty heading), or null when the line is not a heading. */
function headingText(line: string): string | null {
  const match = ATX_HEADING.exec(line);
  if (!match) return null;
  // Optional closing sequence (`## Title ##`), stripped with a loop: a regex backtracks quadratically on long space runs.
  const text = (match[1] ?? '').trimEnd();
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end -= 1;
  const closed = end < text.length && (end === 0 || text[end - 1] === ' ' || text[end - 1] === '\t');
  return (closed ? text.slice(0, end) : text).trim();
}

/** Splits text into heading-delimited sections of non-empty paragraphs. Sections without body text are dropped. */
function parseSections(text: string): Section[] {
  const sections: Section[] = [];
  let section: Section = { heading: null, paragraphs: [] };
  let lines: string[] = [];
  let fence: string | null = null;

  const endParagraph = () => {
    const paragraph = lines.join('\n').trim();
    if (paragraph !== '') section.paragraphs.push(paragraph);
    lines = [];
  };

  for (const line of text.split(/\r\n?|\n/)) {
    const marker = CODE_FENCE.exec(line)?.[1];
    if (fence !== null) {
      // Fenced code stays verbatim: blank lines and `#` comments inside it are content.
      lines.push(line);
      if (marker?.startsWith(fence)) fence = null;
      continue;
    }
    if (marker !== undefined) {
      fence = marker;
      lines.push(line);
      continue;
    }
    const heading = headingText(line);
    if (heading !== null && heading.length <= MAX_HEADING_CHARS) {
      endParagraph();
      sections.push(section);
      section = { heading: heading === '' ? null : heading, paragraphs: [] };
    } else if (line.trim() === '') {
      endParagraph();
    } else {
      lines.push(line);
    }
  }
  endParagraph();
  sections.push(section);
  return sections.filter((candidate) => candidate.paragraphs.length > 0);
}

/** Packs a section's units into chunk bodies of up to targetTokens (single units up to maxTokens). */
function packSection(paragraphs: readonly string[], options: ChunkOptions): string[] {
  const units: Unit[] = [];
  for (const paragraph of paragraphs) pushParagraphUnits(units, paragraph, options.maxTokens);

  const bodies: string[] = [];
  let current = '';
  for (const unit of units) {
    if (current === '') {
      current = unit.text;
      continue;
    }
    const candidate = current + unit.joiner + unit.text;
    const candidateTokens = estimateTokens(candidate);
    if (candidateTokens <= options.targetTokens) {
      current = candidate;
      continue;
    }
    const overlap = tail(current, options.overlapTokens);
    // A body no longer than the overlap would reappear whole in the next chunk
    // (e.g. a short question before a long answer): keep them together instead.
    if (overlap === current && candidateTokens <= options.maxTokens) {
      current = candidate;
      continue;
    }
    bodies.push(current);
    current = startWithOverlap(overlap, unit, options.maxTokens);
  }
  if (current !== '') bodies.push(current);
  return bodies;
}

/** Starts the next chunk of a section with the previous chunk's tail, unless that would break the hard cap. */
function startWithOverlap(overlap: string, unit: Unit, maxTokens: number): string {
  if (overlap === '') return unit.text;
  const candidate = overlap + (unit.joiner === '' ? ' ' : unit.joiner) + unit.text;
  return estimateTokens(candidate) <= maxTokens ? candidate : unit.text;
}

/** The last ~`tokens` of `text`, starting at a word boundary ('' when there is none). */
function tail(text: string, tokens: number): string {
  const maxChars = tokens * CHARS_PER_TOKEN;
  if (maxChars === 0) return '';
  if (text.length <= maxChars) return text;
  const window = text.slice(text.length - maxChars);
  const boundary = window.search(/\s/);
  return boundary === -1 ? '' : window.slice(boundary).trim();
}

function pushParagraphUnits(units: Unit[], paragraph: string, maxTokens: number): void {
  if (estimateTokens(paragraph) <= maxTokens) {
    units.push({ text: paragraph, joiner: PARAGRAPH_BREAK });
    return;
  }
  let joiner = PARAGRAPH_BREAK;
  for (const { segment } of sentenceSegmenter.segment(paragraph)) {
    const sentence = segment.trim();
    if (sentence === '') continue;
    if (estimateTokens(sentence) <= maxTokens) units.push({ text: sentence, joiner });
    else pushWordUnits(units, sentence, maxTokens, joiner);
    // Segments keep their trailing whitespace: preserve line breaks (lists, code) when re-joining.
    joiner = segment.includes('\n') ? '\n' : ' ';
  }
}

function pushWordUnits(units: Unit[], sentence: string, maxTokens: number, firstJoiner: string): void {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  let joiner = firstJoiner;
  for (const word of sentence.split(/\s+/)) {
    let rest = word;
    while (rest.length > maxChars) {
      // Unbroken text (URLs, encoded data): fixed-size pieces, never splitting a surrogate pair.
      const cut = isHighSurrogate(rest.charCodeAt(maxChars - 1)) ? maxChars - 1 : maxChars;
      units.push({ text: rest.slice(0, cut), joiner });
      rest = rest.slice(cut);
      joiner = '';
    }
    if (rest !== '') units.push({ text: rest, joiner });
    joiner = ' ';
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
