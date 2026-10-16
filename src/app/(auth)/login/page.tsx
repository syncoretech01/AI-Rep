import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AuthShell } from '@/components/admin/AuthShell';
import { SignInForm } from '@/components/admin/AuthForms';
import { linkClass } from '@/components/admin/ui';
import { firstSearchParam, safeNextPath, withNextParam } from '@/server/admin/redirects';
import { getAuthUser } from '@/server/auth/session';
import { signIn } from '../actions';

export const metadata: Metadata = { title: 'Sign in' };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function LoginPage({ searchParams }: Props) {
  const next = safeNextPath(firstSearchParam((await searchParams).next), '/');
  if (await getAuthUser()) redirect(next);

  return (
    <AuthShell
      title="Sign in"
      description="Manage your AI receptionist: agents, knowledge, conversations and leads."
      footer={
        <>
          New to Syncore?{' '}
          <Link href={withNextParam('/signup', next)} className={linkClass}>
            Create an account
          </Link>
        </>
      }
    >
      <SignInForm action={signIn} next={next} />
    </AuthShell>
  );
}
