import { jsonParam } from '@/server/db/sql';
import type { Database } from '@/server/db/types';
import type { Logger } from '@/server/observability/logger';
import type { CostEstimate, CostEstimator } from './cost';
import type { UsageContext, UsageRecorder } from './types';

/** The counters of one usage_records row, named like the TokenUsage fields they come from. */
interface UsageCounts {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  toolCalls: number;
  durationMs: number;
}

interface UsageEntry {
  kind: 'text_generation' | 'embedding';
  purpose: string;
  provider: string;
  model: string;
  counts: UsageCounts;
  cost: CostEstimate;
  metadata: Record<string, string | number | boolean>;
}

const INT4_MAX = 2_147_483_647;

/** Integer column value; a misbehaving adapter (negative, fractional, NaN) must not lose the record. */
function count(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), INT4_MAX) : 0;
}

/** Fits a provider-reported label into its column (empty labels would violate the check constraint). */
function label(value: string, maxChars: number): string {
  return value.trim().slice(0, maxChars) || 'unknown';
}

/**
 * Persists usage with an estimated cost to `usage_records`. Writes go through
 * the privileged connection (system records; members only read them) as their
 * own statement — never call this inside an open transaction.
 */
export function createUsageRecorder(deps: { db: Database; costs: CostEstimator; logger: Logger }): UsageRecorder {
  const { db, costs, logger } = deps;
  const unpricedModels = new Set<string>();

  async function persist(context: UsageContext, build: () => UsageEntry): Promise<void> {
    let entry: UsageEntry | undefined;
    try {
      entry = build();
      const { counts, cost } = entry;
      const usd = Number.isFinite(cost.usd) && cost.usd > 0 ? cost.usd : 0;
      if (!cost.known) warnUnpriced(entry.provider, entry.model);
      await db.query(
        `insert into public.usage_records
           (organization_id, agent_id, conversation_id, kind, purpose, provider, model,
            input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
            tool_calls, duration_ms, estimated_cost_usd, pricing_known, metadata)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb)`,
        [
          context.organizationId,
          context.agentId ?? null,
          context.conversationId ?? null,
          entry.kind,
          entry.purpose,
          label(entry.provider, 64),
          label(entry.model, 128),
          counts.inputTokens,
          counts.cachedInputTokens,
          counts.cacheWriteTokens,
          counts.outputTokens,
          counts.reasoningTokens,
          counts.toolCalls,
          counts.durationMs,
          usd.toFixed(8),
          cost.known,
          jsonParam(entry.metadata),
        ],
      );
    } catch (error) {
      // Metering must never break a conversation. Log everything needed to reconcile (numbers only, no content).
      logger.error('usage.record_failed', {
        organizationId: context.organizationId,
        agentId: context.agentId ?? null,
        conversationId: context.conversationId ?? null,
        ...(entry && {
          kind: entry.kind,
          purpose: entry.purpose,
          provider: entry.provider,
          model: entry.model,
          ...entry.counts,
          costUsd: entry.cost.usd,
          pricingKnown: entry.cost.known,
          metadata: entry.metadata,
        }),
        error,
      });
    }
  }

  function warnUnpriced(provider: string, model: string): void {
    const key = `${provider}/${model}`;
    if (unpricedModels.has(key)) return;
    unpricedModels.add(key);
    logger.warn('usage.pricing_unknown', { provider, model, hint: 'add the model to AI_MODEL_PRICING_JSON' });
  }

  return {
    recordTextGeneration: (context, purpose, report) =>
      persist(context, () => ({
        kind: 'text_generation',
        purpose,
        provider: report.provider,
        model: report.model,
        counts: {
          inputTokens: count(report.usage.inputTokens),
          cachedInputTokens: count(report.usage.cachedInputTokens),
          cacheWriteTokens: count(report.usage.cacheWriteTokens),
          outputTokens: count(report.usage.outputTokens),
          reasoningTokens: count(report.usage.reasoningTokens),
          toolCalls: count(report.toolCalls),
          durationMs: count(report.durationMs),
        },
        cost: costs.text(report.model, report.usage),
        metadata: report.metadata ?? {},
      })),
    recordEmbedding: (context, purpose, report) =>
      persist(context, () => ({
        kind: 'embedding',
        purpose,
        provider: report.provider,
        model: report.model,
        counts: {
          inputTokens: count(report.inputTokens),
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          toolCalls: 0,
          durationMs: count(report.durationMs),
        },
        cost: costs.embedding(report.model, report.inputTokens),
        metadata: report.metadata ?? {},
      })),
  };
}
