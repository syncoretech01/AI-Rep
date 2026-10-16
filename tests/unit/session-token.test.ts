import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signWidgetSession, verifyWidgetSession } from '@/server/channels/webchat/session-token';
import { MAX_SESSION_TOKEN_CHARS } from '@/shared/widget-protocol';

const SECRET = 'unit-test-widget-session-secret-0123456789';
const NOW = new Date('2026-10-08T12:00:00.000Z');
const NOW_SECONDS = NOW.getTime() / 1000;
const TTL = 3600;
const AGENT = '7d1f6a52-3c0e-4b8a-9f51-2a6c4e8b0d13';
const VISITOR = 'c2b4e6f8-0a1c-4e3d-8b5f-7a9c1e3d5f70';

const at = (offsetSeconds: number) => new Date(NOW.getTime() + offsetSeconds * 1000);
const sign = (now: Date = NOW, subject = { agentId: AGENT, visitorId: VISITOR }) =>
  signWidgetSession(subject, { secret: SECRET, ttlSeconds: TTL, now });
const verify = (token: string, now: Date = NOW, secret = SECRET) => verifyWidgetSession(token, { secret, now });

/** A token in the documented format with an arbitrary payload, signed with `secret`. */
function forge(payload: unknown, secret = SECRET): string {
  const part = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(`syncore.widget.v1.${part}`).digest('base64url');
  return `${part}.${signature}`;
}

const validClaims = { v: 1, agentId: AGENT, visitorId: VISITOR, iat: NOW_SECONDS, exp: NOW_SECONDS + TTL };

describe('signWidgetSession / verifyWidgetSession', () => {
  it('round-trips the claims of a fresh token', () => {
    const token = sign();
    expect(verify(token)).toEqual(validClaims);
    // Opaque to the browser but self-describing: base64url(JSON).base64url(HMAC-SHA256).
    const [payload, signature, ...rest] = token.split('.');
    expect(rest).toEqual([]);
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'))).toEqual(validClaims);
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).toBe(forge(validClaims));
  });

  it('rejects a tampered payload or signature', () => {
    const token = sign();
    const [payload, signature] = token.split('.') as [string, string];

    const otherVisitor = Buffer.from(JSON.stringify({ ...validClaims, visitorId: randomUUID() })).toString('base64url');
    expect(verify(`${otherVisitor}.${signature}`)).toBeNull();
    const longerLife = Buffer.from(JSON.stringify({ ...validClaims, exp: validClaims.exp + 86_400 })).toString('base64url');
    expect(verify(`${longerLife}.${signature}`)).toBeNull();

    const flipped = `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
    expect(verify(`${payload}.${flipped}`)).toBeNull();
    expect(verify(`${payload}.${signature.slice(0, -1)}`)).toBeNull();
    expect(verify(`${payload}.${signature}A`)).toBeNull();
    // A different spelling of the same signature bytes (unused trailing bits) is not accepted either.
    const last = signature.at(-1)!;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const sibling = alphabet[alphabet.indexOf(last) ^ 1]!;
    expect(Buffer.from(`${signature.slice(0, -1)}${sibling}`, 'base64url')).toEqual(Buffer.from(signature, 'base64url'));
    expect(verify(`${payload}.${signature.slice(0, -1)}${sibling}`)).toBeNull();
  });

  it('rejects a token signed with another secret', () => {
    expect(verify(sign(), NOW, 'another-widget-session-secret-0123456789')).toBeNull();
    expect(verify(forge(validClaims, 'another-widget-session-secret-0123456789'))).toBeNull();
    expect(verify(sign(), NOW, '')).toBeNull();
  });

  it('expires after the TTL', () => {
    const token = sign();
    expect(verify(token, at(TTL - 1))).not.toBeNull();
    expect(verify(token, at(TTL))).toBeNull();
    expect(verify(token, at(TTL + 86_400))).toBeNull();
  });

  it('tolerates a minute of clock skew but rejects tokens issued in the future', () => {
    expect(verify(sign(at(60)))).toEqual({ ...validClaims, iat: NOW_SECONDS + 60, exp: NOW_SECONDS + 60 + TTL });
    expect(verify(sign(at(61)))).toBeNull();
    expect(verify(forge({ ...validClaims, iat: NOW_SECONDS + 3600, exp: NOW_SECONDS + 7200 }))).toBeNull();
  });

  it('rejects malformed and oversized tokens without throwing', () => {
    const signature = sign().split('.')[1]!;
    const malformed = [
      '',
      'not-a-token',
      '.',
      `.${signature}`,
      `${sign().split('.')[0]!}.`,
      `${sign()}.extra`,
      'a.b.c',
      'pay load.sig nature',
      '%%%.%%%',
      `${'A'.repeat(MAX_SESSION_TOKEN_CHARS)}.${signature}`,
      `${sign()}${'A'.repeat(MAX_SESSION_TOKEN_CHARS)}`,
    ];
    for (const token of malformed) expect(verify(token)).toBeNull();
    expect(() => verifyWidgetSession(undefined as unknown as string, { secret: SECRET, now: NOW })).not.toThrow();
    expect(verifyWidgetSession(undefined as unknown as string, { secret: SECRET, now: NOW })).toBeNull();
  });

  it('rejects correctly signed payloads that are not valid claims', () => {
    const invalid: unknown[] = [
      'not json',
      '[]',
      'null',
      { ...validClaims, v: 2 },
      { ...validClaims, agentId: 'agent-1' },
      { ...validClaims, visitorId: '' },
      { ...validClaims, iat: NOW_SECONDS + 0.5 },
      { ...validClaims, exp: String(validClaims.exp) },
      { ...validClaims, exp: validClaims.iat },
      { ...validClaims, organizationId: randomUUID() },
      { v: 1, agentId: AGENT, visitorId: VISITOR, exp: validClaims.exp },
    ];
    for (const payload of invalid) expect(verify(forge(payload))).toBeNull();
    // The forging helper itself produces accepted tokens for valid claims.
    expect(verify(forge(validClaims))).toEqual(validClaims);
  });

  it('binds the visitor to one agent: the agent cannot be swapped without the secret', () => {
    const otherAgent = randomUUID();
    const token = sign();
    expect(verify(token)?.agentId).toBe(AGENT);
    expect(verify(sign(NOW, { agentId: otherAgent, visitorId: VISITOR }))).toMatchObject({ agentId: otherAgent, visitorId: VISITOR });

    const signature = token.split('.')[1]!;
    const rebound = Buffer.from(JSON.stringify({ ...validClaims, agentId: otherAgent })).toString('base64url');
    expect(verify(`${rebound}.${signature}`)).toBeNull();
  });

  it('refuses to sign invalid subjects or settings', () => {
    expect(() => signWidgetSession({ agentId: 'agent', visitorId: VISITOR }, { secret: SECRET, ttlSeconds: TTL, now: NOW })).toThrow();
    expect(() => signWidgetSession({ agentId: AGENT, visitorId: 'visitor' }, { secret: SECRET, ttlSeconds: TTL, now: NOW })).toThrow();
    expect(() => signWidgetSession({ agentId: AGENT, visitorId: VISITOR }, { secret: '', ttlSeconds: TTL, now: NOW })).toThrow();
    expect(() => signWidgetSession({ agentId: AGENT, visitorId: VISITOR }, { secret: SECRET, ttlSeconds: 0, now: NOW })).toThrow(RangeError);
    expect(() => signWidgetSession({ agentId: AGENT, visitorId: VISITOR }, { secret: SECRET, ttlSeconds: 1.5, now: NOW })).toThrow(RangeError);
  });
});
