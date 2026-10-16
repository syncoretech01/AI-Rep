import type { z } from 'zod';
import type { Logger } from '@/server/observability/logger';
import { SSE_CONTENT_TYPE, type ApiError } from '@/shared/widget-protocol';
import { WebChatError } from './service';

/** Small helpers shared by the public widget API route handlers. */

export const SSE_HEADERS: Record<string, string> = {
  'content-type': SSE_CONTENT_TYPE,
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  // Tells nginx-style proxies not to buffer the stream.
  'x-accel-buffering': 'no',
};

const DEFAULT_MAX_BODY_BYTES = 16 * 1024;
const MAX_ERROR_MESSAGE_CHARS = 200;
const INTERNAL_MESSAGE = 'Something went wrong. Please try again.';

function isJsonContentType(value: string | null): boolean {
  return value?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

/** Reads the raw body, never buffering more than `maxBytes` (a chunked body has no Content-Length to check). */
async function readBodyText(request: Request, maxBytes: number): Promise<string> {
  const tooLarge = () => new WebChatError('invalid_request', 413, 'The request is too large.');
  if (Number(request.headers.get('content-length')) > maxBytes) throw tooLarge();
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof WebChatError) throw error;
    throw new WebChatError('invalid_request', 400, 'The request body could not be read.');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new WebChatError('invalid_request', 400, 'The request body is not valid UTF-8.');
  }
}

/** "message is too long" -> "Message is too long." (schema messages never contain secrets). */
function describeIssue(error: z.ZodError): string {
  const message = error.issues[0]?.message.trim().slice(0, MAX_ERROR_MESSAGE_CHARS) ?? '';
  if (message === '') return 'The request is invalid.';
  const sentence = `${message.charAt(0).toUpperCase()}${message.slice(1)}`;
  return sentence.endsWith('.') ? sentence : `${sentence}.`;
}

/**
 * Parses an `application/json` request body (at most `maxBytes`) and validates it.
 * Every failure is a `WebChatError` with code 'invalid_request'.
 */
export async function readJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<T> {
  // JSON-only also keeps cross-site HTML forms (which cannot send application/json) out.
  if (!isJsonContentType(request.headers.get('content-type'))) {
    throw new WebChatError('invalid_request', 415, 'Send the request as JSON.');
  }
  const text = await readBodyText(request, maxBytes);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new WebChatError('invalid_request', 400, 'The request body is not valid JSON.');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new WebChatError('invalid_request', 400, describeIssue(parsed.error));
  return parsed.data;
}

export function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('cache-control', 'no-store');
  return Response.json(body, { status, headers: responseHeaders });
}

/** `WebChatError` -> its status and an ApiError body; anything else is logged and becomes a generic 500. */
export function errorResponse(error: unknown, logger: Logger): Response {
  if (error instanceof WebChatError) {
    const body: ApiError = { error: { code: error.code, message: error.message } };
    const headers =
      error.retryAfterSeconds === undefined ? undefined : { 'retry-after': String(error.retryAfterSeconds) };
    return jsonResponse(body, error.status, headers);
  }
  logger.error('webchat.request_failed', { error });
  const body: ApiError = { error: { code: 'internal', message: INTERNAL_MESSAGE } };
  return jsonResponse(body, 500);
}

/** The public host the request was sent to: `x-forwarded-host` (first entry) set by the proxy, else `host`. */
function requestHost(headers: Headers): string | null {
  const host = headers.get('x-forwarded-host')?.split(',', 1)[0]?.trim() || headers.get('host')?.trim();
  return host ? host.toLowerCase() : null;
}

function originHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null; // e.g. "null" from sandboxed frames
  }
}

/**
 * The widget iframe is served by this app, so its API calls are same-origin. A request whose
 * `Origin` names another host is rejected with 403 — the check Next.js applies to Server
 * Actions. Never compared against `request.url`, which can be an internal URL behind a proxy.
 * Requests without `Origin` (non-browser clients) pass: they carry no ambient credentials.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (origin === null) return;
  const expected = requestHost(request.headers);
  if (expected === null || originHost(origin) !== expected) {
    throw new WebChatError('invalid_request', 403, 'Cross-origin requests are not allowed.');
  }
}
