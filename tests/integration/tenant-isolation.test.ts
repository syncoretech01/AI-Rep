import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@/server/agent/runtime/events';
import { verifyWidgetSession } from '@/server/channels/webchat/session-token';
import { loadAiConfig, loadWidgetConfig } from '@/server/config/env';
import { pgTextArray, vectorParam } from '@/server/db/sql';
import type { Sql, SqlParam } from '@/server/db/types';
import {
  ensureWebChatChannel,
  getAgent,
  getWebChatChannel,
  insertAgent,
  listAgents,
  rotateWidgetKey,
  setWebChatEnabled,
  updateAgentSettings,
} from '@/server/domain/agents/repository';
import { DEFAULT_AGENT_SETTINGS } from '@/server/domain/agents/schemas';
import type { Agent } from '@/server/domain/agents/types';
import {
  getBusinessProfile,
  listBusinessHours,
  replaceBusinessHours,
  upsertBusinessProfile,
} from '@/server/domain/business/repository';
import type { BusinessProfileInput } from '@/server/domain/business/schemas';
import { DAY_NAMES, type HoursInterval } from '@/server/domain/business/types';
import { captureLead, getContact, listLeads } from '@/server/domain/contacts/service';
import {
  appendMessage,
  closeConversation,
  getActiveVisitorConversation,
  getConversation,
  getConversationDetail,
  getOrCreateVisitorConversation,
  listConversations,
  listMessages,
  listRecentTextMessages,
  releaseTurnLock,
  tryAcquireTurnLock,
  updateSummary,
} from '@/server/domain/conversations/service';
import {
  deleteKnowledgeSource,
  getKnowledgeSource,
  ingestTextSource,
  listKnowledgeSources,
  reindexKnowledgeSource,
} from '@/server/domain/knowledge/ingestion';
import { retrieveChunks, searchKnowledge } from '@/server/domain/knowledge/retrieval';
import { createOrganization, getMembershipBySlug, listMemberships } from '@/server/domain/organizations/service';
import { DomainError, type DomainErrorCode } from '@/server/domain/types';
import { silentLogger } from '@/server/observability/logger';
import { createServices, type AppServices } from '@/server/services';
import { createSseParser, type WidgetEvent } from '@/shared/widget-protocol';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { FakeEmbeddingProvider, fakeEmbed } from '../support/fake-embeddings';
import { addMember, createAuthUser } from '../support/fixtures';
import { FakeReceptionistModel, NO_INFORMATION_REPLY } from '../support/receptionist-model';

/**
 * The Phase 0 "tenant isolation test" (IMPLEMENTATION_PLAN.md), across every layer:
 *
 * 1. Row level security — a matrix over EVERY table in `public`: as organization A's owner (and admin), B's rows
 *    are invisible, unchangeable and cannot be created; a plain member reads but never writes; a signed-in user
 *    without membership sees nothing; `anon` is denied everything. Writes are probed both aimed at B and
 *    unfiltered (no WHERE/RETURNING, so Postgres applies only the INSERT/UPDATE/DELETE policies, not the SELECT
 *    policy), with the real effect inspected inside the rolled-back transaction. Positive controls prove each
 *    denial comes from tenant scoping, not from a blanket refusal.
 * 2. Composite foreign keys — no row of A can reference an entity of B, even through the privileged service
 *    scope; the schema itself is checked so that a new table or reference cannot skip the matrix.
 * 3. Domain services — given A's organization id and B's entity ids they return null / [] / not_found and
 *    never modify B (service scope as used by the runtime, user scope as used by the admin UI).
 * 4. Agent runtime, tool executor and the public web chat channel — the tenant comes from the widget key (ids
 *    in the request body are ignored), knowledge and business facts never cross tenants, a foreign conversation
 *    or agent is refused, and metering is attributed to the tenant's own records.
 *
 * Both tenants are built through the product paths: onboarding (`createOrganization`), owner configuration
 * under RLS (business profile, hours, web chat, a second agent), knowledge ingestion through the metered
 * embedder, and visitor turns through the web chat service (FakeReceptionistModel + FakeEmbeddingProvider,
 * fixed clock).
 */

const NOW = new Date('2026-10-08T15:00:00.000Z');
const WIDGET_SECRET = 'tenant-isolation-widget-session-secret-0123456789';
/** Both tenants' visitors give the same number: contacts are per organization. */
const SHARED_PHONE = '(555) 123-4567';
const EMBEDDING_MODEL = 'fake-embedding';

interface TenantSpec {
  name: string;
  agentName: string;
  /** Configured by the owner; different for each tenant, so a mix-up shows. */
  profile: BusinessProfileInput;
  /** Weekly hours, configured by the owner; Sundays stay closed (insert probes use them). */
  hours: HoursInterval[];
  knowledge: string;
  fact: string;
  question: string;
  /** Words that only this tenant's knowledge and profile contain. */
  markers: readonly string[];
  visitorName: string;
  ip: string;
}

const weekdays = (days: readonly number[], opensAt: string, closesAt: string): HoursInterval[] =>
  days.map((dayOfWeek) => ({ dayOfWeek, opensAt, closesAt }));

const SPECS: Record<'A' | 'B', TenantSpec> = {
  A: {
    name: 'Acme Heating',
    agentName: 'Ava',
    profile: {
      businessName: 'Acme Heating',
      description: 'Boiler and furnace repair.',
      phone: '(555) 010-1000',
      email: 'hello@acme-heating.example',
      website: null,
      address: '12 Elm Street, Springfield',
      serviceArea: 'Springfield',
    },
    hours: weekdays([1, 2, 3, 4, 5], '08:00', '18:00'),
    knowledge: [
      '# Emergency service',
      'We offer 24/7 emergency boiler repair across Springfield.',
      '',
      '# Pricing',
      'Our standard call-out fee is $89 per visit.',
    ].join('\n'),
    fact: 'We offer 24/7 emergency boiler repair across Springfield.',
    question: 'Do you offer emergency boiler repair?',
    markers: ['boiler', 'Springfield', '$89'],
    visitorName: 'Jane Doe',
    ip: '198.51.100.10',
  },
  B: {
    name: 'Bravo Pinball',
    agentName: 'Bea',
    profile: {
      businessName: 'Bravo Pinball',
      description: null,
      phone: '(555) 020-2000',
      email: null,
      website: 'https://bravo-pinball.example',
      address: '7 Arcade Lane, Shelbyville',
      serviceArea: 'Shelbyville',
    },
    hours: weekdays([2, 3, 4, 5, 6], '10:00', '16:00'),
    knowledge: [
      '# Restoration',
      'We restore vintage pinball machines in Shelbyville.',
      '',
      '# Pricing',
      'A full pinball restoration costs $1,450 per machine.',
    ].join('\n'),
    fact: 'We restore vintage pinball machines in Shelbyville.',
    question: 'Do you restore vintage pinball machines?',
    markers: ['pinball', 'Shelbyville', '1,450'],
    visitorName: 'Janet Roe',
    ip: '198.51.100.20',
  },
};

/** One tenant, created through the product paths. */
interface Tenant {
  spec: TenantSpec;
  orgId: string;
  slug: string;
  ownerId: string;
  adminId: string;
  memberId: string;
  agentId: string;
  /** A second agent without business profile, hours or channel (insert probes use it). */
  spareAgentId: string;
  widgetKey: string;
  sourceId: string;
  documentId: string;
  /** The visitor's conversation: grounded answer, then lead capture. */
  conversationId: string;
  visitorId: string;
  visitorToken: string;
  /** Another visitor's conversation without messages or lead. */
  quietConversationId: string;
  contactId: string;
  leadId: string;
  /** The captureLead tool run. */
  toolRunId: string;
}

let t: TestDatabase;
let services: AppServices;
let A: Tenant;
let B: Tenant;
/** Signed in, member of nothing. */
let outsiderId: string;

beforeAll(async () => {
  t = await createTestDatabase();
  services = createServices({
    db: t.db,
    logger: silentLogger,
    ai: loadAiConfig({
      AI_TEXT_PROVIDER: 'receptionist',
      AI_TEXT_MODEL: 'receptionist-mini',
      AI_ESCALATION_ENABLED: 'false',
      AI_EMBEDDING_PROVIDER: 'fake',
      AI_EMBEDDING_MODEL: EMBEDDING_MODEL,
    }),
    providers: {
      text: { receptionist: () => new FakeReceptionistModel('receptionist') },
      embedding: { fake: () => new FakeEmbeddingProvider('fake') },
    },
    widget: loadWidgetConfig({
      WIDGET_SESSION_SECRET: WIDGET_SECRET,
      RATE_LIMIT_IP_PER_MINUTE: '1000',
      RATE_LIMIT_WIDGET_PER_MINUTE: '1000',
      RATE_LIMIT_ORG_PER_MINUTE: '1000',
    }),
    now: () => NOW,
  });
  A = await setUpTenant(SPECS.A);
  B = await setUpTenant(SPECS.B);
  outsiderId = (await createAuthUser(t.db)).id;
});

afterAll(async () => {
  await t.close();
});

// ── tenant setup through the product paths ────────────────────────────────────

async function setUpTenant(spec: TenantSpec): Promise<Tenant> {
  const owner = await createAuthUser(t.db);
  const admin = await createAuthUser(t.db);
  const member = await createAuthUser(t.db);
  // Onboarding: organization, owner membership, first agent, profile, unpublished channel, audit row (no hours).
  const { organization, agent } = await createOrganization(t.db, {
    name: spec.name,
    ownerUserId: owner.id,
    agentName: spec.agentName,
  });
  await addMember(t.db, organization.id, admin.id, 'admin');
  await addMember(t.db, organization.id, member.id, 'member');

  // Configuration as the owner, under RLS (the admin UI's scope).
  const asOwner = t.asUser(owner.id);
  const { channel, spare } = await asOwner.run(async (sql) => {
    await upsertBusinessProfile(sql, organization.id, agent.id, spec.profile);
    await replaceBusinessHours(sql, organization.id, agent.id, spec.hours);
    return {
      channel: await setWebChatEnabled(sql, organization.id, agent.id, true),
      spare: await insertAgent(sql, organization.id, { name: 'Overflow desk' }),
    };
  });
  const widgetKey = channel.publicKey;
  if (widgetKey === null) throw new Error('setup: the published channel has no widget key');
  const source = await ingestTextSource(asOwner, services.embedder, {
    organizationId: organization.id,
    agentId: null,
    kind: 'text',
    title: `${spec.name} FAQ`,
    text: spec.knowledge,
    createdBy: owner.id,
  });
  if (source.status !== 'ready') throw new Error(`setup: knowledge ingestion ended '${source.status}'`);

  // A visitor: a grounded question, then contact details (lead capture through the tool).
  const session = await services.webChat.startSession({ widgetKey }, { ip: spec.ip });
  const grounded = await visitorTurn(widgetKey, session.sessionToken, spec.question, spec.ip);
  if (!grounded.reply.includes(spec.fact)) throw new Error(`setup: ungrounded reply "${grounded.reply}"`);
  const lead = await visitorTurn(
    widgetKey,
    session.sessionToken,
    `I'm ${spec.visitorName}, my number is ${SHARED_PHONE} — please call me about a quote`,
    spec.ip,
  );
  if (lead.conversationId !== grounded.conversationId || !lead.reply.includes('saved your details')) {
    throw new Error(`setup: lead capture failed ("${lead.reply}")`);
  }
  const quiet = await t.service.run((sql) =>
    getOrCreateVisitorConversation(sql, {
      organizationId: organization.id,
      agentId: agent.id,
      channel: 'web_chat',
      visitorId: randomUUID(),
    }),
  );

  const conversationId = grounded.conversationId;
  const single = async (text: string, params: SqlParam[]): Promise<string> => {
    const rows = await t.db.query<{ id: string }>(text, params);
    if (rows.length !== 1 || !rows[0]) throw new Error(`setup: expected one row for: ${text}`);
    return rows[0].id;
  };
  return {
    spec,
    orgId: organization.id,
    slug: organization.slug,
    ownerId: owner.id,
    adminId: admin.id,
    memberId: member.id,
    agentId: agent.id,
    spareAgentId: spare.id,
    widgetKey,
    sourceId: source.id,
    documentId: await single('select id from public.knowledge_documents where source_id = $1', [source.id]),
    conversationId,
    visitorId: await single('select visitor_id as id from public.conversations where id = $1', [conversationId]),
    visitorToken: session.sessionToken,
    quietConversationId: quiet.id,
    contactId: await single('select id from public.contacts where organization_id = $1', [organization.id]),
    leadId: await single('select id from public.leads where conversation_id = $1', [conversationId]),
    toolRunId: await single("select id from public.tool_runs where conversation_id = $1 and tool_name = 'captureLead'", [
      conversationId,
    ]),
  };
}

async function readEvents(stream: ReadableStream<Uint8Array>): Promise<WidgetEvent[]> {
  const events: WidgetEvent[] = [];
  const invalid: string[] = [];
  const parser = createSseParser(
    (event) => events.push(event),
    (raw) => invalid.push(raw),
  );
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
  parser.push(decoder.decode());
  parser.flush();
  if (invalid.length > 0) throw new Error(`invalid SSE frames: ${invalid.join(' | ')}`);
  return events;
}

/** One visitor message through the web chat channel, waiting for the post-turn work. `extra` goes into the body. */
async function visitorTurn(widgetKey: string, sessionToken: string, text: string, ip: string, extra: Record<string, unknown> = {}) {
  const request = { ...extra, widgetKey, sessionToken, text };
  const { stream, done } = await services.webChat.openMessageStream(request, { ip });
  const events = await readEvents(stream);
  await done;
  const start = events[0];
  const end = events.at(-1);
  if (start?.type !== 'turn.start' || end?.type !== 'turn.done') {
    throw new Error(`unexpected turn events: ${JSON.stringify(events)}`);
  }
  return { events, conversationId: start.conversationId, reply: end.text };
}

// ── probes ────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type Statement = readonly [text: string, params: readonly SqlParam[]];
type Outcome = { ok: true; rows: Row[] } | { ok: false; code: unknown; constraint: unknown; message: string };
/** Runs work in one transaction as some database actor. */
type Runner = <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>;

const asUser =
  (userId: string): Runner =>
  (fn) =>
    t.asUser(userId).run(fn);
const asService: Runner = (fn) => t.service.run(fn);
/** The Data API's unauthenticated role (the app itself never uses it). */
const asAnon: Runner = (fn) =>
  t.db.transaction(async (tx) => {
    await tx.query("select set_config('role', 'anon', true)");
    return fn(tx);
  });

function failed(error: unknown): Outcome {
  if (typeof error !== 'object' || error === null) return { ok: false, code: undefined, constraint: undefined, message: String(error) };
  const record = error as { code?: unknown; constraint?: unknown; message?: unknown };
  return { ok: false, code: record.code, constraint: record.constraint, message: String(record.message) };
}

/** Runs one statement and commits. */
async function attempt(run: Runner, [text, params]: Statement): Promise<Outcome> {
  try {
    return { ok: true, rows: await run((sql) => sql.query(text, params)) };
  } catch (error) {
    return failed(error);
  }
}

/** How a call settled (its result is not needed). */
async function outcomeOf(promise: Promise<unknown>): Promise<Outcome> {
  try {
    await promise;
    return { ok: true, rows: [] };
  } catch (error) {
    return failed(error);
  }
}

class Rollback extends Error {}

/** Runs one statement and always rolls back: positive controls leave no trace. */
async function attemptRolledBack(run: Runner, [text, params]: Statement): Promise<Outcome> {
  const box: { rows?: Row[] } = {};
  try {
    await run(async (sql) => {
      box.rows = await sql.query(text, params);
      throw new Rollback('probe');
    });
  } catch (error) {
    if (error instanceof Rollback && box.rows) return { ok: true, rows: box.rows };
    return failed(error);
  }
  throw new Error('probe transaction was not rolled back');
}

/** How one table's rows of A and B looked before a write probe and right after it (privileged view). */
interface RowsChange {
  before: string[];
  after: string[];
}

interface Effect {
  outcome: Outcome;
  a: RowsChange;
  b: RowsChange;
}

/**
 * Runs a write as the user in a transaction that is always rolled back and reports what it changed, seen from
 * inside that transaction as the privileged session user. Unlike counting RETURNING rows, this also measures
 * statements without WHERE/RETURNING, which Postgres filters by the UPDATE/DELETE policies alone (no SELECT policy).
 * `prepare` runs first as the privileged user, in the same transaction (it must not touch `table` itself).
 */
async function writeEffect(
  userId: string,
  table: string,
  [text, params]: Statement,
  prepare: readonly string[] = [],
): Promise<Effect> {
  const before = { a: await digest(table, A.orgId), b: await digest(table, B.orgId) };
  const box: { effect?: Effect } = {};
  try {
    await t.asUser(userId).run(async (sql) => {
      if (prepare.length > 0) {
        await sql.query("select set_config('role', 'none', true)");
        for (const statement of prepare) await sql.query(statement);
        // The user's JWT claims are still set for this transaction.
        await sql.query("select set_config('role', 'authenticated', true)");
      }
      await sql.query('savepoint probe');
      let outcome: Outcome;
      try {
        outcome = { ok: true, rows: await sql.query(text, params) };
      } catch (error) {
        outcome = failed(error);
        await sql.query('rollback to savepoint probe');
      }
      // Back to the privileged session user (RLS no longer applies) to see what the statement really did.
      await sql.query("select set_config('role', 'none', true)");
      box.effect = {
        outcome,
        a: { before: before.a, after: await digestIn(sql, table, A.orgId) },
        b: { before: before.b, after: await digestIn(sql, table, B.orgId) },
      };
      throw new Rollback('probe');
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  if (!box.effect) throw new Error('write probe did not run');
  return box.effect;
}

const unchanged = (change: RowsChange) => expect(change.after).toEqual(change.before);

/** Every row changed (an update reached all of them). */
function allChanged(change: RowsChange): void {
  expect(change.before.length).toBeGreaterThan(0);
  expect(change.after).toHaveLength(change.before.length);
  expect(change.after.filter((row) => change.before.includes(row))).toEqual([]);
}

/** 42501, from a row level security policy ('rls') or a missing table/schema privilege ('privilege'). */
function expectDenied(outcome: Outcome, reason: 'rls' | 'privilege'): void {
  if (outcome.ok) throw new Error(`expected permission denied (42501), but it succeeded with ${outcome.rows.length} row(s)`);
  expect(outcome.code, outcome.message).toBe('42501');
  expect(outcome.message).toMatch(reason === 'rls' ? /row-level security policy/ : /permission denied for (?:table|schema)/);
}

/** A write that must not reach the rows: zero rows where the role holds the privilege, otherwise denied. */
function expectNoEffect(outcome: Outcome, privileged: boolean): void {
  if (privileged) expect(outcome).toEqual({ ok: true, rows: [] });
  else expectDenied(outcome, 'privilege');
}

/** Exactly one row written (positive controls). */
function expectInserted(outcome: Outcome): void {
  if (!outcome.ok) throw new Error(`expected the insert to succeed, got ${String(outcome.code)}: ${outcome.message}`);
  expect(outcome.rows).toHaveLength(1);
}

function expectForeignKeyViolation(outcome: Outcome, constraint?: string, context = ''): void {
  if (outcome.ok) {
    throw new Error(`expected a foreign key violation (23503), but it succeeded with ${outcome.rows.length} row(s): ${context}`);
  }
  expect(outcome.code, `${outcome.message} ${context}`).toBe('23503');
  if (constraint !== undefined) expect(outcome.constraint, context).toBe(constraint);
}

async function expectDomainError(promise: Promise<unknown>, code: DomainErrorCode): Promise<void> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  if (!(error instanceof DomainError)) throw new Error(`expected DomainError('${code}'), got ${String(error)}`);
  expect(error.code).toBe(code);
}

const idRows = (ids: readonly string[]) => ids.map((id) => ({ id }));
/** Sorted in JS: SQL `order by` on names would depend on the database collation. */
const sorted = (values: readonly string[]) => [...values].sort();

// ── the table matrix ──────────────────────────────────────────────────────────

interface TableRule {
  table: string;
  /** Who in the organization may read its rows. */
  readers: 'members' | 'admins';
  /** What owners/admins may do (RLS-checked). Everything else has no privilege for `authenticated`. */
  grant: { insert: boolean; update: boolean; delete: boolean };
  /** A column-level UPDATE grant: only these columns may change (any other is a privilege error). */
  updatableColumns?: readonly string[];
  /** A real change, for update probes. */
  set: string;
  /**
   * INSERT of a valid row in tenant `x`'s organization by `actorId` (for B it references only B's entities, so
   * only RLS can refuse it). No RETURNING: that would also apply the SELECT policy and mask a broken INSERT policy.
   */
  insert(x: Tenant, actorId: string): Statement;
  /** The row a positive-control delete removes (default: any row of the organization). */
  deletable?(x: Tenant): string;
  /**
   * Privileged statements that clear rows of BOTH tenants whose foreign keys would block an unfiltered DELETE
   * (agents have conversations, leads and tool runs). Otherwise the foreign key error would hide a DELETE policy
   * that reaches B's rows: the policy alone must decide what goes.
   */
  deleteAllPrepare?: readonly string[];
}

const CONFIGURATION = { insert: true, update: true, delete: true };
const SERVER_WRITTEN = { insert: false, update: false, delete: false };
const INJECTED_VECTOR = vectorParam(fakeEmbed('Injected chunk'));

const TABLE_RULES: readonly TableRule[] = [
  {
    table: 'organizations',
    readers: 'members',
    grant: { insert: false, update: true, delete: false },
    set: "name = 'Hijacked'",
    insert: () => ['insert into public.organizations (name, slug) values ($1, $2)', ['Injected', `injected-${randomUUID().slice(0, 8)}`]],
  },
  {
    table: 'organization_members',
    readers: 'members',
    grant: SERVER_WRITTEN,
    set: "role = 'member'",
    // Joining (or promoting yourself in) an organization.
    insert: (x, actorId) => [
      "insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'owner')",
      [x.orgId, actorId],
    ],
  },
  {
    table: 'agents',
    readers: 'members',
    grant: CONFIGURATION,
    set: "instructions = 'Hijacked'",
    insert: (x) => ["insert into public.agents (organization_id, name) values ($1, 'Injected desk')", [x.orgId]],
    deletable: (x) => x.spareAgentId,
    deleteAllPrepare: ['delete from public.tool_runs', 'delete from public.leads', 'delete from public.conversations'],
  },
  {
    table: 'business_profiles',
    readers: 'members',
    grant: CONFIGURATION,
    set: "description = 'Hijacked'",
    insert: (x) => [
      "insert into public.business_profiles (organization_id, agent_id, business_name) values ($1, $2, 'Injected')",
      [x.orgId, x.spareAgentId],
    ],
  },
  {
    table: 'business_hours',
    readers: 'members',
    grant: CONFIGURATION,
    set: "closes_at = '23:59'",
    insert: (x) => [
      `insert into public.business_hours (organization_id, agent_id, day_of_week, opens_at, closes_at)
       values ($1, $2, 0, '10:00', '11:00')`,
      [x.orgId, x.agentId],
    ],
  },
  {
    table: 'agent_channels',
    readers: 'members',
    // Widget keys are one namespace across tenants that only the server writes: owners and admins may toggle
    // a channel or delete it, but never insert one or set its key (channels are created in service scope).
    grant: { insert: false, update: true, delete: true },
    updatableColumns: ['enabled', 'config'],
    set: 'enabled = false',
    insert: (x) => [
      "insert into public.agent_channels (organization_id, agent_id, channel, enabled) values ($1, $2, 'web_chat', true)",
      [x.orgId, x.spareAgentId],
    ],
  },
  {
    table: 'knowledge_sources',
    readers: 'members',
    grant: CONFIGURATION,
    set: "title = 'Hijacked'",
    insert: (x) => [
      "insert into public.knowledge_sources (organization_id, agent_id, kind, title) values ($1, $2, 'text', 'Injected')",
      [x.orgId, x.agentId],
    ],
  },
  {
    table: 'knowledge_documents',
    readers: 'members',
    grant: CONFIGURATION,
    set: "title = 'Hijacked'",
    insert: (x) => [
      `insert into public.knowledge_documents (organization_id, source_id, title, content, content_sha256, char_count)
       values ($1, $2, 'Injected', 'Injected', $3, 8)`,
      [x.orgId, x.sourceId, 'f'.repeat(64)],
    ],
  },
  {
    table: 'knowledge_chunks',
    readers: 'members',
    grant: CONFIGURATION,
    set: "content = 'Hijacked'",
    insert: (x) => [
      `insert into public.knowledge_chunks
         (organization_id, source_id, document_id, chunk_index, content, token_count, embedding, embedding_model)
       values ($1, $2, $3, 999, 'Injected', 1, $4::extensions.vector, $5)`,
      [x.orgId, x.sourceId, x.documentId, INJECTED_VECTOR, EMBEDDING_MODEL],
    ],
  },
  {
    table: 'contacts',
    readers: 'members',
    grant: SERVER_WRITTEN,
    set: "name = 'Hijacked'",
    insert: (x) => [
      "insert into public.contacts (organization_id, name, phone, phone_normalized) values ($1, 'Injected', '+15550000000', '+15550000000')",
      [x.orgId],
    ],
  },
  {
    table: 'conversations',
    readers: 'members',
    grant: SERVER_WRITTEN,
    set: "summary = 'Hijacked'",
    insert: (x) => ["insert into public.conversations (organization_id, agent_id, channel) values ($1, $2, 'web_chat')", [x.orgId, x.agentId]],
  },
  {
    table: 'leads',
    readers: 'members',
    grant: SERVER_WRITTEN,
    set: "status = 'closed'",
    insert: (x) => [
      "insert into public.leads (organization_id, agent_id, contact_id, channel) values ($1, $2, $3, 'web_chat')",
      [x.orgId, x.agentId, x.contactId],
    ],
  },
  {
    table: 'tool_runs',
    readers: 'members',
    grant: SERVER_WRITTEN,
    set: "error_message = 'Hijacked'",
    insert: (x) => [
      `insert into public.tool_runs (organization_id, agent_id, conversation_id, channel, tool_name, status)
       values ($1, $2, $3, 'web_chat', 'captureLead', 'succeeded')`,
      [x.orgId, x.agentId, x.conversationId],
    ],
  },
  {
    table: 'messages',
    readers: 'members',
    grant: SERVER_WRITTEN,
    set: "content = 'Hijacked'",
    // A forged assistant reply.
    insert: (x) => [
      "insert into public.messages (organization_id, conversation_id, role, content) values ($1, $2, 'assistant', 'Injected')",
      [x.orgId, x.conversationId],
    ],
  },
  {
    table: 'usage_records',
    readers: 'members',
    grant: SERVER_WRITTEN,
    set: 'estimated_cost_usd = 0',
    insert: (x) => [
      `insert into public.usage_records (organization_id, kind, purpose, provider, model)
       values ($1, 'text_generation', 'chat_response', 'injected', 'injected')`,
      [x.orgId],
    ],
  },
  {
    table: 'audit_logs',
    // The audit trail is for owners and admins only.
    readers: 'admins',
    grant: SERVER_WRITTEN,
    set: "action = 'hijacked'",
    insert: (x) => ["insert into public.audit_logs (organization_id, actor_type, action) values ($1, 'user', 'injected')", [x.orgId]],
  },
];

const tenantColumn = (table: string) => (table === 'organizations' ? 'id' : 'organization_id');

/** Whether owners/admins hold the UPDATE privilege on this column (RLS then decides which rows). */
const mayUpdate = (rule: TableRule, column: string) => rule.grant.update && (rule.updatableColumns?.includes(column) ?? true);

/** The organization's row ids (privileged read). */
async function idsOf(table: string, orgId: string): Promise<string[]> {
  const rows = await t.db.query<{ id: string }>(
    `select x.id from public.${table} x where x.${tenantColumn(table)} = $1 order by x.id`,
    [orgId],
  );
  return rows.map((row) => row.id);
}

/** A fingerprint of every row of the organization in one table, read through `sql` (privileged role). */
async function digestIn(sql: Sql, table: string, orgId: string): Promise<string[]> {
  const rows = await sql.query<{ digest: string }>(
    `select md5(x::text) as digest from public.${table} x where x.${tenantColumn(table)} = $1 order by x.id`,
    [orgId],
  );
  return rows.map((row) => row.digest);
}

const digest = (table: string, orgId: string) => digestIn(t.db, table, orgId);

/** Fingerprints of all of a tenant's data. */
async function tenantDigest(x: Tenant): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  for (const rule of TABLE_RULES) result[rule.table] = await digest(rule.table, x.orgId);
  return result;
}

const selectAll = (table: string): Statement => [`select x.id from public.${table} x order by x.id`, []];
const withReturning = ([text, params]: Statement): Statement => [`${text} returning id`, params];
/** Explicitly aimed at one organization's rows (WHERE + RETURNING: the SELECT policy filters too). */
const updateTenant = (rule: TableRule, orgId: string): Statement => [
  `update public.${rule.table} x set ${rule.set} where x.${tenantColumn(rule.table)} = $1 returning x.id`,
  [orgId],
];
const deleteTenant = (rule: TableRule, orgId: string): Statement => [
  `delete from public.${rule.table} x where x.${tenantColumn(rule.table)} = $1 returning x.id`,
  [orgId],
];
/** Unfiltered (no WHERE, no RETURNING): only the UPDATE/DELETE policies decide which rows it reaches. */
const updateAll = (rule: TableRule): Statement => [`update public.${rule.table} set ${rule.set}`, []];
const deleteAll = (rule: TableRule): Statement => [`delete from public.${rule.table}`, []];

/** A write by someone who may not write A's rows: refused (no privilege) or zero rows, and nothing changes anywhere. */
function expectWriteRefused(effect: Effect, privileged: boolean): void {
  if (privileged) expect(effect.outcome).toEqual({ ok: true, rows: [] });
  else expectDenied(effect.outcome, 'privilege');
  unchanged(effect.a);
  unchanged(effect.b);
}

describe('row level security matrix (every table in public)', () => {
  describe.each(TABLE_RULES)('$table', (rule) => {
    it("A's owner and admin see all of A's rows and none of B's", async () => {
      const own = await idsOf(rule.table, A.orgId);
      const foreign = await idsOf(rule.table, B.orgId);
      expect(own.length).toBeGreaterThan(0);
      expect(foreign.length).toBeGreaterThan(0);

      for (const actorId of [A.ownerId, A.adminId]) {
        expect(await attempt(asUser(actorId), selectAll(rule.table))).toEqual({ ok: true, rows: idRows(own) });
        // Naming B's rows explicitly does not help either.
        const targeted = await attempt(asUser(actorId), [
          `select x.id from public.${rule.table} x where x.id = any($1::uuid[])`,
          [pgTextArray(foreign)],
        ]);
        expect(targeted).toEqual({ ok: true, rows: [] });
      }
    });

    it("A's owner and admin can neither change nor delete B's rows", async () => {
      for (const actorId of [A.ownerId, A.adminId]) {
        // Aimed at B: zero rows.
        const before = await digest(rule.table, B.orgId);
        expectNoEffect(await attempt(asUser(actorId), updateTenant(rule, B.orgId)), rule.grant.update);
        expectNoEffect(await attempt(asUser(actorId), deleteTenant(rule, B.orgId)), rule.grant.delete);
        expect(await digest(rule.table, B.orgId)).toEqual(before);

        // Unfiltered (rolled back): exactly A's rows are reached when the role may write them, never B's.
        const update = await writeEffect(actorId, rule.table, updateAll(rule));
        unchanged(update.b);
        if (rule.grant.update) {
          expect(update.outcome).toEqual({ ok: true, rows: [] });
          allChanged(update.a);
        } else {
          expectDenied(update.outcome, 'privilege');
          unchanged(update.a);
        }

        const remove = await writeEffect(actorId, rule.table, deleteAll(rule), rule.deleteAllPrepare);
        unchanged(remove.b);
        if (rule.grant.delete) {
          expect(remove.outcome).toEqual({ ok: true, rows: [] });
          expect(remove.a.after).toEqual([]);
        } else {
          expectDenied(remove.outcome, 'privilege');
          unchanged(remove.a);
        }
      }
    });

    it("A's owner and admin can neither create rows in B nor move A's rows into B", async () => {
      for (const actorId of [A.ownerId, A.adminId]) {
        const before = await digest(rule.table, B.orgId);
        expectDenied(await attempt(asUser(actorId), rule.insert(B, actorId)), rule.grant.insert ? 'rls' : 'privilege');
        expect(await digest(rule.table, B.orgId)).toEqual(before);
        if (rule.table === 'organizations') continue;

        // Unfiltered and rolled back: with a WHERE clause Postgres would also check the new rows against the
        // SELECT policy, so only the UPDATE policy's WITH CHECK may refuse rows that would leave A.
        const moved = await writeEffect(actorId, rule.table, [`update public.${rule.table} set organization_id = $1`, [B.orgId]]);
        expectDenied(moved.outcome, mayUpdate(rule, 'organization_id') ? 'rls' : 'privilege');
        unchanged(moved.a);
        unchanged(moved.b);
      }
    });

    it("A's owner and admin may create and delete A's rows exactly where granted (control, rolled back)", async () => {
      const own = await idsOf(rule.table, A.orgId);
      for (const actorId of [A.ownerId, A.adminId]) {
        const inserted = await attemptRolledBack(asUser(actorId), withReturning(rule.insert(A, actorId)));
        if (rule.grant.insert) expectInserted(inserted);
        else expectDenied(inserted, 'privilege');

        const target = rule.deletable?.(A) ?? own[0]!;
        const deleted = await attemptRolledBack(asUser(actorId), [
          `delete from public.${rule.table} x where x.${tenantColumn(rule.table)} = $1 and x.id = $2 returning x.id`,
          [A.orgId, target],
        ]);
        if (rule.grant.delete) expect(deleted).toEqual({ ok: true, rows: [{ id: target }] });
        else expectDenied(deleted, 'privilege');
      }
    });

    it(`a plain member of A ${rule.readers === 'members' ? 'reads' : 'cannot read'} A's rows and writes nothing`, async () => {
      const own = await idsOf(rule.table, A.orgId);
      expect(await attempt(asUser(A.memberId), selectAll(rule.table))).toEqual({
        ok: true,
        rows: rule.readers === 'members' ? idRows(own) : [],
      });

      const before = await digest(rule.table, A.orgId);
      expectDenied(await attempt(asUser(A.memberId), rule.insert(A, A.memberId)), rule.grant.insert ? 'rls' : 'privilege');
      expect(await digest(rule.table, A.orgId)).toEqual(before);
      expectWriteRefused(await writeEffect(A.memberId, rule.table, updateAll(rule)), rule.grant.update);
      expectWriteRefused(await writeEffect(A.memberId, rule.table, deleteAll(rule), rule.deleteAllPrepare), rule.grant.delete);
    });

    it('a signed-in user without membership sees and changes nothing', async () => {
      expect(await attempt(asUser(outsiderId), selectAll(rule.table))).toEqual({ ok: true, rows: [] });

      const before = await digest(rule.table, A.orgId);
      expectDenied(await attempt(asUser(outsiderId), rule.insert(A, outsiderId)), rule.grant.insert ? 'rls' : 'privilege');
      expect(await digest(rule.table, A.orgId)).toEqual(before);
      expectWriteRefused(await writeEffect(outsiderId, rule.table, updateAll(rule)), rule.grant.update);
      expectWriteRefused(await writeEffect(outsiderId, rule.table, deleteAll(rule), rule.deleteAllPrepare), rule.grant.delete);
    });

    it('the anon role is denied every operation', async () => {
      const before = await digest(rule.table, A.orgId);
      expectDenied(await attempt(asAnon, selectAll(rule.table)), 'privilege');
      expectDenied(await attempt(asAnon, rule.insert(A, outsiderId)), 'privilege');
      expectDenied(await attempt(asAnon, updateAll(rule)), 'privilege');
      expectDenied(await attempt(asAnon, deleteAll(rule)), 'privilege');
      expect(await digest(rule.table, A.orgId)).toEqual(before);
    });
  });

  it("lets A's owner and admin toggle A's web chat channel but never write a widget key", async () => {
    const statements: Statement[] = [
      // B's key (refused for lacking the privilege, before any unique check), a cleared key, a channel with a chosen key.
      ['update public.agent_channels set public_key = $2 where organization_id = $1', [A.orgId, B.widgetKey]],
      ['update public.agent_channels set public_key = null', []],
      [
        "insert into public.agent_channels (organization_id, agent_id, channel, public_key) values ($1, $2, 'web_chat', $3)",
        [A.orgId, A.spareAgentId, `wk_${'K'.repeat(32)}`],
      ],
    ];
    for (const actorId of [A.ownerId, A.adminId]) {
      // Positive control (rolled back): `enabled` is a granted column.
      const toggled = await writeEffect(actorId, 'agent_channels', ['update public.agent_channels set enabled = not enabled', []]);
      expect(toggled.outcome).toEqual({ ok: true, rows: [] });
      allChanged(toggled.a);
      unchanged(toggled.b);

      for (const statement of statements) {
        const effect = await writeEffect(actorId, 'agent_channels', statement);
        expectDenied(effect.outcome, 'privilege');
        unchanged(effect.a);
        unchanged(effect.b);
      }
    }
  });

  it('keeps the rate-limit buckets and the RLS helper functions out of reach', async () => {
    const buckets = await t.db.query('select bucket_key, window_start, hits from app_private.rate_limit_buckets order by 1, 2');
    expect(buckets.length).toBeGreaterThan(0);
    // Hashed client IPs: no Data API role may read them, not even an owner; nor reset or fill anyone's budget.
    expectDenied(await attempt(asUser(A.ownerId), ['select bucket_key from app_private.rate_limit_buckets', []]), 'privilege');
    expectDenied(await attempt(asUser(A.ownerId), ['delete from app_private.rate_limit_buckets', []]), 'privilege');
    expectDenied(await attempt(asUser(A.ownerId), ['update app_private.rate_limit_buckets set hits = 0', []]), 'privilege');
    expectDenied(
      await attempt(asUser(A.ownerId), ["insert into app_private.rate_limit_buckets (bucket_key, window_start) values ('x', now())", []]),
      'privilege',
    );
    expectDenied(await attempt(asAnon, ['select bucket_key from app_private.rate_limit_buckets', []]), 'privilege');
    expect(await t.db.query('select bucket_key, window_start, hits from app_private.rate_limit_buckets order by 1, 2')).toEqual(buckets);
    expectDenied(await attempt(asAnon, ['select app_private.user_organization_ids()', []]), 'privilege');

    // The membership helpers only ever answer for the calling user.
    const helper = ['select app_private.user_organization_ids() as id', []] as const;
    expect(await attempt(asUser(A.ownerId), helper)).toEqual({ ok: true, rows: [{ id: A.orgId }] });
    expect(await attempt(asUser(outsiderId), helper)).toEqual({ ok: true, rows: [] });
    expect(
      await attempt(asUser(A.memberId), ['select app_private.user_admin_organization_ids() as id', []]),
    ).toEqual({ ok: true, rows: [] });
  });
});

// ── schema guarantees ─────────────────────────────────────────────────────────

interface LinkRule {
  /** The composite (x_id, organization_id) foreign key that must refuse the reference. */
  constraint: string;
  /** A row in `org`'s organization that references `target`'s entity. */
  row(org: Tenant, target: Tenant): Statement;
}

const CHUNK_INSERT = `insert into public.knowledge_chunks
  (organization_id, source_id, document_id, chunk_index, content, token_count, embedding, embedding_model)
  values ($1, $2, $3, 999, 'Linked', 1, $4::extensions.vector, $5) returning id`;
const LEAD_INSERT = `insert into public.leads (organization_id, agent_id, contact_id, conversation_id, channel)
  values ($1, $2, $3, $4, 'web_chat') returning id`;
const TOOL_RUN_INSERT = `insert into public.tool_runs (organization_id, agent_id, conversation_id, channel, tool_name, status)
  values ($1, $2, $3, 'web_chat', 'searchKnowledge', 'succeeded') returning id`;

const LINK_RULES: readonly LinkRule[] = [
  {
    constraint: 'agent_channels_agent_id_organization_id_fkey',
    row: (org, target) => [
      "insert into public.agent_channels (organization_id, agent_id, channel) values ($1, $2, 'web_chat') returning id",
      [org.orgId, target.spareAgentId],
    ],
  },
  {
    constraint: 'business_hours_agent_id_organization_id_fkey',
    row: (org, target) => [
      `insert into public.business_hours (organization_id, agent_id, day_of_week, opens_at, closes_at)
       values ($1, $2, 0, '10:00', '11:00') returning id`,
      [org.orgId, target.agentId],
    ],
  },
  {
    constraint: 'business_profiles_agent_id_organization_id_fkey',
    row: (org, target) => [
      'insert into public.business_profiles (organization_id, agent_id) values ($1, $2) returning id',
      [org.orgId, target.spareAgentId],
    ],
  },
  {
    constraint: 'conversations_agent_id_organization_id_fkey',
    row: (org, target) => [
      "insert into public.conversations (organization_id, agent_id, channel) values ($1, $2, 'web_chat') returning id",
      [org.orgId, target.agentId],
    ],
  },
  {
    constraint: 'conversations_contact_id_organization_id_fkey',
    row: (org, target) => [
      "insert into public.conversations (organization_id, agent_id, channel, contact_id) values ($1, $2, 'web_chat', $3) returning id",
      [org.orgId, org.agentId, target.contactId],
    ],
  },
  {
    constraint: 'knowledge_chunks_document_id_organization_id_fkey',
    row: (org, target) => [CHUNK_INSERT, [org.orgId, org.sourceId, target.documentId, INJECTED_VECTOR, EMBEDDING_MODEL]],
  },
  {
    constraint: 'knowledge_chunks_source_id_organization_id_fkey',
    row: (org, target) => [CHUNK_INSERT, [org.orgId, target.sourceId, org.documentId, INJECTED_VECTOR, EMBEDDING_MODEL]],
  },
  {
    constraint: 'knowledge_documents_source_id_organization_id_fkey',
    row: (org, target) => [
      `insert into public.knowledge_documents (organization_id, source_id, title, content, content_sha256, char_count)
       values ($1, $2, 'Linked', 'Linked', $3, 6) returning id`,
      [org.orgId, target.sourceId, 'e'.repeat(64)],
    ],
  },
  {
    constraint: 'knowledge_sources_agent_id_organization_id_fkey',
    row: (org, target) => [
      "insert into public.knowledge_sources (organization_id, agent_id, kind, title) values ($1, $2, 'text', 'Linked') returning id",
      [org.orgId, target.agentId],
    ],
  },
  { constraint: 'leads_agent_id_organization_id_fkey', row: (org, target) => [LEAD_INSERT, [org.orgId, target.agentId, org.contactId, null]] },
  { constraint: 'leads_contact_id_organization_id_fkey', row: (org, target) => [LEAD_INSERT, [org.orgId, org.agentId, target.contactId, null]] },
  {
    constraint: 'leads_conversation_id_organization_id_fkey',
    // The quiet conversations have no lead yet (one lead per conversation).
    row: (org, target) => [LEAD_INSERT, [org.orgId, org.agentId, org.contactId, target.quietConversationId]],
  },
  {
    constraint: 'messages_conversation_id_organization_id_fkey',
    row: (org, target) => [
      "insert into public.messages (organization_id, conversation_id, role, content) values ($1, $2, 'user', 'Linked') returning id",
      [org.orgId, target.conversationId],
    ],
  },
  {
    constraint: 'messages_tool_run_id_organization_id_fkey',
    row: (org, target) => [
      "insert into public.messages (organization_id, conversation_id, role, tool_name, tool_run_id) values ($1, $2, 'tool_result', 'captureLead', $3) returning id",
      [org.orgId, org.conversationId, target.toolRunId],
    ],
  },
  { constraint: 'tool_runs_agent_id_organization_id_fkey', row: (org, target) => [TOOL_RUN_INSERT, [org.orgId, target.agentId, org.conversationId]] },
  {
    constraint: 'tool_runs_conversation_id_organization_id_fkey',
    row: (org, target) => [TOOL_RUN_INSERT, [org.orgId, org.agentId, target.conversationId]],
  },
];

describe('schema guarantees', () => {
  it('the matrix covers every table in the public schema', async () => {
    const tables = await t.db.query<{ name: string }>(
      "select c.relname as name from pg_class c where c.relkind in ('r', 'p') and c.relnamespace = 'public'::regnamespace",
    );
    expect(sorted(tables.map((row) => row.name))).toEqual(sorted(TABLE_RULES.map((rule) => rule.table)));
  });

  it('every table in public and app_private has row level security enabled', async () => {
    const tables = await t.db.query<{ name: string; rls: boolean }>(
      `select n.nspname || '.' || c.relname as name, c.relrowsecurity as rls
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where c.relkind in ('r', 'p') and n.nspname in ('public', 'app_private')`,
    );
    expect(tables.map((table) => table.name)).toEqual(
      expect.arrayContaining(['app_private.rate_limit_buckets', ...TABLE_RULES.map((rule) => `public.${rule.table}`)]) as unknown,
    );
    expect(tables.filter((table) => !table.rls)).toEqual([]);
  });

  it('every tenant table carries a NOT NULL organization_id that references organizations', async () => {
    const columns = await t.db.query<{ table_name: string; nullable: string; references_organizations: boolean }>(
      `select c.table_name, c.is_nullable as nullable,
              exists (
                select 1 from pg_constraint k
                where k.contype = 'f' and k.conrelid = ('public.' || c.table_name)::regclass
                  and k.confrelid = 'public.organizations'::regclass
                  and k.conkey = array[c.ordinal_position::smallint]
              ) as references_organizations
       from information_schema.columns c
       where c.table_schema = 'public' and c.column_name = 'organization_id'`,
    );
    const tenantTables = TABLE_RULES.map((rule) => rule.table).filter((table) => table !== 'organizations');
    expect([...columns].sort((x, y) => (x.table_name < y.table_name ? -1 : 1))).toEqual(
      sorted(tenantTables).map((table) => ({ table_name: table, nullable: 'NO', references_organizations: true })),
    );
  });

  it('only the authenticated role has RLS policies', async () => {
    const roles = await t.db.query<{ roles: string }>(
      "select distinct roles::text as roles from pg_policies where schemaname in ('public', 'app_private')",
    );
    expect(roles).toEqual([{ roles: '{authenticated}' }]);
  });

  it('every reference between tenant tables is a composite (x_id, organization_id) foreign key', async () => {
    // Foreign keys from public tables to public tables other than `organizations` itself.
    const keys = await t.db.query<{ name: string; columns: string[]; referenced: string[] }>(
      `select c.conname as name,
              array(select a.attname::text from unnest(c.conkey) with ordinality k(attnum, n)
                    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum order by k.n) as columns,
              array(select a.attname::text from unnest(c.confkey) with ordinality k(attnum, n)
                    join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum order by k.n) as referenced
       from pg_constraint c
       join pg_class r on r.oid = c.confrelid
       where c.contype = 'f' and c.connamespace = 'public'::regnamespace
         and r.relnamespace = 'public'::regnamespace and r.relname <> 'organizations'`,
    );
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect({ name: key.name, columns: key.columns.slice(1), referenced: key.referenced }).toEqual({
        name: key.name,
        columns: ['organization_id'],
        referenced: ['id', 'organization_id'],
      });
    }
    // Each of them is exercised below.
    expect(sorted(keys.map((key) => key.name))).toEqual(sorted(LINK_RULES.map((rule) => rule.constraint)));
  });

  it('uuid columns without a foreign key are only the documented ones', async () => {
    // conversations.visitor_id is an anonymous id, not a reference. usage_records.agent_id/conversation_id are
    // append-only metering annotations without a key: their consistency is checked at the data level below.
    const columns = await t.db.query<{ name: string }>(
      `select c.table_name || '.' || c.column_name as name
       from information_schema.columns c
       where c.table_schema = 'public' and c.data_type = 'uuid' and c.column_name not in ('id', 'organization_id')
         and not exists (
           select 1 from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any(k.conkey)
           where k.contype = 'f' and k.conrelid = ('public.' || c.table_name)::regclass and a.attname = c.column_name
         )`,
    );
    expect(sorted(columns.map((row) => row.name))).toEqual([
      'conversations.visitor_id',
      'usage_records.agent_id',
      'usage_records.conversation_id',
    ]);
  });
});

describe('composite foreign keys refuse cross-tenant references (even in service scope)', () => {
  describe.each(LINK_RULES)('$constraint', (rule) => {
    it("refuses a row of A that points at B's entity", async () => {
      // Control: the same row pointing at A's own entity is valid.
      expectInserted(await attemptRolledBack(asService, rule.row(A, A)));

      const before = { a: await tenantDigest(A), b: await tenantDigest(B) };
      expectForeignKeyViolation(await attempt(asService, rule.row(A, B)), rule.constraint);
      expect({ a: await tenantDigest(A), b: await tenantDigest(B) }).toEqual(before);
    });
  });

  it("refuses re-pointing existing rows at B's entities and moving rows with dependents into B", async () => {
    const [chunk] = await idsOf('knowledge_chunks', A.orgId);
    const cases: Array<{ statement: Statement; constraint?: string }> = [
      {
        statement: ['update public.conversations set contact_id = $1 where id = $2', [B.contactId, A.conversationId]],
        constraint: 'conversations_contact_id_organization_id_fkey',
      },
      {
        statement: ['update public.leads set contact_id = $1 where id = $2', [B.contactId, A.leadId]],
        constraint: 'leads_contact_id_organization_id_fkey',
      },
      {
        // A fresh chunk_index keeps (document_id, chunk_index) unique, so only the composite key can refuse it.
        statement: ['update public.knowledge_chunks set document_id = $1, chunk_index = 999 where id = $2', [B.documentId, chunk!]],
        constraint: 'knowledge_chunks_document_id_organization_id_fkey',
      },
      {
        statement: ['update public.messages set conversation_id = $1 where conversation_id = $2', [B.conversationId, A.conversationId]],
        constraint: 'messages_conversation_id_organization_id_fkey',
      },
      { statement: ['update public.agents set organization_id = $1 where id = $2', [B.orgId, A.agentId]] },
      { statement: ['update public.knowledge_sources set organization_id = $1 where id = $2', [B.orgId, A.sourceId]] },
      { statement: ['update public.conversations set organization_id = $1 where id = $2', [B.orgId, A.conversationId]] },
    ];
    const before = { a: await tenantDigest(A), b: await tenantDigest(B) };
    for (const { statement, constraint } of cases) {
      expectForeignKeyViolation(await attempt(asService, statement), constraint, statement[0]);
    }
    expect({ a: await tenantDigest(A), b: await tenantDigest(B) }).toEqual(before);
  });
});

// ── domain services ───────────────────────────────────────────────────────────

const runners = () =>
  [
    ['service scope', asService],
    ["A's owner (user scope)", asUser(A.ownerId)],
  ] as const;

describe("domain services given organization A's id and B's entity ids", () => {
  it('agent, channel and business lookups return nothing', async () => {
    for (const [, run] of runners()) {
      await run(async (sql) => {
        expect(await getAgent(sql, A.orgId, B.agentId)).toBeNull();
        expect(await getAgent(sql, A.orgId, A.agentId)).not.toBeNull();
        expect(await getWebChatChannel(sql, A.orgId, B.agentId)).toBeNull();
        expect((await getWebChatChannel(sql, A.orgId, A.agentId))?.publicKey).toBe(A.widgetKey);
        expect(await getBusinessProfile(sql, A.orgId, B.agentId)).toBeNull();
        expect((await getBusinessProfile(sql, A.orgId, A.agentId))?.businessName).toBe(A.spec.profile.businessName);
        expect(await listBusinessHours(sql, A.orgId, B.agentId)).toEqual([]);
        expect(await listBusinessHours(sql, A.orgId, A.agentId)).toEqual(A.spec.hours);
        expect(sorted((await listAgents(sql, A.orgId)).map((agent) => agent.id))).toEqual(sorted([A.agentId, A.spareAgentId]));
      });
    }
    // Under RLS, naming B's organization outright does not help A's owner (the service scope can, by design).
    await asUser(A.ownerId)(async (sql) => {
      expect(await getAgent(sql, B.orgId, B.agentId)).toBeNull();
      expect(await getWebChatChannel(sql, B.orgId, B.agentId)).toBeNull();
      expect(await getBusinessProfile(sql, B.orgId, B.agentId)).toBeNull();
      expect(await listBusinessHours(sql, B.orgId, B.agentId)).toEqual([]);
      expect(await listAgents(sql, B.orgId)).toEqual([]);
    });
    expect(await asService((sql) => getAgent(sql, B.orgId, B.agentId))).not.toBeNull();
  });

  it('conversation, message and contact lookups return nothing', async () => {
    for (const [, run] of runners()) {
      await run(async (sql) => {
        expect(await getConversation(sql, A.orgId, B.conversationId)).toBeNull();
        expect(await getConversation(sql, A.orgId, A.conversationId)).not.toBeNull();
        expect(
          await getActiveVisitorConversation(sql, { organizationId: A.orgId, agentId: B.agentId, visitorId: B.visitorId }),
        ).toBeNull();
        expect(
          await getActiveVisitorConversation(sql, { organizationId: A.orgId, agentId: A.agentId, visitorId: B.visitorId }),
        ).toBeNull();
        expect(
          (await getActiveVisitorConversation(sql, { organizationId: A.orgId, agentId: A.agentId, visitorId: A.visitorId }))?.id,
        ).toBe(A.conversationId);
        expect(await listMessages(sql, A.orgId, B.conversationId)).toEqual([]);
        expect((await listMessages(sql, A.orgId, A.conversationId)).length).toBeGreaterThan(0);
        expect(await listRecentTextMessages(sql, A.orgId, B.conversationId, 50)).toEqual([]);
        expect((await listRecentTextMessages(sql, A.orgId, A.conversationId, 50)).length).toBeGreaterThan(0);
        expect(await getContact(sql, A.orgId, B.contactId)).toBeNull();
        expect(await getContact(sql, A.orgId, A.contactId)).not.toBeNull();
      });
    }
    await asUser(A.ownerId)(async (sql) => {
      expect(await getConversation(sql, B.orgId, B.conversationId)).toBeNull();
      expect(await listMessages(sql, B.orgId, B.conversationId)).toEqual([]);
      expect(await getContact(sql, B.orgId, B.contactId)).toBeNull();
    });
  });

  it('admin list and detail views of A never include B, and B stays invisible to A even by id', async () => {
    const owner = t.asUser(A.ownerId);
    for (const db of [t.service, owner]) {
      expect(await getConversationDetail(db, A.orgId, B.conversationId)).toBeNull();
      expect(await getKnowledgeSource(db, A.orgId, B.sourceId)).toBeNull();
      expect((await getKnowledgeSource(db, A.orgId, A.sourceId))?.status).toBe('ready');
      const detail = await getConversationDetail(db, A.orgId, A.conversationId);
      expect(detail?.contact?.id).toBe(A.contactId);
      expect(detail?.toolRuns.map((run) => run.toolName)).toEqual(['searchKnowledge', 'captureLead']);

      const conversations = await listConversations(db, A.orgId);
      expect(sorted(conversations.map((item) => item.id))).toEqual(sorted(await idsOf('conversations', A.orgId)));
      const leads = await listLeads(db, A.orgId);
      expect(leads.map((lead) => [lead.id, lead.contact.id])).toEqual([[A.leadId, A.contactId]]);
      expect((await listKnowledgeSources(db, A.orgId)).map((source) => source.id)).toEqual([A.sourceId]);
    }
    // The admin UI's own scope with B's organization id: RLS returns nothing at all.
    expect(await getConversationDetail(owner, B.orgId, B.conversationId)).toBeNull();
    expect(await listConversations(owner, B.orgId)).toEqual([]);
    expect(await listLeads(owner, B.orgId)).toEqual([]);
    expect(await listKnowledgeSources(owner, B.orgId)).toEqual([]);
    expect(await getKnowledgeSource(owner, B.orgId, B.sourceId)).toBeNull();
    // Control: B's owner does see B's records.
    expect((await listLeads(t.asUser(B.ownerId), B.orgId)).map((lead) => lead.id)).toEqual([B.leadId]);
  });

  it('membership lookups never reveal another organization', async () => {
    const owner = t.asUser(A.ownerId);
    expect((await getMembershipBySlug(owner, A.ownerId, A.slug))?.role).toBe('owner');
    expect(await getMembershipBySlug(owner, A.ownerId, B.slug)).toBeNull();
    expect(await getMembershipBySlug(owner, B.ownerId, B.slug)).toBeNull();
    expect(await listMemberships(owner, B.ownerId)).toEqual([]);
    expect((await listMemberships(owner, A.ownerId)).map((membership) => membership.organization.id)).toEqual([A.orgId]);
    expect(await listMemberships(t.asUser(outsiderId), outsiderId)).toEqual([]);
    expect(await getMembershipBySlug(t.asUser(outsiderId), outsiderId, A.slug)).toBeNull();
    // Control: the privileged scope sees B's membership.
    expect((await listMemberships(t.service, B.ownerId)).map((membership) => membership.organization.id)).toEqual([B.orgId]);
  });

  it("retrieval never returns another organization's chunks, even for an exact-match vector with no threshold", async () => {
    const [bChunk] = await t.db.query<{ id: string; embedding: string }>(
      'select id, embedding::text as embedding from public.knowledge_chunks where organization_id = $1 order by chunk_index limit 1',
      [B.orgId],
    );
    const embedding = parseVector(bChunk!.embedding);
    const query = (organizationId: string, agentId: string) =>
      asService((sql) =>
        retrieveChunks(sql, {
          organizationId,
          agentId,
          embedding,
          embeddingModel: EMBEDDING_MODEL,
          maxChunks: 20,
          maxTokens: 8000,
          minSimilarity: -1,
        }),
      );

    // Control: B's own agent gets the chunk back as an exact match.
    const own = await query(B.orgId, B.agentId);
    expect(own[0]?.chunkId).toBe(bChunk!.id);
    expect(own[0]?.similarity).toBeCloseTo(1, 5);
    // A with its own agent: only (all of) A's chunks, never B's.
    expect(sorted((await query(A.orgId, A.agentId)).map((chunk) => chunk.chunkId))).toEqual(sorted(await idsOf('knowledge_chunks', A.orgId)));
    // A naming B's agent (or B naming A's) gets nothing, not even its own shared knowledge.
    expect(await query(A.orgId, B.agentId)).toEqual([]);
    expect(await query(B.orgId, A.agentId)).toEqual([]);
  });

  it("searchKnowledge for A never finds B's facts", async () => {
    // The configured retrieval budget, as the searchKnowledge tool uses it.
    const { maxRetrievedChunks, maxRetrievedTokens, minRetrievalSimilarity } = services.ai.budgets;
    const budget = { maxChunks: maxRetrievedChunks, maxTokens: maxRetrievedTokens, minSimilarity: minRetrievalSimilarity };
    const search = (x: Tenant, query: string) =>
      searchKnowledge(t.service, services.embedder, { organizationId: x.orgId, agentId: x.agentId, query, budget });

    expect((await search(B, B.spec.fact))[0]?.content).toContain(B.spec.fact);
    expect(await search(A, B.spec.fact)).toEqual([]);
    expect(await search(A, B.spec.question)).toEqual([]);
    expect((await search(A, A.spec.question))[0]?.content).toContain(A.spec.fact);
  });

  it("writes given A's organization never touch B (service scope)", async () => {
    const before = await tenantDigest(B);
    const beforeA = await tenantDigest(A);

    await asService((sql) => closeConversation(sql, A.orgId, B.conversationId));
    await expectDomainError(
      asService((sql) => appendMessage(sql, A.orgId, B.conversationId, { role: 'assistant', content: 'Injected' })),
      'not_found',
    );
    expect(await asService((sql) => tryAcquireTurnLock(sql, A.orgId, B.conversationId, 60))).toBe(false);
    await asService((sql) => updateSummary(sql, A.orgId, B.conversationId, 'Hijacked', 1_000_000));
    await expectDomainError(
      asService((sql) =>
        captureLead(sql, {
          organizationId: A.orgId,
          agentId: A.agentId,
          conversationId: B.conversationId,
          channel: 'web_chat',
          name: 'Mallory',
          phone: '+15559990000',
        }),
      ),
      'not_found',
    );
    // An agent of B under A's organization: the composite key refuses the lead (and the contact rolls back with it).
    const crossAgentLead = asService((sql) =>
      captureLead(sql, {
        organizationId: A.orgId,
        agentId: B.agentId,
        conversationId: null,
        channel: 'web_chat',
        name: 'Mallory',
        phone: '+15559990000',
      }),
    );
    expectForeignKeyViolation(await outcomeOf(crossAgentLead), 'leads_agent_id_organization_id_fkey');

    const settings = { ...DEFAULT_AGENT_SETTINGS, name: 'Hijacked' };
    await expectDomainError(asService((sql) => updateAgentSettings(sql, A.orgId, B.agentId, settings)), 'not_found');
    await expectDomainError(asService((sql) => setWebChatEnabled(sql, A.orgId, B.agentId, false)), 'not_found');
    await expectDomainError(asService((sql) => rotateWidgetKey(sql, A.orgId, B.agentId)), 'not_found');
    await expectDomainError(asService((sql) => ensureWebChatChannel(sql, A.orgId, B.spareAgentId)), 'not_found');
    const profile = { businessName: 'Hijacked', description: null, phone: null, email: null, website: null, address: null, serviceArea: null };
    await expectDomainError(asService((sql) => upsertBusinessProfile(sql, A.orgId, B.agentId, profile)), 'not_found');
    await expectDomainError(asService((sql) => replaceBusinessHours(sql, A.orgId, B.agentId, [])), 'not_found');

    expect(await deleteKnowledgeSource(t.service, A.orgId, B.sourceId)).toBe(false);
    await expectDomainError(reindexKnowledgeSource(t.service, services.embedder, A.orgId, B.sourceId), 'not_found');
    await expectDomainError(
      ingestTextSource(t.service, services.embedder, {
        organizationId: A.orgId,
        agentId: B.agentId,
        kind: 'text',
        title: 'Injected',
        text: 'Injected knowledge.',
        createdBy: null,
      }),
      'invalid',
    );

    expect(await tenantDigest(B)).toEqual(before);
    expect(await tenantDigest(A)).toEqual(beforeA);
  });

  it("does not release B's turn lock from A", async () => {
    expect(await asService((sql) => tryAcquireTurnLock(sql, B.orgId, B.conversationId, 60))).toBe(true);
    try {
      await asService((sql) => releaseTurnLock(sql, A.orgId, B.conversationId));
      // Still held: another turn of B cannot start.
      expect(await asService((sql) => tryAcquireTurnLock(sql, B.orgId, B.conversationId, 60))).toBe(false);
    } finally {
      await asService((sql) => releaseTurnLock(sql, B.orgId, B.conversationId));
    }
  });

  it("A's owner cannot change B through the admin functions (user scope, B's organization id)", async () => {
    const before = await tenantDigest(B);
    const owner = asUser(A.ownerId);
    const settings = { ...DEFAULT_AGENT_SETTINGS, name: 'Hijacked' };

    await expectDomainError(owner((sql) => updateAgentSettings(sql, B.orgId, B.agentId, settings)), 'not_found');
    await expectDomainError(owner((sql) => setWebChatEnabled(sql, B.orgId, B.agentId, false)), 'not_found');
    // Widget keys are never written under user scope, for any organization (the server rotates them).
    expectDenied(await outcomeOf(owner((sql) => rotateWidgetKey(sql, B.orgId, B.agentId))), 'privilege');
    await expectDomainError(owner((sql) => replaceBusinessHours(sql, B.orgId, B.agentId, [])), 'not_found');
    const profile = { businessName: 'Hijacked', description: null, phone: null, email: null, website: null, address: null, serviceArea: null };
    await expectDomainError(owner((sql) => upsertBusinessProfile(sql, B.orgId, B.agentId, profile)), 'not_found');
    expect(await deleteKnowledgeSource(t.asUser(A.ownerId), B.orgId, B.sourceId)).toBe(false);
    await expectDomainError(reindexKnowledgeSource(t.asUser(A.ownerId), services.embedder, B.orgId, B.sourceId), 'not_found');
    await expectDomainError(
      ingestTextSource(t.asUser(A.ownerId), services.embedder, {
        organizationId: B.orgId,
        agentId: null,
        kind: 'text',
        title: 'Injected',
        text: 'Injected knowledge.',
        createdBy: A.ownerId,
      }),
      'forbidden',
    );

    expect(await tenantDigest(B)).toEqual(before);
  });
});

// ── agent runtime, tool executor and the public channel ──────────────────────

async function loadAgent(x: Tenant): Promise<Agent> {
  const agent = await asService((sql) => getAgent(sql, x.orgId, x.agentId));
  if (!agent) throw new Error('agent not found');
  return agent;
}

describe('agent runtime and tools', () => {
  it("refuses to run a turn in another organization's conversation", async () => {
    const before = { a: await tenantDigest(A), b: await tenantDigest(B) };
    const events: AgentEvent[] = [];
    const emit = (event: AgentEvent) => {
      events.push(event);
    };
    const agentA = await loadAgent(A);
    const agentB = await loadAgent(B);

    await expectDomainError(
      services.runChatTurn(
        { organizationId: A.orgId, agent: agentA, conversationId: B.conversationId, channel: 'web_chat', userText: 'Hello?' },
        emit,
      ),
      'not_found',
    );
    // B's agent presented under A's organization (or in A's conversation) is refused before anything is read.
    await expectDomainError(
      services.runChatTurn(
        { organizationId: A.orgId, agent: agentB, conversationId: A.conversationId, channel: 'web_chat', userText: 'Hello?' },
        emit,
      ),
      'not_found',
    );
    await expectDomainError(
      services.runChatTurn(
        { organizationId: B.orgId, agent: agentB, conversationId: A.conversationId, channel: 'web_chat', userText: 'Hello?' },
        emit,
      ),
      'not_found',
    );
    expect(events).toEqual([]);
    expect({ a: await tenantDigest(A), b: await tenantDigest(B) }).toEqual(before);
  });

  it("the tool executor cannot write into another organization's conversation", async () => {
    const before = { a: await tenantDigest(A), b: await tenantDigest(B) };
    const result = await services.toolExecutor.execute(
      { callId: 'call_cross_tenant_1', name: 'captureLead', arguments: JSON.stringify({ name: 'Mallory', phone: '+15559990000' }) },
      { organizationId: A.orgId, agent: await loadAgent(A), conversationId: B.conversationId, channel: 'web_chat', now: NOW },
    );
    // No audit row means no execution: the run could not be recorded against B's conversation.
    expect(result).toMatchObject({ ok: false, toolRunId: null, errorCode: 'unavailable' });
    expect({ a: await tenantDigest(A), b: await tenantDigest(B) }).toEqual(before);
  });

  it("searchKnowledge through the executor returns none of B's knowledge to A", async () => {
    const run = (x: Tenant, callId: string) =>
      loadAgent(x).then((agent) =>
        services.toolExecutor.execute(
          { callId, name: 'searchKnowledge', arguments: JSON.stringify({ query: B.spec.fact }) },
          { organizationId: x.orgId, agent, conversationId: x.conversationId, channel: 'web_chat', now: NOW },
        ),
      );

    const fromA = await run(A, 'call_cross_tenant_2');
    expect(fromA.ok).toBe(true);
    expect(JSON.parse(fromA.modelOutput)).toMatchObject({ ok: true, results: [] });
    for (const marker of B.spec.markers) expect(fromA.modelOutput).not.toContain(marker);
    const [stored] = await t.db.query<{ organization_id: string; output: unknown }>(
      'select organization_id, output from public.tool_runs where id = $1',
      [fromA.toolRunId],
    );
    expect(stored?.organization_id).toBe(A.orgId);
    expect(stored?.output).toMatchObject({ results: [] });

    // Control: the same call for B finds the fact.
    const fromB = await run(B, 'call_cross_tenant_3');
    expect(fromB.modelOutput).toContain(B.spec.fact);
  });

  it("business tools answer from the organization's own profile and hours, and refuse another organization's agent", async () => {
    for (const x of [A, B]) {
      const agent = await loadAgent(x);
      const context = { organizationId: x.orgId, agent, conversationId: x.quietConversationId, channel: 'web_chat' as const, now: NOW };
      const info = await services.toolExecutor.execute({ callId: `call_info_${x.slug}`, name: 'getBusinessInfo', arguments: '{}' }, context);
      const configured = Object.fromEntries(Object.entries(x.spec.profile).filter(([, value]) => value !== null));
      expect(JSON.parse(info.modelOutput)).toEqual({ ok: true, ...configured });
      const hours = await services.toolExecutor.execute({ callId: `call_hours_${x.slug}`, name: 'getBusinessHours', arguments: '{}' }, context);
      expect(JSON.parse(hours.modelOutput)).toMatchObject({ ok: true, timezone: agent.timezone, weekly: weeklyOf(x.spec.hours) });
    }

    // B's agent presented under A's organization: the run cannot even be recorded, so nothing is read.
    const before = { a: await tenantDigest(A), b: await tenantDigest(B) };
    const agentB = await loadAgent(B);
    for (const name of ['getBusinessInfo', 'getBusinessHours']) {
      const refused = await services.toolExecutor.execute(
        { callId: `call_cross_tenant_${name}`, name, arguments: '{}' },
        { organizationId: A.orgId, agent: agentB, conversationId: A.quietConversationId, channel: 'web_chat', now: NOW },
      );
      expect(refused).toMatchObject({ ok: false, toolRunId: null, errorCode: 'unavailable' });
    }
    expect({ a: await tenantDigest(A), b: await tenantDigest(B) }).toEqual(before);
  });
});

/** getBusinessHours' weekly view of a set of intervals (Sunday first). */
function weeklyOf(hours: readonly HoursInterval[]): Array<{ day: string; hours: string[] }> {
  return DAY_NAMES.map((day, dayOfWeek) => ({
    day,
    hours: hours.filter((interval) => interval.dayOfWeek === dayOfWeek).map((interval) => `${interval.opensAt}-${interval.closesAt}`),
  }));
}

describe('public web chat channel', () => {
  it("a visitor session minted by A's widget is worthless at B's widget", async () => {
    const ip = '198.51.100.40';
    const before = { a: await tenantDigest(A), b: await tenantDigest(B) };

    // Opening B's widget with A's token starts a fresh visitor of B: nothing of A is restored.
    const session = await services.webChat.startSession({ widgetKey: B.widgetKey, sessionToken: A.visitorToken }, { ip });
    expect(session.agent.name).toBe(B.spec.agentName);
    expect(session.conversation).toBeNull();
    const issued = verifyWidgetSession(session.sessionToken, { secret: WIDGET_SECRET, now: NOW });
    expect(issued?.agentId).toBe(B.agentId);
    expect(issued?.visitorId).not.toBe(A.visitorId);
    await expect(
      services.webChat.openMessageStream({ widgetKey: B.widgetKey, sessionToken: A.visitorToken, text: 'Hello' }, { ip }),
    ).rejects.toMatchObject({ name: 'WebChatError', code: 'invalid_session', status: 401 });
    await expect(
      services.webChat.resetConversation({ widgetKey: B.widgetKey, sessionToken: A.visitorToken }, { ip }),
    ).rejects.toMatchObject({ name: 'WebChatError', code: 'invalid_session', status: 401 });

    // Control: at A's widget the same token restores A's conversation.
    const restored = await services.webChat.startSession({ widgetKey: A.widgetKey, sessionToken: A.visitorToken }, { ip });
    expect(restored.conversation?.id).toBe(A.conversationId);
    expect({ a: await tenantDigest(A), b: await tenantDigest(B) }).toEqual(before);
  });

  it('ignores tenant ids smuggled into the request body', async () => {
    const ip = '198.51.100.41';
    const smuggled = { organizationId: A.orgId, agentId: A.agentId, conversationId: A.conversationId, visitorId: A.visitorId };
    const beforeA = await tenantDigest(A);

    const session = await services.webChat.startSession({ ...smuggled, widgetKey: B.widgetKey, sessionToken: B.visitorToken }, { ip });
    expect(session.agent.name).toBe(B.spec.agentName);
    expect(session.conversation?.id).toBe(B.conversationId);
    expect(session.conversation?.messages.map((message) => message.content).join('\n')).not.toContain(A.spec.fact);

    // A new visitor of B: the message runs in a new conversation of B, answered from B's knowledge, and
    // "New chat" closes that conversation, never A's.
    const fresh = await services.webChat.startSession({ ...smuggled, widgetKey: B.widgetKey }, { ip });
    const turn = await visitorTurn(B.widgetKey, fresh.sessionToken, B.spec.question, ip, smuggled);
    expect(turn.reply).toContain(B.spec.fact);
    const conversation = 'select organization_id, agent_id, status from public.conversations where id = $1';
    expect(await t.db.query(conversation, [turn.conversationId])).toEqual([
      { organization_id: B.orgId, agent_id: B.agentId, status: 'active' },
    ]);
    await services.webChat.resetConversation({ ...smuggled, widgetKey: B.widgetKey, sessionToken: fresh.sessionToken }, { ip });
    expect(await t.db.query(conversation, [turn.conversationId])).toEqual([
      { organization_id: B.orgId, agent_id: B.agentId, status: 'closed' },
    ]);
    expect(await tenantDigest(A)).toEqual(beforeA);
  });

  it("A's visitor asking about B's business gets no evidence and no invented answer", async () => {
    const ip = '198.51.100.42';
    const session = await services.webChat.startSession({ widgetKey: A.widgetKey }, { ip });
    const turn = await visitorTurn(A.widgetKey, session.sessionToken, B.spec.question, ip);

    const tools = turn.events.flatMap((event) =>
      event.type === 'tool.call' || event.type === 'tool.result' ? [{ type: event.type, name: event.name }] : [],
    );
    expect(tools).toEqual([
      { type: 'tool.call', name: 'searchKnowledge' },
      { type: 'tool.result', name: 'searchKnowledge' },
    ]);
    expect(turn.reply).toBe(NO_INFORMATION_REPLY);
    const runs = await t.db.query<{ organization_id: string; output: unknown }>(
      'select organization_id, output from public.tool_runs where conversation_id = $1',
      [turn.conversationId],
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.organization_id).toBe(A.orgId);
    expect(runs[0]?.output).toMatchObject({ results: [] });

    // Nothing one tenant knows reached any of the other's tool results or replies (business tools included).
    for (const [x, other] of [
      [A, B],
      [B, A],
    ] as const) {
      for (const marker of other.spec.markers) {
        const leaked = await t.db.query(
          `select id from public.tool_runs where organization_id = $1 and output::text ilike $2
           union all
           select id from public.messages where organization_id = $1 and role = 'assistant' and content ilike $2`,
          [x.orgId, `%${marker}%`],
        );
        expect(leaked, `${other.spec.name}'s "${marker}" in ${x.spec.name}`).toEqual([]);
      }
    }
  });
});

describe('data written by the product stays within its tenant', () => {
  it("metering and audit rows only ever reference their own organization's records", async () => {
    // usage_records has no foreign keys on agent_id/conversation_id: the server must never cross tenants.
    const usage = await t.db.query(
      `select u.id from public.usage_records u
       left join public.agents a on a.id = u.agent_id
       left join public.conversations c on c.id = u.conversation_id
       where (u.agent_id is not null and a.organization_id is distinct from u.organization_id)
          or (u.conversation_id is not null and c.organization_id is distinct from u.organization_id)`,
    );
    expect(usage).toEqual([]);
    const audit = await t.db.query(
      `select l.id from public.audit_logs l
       left join public.conversations c on l.target_type = 'conversation' and c.id::text = l.target_id
       where (l.target_type = 'conversation' and c.organization_id is distinct from l.organization_id)
          or (l.target_type = 'organization' and l.target_id is distinct from l.organization_id::text)`,
    );
    expect(audit).toEqual([]);

    for (const x of [A, B]) {
      const metered = await t.db.query<{ usage: string }>(
        "select distinct kind || '/' || purpose as usage from public.usage_records where organization_id = $1",
        [x.orgId],
      );
      expect(sorted(metered.map((row) => row.usage))).toEqual([
        'embedding/knowledge_ingestion',
        'embedding/knowledge_query',
        'text_generation/chat_response',
      ]);
      // The visitor's turns are metered against the tenant's own agent and conversation.
      const attributed = await t.db.query<{ purpose: string }>(
        `select distinct purpose from public.usage_records
         where organization_id = $1 and agent_id = $2 and conversation_id = $3`,
        [x.orgId, x.agentId, x.conversationId],
      );
      expect(sorted(attributed.map((row) => row.purpose))).toEqual(['chat_response', 'knowledge_query']);
      const audited = await t.db.query<{ action: string }>('select distinct action from public.audit_logs where organization_id = $1', [
        x.orgId,
      ]);
      expect(sorted(audited.map((row) => row.action))).toEqual(['organization.created', 'tool.captureLead']);
    }
  });

  it('the same phone number gives each organization its own contact', async () => {
    // Had B's capture matched A's contact, it would have renamed it (and failed on the composite keys).
    expect(A.contactId).not.toBe(B.contactId);
    for (const x of [A, B]) {
      const contacts = await t.db.query<{ id: string; name: string; phone_normalized: string }>(
        'select id, name, phone_normalized from public.contacts where organization_id = $1',
        [x.orgId],
      );
      expect(contacts).toEqual([{ id: x.contactId, name: x.spec.visitorName, phone_normalized: '5551234567' }]);
    }
  });
});

function parseVector(text: string): number[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.every((value): value is number => typeof value === 'number')) {
    throw new Error('not a vector');
  }
  return parsed;
}
