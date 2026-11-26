import { randomUUID } from 'node:crypto';
import { isUuid, jsonParam, maybeOne, toDate, toNumber, truncateText } from '@/server/db/sql';
import type { Sql } from '@/server/db/types';
import type { Channel } from '@/server/domain/types';

/**
 * Durable operation records for tools with EXTERNAL side effects (ARCHITECTURE.md "Tool execution safety").
 *
 * State machine (app_private.tool_operations.status):
 *
 *   (no row) ──claim──▶ in_progress ──handler ok──────────────▶ succeeded   (repeats replay the stored result)
 *                          │ ├─────nothing was sent───────────▶ not_attempted ─┐
 *                          │ ├─────provider refused it────────▶ failed ────────┤ may be claimed again
 *                          │ └─────sent, result unconfirmed───▶ unknown        │
 *                          └─claim lapsed (worker died)───────▶ unknown ◀──────┘ never claimed automatically:
 *                                                                               reconciliation resolves it
 *
 * The claim is one atomic statement on the unique (organization_id, operation_key), so two workers can never both
 * execute an operation, and every transition out of in_progress is fenced by the claim token.
 */

export type OperationStatus = 'not_attempted' | 'in_progress' | 'succeeded' | 'failed' | 'unknown';

export interface OperationIdentity {
  organizationId: string;
  agentId: string;
  conversationId: string | null;
  channel: Channel;
  toolName: string;
  operationKey: string;
}

export interface OperationRecord {
  id: string;
  status: OperationStatus;
  attempts: number;
  result: unknown;
  externalReference: string | null;
  errorCode: string | null;
  claimedUntil: Date | null;
  updatedAt: Date;
}

export type ClaimResult =
  /** This worker owns the operation now and must settle it with `token`. */
  | { claimed: true; id: string; attempt: number; token: string }
  /** Someone else's live claim, a success to replay, or an unknown outcome awaiting reconciliation. */
  | { claimed: false; existing: OperationRecord };

const MAX_REFERENCE_CHARS = 200;
const MAX_ERROR_CODE_CHARS = 64;

interface OperationRow {
  id: string;
  status: OperationStatus;
  attempts: string | number;
  result: unknown;
  external_reference: string | null;
  error_code: string | null;
  claimed_until: Date | string | null;
  updated_at: Date | string;
}

const COLUMNS = 'id, status, attempts, result, external_reference, error_code, claimed_until, updated_at';

function mapRow(row: OperationRow): OperationRecord {
  return {
    id: row.id,
    status: row.status,
    attempts: toNumber(row.attempts),
    result: row.result,
    externalReference: row.external_reference,
    errorCode: row.error_code,
    claimedUntil: row.claimed_until === null ? null : toDate(row.claimed_until),
    updatedAt: toDate(row.updated_at),
  };
}

/**
 * Claims the operation for one execution, atomically: a new operation, or one that was not attempted or failed,
 * becomes in_progress under a fresh claim token. A claim that lapsed (its worker died mid-call) turns into
 * `unknown` here — the call may have been sent — and is NOT claimed.
 */
export async function claimOperation(
  sql: Sql,
  identity: OperationIdentity,
  input: unknown,
  leaseSeconds: number,
): Promise<ClaimResult> {
  const token = randomUUID();
  const claimed = maybeOne(
    await sql.query<{ id: string; attempts: string | number }>(
      `insert into app_private.tool_operations as o
         (organization_id, agent_id, conversation_id, tool_name, operation_key, status, claim_token, claimed_until, input,
          last_claim_token)
       values ($1, $2, $3, $4, $5, 'in_progress', $6::uuid, now() + make_interval(secs => $7::double precision), $8::jsonb,
               $6::uuid)
       on conflict (organization_id, operation_key) do update
         set status = 'in_progress', claim_token = excluded.claim_token, claimed_until = excluded.claimed_until,
             last_claim_token = excluded.claim_token,
             attempts = o.attempts + 1, error_code = null, input = excluded.input
         where o.status in ('not_attempted', 'failed')
       returning o.id, o.attempts`,
      [
        identity.organizationId,
        identity.agentId,
        identity.conversationId,
        identity.toolName,
        identity.operationKey,
        token,
        leaseSeconds,
        jsonParam(input ?? {}),
      ],
    ),
  );
  if (claimed) return { claimed: true, id: claimed.id, attempt: toNumber(claimed.attempts), token };

  // Not claimable: a lapsed claim's outcome is unknown from now on.
  await sql.query(
    `update app_private.tool_operations
     set status = 'unknown', claim_token = null, claimed_until = null, error_code = 'claim_expired'
     where organization_id = $1 and operation_key = $2 and status = 'in_progress' and claimed_until <= now()`,
    [identity.organizationId, identity.operationKey],
  );
  const existing = maybeOne(
    await sql.query<OperationRow>(
      `select ${COLUMNS} from app_private.tool_operations where organization_id = $1 and operation_key = $2`,
      [identity.organizationId, identity.operationKey],
    ),
  );
  if (!existing) throw new Error('tool operation vanished during claim');
  return { claimed: false, existing: mapRow(existing) };
}

export type Settlement =
  | { status: 'succeeded'; result: unknown; externalReference?: string }
  | { status: 'not_attempted' | 'failed' | 'unknown'; errorCode: string };

/**
 * Records the outcome of a claimed execution, fenced by the claim token. A worker whose lease lapsed (another request
 * marked the operation `unknown` / claim_expired) still records what it learned, as long as nobody re-claimed it
 * since: its last_claim_token still matches. Returns false when the claim was superseded.
 */
export async function settleOperation(
  sql: Sql,
  organizationId: string,
  claim: { id: string; token: string },
  settlement: Settlement,
): Promise<boolean> {
  const succeeded = settlement.status === 'succeeded';
  const rows = await sql.query(
    `update app_private.tool_operations
     set status = $4, result = $5::jsonb, external_reference = $6, error_code = $7,
         claim_token = null, claimed_until = null
     where id = $1 and organization_id = $2
       and ((status = 'in_progress' and claim_token = $3::uuid)
         or (status = 'unknown' and error_code = 'claim_expired' and last_claim_token = $3::uuid))
     returning id`,
    [
      claim.id,
      organizationId,
      claim.token,
      settlement.status,
      succeeded ? jsonParam(settlement.result ?? null) : null,
      succeeded && settlement.externalReference ? truncateText(settlement.externalReference, MAX_REFERENCE_CHARS) : null,
      succeeded ? null : truncateText(settlement.errorCode, MAX_ERROR_CODE_CHARS),
    ],
  );
  return rows.length > 0;
}

/** Operations that need attention: unknown outcomes and claims that have lapsed. Oldest first. */
export async function listUnresolvedOperations(sql: Sql, organizationId: string, limit = 100): Promise<OperationRecord[]> {
  if (!isUuid(organizationId)) return [];
  const rows = await sql.query<OperationRow>(
    `select ${COLUMNS} from app_private.tool_operations
     where organization_id = $1 and (status = 'unknown' or (status = 'in_progress' and claimed_until <= now()))
     order by updated_at, id
     limit $2`,
    [organizationId, Math.min(Math.max(Math.trunc(limit), 1), 500)],
  );
  return rows.map(mapRow);
}

/**
 * Reconciliation: someone (an operator, or a provider status check in a later phase) established what really
 * happened to an `unknown` operation. A succeeded one is replayed from now on; a failed one may be retried.
 */
export async function resolveUnknownOperation(
  sql: Sql,
  organizationId: string,
  operationId: string,
  resolution: { status: 'succeeded'; result: unknown; externalReference?: string } | { status: 'failed'; errorCode: string },
): Promise<boolean> {
  if (!isUuid(organizationId) || !isUuid(operationId)) return false;
  const succeeded = resolution.status === 'succeeded';
  const rows = await sql.query(
    `update app_private.tool_operations
     set status = $3, result = $4::jsonb, external_reference = coalesce($5, external_reference), error_code = $6,
         reconciled_at = now()
     where id = $1 and organization_id = $2 and status = 'unknown'
     returning id`,
    [
      operationId,
      organizationId,
      resolution.status,
      succeeded ? jsonParam(resolution.result ?? null) : null,
      succeeded && resolution.externalReference ? truncateText(resolution.externalReference, MAX_REFERENCE_CHARS) : null,
      succeeded ? null : truncateText(resolution.errorCode, MAX_ERROR_CODE_CHARS),
    ],
  );
  return rows.length > 0;
}
