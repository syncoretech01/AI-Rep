import { createHmac } from 'node:crypto';
import { one, toNumber } from '@/server/db/sql';
import type { Database } from '@/server/db/types';

/**
 * Fixed-window rate limiting on `app_private.rate_limit_buckets`. Counters live
 * in Postgres, so limits hold across serverless instances. Each call is one
 * atomic upsert on the root connection (its own transaction): never call it
 * inside an open transaction.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Requests left in the current window after this one. */
  remaining: number;
  /** Seconds until the window resets (0 when allowed). */
  retryAfterSeconds: number;
}

/** Matches the rate_limit_buckets.bucket_key check constraint. */
const MAX_KEY_CHARS = 200;
/** Buckets are pruned an hour after their window starts: a longer window would be reset early. */
const MAX_WINDOW_SECONDS = 3600;
const PRUNE_PROBABILITY = 0.02;
const PRUNE_AFTER_MS = MAX_WINDOW_SECONDS * 1000;

export async function consumeRateLimit(
  db: Database,
  input: { key: string; limit: number; windowSeconds: number; now: Date },
): Promise<RateLimitDecision> {
  const { key, limit, windowSeconds, now } = input;
  if (key.length === 0 || key.length > MAX_KEY_CHARS) throw new RangeError('Rate limit keys must be 1-200 characters');
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > MAX_WINDOW_SECONDS) {
    throw new RangeError(`windowSeconds must be an integer from 1 to ${MAX_WINDOW_SECONDS}`);
  }

  const windowMs = windowSeconds * 1000;
  const windowStart = Math.floor(now.getTime() / windowMs) * windowMs;
  const rows = await db.query<{ hits: number | string }>(
    `insert into app_private.rate_limit_buckets as b (bucket_key, window_start, hits)
     values ($1, $2, 1)
     on conflict (bucket_key, window_start) do update set hits = b.hits + 1
     returning b.hits`,
    [key, new Date(windowStart)],
  );
  const hits = toNumber(one(rows, 'rate limit bucket').hits);

  if (Math.random() < PRUNE_PROBABILITY) {
    // Housekeeping only: a failed prune must never fail the request.
    await pruneRateLimitBuckets(db, now).catch(() => undefined);
  }

  const allowed = hits <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - hits),
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((windowStart + windowMs - now.getTime()) / 1000)),
  };
}

/** Deletes buckets whose window started more than an hour before `now`. Returns how many were removed. */
export async function pruneRateLimitBuckets(db: Database, now: Date): Promise<number> {
  const rows = await db.query<{ count: number | string }>(
    `with deleted as (delete from app_private.rate_limit_buckets where window_start < $1 returning 1)
     select count(*) as count from deleted`,
    [new Date(now.getTime() - PRUNE_AFTER_MS)],
  );
  return toNumber(one(rows).count);
}

/** Pseudonymous rate-limit/log identifier for a client IP: no raw IPs are stored or logged. */
export function hashClientIp(ip: string, secret: string): string {
  return createHmac('sha256', secret).update(`syncore.client-ip.v1.${ip}`).digest('hex').slice(0, 32);
}
