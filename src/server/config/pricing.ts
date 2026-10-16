import type { ModelPrice } from './env';

/**
 * Provider price snapshot (USD per 1M tokens) used to estimate usage cost.
 * Configuration data keyed by model id; deployments override or extend it with
 * AI_MODEL_PRICING_JSON. Re-check provider pricing before pricing decisions.
 *
 * Source: OpenAI API pricing, verified 2026-10-08, STANDARD processing tier
 * (interactive chat is not Batch/Flex). AI_RUNTIME.md quotes $0.05 / $0.005 /
 * $0.25 for gpt-6-luna: those are the Batch/Flex rates; Standard rates are double.
 *
 * Requests above 272K input tokens are billed at higher long-context rates; the
 * context budgets keep requests far below that, so only short-context rates are listed.
 */
export const PRICING_SNAPSHOT_DATE = '2026-10-08';

export const DEFAULT_MODEL_PRICING: Readonly<Record<string, ModelPrice>> = Object.freeze({
  'gpt-6-luna': { inputPerMTok: 0.1, cachedInputPerMTok: 0.01, cacheWritePerMTok: 0.125, outputPerMTok: 0.5 },
  'gpt-6-sol': { inputPerMTok: 2.0, cachedInputPerMTok: 0.2, cacheWritePerMTok: 2.5, outputPerMTok: 10.0 },
  'text-embedding-3-small': { inputPerMTok: 0.02, outputPerMTok: 0 },
});
