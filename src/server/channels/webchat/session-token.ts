import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { isUuid } from '@/server/db/sql';
import { MAX_SESSION_TOKEN_CHARS } from '@/shared/widget-protocol';

/**
 * Signed, stateless web chat visitor session. The browser stores only this
 * opaque token: `base64url(JSON claims) + '.' + base64url(HMAC-SHA256)`. It
 * binds an anonymous visitor id to ONE agent; the organization is never in the
 * token (it is resolved from the widget key on every request).
 */

export interface WidgetSessionClaims {
  v: 1;
  agentId: string;
  visitorId: string;
  /** Issued at (seconds since the epoch). */
  iat: number;
  /** Expires at (seconds since the epoch). */
  exp: number;
}

/** Domain separation: these signatures can never be confused with any other HMAC made with the same secret. */
const SIGNING_CONTEXT = 'syncore.widget.v1.';
/** Tolerated clock skew between server instances for `iat`. */
const MAX_FUTURE_IAT_SECONDS = 60;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const claimsSchema = z
  .strictObject({
    v: z.literal(1),
    agentId: z.uuid(),
    visitorId: z.uuid(),
    iat: z.int().nonnegative(),
    exp: z.int().positive(),
  })
  .refine((claims) => claims.exp > claims.iat);

function signature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`${SIGNING_CONTEXT}${payload}`).digest('base64url');
}

function epochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

export function signWidgetSession(
  subject: { agentId: string; visitorId: string },
  options: { secret: string; ttlSeconds: number; now: Date },
): string {
  if (!options.secret) throw new Error('A widget session secret is required');
  if (!isUuid(subject.agentId) || !isUuid(subject.visitorId)) throw new Error('Widget session ids must be UUIDs');
  if (!Number.isSafeInteger(options.ttlSeconds) || options.ttlSeconds <= 0) {
    throw new RangeError('ttlSeconds must be a positive integer');
  }
  const iat = epochSeconds(options.now);
  const claims: WidgetSessionClaims = {
    v: 1,
    agentId: subject.agentId,
    visitorId: subject.visitorId,
    iat,
    exp: iat + options.ttlSeconds,
  };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${payload}.${signature(payload, options.secret)}`;
}

/** The claims of a genuine, unexpired token; null for anything else. Never throws. */
export function verifyWidgetSession(token: string, options: { secret: string; now: Date }): WidgetSessionClaims | null {
  try {
    if (!options.secret || token.length === 0 || token.length > MAX_SESSION_TOKEN_CHARS) return null;
    const dot = token.indexOf('.');
    if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
    const payload = token.slice(0, dot);
    const given = token.slice(dot + 1);
    if (!BASE64URL.test(payload) || !BASE64URL.test(given)) return null;

    // Comparing the canonical encodings (not decoded bytes) also rejects alternative spellings of a valid signature.
    const expected = Buffer.from(signature(payload, options.secret), 'utf8');
    const actual = Buffer.from(given, 'utf8');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

    const json: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const parsed = claimsSchema.safeParse(json);
    if (!parsed.success) return null;
    const now = epochSeconds(options.now);
    if (parsed.data.exp <= now || parsed.data.iat > now + MAX_FUTURE_IAT_SECONDS) return null;
    return parsed.data;
  } catch {
    return null;
  }
}
