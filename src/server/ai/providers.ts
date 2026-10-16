import 'server-only';
import type { AiConfig, OpenAIConfig } from '@/server/config/env';
import { OpenAIEmbeddingProvider } from './openai/embedding-provider';
import { OpenAITextProvider } from './openai/text-provider';
import type { ProviderFactories } from './registry';

/**
 * Production provider factories, keyed by the ids used in AI_*_PROVIDER.
 * Factories run lazily (on first use), so a missing credential only fails the
 * requests that need that provider — never startup or `next build`.
 */
export function createDefaultProviderFactories(config: { openai: OpenAIConfig; ai: AiConfig }): ProviderFactories {
  const openAIOptions = () => {
    const apiKey = config.openai.apiKey;
    if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
    return { apiKey, timeoutMs: config.ai.requestTimeoutMs };
  };
  return {
    text: { openai: () => new OpenAITextProvider(openAIOptions()) },
    embedding: { openai: () => new OpenAIEmbeddingProvider(openAIOptions()) },
  };
}
