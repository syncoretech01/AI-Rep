import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { loginRedirectPath, requiresSignIn } from '@/server/admin/redirects';
import { loadSupabaseConfig } from '@/server/config/env';
import { AUTH_COOKIE_OPTIONS } from './supabase';

/**
 * Runs in the proxy for every admin request: refreshes an expiring Supabase session (Server Components
 * cannot write cookies) and sends anonymous visitors of protected pages to /login. This is a convenience,
 * not the authorization boundary: every page, Server Action and Route Handler checks access itself.
 *
 * Only page requests (GET/HEAD) are redirected. A Server Action is a POST: the browser would replay it
 * against /login and the router would throw on the response, so it runs and answers "signed out" itself.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });
  const { url, publishableKey } = loadSupabaseConfig();
  const supabase = createServerClient(url, publishableKey, {
    cookieOptions: AUTH_COOKIE_OPTIONS,
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet, headers) {
        // Refreshed tokens go to the request (for the page rendering now) and the response (for the browser).
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        // Cache-Control etc.: a response that sets auth cookies must never be cached and served to someone else.
        for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      },
    },
  });

  // Nothing may run between creating the client and getClaims(): it performs the token refresh.
  const { data } = await supabase.auth.getClaims();
  const isPageRequest = request.method === 'GET' || request.method === 'HEAD';
  if (data !== null || !isPageRequest || !requiresSignIn(request.nextUrl.pathname)) return response;

  const login = new URL(loginRedirectPath(request.nextUrl.pathname, request.nextUrl.search), request.url);
  const redirect = NextResponse.redirect(login);
  // Keep whatever the auth client wrote (e.g. clearing a dead session) and its no-cache headers.
  for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
  for (const [key, value] of response.headers) {
    if (key === 'cache-control' || key === 'expires' || key === 'pragma') redirect.headers.set(key, value);
  }
  return redirect;
}
