import { describe, expect, it } from 'vitest';
import { estimateTokens } from '@/server/ai/tokens';
import { DEFAULT_CHUNK_OPTIONS, chunkText, type ChunkOptions, type TextChunk } from '@/server/domain/knowledge/chunker';

// In unicode mode a valid pair is one code point, so any surrogate matched here is unpaired.
const LONE_SURROGATE = /[\u{D800}-\u{DFFF}]/u;

function bodyOf(chunk: TextChunk): string {
  return chunk.heading === null ? chunk.content : chunk.content.slice(chunk.heading.length + 2);
}

/** Invariants every chunking result must satisfy (collected, so one assertion covers thousands of chunks). */
function violations(chunks: readonly TextChunk[], options: ChunkOptions): string[] {
  const problems: string[] = [];
  chunks.forEach((chunk, position) => {
    const body = bodyOf(chunk);
    const headingTokens = chunk.heading === null ? 0 : estimateTokens(`${chunk.heading}\n\n`);
    if (chunk.index !== position) problems.push(`chunk ${position}: index ${chunk.index}`);
    if (body.trim() === '') problems.push(`chunk ${position}: empty body`);
    if (chunk.tokenCount !== estimateTokens(chunk.content)) problems.push(`chunk ${position}: wrong tokenCount`);
    if (chunk.tokenCount > options.maxTokens + headingTokens) problems.push(`chunk ${position}: ${chunk.tokenCount} tokens`);
    if (estimateTokens(body) > options.maxTokens) problems.push(`chunk ${position}: body over maxTokens`);
    if (chunk.heading !== null && !chunk.content.startsWith(`${chunk.heading}\n\n`)) {
      problems.push(`chunk ${position}: missing heading prefix`);
    }
    if (LONE_SURROGATE.test(chunk.content)) problems.push(`chunk ${position}: lone surrogate`);
  });
  return problems;
}

function expectWellFormed(chunks: readonly TextChunk[], options: ChunkOptions = DEFAULT_CHUNK_OPTIONS): void {
  expect(violations(chunks, options)).toEqual([]);
}

/** Length of the longest prefix of `next` that `previous` ends with. */
function overlapLength(previous: string, next: string): number {
  for (let length = Math.min(previous.length, next.length); length > 0; length -= 1) {
    if (previous.endsWith(next.slice(0, length))) return length;
  }
  return 0;
}

function sentences(count: number, label = 'Sentence'): string[] {
  return Array.from({ length: count }, (_, i) => `${label} number ${i} covers topic${i} in useful detail.`);
}

/** Deterministic PRNG (mulberry32) for generated documents. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('chunkText basics', () => {
  it('returns no chunks for empty, blank or heading-only text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('  \n\n \t ')).toEqual([]);
    expect(chunkText('# Title\n\n## Subtitle\n')).toEqual([]);
  });

  it('keeps a short text as one chunk without a heading', () => {
    expect(chunkText('We fix boilers.')).toEqual([
      { index: 0, content: 'We fix boilers.', tokenCount: estimateTokens('We fix boilers.'), heading: null },
    ]);
  });

  it('packs small paragraphs of a section into one chunk', () => {
    const paragraphs = ['First paragraph.', 'Second paragraph\nwith a second line.', '- item one\n- item two'];
    const chunks = chunkText(paragraphs.join('\n\n'));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toBe(paragraphs.join('\n\n'));
  });

  it('accepts CRLF input', () => {
    const chunks = chunkText('# Hours\r\nOpen daily.\r\n\r\n# Prices\r\nFair prices.');
    expect(chunks.map((chunk) => chunk.content)).toEqual(['Hours\n\nOpen daily.', 'Prices\n\nFair prices.']);
  });

  it('rejects invalid options', () => {
    expect(() => chunkText('text', { targetTokens: 0 })).toThrow(RangeError);
    expect(() => chunkText('text', { targetTokens: 100, maxTokens: 50 })).toThrow(RangeError);
    expect(() => chunkText('text', { targetTokens: 100, overlapTokens: 100 })).toThrow(RangeError);
    expect(() => chunkText('text', { overlapTokens: -1 })).toThrow(RangeError);
    expect(() => chunkText('text', { maxTokens: 1.5 })).toThrow(RangeError);
  });

  it('uses the documented defaults', () => {
    expect(DEFAULT_CHUNK_OPTIONS).toEqual({ targetTokens: 300, maxTokens: 450, overlapTokens: 40 });
  });
});

describe('chunkText headings', () => {
  const doc = [
    'Welcome to Acme Heating.',
    '',
    '# Services',
    'We repair boilers.',
    '',
    '## Emergency service ##',
    'Available 24/7.',
    '',
    '```sh',
    '# a shell comment, not a heading',
    '',
    'echo "call us"',
    '```',
    '',
    '### Empty section',
    '## Pricing',
    '#hashtag is not a heading',
    '####### neither is this',
    'Call-out fee is $89.',
  ].join('\n');

  it('splits sections at headings and prefixes the nearest heading', () => {
    const chunks = chunkText(doc);
    expectWellFormed(chunks);
    expect(chunks.map((chunk) => chunk.heading)).toEqual([null, 'Services', 'Emergency service', 'Pricing']);
    expect(chunks.map((chunk) => chunk.content)).toEqual([
      'Welcome to Acme Heating.',
      'Services\n\nWe repair boilers.',
      'Emergency service\n\nAvailable 24/7.\n\n```sh\n# a shell comment, not a heading\n\necho "call us"\n```',
      'Pricing\n\n#hashtag is not a heading\n####### neither is this\nCall-out fee is $89.',
    ]);
  });

  it('prefixes the heading to every chunk of a long section', () => {
    const chunks = chunkText(`# FAQ\n\n${sentences(200).join(' ')}`);
    expectWellFormed(chunks);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.heading).toBe('FAQ');
      expect(chunk.content.startsWith('FAQ\n\n')).toBe(true);
    }
  });

  it('strips only a closing sequence that follows a space', () => {
    const chunks = chunkText('## Learn C#\nBody one.\n\n# Hours #  \nBody two.\n\n## ##\nBody three.');
    expect(chunks.map((chunk) => chunk.heading)).toEqual(['Learn C#', 'Hours', null]);
    expect(chunks[2]!.content).toBe('Body three.');
  });

  it('parses heading lines in linear time, even with long runs of spaces', () => {
    const start = performance.now();
    const chunks = chunkText(`# a${' '.repeat(200_000)}b\n\nbody`);
    // A backtracking closing-sequence regex took over a minute on this input.
    expect(performance.now() - start).toBeLessThan(1000);
    expect(chunks.map((chunk) => chunk.content)).toEqual(['# a b\n\nbody']);
  });

  it('treats an over-long heading line as body text', () => {
    const line = `# ${'very long heading words '.repeat(12)}`.trimEnd();
    const chunks = chunkText(`${line}\nBody text.`);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.heading).toBeNull();
    expect(chunks[0]!.content).toBe(`${line}\nBody text.`);
  });
});

describe('chunkText splitting', () => {
  const small: ChunkOptions = { targetTokens: 60, maxTokens: 80, overlapTokens: 10 };

  it('keeps a paragraph between targetTokens and maxTokens whole', () => {
    const paragraph = sentences(7).join(' '); // ~350 chars: over target 50, under max 100
    expect(estimateTokens(paragraph)).toBeGreaterThan(50);
    const chunks = chunkText(paragraph, { targetTokens: 50, maxTokens: 100, overlapTokens: 0 });
    expect(chunks.map((chunk) => chunk.content)).toEqual([paragraph]);
  });

  it('splits a long paragraph by sentences without breaking any sentence', () => {
    const parts = sentences(40);
    const chunks = chunkText(parts.join(' '), small);
    expectWellFormed(chunks, small);
    expect(chunks.length).toBeGreaterThan(5);
    for (const sentence of parts) {
      expect(chunks.some((chunk) => chunk.content.includes(sentence))).toBe(true);
    }
  });

  it('splits a giant sentence by words', () => {
    const words = Array.from({ length: 3000 }, (_, i) => `w${i}`);
    const chunks = chunkText(words.join(' '));
    expectWellFormed(chunks);
    expect(chunks.length).toBeGreaterThan(10);
    const seen = new Set(chunks.flatMap((chunk) => chunk.content.split(' ')));
    expect(words.every((word) => seen.has(word))).toBe(true);
  });

  it('hard-splits unbroken text into pieces of at most maxTokens', () => {
    const blob = 'x'.repeat(5000);
    const chunks = chunkText(blob);
    expectWellFormed(chunks);
    expect(chunks.map((chunk) => chunk.content.length)).toEqual([1800, 1800, 1400]);
    expect(chunks.map((chunk) => chunk.content).join('')).toBe(blob);
  });

  it('never splits a surrogate pair', () => {
    for (const text of [`a${'\u{1F600}'.repeat(1000)}`, '\u{1F600}'.repeat(1000)]) {
      const chunks = chunkText(text);
      expectWellFormed(chunks);
      expect(chunks.map((chunk) => chunk.content).join('')).toBe(text);
    }
  });

  it('preserves line breaks between sentences of a split paragraph', () => {
    const list = Array.from({ length: 30 }, (_, i) => `- Item ${i} is a service we offer.`).join('\n');
    const chunks = chunkText(list, small);
    expectWellFormed(chunks, small);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.content.startsWith('- Item 0 is a service we offer.\n- Item 1 is a service we offer.')).toBe(true);
  });
});

describe('chunkText overlap', () => {
  const options: ChunkOptions = { targetTokens: 60, maxTokens: 80, overlapTokens: 10 };

  it('carries the tail of the previous chunk into the next chunk of the same section', () => {
    const chunks = chunkText(sentences(40).join(' '), options);
    expectWellFormed(chunks, options);
    for (let i = 1; i < chunks.length; i += 1) {
      const shared = overlapLength(bodyOf(chunks[i - 1]!), bodyOf(chunks[i]!));
      expect(shared).toBeGreaterThanOrEqual(10);
      expect(shared).toBeLessThanOrEqual(options.overlapTokens * 4);
    }
  });

  it('does not overlap across sections', () => {
    const chunks = chunkText(`# A\n\n${sentences(40).join(' ')}\n\n# B\n\nSection B starts here.`, options);
    const firstOfB = chunks.find((chunk) => chunk.heading === 'B');
    expect(firstOfB?.content).toBe('B\n\nSection B starts here.');
  });

  it('never emits a chunk that the next chunk would repeat whole', () => {
    const question = 'Q: What does the warranty cover?';
    const answer = sentences(30, 'Answer').join(' '); // between targetTokens and maxTokens
    const together = chunkText(`${question}\n\n${answer}`);
    expectWellFormed(together);
    expect(together.map((chunk) => chunk.content)).toEqual([`${question}\n\n${answer}`]);

    // No room under maxTokens: emitted separately, still without repetition.
    const longAnswer = 'word '.repeat(358).trim();
    const apart = chunkText(`${question}\n\n${longAnswer}`);
    expectWellFormed(apart);
    expect(apart.map((chunk) => chunk.content)).toEqual([question, longAnswer]);
  });

  it('adds no overlap when overlapTokens is 0', () => {
    const paragraph = sentences(40).join(' ');
    const chunks = chunkText(paragraph, { ...options, overlapTokens: 0 });
    expect(chunks.map((chunk) => chunk.content).join(' ')).toBe(paragraph);
  });
});

describe('chunkText invariants on generated documents', () => {
  function generateDocument(seed: number): { text: string; words: string[] } {
    const random = prng(seed);
    const pick = (max: number) => Math.floor(random() * max);
    const words: string[] = [];
    const word = () => {
      const value = `t${seed}x${words.length}`;
      words.push(value);
      return value;
    };
    const lines: string[] = [];
    for (let section = 0; section < 12; section += 1) {
      if (random() < 0.8) lines.push(`${'#'.repeat(1 + pick(6))} Heading ${section}`, '');
      for (let paragraph = 0; paragraph < 1 + pick(5); paragraph += 1) {
        const shape = random();
        if (shape < 0.1) {
          lines.push(Array.from({ length: 400 + pick(600) }, word).join(' ')); // giant sentence
        } else if (shape < 0.15) {
          lines.push('z'.repeat(2000 + pick(3000))); // unbroken blob
        } else if (shape < 0.3) {
          lines.push(Array.from({ length: 2 + pick(20) }, () => `- ${word()} ${word()}.`).join('\n')); // list
        } else {
          const count = 1 + pick(80);
          lines.push(Array.from({ length: count }, () => `${word()} ${word()} ${word()} ${word()}.`).join(' '));
        }
        lines.push('');
      }
    }
    return { text: lines.join('\n'), words };
  }

  const optionSets: ChunkOptions[] = [
    DEFAULT_CHUNK_OPTIONS,
    { targetTokens: 20, maxTokens: 30, overlapTokens: 5 },
    { targetTokens: 100, maxTokens: 400, overlapTokens: 60 },
    { targetTokens: 1, maxTokens: 1, overlapTokens: 0 },
  ];

  it.each([1, 2, 3])('holds caps, indexes and content coverage (seed %i)', (seed) => {
    const { text, words } = generateDocument(seed);
    for (const options of optionSets) {
      const chunks = chunkText(text, options);
      expectWellFormed(chunks, options);
      // Every word short enough to fit in a chunk survives intact in some chunk body.
      const seen = new Set(chunks.flatMap((chunk) => bodyOf(chunk).split(/[\s.]+/)));
      const maxChars = options.maxTokens * 4;
      expect(words.filter((value) => value.length <= maxChars && !seen.has(value))).toEqual([]);
    }
  });
});
