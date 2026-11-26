import type { ModelPrice } from './env';

/**
 * Provider price snapshot (USD per 1M tokens) used to ESTIMATE usage cost. Estimates are labelled with
 * AI_PRICING_VERSION (default: this snapshot's date) and are never provider-confirmed billing (AI_RUNTIME.md).
 * Configuration data keyed by model id; deployments override or extend it with AI_MODEL_PRICING_JSON.
 *
 * Source: https://developers.openai.com/api/docs/pricing, checked 2026-11-26, STANDARD (interactive) tier, short
 * context (<= 272K input tokens). Batch and Flex rates are discounted (about half) and do not apply to interactive
 * chat; Fast/priority processing costs about double. Cache writes use the default 30-minute cache TTL rate.
 * Requests above 272K input tokens bill at long-context rates; the context budgets keep requests far below that.
 */
export const PRICING_SNAPSHOT_DATE = '2026-11-26';

export const DEFAULT_MODEL_PRICING: Readonly<Record<string, ModelPrice>> = Object.freeze({
  'gpt-6-luna': { inputPerMTok: 0.1, cachedInputPerMTok: 0.01, cacheWritePerMTok: 0.125, outputPerMTok: 0.5 },
  'gpt-6.2-sol': { inputPerMTok: 2.0, cachedInputPerMTok: 0.1, cacheWritePerMTok: 2.5, outputPerMTok: 10.0 },
  'gpt-6.1-sol': { inputPerMTok: 2.0, cachedInputPerMTok: 0.1, cacheWritePerMTok: 2.5, outputPerMTok: 10.0 },
  'gpt-6-sol': { inputPerMTok: 2.0, cachedInputPerMTok: 0.2, cacheWritePerMTok: 2.5, outputPerMTok: 10.0 },
  'text-embedding-3-small': { inputPerMTok: 0.02, outputPerMTok: 0 },
  // GPT-Live: billed per second of session time; delegated backend tokens and transcription are billed separately.
  'gpt-live-1.1': { inputPerMTok: 0, outputPerMTok: 0, activePerMinute: 0.05, standbyPerMinute: 0.02 },
  'gpt-live-1': { inputPerMTok: 0, outputPerMTok: 0, activePerMinute: 0.05, standbyPerMinute: 0.02 },
});
