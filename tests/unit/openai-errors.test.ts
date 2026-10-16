import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from 'openai';
import { describe, expect, it } from 'vitest';
import { failedResponseError, startProviderCall, toProviderError } from '@/server/ai/openai/errors';
import { ProviderError } from '@/server/ai/types';

/** Builds the same error class the SDK throws for an HTTP error response. */
function httpError(status: number, code: string | null, message = 'The provider said something') {
  return APIError.generate(
    status,
    { error: { message, type: 'invalid_request_error', code, param: null } },
    undefined,
    new Headers({ 'x-request-id': 'req_abc123' }),
  );
}

describe('toProviderError', () => {
  it('passes ProviderErrors through unchanged', () => {
    const error = new ProviderError({ provider: 'openai', code: 'timeout', retryable: true, message: 'x' });
    expect(toProviderError(error, 'openai')).toBe(error);
  });

  it.each([
    [429, 'rate_limit_exceeded', 'rate_limited', true],
    [429, 'insufficient_quota', 'rate_limited', false],
    [429, 'credit_balance_exhausted', 'rate_limited', false],
    [429, 'project_spend_limit_exceeded', 'rate_limited', false],
    [429, 'organization_spend_limit_exceeded', 'rate_limited', false],
    [429, 'organization_usage_limit_exceeded', 'rate_limited', false],
    [401, 'invalid_api_key', 'auth', false],
    [403, null, 'auth', false],
    [400, 'context_length_exceeded', 'invalid_request', false],
    [404, 'model_not_found', 'invalid_request', false],
    [422, null, 'invalid_request', false],
    [400, 'content_policy_violation', 'content_filter', false],
    [400, 'invalid_prompt', 'content_filter', false],
    [500, 'server_error', 'unavailable', true],
    [503, null, 'unavailable', true],
    [418, null, 'unknown', false],
  ] as const)('maps HTTP %i (%s) to %s', (status, code, expected, retryable) => {
    const mapped = toProviderError(httpError(status, code), 'openai');
    expect(mapped).toBeInstanceOf(ProviderError);
    expect(mapped).toMatchObject({ provider: 'openai', code: expected, retryable, status });
  });

  it('maps SDK connection failures and aborts', () => {
    expect(toProviderError(new APIConnectionTimeoutError(), 'openai')).toMatchObject({ code: 'timeout', retryable: true });
    expect(toProviderError(new APIConnectionError({ message: 'socket hang up' }), 'openai')).toMatchObject({
      code: 'unavailable',
      retryable: true,
    });
    expect(toProviderError(new APIUserAbortError(), 'openai')).toMatchObject({ code: 'aborted', retryable: false });
  });

  it('treats a user abort caused by a deadline as a timeout', () => {
    const abort = new APIUserAbortError();
    Object.defineProperty(abort, 'cause', { value: new DOMException('The operation timed out.', 'TimeoutError') });
    expect(toProviderError(abort, 'openai')).toMatchObject({ code: 'timeout', retryable: true });
  });

  it('maps an SSE error event (APIError without status) to a retryable unavailability', () => {
    const sseError = new APIError(undefined, { code: 'server_error', message: 'boom' }, undefined, undefined);
    expect(toProviderError(sseError, 'openai')).toMatchObject({ code: 'unavailable', retryable: true, status: undefined });
  });

  it('maps raw abort/timeout DOMExceptions and anything else', () => {
    expect(toProviderError(new DOMException('timed out', 'TimeoutError'), 'openai')).toMatchObject({ code: 'timeout' });
    expect(toProviderError(new DOMException('aborted', 'AbortError'), 'openai')).toMatchObject({ code: 'aborted' });
    expect(toProviderError(new TypeError('boom'), 'openai')).toMatchObject({ code: 'unknown', retryable: false });
    expect(toProviderError('a string', 'openai')).toMatchObject({ code: 'unknown', retryable: false });
  });

  it('builds safe messages from identifiers only and keeps the cause', () => {
    const original = httpError(400, 'invalid_value', "Invalid value in input[2]: 'my phone is 555-0100'");
    const mapped = toProviderError(original, 'openai');
    expect(mapped.message).toBe('openai: request rejected (HTTP 400, invalid_value, request req_abc123)');
    expect(mapped.message).not.toContain('555-0100');
    expect(mapped.cause).toBe(original);
  });

  it('never copies unsafe-looking codes into the message', () => {
    const mapped = toProviderError(httpError(400, 'bad code with spaces & <html>'), 'openai');
    expect(mapped.message).toBe('openai: request rejected (HTTP 400, request req_abc123)');
  });

  it('never throws on non-string codes (OpenAI-compatible servers may send numbers)', () => {
    const numeric = (status: number) =>
      APIError.generate(status, { error: { message: 'x', code: status } }, undefined, new Headers());
    expect(toProviderError(numeric(400), 'openai')).toMatchObject({ code: 'invalid_request', message: 'openai: request rejected (HTTP 400)' });
    expect(toProviderError(numeric(429), 'openai')).toMatchObject({ code: 'rate_limited', retryable: true });
    expect(failedResponseError(500, 'openai')).toMatchObject({ code: 'unavailable', message: 'openai: response failed' });
  });
});

describe('failedResponseError', () => {
  it('maps response.failed error codes', () => {
    expect(failedResponseError('server_error', 'openai')).toMatchObject({
      code: 'unavailable',
      retryable: true,
      message: 'openai: response failed (server_error)',
    });
    expect(failedResponseError(null, 'openai')).toMatchObject({ code: 'unavailable', retryable: true });
    expect(failedResponseError('rate_limit_exceeded', 'openai')).toMatchObject({ code: 'rate_limited', retryable: true });
    for (const code of ['invalid_prompt', 'bio_policy', 'misalignment_policy_violation']) {
      expect(failedResponseError(code, 'openai')).toMatchObject({ code: 'content_filter', retryable: false });
    }
  });
});

describe('startProviderCall', () => {
  it('attributes failures to the caller abort, then the deadline, then the error itself', async () => {
    const caller = new AbortController();
    const call = startProviderCall('openai', 60_000, caller.signal);
    expect(call.signal.aborted).toBe(false);
    expect(call.toError(httpError(500, null))).toMatchObject({ code: 'unavailable' });

    caller.abort();
    expect(call.signal.aborted).toBe(true);
    expect(call.toError(httpError(500, null))).toMatchObject({ code: 'aborted', retryable: false });

    const timed = startProviderCall('openai', 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(timed.signal.aborted).toBe(true);
    expect(timed.toError(new APIUserAbortError())).toMatchObject({
      code: 'timeout',
      retryable: true,
      message: 'openai: request timed out after 1ms',
    });
  });
});
