import type { Metadata } from 'next';
import Link from 'next/link';
import { formatDate } from '@/components/admin/format';
import { NewAgentForm } from '@/components/admin/NewAgentForm';
import { Badge, Card, EmptyState, PageHeader, Section, linkClass } from '@/components/admin/ui';
import { requireOrgAccess } from '@/server/auth/org-access';
import { getWebChatChannel, listAgents } from '@/server/domain/agents/repository';
import type { Agent } from '@/server/domain/agents/types';
import { createAgentAction } from './actions';

export const metadata: Metadata = { title: 'Agents' };

type Props = { params: Promise<{ orgSlug: string }> };

export default async function AgentsPage({ params }: Props) {
  const { orgSlug } = await params;
  const access = await requireOrgAccess(orgSlug);
  const organizationId = access.organization.id;
  const base = `/o/${access.organization.slug}`;

  const agents = await access.db.run(async (sql) => {
    const list = await listAgents(sql, organizationId);
    const rows: Array<{ agent: Agent; webChatEnabled: boolean }> = [];
    for (const agent of list) {
      const channel = await getWebChatChannel(sql, organizationId, agent.id);
      rows.push({ agent, webChatEnabled: channel?.enabled === true });
    }
    return rows;
  });

  return (
    <>
      <PageHeader
        title="Agents"
        description="Each agent is an AI receptionist with its own settings, business profile, hours and web chat."
      />

      {agents.length === 0 ? (
        <EmptyState title="No agents yet" description="Create an agent to start configuring your receptionist." />
      ) : (
        <Card className="mb-8">
          <ul className="divide-y divide-slate-200">
            {agents.map(({ agent, webChatEnabled }) => (
              <li key={agent.id} className="flex flex-col gap-2 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                <div className="min-w-0">
                  <Link href={`${base}/agents/${agent.id}`} className={`text-base ${linkClass}`}>
                    {agent.name}
                  </Link>
                  <p className="text-sm text-slate-600">
                    {agent.timezone} · Created {formatDate(agent.createdAt)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {agent.status === 'active' ? <Badge tone="success">Active</Badge> : <Badge tone="warning">Paused</Badge>}
                  {webChatEnabled ? <Badge tone="info">Web chat published</Badge> : <Badge>Web chat off</Badge>}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {access.isAdmin ? (
        <Section title="New agent" description="Starts with default settings and an unpublished web chat.">
          <NewAgentForm action={createAgentAction.bind(null, access.organization.slug)} />
        </Section>
      ) : null}
    </>
  );
}
