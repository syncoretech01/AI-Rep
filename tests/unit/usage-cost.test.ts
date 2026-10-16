import { describe, expect, it } from 'vitest';
import type { TokenUsage } from '@/server/ai/types';
import { DEFAULT_MODEL_PRICING, PRICING_SNAPSHOT_DATE } from '@/server/config/pricing';
import { createCostEstimator } from '@/server/domain/usage/cost';

function usage(partial: Partial<TokenUsage>): TokenUsage {
  return { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, ...partial };
}

describe('pricing snapshot', () => {
  it('lists standard-tier prices for the configured default models', () => {
    expect(PRICING_SNAPSHOT_DATE).toBe('2026-10-08');
    expect(DEFAULT_MODEL_PRICING['gpt-6-luna']).toEqual({
      inputPerMTok: 0.1,
      cachedInputPerMTok: 0.01,
      cacheWritePerMTok: 0.125,
      outputPerMTok: 0.5,
    });
    expect(DEFAULT_MODEL_PRICING['gpt-6-sol']).toEqual({
      inputPerMTok: 2,
      cachedInputPerMTok: 0.2,
      cacheWritePerMTok: 2.5,
      outputPerMTok: 10,
    });
    expect(DEFAULT_MODEL_PRICING['text-embedding-3-small']).toEqual({ inputPerMTok: 0.02, outputPerMTok: 0 });
  });
});

describe('createCostEstimator', () => {
  const costs = createCostEstimator();

  it('prices cached input tokens at the cached rate', () => {
    // 6,000 uncached × $0.10 + 4,000 cached × $0.01 + 500 output × $0.50, per 1M tokens.
    const estimate = costs.text('gpt-6-luna', usage({ inputTokens: 10_000, cachedInputTokens: 4_000, outputTokens: 500 }));
    expect(estimate).toEqual({ usd: 0.00089, known: true });
  });

  it('prices cache writes and does not add reasoning tokens again', () => {
    // 5,000 uncached × 0.10 + 2,000 cached × 0.01 + 3,000 written × 0.125 + 1,000 output × 0.50.
    const estimate = costs.text(
      'gpt-6-luna',
      usage({ inputTokens: 10_000, cachedInputTokens: 2_000, cacheWriteTokens: 3_000, outputTokens: 1_000, reasoningTokens: 400 }),
    );
    expect(estimate.usd).toBe(0.001395);
  });

  it('prices the escalation model', () => {
    expect(costs.text('gpt-6-sol', usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 })).usd).toBe(12);
  });

  it('prices embeddings by input tokens', () => {
    expect(costs.embedding('text-embedding-3-small', 1_000_000)).toEqual({ usd: 0.02, known: true });
    expect(costs.embedding('text-embedding-3-small', 1_234).usd).toBe(0.00002468);
  });

  it('rounds to 8 decimal places', () => {
    expect(costs.embedding('text-embedding-3-small', 3).usd).toBe(0.00000006);
    expect(costs.text('gpt-6-luna', usage({ inputTokens: 1 })).usd).toBe(0.0000001);
    const tiny = createCostEstimator({ tiny: { inputPerMTok: 0.004, outputPerMTok: 0.006 } });
    expect(tiny.embedding('tiny', 1).usd).toBe(0); // 4e-9 rounds down
    expect(tiny.text('tiny', usage({ outputTokens: 1 })).usd).toBe(0.00000001); // 6e-9 rounds up
  });

  it('lets overrides win over the snapshot, with cache rates falling back to the input rate', () => {
    const custom = createCostEstimator({ 'gpt-6-luna': { inputPerMTok: 1, outputPerMTok: 2 } });
    const estimate = custom.text(
      'gpt-6-luna',
      usage({ inputTokens: 1_000_000, cachedInputTokens: 500_000, cacheWriteTokens: 250_000, outputTokens: 1_000_000 }),
    );
    expect(estimate).toEqual({ usd: 3, known: true });
    // Models without an override keep the snapshot price.
    expect(custom.embedding('text-embedding-3-small', 1_000_000).usd).toBe(0.02);
  });

  it('prices models that only exist in overrides', () => {
    const custom = createCostEstimator({ 'alt-mini': { inputPerMTok: 0.5, outputPerMTok: 1 } });
    expect(custom.text('alt-mini', usage({ inputTokens: 2_000_000, outputTokens: 1_000_000 }))).toEqual({ usd: 2, known: true });
  });

  it('matches a dated snapshot to the longest known model id', () => {
    expect(costs.text('gpt-6-luna-2026-09-15', usage({ inputTokens: 1_000_000 }))).toEqual({ usd: 0.1, known: true });

    const custom = createCostEstimator({ 'gpt-6-luna-mini': { inputPerMTok: 0.02, outputPerMTok: 0.1 } });
    expect(custom.text('gpt-6-luna-mini-2026-09-15', usage({ inputTokens: 1_000_000 })).usd).toBe(0.02);
    expect(custom.text('gpt-6-luna-2026-09-15', usage({ inputTokens: 1_000_000 })).usd).toBe(0.1);
  });

  it('does not price a different model that merely shares a prefix', () => {
    expect(costs.text('gpt-6-lunar', usage({ inputTokens: 1_000 }))).toEqual({ usd: 0, known: false });
  });

  it('reports unknown models as unpriced', () => {
    expect(costs.text('mystery-model', usage({ inputTokens: 1_000, outputTokens: 1_000 }))).toEqual({ usd: 0, known: false });
    expect(costs.embedding('mystery-embedder', 1_000)).toEqual({ usd: 0, known: false });
    // Object.prototype keys are not prices.
    expect(costs.text('constructor', usage({ inputTokens: 1_000 }))).toEqual({ usd: 0, known: false });
    expect(costs.text('__proto__', usage({ inputTokens: 1_000 }))).toEqual({ usd: 0, known: false });
  });

  it('prices negative or non-finite counts as zero', () => {
    expect(costs.text('gpt-6-luna', usage({ inputTokens: -5, outputTokens: Number.NaN })).usd).toBe(0);
    expect(costs.embedding('text-embedding-3-small', Number.POSITIVE_INFINITY).usd).toBe(0);
  });
});
