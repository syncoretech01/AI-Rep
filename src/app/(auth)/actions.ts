'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { formString, invalidFormState, type ActionState } from '@/server/admin/forms';
import { requestOrigin, safeNextPath } from '@/server/admin/redirects';
import { createServerAuthClient } from '@/server/auth/supabase';
import { createLogger } from '@/server/observability/logger';

const logger = createLogger({ bindings: { module: 'auth' } });

const email = z
  .string()
  .trim()
  .min(1, 'Enter your email address.')
  .max(254, 'Enter a valid email address.')
  .pipe(z.email('Enter a valid email address.'));

// Sign-in only needs a password: accounts created elsewhere (dashboard, invitations) may predate the sign-up
// rules, and Supabase is the judge of credentials. 72 is the bcrypt limit Supabase enforces.
const signInSchema = z.object({
  email,
  password: z.string().min(1, 'Enter your password.').max(72, 'Invalid email or password.'),
});

const signUpSchema = z.object({
  email,
  password: z.string().min(8, 'Use at least 8 characters.').max(72, 'Use at most 72 characters.'),
});

const INVALID_CREDENTIALS = 'Invalid email or password.';
const RATE_LIMITED = 'Too many attempts. Please wait a few minutes and try again.';
const AUTH_UNAVAILABLE = 'Sign-in is temporarily unavailable. Please try again in a moment.';

interface AuthFailure {
  code?: string;
  status?: number;
  message: string;
}

/** Infrastructure failures say so rather than blaming the credentials (auth-js reports network errors as status 0). */
function isServiceFailure(error: AuthFailure): boolean {
  return error.status === undefined || error.status === 0 || error.status >= 500;
}

function signInFailure(error: AuthFailure): ActionState {
  if (error.code === 'email_not_confirmed') {
    return { status: 'error', message: 'Confirm your email address first: open the link we emailed you.' };
  }
  if (error.code === 'over_request_rate_limit') return { status: 'error', message: RATE_LIMITED };
  if (isServiceFailure(error)) {
    logger.warn('auth.sign_in_unavailable', { code: error.code, status: error.status });
    return { status: 'error', message: AUTH_UNAVAILABLE };
  }
  // Never reveal whether the email has an account.
  return { status: 'error', message: INVALID_CREDENTIALS };
}

function signUpFailure(error: AuthFailure): ActionState {
  switch (error.code) {
    case 'weak_password':
      // Supabase describes its password requirements in this message.
      return {
        status: 'error',
        message: 'Choose a stronger password.',
        fieldErrors: { password: [error.message.slice(0, 300)] },
      };
    case 'user_already_exists':
    case 'email_exists':
      return { status: 'error', message: 'An account with this email already exists. Sign in instead.' };
    case 'email_address_invalid':
    case 'email_address_not_authorized':
      return {
        status: 'error',
        message: 'This email address cannot be used.',
        fieldErrors: { email: ['Use a different email address.'] },
      };
    case 'signup_disabled':
    case 'email_provider_disabled':
      return { status: 'error', message: 'New sign-ups are currently disabled.' };
    case 'over_request_rate_limit':
    case 'over_email_send_rate_limit':
      return { status: 'error', message: RATE_LIMITED };
    default:
      logger.warn('auth.sign_up_failed', { code: error.code, status: error.status });
      return { status: 'error', message: 'We could not create your account. Please try again.' };
  }
}

export async function signIn(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = signInSchema.safeParse({
    email: formString(formData, 'email'),
    password: formString(formData, 'password'),
  });
  if (!parsed.success) return invalidFormState(parsed.error);

  const auth = await createServerAuthClient();
  const { error } = await auth.signInWithPassword(parsed.data);
  if (error) return signInFailure(error);
  // redirect() throws: it must stay outside try/catch.
  redirect(safeNextPath(formString(formData, 'next'), '/'));
}

export async function signUp(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = signUpSchema.safeParse({
    email: formString(formData, 'email'),
    password: formString(formData, 'password'),
  });
  if (!parsed.success) return invalidFormState(parsed.error);

  const next = safeNextPath(formString(formData, 'next'), '/onboarding');
  const origin = requestOrigin(await headers());
  const auth = await createServerAuthClient();
  const { data, error } = await auth.signUp({
    ...parsed.data,
    // Without an origin Supabase falls back to the project's Site URL.
    options: origin ? { emailRedirectTo: `${origin}/auth/confirm?next=${encodeURIComponent(next)}` } : undefined,
  });
  if (error) return signUpFailure(error);
  // Projects that confirm email addresses (the hosted default) return no session until the link is opened.
  redirect(data.session ? next : `/check-email${next === '/onboarding' ? '' : `?next=${encodeURIComponent(next)}`}`);
}

export async function signOut(): Promise<void> {
  const auth = await createServerAuthClient();
  // 'local' ends this browser's session only; the user's other devices stay signed in.
  const { error } = await auth.signOut({ scope: 'local' });
  if (error) logger.warn('auth.sign_out_failed', { code: error.code, status: error.status });
  redirect('/login');
}
