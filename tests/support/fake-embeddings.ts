import type { EmbeddingProvider, EmbeddingRequest, EmbeddingResult } from '@/server/ai/types';

/**
 * Deterministic embedding provider for tests. Words are lower-cased, lightly
 * stemmed, stop words dropped, and hashed into a 1536-dim vector, so cosine
 * similarity tracks word overlap: related texts score high, unrelated ~0.
 */

export const FAKE_EMBEDDING_DIMENSIONS = 1536;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for', 'from', 'have', 'how', 'i', 'in',
  'is', 'it', 'me', 'my', 'of', 'on', 'or', 'our', 'that', 'the', 'this', 'to', 'we', 'what', 'when', 'where',
  'which', 'who', 'will', 'with', 'you', 'your', 'us', 'any', 'there', 'about', 'please', 'tell',
]);

function stem(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

export function fakeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .map(stem);
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function fakeEmbed(text: string, dimensions = FAKE_EMBEDDING_DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = fakeTokens(text);
  if (tokens.length === 0) {
    vector[0] = 1;
    return vector;
  }
  for (const token of tokens) {
    const hash = fnv1a(token);
    const index = hash % dimensions;
    vector[index] = (vector[index] ?? 0) + ((hash >>> 16) & 1 ? 1 : -1);
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly requests: EmbeddingRequest[] = [];
  failNext: Error | null = null;

  constructor(id = 'fake') {
    this.id = id;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    this.requests.push(request);
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    const dimensions = request.dimensions ?? FAKE_EMBEDDING_DIMENSIONS;
    return {
      provider: this.id,
      model: request.model,
      vectors: request.input.map((text) => fakeEmbed(text, dimensions)),
      usage: { inputTokens: request.input.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0) },
      durationMs: 1,
    };
  }
}
