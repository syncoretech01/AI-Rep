import type { ReactNode } from 'react';
import { signOut } from '@/app/(auth)/actions';
import { AdminShell } from '@/components/admin/AdminShell';
import { requireOrgAccess } from '@/server/auth/org-access';
import { listMemberships } from '@/server/domain/organizations/service';
import type { MemberRole } from '@/server/domain/types';

const ROLE_LABELS: Record<MemberRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member (view only)' };

type Props = { children: ReactNode; params: Promise<{ orgSlug: string }> };

/**
 * Shell of an organization's admin pages. Layouts and pages render in parallel, so every page (and every
 * Server Action) checks access itself; this check only guards the shell.
 */
export default async function OrganizationLayout({ children, params }: Props) {
  const { orgSlug } = await params;
  const access = await requireOrgAccess(orgSlug);
  const memberships = await listMemberships(access.db, access.user.id);

  return (
    <AdminShell
      organization={{ name: access.organization.name, slug: access.organization.slug }}
      organizations={memberships.map(({ organization }) => ({ name: organization.name, slug: organization.slug }))}
      userEmail={access.user.email}
      roleLabel={ROLE_LABELS[access.role]}
      signOutAction={signOut}
    >
      {children}
    </AdminShell>
  );
}
