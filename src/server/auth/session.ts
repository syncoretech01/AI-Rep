import 'server-only';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { isUuid } from '@/server/db/sql';
import { createServerAuthClient } from './supabase';

export interface AuthUser {
  id: string;
  email: string | null;
}

/**
 * getClaims() verifies the access token (locally with asymmetric signing keys, otherwise through the Auth
 * server). getSession() is never used on the server: it only decodes the cookie. Memoized per request, so a
 * layout, its page and their helpers verify the session once.
 */
const loadAuthUser = cache(async (): Promise<AuthUser | null> => {
  const auth = await createServerAuthClient();
  const { data } = await auth.getClaims();
  if (!data) return null;
  const { sub, email, is_anonymous: isAnonymous } = data.claims;
  // userScope needs a UUID subject; anonymous sessions (if ever enabled on the project) get no admin access.
  if (!isUuid(sub) || isAnonymous === true) return null;
  return { id: sub, email: email !== undefined && email !== '' ? email : null };
});

/** The signed-in user, or null. */
export async function getAuthUser(): Promise<AuthUser | null> {
  return loadAuthUser();
}

/** The signed-in user; signed-out visitors are sent to /login. */
export async function requireUser(): Promise<AuthUser> {
  const user = await getAuthUser();
  if (!user) redirect('/login');
  return user;
}
