import type { Metadata } from 'next';
import Link from 'next/link';
import { capitalize, formatDateTime } from '@/components/admin/format';
import { Badge, Card, EmptyState, PageHeader, linkClass, type BadgeTone } from '@/components/admin/ui';
import { requireOrgAccess } from '@/server/auth/org-access';
import { listLeads, visitorDetails } from '@/server/domain/contacts/service';
import type { LeadStatus } from '@/server/domain/contacts/types';

export const metadata: Metadata = { title: 'Leads' };

type Props = { params: Promise<{ orgSlug: string }> };

const LIST_LIMIT = 100;

const STATUS_TONES: Record<LeadStatus, BadgeTone> = {
  new: 'info',
  contacted: 'warning',
  qualified: 'success',
  closed: 'neutral',
};

export default async function LeadsPage({ params }: Props) {
  const { orgSlug } = await params;
  const access = await requireOrgAccess(orgSlug);
  const leads = await listLeads(access.db, access.organization.id, { limit: LIST_LIMIT });
  const base = `/o/${access.organization.slug}`;

  return (
    <>
      <PageHeader
        title="Leads"
        description={
          leads.length === LIST_LIMIT
            ? `The ${LIST_LIMIT} most recent leads.`
            : 'Visitors who left their details with an assistant, newest first.'
        }
      />
      {leads.length === 0 ? (
        <EmptyState
          title="No leads yet"
          description="When a visitor shares a phone number or email in the chat, the assistant saves a lead here."
        />
      ) : (
        <Card className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
            <caption className="sr-only">Leads</caption>
            <thead className="bg-slate-50 text-xs font-medium text-slate-600">
              <tr>
                <th scope="col" className="px-4 py-2.5">
                  Created
                </th>
                <th scope="col" className="px-4 py-2.5">
                  Contact
                </th>
                <th scope="col" className="px-4 py-2.5">
                  Agent
                </th>
                <th scope="col" className="px-4 py-2.5">
                  Status
                </th>
                <th scope="col" className="px-4 py-2.5">
                  Summary
                </th>
                <th scope="col" className="px-4 py-2.5">
                  <span className="sr-only">Conversation</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {leads.map((lead) => {
                // What the visitor gave in this conversation; the contact it matched is secondary.
                const { details, linkedContact } = visitorDetails(lead, lead.contact);
                return (
                  <tr key={lead.id} className="align-top">
                    <td className="px-4 py-3 whitespace-nowrap text-slate-600">{formatDateTime(lead.createdAt)}</td>
                    <td className="min-w-48 px-4 py-3">
                      <p className="font-medium break-words text-slate-900">{details.name ?? 'Name not given'}</p>
                      {details.phone ? <p className="break-words text-slate-700">{details.phone}</p> : null}
                      {details.email ? <p className="break-all text-slate-700">{details.email}</p> : null}
                      {linkedContact ? (
                        <p className="mt-1 text-xs break-words text-slate-500">
                          Linked contact:{' '}
                          {[linkedContact.name, linkedContact.phone, linkedContact.email]
                            .filter((value) => value !== null)
                            .join(' · ')}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-700">{lead.agentName}</td>
                    <td className="px-4 py-3">
                      <Badge tone={STATUS_TONES[lead.status]}>{capitalize(lead.status)}</Badge>
                    </td>
                    <td className="max-w-md min-w-56 px-4 py-3 break-words whitespace-pre-wrap text-slate-700">
                      {lead.summary ?? '—'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {lead.conversationId ? (
                        <Link href={`${base}/conversations/${lead.conversationId}`} className={linkClass}>
                          View conversation
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
