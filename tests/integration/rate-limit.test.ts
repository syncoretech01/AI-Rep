import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { consumeRateLimit, hashClientIp, pruneRateLimitBuckets } from '@/server/channels/webchat/rate-limit';
import { createTestDatabase, type TestDatabase } from '../support/db';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.close();
});

// 12:00:15.200 UTC: 44.8 s before the end of its 60 s window.
const NOW = new Date('2026-10-08T12:00:15.200Z');
const WINDOW_START = new Date('2026-10-08T12:00:00.000Z');
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
const newKey = () => `test:${randomUUID()}`;

function consume(key: string, limit: number, now: Date = NOW) {
  return consumeRateLimit(t.db, { key, limit, windowSeconds: 60, now });
}

async function bucketRows(key: string): Promise<Array<{ window_start: Date; hits: number }>> {
  return t.db.query<{ window_start: Date; hits: number }>(
    'select window_start, hits from app_private.rate_limit_buckets where bucket_key = $1 order by window_start',
    [key],
  );
}

describe('consumeRateLimit', () => {
  it('counts requests within a window and blocks at the limit with a retry delay', async () => {
    const key = newKey();

    expect(await consume(key, 3)).toEqual({ allowed: true, remaining: 2, retryAfterSeconds: 0 });
    expect(await consume(key, 3, at(1000))).toEqual({ allowed: true, remaining: 1, retryAfterSeconds: 0 });
    expect(await consume(key, 3, at(2000))).toEqual({ allowed: true, remaining: 0, retryAfterSeconds: 0 });
    // 4th request at 12:00:17.200: the window ends at 12:01:00, 42.8 s later.
    expect(await consume(key, 3, at(2000))).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 43 });
    expect(await consume(key, 3, at(44_700))).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 1 });

    // One row per key and aligned window; denied requests are counted too.
    expect(await bucketRows(key)).toEqual([{ window_start: WINDOW_START, hits: 5 }]);
  });

  it('starts counting again in the next window', async () => {
    const key = newKey();
    await consume(key, 1);
    expect((await consume(key, 1)).allowed).toBe(false);

    expect(await consume(key, 1, at(44_800))).toEqual({ allowed: true, remaining: 0, retryAfterSeconds: 0 });
    expect(await bucketRows(key)).toEqual([
      { window_start: WINDOW_START, hits: 2 },
      { window_start: new Date('2026-10-08T12:01:00.000Z'), hits: 1 },
    ]);
  });

  it('keeps keys independent', async () => {
    const exhausted = newKey();
    const other = newKey();
    await consume(exhausted, 1);
    expect((await consume(exhausted, 1)).allowed).toBe(false);

    expect(await consume(other, 1)).toEqual({ allowed: true, remaining: 0, retryAfterSeconds: 0 });
  });

  it('counts concurrent requests exactly (one atomic upsert per request)', async () => {
    const key = newKey();
    const decisions = await Promise.all(Array.from({ length: 12 }, () => consume(key, 5)));

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(5);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(7);
    expect(await bucketRows(key)).toEqual([{ window_start: WINDOW_START, hits: 12 }]);
  });

  it('honours other window sizes', async () => {
    const key = newKey();
    const decision = await consumeRateLimit(t.db, { key, limit: 1, windowSeconds: 3600, now: NOW });
    expect(decision.allowed).toBe(true);
    const denied = await consumeRateLimit(t.db, { key, limit: 1, windowSeconds: 3600, now: NOW });
    // The hour window started at 12:00:00, so it resets 3584.8 s later.
    expect(denied).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 3585 });
  });

  it('rejects invalid keys and limits before touching the database', async () => {
    const valid = { key: newKey(), limit: 1, windowSeconds: 60, now: NOW };
    await expect(consumeRateLimit(t.db, { ...valid, key: '' })).rejects.toThrow(RangeError);
    await expect(consumeRateLimit(t.db, { ...valid, key: 'k'.repeat(201) })).rejects.toThrow(RangeError);
    await expect(consumeRateLimit(t.db, { ...valid, limit: 0 })).rejects.toThrow(RangeError);
    await expect(consumeRateLimit(t.db, { ...valid, windowSeconds: 0.5 })).rejects.toThrow(RangeError);
    // Buckets are pruned an hour after their window starts, so longer windows are refused.
    await expect(consumeRateLimit(t.db, { ...valid, windowSeconds: 3601 })).rejects.toThrow(RangeError);
    expect(await bucketRows(valid.key)).toEqual([]);
  });
});

describe('bucket pruning', () => {
  async function insertBucket(key: string, windowStart: Date): Promise<void> {
    await t.db.query('insert into app_private.rate_limit_buckets (bucket_key, window_start, hits) values ($1, $2, 1)', [
      key,
      windowStart,
    ]);
  }

  it('deletes buckets whose window started more than an hour ago', async () => {
    const old = newKey();
    const recent = newKey();
    await insertBucket(old, at(-2 * 3600 * 1000));
    await insertBucket(recent, at(-30 * 60 * 1000));

    expect(await pruneRateLimitBuckets(t.db, NOW)).toBeGreaterThanOrEqual(1);
    expect(await bucketRows(old)).toEqual([]);
    expect(await bucketRows(recent)).toHaveLength(1);
  });

  it('prunes opportunistically while consuming', async () => {
    const old = newKey();
    await insertBucket(old, at(-3 * 3600 * 1000));

    // Math.random only decides whether to prune (PGlite draws its entropy from crypto, not from it).
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    await consume(newKey(), 10);
    random.mockReturnValue(0.001);
    expect(await bucketRows(old)).toHaveLength(1);

    await consume(newKey(), 10);
    random.mockRestore();
    expect(await bucketRows(old)).toEqual([]);
  });
});

describe('hashClientIp', () => {
  it('is a keyed, truncated hash: stable, secret-dependent and never the raw IP', () => {
    const secret = 'rate-limit-test-secret-0123456789abcdef';
    const hash = hashClientIp('203.0.113.7', secret);

    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(hashClientIp('203.0.113.7', secret)).toBe(hash);
    expect(hashClientIp('203.0.113.8', secret)).not.toBe(hash);
    expect(hashClientIp('203.0.113.7', `${secret}x`)).not.toBe(hash);
  });
});
