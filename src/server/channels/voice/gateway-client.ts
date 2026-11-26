import { z } from 'zod';
import type { VoiceConfig } from '@/server/config/env';
import { VOICE_SESSION_PATH, type GatewayErrorCode } from './protocol';

/** How the Next.js app talks to the voice gateway (server to server, shared secret). */

export class VoiceGatewayError extends Error {
  readonly status: number;
  readonly code: GatewayErrorCode | 'gateway_unavailable';

  constructor(status: number, code: GatewayErrorCode | 'gateway_unavailable', message: string) {
    super(message);
    this.name = 'VoiceGatewayError';
    this.status = status;
    this.code = code;
  }
}

const startResultSchema = z.object({
  voiceSessionId: z.string().min(1),
  conversationId: z.string().min(1),
  sdp: z.string().min(1),
  maxDurationSeconds: z.number().int().positive(),
  delegation: z.enum(['responses', 'client']),
});
const endResultSchema = z.object({ ended: z.boolean() });

export type GatewayStartResult = z.infer<typeof startResultSchema>;

const REQUEST_TIMEOUT_MS = 20_000;

async function call<T>(
  config: VoiceConfig['gateway'],
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
  fetchImpl: typeof fetch,
): Promise<T> {
  if (!config.secret) throw new VoiceGatewayError(503, 'gateway_unavailable', 'VOICE_GATEWAY_SECRET is not configured.');
  let response: Response;
  try {
    response = await fetchImpl(new URL(path, config.url), {
      method: 'POST',
      headers: { authorization: `Bearer ${config.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch {
    throw new VoiceGatewayError(503, 'gateway_unavailable', 'The voice gateway is not reachable.');
  }
  const payload = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (!response.ok) {
    const code = (payload?.error?.code ?? 'internal') as GatewayErrorCode;
    throw new VoiceGatewayError(response.status, code, payload?.error?.message ?? 'The voice gateway refused the request.');
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new VoiceGatewayError(502, 'internal', 'The voice gateway returned an unexpected response.');
  return parsed.data;
}

export function startGatewaySession(
  config: VoiceConfig['gateway'],
  body: { organizationId: string; agentId: string; startedBy: string | null; sdp: string },
  fetchImpl: typeof fetch = fetch,
): Promise<GatewayStartResult> {
  return call(config, VOICE_SESSION_PATH, body, startResultSchema, fetchImpl);
}

export async function endGatewaySession(
  config: VoiceConfig['gateway'],
  body: { organizationId: string; voiceSessionId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const result = await call(
    config,
    `${VOICE_SESSION_PATH}/${body.voiceSessionId}/end`,
    { organizationId: body.organizationId },
    endResultSchema,
    fetchImpl,
  );
  return result.ended;
}
