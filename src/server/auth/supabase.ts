import 'server-only';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { loadSupabaseConfig } from '@/server/config/env';

/**
 * Supabase is used for Auth only; data access goes through src/server/db (raw SQL, RLS via userScope).
 *
 * Session cookies are httpOnly: the admin UI signs in and out through Server Actions and never runs a
 * browser Supabase client, so no script needs the tokens and an XSS bug cannot steal them.
 */
export const AUTH_COOKIE_OPTIONS: CookieOptions = {
  path: '/',
  sameSite: 'lax',
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
};

/**
 * Supabase Auth for the current request (Server Components, Server Actions, Route Handlers). Never share
 * one across requests. Server Components cannot write cookies: the proxy refreshes sessions before they
 * render, so a refresh attempted there is safely dropped.
 */
export async function createServerAuthClient() {
  const cookieStore = await cookies();
  const { url, publishableKey } = loadSupabaseConfig();
  const supabase = createServerClient(url, publishableKey, {
    cookieOptions: AUTH_COOKIE_OPTIONS,
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component: the proxy refreshes sessions.
        }
      },
    },
  });
  return supabase.auth;
}
