'use server';

import {
  STALE_PROCESSING_MS,
  formString,
  invalidFormState,
  zodFieldErrors,
  type ActionState,
} from '@/server/admin/forms';
import { getAppServices } from '@/server/app-services';
import {
  adminActionFailed,
  authorizeAdminAction,
  recordAdminAudit,
  revalidateAdminPages,
  type OrgAccess,
} from '@/server/auth/org-access';
import { isUuid } from '@/server/db/sql';
import { deleteKnowledgeSource, ingestTextSource, reindexKnowledgeSource } from '@/server/domain/knowledge/ingestion';
import { decodeKnowledgeFile, textSourceInputSchema, validateKnowledgeFile } from '@/server/domain/knowledge/schemas';
import type { KnowledgeSource } from '@/server/domain/knowledge/types';

/*
 * Knowledge actions. Ingestion is synchronous: the source is chunked and embedded while the request runs, and
 * the result ('ready' or 'failed' with a reason) is reported back. Writes run under USER scope (RLS: owners
 * and admins only) and are audited through service scope. `sourceId` is a bound argument the browser sends
 * back, so it can be any value: a non-UUID names no source.
 */

const NOT_FOUND_STATE: ActionState = { status: 'error', message: 'Knowledge source not found.' };

function fileError(message: string): ActionState {
  return { status: 'error', message, fieldErrors: { file: [message] } };
}

/** The empty "All agents" option means a source shared by every agent. */
function scopeAgentId(formData: FormData): string | null {
  const value = formString(formData, 'agentId');
  return value === '' ? null : value;
}

function defaultTitle(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/** Outcome message: a failed source is kept (it can be retried), so the save itself succeeded. */
function ingestedState(source: KnowledgeSource): ActionState {
  if (source.status === 'ready') {
    return { status: 'success', message: `Added "${source.title}". The assistant can use it now.` };
  }
  return {
    status: 'error',
    message: `"${source.title}" was saved but could not be processed: ${source.error ?? 'Processing failed.'} You can retry it from the list.`,
  };
}

async function auditCreated(access: OrgAccess, source: KnowledgeSource): Promise<void> {
  await recordAdminAudit(access, {
    action: 'knowledge_source.created',
    targetType: 'knowledge_source',
    targetId: source.id,
    metadata: { kind: source.kind, status: source.status, agentId: source.agentId },
  });
}

export async function addTextSourceAction(
  orgSlug: string,
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const authorization = await authorizeAdminAction(orgSlug);
  if (!authorization.ok) return authorization.state;
  const { access } = authorization;

  const parsed = textSourceInputSchema.safeParse({
    title: formString(formData, 'title'),
    text: formString(formData, 'text'),
    agentId: scopeAgentId(formData),
  });
  if (!parsed.success) return invalidFormState(parsed.error);

  const { embedder, logger } = getAppServices();
  let source: KnowledgeSource;
  try {
    source = await ingestTextSource(
      access.db,
      embedder,
      { ...parsed.data, organizationId: access.organization.id, kind: 'text', createdBy: access.user.id },
      { logger },
    );
    await auditCreated(access, source);
  } catch (error) {
    return adminActionFailed(access, 'knowledge_source.created', error);
  }
  revalidateAdminPages();
  return ingestedState(source);
}

export async function uploadFileSourceAction(
  orgSlug: string,
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const authorization = await authorizeAdminAction(orgSlug);
  if (!authorization.ok) return authorization.state;
  const { access } = authorization;

  const file = formData.get('file');
  if (file === null || typeof file === 'string' || (file.size === 0 && file.name === '')) {
    return fileError('Choose a file to upload.');
  }
  // Metadata first: nothing is read from a file with the wrong type or size.
  const check = validateKnowledgeFile({ name: file.name, type: file.type, size: file.size });
  if (!check.ok) return fileError(check.message);
  const decoded = decodeKnowledgeFile(new Uint8Array(await file.arrayBuffer()));
  if (!decoded.ok) return fileError(decoded.message);

  const fileName = file.name.trim();
  const parsed = textSourceInputSchema.safeParse({
    title: formString(formData, 'title').trim() || defaultTitle(fileName),
    text: decoded.text,
    agentId: scopeAgentId(formData),
  });
  if (!parsed.success) {
    // Problems with the decoded text belong to the file input.
    const { text, ...fieldErrors } = zodFieldErrors(parsed.error);
    return {
      status: 'error',
      message: 'Please correct the highlighted fields.',
      fieldErrors: text ? { ...fieldErrors, file: text } : fieldErrors,
    };
  }

  const { embedder, logger } = getAppServices();
  let source: KnowledgeSource;
  try {
    source = await ingestTextSource(
      access.db,
      embedder,
      {
        ...parsed.data,
        organizationId: access.organization.id,
        kind: 'file',
        createdBy: access.user.id,
        file: { name: fileName, mimeType: check.mimeType, byteSize: file.size },
      },
      { logger },
    );
    await auditCreated(access, source);
  } catch (error) {
    return adminActionFailed(access, 'knowledge_source.created', error);
  }
  revalidateAdminPages();
  return ingestedState(source);
}

export async function deleteSourceAction(
  orgSlug: string,
  sourceId: string,
  _previous: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  const authorization = await authorizeAdminAction(orgSlug);
  if (!authorization.ok) return authorization.state;
  const { access } = authorization;
  if (!isUuid(sourceId)) return NOT_FOUND_STATE;

  try {
    const deleted = await deleteKnowledgeSource(access.db, access.organization.id, sourceId);
    if (!deleted) return NOT_FOUND_STATE;
    await recordAdminAudit(access, {
      action: 'knowledge_source.deleted',
      targetType: 'knowledge_source',
      targetId: sourceId,
    });
  } catch (error) {
    return adminActionFailed(access, 'knowledge_source.deleted', error);
  }
  revalidateAdminPages();
  return { status: 'success', message: 'Deleted.' };
}

export async function retrySourceAction(
  orgSlug: string,
  sourceId: string,
  _previous: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  const authorization = await authorizeAdminAction(orgSlug);
  if (!authorization.ok) return authorization.state;
  const { access } = authorization;
  if (!isUuid(sourceId)) return NOT_FOUND_STATE;

  const { embedder, logger } = getAppServices();
  let source: KnowledgeSource;
  try {
    // Retryability is checked inside the claiming UPDATE (not read-then-check), so two tabs or admins retrying at
    // once cannot both re-embed — and pay for — the same source; the loser gets a 'conflict' message.
    source = await reindexKnowledgeSource(access.db, embedder, access.organization.id, sourceId, {
      logger,
      onlyIfRetryable: { staleProcessingMs: STALE_PROCESSING_MS },
    });
    await recordAdminAudit(access, {
      action: 'knowledge_source.reindexed',
      targetType: 'knowledge_source',
      targetId: source.id,
      metadata: { status: source.status },
    });
  } catch (error) {
    return adminActionFailed(access, 'knowledge_source.reindexed', error);
  }
  revalidateAdminPages();
  return source.status === 'ready'
    ? { status: 'success', message: 'Processed.' }
    : { status: 'error', message: source.error ?? 'Processing failed.' };
}
