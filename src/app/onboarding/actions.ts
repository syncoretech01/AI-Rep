'use server';

import { redirect } from 'next/navigation';
import {
  SIGNED_OUT_STATE,
  UNEXPECTED_ERROR_STATE,
  expectedErrorState,
  formString,
  invalidFormState,
  type ActionState,
} from '@/server/admin/forms';
import { getAppServices } from '@/server/app-services';
import { revalidateAdminPages } from '@/server/auth/org-access';
import { getAuthUser } from '@/server/auth/session';
import { createOrganization, createOrganizationInputSchema } from '@/server/domain/organizations/service';

/** Creates the user's organization (owner membership + a first agent) and opens that agent's setup. */
export async function createOrganizationAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const user = await getAuthUser();
  if (!user) return SIGNED_OUT_STATE;

  const parsed = createOrganizationInputSchema.safeParse({
    name: formString(formData, 'name'),
    agentName: formString(formData, 'agentName'),
  });
  if (!parsed.success) return invalidFormState(parsed.error);

  const { db, logger } = getAppServices();
  let destination: string;
  try {
    // Privileged connection: an organization cannot be created through RLS (the user is not a member yet).
    // The owner is the verified session user, never a value from the form.
    const { organization, agent } = await createOrganization(db, {
      name: parsed.data.name,
      agentName: parsed.data.agentName,
      ownerUserId: user.id,
    });
    destination = `/o/${organization.slug}/agents/${agent.id}`;
  } catch (error) {
    const expected = expectedErrorState(error);
    if (expected) return expected;
    logger.error('admin.action_failed', { action: 'organization.created', error });
    return UNEXPECTED_ERROR_STATE;
  }
  // The organization switcher of every admin page the browser has cached lists the memberships.
  revalidateAdminPages();
  redirect(destination);
}
