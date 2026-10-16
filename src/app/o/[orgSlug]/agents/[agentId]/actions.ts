'use server';

import { z } from 'zod';
import {
  formString,
  hoursFieldErrors,
  invalidFormState,
  parseAgentSettingsForm,
  parseBusinessHoursForm,
  parseBusinessProfileForm,
  readBusinessHoursRows,
  type ActionState,
} from '@/server/admin/forms';
import { getAppServices } from '@/server/app-services';
import {
  adminActionFailed,
  authorizeAdminAction,
  recordAdminAudit,
  revalidateAdminPages,
} from '@/server/auth/org-access';
import { serviceScope } from '@/server/db/scope';
import { isUuid } from '@/server/db/sql';
import {
  ensureWebChatChannel,
  rotateWidgetKey,
  setWebChatEnabled,
  updateAgentSettings,
} from '@/server/domain/agents/repository';
import { replaceBusinessHours, upsertBusinessProfile } from '@/server/domain/business/repository';

/*
 * Agent configuration actions. Each one authorizes itself (signed in, member, owner/admin), validates the
 * form, writes under USER scope (RLS applies; the repositories also filter by organization and re-validate)
 * and audits through service scope. Widget keys are the exception: API roles may never write them (the key
 * namespace spans all tenants), so creating the web chat channel and rotating its key run in SERVICE scope,
 * after the owner/admin check. `agentId` is a bound argument the browser sends back, so it can be any
 * value: a non-UUID is refused here, and the repositories report another organization's agent as not found.
 */

const publishSchema = z.enum(['true', 'false'], 'Choose whether to publish web chat.');
const AGENT_NOT_FOUND_STATE: ActionState = { status: 'error', message: 'Agent not found.' };

export async function updateAgentSettingsAction(
  orgSlug: string,
  agentId: string,
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const authorization = await authorizeAdminAction(orgSlug);
  if (!authorization.ok) return authorization.state;
  const { access } = authorization;
  if (!isUuid(agentId)) return AGENT_NOT_FOUND_STATE;

  const parsed = parseAgentSettingsForm(formData);
  if (!parsed.success) return invalidFormState(parsed.error);

  try {
    const agent = await access.db.run((sql) => updateAgentSettings(sql, access.organization.id, agentId, parsed.data));
    await recordAdminAudit(access, {
      action: 'agent.settings_updated',
      targetType: 'agent',
      targetId: agent.id,
      metadata: { status: agent.status, leadCapture: agent.leadCapture.enabled },
    });
  } catch (error) {
    return adminActionFailed(access, 'agent.settings_updated', error);
  }
  revalidateAdminPages();
  return { status: 'success', message: 'Settings saved.' };
}

export async function updateBusinessProfileAction(
  orgSlug: string,
  agentId: string,
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const authorization = await authorizeAdminAction(orgSlug);
  if (!authorization.ok) return authorization.state;
  const { access } = authorization;
  if (!isUuid(agentId)) return AGENT_NOT_FOUND_STATE;

  const parsed = parseBusinessProfileForm(formData);
  if (!parsed.success) return invalidFormState(parsed.error);

  try {
    const profile = await access.db.run((sql) =>
      upsertBusinessProfile(sql, access.organization.id, agentId, parsed.data),
    );
    await recordAdminAudit(access, {
      action: 'agent.business_profile_updated',
      targetType: 'agent',
      targetId: profile.agentId,
    });
  } catch (error) {
    return adminActionFailed(access, 'agent.business_profile_updated', error);
  }
  revalidateAdminPages();
  return { status: 'success', message: 'Business profile saved.' };
}

export async function updateBusinessHoursAction(
  orgSlug: string,
  agentId: string,
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const authorization = await authorizeAdminAction(orgSlug);
  if (!authorization.ok) return authorization.state;
  const { access } = authorization;
  if (!isUuid(agentId)) return AGENT_NOT_FOUND_STATE;

  const parsed = parseBusinessHoursForm(formData);
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Please correct the opening hours.',
      fieldErrors: hoursFieldErrors(parsed.error, readBusinessHoursRows(formData)),
    };
  }

  try {
    const hours = await access.db.run((sql) => replaceBusinessHours(sql, access.organization.id, agentId, parsed.data));
    await recordAdminAudit(access, {
      action: 'agent.business_hours_updated',
      targetType: 'agent',
      targetId: agentId,
      metadata: { intervals: hours.length },
    });
  } catch (error) {
    return adminActionFailed(access, 'agent.business_hours_updated', error);
  }
  revalidateAdminPages();
  return { status: 'success', message: 'Opening hours saved.' };
}

export async function setWebChatEnabledAction(
  orgSlug: string,
  agentId: string,
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const authorization = await authorizeAdminAction(orgSlug);
  if (!authorization.ok) return authorization.state;
  const { access } = authorization;
  if (!isUuid(agentId)) return AGENT_NOT_FOUND_STATE;

  const parsed = publishSchema.safeParse(formString(formData, 'enabled'));
  if (!parsed.success) return invalidFormState(parsed.error);
  const enabled = parsed.data === 'true';

  const organizationId = access.organization.id;
  try {
    // A missing channel (and its key) is created server-side first; the toggle itself runs under RLS.
    await serviceScope(getAppServices().db).run((sql) => ensureWebChatChannel(sql, organizationId, agentId));
    const channel = await access.db.run((sql) => setWebChatEnabled(sql, organizationId, agentId, enabled));
    await recordAdminAudit(access, {
      action: enabled ? 'agent.web_chat_published' : 'agent.web_chat_unpublished',
      targetType: 'agent',
      targetId: channel.agentId,
      metadata: { channelId: channel.id },
    });
  } catch (error) {
    return adminActionFailed(access, 'agent.web_chat_updated', error);
  }
  revalidateAdminPages();
  return {
    status: 'success',
    message: enabled ? 'Web chat is published.' : 'Web chat is unpublished. Visitors now see the chat as unavailable.',
  };
}

export async function rotateWidgetKeyAction(
  orgSlug: string,
  agentId: string,
  _previous: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  const authorization = await authorizeAdminAction(orgSlug);
  if (!authorization.ok) return authorization.state;
  const { access } = authorization;
  if (!isUuid(agentId)) return AGENT_NOT_FOUND_STATE;

  try {
    const channel = await serviceScope(getAppServices().db).run((sql) =>
      rotateWidgetKey(sql, access.organization.id, agentId),
    );
    await recordAdminAudit(access, {
      action: 'agent.widget_key_rotated',
      targetType: 'agent',
      targetId: channel.agentId,
      metadata: { channelId: channel.id },
    });
  } catch (error) {
    return adminActionFailed(access, 'agent.widget_key_rotated', error);
  }
  revalidateAdminPages();
  return { status: 'success', message: 'New widget key issued. Update the embed code on your website.' };
}
