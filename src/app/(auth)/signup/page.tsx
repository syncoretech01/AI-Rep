import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AuthShell } from '@/components/admin/AuthShell';
import { SignUpForm } from '@/components/admin/AuthForms';
import { linkClass } from '@/components/admin/ui';
import { firstSearchParam, safeNextPath, withNextParam } from '@/server/admin/redirects';
import { getAuthUser } from '@/server/auth/session';
import { signUp } from '../actions';

export const metadata: Metadata = { title: 'Create an account' };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function SignUpPage({ searchParams }: Props) {
  const next = safeNextPath(firstSearchParam((await searchParams).next), '/');
  if (await getAuthUser()) redirect(next);

  return (
    <AuthShell
      title="Create your account"
      description="Set up an AI receptionist that answers your website visitors and captures leads."
      footer={
        <>
          Already have an account?{' '}
          <Link href={withNextParam('/login', next)} className={linkClass}>
            Sign in
          </Link>
        </>
      }
    >
      {/* New accounts continue to onboarding unless they were sent here from a specific page. */}
      <SignUpForm action={signUp} next={next === '/' ? '/onboarding' : next} />
    </AuthShell>
  );
}
