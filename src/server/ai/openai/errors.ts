import 'server-only';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from 'openai';
import { ProviderError, type ProviderErrorCode } from '../types';

/** HTTP 429 codes that mean "out of credit/quota" rather than "slow down": retrying cannot help. */
const QUOTA_CODES = new Set(['credit_balance_exhausted', 'organization_usage_limit_exceeded', 'insufficient_quota']);
const CONTENT_POLICY_CODES = new Set(['content_filter', 'content_policy_violation', 'invalid_prompt']);
const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Codes are copied verbatim from the error body, so they may be numbers (some compatible
 * servers) or free text: only identifiers are classified or quoted, and mapping never throws.
 */
function safeCode(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : undefined;
}

function isQuotaCode(code: string | undefined): boolean {
  return code !== undefined && (QUOTA_CODES.has(code) || code.endsWith('_spend_limit_exceeded'));
}

function isContentPolicyCode(code: string | undefined): boolean {
  return (
    code !== undefined &&
    (CONTENT_POLICY_CODES.has(code) || code.endsWith('_policy') || code.endsWith('_policy_violation'))
  );
}

function hasErrorName(value: unknown, name: string): boolean {
  return typeof value === 'object' && value !== null && 'name' in value && value.name === name;
}

/** `instanceof APIError` alone narrows to `APIError<any, any, any>`. */
function isAPIError(value: unknown): value is APIError {
  return value instanceof APIError;
}

/** Status, provider error code and request id only — SDK messages can echo request content. */
function describe(error: APIError, code: string | undefined): string {
  const parts: string[] = [];
  if (error.status !== undefined) parts.push(`HTTP ${error.status}`);
  if (code) parts.push(code);
  const requestId = safeCode(error.requestID);
  if (requestId) parts.push(`request ${requestId}`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/**
 * Normalizes any failure from the OpenAI SDK (or our own call plumbing) into a
 * ProviderError. Messages are built from safe identifiers only; the original
 * error is kept as `cause` for debugging.
 */
export function toProviderError(error: unknown, provider: string): ProviderError {
  if (error instanceof ProviderError) return error;
  const fail = (code: ProviderErrorCode, retryable: boolean, message: string, status?: number) =>
    new ProviderError({ provider, code, retryable, message: `${provider}: ${message}`, status, cause: error });

  if (error instanceof APIUserAbortError) {
    // The SDK reports any aborted signal as a user abort; the abort reason tells a deadline apart.
    return hasErrorName(error.cause, 'TimeoutError')
      ? fail('timeout', true, 'request timed out')
      : fail('aborted', false, 'request was aborted');
  }
  if (error instanceof APIConnectionTimeoutError) return fail('timeout', true, 'request timed out');
  if (error instanceof APIConnectionError) return fail('unavailable', true, 'could not connect');
  if (isAPIError(error)) {
    const code = safeCode(error.code);
    const detail = describe(error, code);
    if (error instanceof RateLimitError) {
      return isQuotaCode(code)
        ? fail('rate_limited', false, `quota exhausted${detail}`, error.status)
        : fail('rate_limited', true, `rate limited${detail}`, error.status);
    }
    if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
      return fail('auth', false, `credentials rejected${detail}`, error.status);
    }
    if (error instanceof BadRequestError || error instanceof UnprocessableEntityError || error instanceof NotFoundError) {
      return isContentPolicyCode(code)
        ? fail('content_filter', false, `request blocked by content policy${detail}`, error.status)
        : fail('invalid_request', false, `request rejected${detail}`, error.status);
    }
    if (error instanceof InternalServerError) return fail('unavailable', true, `server error${detail}`, error.status);
    // An `error` event inside an SSE stream surfaces as an APIError without an HTTP status.
    if (error.status === undefined) return fail('unavailable', true, `stream error${detail}`);
    return fail('unknown', false, `unexpected response${detail}`, error.status);
  }
  if (hasErrorName(error, 'TimeoutError')) return fail('timeout', true, 'request timed out');
  if (hasErrorName(error, 'AbortError')) return fail('aborted', false, 'request was aborted');
  return fail('unknown', false, 'unexpected error');
}

/** Maps the error code of a `response.failed` stream event. */
export function failedResponseError(rawCode: unknown, provider: string): ProviderError {
  const code = safeCode(rawCode);
  const detail = code ? ` (${code})` : '';
  if (code === 'rate_limit_exceeded') {
    return new ProviderError({ provider, code: 'rate_limited', retryable: true, message: `${provider}: rate limited${detail}` });
  }
  if (isContentPolicyCode(code)) {
    return new ProviderError({
      provider,
      code: 'content_filter',
      retryable: false,
      message: `${provider}: response blocked by content policy${detail}`,
    });
  }
  return new ProviderError({ provider, code: 'unavailable', retryable: true, message: `${provider}: response failed${detail}` });
}

export interface ProviderCall {
  /** Pass to the SDK call: aborts on the caller's signal or the per-call deadline. */
  signal: AbortSignal;
  /** Maps a failure of this call, attributing aborts to the caller ('aborted') or to the deadline ('timeout'). */
  toError(error: unknown): ProviderError;
}

/**
 * The SDK `timeout` only bounds the wait for response headers, so every call also
 * gets an overall deadline (covering retries and the streamed body).
 */
export function startProviderCall(provider: string, timeoutMs: number, callerSignal?: AbortSignal): ProviderCall {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  return {
    signal,
    toError(error) {
      if (callerSignal?.aborted) {
        return new ProviderError({ provider, code: 'aborted', retryable: false, message: `${provider}: request was aborted`, cause: error });
      }
      if (deadline.aborted) {
        return new ProviderError({
          provider,
          code: 'timeout',
          retryable: true,
          message: `${provider}: request timed out after ${timeoutMs}ms`,
          cause: error,
        });
      }
      return toProviderError(error, provider);
    },
  };
}
