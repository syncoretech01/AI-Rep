import type { TokenUsage } from '@/server/ai/types';
import type { ModelPrice } from '@/server/config/env';
import { DEFAULT_MODEL_PRICING } from '@/server/config/pricing';

/**
 * Estimates provider cost from normalized usage. Adapters only report usage;
 * pricing lives here (ARCHITECTURE.md §16).
 */

export interface CostEstimate {
  usd: number;
  /** False when no price is configured for the model (usd is then 0). */
  known: boolean;
}

export interface CostEstimator {
  text(model: string, usage: TokenUsage): CostEstimate;
  embedding(model: string, inputTokens: number): CostEstimate;
}

/** Negative or non-finite counts (a misbehaving adapter) price as zero. */
function count(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Matches the precision of usage_records.estimated_cost_usd (numeric(14, 8)). */
function roundUsd(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

/** `overrides` (AiConfig.pricingOverrides) win over the built-in snapshot. */
export function createCostEstimator(overrides: Record<string, ModelPrice> = {}): CostEstimator {
  // A Map (not an object lookup) so ids like "constructor" never hit Object.prototype.
  const prices = new Map<string, ModelPrice>([...Object.entries(DEFAULT_MODEL_PRICING), ...Object.entries(overrides)]);
  // Longest first: a dated snapshot ("<model>-2026-09-15") resolves to its most specific known model id.
  const knownIds = [...prices.keys()].sort((a, b) => b.length - a.length);

  function priceOf(model: string): ModelPrice | undefined {
    const exact = prices.get(model);
    if (exact) return exact;
    const family = knownIds.find((id) => model.startsWith(`${id}-`));
    return family === undefined ? undefined : prices.get(family);
  }

  return {
    text(model, usage) {
      const price = priceOf(model);
      if (!price) return { usd: 0, known: false };
      // inputTokens includes cached and cache-write tokens; outputTokens already includes reasoning tokens.
      const cached = count(usage.cachedInputTokens);
      const cacheWrite = count(usage.cacheWriteTokens);
      const uncached = Math.max(0, count(usage.inputTokens) - cached - cacheWrite);
      const perMillion =
        uncached * price.inputPerMTok +
        cached * (price.cachedInputPerMTok ?? price.inputPerMTok) +
        cacheWrite * (price.cacheWritePerMTok ?? price.inputPerMTok) +
        count(usage.outputTokens) * price.outputPerMTok;
      return { usd: roundUsd(perMillion / 1e6), known: true };
    },
    embedding(model, inputTokens) {
      const price = priceOf(model);
      if (!price) return { usd: 0, known: false };
      return { usd: roundUsd((count(inputTokens) * price.inputPerMTok) / 1e6), known: true };
    },
  };
}
