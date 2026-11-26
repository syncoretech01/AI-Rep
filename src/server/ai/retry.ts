import { ProviderError, type ProviderErrorCode } from './types';

/**
 * Provider-neutral retry policy for infrastructure failures (AI_RUNTIME.md "Failure handling").
 *
 * - Retryable 429 (rate limit), timeouts and 5xx/connection failures are retried on the SAME provider and model,
 *   a bounded number of times, with jittered exponential backoff that honours the provider's Retry-After and the
 *   caller's overall deadline.
 * - Authentication, configuration (invalid request), quota-exhausted and content-policy errors fail immediately.
 * - An outage is never a reason to switch to a premium model: escalation is a reasoning decision (ModelRouter).
 * - Callers decide what is safe to repeat: a streamed response the user already saw, or a call whose side effects
 *   may have committed, is not retried (`canRetry`).
 *
 * Provider failover (another provider for the same tier) would plug in here as a list of routes tried in order;
 * it is not implemented while only one provider is configured.
 */

export interface RetryPolicy {
  /** Retries after the first attempt. 0 disables retries. */
  maxRetries: number;
  /** Backoff before the first retry; doubles per retry (before jitter). */
  baseDelayMs: number;
  /** Cap on the computed backoff. */
  maxDelayMs: number;
  /** A provider asking to wait longer than this (Retry-After) is not retried: the user will not wait that long. */
  maxRetryAfterMs: number;
  /** A retry only starts if at least this much time remains before the deadline afterwards. */
  minAttemptMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxRetries: 2,
  baseDelayMs: 400,
  maxDelayMs: 4_000,
  maxRetryAfterMs: 10_000,
  minAttemptMs: 3_000,
});

/** Infrastructure failures worth repeating unchanged. Everything else is a fix-the-request/config problem. */
const RETRYABLE_CODES: ReadonlySet<ProviderErrorCode> = new Set(['rate_limited', 'timeout', 'unavailable']);

export function isRetryableProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError && error.retryable && RETRYABLE_CODES.has(error.code);
}

export interface RetryDecisionInput {
  error: unknown;
  /** 1-based number of the retry being considered. */
  retry: number;
  policy: RetryPolicy;
  /** Milliseconds left before the caller's deadline (Infinity when there is none). */
  remainingMs: number;
  /** Source of jitter in [0, 1). */
  random: () => number;
}

export type RetryDecision =
  | { retry: true; delayMs: number }
  | { retry: false; reason: 'not_retryable' | 'exhausted' | 'retry_after_too_long' | 'deadline' };

/** Whether (and after how long) a failed attempt may be repeated on the same model. */
export function decideRetry(input: RetryDecisionInput): RetryDecision {
  const { error, retry, policy, remainingMs, random } = input;
  if (!isRetryableProviderError(error)) return { retry: false, reason: 'not_retryable' };
  if (retry > policy.maxRetries) return { retry: false, reason: 'exhausted' };

  const retryAfterMs = error.retryAfterMs;
  if (retryAfterMs !== undefined && retryAfterMs > policy.maxRetryAfterMs) {
    return { retry: false, reason: 'retry_after_too_long' };
  }
  // "Equal jitter": half fixed, half random, so concurrent callers spread out without retrying instantly.
  const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retry - 1));
  const jittered = Math.round(backoff / 2 + random() * (backoff / 2));
  const delayMs = Math.max(jittered, retryAfterMs ?? 0);
  if (delayMs + policy.minAttemptMs > remainingMs) return { retry: false, reason: 'deadline' };
  return { retry: true, delayMs };
}

export interface RetryAttemptInfo {
  /** 1-based number of the retry about to start. */
  retry: number;
  delayMs: number;
  error: ProviderError;
}

export interface RetryOptions {
  policy: RetryPolicy;
  /** Absolute deadline in `clock()` milliseconds (default: none). */
  deadlineAt?: number;
  /** Aborts the backoff wait (e.g. the turn deadline). */
  signal?: AbortSignal;
  /** Extra veto for a specific failure, e.g. "the user already saw part of this response". */
  canRetry?: (error: unknown) => boolean;
  /** Maps a thrown value to the provider error it carries (e.g. unwraps a wrapper). Default: identity. */
  unwrap?: (error: unknown) => unknown;
  onRetry?: (info: RetryAttemptInfo) => void;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  clock?: () => number;
}

/** Runs `attempt` (1-based attempt number), repeating it under the policy. Rethrows the last failure. */
export async function withRetries<T>(attempt: (attemptNumber: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const clock = options.clock ?? (() => performance.now());
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? abortableSleep;
  const unwrap = options.unwrap ?? ((error: unknown) => error);
  for (let attemptNumber = 1; ; attemptNumber += 1) {
    try {
      return await attempt(attemptNumber);
    } catch (error) {
      const cause = unwrap(error);
      if (options.signal?.aborted || (options.canRetry && !options.canRetry(error))) throw error;
      const remainingMs = options.deadlineAt === undefined ? Infinity : options.deadlineAt - clock();
      const decision = decideRetry({ error: cause, retry: attemptNumber, policy: options.policy, remainingMs, random });
      if (!decision.retry || !(cause instanceof ProviderError)) throw error;
      options.onRetry?.({ retry: attemptNumber, delayMs: decision.delayMs, error: cause });
      await sleep(decision.delayMs, options.signal);
    }
  }
}

/** Resolves after `ms`, or rejects with the signal's reason as soon as it aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
