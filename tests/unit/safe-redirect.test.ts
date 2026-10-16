import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { config as proxyConfig } from '@/proxy';
import {
  firstSearchParam,
  loginRedirectPath,
  requestOrigin,
  requiresSignIn,
  safeNextPath,
  withNextParam,
} from '@/server/admin/redirects';
import { updateSession } from '@/server/auth/proxy-session';

type CookieWrite = { name: string; value: string; options: Record<string, unknown> };

// Supabase Auth stand-in for the proxy: a session (or none), optionally refreshed during getClaims().
const auth = vi.hoisted(() => ({ signedIn: false, refresh: false, cookieOptions: [] as unknown[] }));

vi.mock('@supabase/ssr', () => ({
  createServerClient: (
    _url: string,
    _key: string,
    options: { cookieOptions: unknown; cookies: { setAll: (cookies: CookieWrite[], headers: Record<string, string>) => void } },
  ) => {
    auth.cookieOptions.push(options.cookieOptions);
    return {
      auth: {
        getClaims: async () => {
          if (auth.refresh) {
            options.cookies.setAll([{ name: 'sb-test-auth-token', value: 'refreshed', options: { path: '/' } }], {
              'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0',
            });
          }
          return auth.signedIn ? { data: { claims: { sub: 'user' } }, error: null } : { data: null, error: null };
        },
      },
    };
  },
}));

describe('safeNextPath', () => {
  it.each(['/', '/o/x', '/o/acme/agents?tab=settings#web-chat', '/onboarding', '/o/caf%C3%A9', '/%2F%2Fevil.com'])(
    'allows the same-site path %j',
    (path) => {
      expect(safeNextPath(path)).toBe(path);
    },
  );

  it.each([
    ['an absolute URL', 'https://evil'],
    ['an absolute URL with a path', 'https://evil.example/o/x'],
    ['a protocol-relative URL', '//evil'],
    ['three slashes', '///evil.com'],
    ['a backslash after the slash', '/\\evil'],
    ['a backslash later in the path', '/o/\\\\evil'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
    ['a relative path', 'o/x'],
    ['a tab (dropped by browsers)', '/\t/evil.com'],
    ['a newline (dropped by browsers)', '/\n/evil.com'],
    ['a space', '/ /evil.com'],
    ['a NUL character', '/o/x\u0000'],
    ['a DEL character', '/o/x\u007f'],
    ['an empty string', ''],
    ['a very long value', `/${'a'.repeat(3000)}`],
  ])('rejects %s', (_label, value) => {
    expect(safeNextPath(value)).toBe('/');
    expect(safeNextPath(value, '/onboarding')).toBe('/onboarding');
  });

  it('falls back when the value is missing', () => {
    expect(safeNextPath(null)).toBe('/');
    expect(safeNextPath(undefined, '/onboarding')).toBe('/onboarding');
  });

  it.each(['/..//evil.com', '/.//evil.com', '/%2e%2e//evil.com', '/%2E%2E//evil.com', '/o/../..//evil.com', '/o/.%2e//evil.com'])(
    'rejects %j, whose dot segments resolve to a protocol-relative path',
    (value) => {
      // The Next.js router resolves a Server Action redirect to '/..//evil.com' into the href '//evil.com'
      // and then navigates to https://evil.com.
      expect(safeNextPath(value)).toBe('/');
    },
  );

  it('returns the normalized path that browsers and the router navigate to', () => {
    expect(safeNextPath('/o/acme/../other/leads?page=2#top')).toBe('/o/other/leads?page=2#top');
    expect(safeNextPath('/o/café')).toBe('/o/caf%C3%A9');
    expect(safeNextPath('/o/acme?')).toBe('/o/acme');
    expect(safeNextPath('/../../o/acme')).toBe('/o/acme');
  });
});

describe('withNextParam', () => {
  it('adds a non-default destination as an encoded query parameter', () => {
    expect(withNextParam('/signup', '/o/acme/agents?tab=1')).toBe('/signup?next=%2Fo%2Facme%2Fagents%3Ftab%3D1');
  });

  it('omits the default destination', () => {
    expect(withNextParam('/login', '/')).toBe('/login');
  });
});

describe('requiresSignIn', () => {
  it.each(['/o', '/o/acme', '/o/acme/agents/123', '/onboarding', '/onboarding/'])('protects %s', (path) => {
    expect(requiresSignIn(path)).toBe(true);
  });

  it.each(['/', '/login', '/signup', '/check-email', '/auth/confirm', '/auth/error', '/organizations', '/onboardingx'])(
    'leaves %s public',
    (path) => {
      expect(requiresSignIn(path)).toBe(false);
    },
  );
});

describe('loginRedirectPath', () => {
  it('returns to the requested page after signing in', () => {
    expect(loginRedirectPath('/o/acme/leads', '?page=2')).toBe('/login?next=%2Fo%2Facme%2Fleads%3Fpage%3D2');
    expect(loginRedirectPath('/onboarding', '')).toBe('/login?next=%2Fonboarding');
  });

  it('drops a destination that is not a safe path', () => {
    expect(loginRedirectPath('//evil.com', '')).toBe('/login');
  });
});

describe('firstSearchParam', () => {
  it('takes the first of repeated parameters', () => {
    expect(firstSearchParam(['/a', '/b'])).toBe('/a');
    expect(firstSearchParam('/a')).toBe('/a');
    expect(firstSearchParam(undefined)).toBeUndefined();
  });
});

describe('requestOrigin', () => {
  it('prefers the forwarded host and protocol set by the hosting proxy', () => {
    const headers = new Headers({
      host: 'internal:3000',
      'x-forwarded-host': 'App.Example.com',
      'x-forwarded-proto': 'https',
    });
    expect(requestOrigin(headers)).toBe('https://app.example.com');
  });

  it('uses the first value of comma-separated forwarded headers', () => {
    const headers = new Headers({ 'x-forwarded-host': 'app.example.com, proxy.local', 'x-forwarded-proto': 'http, https' });
    expect(requestOrigin(headers)).toBe('http://app.example.com');
  });

  it('falls back to the Host header, assuming https except for local development', () => {
    expect(requestOrigin(new Headers({ host: 'app.example.com' }))).toBe('https://app.example.com');
    expect(requestOrigin(new Headers({ host: 'localhost:3000' }))).toBe('http://localhost:3000');
    expect(requestOrigin(new Headers({ host: '127.0.0.1:3000' }))).toBe('http://127.0.0.1:3000');
    expect(requestOrigin(new Headers({ host: '[::1]:3000' }))).toBe('http://[::1]:3000');
  });

  it('ignores an unknown forwarded protocol', () => {
    expect(requestOrigin(new Headers({ host: 'app.example.com', 'x-forwarded-proto': 'javascript' }))).toBe(
      'https://app.example.com',
    );
  });

  it.each([
    ['no host', {}],
    ['an empty host', { host: '' }],
    ['a host with a path', { host: 'evil.com/path' }],
    ['a host with credentials', { host: 'user@evil.com' }],
    ['a host with a scheme', { 'x-forwarded-host': 'https://evil.com' }],
    ['an oversized host', { host: `${'a'.repeat(300)}.com` }],
  ])('returns null for %s', (_label, init: Record<string, string>) => {
    expect(requestOrigin(new Headers(init))).toBeNull();
  });
});

describe('proxy session refresh and login redirect', () => {
  const request = (path: string, method = 'GET') => new NextRequest(`https://app.example.com${path}`, { method });

  beforeEach(() => {
    auth.signedIn = false;
    auth.refresh = false;
    auth.cookieOptions.length = 0;
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
  });

  it('sends signed-out page requests for protected pages to /login, keeping the destination', async () => {
    const response = await updateSession(request('/o/acme/leads?page=2'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://app.example.com/login?next=%2Fo%2Facme%2Fleads%3Fpage%3D2');
    const head = await updateSession(request('/onboarding', 'HEAD'));
    expect(head.headers.get('location')).toBe('https://app.example.com/login?next=%2Fonboarding');
  });

  it('lets Server Action posts through: the action answers a signed-out user itself', async () => {
    // A redirect would make the browser replay the POST against /login and the router throw on the response.
    const response = await updateSession(request('/o/acme/agents', 'POST'));
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('leaves public pages and signed-in users alone', async () => {
    for (const path of ['/', '/login', '/auth/confirm?code=x']) {
      expect((await updateSession(request(path))).headers.get('location')).toBeNull();
    }
    auth.signedIn = true;
    expect((await updateSession(request('/o/acme'))).headers.get('location')).toBeNull();
  });

  it('writes refreshed session cookies (httpOnly) with no-cache headers, also on the login redirect', async () => {
    auth.signedIn = true;
    auth.refresh = true;
    const response = await updateSession(request('/o/acme'));
    expect(response.cookies.get('sb-test-auth-token')?.value).toBe('refreshed');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(auth.cookieOptions[0]).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });

    auth.signedIn = false;
    const redirect = await updateSession(request('/o/acme'));
    expect(redirect.status).toBe(307);
    expect(redirect.cookies.get('sb-test-auth-token')?.value).toBe('refreshed');
    expect(redirect.headers.get('cache-control')).toContain('no-store');
  });

  it('runs on admin routes but never on static assets or the public widget surface', () => {
    const [source] = proxyConfig.matcher;
    const matcher = new RegExp(`^${source ?? ''}$`);
    for (const path of ['/', '/login', '/o/acme', '/o/acme/agents/1', '/onboarding', '/auth/confirm', '/widgets']) {
      expect(matcher.test(path), path).toBe(true);
    }
    const skipped = [
      '/embed.js',
      '/widget/wk_abc',
      '/widget',
      '/api/widget/session',
      '/api/widget/messages',
      '/_next/static/app.js',
      '/_next/image',
      '/favicon.ico',
      '/logo.png',
    ];
    for (const path of skipped) expect(matcher.test(path), path).toBe(false);
  });
});
