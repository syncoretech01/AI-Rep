import type { ScopedDb } from '@/server/db/scope';
import { jsonParam, maybeOne, pgTextArray, toDate, toNumber } from '@/server/db/sql';
import type { Sql } from '@/server/db/types';
import { getContact } from '@/server/domain/contacts/service';
import { DomainError, type Channel } from '@/server/domain/types';
import type {
  Conversation,
  ConversationDetail,
  ConversationListItem,
  ConversationStatus,
  Message,
  MessageRole,
  NewMessage,
  ToolRunRecord,
} from './types';

// Column limits from supabase/migrations (conversations, messages).
const MAX_CONTENT_CHARS = 20_000;
const MAX_SUMMARY_CHARS = 8000;
const MAX_TOOL_NAME_CHARS = 64;
const MAX_TOOL_CALL_ID_CHARS = 128;
const PREVIEW_CHARS = 140;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
/** The admin detail view shows at most the latest N messages / tool runs of a conversation. */
const DETAIL_ROW_LIMIT = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Conversation queries alias the table as `c`.
const CONVERSATION_COLUMNS = `c.id, c.organization_id, c.agent_id, c.channel, c.status, c.visitor_id, c.contact_id,
  c.summary, c.summary_through_seq, c.message_count, c.last_message_at, c.created_at, c.closed_at`;
const MESSAGE_COLUMNS =
  'id, seq, organization_id, conversation_id, role, content, tool_name, tool_call_id, tool_run_id, data, created_at';

interface ConversationRow {
  id: string;
  organization_id: string;
  agent_id: string;
  channel: Channel;
  status: ConversationStatus;
  visitor_id: string | null;
  contact_id: string | null;
  summary: string;
  summary_through_seq: string | number;
  message_count: string | number;
  last_message_at: Date | string | null;
  created_at: Date | string;
  closed_at: Date | string | null;
}

interface MessageRow {
  id: string;
  seq: string | number;
  organization_id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  tool_name: string | null;
  tool_call_id: string | null;
  tool_run_id: string | null;
  data: Record<string, unknown>;
  created_at: Date | string;
}

interface ConversationListRow {
  id: string;
  agent_id: string;
  agent_name: string;
  channel: Channel;
  status: ConversationStatus;
  contact_name: string | null;
  message_count: string | number;
  last_message_at: Date | string | null;
  created_at: Date | string;
  preview: string | null;
}

interface ToolRunRow {
  id: string;
  tool_name: string;
  status: ToolRunRecord['status'];
  input: unknown;
  output: unknown;
  error_code: string | null;
  error_message: string | null;
  started_at: Date | string;
  duration_ms: string | number | null;
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function toDateOrNull(value: Date | string | null): Date | null {
  return value === null ? null : toDate(value);
}

function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    organizationId: row.organization_id,
    agentId: row.agent_id,
    channel: row.channel,
    status: row.status,
    visitorId: row.visitor_id,
    contactId: row.contact_id,
    summary: row.summary,
    summaryThroughSeq: toNumber(row.summary_through_seq),
    messageCount: toNumber(row.message_count),
    lastMessageAt: toDateOrNull(row.last_message_at),
    createdAt: toDate(row.created_at),
    closedAt: toDateOrNull(row.closed_at),
  };
}

function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    seq: toNumber(row.seq),
    organizationId: row.organization_id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    toolName: row.tool_name,
    toolCallId: row.tool_call_id,
    toolRunId: row.tool_run_id,
    data: row.data,
    createdAt: toDate(row.created_at),
  };
}

function mapToolRun(row: ToolRunRow): ToolRunRecord {
  return {
    id: row.id,
    toolName: row.tool_name,
    status: row.status,
    input: row.input,
    output: row.output,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: toDate(row.started_at),
    durationMs: row.duration_ms === null ? null : toNumber(row.duration_ms),
  };
}

/** Caps text at `maxChars` without splitting a surrogate pair (Postgres counts code points). */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Model/visitor text may contain NUL, which Postgres text rejects (it would abort the whole turn). */
function storableText(text: string, maxChars: number): string {
  return truncate(text.replaceAll('\u0000', ''), maxChars);
}

// An unescaped `\u0000` or surrogate escape in JSON text (an even run of backslashes may precede it).
const JSONB_UNSAFE_ESCAPE = /(?<!\\)((?:\\\\)*)\\u(0000|d[89a-f][0-9a-f]{2})/g;

/**
 * Serializes message data for jsonb, which rejects the `\u0000` and lone-surrogate escapes JSON.stringify
 * emits (parsed model arguments can contain both, and either would abort the whole turn): NUL is dropped and
 * a lone surrogate becomes U+FFFD. JSON.stringify writes surrogate pairs literally, so every escaped
 * surrogate is a lone one; a literal backslash followed by "u0000" is not an escape and survives.
 */
function storableJson(data: Record<string, unknown>): string {
  return jsonParam(data).replace(JSONB_UNSAFE_ESCAPE, (_match, slashes: string, code: string) =>
    code === '0000' ? slashes : `${slashes}\\ufffd`,
  );
}

/** A non-negative bigint parameter (null when unset); clamped so an out-of-range number cannot fail the cast. */
function bigintParam(value: number | undefined): number | null {
  if (value === undefined || Number.isNaN(value)) return null;
  return Math.min(Math.max(Math.trunc(value), 0), Number.MAX_SAFE_INTEGER);
}

function listLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIST_LIMIT);
}

/** One-line preview of the latest text, at most PREVIEW_CHARS characters. */
function toPreview(text: string | null): string | null {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (flat === '') return null;
  return flat.length <= PREVIEW_CHARS ? flat : `${truncate(flat, PREVIEW_CHARS - 1).trimEnd()}…`;
}

export async function getConversation(
  sql: Sql,
  organizationId: string,
  conversationId: string,
): Promise<Conversation | null> {
  if (!isUuid(organizationId) || !isUuid(conversationId)) return null;
  const row = maybeOne(
    await sql.query<ConversationRow>(
      `select ${CONVERSATION_COLUMNS} from public.conversations c where c.id = $1 and c.organization_id = $2`,
      [conversationId, organizationId],
    ),
  );
  return row ? mapConversation(row) : null;
}

export async function getActiveVisitorConversation(
  sql: Sql,
  params: { organizationId: string; agentId: string; visitorId: string },
): Promise<Conversation | null> {
  const { organizationId, agentId, visitorId } = params;
  if (!isUuid(organizationId) || !isUuid(agentId) || !isUuid(visitorId)) return null;
  const row = maybeOne(
    await sql.query<ConversationRow>(
      `select ${CONVERSATION_COLUMNS} from public.conversations c
       where c.organization_id = $1 and c.agent_id = $2 and c.visitor_id = $3 and c.status = 'active'`,
      [organizationId, agentId, visitorId],
    ),
  );
  return row ? mapConversation(row) : null;
}

/** Race-safe: relies on the partial unique index (agent_id, visitor_id) where status='active'. */
export async function getOrCreateVisitorConversation(
  sql: Sql,
  params: { organizationId: string; agentId: string; channel: Channel; visitorId: string },
): Promise<Conversation> {
  // A concurrent request may create (or close) the visitor's conversation between the
  // lookup and the insert; `do nothing` keeps the transaction usable, so just look again.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await getActiveVisitorConversation(sql, params);
    if (existing) return existing;
    const inserted = maybeOne(
      await sql.query<ConversationRow>(
        `insert into public.conversations as c (organization_id, agent_id, channel, visitor_id)
         values ($1, $2, $3, $4)
         on conflict (agent_id, visitor_id) where status = 'active' and visitor_id is not null do nothing
         returning ${CONVERSATION_COLUMNS}`,
        [params.organizationId, params.agentId, params.channel, params.visitorId],
      ),
    );
    if (inserted) return mapConversation(inserted);
  }
  throw new Error('Visitor conversation lookup did not converge');
}

/** Marks the conversation closed. No-op if it is already closed (or not in this organization). */
export async function closeConversation(sql: Sql, organizationId: string, conversationId: string): Promise<void> {
  if (!isUuid(organizationId) || !isUuid(conversationId)) return;
  await sql.query(
    `update public.conversations set status = 'closed', closed_at = now()
     where id = $1 and organization_id = $2 and status = 'active'`,
    [conversationId, organizationId],
  );
}

/** Inserts a message and bumps conversations.message_count / last_message_at. */
export async function appendMessage(
  sql: Sql,
  organizationId: string,
  conversationId: string,
  message: NewMessage,
): Promise<Message> {
  const toolName = message.toolName ?? null;
  const isToolRole = message.role === 'tool_call' || message.role === 'tool_result';
  if (isToolRole !== (toolName !== null)) {
    throw new Error(`A ${message.role} message ${isToolRole ? 'requires' : 'must not have'} a toolName`);
  }
  if (!isUuid(organizationId) || !isUuid(conversationId)) {
    throw new DomainError('not_found', 'Conversation not found.');
  }

  // One statement: the message is inserted only if the organization's conversation
  // exists, and its counters move in step (the row lock serializes concurrent appends).
  const row = maybeOne(
    await sql.query<MessageRow>(
      `with conversation as (
         update public.conversations
         set message_count = message_count + 1, last_message_at = now()
         where id = $1 and organization_id = $2
         returning id, organization_id
       )
       insert into public.messages
         (organization_id, conversation_id, role, content, tool_name, tool_call_id, tool_run_id, data)
       select organization_id, id, $3::text, $4::text, $5::text, $6::text, $7::uuid, $8::jsonb
       from conversation
       returning ${MESSAGE_COLUMNS}`,
      [
        conversationId,
        organizationId,
        message.role,
        storableText(message.content ?? '', MAX_CONTENT_CHARS),
        toolName === null ? null : storableText(toolName, MAX_TOOL_NAME_CHARS),
        message.toolCallId ? storableText(message.toolCallId, MAX_TOOL_CALL_ID_CHARS) : null,
        message.toolRunId ?? null,
        storableJson(message.data ?? {}),
      ],
    ),
  );
  if (!row) throw new DomainError('not_found', 'Conversation not found.');
  return mapMessage(row);
}

/** Chronological (seq ascending). `limit` keeps the LAST n matching messages. */
export async function listMessages(
  sql: Sql,
  organizationId: string,
  conversationId: string,
  options: { roles?: MessageRole[]; afterSeq?: number; limit?: number } = {},
): Promise<Message[]> {
  if (!isUuid(organizationId) || !isUuid(conversationId)) return [];
  const rows = await sql.query<MessageRow>(
    `select ${MESSAGE_COLUMNS} from (
       select ${MESSAGE_COLUMNS} from public.messages
       where organization_id = $1 and conversation_id = $2
         and ($3::text[] is null or role = any($3::text[]))
         and ($4::bigint is null or seq > $4::bigint)
       order by seq desc
       limit $5::bigint
     ) latest
     order by seq`,
    [
      organizationId,
      conversationId,
      options.roles === undefined ? null : pgTextArray(options.roles),
      bigintParam(options.afterSeq),
      bigintParam(options.limit),
    ],
  );
  return rows.map(mapMessage);
}

/** The last `limit` user/assistant messages, chronological (tool and system rows excluded). */
export async function listRecentTextMessages(
  sql: Sql,
  organizationId: string,
  conversationId: string,
  limit: number,
): Promise<Message[]> {
  return listMessages(sql, organizationId, conversationId, { roles: ['user', 'assistant'], limit });
}

/** Atomically claims the conversation for one turn. false if another turn holds an unexpired lock. */
export async function tryAcquireTurnLock(
  sql: Sql,
  organizationId: string,
  conversationId: string,
  ttlSeconds: number,
): Promise<boolean> {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new RangeError('ttlSeconds must be a positive number');
  if (!isUuid(organizationId) || !isUuid(conversationId)) return false;
  // Concurrent claims serialize on the row lock; the loser re-checks the committed lock and matches nothing.
  const rows = await sql.query(
    `update public.conversations
     set turn_locked_until = now() + make_interval(secs => $3::double precision)
     where id = $1 and organization_id = $2 and (turn_locked_until is null or turn_locked_until <= now())
     returning id`,
    [conversationId, organizationId, ttlSeconds],
  );
  return rows.length > 0;
}

export async function releaseTurnLock(sql: Sql, organizationId: string, conversationId: string): Promise<void> {
  if (!isUuid(organizationId) || !isUuid(conversationId)) return;
  await sql.query(
    `update public.conversations set turn_locked_until = null
     where id = $1 and organization_id = $2 and turn_locked_until is not null`,
    [conversationId, organizationId],
  );
}

/** Monotonic: only applies when throughSeq > current summary_through_seq. */
export async function updateSummary(
  sql: Sql,
  organizationId: string,
  conversationId: string,
  summary: string,
  throughSeq: number,
): Promise<void> {
  if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) throw new RangeError('throughSeq must be a sequence number');
  if (!isUuid(organizationId) || !isUuid(conversationId)) return;
  await sql.query(
    `update public.conversations set summary = $3, summary_through_seq = $4
     where id = $1 and organization_id = $2 and summary_through_seq < $4`,
    [conversationId, organizationId, storableText(summary.trim(), MAX_SUMMARY_CHARS), throughSeq],
  );
}

/** Newest activity first. Works under user scope (RLS) and service scope alike. */
export async function listConversations(
  db: ScopedDb,
  organizationId: string,
  options: { limit?: number } = {},
): Promise<ConversationListItem[]> {
  if (!isUuid(organizationId)) return [];
  const rows = await db.run((sql) =>
    sql.query<ConversationListRow>(
      // Label: what the visitor gave in this conversation (the lead snapshot) when they gave anything, else the
      // linked contact. Contacts are never renamed by visitors, so a visitor who gave someone else's phone number
      // must not be listed under that person's name. Same rule as visitorDetails() in contacts/service.ts.
      `select c.id, c.agent_id, a.name as agent_name, c.channel, c.status,
              case when coalesce(l.captured_name, l.captured_phone, l.captured_email) is not null
                   then l.captured_name else ct.name end as contact_name,
              c.message_count, c.last_message_at, c.created_at, latest.preview
       from public.conversations c
       join public.agents a on a.id = c.agent_id and a.organization_id = c.organization_id
       left join public.contacts ct on ct.id = c.contact_id and ct.organization_id = c.organization_id
       left join public.leads l on l.conversation_id = c.id and l.organization_id = c.organization_id
       left join lateral (
         select left(m.content, 400) as preview
         from public.messages m
         where m.conversation_id = c.id and m.organization_id = c.organization_id
           and m.role in ('user', 'assistant')
         order by m.seq desc
         limit 1
       ) latest on true
       where c.organization_id = $1
       order by c.last_message_at desc nulls last, c.created_at desc, c.id desc
       limit $2`,
      [organizationId, listLimit(options.limit)],
    ),
  );
  return rows.map((row) => ({
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    channel: row.channel,
    status: row.status,
    contactName: row.contact_name,
    messageCount: toNumber(row.message_count),
    lastMessageAt: toDateOrNull(row.last_message_at),
    createdAt: toDate(row.created_at),
    preview: toPreview(row.preview),
  }));
}

/** Conversation, contact, transcript (incl. tool rows) and tool audit trail; null outside the organization. */
export async function getConversationDetail(
  db: ScopedDb,
  organizationId: string,
  conversationId: string,
): Promise<ConversationDetail | null> {
  if (!isUuid(organizationId) || !isUuid(conversationId)) return null;
  return db.run(async (sql) => {
    const row = maybeOne(
      await sql.query<ConversationRow & { agent_name: string }>(
        `select ${CONVERSATION_COLUMNS}, a.name as agent_name
         from public.conversations c
         join public.agents a on a.id = c.agent_id and a.organization_id = c.organization_id
         where c.id = $1 and c.organization_id = $2`,
        [conversationId, organizationId],
      ),
    );
    if (!row) return null;

    const conversation = { ...mapConversation(row), agentName: row.agent_name };
    const contact = conversation.contactId === null ? null : await getContact(sql, organizationId, conversation.contactId);
    const messages = await listMessages(sql, organizationId, conversationId, { limit: DETAIL_ROW_LIMIT });
    const toolRuns = await sql.query<ToolRunRow>(
      `select id, tool_name, status, input, output, error_code, error_message, started_at, duration_ms from (
         select id, tool_name, status, input, output, error_code, error_message, started_at, duration_ms
         from public.tool_runs
         where organization_id = $1 and conversation_id = $2
         order by started_at desc, id desc
         limit $3
       ) latest
       order by started_at, id`,
      [organizationId, conversationId, DETAIL_ROW_LIMIT],
    );
    return { conversation, contact, messages, toolRuns: toolRuns.map(mapToolRun) };
  });
}
