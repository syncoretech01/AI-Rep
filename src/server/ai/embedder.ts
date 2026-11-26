import type { EmbeddingUsagePurpose, UsageContext } from '@/server/domain/usage/types';

export interface EmbedOutcome {
  /** One vector per input text, in order. */
  vectors: number[][];
  /** Model that produced the vectors (stored with chunks; retrieval only compares like with like). */
  model: string;
}

/**
 * What knowledge ingestion and retrieval need from the AI layer: routed,
 * metered embeddings. Implemented by `EmbeddingService` (router + usage).
 */
export interface Embedder {
  /** The embedding model currently configured (used to filter stored chunks). */
  readonly model: string;
  /** `signal` bounds the call and its retries (e.g. the tool's time limit, which follows the turn deadline). */
  embed(
    texts: readonly string[],
    context: UsageContext & { purpose: EmbeddingUsagePurpose; signal?: AbortSignal },
  ): Promise<EmbedOutcome>;
}
