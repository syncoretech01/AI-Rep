import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type SetAll = (cookies: Array<{ name: string; value: string; options: Record<string, unknown> }>, headers: Record<string, string>) => void;

const hoisted = vi.hoisted(() => ({
  signedIn: false,
  refresh: false,
  options: [] as Array<Record<string, unknown>>,
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: (_url: string, _key: string, options: { cookies: { setAll: SetAll }; cookieOptions: Record<string, unknown> }) => {
    hoisted.options.push(options.cookieOptions);
    return {
      auth: {
        getClaims: async () => {
          if (hoisted.refresh) {
            options.cookies.setAll(
              [{ name: 'sb-test-auth-token', value: 'fresh', options: { path: '/', httpOnly: true } }],
              { 'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0', Expires: '0', Pragma: 'no-cache' },
            );
          }
          return hoisted.signedIn ? { data: { claims: { sub: 'u' } }, error: null } : { data: null, error: null };
        },
      },
    };
  },
}));

import { updateSession } from '@/server/auth/proxy-session';
import { proxy, config } from '@/proxy';

beforeEach(() => {
  hoisted.signedIn = false;
  hoisted.refresh = false;
  hoisted.options.length = 0;
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
});

const req = (path: string, method = 'GET') => new NextRequest(`https://app.example.com${path}`, { method });

describe('updateSession', () => {
  it('sends signed-out page requests for protected pages to /login with the destination', async () => {
    const res = await updateSession(req('/o/acme/leads?page=2'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://app.example.com/login?next=%2Fo%2Facme%2Fleads%3Fpage%3D2');
    const onboarding = await updateSession(req('/onboarding', 'HEAD'));
    expect(onboarding.headers.get('location')).toBe('https://app.example.com/login?next=%2Fonboarding');
  });

  it('lets Server Action posts through so the action answers itself', async () => {
    const res = await updateSession(req('/o/acme/agents', 'POST'));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('leaves public pages and signed-in users alone', async () => {
    expect((await updateSession(req('/login'))).headers.get('location')).toBeNull();
    expect((await updateSession(req('/'))).headers.get('location')).toBeNull();
    hoisted.signedIn = true;
    expect((await updateSession(req('/o/acme'))).headers.get('location')).toBeNull();
  });

  it('writes refreshed cookies (httpOnly options) and no-cache headers to the response', async () => {
    hoisted.signedIn = true;
    hoisted.refresh = true;
    const res = await updateSession(req('/o/acme'));
    expect(res.cookies.get('sb-test-auth-token')?.value).toBe('fresh');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(hoisted.options[0]).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
  });

  it('keeps cleared cookies and no-cache headers on the login redirect', async () => {
    hoisted.refresh = true;
    const res = await updateSession(req('/o/acme'));
    expect(res.status).toBe(307);
    expect(res.cookies.get('sb-test-auth-token')?.value).toBe('fresh');
    expect(res.headers.get('cache-control')).toContain('no-store');
  });
});

describe('proxy', () => {
  it('delegates to updateSession', async () => {
    const res = await proxy(req('/o/acme'));
    expect(res.status).toBe(307);
  });

  it('matcher excludes static assets and the public widget surface', async () => {
    // The same compiler Next uses for `config.matcher` (typed in tests/support/next-internals.d.ts).
    const { pathToRegexp } = await import('next/dist/compiled/path-to-regexp/index.js');
    const [source] = config.matcher;
    const re = pathToRegexp(source!, [], { delimiter: '/', sensitive: false, strict: true });
    const proxied = ['/', '/login', '/o/acme', '/o/acme/agents/1', '/onboarding', '/auth/confirm', '/widgets', '/api/other'];
    const skipped = ['/embed.js', '/widget/wk_abc', '/widget', '/api/widget/session', '/api/widget/messages', '/_next/static/x.js', '/_next/image', '/favicon.ico', '/logo.png'];
    for (const path of proxied) expect(re.test(path), path).toBe(true);
    for (const path of skipped) expect(re.test(path), path).toBe(false);
  });
});
