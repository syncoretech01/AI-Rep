import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { z } from 'zod';
import { ProviderError } from '@/server/ai/types';
import { DomainError } from '@/server/domain/types';
import { UsageLimitError } from '@/server/domain/usage/limits';
import { VoiceLimitError } from '@/server/domain/voice/sessions';
import type { Logger } from '@/server/observability/logger';
import type { VoiceSessionManager } from './manager';
import { VOICE_SESSION_PATH, type GatewayErrorCode } from './protocol';

/**
 * The voice gateway's internal HTTP API. Only the Next.js app calls it (with the shared VOICE_GATEWAY_SECRET); it is
 * bound to a private interface. Audio never passes through it: it carries only the WebRTC offer/answer (signaling)
 * and session control.
 *
 *   GET  /health                          liveness + live session count
 *   POST /v1/voice-sessions               { organizationId, agentId, startedBy, sdp } -> { voiceSessionId, sdp, ... }
 *   POST /v1/voice-sessions/:id/end       { organizationId } -> { ended }
 */

const MAX_BODY_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const startSchema = z.object({
  organizationId: z.string().regex(UUID),
  agentId: z.string().regex(UUID),
  startedBy: z.string().regex(UUID).nullable(),
  sdp: z.string().min(1).max(32_000),
});

const endSchema = z.object({ organizationId: z.string().regex(UUID) });

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: GatewayErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time bearer check (digests have equal length whatever the input). */
export function isAuthorized(header: string | undefined, secret: string): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? '');
  return match?.[1] !== undefined && timingSafeEqual(digest(match[1]), digest(secret));
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'invalid_request', 'The request is too large.');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'invalid_request', 'The request body is not valid JSON.');
  }
}

function send(response: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

/** Maps a failure to an HTTP status and a code the app can act on; internals stay in the logs. */
function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof VoiceLimitError) return new HttpError(409, 'voice_limit', error.message);
  if (error instanceof UsageLimitError) return new HttpError(429, 'spend_limit', 'The AI usage limit has been reached.');
  if (error instanceof DomainError) {
    if (error.code === 'not_found') return new HttpError(404, 'not_found', error.message);
    if (error.code === 'invalid') return new HttpError(400, 'invalid_request', error.message);
  }
  if (error instanceof ProviderError) return new HttpError(502, 'provider_unavailable', 'The voice provider is unavailable.');
  return new HttpError(500, 'internal', 'Something went wrong.');
}

export function createGatewayServer(deps: { manager: VoiceSessionManager; secret: string; logger: Logger }): http.Server {
  const { manager, secret, logger } = deps;

  async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://gateway.internal');
    if (request.method === 'GET' && url.pathname === '/health') {
      send(response, 200, { ok: true, sessions: manager.activeSessions() });
      return;
    }
    if (!isAuthorized(request.headers.authorization, secret)) throw new HttpError(401, 'unauthorized', 'Unauthorized.');
    if (request.method !== 'POST') throw new HttpError(405, 'invalid_request', 'Method not allowed.');

    if (url.pathname === VOICE_SESSION_PATH) {
      const parsed = startSchema.safeParse(await readJson(request));
      if (!parsed.success) throw new HttpError(400, 'invalid_request', 'Invalid voice session request.');
      const started = await manager.start({
        organizationId: parsed.data.organizationId,
        agentId: parsed.data.agentId,
        startedBy: parsed.data.startedBy,
        sdpOffer: parsed.data.sdp,
      });
      send(response, 201, {
        voiceSessionId: started.voiceSessionId,
        conversationId: started.conversationId,
        sdp: started.sdpAnswer,
        maxDurationSeconds: started.maxDurationSeconds,
        delegation: started.delegation,
      });
      return;
    }
    const endMatch = new RegExp(`^${VOICE_SESSION_PATH}/([0-9a-f-]{36})/end$`, 'i').exec(url.pathname);
    if (endMatch?.[1]) {
      const parsed = endSchema.safeParse(await readJson(request));
      if (!parsed.success) throw new HttpError(400, 'invalid_request', 'Invalid end request.');
      send(response, 200, { ended: await manager.end(parsed.data.organizationId, endMatch[1]) });
      return;
    }
    throw new HttpError(404, 'not_found', 'Not found.');
  }

  return http.createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      const failure = toHttpError(error);
      if (failure.status >= 500) logger.error('voice.gateway.request_failed', { path: request.url, error });
      if (!response.headersSent) send(response, failure.status, { error: { code: failure.code, message: failure.message } });
      else response.end();
    });
  });
}
