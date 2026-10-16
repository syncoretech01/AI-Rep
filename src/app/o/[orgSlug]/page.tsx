import type { Metadata } from 'next';
import Link from 'next/link';
import { formatDateTime, pluralize } from '@/components/admin/format';
import { Badge, Card, EmptyState, PageHeader, linkClass } from '@/components/admin/ui';
import { requireOrgAccess } from '@/server/auth/org-access';
import type { Sql } from '@/server/db/types';
import { getWebChatChannel, listAgents } from '@/server/domain/agents/repository';
import type { Agent, AgentChannel } from '@/server/domain/agents/types';
import { getBusinessProfile, listBusinessHours } from '@/server/domain/business/repository';
import type { BusinessProfile, HoursInterval } from '@/server/domain/business/types';
import { listLeads, visitorDetails } from '@/server/domain/contacts/service';
import { listConversations } from '@/server/domain/conversations/service';
import { listKnowledgeSources } from '@/server/domain/knowledge/ingestion';
import type { KnowledgeSource } from '@/server/domain/knowledge/types';

export const metadata: Metadata = { title: 'Overview' };

type Props = { params: Promise<{ orgSlug: string }> };

const RECENT_LIMIT = 5;

interface ChecklistItem {
  label: string;
  done: boolean;
  href: string;
}

interface AgentSetup {
  agent: Agent;
  profile: BusinessProfile | null;
  hours: HoursInterval[];
  channel: AgentChannel | null;
}

/** Each agent with the configuration its setup checklist needs (one transaction, user scope). */
async function loadAgentSetups(sql: Sql, organizationId: string): Promise<AgentSetup[]> {
  const agents = await listAgents(sql, organizationId);
  const setups: AgentSetup[] = [];
  for (const agent of agents) {
    setups.push({
      agent,
      profile: await getBusinessProfile(sql, organizationId, agent.id),
      hours: await listBusinessHours(sql, organizationId, agent.id),
      channel: await getWebChatChannel(sql, organizationId, agent.id),
    });
  }
  return setups;
}

function hasReadyKnowledge(sources: readonly KnowledgeSource[], agentId: string): boolean {
  return sources.some((source) => source.status === 'ready' && (source.agentId === null || source.agentId === agentId));
}

function CheckIcon({ done }: { done: boolean }) {
  return done ? (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="size-5 shrink-0 text-emerald-600">
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z"
        clipRule="evenodd"
      />
    </svg>
  ) : (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} className="size-5 shrink-0 text-slate-400">
      <circle cx="10" cy="10" r="7.25" />
    </svg>
  );
}

export default async function OverviewPage({ params }: Props) {
  const { orgSlug } = await params;
  const access = await requireOrgAccess(orgSlug);
  const organizationId = access.organization.id;
  const base = `/o/${access.organization.slug}`;

  const [setups, sources, leads, conversations] = await Promise.all([
    access.db.run((sql) => loadAgentSetups(sql, organizationId)),
    listKnowledgeSources(access.db, organizationId),
    listLeads(access.db, organizationId, { limit: RECENT_LIMIT }),
    listConversations(access.db, organizationId, { limit: RECENT_LIMIT }),
  ]);

  return (
    <>
      <PageHeader
        title="Overview"
        description={`Setup progress and the latest activity in ${access.organization.name}.`}
      />

      <section aria-labelledby="setup-heading" className="mb-10">
        <h2 id="setup-heading" className="mb-3 text-base font-semibold text-slate-900">
          Setup
        </h2>
        {setups.length === 0 ? (
          <EmptyState
            title="No agents yet"
            description="Create an agent to configure your AI receptionist."
            action={
              <Link href={`${base}/agents`} className={linkClass}>
                Go to Agents
              </Link>
            }
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {setups.map(({ agent, profile, hours, channel }) => {
              const agentPath = `${base}/agents/${agent.id}`;
              const items: ChecklistItem[] = [
                { label: 'Business name added', done: Boolean(profile?.businessName), href: `${agentPath}#business-profile` },
                { label: 'Opening hours set', done: hours.length > 0, href: `${agentPath}#business-hours` },
                { label: 'Knowledge ready', done: hasReadyKnowledge(sources, agent.id), href: `${base}/knowledge` },
                { label: 'Web chat published', done: channel?.enabled === true, href: `${agentPath}#web-chat` },
              ];
              const completed = items.filter((item) => item.done).length;
              return (
                <Card key={agent.id} className="p-4 sm:p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate font-semibold text-slate-900">
                        <Link href={agentPath} className={linkClass}>
                          {agent.name}
                        </Link>
                      </h3>
                      <p className="text-sm text-slate-600">
                        {completed} of {items.length} setup steps done
                      </p>
                    </div>
                    {agent.status === 'active' ? <Badge tone="success">Active</Badge> : <Badge tone="warning">Paused</Badge>}
                  </div>
                  <ul className="mt-4 space-y-2.5">
                    {items.map((item) => (
                      <li key={item.label} className="flex items-center gap-2.5 text-sm">
                        <CheckIcon done={item.done} />
                        <span className={item.done ? 'text-slate-600' : 'font-medium text-slate-900'}>
                          {item.label}
                          <span className="sr-only">{item.done ? ' (done)' : ' (to do)'}</span>
                        </span>
                        {item.done ? null : (
                          <Link href={item.href} className={`ml-auto text-sm ${linkClass}`}>
                            Set up<span className="sr-only">: {item.label.toLowerCase()}</span>
                          </Link>
                        )}
                      </li>
                    ))}
                  </ul>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <div className="grid gap-8 xl:grid-cols-2">
        <section aria-labelledby="recent-leads-heading">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 id="recent-leads-heading" className="text-base font-semibold text-slate-900">
              Recent leads
            </h2>
            <Link href={`${base}/leads`} className={`text-sm ${linkClass}`}>
              All leads
            </Link>
          </div>
          {leads.length === 0 ? (
            <EmptyState
              title="No leads yet"
              description="When a visitor leaves their details in the chat, the lead appears here."
            />
          ) : (
            <Card>
              <ul className="divide-y divide-slate-200">
                {leads.map((lead) => {
                  // What the visitor gave in this conversation; the contact it matched is secondary.
                  const { details, linkedContact } = visitorDetails(lead, lead.contact);
                  return (
                    <li key={lead.id} className="px-4 py-3 text-sm">
                      <div className="flex items-start justify-between gap-3">
                        <p className="min-w-0 truncate font-medium text-slate-900">
                          {details.name ?? details.phone ?? details.email ?? 'Unnamed contact'}
                        </p>
                        <span className="shrink-0 text-xs text-slate-500">{formatDateTime(lead.createdAt)}</span>
                      </div>
                      <p className="truncate text-slate-600">
                        {[details.phone, details.email].filter((value) => value !== null).join(' · ') ||
                          'No contact details'}
                      </p>
                      {linkedContact ? (
                        <p className="truncate text-xs text-slate-500">
                          Linked contact:{' '}
                          {[linkedContact.name, linkedContact.phone, linkedContact.email]
                            .filter((value) => value !== null)
                            .join(' · ')}
                        </p>
                      ) : null}
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                        <span>{lead.agentName}</span>
                        {lead.conversationId ? (
                          <Link href={`${base}/conversations/${lead.conversationId}`} className={linkClass}>
                            View conversation
                          </Link>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </section>

        <section aria-labelledby="recent-conversations-heading">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 id="recent-conversations-heading" className="text-base font-semibold text-slate-900">
              Recent conversations
            </h2>
            <Link href={`${base}/conversations`} className={`text-sm ${linkClass}`}>
              All conversations
            </Link>
          </div>
          {conversations.length === 0 ? (
            <EmptyState
              title="No conversations yet"
              description="Publish web chat on an agent, then try it from the preview link."
            />
          ) : (
            <Card>
              <ul className="divide-y divide-slate-200">
                {conversations.map((conversation) => (
                  <li key={conversation.id} className="px-4 py-3 text-sm">
                    <div className="flex items-start justify-between gap-3">
                      <Link
                        href={`${base}/conversations/${conversation.id}`}
                        className={`min-w-0 truncate ${linkClass}`}
                      >
                        {conversation.contactName ?? 'Anonymous visitor'}
                      </Link>
                      <span className="shrink-0 text-xs text-slate-500">
                        {formatDateTime(conversation.lastMessageAt ?? conversation.createdAt)}
                      </span>
                    </div>
                    <p className="truncate text-slate-600">{conversation.preview ?? 'No messages yet'}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {conversation.agentName} · {pluralize(conversation.messageCount, 'message')}
                    </p>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </section>
      </div>
    </>
  );
}
