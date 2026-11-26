import type { TokenUsage } from '@/server/ai/types';

/** Which tenant/agent/conversation a unit of AI usage belongs to. */
export interface UsageContext {
  organizationId: string;
  agentId?: string | null;
  conversationId?: string | null;
}

/** voice_delegation: tokens of the provider-hosted backend model that answers in a voice session (Responses delegation). */
export type TextUsagePurpose = 'chat_response' | 'conversation_summary' | 'voice_delegation';
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

export interface VoiceUsageReport {
  provider: string;
  model: string;
  activeSeconds: number;
  standbySeconds: number;
  /** 'provider' when the provider reported the seconds; 'estimated' when derived from our own timestamps. */
  source: 'provider' | 'estimated';
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
  recordTextGeneration(context: UsageContext, purpose: TextUsagePurpose, report: TextUsageReport): Promise<RecordedUsage>;
  recordEmbedding(context: UsageContext, purpose: EmbeddingUsagePurpose, report: EmbeddingUsageReport): Promise<RecordedUsage>;
  /** Session time of a realtime voice session (one record when it ends). */
  recordVoiceSession(context: UsageContext, report: VoiceUsageReport): Promise<RecordedUsage>;
}

/** The estimate a record was stored with (also returned when storing failed, so callers can still log it). */
export interface RecordedUsage {
  estimatedCostUsd: number;
  pricingKnown: boolean;
}
