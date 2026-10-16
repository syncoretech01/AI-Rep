import { redirect } from 'next/navigation';
import type { NextRequest } from 'next/server';
import { safeNextPath } from '@/server/admin/redirects';
import { createServerAuthClient } from '@/server/auth/supabase';
import { createLogger } from '@/server/observability/logger';

const logger = createLogger({ bindings: { module: 'auth.confirm' } });

// Real auth codes are short; never forward arbitrarily large values to the Auth server.
const MAX_CODE_CHARS = 1024;

/**
 * Landing route of Supabase email links (the default PKCE template: Supabase confirms the address, then
 * redirects here with `?code=…`). The code only becomes a session together with the code verifier cookie
 * that sign-up left in the same browser, so a link someone else forwards cannot sign this browser into
 * their account (login CSRF). For the same reason token-hash links (`?token_hash=…`), which verify in any
 * browser, are not accepted. On success the user continues to the safe `next` path; otherwise to
 * /auth/error, which points out that the address may already be confirmed.
 */
export async function GET(request: NextRequest): Promise<never> {
  const next = safeNextPath(request.nextUrl.searchParams.get('next'), '/');
  const code = request.nextUrl.searchParams.get('code');

  let confirmed = false;
  if (code !== null && code !== '' && code.length <= MAX_CODE_CHARS) {
    const auth = await createServerAuthClient();
    const { error } = await auth.exchangeCodeForSession(code);
    if (error) logger.warn('auth.confirm_failed', { code: error.code, status: error.status });
    confirmed = error === null;
  }
  // redirect() throws: Next.js turns it into a redirect response that carries the new session cookies.
  redirect(confirmed ? next : '/auth/error');
}
