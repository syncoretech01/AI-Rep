import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { VoiceLabPanel } from '@/components/admin/VoiceLabPanel';
import { EmptyState, PageHeader, ReadOnlyNotice } from '@/components/admin/ui';
import { requireOrgAccess } from '@/server/auth/org-access';
import { loadVoiceConfig } from '@/server/config/env';
import { listAgents } from '@/server/domain/agents/repository';

export const metadata: Metadata = { title: 'Voice lab' };

type Props = { params: Promise<{ orgSlug: string }> };

/**
 * Developer voice lab (Phase 2 proof of concept, not the production voice widget): talk to an agent in the browser
 * over GPT-Live and watch the transcript, tool runs and cost. Hidden unless VOICE_DEV_ENABLED=true.
 */
export default async function VoiceLabPage({ params }: Props) {
  const voice = loadVoiceConfig();
  if (!voice.devPageEnabled) notFound();
  const { orgSlug } = await params;
  const access = await requireOrgAccess(orgSlug);
  const organizationId = access.organization.id;
  const agents = (await access.db.run((sql) => listAgents(sql, organizationId))).filter((agent) => agent.status === 'active');

  return (
    <>
      <PageHeader
        title="Voice lab"
        description={`Developer test of realtime voice: ${voice.model} with ${voice.delegation} delegation, sessions capped at ${Math.round(voice.maxSessionSeconds / 60)} min. Calls are billed by the provider.`}
      />
      {!access.isAdmin ? (
        <ReadOnlyNotice>Only owners and admins can start voice tests.</ReadOnlyNotice>
      ) : agents.length === 0 ? (
        <EmptyState title="No active agent" description="Create or resume an agent to talk to it." />
      ) : (
        <VoiceLabPanel orgSlug={access.organization.slug} agents={agents.map((agent) => ({ id: agent.id, name: agent.name }))} />
      )}
    </>
  );
}
