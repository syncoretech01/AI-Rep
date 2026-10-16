import Link from 'next/link';
import { redirect } from 'next/navigation';
import { buttonClass } from '@/components/admin/ui';
import { getAppServices } from '@/server/app-services';
import { getAuthUser } from '@/server/auth/session';
import { userScope } from '@/server/db/scope';
import { listMemberships } from '@/server/domain/organizations/service';

export default async function HomePage() {
  const user = await getAuthUser();
  if (user) {
    const memberships = await listMemberships(userScope(getAppServices().db, user.id), user.id);
    const first = memberships[0];
    redirect(first ? `/o/${first.organization.slug}` : '/onboarding');
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-6 py-16">
      <p className="text-sm font-semibold tracking-wide text-indigo-700 uppercase">Syncore</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">AI Receptionist</h1>
      <p className="mt-4 text-lg text-slate-600">
        One AI receptionist for your business: it answers website visitors from your own information and captures
        their details for follow-up.
      </p>
      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Link href="/login" className={buttonClass('primary')}>
          Sign in
        </Link>
        <Link href="/signup" className={buttonClass('secondary')}>
          Create account
        </Link>
      </div>
    </main>
  );
}
