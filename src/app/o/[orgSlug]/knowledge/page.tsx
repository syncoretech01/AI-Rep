import type { Metadata } from 'next';
import { formatBytes, formatDateTime, pluralize } from '@/components/admin/format';
import { AddTextSourceForm, KnowledgeSourceActions, UploadSourceForm } from '@/components/admin/KnowledgeForms';
import { Badge, Card, EmptyState, PageHeader, ReadOnlyNotice, Section, type BadgeTone } from '@/components/admin/ui';
import { isRetryableSource } from '@/server/admin/forms';
import { requireOrgAccess } from '@/server/auth/org-access';
import { listAgents } from '@/server/domain/agents/repository';
import { listKnowledgeSources } from '@/server/domain/knowledge/ingestion';
import {
  ALLOWED_KNOWLEDGE_EXTENSIONS,
  MAX_KNOWLEDGE_FILE_BYTES,
  MAX_KNOWLEDGE_TEXT_CHARS,
} from '@/server/domain/knowledge/schemas';
import type { KnowledgeSource, KnowledgeSourceStatus } from '@/server/domain/knowledge/types';
import { addTextSourceAction, deleteSourceAction, retrySourceAction, uploadFileSourceAction } from './actions';

export const metadata: Metadata = { title: 'Knowledge' };
// Adding knowledge embeds it while the Server Action runs.
export const maxDuration = 60;

type Props = { params: Promise<{ orgSlug: string }> };

const STATUS_BADGES: Record<KnowledgeSourceStatus, { label: string; tone: BadgeTone }> = {
  ready: { label: 'Ready', tone: 'success' },
  processing: { label: 'Processing', tone: 'info' },
  pending: { label: 'Pending', tone: 'info' },
  failed: { label: 'Failed', tone: 'danger' },
};

const FILE_ACCEPT = [...ALLOWED_KNOWLEDGE_EXTENSIONS, 'text/plain', 'text/markdown'].join(',');

/** Ids of sources the Retry button applies to (failed, or interrupted while processing). */
function retryableSourceIds(sources: readonly KnowledgeSource[]): Set<string> {
  const now = new Date();
  return new Set(sources.filter((source) => isRetryableSource(source, now)).map((source) => source.id));
}

function describeKind(source: KnowledgeSource): string {
  if (source.kind !== 'file') return 'Text';
  const size = source.byteSize === null ? '' : ` (${formatBytes(source.byteSize)})`;
  return `File: ${source.fileName ?? 'upload'}${size}`;
}

export default async function KnowledgePage({ params }: Props) {
  const { orgSlug } = await params;
  const access = await requireOrgAccess(orgSlug);
  const organizationId = access.organization.id;
  const slug = access.organization.slug;

  const [agents, sources] = await Promise.all([
    access.db.run((sql) => listAgents(sql, organizationId)),
    listKnowledgeSources(access.db, organizationId),
  ]);
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
  const agentOptions = agents.map(({ id, name }) => ({ id, name }));
  const retryable = retryableSourceIds(sources);

  return (
    <>
      <PageHeader
        title="Knowledge"
        description="What your assistants answer from: services, prices, policies and FAQs. They never make up answers that are not here."
      />

      {access.isAdmin ? (
        <div className="mb-10 grid gap-6 lg:grid-cols-2">
          <Section title="Add text" description="Paste or type information.">
            <AddTextSourceForm
              action={addTextSourceAction.bind(null, slug)}
              agents={agentOptions}
              maxTextChars={MAX_KNOWLEDGE_TEXT_CHARS}
            />
          </Section>
          <Section title="Upload a file" description="Plain text (.txt) or Markdown (.md).">
            <UploadSourceForm
              action={uploadFileSourceAction.bind(null, slug)}
              agents={agentOptions}
              maxFileBytes={MAX_KNOWLEDGE_FILE_BYTES}
              accept={FILE_ACCEPT}
            />
          </Section>
        </div>
      ) : (
        <ReadOnlyNotice />
      )}

      <section aria-labelledby="sources-heading">
        <h2 id="sources-heading" className="mb-3 text-base font-semibold text-slate-900">
          Sources
        </h2>
        {sources.length === 0 ? (
          <EmptyState
            title="No knowledge yet"
            description="Add your services, prices and frequently asked questions so the assistant can answer visitors."
          />
        ) : (
          <Card>
            <ul className="divide-y divide-slate-200">
              {sources.map((source) => {
                const badge = STATUS_BADGES[source.status];
                const scope =
                  source.agentId === null ? 'All agents' : (agentNames.get(source.agentId) ?? 'Unknown agent');
                const interrupted = source.status !== 'failed' && retryable.has(source.id);
                return (
                  <li
                    key={source.id}
                    className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-6"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium break-words text-slate-900">{source.title}</p>
                        <Badge tone={badge.tone}>{badge.label}</Badge>
                      </div>
                      <p className="mt-1 text-sm text-slate-600">
                        {scope} · {describeKind(source)}
                        {source.status === 'ready' ? ` · ${pluralize(source.chunkCount, 'chunk')}` : ''} · Added{' '}
                        {formatDateTime(source.createdAt)}
                      </p>
                      {source.status === 'failed' ? (
                        <p className="mt-1 text-sm text-red-700">{source.error ?? 'Processing failed.'}</p>
                      ) : null}
                      {interrupted ? (
                        <p className="mt-1 text-sm text-amber-800">
                          Processing was interrupted. Retry to finish it.
                        </p>
                      ) : null}
                    </div>
                    {access.isAdmin ? (
                      <KnowledgeSourceActions
                        title={source.title}
                        retryAction={retryable.has(source.id) ? retrySourceAction.bind(null, slug, source.id) : null}
                        deleteAction={deleteSourceAction.bind(null, slug, source.id)}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </section>
    </>
  );
}
