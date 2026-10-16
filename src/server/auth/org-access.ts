import 'server-only';
import { revalidatePath } from 'next/cache';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import {
  ADMIN_ONLY_STATE,
  NO_ACCESS_STATE,
  UNEXPECTED_ERROR_STATE,
  expectedErrorState,
  type ActionState,
} from '@/server/admin/forms';
import { getAppServices } from '@/server/app-services';
import { serviceScope, userScope, type ScopedDb } from '@/server/db/scope';
import { recordAudit, type AuditEntry } from '@/server/domain/audit/service';
import { getMembershipBySlug, type Organization } from '@/server/domain/organizations/service';
import { isAdminRole, type MemberRole } from '@/server/domain/types';
import { createLogger } from '@/server/observability/logger';
import { getAuthUser, requireUser, type AuthUser } from './session';

// Not getAppServices().logger: building the services may be what failed.
const accessLogger = createLogger({ bindings: { module: 'admin.access' } });

/** The signed-in user's access to one organization (resolved from the URL slug, never from client ids). */
export interface OrgAccess {
  user: AuthUser;
  organization: Organization;
  role: MemberRole;
  isAdmin: boolean;
  /** User scope: Supabase RLS applies on top of the explicit organization filters. */
  db: ScopedDb;
}

// Memoized per request: the layout and the page both resolve the same membership.
const findMembership = cache((userId: string, orgSlug: string) =>
  getMembershipBySlug(userScope(getAppServices().db, userId), userId, orgSlug),
);

async function resolveOrgAccess(user: AuthUser, orgSlug: unknown): Promise<OrgAccess | null> {
  // Server Action arguments are sent back by the client: anything but a string names no organization.
  if (typeof orgSlug !== 'string') return null;
  const membership = await findMembership(user.id, orgSlug);
  if (!membership) return null;
  return {
    user,
    organization: membership.organization,
    role: membership.role,
    isAdmin: isAdminRole(membership.role),
    db: userScope(getAppServices().db, user.id),
  };
}

/**
 * For pages and layouts under /o/[orgSlug]: signed-out visitors go to /login; an unknown organization and
 * one the user does not belong to both render the same 404 (existence is never revealed).
 */
export async function requireOrgAccess(orgSlug: string): Promise<OrgAccess> {
  const user = await requireUser();
  const access = await resolveOrgAccess(user, orgSlug);
  if (!access) notFound();
  return access;
}

/** For Server Actions, which authorize themselves (the proxy does not cover them): null = not allowed. */
export async function getOrgAccessForAction(orgSlug: string): Promise<OrgAccess | null> {
  const user = await getAuthUser();
  return user ? resolveOrgAccess(user, orgSlug) : null;
}

export type AdminActionAuthorization = { ok: true; access: OrgAccess } | { ok: false; state: ActionState };

/**
 * Authorizes a Server Action that changes an organization: a signed-in member who is an owner or admin.
 * The role is checked before anything is written: under RLS a member's write fails as "not found" or
 * with a raw permission error. Never throws: a failed lookup (e.g. the database is unreachable) is
 * logged and answered with the generic error state, so the form shows it instead of crashing.
 */
export async function authorizeAdminAction(orgSlug: string): Promise<AdminActionAuthorization> {
  let access: OrgAccess | null;
  try {
    access = await getOrgAccessForAction(orgSlug);
  } catch (error) {
    accessLogger.error('admin.authorization_failed', { error });
    return { ok: false, state: UNEXPECTED_ERROR_STATE };
  }
  if (!access) return { ok: false, state: NO_ACCESS_STATE };
  if (!access.isAdmin) return { ok: false, state: ADMIN_ONLY_STATE };
  return { ok: true, access };
}

/**
 * Audits an admin change. Runs under SERVICE scope (audit_logs has no user write grant, so the UI cannot
 * forge or erase entries) in its own transaction after the change committed. Never throws: the change
 * already happened, so a failed audit write is logged instead of being reported as a failed save.
 */
export async function recordAdminAudit(
  access: OrgAccess,
  entry: Omit<AuditEntry, 'organizationId' | 'actorType' | 'actorId'>,
): Promise<void> {
  const { db, logger } = getAppServices();
  const organizationId = access.organization.id;
  try {
    await serviceScope(db).run((sql) =>
      recordAudit(sql, { ...entry, organizationId, actorType: 'user', actorId: access.user.id }),
    );
  } catch (error) {
    logger.error('admin.audit_failed', { organizationId, action: entry.action, error });
  }
}

/** State for a failed admin action: expected failures keep their safe message; anything else is logged. */
export function adminActionFailed(access: OrgAccess, action: string, error: unknown): ActionState {
  const expected = expectedErrorState(error);
  if (expected) return expected;
  getAppServices().logger.error('admin.action_failed', { organizationId: access.organization.id, action, error });
  return UNEXPECTED_ERROR_STATE;
}

/**
 * Changes show up on several admin pages (overview checklist, lists, details). Next.js tags layouts by route
 * pattern, so the pattern is revalidated: these pages render dynamically per request, so this re-renders the
 * current page in the action response and clears the browser's router cache.
 */
export function revalidateAdminPages(): void {
  revalidatePath('/o/[orgSlug]', 'layout');
}
