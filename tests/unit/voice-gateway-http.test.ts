import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProviderError } from '@/server/ai/types';
import { VoiceGatewayError, endGatewaySession, startGatewaySession } from '@/server/channels/voice/gateway-client';
import { createGatewayServer, isAuthorized } from '@/server/channels/voice/gateway-http';
import type { StartVoiceSessionInput, StartedVoiceSession, VoiceSessionManager } from '@/server/channels/voice/manager';
import { DomainError } from '@/server/domain/types';
import { UsageLimitError } from '@/server/domain/usage/limits';
import { VoiceLimitError } from '@/server/domain/voice/sessions';
import { silentLogger } from '@/server/observability/logger';

/** The voice gateway's internal signaling API and the app's client for it, over a real HTTP server on localhost. */

const SECRET = 'test-gateway-secret-0123456789abcdef';
const ORG = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';

class FakeManager implements VoiceSessionManager {
  starts: StartVoiceSessionInput[] = [];
  ends: Array<{ organizationId: string; voiceSessionId: string }> = [];
  failWith: unknown = null;

  start(input: StartVoiceSessionInput): Promise<StartedVoiceSession> {
    this.starts.push(input);
    if (this.failWith) return Promise.reject(this.failWith instanceof Error ? this.failWith : new Error('failure'));
    return Promise.resolve({ voiceSessionId: SESSION, conversationId: 'conv-1', sdpAnswer: 'v=0 answer', maxDurationSeconds: 600, delegation: 'responses' });
  }

  end(organizationId: string, voiceSessionId: string): Promise<boolean> {
    this.ends.push({ organizationId, voiceSessionId });
    return Promise.resolve(organizationId === ORG);
  }

  activeSessions(): number {
    return 1;
  }

  recoverStaleSessions(): Promise<number> {
    return Promise.resolve(0);
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

let manager: FakeManager;
let server: http.Server;
let base: string;

beforeAll(async () => {
  manager = new FakeManager();
  server = createGatewayServer({ manager, secret: SECRET, logger: silentLogger });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  manager.starts = [];
  manager.ends = [];
  manager.failWith = null;
});

const gateway = () => ({ url: base, port: 0, secret: SECRET });
const startBody = { organizationId: ORG, agentId: AGENT, startedBy: null, sdp: 'v=0 offer' };

async function post(path: string, body: unknown, authorization: string | null = `Bearer ${SECRET}`) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization && { authorization }) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('isAuthorized', () => {
  it('accepts only the exact bearer secret', () => {
    expect(isAuthorized(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(isAuthorized(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(isAuthorized(SECRET, SECRET)).toBe(false);
    expect(isAuthorized('Bearer ', SECRET)).toBe(false);
    expect(isAuthorized(undefined, SECRET)).toBe(false);
  });
});

describe('gateway HTTP API', () => {
  it('reports health without credentials but nothing else', async () => {
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, sessions: 1 });

    expect(await post('/v1/voice-sessions', startBody, null)).toMatchObject({ status: 401, body: { error: { code: 'unauthorized' } } });
    expect(await post('/v1/voice-sessions', startBody, 'Bearer wrong')).toMatchObject({ status: 401 });
    expect(manager.starts).toEqual([]);
  });

  it('starts a session from a valid offer and returns only signaling data', async () => {
    const result = await post('/v1/voice-sessions', startBody);
    expect(result).toEqual({
      status: 201,
      body: { voiceSessionId: SESSION, conversationId: 'conv-1', sdp: 'v=0 answer', maxDurationSeconds: 600, delegation: 'responses' },
    });
    expect(manager.starts).toEqual([{ organizationId: ORG, agentId: AGENT, startedBy: null, sdpOffer: 'v=0 offer' }]);
  });

  it('refuses malformed, oversized and unknown requests', async () => {
    expect(await post('/v1/voice-sessions', { ...startBody, organizationId: 'org' })).toMatchObject({ status: 400 });
    expect(await post('/v1/voice-sessions', '{not json')).toMatchObject({ status: 400 });
    expect(await post('/v1/voice-sessions', { ...startBody, sdp: 'x'.repeat(70_000) })).toMatchObject({ status: 413 });
    expect(await post('/v1/other', {})).toMatchObject({ status: 404 });
    const get = await fetch(`${base}/v1/voice-sessions`, { headers: { authorization: `Bearer ${SECRET}` } });
    expect(get.status).toBe(405);
    expect(manager.starts).toEqual([]);
  });

  it.each([
    [new VoiceLimitError(), 409, 'voice_limit'],
    [new UsageLimitError('daily_spend'), 429, 'spend_limit'],
    [new DomainError('not_found', 'Agent not found or not active.'), 404, 'not_found'],
    [new ProviderError({ provider: 'openai', code: 'unavailable', retryable: true, message: 'secret upstream detail' }), 502, 'provider_unavailable'],
    [new Error('db password in message'), 500, 'internal'],
  ])('maps %s to %i %s without leaking internals', async (error, status, code) => {
    manager.failWith = error;
    const result = await post('/v1/voice-sessions', startBody);
    expect(result).toMatchObject({ status, body: { error: { code } } });
    expect(JSON.stringify(result.body)).not.toMatch(/secret upstream|password/);
  });

  it("ends a session only within the caller's organization", async () => {
    expect(await post(`/v1/voice-sessions/${SESSION}/end`, { organizationId: ORG })).toEqual({ status: 200, body: { ended: true } });
    const other = '44444444-4444-4444-8444-444444444444';
    expect(await post(`/v1/voice-sessions/${SESSION}/end`, { organizationId: other })).toEqual({ status: 200, body: { ended: false } });
    expect(manager.ends).toEqual([
      { organizationId: ORG, voiceSessionId: SESSION },
      { organizationId: other, voiceSessionId: SESSION },
    ]);
  });
});

describe('gateway client', () => {
  it('round-trips start and end with the shared secret', async () => {
    await expect(startGatewaySession(gateway(), startBody)).resolves.toMatchObject({ voiceSessionId: SESSION, sdp: 'v=0 answer' });
    await expect(endGatewaySession(gateway(), { organizationId: ORG, voiceSessionId: SESSION })).resolves.toBe(true);
  });

  it('carries the gateway error code and status to the app', async () => {
    manager.failWith = new VoiceLimitError();
    await expect(startGatewaySession(gateway(), startBody)).rejects.toMatchObject({ status: 409, code: 'voice_limit' });
  });

  it('refuses a malformed gateway response', async () => {
    const malformed = () => Promise.resolve(new Response(JSON.stringify({ voiceSessionId: SESSION }), { status: 201 }));
    await expect(startGatewaySession(gateway(), startBody, malformed)).rejects.toMatchObject({ status: 502 });
  });

  it('fails clearly when the gateway is not configured or not reachable', async () => {
    await expect(startGatewaySession({ ...gateway(), secret: undefined }, startBody)).rejects.toMatchObject({ code: 'gateway_unavailable' });
    const unreachable = () => Promise.reject(new TypeError('fetch failed'));
    const error: unknown = await startGatewaySession(gateway(), startBody, unreachable).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(VoiceGatewayError);
    expect(error).toMatchObject({ status: 503, code: 'gateway_unavailable' });
  });
});
