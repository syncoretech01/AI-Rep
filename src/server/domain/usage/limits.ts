import { isUuid, maybeOne, toNumber } from '@/server/db/sql';
import type { Database, Sql } from '@/server/db/types';
import type { Logger } from '@/server/observability/logger';
import type { CostEstimator } from './cost';

/**
 * Organization-level AI spending safeguards (AI_RUNTIME.md "Runtime cost controls").
 *
 * Before every provider call the caller reserves a CONSERVATIVE estimate of its cost (input estimate at the dearer
 * of the uncached / cache-write rate, plus the full output cap; the caller over-estimates input); the reservation is
 * granted only if today's and this month's estimated spend plus every in-flight reservation stays within the
 * organization's limits. After the call its real usage is recorded (usage_records -> usage_daily_totals) and the
 * reservation released. Reservations are serialized per organization with a transaction-scoped advisory lock,
 * so concurrent requests on any number of app instances cannot overshoot a limit together; a crashed worker's
 * reservation stops counting when it expires.
 *
 * Estimates come from the configured price list. They are not provider-confirmed billing.
 * Days and months are UTC.
 */

/** The resource budgeted today. Voice minutes, concurrent calls and SMS segments join in later phases. */
export type LimitedResource = 'ai_spend_usd';

export interface OrganizationLimits {
  dailySpendUsd: number;
  monthlySpendUsd: number;
  maxConversationTurns: number;
}

export interface LimitDefaults {
  dailySpendUsd: number;
  monthlySpendUsd: number;
  maxConversationTurns: number;
}

export type LimitScope = 'daily_spend' | 'monthly_spend';

/** A provider call was refused because it could exceed the organization's spend limit. */
export class UsageLimitError extends Error {
  readonly scope: LimitScope;
  readonly resource: LimitedResource;

  constructor(scope: LimitScope) {
    super(`The organization's ${scope === 'daily_spend' ? 'daily' : 'monthly'} AI spend limit has been reached.`);
    this.name = 'UsageLimitError';
    this.scope = scope;
    this.resource = 'ai_spend_usd';
  }
}

export interface Reservation {
  id: string;
  organizationId: string;
  amountUsd: number;
}

export interface SpendSnapshot {
  limits: OrganizationLimits;
  daySpentUsd: number;
  monthSpentUsd: number;
  reservedUsd: number;
}

export interface UsageGuard {
  /**
   * Reserves the conservatively estimated cost of one text-model call (input estimate + the full output cap).
   * Throws UsageLimitError when the organization's limits do not allow it.
   */
  reserveText(organizationId: string, call: { model: string; inputTokens: number; maxOutputTokens: number }): Promise<Reservation>;
  /** Reserves the cost of embedding `inputTokens` tokens. Throws UsageLimitError like reserveText. */
  reserveEmbedding(organizationId: string, call: { model: string; inputTokens: number }): Promise<Reservation>;
  /** Releases a reservation once its usage is recorded (or the call failed). Never throws. */
  release(reservation: Reservation): Promise<void>;
  /** The organization's effective limits (overrides over defaults). */
  limits(organizationId: string): Promise<OrganizationLimits>;
}

/** Longer than any single provider call (including retries) and the chat turn deadline. */
const RESERVATION_TTL_SECONDS = 180;

interface LimitsRow {
  daily_ai_spend_usd: string | number | null;
  monthly_ai_spend_usd: string | number | null;
  max_conversation_turns: string | number | null;
}

interface SpendRow extends LimitsRow {
  day_spent: string | number;
  month_spent: string | number;
  reserved: string | number;
}

function effectiveLimits(row: LimitsRow | null, defaults: LimitDefaults): OrganizationLimits {
  return {
    dailySpendUsd: row?.daily_ai_spend_usd == null ? defaults.dailySpendUsd : toNumber(row.daily_ai_spend_usd),
    monthlySpendUsd: row?.monthly_ai_spend_usd == null ? defaults.monthlySpendUsd : toNumber(row.monthly_ai_spend_usd),
    maxConversationTurns:
      row?.max_conversation_turns == null ? defaults.maxConversationTurns : toNumber(row.max_conversation_turns),
  };
}

/** Spend so far today and this month (UTC), plus live reservations. Call inside the reservation transaction. */
export async function readSpend(sql: Sql, organizationId: string, defaults: LimitDefaults): Promise<SpendSnapshot> {
  const row = maybeOne(
    await sql.query<SpendRow>(
      `select l.daily_ai_spend_usd, l.monthly_ai_spend_usd, l.max_conversation_turns,
              coalesce((select d.estimated_cost_usd from app_private.usage_daily_totals d
                        where d.organization_id = $1 and d.usage_date = (now() at time zone 'UTC')::date), 0) as day_spent,
              coalesce((select sum(d.estimated_cost_usd) from app_private.usage_daily_totals d
                        where d.organization_id = $1
                          and d.usage_date >= date_trunc('month', now() at time zone 'UTC')::date), 0) as month_spent,
              coalesce((select sum(r.amount) from app_private.usage_reservations r
                        where r.organization_id = $1 and r.resource = 'ai_spend_usd' and r.expires_at > now()), 0) as reserved
       from (select 1) as one
       left join app_private.organization_limits l on l.organization_id = $1`,
      [organizationId],
    ),
  );
  return {
    limits: effectiveLimits(row, defaults),
    daySpentUsd: row ? toNumber(row.day_spent) : 0,
    monthSpentUsd: row ? toNumber(row.month_spent) : 0,
    reservedUsd: row ? toNumber(row.reserved) : 0,
  };
}

/** Which limit (if any) a new reservation of `amountUsd` would break. A limit of 0 blocks every call. */
export function exceededLimit(spend: SpendSnapshot, amountUsd: number): LimitScope | null {
  const wouldExceed = (spent: number, limit: number) =>
    limit <= 0 || spent >= limit || spent + spend.reservedUsd + amountUsd > limit;
  if (wouldExceed(spend.daySpentUsd, spend.limits.dailySpendUsd)) return 'daily_spend';
  if (wouldExceed(spend.monthSpentUsd, spend.limits.monthlySpendUsd)) return 'monthly_spend';
  return null;
}

export function createUsageGuard(deps: {
  db: Database;
  costs: CostEstimator;
  defaults: LimitDefaults;
  logger: Logger;
}): UsageGuard {
  const { db, costs, defaults, logger } = deps;

  async function reserve(organizationId: string, amountUsd: number, kind: string, model: string): Promise<Reservation> {
    if (!isUuid(organizationId)) throw new Error('reserve: invalid organization id');
    const amount = Number.isFinite(amountUsd) && amountUsd > 0 ? amountUsd : 0;
    const outcome = await db.transaction(async (sql) => {
      // Bounded like every service-scope transaction (scope.ts): a stuck lock must not pin a pooled connection.
      await sql.query("select set_config('statement_timeout', '10000', true)");
      // One reservation at a time per organization, across all app instances; held until commit.
      await sql.query("select pg_advisory_xact_lock(hashtextextended('usage:ai_spend_usd:' || $1::text, 0))", [
        organizationId,
      ]);
      await sql.query('delete from app_private.usage_reservations where organization_id = $1 and expires_at <= now()', [
        organizationId,
      ]);
      const spend = await readSpend(sql, organizationId, defaults);
      const exceeded = exceededLimit(spend, amount);
      if (exceeded) return { kind: 'denied' as const, exceeded, spend };
      const row = maybeOne(
        await sql.query<{ id: string }>(
          `insert into app_private.usage_reservations (organization_id, resource, amount, expires_at)
           values ($1, 'ai_spend_usd', $2, now() + make_interval(secs => $3::double precision))
           returning id`,
          [organizationId, amount.toFixed(8), RESERVATION_TTL_SECONDS],
        ),
      );
      if (!row) throw new Error('usage reservation insert returned no row');
      return { kind: 'reserved' as const, reservation: { id: row.id, organizationId, amountUsd: amount } };
    });
    if (outcome.kind === 'denied') {
      const { spend, exceeded } = outcome;
      logger.warn('usage.limit.enforced', {
        organizationId,
        resource: 'ai_spend_usd',
        scope: exceeded,
        kind,
        model,
        requestedUsd: amount,
        limitUsd: exceeded === 'daily_spend' ? spend.limits.dailySpendUsd : spend.limits.monthlySpendUsd,
        spentUsd: exceeded === 'daily_spend' ? spend.daySpentUsd : spend.monthSpentUsd,
        reservedUsd: spend.reservedUsd,
      });
      throw new UsageLimitError(exceeded);
    }
    return outcome.reservation;
  }

  return {
    reserveText(organizationId, call) {
      // Input may be billed uncached or as a (dearer) cache write: reserve whichever costs more.
      const base = { inputTokens: call.inputTokens, cachedInputTokens: 0, outputTokens: call.maxOutputTokens, reasoningTokens: 0 };
      const uncached = costs.text(call.model, { ...base, cacheWriteTokens: 0 });
      const cacheWrite = costs.text(call.model, { ...base, cacheWriteTokens: call.inputTokens });
      return reserve(organizationId, Math.max(uncached.usd, cacheWrite.usd), 'text_generation', call.model);
    },
    reserveEmbedding(organizationId, call) {
      return reserve(organizationId, costs.embedding(call.model, call.inputTokens).usd, 'embedding', call.model);
    },
    async release(reservation) {
      try {
        await db.query('delete from app_private.usage_reservations where id = $1 and organization_id = $2', [
          reservation.id,
          reservation.organizationId,
        ]);
      } catch (error) {
        // It expires on its own; only the headroom is temporarily reduced.
        logger.warn('usage.reservation_release_failed', { organizationId: reservation.organizationId, error });
      }
    },
    async limits(organizationId) {
      if (!isUuid(organizationId)) return effectiveLimits(null, defaults);
      const row = maybeOne(
        await db.query<LimitsRow>(
          `select daily_ai_spend_usd, monthly_ai_spend_usd, max_conversation_turns
           from app_private.organization_limits where organization_id = $1`,
          [organizationId],
        ),
      );
      return effectiveLimits(row, defaults);
    },
  };
}

/** Premium-tier (escalation) model calls already made in a conversation. */
export async function countEscalatedCalls(sql: Sql, organizationId: string, conversationId: string): Promise<number> {
  if (!isUuid(organizationId) || !isUuid(conversationId)) return 0;
  const row = maybeOne(
    await sql.query<{ count: string | number }>(
      `select count(*) as count from public.usage_records
       where organization_id = $1 and conversation_id = $2 and kind = 'text_generation'
         and metadata ->> 'tier' = 'escalation'`,
      [organizationId, conversationId],
    ),
  );
  return row ? toNumber(row.count) : 0;
}

/** A guard that never limits (scripts and tests that do not exercise limits). */
export const unlimitedUsageGuard: UsageGuard = {
  reserveText: (organizationId) => Promise.resolve({ id: 'unlimited', organizationId, amountUsd: 0 }),
  reserveEmbedding: (organizationId) => Promise.resolve({ id: 'unlimited', organizationId, amountUsd: 0 }),
  release: () => Promise.resolve(),
  limits: () =>
    Promise.resolve({ dailySpendUsd: Infinity, monthlySpendUsd: Infinity, maxConversationTurns: Number.MAX_SAFE_INTEGER }),
};
