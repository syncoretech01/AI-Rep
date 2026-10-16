import type { z } from 'zod';
import { jsonParam, maybeOne, one, toDate } from '@/server/db/sql';
import type { Sql } from '@/server/db/types';
import { DomainError, type Channel } from '@/server/domain/types';
import { WIDGET_KEY_PATTERN } from '@/shared/widget-protocol';
import { DEFAULT_AGENT_SETTINGS, agentSettingsSchema, parseLeadCapture, type AgentSettings } from './schemas';
import type { Agent, AgentChannel, AgentStatus } from './types';
import { generateWidgetKey } from './widget-key';

/**
 * Agents and their web chat channel. Functions run inside the caller's
 * transaction: under user scope RLS applies (members read, owners/admins
 * write); under service scope the explicit organization filters are the guard.
 *
 * Widget keys are one namespace across all tenants, so only the server writes
 * them: API roles may toggle a channel but never insert one or set its key (a
 * tenant could otherwise claim another tenant's retired key). Creating the
 * channel and rotating its key therefore need SERVICE scope, after the caller
 * has checked owner/admin; under user scope both fail with 42501.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AGENT_COLUMNS =
  'id, organization_id, name, status, greeting, language, timezone, instructions, lead_capture, created_at, updated_at';
const CHANNEL_COLUMNS = 'id, organization_id, agent_id, channel, enabled, public_key, created_at, updated_at';

interface AgentRow {
  id: string;
  organization_id: string;
  name: string;
  status: AgentStatus;
  greeting: string;
  language: string;
  timezone: string;
  instructions: string;
  lead_capture: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ChannelRow {
  id: string;
  organization_id: string;
  agent_id: string;
  channel: Channel;
  enabled: boolean;
  public_key: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PublishedWidgetRow extends AgentRow {
  channel_id: string;
  channel: Channel;
  enabled: boolean;
  public_key: string | null;
  channel_created_at: Date | string;
  channel_updated_at: Date | string;
}

export interface PublishedWidget {
  channel: AgentChannel;
  agent: Agent;
}

/** Ids may come from URLs or forms: malformed ones mean "not found", not a Postgres cast error. */
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function agentNotFound(): DomainError {
  return new DomainError('not_found', 'Agent not found.');
}

/** Typed input is re-validated here: the timezone and lead capture rules are not database constraints. */
function validated<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new DomainError('invalid', result.error.issues[0]?.message ?? 'Invalid agent settings.');
}

function mapAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    status: row.status,
    greeting: row.greeting,
    language: row.language,
    timezone: row.timezone,
    instructions: row.instructions,
    leadCapture: parseLeadCapture(row.lead_capture),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapChannel(row: ChannelRow): AgentChannel {
  return {
    id: row.id,
    organizationId: row.organization_id,
    agentId: row.agent_id,
    channel: row.channel,
    enabled: row.enabled,
    publicKey: row.public_key,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

const newAgentSchema = agentSettingsSchema.partial().required({ name: true });

export async function insertAgent(
  sql: Sql,
  organizationId: string,
  input: { name: string } & Partial<AgentSettings>,
): Promise<Agent> {
  if (!isUuid(organizationId)) throw new DomainError('not_found', 'Organization not found.');
  const settings = validated(newAgentSchema, input);
  const defaults = DEFAULT_AGENT_SETTINGS;
  const rows = await sql.query<AgentRow>(
    `insert into public.agents
       (organization_id, name, status, greeting, language, timezone, instructions, lead_capture)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     returning ${AGENT_COLUMNS}`,
    [
      organizationId,
      settings.name,
      settings.status ?? defaults.status,
      settings.greeting ?? defaults.greeting,
      settings.language ?? defaults.language,
      settings.timezone ?? defaults.timezone,
      settings.instructions ?? defaults.instructions,
      jsonParam(settings.leadCapture ?? defaults.leadCapture),
    ],
  );
  return mapAgent(one(rows, 'agent'));
}

export async function getAgent(sql: Sql, organizationId: string, agentId: string): Promise<Agent | null> {
  if (!isUuid(organizationId) || !isUuid(agentId)) return null;
  const row = maybeOne(
    await sql.query<AgentRow>(`select ${AGENT_COLUMNS} from public.agents where id = $1 and organization_id = $2`, [
      agentId,
      organizationId,
    ]),
  );
  return row ? mapAgent(row) : null;
}

/** Oldest first. */
export async function listAgents(sql: Sql, organizationId: string): Promise<Agent[]> {
  if (!isUuid(organizationId)) return [];
  const rows = await sql.query<AgentRow>(
    `select ${AGENT_COLUMNS} from public.agents where organization_id = $1 order by created_at, id`,
    [organizationId],
  );
  return rows.map(mapAgent);
}

export async function updateAgentSettings(
  sql: Sql,
  organizationId: string,
  agentId: string,
  settings: AgentSettings,
): Promise<Agent> {
  if (!isUuid(organizationId) || !isUuid(agentId)) throw agentNotFound();
  const valid = validated(agentSettingsSchema, settings);
  const row = maybeOne(
    await sql.query<AgentRow>(
      `update public.agents
       set name = $3, status = $4, greeting = $5, language = $6, timezone = $7, instructions = $8,
           lead_capture = $9::jsonb
       where id = $1 and organization_id = $2
       returning ${AGENT_COLUMNS}`,
      [
        agentId,
        organizationId,
        valid.name,
        valid.status,
        valid.greeting,
        valid.language,
        valid.timezone,
        valid.instructions,
        jsonParam(valid.leadCapture),
      ],
    ),
  );
  // No row: unknown agent, another organization's agent, or (under RLS) not an owner/admin.
  if (!row) throw agentNotFound();
  return mapAgent(row);
}

export async function getWebChatChannel(sql: Sql, organizationId: string, agentId: string): Promise<AgentChannel | null> {
  if (!isUuid(organizationId) || !isUuid(agentId)) return null;
  const row = maybeOne(
    await sql.query<ChannelRow>(
      `select ${CHANNEL_COLUMNS} from public.agent_channels
       where organization_id = $1 and agent_id = $2 and channel = 'web_chat'`,
      [organizationId, agentId],
    ),
  );
  return row ? mapChannel(row) : null;
}

/**
 * Returns the agent's web chat channel, creating it (disabled, with a fresh widget key) when missing.
 * Creating needs service scope.
 */
export async function ensureWebChatChannel(sql: Sql, organizationId: string, agentId: string): Promise<AgentChannel> {
  if (!isUuid(organizationId) || !isUuid(agentId)) throw agentNotFound();
  const existing = await getWebChatChannel(sql, organizationId, agentId);
  if (existing) return existing;

  // Selecting the agent inside the insert turns "not this organization's agent" into
  // zero rows instead of a foreign-key error that would abort the caller's transaction.
  const inserted = maybeOne(
    await sql.query<ChannelRow>(
      `insert into public.agent_channels (organization_id, agent_id, channel, enabled, public_key)
       select a.organization_id, a.id, 'web_chat', false, $3::text
       from public.agents a
       where a.id = $2 and a.organization_id = $1
       on conflict (agent_id, channel) do nothing
       returning ${CHANNEL_COLUMNS}`,
      [organizationId, agentId, generateWidgetKey()],
    ),
  );
  if (inserted) return mapChannel(inserted);

  // A concurrent call created it first, or the agent is not in this organization.
  const channel = await getWebChatChannel(sql, organizationId, agentId);
  if (!channel) throw agentNotFound();
  return channel;
}

/**
 * Publishes or unpublishes the agent's web chat widget. Only toggles an existing channel (see
 * ensureWebChatChannel), so owners and admins can do it under RLS.
 */
export async function setWebChatEnabled(
  sql: Sql,
  organizationId: string,
  agentId: string,
  enabled: boolean,
): Promise<AgentChannel> {
  if (!isUuid(organizationId) || !isUuid(agentId)) throw agentNotFound();
  const rows = await sql.query<ChannelRow>(
    `update public.agent_channels set enabled = $3
     where organization_id = $1 and agent_id = $2 and channel = 'web_chat'
     returning ${CHANNEL_COLUMNS}`,
    [organizationId, agentId, enabled],
  );
  return updatedChannel(rows);
}

/**
 * Issues a new widget key (creating the channel when missing); embeds using the old key stop working
 * immediately. Needs service scope.
 */
export async function rotateWidgetKey(sql: Sql, organizationId: string, agentId: string): Promise<AgentChannel> {
  await ensureWebChatChannel(sql, organizationId, agentId);
  const rows = await sql.query<ChannelRow>(
    `update public.agent_channels set public_key = $3
     where organization_id = $1 and agent_id = $2 and channel = 'web_chat'
     returning ${CHANNEL_COLUMNS}`,
    [organizationId, agentId, generateWidgetKey()],
  );
  return updatedChannel(rows);
}

function updatedChannel(rows: readonly ChannelRow[]): AgentChannel {
  const row = maybeOne(rows);
  // No row: no channel yet, another organization's agent, or (under RLS) a member, who can see the channel
  // but not update it.
  if (!row) throw new DomainError('not_found', 'Web chat channel not found.');
  return mapChannel(row);
}

/**
 * Public widget lookup (service scope). Returns null unless the key exists, the
 * channel is enabled AND the agent is active. The key is the only tenant input:
 * the organization comes from the matched row, never from the request.
 */
export async function findPublishedWidget(sql: Sql, publicKey: string): Promise<PublishedWidget | null> {
  if (!WIDGET_KEY_PATTERN.test(publicKey)) return null;
  const row = maybeOne(
    await sql.query<PublishedWidgetRow>(
      `select a.id, a.organization_id, a.name, a.status, a.greeting, a.language, a.timezone, a.instructions,
              a.lead_capture, a.created_at, a.updated_at,
              c.id as channel_id, c.channel, c.enabled, c.public_key,
              c.created_at as channel_created_at, c.updated_at as channel_updated_at
       from public.agent_channels c
       join public.agents a on a.id = c.agent_id and a.organization_id = c.organization_id
       where c.public_key = $1 and c.channel = 'web_chat' and c.enabled and a.status = 'active'`,
      [publicKey],
    ),
  );
  if (!row) return null;
  return {
    agent: mapAgent(row),
    channel: mapChannel({
      id: row.channel_id,
      organization_id: row.organization_id,
      agent_id: row.id,
      channel: row.channel,
      enabled: row.enabled,
      public_key: row.public_key,
      created_at: row.channel_created_at,
      updated_at: row.channel_updated_at,
    }),
  };
}
