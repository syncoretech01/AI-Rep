import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  class RedirectSignal extends Error {
    readonly url: string;
    constructor(url: string) {
      super(`NEXT_REDIRECT ${url}`);
      this.url = url;
    }
  }
  type Result = { data: Record<string, unknown> | null; error: { code?: string; status?: number; message: string } | null };
  const calls: Array<[string, unknown]> = [];
  const results: Record<string, Result> = {};
  const auth = new Proxy(
    {},
    {
      // Not a thenable: `await createServerAuthClient()` must resolve to the client itself.
      get: (_target, method: string) =>
        method === 'then'
          ? undefined
          : async (arg: unknown) => {
              calls.push([method, arg]);
              return results[method] ?? { data: {}, error: null };
            },
    },
  );
  const headers: Record<string, string> = { host: 'app.example.com', 'x-forwarded-proto': 'https' };
  return { RedirectSignal, calls, results, auth, headers };
});

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new hoisted.RedirectSignal(url);
  },
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers(hoisted.headers) }));
vi.mock('@/server/auth/supabase', () => ({ createServerAuthClient: async () => hoisted.auth }));

import { signIn, signOut, signUp } from '@/app/(auth)/actions';
import { GET as confirm } from '@/app/auth/confirm/route';
import AuthErrorPage from '@/app/auth/error/page';

const IDLE = { status: 'idle' } as const;

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
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
  hoisted.calls.length = 0;
  for (const key of Object.keys(hoisted.results)) Reflect.deleteProperty(hoisted.results, key);
});

describe('signIn', () => {
  it('validates the form without calling Supabase', async () => {
    expect(await signIn(IDLE, form({ email: 'nope', password: '' }))).toEqual({
      status: 'error',
      message: 'Please correct the highlighted fields.',
      fieldErrors: { email: ['Enter a valid email address.'], password: ['Enter your password.'] },
    });
    expect(hoisted.calls).toEqual([]);
  });

  it('signs in and continues to a safe next path only', async () => {
    expect(await redirectOf(signIn(IDLE, form({ email: ' Jo@Example.com ', password: 'short', next: '/o/acme/leads' })))).toBe(
      '/o/acme/leads',
    );
    expect(hoisted.calls).toEqual([['signInWithPassword', { email: 'Jo@Example.com', password: 'short' }]]);
    expect(await redirectOf(signIn(IDLE, form({ email: 'jo@example.com', password: 'x', next: 'https://evil.example' })))).toBe('/');
    expect(await redirectOf(signIn(IDLE, form({ email: 'jo@example.com', password: 'x', next: '//evil.example' })))).toBe('/');
    for (const next of ['/..//evil.example', '/%2e%2e//evil.example', '/o/../..//evil.example']) {
      expect(await redirectOf(signIn(IDLE, form({ email: 'jo@example.com', password: 'x', next })))).toBe('/');
    }
    expect(await redirectOf(signIn(IDLE, form({ email: 'jo@example.com', password: 'x', next: '/o/x/../acme' })))).toBe(
      '/o/acme',
    );
  });

  it.each([
    [{ code: 'invalid_credentials', status: 400 }, 'Invalid email or password.'],
    [{ code: 'user_not_found', status: 400 }, 'Invalid email or password.'],
    [{ code: 'email_not_confirmed', status: 400 }, 'Confirm your email address first: open the link we emailed you.'],
    [{ code: 'over_request_rate_limit', status: 429 }, 'Too many attempts. Please wait a few minutes and try again.'],
    [{ status: 0 }, 'Sign-in is temporarily unavailable. Please try again in a moment.'],
    [{ status: 503 }, 'Sign-in is temporarily unavailable. Please try again in a moment.'],
  ])('maps %j to a safe message', async (error, message) => {
    hoisted.results.signInWithPassword = { data: null, error: { ...error, message: 'internal detail' } };
    expect(await signIn(IDLE, form({ email: 'jo@example.com', password: 'whatever1' }))).toEqual({ status: 'error', message });
  });
});

describe('signUp', () => {
  it('requires 8+ character passwords', async () => {
    expect(await signUp(IDLE, form({ email: 'jo@example.com', password: 'short' }))).toMatchObject({
      fieldErrors: { password: ['Use at least 8 characters.'] },
    });
    expect(hoisted.calls).toEqual([]);
  });

  it('asks to check email when confirmation is required, with the confirm link on this origin', async () => {
    hoisted.results.signUp = { data: { user: {}, session: null }, error: null };
    expect(await redirectOf(signUp(IDLE, form({ email: 'jo@example.com', password: 'long enough', next: '/onboarding' })))).toBe(
      '/check-email',
    );
    expect(hoisted.calls[0]).toEqual([
      'signUp',
      {
        email: 'jo@example.com',
        password: 'long enough',
        options: { emailRedirectTo: 'https://app.example.com/auth/confirm?next=%2Fonboarding' },
      },
    ]);
    expect(await redirectOf(signUp(IDLE, form({ email: 'jo@example.com', password: 'long enough', next: '/o/acme' })))).toBe(
      '/check-email?next=%2Fo%2Facme',
    );
  });

  it('continues straight away when the project does not confirm emails', async () => {
    hoisted.results.signUp = { data: { user: {}, session: {} }, error: null };
    expect(await redirectOf(signUp(IDLE, form({ email: 'jo@example.com', password: 'long enough' })))).toBe('/onboarding');
  });

  it('omits the redirect URL when the origin is unknown', async () => {
    const saved = { ...hoisted.headers };
    delete hoisted.headers.host;
    try {
      hoisted.results.signUp = { data: { user: {}, session: null }, error: null };
      await redirectOf(signUp(IDLE, form({ email: 'jo@example.com', password: 'long enough' })));
      expect(hoisted.calls[0]?.[1]).toMatchObject({ options: undefined });
    } finally {
      Object.assign(hoisted.headers, saved);
    }
  });

  it('maps Supabase errors', async () => {
    hoisted.results.signUp = {
      data: null,
      error: { code: 'weak_password', status: 422, message: 'Password should contain at least one digit.' },
    };
    expect(await signUp(IDLE, form({ email: 'jo@example.com', password: 'long enough' }))).toEqual({
      status: 'error',
      message: 'Choose a stronger password.',
      fieldErrors: { password: ['Password should contain at least one digit.'] },
    });
    hoisted.results.signUp = { data: null, error: { code: 'user_already_exists', status: 422, message: 'x' } };
    expect(await signUp(IDLE, form({ email: 'jo@example.com', password: 'long enough' }))).toEqual({
      status: 'error',
      message: 'An account with this email already exists. Sign in instead.',
    });
    hoisted.results.signUp = { data: null, error: { status: 0, message: 'fetch failed' } };
    expect(await signUp(IDLE, form({ email: 'jo@example.com', password: 'long enough' }))).toEqual({
      status: 'error',
      message: 'We could not create your account. Please try again.',
    });
  });
});

describe('signOut', () => {
  it('ends this browser session and returns to /login', async () => {
    expect(await redirectOf(signOut())).toBe('/login');
    expect(hoisted.calls).toEqual([['signOut', { scope: 'local' }]]);
  });
});

describe('/auth/confirm', () => {
  const request = (query: string) => new NextRequest(`https://app.example.com/auth/confirm?${query}`);

  it('exchanges a PKCE code and continues to the safe next path', async () => {
    expect(await redirectOf(confirm(request('code=xyz')))).toBe('/');
    expect(hoisted.calls).toEqual([['exchangeCodeForSession', 'xyz']]);
    expect(await redirectOf(confirm(request('code=xyz&next=%2Fonboarding')))).toBe('/onboarding');
  });

  it('never signs a browser in from a token hash (login CSRF): only the browser that signed up can confirm', async () => {
    // A token-hash link verifies in any browser: someone could forward their own link and sign the victim's
    // browser into the attacker's account. Such links establish no session and verify nothing.
    for (const type of ['signup', 'email', 'magiclink', 'invite', 'recovery', 'email_change']) {
      expect(await redirectOf(confirm(request(`token_hash=abc&type=${type}&next=%2Fonboarding`)))).toBe('/auth/error');
    }
    expect(hoisted.calls).toEqual([]);
  });

  it('falls back to / for an unsafe next path', async () => {
    expect(await redirectOf(confirm(request('code=xyz&next=https%3A%2F%2Fevil.example')))).toBe('/');
    expect(await redirectOf(confirm(request('code=xyz&next=%2F%5Cevil.example')))).toBe('/');
    expect(await redirectOf(confirm(request('code=xyz&next=%2F..%2F%2Fevil.example')))).toBe('/');
    expect(await redirectOf(confirm(request('code=xyz&next=%2Fo%2Facme%2Fagents')))).toBe('/o/acme/agents');
  });

  it('sends failures and malformed links to /auth/error', async () => {
    // E.g. the link was opened in another browser (no code verifier there), or it was already used.
    hoisted.results.exchangeCodeForSession = {
      data: null,
      error: { code: 'bad_code_verifier', status: 400, message: 'code challenge does not match' },
    };
    expect(await redirectOf(confirm(request('code=xyz&next=%2Fonboarding')))).toBe('/auth/error');
    expect(await redirectOf(confirm(request('')))).toBe('/auth/error');
    expect(await redirectOf(confirm(request('code=')))).toBe('/auth/error');
    expect(await redirectOf(confirm(request(`code=${'x'.repeat(2000)}`)))).toBe('/auth/error');
    expect(hoisted.calls).toEqual([['exchangeCodeForSession', 'xyz']]);
  });

  it('explains on /auth/error that the address may already be confirmed', () => {
    // Supabase confirms the address before redirecting here, so a failed exchange usually still leaves a
    // confirmed account: the way forward is signing in with the password.
    const page = renderToStaticMarkup(AuthErrorPage());
    expect(page).toContain('Your email address may already be confirmed: try signing in with your password.');
    expect(page).toContain('only in the browser you signed up in');
    expect(page).toContain('href="/login"');
  });
});
