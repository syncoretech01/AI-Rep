import { jsonParam } from '@/server/db/sql';
import type { Database } from '@/server/db/types';
import type { Logger } from '@/server/observability/logger';
import type { CostEstimate, CostEstimator } from './cost';
import type { RecordedUsage, UsageContext, UsageRecorder } from './types';

/** The counters of one usage_records row, named like the TokenUsage fields they come from. */
interface UsageCounts {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  toolCalls: number;
  durationMs: number;
  /** Voice session time, in seconds (null for token usage). */
  activeSeconds?: number;
  standbySeconds?: number;
}

interface UsageEntry {
  kind: 'text_generation' | 'embedding' | 'voice_session';
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

/** Seconds with millisecond precision; a misbehaving value records as 0 rather than losing the record. */
function seconds(value: number): string {
  return (Number.isFinite(value) && value > 0 ? Math.min(value, 1e9) : 0).toFixed(3);
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
export function createUsageRecorder(deps: {
  db: Database;
  costs: CostEstimator;
  logger: Logger;
  /** Stored with every estimate (AI_PRICING_VERSION): which price list produced it. */
  pricingVersion?: string;
}): UsageRecorder {
  const { db, costs, logger } = deps;
  const pricingVersion = deps.pricingVersion ?? null;
  const unpricedModels = new Set<string>();

  async function persist(context: UsageContext, build: () => UsageEntry): Promise<RecordedUsage> {
    let entry: UsageEntry | undefined;
    let recorded: RecordedUsage = { estimatedCostUsd: 0, pricingKnown: false };
    try {
      entry = build();
      const { counts, cost } = entry;
      const usd = Number.isFinite(cost.usd) && cost.usd > 0 ? cost.usd : 0;
      recorded = { estimatedCostUsd: usd, pricingKnown: cost.known };
      if (!cost.known) warnUnpriced(entry.provider, entry.model);
      await db.query(
        `insert into public.usage_records
           (organization_id, agent_id, conversation_id, kind, purpose, provider, model,
            input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
            tool_calls, duration_ms, estimated_cost_usd, pricing_known, metadata, pricing_version,
            active_seconds, standby_seconds)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18, $19, $20)`,
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
          cost.known ? pricingVersion : null,
          counts.activeSeconds === undefined ? null : seconds(counts.activeSeconds),
          counts.standbySeconds === undefined ? null : seconds(counts.standbySeconds),
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
    return recorded;
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
    recordVoiceSession: (context, report) =>
      persist(context, () => ({
        kind: 'voice_session',
        purpose: 'voice_session',
        provider: report.provider,
        model: report.model,
        counts: {
          inputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          toolCalls: 0,
          durationMs: count((report.activeSeconds + report.standbySeconds) * 1000),
          activeSeconds: report.activeSeconds,
          standbySeconds: report.standbySeconds,
        },
        cost: costs.voice(report.model, { activeSeconds: report.activeSeconds, standbySeconds: report.standbySeconds }),
        metadata: { usageSource: report.source, ...report.metadata },
      })),
  };
}
