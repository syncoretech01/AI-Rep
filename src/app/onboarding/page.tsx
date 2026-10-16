import type { Metadata } from 'next';
import Link from 'next/link';
import { signOut } from '@/app/(auth)/actions';
import { AuthShell } from '@/components/admin/AuthShell';
import { OnboardingForm } from '@/components/admin/OnboardingForm';
import { linkClass } from '@/components/admin/ui';
import { getAppServices } from '@/server/app-services';
import { requireUser } from '@/server/auth/session';
import { userScope } from '@/server/db/scope';
import { listMemberships } from '@/server/domain/organizations/service';
import { createOrganizationAction } from './actions';

export const metadata: Metadata = { title: 'Create your organization' };

export default async function OnboardingPage() {
  const user = await requireUser();
  const memberships = await listMemberships(userScope(getAppServices().db, user.id), user.id);
  const current = memberships[0]?.organization;

  return (
    <AuthShell
      title={current ? 'Create another organization' : 'Create your organization'}
      description="We'll set up a first AI assistant for your business. Next, you'll add your opening hours and business details so it can answer visitors accurately."
      footer={
        current ? (
          <Link href={`/o/${current.slug}`} className={linkClass}>
            Back to {current.name}
          </Link>
        ) : (
          <form action={signOut}>
            <span>Signed in as {user.email ?? 'your account'}. </span>
            <button type="submit" className={linkClass}>
              Sign out
            </button>
          </form>
        )
      }
    >
      <OnboardingForm action={createOrganizationAction} />
    </AuthShell>
  );
}
