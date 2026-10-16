'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { formString, invalidFormState, type ActionState } from '@/server/admin/forms';
import { getAppServices } from '@/server/app-services';
import {
  adminActionFailed,
  authorizeAdminAction,
  recordAdminAudit,
  revalidateAdminPages,
  type OrgAccess,
} from '@/server/auth/org-access';
import { serviceScope } from '@/server/db/scope';
import { ensureWebChatChannel, insertAgent } from '@/server/domain/agents/repository';
import { agentSettingsSchema } from '@/server/domain/agents/schemas';
import { upsertBusinessProfile } from '@/server/domain/business/repository';

const newAgentSchema = z.object({ name: agentSettingsSchema.shape.name });

/**
 * Creates an agent with default settings, a business profile named after the organization, no opening
 * hours and an unpublished web chat channel, then opens its settings.
 */
export async function createAgentAction(
  orgSlug: string,
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const authorization = await authorizeAdminAction(orgSlug);
  if (!authorization.ok) return authorization.state;
  const { access } = authorization;

  const parsed = newAgentSchema.safeParse({ name: formString(formData, 'name') });
  if (!parsed.success) return invalidFormState(parsed.error);

  const organizationId = access.organization.id;
  let agentId: string;
  try {
    const agent = await access.db.run(async (sql) => {
      const created = await insertAgent(sql, organizationId, { name: parsed.data.name });
      await upsertBusinessProfile(sql, organizationId, created.id, {
        businessName: access.organization.name,
        description: null,
        phone: null,
        email: null,
        website: null,
        address: null,
        serviceArea: null,
      });
      return created;
    });
    agentId = agent.id;
    await recordAdminAudit(access, {
      action: 'agent.created',
      targetType: 'agent',
      targetId: agent.id,
      metadata: { name: agent.name },
    });
  } catch (error) {
    return adminActionFailed(access, 'agent.created', error);
  }
  await createWebChatChannel(access, agentId);
  revalidateAdminPages();
  redirect(`/o/${access.organization.slug}/agents/${agentId}`);
}

/**
 * The new agent's unpublished web chat channel. Widget keys are one namespace across tenants that only the
 * server writes (API roles cannot insert channels), so it is created in service scope, after the owner/admin
 * check. A failure is logged, not reported: the agent exists either way, and publishing it creates the channel.
 */
async function createWebChatChannel(access: OrgAccess, agentId: string): Promise<void> {
  const { db, logger } = getAppServices();
  const organizationId = access.organization.id;
  try {
    await serviceScope(db).run((sql) => ensureWebChatChannel(sql, organizationId, agentId));
  } catch (error) {
    logger.error('admin.web_chat_channel_failed', { organizationId, agentId, error });
  }
}
