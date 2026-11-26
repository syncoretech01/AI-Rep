import { isUuid, toNumber } from '@/server/db/sql';
import type { Sql } from '@/server/db/types';

/** Read models over usage_records (works under user scope with RLS and under service scope). */

export interface ConversationUsageRow {
  kind: 'text_generation' | 'embedding' | 'voice_session';
  purpose: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  activeSeconds: number | null;
  standbySeconds: number | null;
  estimatedCostUsd: number;
  pricingKnown: boolean;
  createdAt: Date;
}

interface Row {
  kind: ConversationUsageRow['kind'];
  purpose: string;
  provider: string;
  model: string;
  input_tokens: string | number;
  output_tokens: string | number;
  tool_calls: string | number;
  active_seconds: string | number | null;
  standby_seconds: string | number | null;
  estimated_cost_usd: string | number;
  pricing_known: boolean;
  created_at: Date | string;
}

/** Every metered call of one conversation, oldest first. */
export async function listConversationUsage(sql: Sql, organizationId: string, conversationId: string): Promise<ConversationUsageRow[]> {
  if (!isUuid(organizationId) || !isUuid(conversationId)) return [];
  const rows = await sql.query<Row>(
    `select kind, purpose, provider, model, input_tokens, output_tokens, tool_calls, active_seconds, standby_seconds,
            estimated_cost_usd, pricing_known, created_at
     from public.usage_records
     where organization_id = $1 and conversation_id = $2
     order by created_at, id
     limit 1000`,
    [organizationId, conversationId],
  );
  return rows.map((row) => ({
    kind: row.kind,
    purpose: row.purpose,
    provider: row.provider,
    model: row.model,
    inputTokens: toNumber(row.input_tokens),
    outputTokens: toNumber(row.output_tokens),
    toolCalls: toNumber(row.tool_calls),
    activeSeconds: row.active_seconds === null ? null : toNumber(row.active_seconds),
    standbySeconds: row.standby_seconds === null ? null : toNumber(row.standby_seconds),
    estimatedCostUsd: toNumber(row.estimated_cost_usd),
    pricingKnown: row.pricing_known,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  }));
}
