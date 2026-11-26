import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCostEstimator } from '@/server/domain/usage/cost';
import {
  UsageLimitError,
  countEscalatedCalls,
  createUsageGuard,
  unlimitedUsageGuard,
  type LimitDefaults,
} from '@/server/domain/usage/limits';
import { silentLogger } from '@/server/observability/logger';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { createConversation, createTenant } from '../support/fixtures';

/**
 * Organization-level AI spending safeguards (AI_RUNTIME.md "Runtime cost controls"): worst-case reservations
 * before provider calls, checked against today's / this month's estimated spend plus in-flight reservations.
 */

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.close();
});

// $1 per input token makes the arithmetic obvious.
const costs = createCostEstimator({
  'priced-model': { inputPerMTok: 1_000_000, outputPerMTok: 0 },
  'voice-model': { inputPerMTok: 0, outputPerMTok: 0, activePerMinute: 1, standbyPerMinute: 0.5 },
});
const DEFAULTS: LimitDefaults = { dailySpendUsd: 10, monthlySpendUsd: 25, maxConversationTurns: 50 };
const guardWith = (defaults: LimitDefaults = DEFAULTS) => createUsageGuard({ db: t.db, costs, defaults, logger: silentLogger });
const usd = (amount: number) => ({ model: 'priced-model', inputTokens: amount, maxOutputTokens: 0 });

async function newOrganization(): Promise<string> {
  return (await t.service.run((sql) => createTenant(sql))).org.id;
}

/** A metered call as the usage recorder stores it (the trigger maintains the daily totals). */
async function recordSpend(organizationId: string, amountUsd: number, createdAt?: string): Promise<void> {
  await t.db.query(
    `insert into public.usage_records (organization_id, kind, purpose, provider, model, estimated_cost_usd, created_at)
     values ($1, 'text_generation', 'chat_response', 'p', 'priced-model', $2, coalesce($3::timestamptz, now()))`,
    [organizationId, amountUsd.toFixed(8), createdAt ?? null],
  );
}

describe('spend reservations', () => {
  it("grants reservations while today's spend plus in-flight reservations stays within the daily limit", async () => {
    const organizationId = await newOrganization();
    const guard = guardWith();

    const first = await guard.reserveText(organizationId, usd(4));
    await guard.reserveText(organizationId, usd(4));
    await expect(guard.reserveText(organizationId, usd(4))).rejects.toMatchObject({ name: 'UsageLimitError', scope: 'daily_spend' });

    // Releasing a finished call frees its headroom.
    await guard.release(first);
    await expect(guard.reserveText(organizationId, usd(4))).resolves.toMatchObject({ amountUsd: 4 });
  });

  it('counts recorded spend through the daily totals, today only for the daily limit', async () => {
    const organizationId = await newOrganization();
    const guard = guardWith();
    await recordSpend(organizationId, 9);
    // Earlier days and months never count against today.
    await recordSpend(organizationId, 100, '2020-01-01T12:00:00Z');

    await expect(guard.reserveText(organizationId, usd(2))).rejects.toBeInstanceOf(UsageLimitError);
    await expect(guard.reserveText(organizationId, usd(1))).resolves.toMatchObject({ amountUsd: 1 });
    const totals = await t.db.query<{ usage_date: string; estimated_cost_usd: string; records: number }>(
      `select usage_date::text as usage_date, estimated_cost_usd, records from app_private.usage_daily_totals
       where organization_id = $1 order by usage_date`,
      [organizationId],
    );
    expect(totals.map((row) => [row.usage_date, row.estimated_cost_usd, row.records])).toEqual([
      ['2020-01-01', '100.00000000', 1],
      [expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), '9.00000000', 1],
    ]);
  });

  it('enforces the monthly limit independently of the daily one', async () => {
    const organizationId = await newOrganization();
    const guard = guardWith({ dailySpendUsd: 100, monthlySpendUsd: 5, maxConversationTurns: 50 });
    await recordSpend(organizationId, 3);
    // Last month's spend is outside this month (and never today).
    const lastMonth = await t.db.query<{ at: string }>(
      "select (date_trunc('month', now() at time zone 'UTC') - interval '1 hour')::text || '+00' as at",
    );
    await recordSpend(organizationId, 50, lastMonth[0]!.at);

    await expect(guard.reserveText(organizationId, usd(3))).rejects.toMatchObject({ scope: 'monthly_spend' });
    await expect(guard.reserveText(organizationId, usd(2))).resolves.toMatchObject({ amountUsd: 2 });
  });

  it('applies per-organization overrides over the defaults; a limit of 0 blocks every call, even an unpriced one', async () => {
    const organizationId = await newOrganization();
    const guard = guardWith();
    await t.db.query(
      `insert into app_private.organization_limits
         (organization_id, daily_ai_spend_usd, max_conversation_turns, max_concurrent_voice_sessions, max_voice_session_seconds)
       values ($1, 0, 7, 1, 120)`,
      [organizationId],
    );

    expect(await guard.limits(organizationId)).toEqual({
      dailySpendUsd: 0,
      monthlySpendUsd: 25,
      maxConversationTurns: 7,
      maxConcurrentVoiceSessions: 1,
      maxVoiceSessionSeconds: 120,
    });
    await expect(guard.reserveText(organizationId, { model: 'unpriced', inputTokens: 1, maxOutputTokens: 1 })).rejects.toMatchObject({
      scope: 'daily_spend',
    });
    await expect(guard.reserveEmbedding(organizationId, { model: 'unpriced', inputTokens: 1 })).rejects.toBeInstanceOf(UsageLimitError);
    // Without an override the defaults apply.
    expect(await guard.limits(await newOrganization())).toEqual({
      dailySpendUsd: 10,
      monthlySpendUsd: 25,
      maxConversationTurns: 50,
      maxConcurrentVoiceSessions: Number.MAX_SAFE_INTEGER,
      maxVoiceSessionSeconds: Number.MAX_SAFE_INTEGER,
    });
  });

  it('reserves a voice session for its whole maximum duration, all of it priced as active, plus the text allowance', async () => {
    const organizationId = await newOrganization();
    const guard = guardWith();

    // 5 minutes at $1/min active + $0.50 delegated text allowance.
    const reservation = await guard.reserveVoice(organizationId, { model: 'voice-model', maxSeconds: 300, extraUsd: 0.5 });
    expect(reservation.amountUsd).toBeCloseTo(5.5, 8);
    // It holds the headroom for the session's lifetime plus the reconciliation margin.
    const [row] = await t.db.query<{ seconds: number }>(
      'select extract(epoch from expires_at - created_at)::int as seconds from app_private.usage_reservations where id = $1',
      [reservation.id],
    );
    expect(row?.seconds).toBe(420);
    // A second session would exceed the $10 daily limit; a cheaper text call still fits.
    await expect(guard.reserveVoice(organizationId, { model: 'voice-model', maxSeconds: 300, extraUsd: 0 })).rejects.toMatchObject({
      scope: 'daily_spend',
    });
    await expect(guard.reserveText(organizationId, usd(4))).resolves.toMatchObject({ amountUsd: 4 });
    await guard.release(reservation);
    await expect(guard.reserveVoice(organizationId, { model: 'voice-model', maxSeconds: 300, extraUsd: 0 })).resolves.toMatchObject({
      amountUsd: 5,
    });
  });

  it("stops counting a crashed worker's reservation once it expires", async () => {
    const organizationId = await newOrganization();
    const guard = guardWith();
    await guard.reserveText(organizationId, usd(8));
    await expect(guard.reserveText(organizationId, usd(8))).rejects.toBeInstanceOf(UsageLimitError);

    await t.db.query(
      "update app_private.usage_reservations set expires_at = now() - interval '1 second' where organization_id = $1",
      [organizationId],
    );
    await expect(guard.reserveText(organizationId, usd(8))).resolves.toMatchObject({ amountUsd: 8 });
    // The expired row was cleaned up by the reservation that followed.
    const rows = await t.db.query('select id from app_private.usage_reservations where organization_id = $1', [organizationId]);
    expect(rows).toHaveLength(1);
  });

  it('serializes concurrent reservations: together they never overshoot the limit', async () => {
    const organizationId = await newOrganization();
    const guard = guardWith();

    const results = await Promise.allSettled(Array.from({ length: 6 }, () => guard.reserveText(organizationId, usd(3))));

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3); // 9 of 10 USD
    expect(
      results.every((result) => result.status === 'fulfilled' || result.reason instanceof UsageLimitError),
    ).toBe(true);
  });

  it('keeps organizations separate', async () => {
    const full = await newOrganization();
    const other = await newOrganization();
    const guard = guardWith();
    await recordSpend(full, 10);

    await expect(guard.reserveText(full, usd(1))).rejects.toBeInstanceOf(UsageLimitError);
    await expect(guard.reserveText(other, usd(9))).resolves.toMatchObject({ organizationId: other });
  });

  it('reserves embeddings at their price and never refuses with the unlimited guard', async () => {
    const organizationId = await newOrganization();
    const embeddings = createUsageGuard({
      db: t.db,
      costs: createCostEstimator({ 'embed-model': { inputPerMTok: 1_000_000, outputPerMTok: 0 } }),
      defaults: DEFAULTS,
      logger: silentLogger,
    });
    await expect(embeddings.reserveEmbedding(organizationId, { model: 'embed-model', inputTokens: 11 })).rejects.toBeInstanceOf(
      UsageLimitError,
    );
    await expect(embeddings.reserveEmbedding(organizationId, { model: 'embed-model', inputTokens: 10 })).resolves.toMatchObject({
      amountUsd: 10,
    });
    await expect(unlimitedUsageGuard.reserveText(organizationId, usd(1e9))).resolves.toMatchObject({ amountUsd: 0 });
  });
});

describe('escalated call counting', () => {
  it('counts premium-tier text calls per conversation', async () => {
    const tenant = await t.service.run((sql) => createTenant(sql));
    const conversation = await t.service.run((sql) => createConversation(sql, tenant.org.id, tenant.agent.id));
    const record = (tier: string) =>
      t.db.query(
        `insert into public.usage_records (organization_id, conversation_id, kind, purpose, provider, model, metadata)
         values ($1, $2, 'text_generation', 'chat_response', 'p', 'm', jsonb_build_object('tier', $3::text))`,
        [tenant.org.id, conversation.id, tier],
      );
    await record('default');
    await record('escalation');
    await record('escalation');

    expect(await t.service.run((sql) => countEscalatedCalls(sql, tenant.org.id, conversation.id))).toBe(2);
    const other = await t.service.run((sql) => createTenant(sql));
    expect(await t.service.run((sql) => countEscalatedCalls(sql, other.org.id, conversation.id))).toBe(0);
  });
});
