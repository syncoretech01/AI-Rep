import type { TokenUsage } from '@/server/ai/types';

/** Which tenant/agent/conversation a unit of AI usage belongs to. */
export interface UsageContext {
  organizationId: string;
  agentId?: string | null;
  conversationId?: string | null;
}

export type TextUsagePurpose = 'chat_response' | 'conversation_summary';
export type EmbeddingUsagePurpose = 'knowledge_ingestion' | 'knowledge_query';

export interface TextUsageReport {
  provider: string;
  model: string;
  usage: TokenUsage;
  toolCalls: number;
  durationMs: number;
  /** Small, non-sensitive annotations (e.g. routing tier). */
  metadata?: Record<string, string | number | boolean>;
}

export interface EmbeddingUsageReport {
  provider: string;
  model: string;
  inputTokens: number;
  durationMs: number;
  metadata?: Record<string, string | number | boolean>;
}

/**
 * Persists normalized usage to `usage_records` with an estimated cost.
 * Adapters report usage; the cost service prices it — never the adapters.
 * Implementations must not throw: a metering failure is logged with enough
 * detail to reconcile, and never breaks a customer conversation.
 */
export interface UsageRecorder {
  recordTextGeneration(context: UsageContext, purpose: TextUsagePurpose, report: TextUsageReport): Promise<void>;
  recordEmbedding(context: UsageContext, purpose: EmbeddingUsagePurpose, report: EmbeddingUsageReport): Promise<void>;
}
