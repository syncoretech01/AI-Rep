import { isUuid, maybeOne, toDate, toNumber, truncateText } from '@/server/db/sql';
import type { Sql } from '@/server/db/types';
import { DomainError } from '@/server/domain/types';

/**
 * Voice sessions (public.voice_sessions): lifecycle, limits and metered time of one provider voice session. Written
 * only by the voice gateway in service scope (every statement filters by organization); members read them.
 */

export type VoiceSessionStatus = 'creating' | 'active' | 'ending' | 'ended' | 'failed';
export type VoiceDelegationMode = 'responses' | 'client';

export interface VoiceSession {
  id: string;
  organizationId: string;
  agentId: string;
  conversationId: string;
  startedBy: string | null;
  provider: string;
  model: string;
  voice: string | null;
  delegation: VoiceDelegationMode;
  providerSessionId: string | null;
  status: VoiceSessionStatus;
  endReason: string | null;
  maxDurationSeconds: number;
  gatewayInstance: string | null;
  activeSeconds: number;
  standbySeconds: number;
  usageSource: 'provider' | 'estimated' | null;
  estimatedCostUsd: number;
  createdAt: Date;
  connectedAt: Date | null;
  lastEventAt: Date;
  endedAt: Date | null;
}

/** A session refused by an organization voice limit (concurrency). */
export class VoiceLimitError extends DomainError {
  readonly limit: 'concurrent_sessions' | 'session_starts';

  constructor(limit: 'concurrent_sessions' | 'session_starts' = 'concurrent_sessions') {
    super(
      'conflict',
      limit === 'concurrent_sessions'
        ? 'The maximum number of simultaneous voice sessions is in use. Try again shortly.'
        : 'Too many voice sessions were started in the last minute. Try again shortly.',
    );
    this.name = 'VoiceLimitError';
    this.limit = limit;
  }
}

/** Open sessions whose gateway has not reported for this long no longer count against the concurrency limit. */
export const STALE_SESSION_SECONDS = 90;

const COLUMNS = `id, organization_id, agent_id, conversation_id, started_by, provider, model, voice, delegation,
  provider_session_id, status, end_reason, max_duration_seconds, gateway_instance, active_seconds, standby_seconds,
  usage_source, estimated_cost_usd, created_at, connected_at, last_event_at, ended_at`;

interface Row {
  id: string;
  organization_id: string;
  agent_id: string;
  conversation_id: string;
  started_by: string | null;
  provider: string;
  model: string;
  voice: string | null;
  delegation: VoiceDelegationMode;
  provider_session_id: string | null;
  status: VoiceSessionStatus;
  end_reason: string | null;
  max_duration_seconds: string | number;
  gateway_instance: string | null;
  active_seconds: string | number;
  standby_seconds: string | number;
  usage_source: 'provider' | 'estimated' | null;
  estimated_cost_usd: string | number;
  created_at: Date | string;
  connected_at: Date | string | null;
  last_event_at: Date | string;
  ended_at: Date | string | null;
}

function mapRow(row: Row): VoiceSession {
  return {
    id: row.id,
    organizationId: row.organization_id,
    agentId: row.agent_id,
    conversationId: row.conversation_id,
    startedBy: row.started_by,
    provider: row.provider,
    model: row.model,
    voice: row.voice,
    delegation: row.delegation,
    providerSessionId: row.provider_session_id,
    status: row.status,
    endReason: row.end_reason,
    maxDurationSeconds: toNumber(row.max_duration_seconds),
    gatewayInstance: row.gateway_instance,
    activeSeconds: toNumber(row.active_seconds),
    standbySeconds: toNumber(row.standby_seconds),
    usageSource: row.usage_source,
    estimatedCostUsd: toNumber(row.estimated_cost_usd),
    createdAt: toDate(row.created_at),
    connectedAt: row.connected_at === null ? null : toDate(row.connected_at),
    lastEventAt: toDate(row.last_event_at),
    endedAt: row.ended_at === null ? null : toDate(row.ended_at),
  };
}

export interface OpenVoiceSessionInput {
  organizationId: string;
  agentId: string;
  startedBy: string | null;
  provider: string;
  model: string;
  voice: string;
  delegation: VoiceDelegationMode;
  maxDurationSeconds: number;
  maxConcurrentSessions: number;
  gatewayInstance: string;
}

/**
 * Opens a session record and its (channel-neutral) conversation, enforcing the organization's concurrent-session
 * limit atomically: a transaction-scoped advisory lock serializes openings per organization across gateway
 * instances. Call inside a transaction (service scope).
 */
export async function openVoiceSession(sql: Sql, input: OpenVoiceSessionInput): Promise<VoiceSession> {
  if (!isUuid(input.organizationId) || !isUuid(input.agentId)) throw new DomainError('not_found', 'Agent not found.');
  await sql.query("select pg_advisory_xact_lock(hashtextextended('voice:sessions:' || $1::text, 0))", [input.organizationId]);
  const open = maybeOne(
    await sql.query<{ count: string | number }>(
      `select count(*) as count from public.voice_sessions
       where organization_id = $1 and status in ('creating', 'active', 'ending')
         and last_event_at > now() - make_interval(secs => $2::double precision)`,
      [input.organizationId, STALE_SESSION_SECONDS],
    ),
  );
  if (toNumber(open?.count ?? 0) >= input.maxConcurrentSessions) throw new VoiceLimitError();

  // Selecting the agent turns "not this organization's (active) agent" into zero rows, not a foreign-key error.
  const conversation = maybeOne(
    await sql.query<{ id: string }>(
      `insert into public.conversations (organization_id, agent_id, channel)
       select a.organization_id, a.id, 'web_voice' from public.agents a
       where a.id = $2 and a.organization_id = $1 and a.status = 'active'
       returning id`,
      [input.organizationId, input.agentId],
    ),
  );
  if (!conversation) throw new DomainError('not_found', 'Agent not found or not active.');

  const row = maybeOne(
    await sql.query<Row>(
      `insert into public.voice_sessions
         (organization_id, agent_id, conversation_id, started_by, provider, model, voice, delegation,
          max_duration_seconds, gateway_instance)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning ${COLUMNS}`,
      [
        input.organizationId,
        input.agentId,
        conversation.id,
        input.startedBy,
        truncateText(input.provider, 64),
        truncateText(input.model, 128),
        truncateText(input.voice, 64),
        input.delegation,
        Math.max(1, Math.trunc(input.maxDurationSeconds)),
        truncateText(input.gatewayInstance, 128),
      ],
    ),
  );
  if (!row) throw new Error('voice_sessions insert returned no row');
  return mapRow(row);
}

/** The provider accepted the session: it is live under this gateway instance. */
export async function markVoiceSessionActive(
  sql: Sql,
  organizationId: string,
  sessionId: string,
  providerSessionId: string,
): Promise<void> {
  await sql.query(
    `update public.voice_sessions
     set status = 'active', provider_session_id = $3, connected_at = now(), last_event_at = now()
     where id = $1 and organization_id = $2 and status = 'creating'`,
    [sessionId, organizationId, truncateText(providerSessionId, 200)],
  );
}

/** Heartbeat from the gateway holding the sideband (keeps the session counted and not "stale"). */
export async function touchVoiceSession(sql: Sql, organizationId: string, sessionId: string): Promise<void> {
  await sql.query(
    `update public.voice_sessions set last_event_at = now()
     where id = $1 and organization_id = $2 and status in ('creating', 'active', 'ending')`,
    [sessionId, organizationId],
  );
}

export interface VoiceSessionUsage {
  activeSeconds: number;
  standbySeconds: number;
  source: 'provider' | 'estimated';
  estimatedCostUsd: number;
}

/**
 * Ends the session (idempotent: an already ended session is left as it is) and stores its final metered time.
 * Returns whether this call ended it.
 */
export async function endVoiceSession(
  sql: Sql,
  organizationId: string,
  sessionId: string,
  outcome: { status: 'ended' | 'failed'; reason: string; usage: VoiceSessionUsage },
): Promise<boolean> {
  const rows = await sql.query(
    `update public.voice_sessions
     set status = $3, end_reason = $4, ended_at = now(), last_event_at = now(),
         active_seconds = $5, standby_seconds = $6, usage_source = $7, estimated_cost_usd = $8
     where id = $1 and organization_id = $2 and status in ('creating', 'active', 'ending')
     returning id`,
    [
      sessionId,
      organizationId,
      outcome.status,
      truncateText(outcome.reason, 64),
      roundSeconds(outcome.usage.activeSeconds),
      roundSeconds(outcome.usage.standbySeconds),
      outcome.usage.source,
      Math.max(0, outcome.usage.estimatedCostUsd).toFixed(8),
    ],
  );
  return rows.length > 0;
}

export async function getVoiceSession(sql: Sql, organizationId: string, sessionId: string): Promise<VoiceSession | null> {
  if (!isUuid(organizationId) || !isUuid(sessionId)) return null;
  const row = maybeOne(
    await sql.query<Row>(`select ${COLUMNS} from public.voice_sessions where id = $1 and organization_id = $2`, [
      sessionId,
      organizationId,
    ]),
  );
  return row ? mapRow(row) : null;
}

/**
 * Open sessions whose gateway stopped reporting (crash, lost host): another gateway instance closes them at the
 * provider and settles their usage. Deliberately cross-tenant (operator recovery); each row carries its organization.
 */
export async function findStaleVoiceSessions(sql: Sql, olderThanSeconds = STALE_SESSION_SECONDS, limit = 100): Promise<VoiceSession[]> {
  const rows = await sql.query<Row>(
    `select ${COLUMNS} from public.voice_sessions
     where status in ('creating', 'active', 'ending')
       and last_event_at <= now() - make_interval(secs => $1::double precision)
     order by last_event_at
     limit $2`,
    [olderThanSeconds, Math.min(Math.max(Math.trunc(limit), 1), 500)],
  );
  return rows.map(mapRow);
}

/**
 * Claims a stale session for recovery by this gateway instance (status 'ending'), atomically: when several instances
 * sweep at once, exactly one wins and settles it (no double metering). Returns whether this call claimed it.
 */
export async function claimStaleVoiceSession(
  sql: Sql,
  organizationId: string,
  sessionId: string,
  gatewayInstance: string,
  olderThanSeconds = STALE_SESSION_SECONDS,
): Promise<boolean> {
  const rows = await sql.query(
    `update public.voice_sessions
     set status = 'ending', gateway_instance = $3, last_event_at = now()
     where id = $1 and organization_id = $2 and status in ('creating', 'active', 'ending')
       and last_event_at <= now() - make_interval(secs => $4::double precision)
     returning id`,
    [sessionId, organizationId, truncateText(gatewayInstance, 128), olderThanSeconds],
  );
  return rows.length > 0;
}

function roundSeconds(value: number): string {
  return (Number.isFinite(value) && value > 0 ? value : 0).toFixed(3);
}
