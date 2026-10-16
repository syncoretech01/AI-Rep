import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthShell } from '@/components/admin/AuthShell';
import { buttonClass } from '@/components/admin/ui';

export const metadata: Metadata = { title: 'Link expired' };

export default function AuthErrorPage() {
  return (
    <AuthShell
      title="This link is invalid or has expired"
      description={
        <>
          <p>Your email address may already be confirmed: try signing in with your password.</p>
          <p className="mt-2">
            Confirmation links work once, only in the browser you signed up in, and expire after a while. If you
            cannot sign in, sign up again to get a new link.
          </p>
        </>
      }
    >
      <div className="flex flex-col gap-3 sm:flex-row">
        <Link href="/login" className={buttonClass('primary', 'flex-1')}>
          Sign in
        </Link>
        <Link href="/signup" className={buttonClass('secondary', 'flex-1')}>
          Sign up again
        </Link>
      </div>
    </AuthShell>
  );
}
