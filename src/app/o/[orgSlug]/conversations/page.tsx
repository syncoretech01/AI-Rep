import type { Metadata } from 'next';
import Link from 'next/link';
import { formatDateTime, pluralize } from '@/components/admin/format';
import { Badge, Card, EmptyState, PageHeader, linkClass } from '@/components/admin/ui';
import { requireOrgAccess } from '@/server/auth/org-access';
import { listConversations } from '@/server/domain/conversations/service';

export const metadata: Metadata = { title: 'Conversations' };

type Props = { params: Promise<{ orgSlug: string }> };

const LIST_LIMIT = 100;

export default async function ConversationsPage({ params }: Props) {
  const { orgSlug } = await params;
  const access = await requireOrgAccess(orgSlug);
  const conversations = await listConversations(access.db, access.organization.id, { limit: LIST_LIMIT });
  const base = `/o/${access.organization.slug}`;

  return (
    <>
      <PageHeader
        title="Conversations"
        description={
          conversations.length === LIST_LIMIT
            ? `The ${LIST_LIMIT} most recently active conversations.`
            : 'Every chat with your assistants, most recent first.'
        }
      />
      {conversations.length === 0 ? (
        <EmptyState
          title="No conversations yet"
          description="Conversations appear here as soon as a visitor sends a message, including from the widget preview."
        />
      ) : (
        <Card>
          <ul className="divide-y divide-slate-200">
            {conversations.map((conversation) => (
              <li key={conversation.id} className="px-4 py-4 sm:px-6">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`${base}/conversations/${conversation.id}`} className={linkClass}>
                        {conversation.contactName ?? 'Anonymous visitor'}
                      </Link>
                      {conversation.status === 'active' ? (
                        <Badge tone="success">Active</Badge>
                      ) : (
                        <Badge>Closed</Badge>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm break-words text-slate-600">
                      {conversation.preview ?? 'No messages yet'}
                    </p>
                  </div>
                  <div className="shrink-0 text-xs text-slate-500 sm:text-right">
                    <p>{formatDateTime(conversation.lastMessageAt ?? conversation.createdAt)}</p>
                    <p>
                      {conversation.agentName} · {pluralize(conversation.messageCount, 'message')}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
