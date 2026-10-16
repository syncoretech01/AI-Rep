import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatDateTime, formatDuration, pluralize } from '@/components/admin/format';
import { Badge, Card, EmptyState, PageHeader, linkClass, type BadgeTone } from '@/components/admin/ui';
import { requireOrgAccess } from '@/server/auth/org-access';
import { isUuid, truncateText } from '@/server/db/sql';
import { getConversationLead, visitorDetails } from '@/server/domain/contacts/service';
import { getConversationDetail } from '@/server/domain/conversations/service';
import type { Message, ToolRunRecord } from '@/server/domain/conversations/types';

export const metadata: Metadata = { title: 'Conversation' };

type Props = { params: Promise<{ orgSlug: string; conversationId: string }> };

const MAX_ENTRIES = 8;
const MAX_LABEL_CHARS = 40;
const MAX_VALUE_CHARS = 160;

const TOOL_RUN_BADGES: Record<ToolRunRecord['status'], { label: string; tone: BadgeTone }> = {
  succeeded: { label: 'Succeeded', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  rejected: { label: 'Rejected', tone: 'warning' },
  running: { label: 'Running', tone: 'info' },
};

const SYSTEM_EVENTS: ReadonlyMap<string, string> = new Map([
  ['assistant_unavailable', 'The assistant could not respond, and the visitor was asked to try again.'],
]);

type Entry = [label: string, value: string];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One short line per value: tool payloads are summarized, never dumped. */
function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') return truncateText(value, MAX_VALUE_CHARS, '…');
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const scalars = value.every((item) => typeof item === 'string' || typeof item === 'number');
    return scalars ? truncateText(value.join(', '), MAX_VALUE_CHARS, '…') || '—' : pluralize(value.length, 'item');
  }
  if (isRecord(value)) return pluralize(Object.keys(value).length, 'field');
  return '—';
}

/** Keys come from model-written tool arguments too, so they are bounded like values. */
function entries(value: unknown): Entry[] {
  if (isRecord(value)) {
    return Object.entries(value)
      .slice(0, MAX_ENTRIES)
      .map(([key, inner]): Entry => [truncateText(key, MAX_LABEL_CHARS, '…'), displayValue(inner)]);
  }
  return value === null || value === undefined ? [] : [['value', displayValue(value)]];
}

function KeyValues({ items }: { items: readonly Entry[] }) {
  if (items.length === 0) return null;
  return (
    <dl className="mt-1 space-y-0.5">
      {items.map(([label, value], index) => (
        // Truncated labels can collide, so the position is the key.
        <div key={index} className="flex min-w-0 gap-2">
          <dt className="max-w-[40%] shrink-0 font-medium break-words text-slate-600">{label}:</dt>
          <dd className="min-w-0 break-words text-slate-800">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Bubble({ message, own }: { message: Message; own: boolean }) {
  const notes = [
    message.data.fallback === true ? 'Fallback reply' : null,
    message.data.tier === 'escalation' ? 'Answered by the escalation model' : null,
  ].filter((note) => note !== null);
  return (
    <li className={own ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={
          own
            ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-indigo-50 px-4 py-2.5 text-slate-900 ring-1 ring-indigo-100'
            : 'max-w-[85%] rounded-2xl rounded-bl-sm bg-white px-4 py-2.5 text-slate-900 ring-1 ring-slate-200'
        }
      >
        <p className="text-xs font-medium text-slate-500">
          {own ? 'Assistant' : 'Visitor'} · <time dateTime={message.createdAt.toISOString()}>{formatDateTime(message.createdAt)}</time>
        </p>
        <p className="mt-1 text-sm break-words whitespace-pre-wrap">{message.content}</p>
        {notes.length > 0 ? <p className="mt-1 text-xs text-slate-500">{notes.join(' · ')}</p> : null}
      </div>
    </li>
  );
}

function ToolCallRow({ message }: { message: Message }) {
  const args = message.data.arguments;
  return (
    <li className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
      <p className="font-medium text-slate-700">
        Tool call: <code className="font-mono">{message.toolName}</code>
      </p>
      <KeyValues items={typeof args === 'string' ? [['raw arguments', displayValue(args)]] : entries(args)} />
    </li>
  );
}

function ToolResultRow({ message, run }: { message: Message; run: ToolRunRecord | undefined }) {
  const ok = message.data.ok === true;
  const errorCode = typeof message.data.errorCode === 'string' ? message.data.errorCode : null;
  return (
    <li className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium text-slate-700">
          Tool result: <code className="font-mono">{message.toolName}</code>
        </p>
        {ok ? <Badge tone="success">Succeeded</Badge> : <Badge tone="danger">Failed</Badge>}
        {errorCode ? <code className="font-mono text-red-700">{errorCode}</code> : null}
        {message.data.replayed === true ? <Badge>Replayed earlier result</Badge> : null}
      </div>
      {run?.errorMessage ? <p className="mt-1 text-slate-700">{run.errorMessage}</p> : null}
      {ok && run ? <KeyValues items={entries(run.output)} /> : null}
    </li>
  );
}

function SystemRow({ message }: { message: Message }) {
  const code = typeof message.data.code === 'string' ? ` (${message.data.code})` : '';
  return (
    <li className="text-center text-xs text-slate-500">
      {SYSTEM_EVENTS.get(message.content) ?? `System event: ${displayValue(message.content)}`}
      {code} · {formatDateTime(message.createdAt)}
    </li>
  );
}

export default async function ConversationPage({ params }: Props) {
  const { orgSlug, conversationId } = await params;
  const access = await requireOrgAccess(orgSlug);
  if (!isUuid(conversationId)) notFound();

  const [detail, lead] = await Promise.all([
    getConversationDetail(access.db, access.organization.id, conversationId),
    access.db.run((sql) => getConversationLead(sql, access.organization.id, conversationId)),
  ]);
  if (!detail) notFound();

  const { conversation, contact, messages, toolRuns } = detail;
  const runsById = new Map(toolRuns.map((run) => [run.id, run]));
  const base = `/o/${access.organization.slug}`;
  // What the visitor gave in this conversation comes first; the contact it matched is secondary.
  const visitor = visitorDetails(lead, contact);
  const visitorName = visitor?.details.name ?? (visitor ? 'Visitor' : 'Anonymous visitor');

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-2 text-sm">
        <Link href={`${base}/conversations`} className={linkClass}>
          Conversations
        </Link>
        <span aria-hidden="true" className="px-1.5 text-slate-400">
          /
        </span>
        <span aria-current="page" className="text-slate-600">
          {visitorName}
        </span>
      </nav>
      <PageHeader
        title={visitorName}
        description={`${conversation.agentName} · Web chat · Started ${formatDateTime(conversation.createdAt)}`}
        actions={conversation.status === 'active' ? <Badge tone="success">Active</Badge> : <Badge>Closed</Badge>}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section aria-labelledby="transcript-heading" className="min-w-0">
          <h2 id="transcript-heading" className="mb-3 text-base font-semibold text-slate-900">
            Transcript
          </h2>
          {conversation.messageCount > messages.length ? (
            <p className="mb-3 text-sm text-slate-600">Showing the latest {pluralize(messages.length, 'message')}.</p>
          ) : null}
          {messages.length === 0 ? (
            <EmptyState title="No messages" />
          ) : (
            <ol className="space-y-3">
              {messages.map((message) => {
                switch (message.role) {
                  case 'user':
                    return <Bubble key={message.id} message={message} own={false} />;
                  case 'assistant':
                    return <Bubble key={message.id} message={message} own />;
                  case 'tool_call':
                    return <ToolCallRow key={message.id} message={message} />;
                  case 'tool_result':
                    return (
                      <ToolResultRow
                        key={message.id}
                        message={message}
                        run={message.toolRunId === null ? undefined : runsById.get(message.toolRunId)}
                      />
                    );
                  case 'system':
                    return <SystemRow key={message.id} message={message} />;
                }
              })}
            </ol>
          )}
        </section>

        <aside className="space-y-6">
          <Card className="p-4">
            <h2 className="text-sm font-semibold text-slate-900">Contact</h2>
            {visitor ? (
              <>
                <dl className="mt-2 space-y-1.5 text-sm">
                  <div>
                    <dt className="text-xs text-slate-500">Name</dt>
                    <dd className="break-words text-slate-900">{visitor.details.name ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-500">Phone</dt>
                    <dd className="break-words">
                      {visitor.details.phone ? (
                        <a href={`tel:${visitor.details.phone}`} className={linkClass}>
                          {visitor.details.phone}
                        </a>
                      ) : (
                        '—'
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-500">Email</dt>
                    <dd className="break-words">
                      {visitor.details.email ? (
                        <a href={`mailto:${visitor.details.email}`} className={linkClass}>
                          {visitor.details.email}
                        </a>
                      ) : (
                        '—'
                      )}
                    </dd>
                  </div>
                </dl>
                {visitor.linkedContact ? (
                  <p className="mt-3 border-t border-slate-200 pt-3 text-xs break-words text-slate-600">
                    Linked contact:{' '}
                    {[visitor.linkedContact.name, visitor.linkedContact.phone, visitor.linkedContact.email]
                      .filter((value) => value !== null)
                      .join(' · ')}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="mt-2 text-sm text-slate-600">The visitor has not shared contact details.</p>
            )}
          </Card>

          <Card className="p-4">
            <h2 className="text-sm font-semibold text-slate-900">Details</h2>
            <dl className="mt-2 space-y-1.5 text-sm">
              <div>
                <dt className="text-xs text-slate-500">Messages</dt>
                <dd className="text-slate-900">{conversation.messageCount.toLocaleString('en-US')}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Last activity</dt>
                <dd className="text-slate-900">{formatDateTime(conversation.lastMessageAt)}</dd>
              </div>
              {conversation.closedAt ? (
                <div>
                  <dt className="text-xs text-slate-500">Closed</dt>
                  <dd className="text-slate-900">{formatDateTime(conversation.closedAt)}</dd>
                </div>
              ) : null}
            </dl>
          </Card>

          {conversation.summary ? (
            <Card className="p-4">
              <h2 className="text-sm font-semibold text-slate-900">Summary</h2>
              <p className="mt-1 text-xs text-slate-500">What the assistant remembers of the earlier conversation.</p>
              <p className="mt-2 text-sm break-words whitespace-pre-wrap text-slate-800">{conversation.summary}</p>
            </Card>
          ) : null}
        </aside>
      </div>

      <section aria-labelledby="tool-runs-heading" className="mt-10">
        <h2 id="tool-runs-heading" className="mb-3 text-base font-semibold text-slate-900">
          Tool runs
        </h2>
        {toolRuns.length === 0 ? (
          <EmptyState title="No tool runs" description="The assistant did not use any tools in this conversation." />
        ) : (
          <Card className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
              <caption className="sr-only">Tool runs in this conversation</caption>
              <thead className="bg-slate-50 text-xs font-medium text-slate-600">
                <tr>
                  <th scope="col" className="px-4 py-2.5">
                    Tool
                  </th>
                  <th scope="col" className="px-4 py-2.5">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-2.5">
                    Started
                  </th>
                  <th scope="col" className="px-4 py-2.5">
                    Duration
                  </th>
                  <th scope="col" className="px-4 py-2.5">
                    Error
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {toolRuns.map((run) => {
                  const badge = TOOL_RUN_BADGES[run.status];
                  return (
                    <tr key={run.id} className="align-top">
                      <td className="px-4 py-2.5 font-mono text-xs whitespace-nowrap text-slate-900">{run.toolName}</td>
                      <td className="px-4 py-2.5">
                        <Badge tone={badge.tone}>{badge.label}</Badge>
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-slate-600">{formatDateTime(run.startedAt)}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-slate-600">{formatDuration(run.durationMs)}</td>
                      <td className="min-w-48 px-4 py-2.5 text-slate-700">
                        {run.errorCode ? <code className="font-mono text-xs text-red-700">{run.errorCode}</code> : '—'}
                        {run.errorMessage ? <p className="mt-0.5 text-xs">{run.errorMessage}</p> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}
      </section>
    </>
  );
}
