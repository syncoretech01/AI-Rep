import type { EmbeddingUsagePurpose, UsageContext, UsageRecorder } from '@/server/domain/usage/types';
import { silentLogger, type Logger } from '@/server/observability/logger';
import type { EmbedOutcome, Embedder } from './embedder';
import type { ModelRouter } from './router';
import { ProviderError } from './types';

/** Inputs per provider request: far below provider limits for our chunk sizes, small enough to fail fast. */
const DEFAULT_BATCH_SIZE = 96;
const MAX_BATCH_SIZE = 2048;

/**
 * Routed, metered embeddings: the configured embedding provider/model, batched,
 * with provider-reported usage recorded per batch. Must be called outside a DB
 * transaction (it performs network I/O and writes usage records).
 */
export class EmbeddingService implements Embedder {
  private readonly router: ModelRouter;
  private readonly usage: UsageRecorder;
  private readonly batchSize: number;
  private readonly logger: Logger;

  constructor(deps: { router: ModelRouter; usage: UsageRecorder; batchSize?: number; logger?: Logger }) {
    const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
      throw new Error(`EmbeddingService batchSize must be an integer between 1 and ${MAX_BATCH_SIZE}`);
    }
    this.router = deps.router;
    this.usage = deps.usage;
    this.batchSize = batchSize;
    this.logger = deps.logger ?? silentLogger;
  }

  get model(): string {
    return this.router.selectEmbedding().model;
  }

  async embed(
    texts: readonly string[],
    context: UsageContext & { purpose: EmbeddingUsagePurpose },
  ): Promise<EmbedOutcome> {
    const route = this.router.selectEmbedding();
    // The configured model (not a provider-reported alias) is what stored chunks are
    // tagged and filtered by, so ingestion and retrieval always compare like with like.
    if (texts.length === 0) return { vectors: [], model: route.model };

    const emptyIndex = texts.findIndex((text) => text.trim() === '');
    if (emptyIndex !== -1) throw new Error(`Cannot embed an empty text (input ${emptyIndex})`);

    const { purpose, ...usageContext } = context;
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += this.batchSize) {
      const input = texts.slice(start, start + this.batchSize);
      const result = await route.provider.embed({ model: route.model, input, dimensions: route.dimensions });

      // Usage first: the provider consumed (and bills) these tokens even if the response is unusable.
      await this.usage.recordEmbedding(usageContext, purpose, {
        provider: route.providerId,
        model: result.model,
        inputTokens: result.usage.inputTokens,
        durationMs: result.durationMs,
      });

      const invalid = describeInvalidBatch(result.vectors, input.length, route.dimensions);
      if (invalid) {
        this.logger.error('ai.embedding.invalid_response', { provider: route.providerId, model: route.model, purpose, invalid });
        throw new ProviderError({
          provider: route.providerId,
          code: 'invalid_request',
          retryable: false,
          message: `Embedding provider returned an invalid response: ${invalid}`,
        });
      }
      vectors.push(...result.vectors);
    }
    return { vectors, model: route.model };
  }
}

function describeInvalidBatch(vectors: readonly number[][], expectedCount: number, dimensions: number): string | null {
  if (vectors.length !== expectedCount) return `expected ${expectedCount} vectors, got ${vectors.length}`;
  const wrong = vectors.findIndex((vector) => vector.length !== dimensions);
  if (wrong !== -1) return `vector ${wrong} has ${vectors[wrong]?.length ?? 0} dimensions, expected ${dimensions}`;
  return null;
}
