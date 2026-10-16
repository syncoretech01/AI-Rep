import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthShell } from '@/components/admin/AuthShell';
import { buttonClass } from '@/components/admin/ui';
import { firstSearchParam, safeNextPath, withNextParam } from '@/server/admin/redirects';

export const metadata: Metadata = { title: 'Check your email' };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function CheckEmailPage({ searchParams }: Props) {
  const next = safeNextPath(firstSearchParam((await searchParams).next), '/');
  return (
    <AuthShell
      title="Check your email"
      description={
        <>
          <p>We sent you a confirmation link. Open it on this device to activate your account and continue setup.</p>
          <p className="mt-2">
            No email after a few minutes? Check your spam folder. If you already have an account, sign in instead.
          </p>
        </>
      }
    >
      <Link href={withNextParam('/login', next)} className={buttonClass('secondary', 'w-full')}>
        Back to sign in
      </Link>
    </AuthShell>
  );
}
