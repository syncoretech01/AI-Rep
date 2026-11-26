import { APIError } from 'openai';
import { describe, expect, it } from 'vitest';
import { retryAfterMsFrom, toProviderError } from '@/server/ai/openai/errors';
import {
  DEFAULT_RETRY_POLICY,
  abortableSleep,
  decideRetry,
  isRetryableProviderError,
  withRetries,
  type RetryPolicy,
} from '@/server/ai/retry';
import { ProviderError, type ProviderErrorCode } from '@/server/ai/types';

/**
 * The provider retry policy (AI_RUNTIME.md "Failure handling"): infrastructure failures are retried on the same
 * model with bounded, jittered backoff that honours Retry-After and the caller's deadline; everything else fails
 * at once.
 */

const failure = (code: ProviderErrorCode, retryable: boolean, retryAfterMs?: number) =>
  new ProviderError({ provider: 'p', code, retryable, message: `p: ${code}`, ...(retryAfterMs !== undefined && { retryAfterMs }) });

const POLICY: RetryPolicy = { maxRetries: 2, baseDelayMs: 400, maxDelayMs: 4_000, maxRetryAfterMs: 10_000, minAttemptMs: 3_000 };
const decide = (error: unknown, retry: number, remainingMs = Infinity, random = 0.5) =>
  decideRetry({ error, retry, policy: POLICY, remainingMs, random: () => random });

describe('decideRetry', () => {
  it('retries rate limits, timeouts and outages; never auth, configuration, quota, policy or aborts', () => {
    for (const code of ['rate_limited', 'timeout', 'unavailable'] as const) {
      expect(decide(failure(code, true), 1)).toEqual({ retry: true, delayMs: 300 });
      expect(isRetryableProviderError(failure(code, true))).toBe(true);
    }
    // A retryable flag alone is not enough, and a non-retryable rate limit is an exhausted quota.
    for (const error of [
      failure('rate_limited', false),
      failure('auth', true),
      failure('invalid_request', true),
      failure('content_filter', false),
      failure('aborted', false),
      failure('unknown', false),
      new Error('not a provider error'),
    ]) {
      expect(decide(error, 1)).toEqual({ retry: false, reason: 'not_retryable' });
    }
  });

  it('backs off exponentially with jitter, capped, and stops after maxRetries', () => {
    expect(decide(failure('unavailable', true), 1, Infinity, 0)).toEqual({ retry: true, delayMs: 200 });
    expect(decide(failure('unavailable', true), 1, Infinity, 0.999)).toEqual({ retry: true, delayMs: 400 });
    expect(decide(failure('unavailable', true), 2, Infinity, 0.5)).toEqual({ retry: true, delayMs: 600 });
    expect(decide(failure('unavailable', true), 3)).toEqual({ retry: false, reason: 'exhausted' });
    const generous = { ...POLICY, maxRetries: 10 };
    expect(decideRetry({ error: failure('timeout', true), retry: 9, policy: generous, remainingMs: Infinity, random: () => 1 })).toEqual({
      retry: true,
      delayMs: 4_000,
    });
  });

  it("waits at least the provider's Retry-After, and gives up when that is longer than a visitor would wait", () => {
    expect(decide(failure('rate_limited', true, 2_500), 1)).toEqual({ retry: true, delayMs: 2_500 });
    // A shorter Retry-After than the backoff still gets the backoff.
    expect(decide(failure('rate_limited', true, 10), 1)).toEqual({ retry: true, delayMs: 300 });
    expect(decide(failure('rate_limited', true, 10_001), 1)).toEqual({ retry: false, reason: 'retry_after_too_long' });
  });

  it('never starts a retry that could not finish before the deadline', () => {
    expect(decide(failure('unavailable', true), 1, 3_300)).toEqual({ retry: true, delayMs: 300 });
    expect(decide(failure('unavailable', true), 1, 3_299)).toEqual({ retry: false, reason: 'deadline' });
    expect(decide(failure('rate_limited', true, 2_500), 1, 5_000)).toEqual({ retry: false, reason: 'deadline' });
  });

  it('has conservative defaults', () => {
    expect(DEFAULT_RETRY_POLICY).toEqual({ maxRetries: 2, baseDelayMs: 400, maxDelayMs: 4_000, maxRetryAfterMs: 10_000, minAttemptMs: 3_000 });
  });
});

describe('withRetries', () => {
  const instant = { random: () => 0.5, sleep: () => Promise.resolve() };

  it('returns the first success and reports each retry', async () => {
    const outcomes = [failure('unavailable', true), failure('timeout', true), 'ok'];
    const retries: unknown[] = [];
    const attempts: number[] = [];
    const result = await withRetries(
      (attempt) => {
        attempts.push(attempt);
        const next = outcomes.shift();
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      },
      { policy: POLICY, onRetry: (info) => retries.push([info.retry, info.delayMs, info.error.code]), ...instant },
    );
    expect(result).toBe('ok');
    expect(attempts).toEqual([1, 2, 3]);
    expect(retries).toEqual([
      [1, 300, 'unavailable'],
      [2, 600, 'timeout'],
    ]);
  });

  it('rethrows the last failure once the retries are exhausted, and non-retryable failures at once', async () => {
    let calls = 0;
    const down = failure('unavailable', true);
    await expect(
      withRetries(() => {
        calls += 1;
        return Promise.reject(down);
      }, { policy: POLICY, ...instant }),
    ).rejects.toBe(down);
    expect(calls).toBe(3);

    calls = 0;
    const auth = failure('auth', false);
    await expect(
      withRetries(() => {
        calls += 1;
        return Promise.reject(auth);
      }, { policy: POLICY, ...instant }),
    ).rejects.toBe(auth);
    expect(calls).toBe(1);
  });

  it('lets the caller veto a retry (e.g. part of the response was already shown) and unwrap wrapped errors', async () => {
    class Wrapped extends Error {
      constructor(readonly inner: ProviderError, readonly shown: boolean) {
        super('wrapped');
      }
    }
    let calls = 0;
    const attempt = (shown: boolean) => () => {
      calls += 1;
      return Promise.reject(new Wrapped(failure('unavailable', true), shown));
    };
    const options = {
      policy: POLICY,
      ...instant,
      unwrap: (error: unknown) => (error instanceof Wrapped ? error.inner : error),
      canRetry: (error: unknown) => !(error instanceof Wrapped && error.shown),
    };
    await expect(withRetries(attempt(true), options)).rejects.toBeInstanceOf(Wrapped);
    expect(calls).toBe(1);
    calls = 0;
    await expect(withRetries(attempt(false), options)).rejects.toBeInstanceOf(Wrapped);
    expect(calls).toBe(3);
  });

  it('respects the deadline and an aborted signal', async () => {
    let now = 0;
    let calls = 0;
    await expect(
      withRetries(
        () => {
          calls += 1;
          now += 48_000; // the attempt took most of the turn
          return Promise.reject(failure('timeout', true));
        },
        { policy: POLICY, deadlineAt: 50_000, clock: () => now, ...instant },
      ),
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(calls).toBe(1);

    const controller = new AbortController();
    controller.abort();
    calls = 0;
    await expect(
      withRetries(() => {
        calls += 1;
        return Promise.reject(failure('unavailable', true));
      }, { policy: POLICY, signal: controller.signal, ...instant }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(calls).toBe(1);
  });
});

describe('abortableSleep', () => {
  it('resolves after the delay and rejects as soon as the signal aborts', async () => {
    await expect(abortableSleep(1)).resolves.toBeUndefined();
    const controller = new AbortController();
    const sleeping = abortableSleep(60_000, controller.signal);
    controller.abort(new Error('deadline'));
    await expect(sleeping).rejects.toThrow('deadline');
    await expect(abortableSleep(1, controller.signal)).rejects.toThrow('deadline');
  });
});

describe('Retry-After parsing (OpenAI adapter)', () => {
  it('reads retry-after-ms, then retry-after seconds or an HTTP date', () => {
    expect(retryAfterMsFrom(new Headers({ 'retry-after-ms': '1250.4' }))).toBe(1250);
    expect(retryAfterMsFrom(new Headers({ 'retry-after': '3' }))).toBe(3_000);
    expect(retryAfterMsFrom(new Headers({ 'retry-after-ms': '50', 'retry-after': '3' }))).toBe(50);
    const now = Date.parse('2026-11-26T10:00:00Z');
    expect(retryAfterMsFrom(new Headers({ 'retry-after': 'Thu, 26 Nov 2026 10:00:05 GMT' }), now)).toBe(5_000);
    expect(retryAfterMsFrom(new Headers({ 'retry-after': 'Thu, 26 Nov 2026 09:59:00 GMT' }), now)).toBe(0);
    for (const value of ['soon', '-1', '']) expect(retryAfterMsFrom(new Headers({ 'retry-after': value }))).toBeUndefined();
    expect(retryAfterMsFrom(new Headers())).toBeUndefined();
    expect(retryAfterMsFrom(undefined)).toBeUndefined();
  });

  it('attaches Retry-After to retryable provider errors only', () => {
    const limited = APIError.generate(
      429,
      { error: { message: 'slow down', type: 'requests', code: 'rate_limit_exceeded', param: null } },
      undefined,
      new Headers({ 'retry-after': '2' }),
    );
    expect(toProviderError(limited, 'openai')).toMatchObject({ code: 'rate_limited', retryable: true, retryAfterMs: 2_000 });
    const overloaded = APIError.generate(503, { error: { message: 'busy', type: 'server_error', code: null, param: null } }, undefined, new Headers({ 'retry-after': '1' }));
    expect(toProviderError(overloaded, 'openai')).toMatchObject({ code: 'unavailable', retryable: true, retryAfterMs: 1_000 });
    // An exhausted quota is never retried, whatever the headers say.
    const quota = APIError.generate(
      429,
      { error: { message: 'quota', type: 'insufficient_quota', code: null, param: null } },
      undefined,
      new Headers({ 'retry-after': '2' }),
    );
    const mapped = toProviderError(quota, 'openai');
    expect(mapped).toMatchObject({ code: 'rate_limited', retryable: false });
    expect(mapped.retryAfterMs).toBeUndefined();
  });

  it('treats 408 and 409 as transient', () => {
    const timeout = APIError.generate(408, { error: { message: 'timeout', type: 'x', code: null, param: null } }, undefined, new Headers());
    const conflict = APIError.generate(409, { error: { message: 'conflict', type: 'x', code: null, param: null } }, undefined, new Headers());
    expect(toProviderError(timeout, 'openai')).toMatchObject({ code: 'timeout', retryable: true, status: 408 });
    expect(toProviderError(conflict, 'openai')).toMatchObject({ code: 'unavailable', retryable: true, status: 409 });
  });
});
