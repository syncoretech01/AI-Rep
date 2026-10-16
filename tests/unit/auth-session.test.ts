import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  class RedirectSignal extends Error {
    readonly url: string;
    constructor(url: string) {
      super(`NEXT_REDIRECT ${url}`);
      this.url = url;
    }
  }
  type ClaimsResult = { data: { claims: Record<string, unknown> } | null; error: { message: string } | null };
  const state: { claims: ClaimsResult } = { claims: { data: null, error: null } };
  const auth = {
    // Verifies the access token: the only identity the server may trust.
    getClaims: vi.fn(async () => state.claims),
    // Only decodes the cookie, so a forged cookie still yields a plausible session like this one.
    getSession: vi.fn(async () => ({
      data: {
        session: {
          access_token: 'forged',
          user: { id: '6d0f3a52-1a8e-4c35-9f5b-7a1d2c3e4f50', email: 'mallory@example.test', is_anonymous: false },
        },
      },
      error: null,
    })),
  };
  return { RedirectSignal, state, auth };
});

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new hoisted.RedirectSignal(url);
  },
}));
vi.mock('@/server/auth/supabase', () => ({ createServerAuthClient: async () => hoisted.auth }));

import { getAuthUser, requireUser } from '@/server/auth/session';

const USER_ID = '0b6c3c52-3f43-4a8e-9a39-2f1f3c1d5e7a';

function verifiedClaims(claims: Record<string, unknown>): void {
  hoisted.state.claims = { data: { claims }, error: null };
}

async function redirectOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof hoisted.RedirectSignal) return error.url;
    throw error;
  }
  throw new Error('expected a redirect');
}

beforeEach(() => {
  hoisted.state.claims = { data: null, error: null };
  vi.clearAllMocks();
});

describe('getAuthUser', () => {
  it('trusts only verified claims, never the decoded cookie session', async () => {
    // No verifiable token, while the cookie still decodes to a session.
    expect(await getAuthUser()).toBeNull();
    expect(hoisted.auth.getClaims).toHaveBeenCalledOnce();
    expect(hoisted.auth.getSession).not.toHaveBeenCalled();
  });

  it('is signed out when verification fails', async () => {
    hoisted.state.claims = { data: null, error: { message: 'invalid JWT: unable to verify signature' } };
    expect(await getAuthUser()).toBeNull();
  });

  it('returns the verified subject and email', async () => {
    verifiedClaims({ sub: USER_ID, email: 'jo@example.test', role: 'authenticated', is_anonymous: false });
    expect(await getAuthUser()).toEqual({ id: USER_ID, email: 'jo@example.test' });
    expect(hoisted.auth.getSession).not.toHaveBeenCalled();
  });

  it.each([[''], [undefined]])('maps the email %j to null', async (email) => {
    verifiedClaims({ sub: USER_ID, email, role: 'authenticated' });
    expect(await getAuthUser()).toEqual({ id: USER_ID, email: null });
  });

  it('gives anonymous sessions no admin identity', async () => {
    verifiedClaims({ sub: USER_ID, email: '', role: 'authenticated', is_anonymous: true });
    expect(await getAuthUser()).toBeNull();
  });

  // userScope turns the subject into the RLS `sub` claim, which must be a user id.
  it.each([['not-a-uuid'], [''], [`${USER_ID}x`], [undefined]])('rejects the subject %j', async (sub) => {
    verifiedClaims({ sub, email: 'jo@example.test', role: 'authenticated' });
    expect(await getAuthUser()).toBeNull();
  });
});

describe('requireUser', () => {
  it('sends signed-out and anonymous visitors to /login', async () => {
    expect(await redirectOf(requireUser())).toBe('/login');
    verifiedClaims({ sub: USER_ID, role: 'authenticated', is_anonymous: true });
    expect(await redirectOf(requireUser())).toBe('/login');
    expect(hoisted.auth.getSession).not.toHaveBeenCalled();
  });

  it('returns the signed-in user', async () => {
    verifiedClaims({ sub: USER_ID, email: 'jo@example.test', role: 'authenticated' });
    await expect(requireUser()).resolves.toEqual({ id: USER_ID, email: 'jo@example.test' });
  });
});
