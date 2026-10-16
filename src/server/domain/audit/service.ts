import { jsonParam } from '@/server/db/sql';
import type { Sql } from '@/server/db/types';

/** Who did what to which record. Keep metadata small and free of secrets and contact details. */
export interface AuditEntry {
  organizationId: string;
  actorType: 'user' | 'agent' | 'system';
  actorId?: string | null;
  /** Dotted verb, e.g. 'organization.created', 'agent.settings_updated', 'tool.captureLead'. */
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Appends an audit log row inside the caller's transaction. Must run with
 * service scope: `audit_logs` has no user write grant or policy, so audit rows
 * cannot be forged or removed from the admin UI.
 */
export async function recordAudit(sql: Sql, entry: AuditEntry): Promise<void> {
  await sql.query(
    `insert into public.audit_logs (organization_id, actor_type, actor_id, action, target_type, target_id, metadata)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      entry.organizationId,
      entry.actorType,
      entry.actorId ?? null,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      jsonParam(entry.metadata ?? {}),
    ],
  );
}
