import 'server-only';
import type { OpenAI } from 'openai';
import { ProviderError, type EmbeddingProvider, type EmbeddingRequest, type EmbeddingResult } from '../types';
import { startProviderCall } from './errors';
import { createOpenAIClient, type OpenAIProviderOptions } from './text-provider';

export type { OpenAIProviderOptions } from './text-provider';

/** Inputs per embeddings request accepted by the API. */
const MAX_INPUTS = 2048;

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  private readonly client: OpenAI;
  private readonly timeoutMs: number;

  constructor(options: OpenAIProviderOptions) {
    this.id = options.id ?? 'openai';
    this.client = createOpenAIClient(options);
    this.timeoutMs = options.timeoutMs;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const count = request.input.length;
    if (count === 0 || count > MAX_INPUTS || request.input.some((text) => text.length === 0)) {
      // The API rejects these anyway; fail before spending a request.
      throw new ProviderError({
        provider: this.id,
        code: 'invalid_request',
        retryable: false,
        message: `${this.id}: embeddings require 1-${MAX_INPUTS} non-empty inputs (got ${count})`,
      });
    }

    const call = startProviderCall(this.id, this.timeoutMs, request.signal);
    const startedAt = performance.now();
    try {
      const response = await this.client.embeddings.create(
        {
          model: request.model,
          input: request.input,
          ...(request.dimensions === undefined ? {} : { dimensions: request.dimensions }),
        },
        { signal: call.signal },
      );
      // `index` ties each vector to its input; do not rely on response order.
      const data = [...response.data].sort((a, b) => a.index - b.index);
      return {
        provider: this.id,
        model: response.model,
        vectors: data.map((item) => item.embedding),
        usage: { inputTokens: response.usage.prompt_tokens },
        durationMs: Math.round(performance.now() - startedAt),
      };
    } catch (error) {
      throw call.toError(error);
    }
  }
}
