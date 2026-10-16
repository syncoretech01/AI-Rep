import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AgentSettingsForm } from '@/components/admin/AgentSettingsForm';
import { BusinessHoursEditor } from '@/components/admin/BusinessHoursEditor';
import { BusinessProfileForm } from '@/components/admin/BusinessProfileForm';
import { Badge, PageHeader, ReadOnlyNotice, Section, linkClass } from '@/components/admin/ui';
import { WebChatPanel } from '@/components/admin/WebChatPanel';
import { requestOrigin } from '@/server/admin/redirects';
import { requireOrgAccess } from '@/server/auth/org-access';
import { isUuid } from '@/server/db/sql';
import { getAgent, getWebChatChannel } from '@/server/domain/agents/repository';
import { agentSettingsSchema } from '@/server/domain/agents/schemas';
import { AGENT_STATUSES, LEAD_FIELDS } from '@/server/domain/agents/types';
import { getBusinessProfile, listBusinessHours } from '@/server/domain/business/repository';
import { DAY_NAMES } from '@/server/domain/business/types';
import {
  rotateWidgetKeyAction,
  setWebChatEnabledAction,
  updateAgentSettingsAction,
  updateBusinessHoursAction,
  updateBusinessProfileAction,
} from './actions';

export const metadata: Metadata = { title: 'Agent settings' };

type Props = { params: Promise<{ orgSlug: string; agentId: string }> };

// IANA zones known to this server (the same check validates the field); 'UTC' is not in Intl's list.
const TIME_ZONES = ['UTC', ...Intl.supportedValuesOf('timeZone').filter((zone) => zone !== 'UTC')];
const INSTRUCTIONS_MAX_LENGTH = agentSettingsSchema.shape.instructions.maxLength ?? 4000;

const SECTIONS = [
  { id: 'settings', label: 'Settings' },
  { id: 'business-profile', label: 'Business profile' },
  { id: 'business-hours', label: 'Business hours' },
  { id: 'web-chat', label: 'Web chat' },
] as const;

export default async function AgentPage({ params }: Props) {
  const { orgSlug, agentId } = await params;
  const access = await requireOrgAccess(orgSlug);
  if (!isUuid(agentId)) notFound();

  const organizationId = access.organization.id;
  const data = await access.db.run(async (sql) => {
    const agent = await getAgent(sql, organizationId, agentId);
    if (!agent) return null;
    return {
      agent,
      profile: await getBusinessProfile(sql, organizationId, agentId),
      hours: await listBusinessHours(sql, organizationId, agentId),
      channel: await getWebChatChannel(sql, organizationId, agentId),
    };
  });
  if (!data) notFound();

  const { agent, profile, hours, channel } = data;
  const slug = access.organization.slug;
  const readOnly = !access.isAdmin;
  const origin = requestOrigin(await headers());

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-2 text-sm">
        <Link href={`/o/${slug}/agents`} className={linkClass}>
          Agents
        </Link>
        <span aria-hidden="true" className="px-1.5 text-slate-400">
          /
        </span>
        <span aria-current="page" className="text-slate-600">
          {agent.name}
        </span>
      </nav>
      <PageHeader
        title={agent.name}
        description="Configure how this assistant behaves and where it is published."
        actions={
          <>
            {agent.status === 'active' ? <Badge tone="success">Active</Badge> : <Badge tone="warning">Paused</Badge>}
            {channel?.enabled ? <Badge tone="info">Web chat published</Badge> : <Badge>Web chat off</Badge>}
          </>
        }
      />
      {readOnly ? <ReadOnlyNotice /> : null}

      <nav aria-label="Agent sections" className="mb-6 flex flex-wrap gap-2">
        {SECTIONS.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className="rounded-full border border-slate-200 bg-white px-3 py-1 text-sm text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
          >
            {section.label}
          </a>
        ))}
      </nav>

      <div className="space-y-8">
        <Section id="settings" title="Settings" description="How the assistant greets visitors, replies and collects leads.">
          <AgentSettingsForm
            action={updateAgentSettingsAction.bind(null, slug, agent.id)}
            values={{
              name: agent.name,
              status: agent.status,
              greeting: agent.greeting,
              language: agent.language,
              timezone: agent.timezone,
              instructions: agent.instructions,
              leadCaptureEnabled: agent.leadCapture.enabled,
              requiredFields: agent.leadCapture.requiredFields,
            }}
            statuses={AGENT_STATUSES}
            leadFields={LEAD_FIELDS}
            timeZones={TIME_ZONES}
            instructionsMaxLength={INSTRUCTIONS_MAX_LENGTH}
            readOnly={readOnly}
          />
        </Section>

        <Section
          id="business-profile"
          title="Business profile"
          description="Facts the assistant shares exactly as written: contact details, address and service area."
        >
          <BusinessProfileForm
            action={updateBusinessProfileAction.bind(null, slug, agent.id)}
            values={{
              businessName: profile?.businessName ?? '',
              description: profile?.description ?? '',
              phone: profile?.phone ?? '',
              email: profile?.email ?? '',
              website: profile?.website ?? '',
              address: profile?.address ?? '',
              serviceArea: profile?.serviceArea ?? '',
            }}
            readOnly={readOnly}
          />
        </Section>

        <Section
          id="business-hours"
          title="Business hours"
          description="When you are open. The assistant answers opening-hours questions from this schedule."
        >
          <BusinessHoursEditor
            action={updateBusinessHoursAction.bind(null, slug, agent.id)}
            intervals={hours}
            timezone={agent.timezone}
            dayNames={DAY_NAMES}
            readOnly={readOnly}
          />
        </Section>

        <Section id="web-chat" title="Web chat" description="Add the chat widget to your website.">
          <WebChatPanel
            enabled={channel?.enabled === true}
            widgetKey={channel?.publicKey ?? null}
            origin={origin}
            agentActive={agent.status === 'active'}
            readOnly={readOnly}
            toggleAction={setWebChatEnabledAction.bind(null, slug, agent.id)}
            rotateAction={rotateWidgetKeyAction.bind(null, slug, agent.id)}
          />
        </Section>
      </div>
    </>
  );
}
