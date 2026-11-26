import 'server-only';
import type { AiConfig, OpenAIConfig, VoiceConfig } from '@/server/config/env';
import { OpenAIEmbeddingProvider } from './openai/embedding-provider';
import { OpenAILiveProvider } from './openai/live-provider';
import { OpenAITextProvider } from './openai/text-provider';
import type { ProviderFactories } from './registry';
import type { RealtimeVoiceProvider } from './voice-types';

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

/**
 * The realtime voice provider named by AI_VOICE_PROVIDER. Only the voice gateway calls this, at startup: a missing
 * credential or an unknown provider id stops the gateway instead of failing its first caller.
 */
export function createDefaultVoiceProvider(config: { openai: OpenAIConfig; ai: AiConfig; voice: VoiceConfig }): RealtimeVoiceProvider {
  if (config.voice.provider !== 'openai') throw new Error(`Unknown realtime voice provider "${config.voice.provider}"`);
  const apiKey = config.openai.apiKey;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
  return new OpenAILiveProvider({ apiKey, timeoutMs: config.ai.requestTimeoutMs });
}
