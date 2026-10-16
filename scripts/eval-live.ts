/**
 * Live evaluation: runs the Phase 1 acceptance conversations against the REAL configured providers.
 *
 *   npm run eval:live            (= tsx --conditions=react-server scripts/eval-live.ts)
 *
 * Providers and models come from the environment exactly as in production (AI_* variables and OPENAI_API_KEY;
 * .env.local and .env are loaded, variables already set win). Everything else is throwaway: an in-memory PGlite
 * database (the Supabase test shim + supabase/migrations), two demo tenants created through the domain services,
 * and the web chat channel service driven the way the widget drives it. It never touches DATABASE_URL and is not
 * part of `npm test`: it calls paid APIs (a run costs well under one US cent with the default models).
 *
 * Each scenario prints the visitor message, the tool calls, the reply, usage/cost and heuristic checks:
 *   1. a question answered in the knowledge base gets a grounded answer;
 *   2. an unknown question gets no invented facts and an "I don't have that information" answer;
 *   3. name + phone are captured as a lead through the captureLead tool;
 *   4. reopening the widget with the stored session token restores the same conversation;
 *   5. one tenant cannot retrieve another tenant's knowledge;
 *   6. usage is metered on the configured provider/model (change AI_TEXT_MODEL etc. and re-run to compare).
 * The exit code is 1 when any check fails or the configuration is incomplete.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { createDefaultProviderFactories } from '@/server/ai/providers';
import type { ProviderFactories } from '@/server/ai/registry';
import { loadAiConfig, loadLogLevel, loadOpenAIConfig, loadWidgetConfig, type AiConfig } from '@/server/config/env';
import { loadMigrations } from '@/server/db/migrations';
import { serviceScope, userScope } from '@/server/db/scope';
import { pgTextArray, toNumber } from '@/server/db/sql';
import type { Database } from '@/server/db/types';
import { setWebChatEnabled, updateAgentSettings } from '@/server/domain/agents/repository';
import type { AgentSettings } from '@/server/domain/agents/schemas';
import { replaceBusinessHours, upsertBusinessProfile } from '@/server/domain/business/repository';
import type { BusinessProfileInput } from '@/server/domain/business/schemas';
import type { HoursInterval } from '@/server/domain/business/types';
import { ingestTextSource } from '@/server/domain/knowledge/ingestion';
import { searchKnowledge } from '@/server/domain/knowledge/retrieval';
import { createOrganization } from '@/server/domain/organizations/service';
import { createLogger, type Logger } from '@/server/observability/logger';
import { createServices, type AppServices } from '@/server/services';
import { createSseParser, type WidgetEvent } from '@/shared/widget-protocol';
import { pgliteDatabase, pgliteOptions } from '../tests/support/pglite';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHIM_FILE = path.join(ROOT, 'tests', 'support', 'supabase-shim.sql');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');

// ── demo tenants ──────────────────────────────────────────────────────────────

interface DemoTenant {
  name: string;
  ownerEmail: string;
  agent: AgentSettings;
  profile: BusinessProfileInput;
  hours: HoursInterval[];
  knowledge: Array<{ title: string; text: string }>;
}

const HOME_SERVICES: DemoTenant = {
  name: 'Demo Home Services',
  ownerEmail: 'owner@demo-home-services.example',
  agent: {
    name: 'Riley',
    status: 'active',
    greeting: "Hi! I'm Riley from Demo Home Services. How can I help with your plumbing, heating or cooling today?",
    language: 'en',
    timezone: 'America/New_York',
    instructions:
      'You answer for Demo Home Services, a residential plumbing, heating and air conditioning company. Be warm and ' +
      'brief. If a visitor needs a technician, a quote or a callback, collect their name and phone number.',
    leadCapture: { enabled: true, requiredFields: ['name', 'phone'] },
  },
  profile: {
    businessName: 'Demo Home Services',
    description: 'Residential plumbing, heating and air conditioning repair and maintenance.',
    phone: '(555) 010-0199',
    email: 'hello@demo-home-services.example',
    website: 'https://demo-home-services.example',
    address: '120 Main Street, Springfield, IL 62701',
    serviceArea: 'Springfield and towns within 25 miles',
  },
  hours: [
    ...[1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, opensAt: '08:00', closesAt: '18:00' })),
    { dayOfWeek: 6, opensAt: '09:00', closesAt: '13:00' },
  ],
  knowledge: [
    {
      title: 'Services and pricing',
      text: [
        '# Service call',
        'A standard service call (diagnosis) costs $89. The fee is waived when you approve the recommended repair.',
        '',
        '# Labor and tune-ups',
        'Labor is $120 per hour after the first hour. An annual heating or cooling tune-up is $129 per system.',
        '',
        '# Emergency service',
        'Emergency service is available 24/7 for burst pipes, major leaks, no heat and no cooling.',
        'Emergency visits outside business hours add a $150 after-hours fee.',
        '',
        '# Service area',
        'We serve Springfield and the towns within 25 miles, including Riverton and Chatham.',
      ].join('\n'),
    },
  ],
};

const PINBALL: DemoTenant = {
  name: 'Shelbyville Pinball Restoration',
  ownerEmail: 'owner@shelbyville-pinball.example',
  agent: {
    name: 'Flip',
    status: 'active',
    greeting: 'Hi! Ask me anything about restoring your pinball machine.',
    language: 'en',
    timezone: 'America/Chicago',
    instructions: 'You answer for a small pinball restoration workshop.',
    leadCapture: { enabled: true, requiredFields: ['name', 'phone'] },
  },
  profile: {
    businessName: 'Shelbyville Pinball Restoration',
    description: 'Restoration of vintage pinball machines.',
    phone: '(555) 020-0300',
    email: null,
    website: null,
    address: '7 Arcade Lane, Shelbyville',
    serviceArea: null,
  },
  hours: [2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, opensAt: '10:00', closesAt: '16:00' })),
  knowledge: [
    {
      title: 'Restoration',
      text: [
        '# Restoration',
        'We restore vintage pinball machines from the 1960s to the 1990s at our Shelbyville workshop.',
        'A full restoration costs $1,450 per machine and takes about six weeks.',
      ].join('\n'),
    },
  ],
};

const GROUNDED_QUESTION = 'How much do you charge for a standard service call?';
const UNKNOWN_QUESTION = 'Do you install swimming pools?';
const LEAD_MESSAGE = "I'm Jane Doe and my number is (555) 123-4567 — please call me back about a quote.";
const LEAD_PHONE = '5551234567';
/** Facts only the home-services tenant knows: none may reach the pinball tenant. */
const HOME_SERVICES_MARKERS = ['$89', 'Demo Home Services', 'Springfield'];

/**
 * "I don't have that information"-style wording: the agent says what it does not know. A bare negation does not
 * count — "No, we don't install pools" is itself an invented fact.
 */
const NO_INFORMATION =
  /\b(?:(?:don['’]t|do not|doesn['’]t|does not)\s+(?:have|know|see)|(?:can['’]t|cannot|couldn['’]t|could not|unable to|not able to)\s+(?:find|confirm|answer|say|see)|no (?:information|details)|not sure)\b/i;
const AFFIRMATIVE_START = /^\W*(?:yes|yeah|absolutely|certainly|of course|sure|we do)\b/i;
const SERVICE_CALL_FEE = /\$\s?89\b/;
const PRICE = /\$\s?\d[\d,]*(?:\.\d+)?/g;
const PHONE_LIKE = /\+?\(?\d[\d\s().-]{6,}\d/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

// ── evaluation ────────────────────────────────────────────────────────────────

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

interface TurnResult {
  conversationId: string | null;
  reply: string;
  error: string | null;
}

interface ToolRunRow {
  id: string;
  tool_name: string;
  status: string;
  input: unknown;
  output: unknown;
  error_code: string | null;
}

interface UsageRow {
  id: string;
  kind: string;
  purpose: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: string | number;
  pricing_known: boolean;
  metadata: unknown;
}

interface Snapshot {
  usage: string[];
  toolRuns: string[];
}

export interface LiveEvaluationOptions {
  ai: AiConfig;
  providers: ProviderFactories;
  logger: Logger;
  print?: (line: string) => void;
}

export interface LiveEvaluationReport {
  passed: number;
  failed: number;
  costUsd: number;
}

interface TenantHandle {
  spec: DemoTenant;
  orgId: string;
  agentId: string;
  widgetKey: string;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const quote = (text: string, max = 160) => JSON.stringify(text.length > max ? `${text.slice(0, max)}…` : text);

/** An in-memory Postgres (PGlite) with the Supabase test shim and every migration applied. */
async function createEvalDatabase(): Promise<Database> {
  const pg = await PGlite.create(pgliteOptions());
  await pg.exec(await readFile(SHIM_FILE, 'utf8'));
  for (const migration of await loadMigrations(MIGRATIONS_DIR)) await pg.exec(migration.sql);
  return pgliteDatabase(pg);
}

/** Onboarding and owner configuration through the domain services, knowledge through the configured embedder. */
async function createTenant(db: Database, services: AppServices, spec: DemoTenant, logger: Logger): Promise<TenantHandle> {
  const ownerId = randomUUID();
  await db.query('insert into auth.users (id, email) values ($1, $2)', [ownerId, spec.ownerEmail]);
  const { organization, agent } = await createOrganization(db, { name: spec.name, ownerUserId: ownerId, agentName: spec.agent.name });
  const owner = userScope(db, ownerId);
  const channel = await owner.run(async (sql) => {
    await updateAgentSettings(sql, organization.id, agent.id, spec.agent);
    await upsertBusinessProfile(sql, organization.id, agent.id, spec.profile);
    await replaceBusinessHours(sql, organization.id, agent.id, spec.hours);
    return setWebChatEnabled(sql, organization.id, agent.id, true);
  });
  if (channel.publicKey === null) throw new Error(`${spec.name}: the published web chat has no widget key`);
  for (const source of spec.knowledge) {
    const ingested = await ingestTextSource(
      owner,
      services.embedder,
      { organizationId: organization.id, agentId: null, kind: 'text', title: source.title, text: source.text, createdBy: ownerId },
      { logger },
    );
    if (ingested.status !== 'ready') throw new Error(`${spec.name}: knowledge "${source.title}" failed: ${ingested.error ?? 'unknown'}`);
  }
  return { spec, orgId: organization.id, agentId: agent.id, widgetKey: channel.publicKey };
}

async function readEvents(stream: ReadableStream<Uint8Array>): Promise<WidgetEvent[]> {
  const events: WidgetEvent[] = [];
  const parser = createSseParser((event) => events.push(event));
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
  parser.push(decoder.decode());
  parser.flush();
  return events;
}

/** One visitor message through the web chat channel (as POST /api/widget/messages does), incl. post-turn work. */
async function visitorTurn(services: AppServices, widgetKey: string, sessionToken: string, text: string, ip: string): Promise<TurnResult> {
  const { stream, done } = await services.webChat.openMessageStream({ widgetKey, sessionToken, text }, { ip });
  const events = await readEvents(stream);
  await done;
  const result: TurnResult = { conversationId: null, reply: '', error: null };
  for (const event of events) {
    if (event.type === 'turn.start') result.conversationId = event.conversationId;
    if (event.type === 'turn.done') result.reply = event.text;
    if (event.type === 'turn.error') result.error = `${event.code}: ${event.message}`;
  }
  return result;
}

async function snapshot(db: Database): Promise<Snapshot> {
  const usage = await db.query<{ id: string }>('select id from public.usage_records');
  const toolRuns = await db.query<{ id: string }>('select id from public.tool_runs');
  return { usage: usage.map((row) => row.id), toolRuns: toolRuns.map((row) => row.id) };
}

async function newToolRuns(db: Database, since: Snapshot): Promise<ToolRunRow[]> {
  return db.query<ToolRunRow>(
    `select id, tool_name, status, input, output, error_code from public.tool_runs
     where id <> all($1::uuid[]) order by started_at, id`,
    [pgTextArray(since.toolRuns)],
  );
}

const USAGE_COLUMNS =
  'id, kind, purpose, provider, model, input_tokens, output_tokens, estimated_cost_usd, pricing_known, metadata';

async function newUsage(db: Database, since: Snapshot): Promise<UsageRow[]> {
  return db.query<UsageRow>(
    `select ${USAGE_COLUMNS} from public.usage_records where id <> all($1::uuid[]) order by created_at, id`,
    [pgTextArray(since.usage)],
  );
}

function describeToolRun(run: ToolRunRow): string {
  const output = asRecord(run.output);
  let outcome = run.status;
  if (run.error_code) outcome += ` (${run.error_code})`;
  if (run.tool_name === 'searchKnowledge' && Array.isArray(output?.results)) outcome += `, ${output.results.length} result(s)`;
  if (run.tool_name === 'captureLead' && Array.isArray(output?.fields)) outcome += `, saved ${output.fields.map(String).join('/')}`;
  return `${run.tool_name} ${JSON.stringify(run.input)} -> ${outcome}`;
}

function usageLines(rows: readonly UsageRow[]): string[] {
  const groups = new Map<string, { calls: number; input: number; output: number; cost: number; unpriced: boolean }>();
  for (const row of rows) {
    const tier = asRecord(row.metadata)?.tier;
    const key = `${row.provider}/${row.model} ${row.purpose}${tier === 'escalation' ? ' [escalation]' : ''}`;
    const group = groups.get(key) ?? { calls: 0, input: 0, output: 0, cost: 0, unpriced: false };
    group.calls += 1;
    group.input += toNumber(row.input_tokens);
    group.output += toNumber(row.output_tokens);
    group.cost += toNumber(row.estimated_cost_usd);
    group.unpriced ||= !row.pricing_known;
    groups.set(key, group);
  }
  return [...groups].map(
    ([key, group]) =>
      `${key} x${group.calls}: ${group.input} in / ${group.output} out tokens, ` +
      (group.unpriced ? 'unpriced (add it to AI_MODEL_PRICING_JSON)' : `$${group.cost.toFixed(8)}`),
  );
}

const totalCost = (rows: readonly UsageRow[]) => rows.reduce((sum, row) => sum + toNumber(row.estimated_cost_usd), 0);

/** "$1,450.00" -> 1450 */
const priceValue = (price: string) => Number(price.replace(/[$,\s]/g, ''));

/** Prices, phone numbers and emails in the reply that appear nowhere in what the tenant told the agent. */
function inventedFacts(reply: string, tenant: DemoTenant): string[] {
  const source = [
    ...tenant.knowledge.map((item) => item.text),
    ...Object.values(tenant.profile).filter((value): value is string => typeof value === 'string'),
  ].join('\n');
  const sourceDigits = source.replace(/\D/g, '');
  const knownPrices = new Set((source.match(PRICE) ?? []).map(priceValue));
  const invented: string[] = [];
  for (const price of reply.match(PRICE) ?? []) {
    if (!knownPrices.has(priceValue(price))) invented.push(price);
  }
  for (const phone of reply.match(PHONE_LIKE) ?? []) {
    const digits = phone.replace(/\D/g, '');
    if (digits.length >= 7 && !sourceDigits.includes(digits)) invented.push(phone.trim());
  }
  for (const email of reply.match(EMAIL) ?? []) {
    if (!source.toLowerCase().includes(email.toLowerCase())) invented.push(email);
  }
  return invented;
}

const check = (name: string, pass: boolean, detail?: string): Check => ({ name, pass, detail });

export async function runLiveEvaluation(options: LiveEvaluationOptions): Promise<LiveEvaluationReport> {
  const { ai, providers, logger } = options;
  const print = options.print ?? ((line: string) => console.log(line));
  const report: LiveEvaluationReport = { passed: 0, failed: 0, costUsd: 0 };
  const record = (checks: readonly Check[]) => {
    for (const item of checks) {
      print(`  ${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.detail === undefined ? '' : ` — ${item.detail}`}`);
      if (item.pass) report.passed += 1;
      else report.failed += 1;
    }
  };

  print('Configured routes (from the environment):');
  print(`  text        ${ai.text.provider}/${ai.text.model} (reasoning: ${ai.text.reasoningEffort})`);
  print(
    `  escalation  ${ai.escalation.enabled ? `${ai.escalation.provider}/${ai.escalation.model} (reasoning: ${ai.escalation.reasoningEffort})` : 'disabled'}`,
  );
  print(`  embeddings  ${ai.embedding.provider}/${ai.embedding.model}`);

  const db = await createEvalDatabase();
  try {
    const services = createServices({
      db,
      logger,
      ai,
      providers,
      // Throwaway sessions for this in-memory run only.
      widget: loadWidgetConfig({ WIDGET_SESSION_SECRET: randomBytes(32).toString('base64url') }),
    });

    print('\nSetting up two tenants (onboarding, owner configuration, knowledge embedded with the configured model)…');
    const setupStart = await snapshot(db);
    const home = await createTenant(db, services, HOME_SERVICES, logger);
    const pinball = await createTenant(db, services, PINBALL, logger);
    for (const line of usageLines(await newUsage(db, setupStart))) print(`  usage  ${line}`);

    const ip = '203.0.113.10';
    const session = await services.webChat.startSession({ widgetKey: home.widgetKey }, { ip });

    /** Prints one visitor turn with its tool calls and usage, then its checks. */
    const scenario = async (
      title: string,
      tenant: TenantHandle,
      sessionToken: string,
      message: string,
      visitorIp: string,
      evaluate: (turn: TurnResult, runs: ToolRunRow[]) => Promise<Check[]> | Check[],
    ): Promise<TurnResult> => {
      print(`\n== ${title} ==`);
      print(`Visitor (${tenant.spec.name}): ${message}`);
      const before = await snapshot(db);
      const turn = await visitorTurn(services, tenant.widgetKey, sessionToken, message, visitorIp);
      const runs = await newToolRuns(db, before);
      for (const run of runs) print(`  tool   ${describeToolRun(run)}`);
      print(turn.error === null ? `Agent: ${turn.reply}` : `Agent failed: ${turn.error}`);
      for (const line of usageLines(await newUsage(db, before))) print(`  usage  ${line}`);
      record([check('the turn completed', turn.error === null && turn.reply !== '', turn.error ?? undefined), ...(await evaluate(turn, runs))]);
      return turn;
    };

    // 1. Grounded answer.
    const grounded = await scenario('1. Question answered in the knowledge base', home, session.sessionToken, GROUNDED_QUESTION, ip, (turn, runs) => {
      const invented = inventedFacts(turn.reply, HOME_SERVICES);
      return [
        // The evidence: the fee has to come back from retrieval, not from the model's own knowledge.
        check(
          'searchKnowledge succeeded and returned the $89 service-call fee',
          runs.some(
            (run) => run.tool_name === 'searchKnowledge' && run.status === 'succeeded' && SERVICE_CALL_FEE.test(JSON.stringify(run.output)),
          ),
        ),
        check('the reply states the $89 service-call fee', SERVICE_CALL_FEE.test(turn.reply), quote(turn.reply)),
        check('the reply invents no prices or contact details', invented.length === 0, invented.join(', ') || undefined),
      ];
    });

    // 2. Unknown question.
    await scenario('2. Question the knowledge base cannot answer', home, session.sessionToken, UNKNOWN_QUESTION, ip, (turn) => {
      const invented = inventedFacts(turn.reply, HOME_SERVICES);
      return [
        check('the reply says it does not have that information', NO_INFORMATION.test(turn.reply), quote(turn.reply)),
        check('the reply does not claim the service is offered', !AFFIRMATIVE_START.test(turn.reply)),
        check('the reply invents no prices or contact details', invented.length === 0, invented.join(', ') || undefined),
      ];
    });

    // 3. Lead capture.
    const lead = await scenario('3. Visitor leaves name and phone', home, session.sessionToken, LEAD_MESSAGE, ip, async (turn, runs) => {
      const rows = await db.query<{ name: string | null; phone_normalized: string | null; contact_id: string; linked: string | null }>(
        `select c.name, c.phone_normalized, l.contact_id, v.contact_id as linked
         from public.leads l
         join public.contacts c on c.id = l.contact_id and c.organization_id = l.organization_id
         join public.conversations v on v.id = l.conversation_id and v.organization_id = l.organization_id
         where l.organization_id = $1 and l.conversation_id = $2`,
        [home.orgId, turn.conversationId],
      );
      const saved = rows[0];
      const captured = runs.some((run) => run.tool_name === 'captureLead' && run.status === 'succeeded');
      return [
        check('captureLead succeeded', captured),
        check(
          "one lead with the visitor's name and phone is linked to the conversation",
          rows.length === 1 && saved?.phone_normalized === LEAD_PHONE && /jane/i.test(saved.name ?? '') && saved.linked === saved.contact_id,
          JSON.stringify(rows),
        ),
        // AI_RUNTIME / CLAUDE.md: never claim an action succeeded unless its tool returned success.
        check('the reply confirms saving only after captureLead succeeded', captured || !/\b(?:saved|noted|recorded|passed)\b/i.test(turn.reply), quote(turn.reply)),
      ];
    });

    // 4. Reopen.
    print('\n== 4. Visitor reopens the widget (refresh) ==');
    const reopened = await services.webChat.startSession({ widgetKey: home.widgetKey, sessionToken: session.sessionToken }, { ip });
    const stored = await db.query<{ id: string }>(
      `select id from public.messages where organization_id = $1 and conversation_id = $2 and role in ('user', 'assistant') order by seq`,
      [home.orgId, grounded.conversationId],
    );
    print(`Restored ${String(reopened.conversation?.messages.length ?? 0)} message(s) of conversation ${reopened.conversation?.id ?? '(none)'}`);
    record([
      check('the same conversation is restored', grounded.conversationId !== null && reopened.conversation?.id === grounded.conversationId),
      check(
        'the restored transcript is the stored user/assistant messages, in order',
        JSON.stringify(reopened.conversation?.messages.map((message) => message.id)) === JSON.stringify(stored.map((row) => row.id)),
      ),
      check('the last restored message is the latest reply', reopened.conversation?.messages.at(-1)?.content === lead.reply),
    ]);

    // 5. Tenant isolation.
    const otherIp = '203.0.113.20';
    const otherSession = await services.webChat.startSession({ widgetKey: pinball.widgetKey }, { ip: otherIp });
    await scenario(
      "5. Another tenant's widget is asked about the first tenant's facts",
      pinball,
      otherSession.sessionToken,
      GROUNDED_QUESTION,
      otherIp,
      async (turn, runs) => {
        const leakedTools = runs.filter((run) => HOME_SERVICES_MARKERS.some((marker) => JSON.stringify(run.output).includes(marker)));
        const retrieved = await searchKnowledge(serviceScope(db), services.embedder, {
          organizationId: pinball.orgId,
          agentId: pinball.agentId,
          query: GROUNDED_QUESTION,
          budget: { maxChunks: 20, maxTokens: 8000, minSimilarity: -1 },
        });
        const sources = await db.query<{ id: string }>('select id from public.knowledge_sources where organization_id = $1', [pinball.orgId]);
        const ownSources = new Set(sources.map((row) => row.id));
        return [
          check('no tool result contains the other tenant\'s knowledge', leakedTools.length === 0, leakedTools.map(describeToolRun).join('; ') || undefined),
          check(
            "the reply contains none of the other tenant's facts",
            !SERVICE_CALL_FEE.test(turn.reply) && !HOME_SERVICES_MARKERS.some((marker) => turn.reply.includes(marker)),
            quote(turn.reply),
          ),
          check(
            'retrieval without a relevance threshold returns only this tenant\'s chunks',
            retrieved.length > 0 && retrieved.every((chunk) => ownSources.has(chunk.sourceId)),
            `${retrieved.length} chunk(s)`,
          ),
        ];
      },
    );

    // 6. Configuration and metering.
    print('\n== 6. Usage metered on the configured providers and models ==');
    const usage = await newUsage(db, { usage: [], toolRuns: [] });
    for (const line of usageLines(usage)) print(`  usage  ${line}`);
    const textRows = usage.filter((row) => row.kind === 'text_generation');
    const embeddingRows = usage.filter((row) => row.kind === 'embedding');
    const offRoute = [
      ...textRows.filter((row) => {
        const escalation = asRecord(row.metadata)?.tier === 'escalation';
        const profile = escalation ? ai.escalation : ai.text;
        return row.provider !== profile.provider || !row.model.startsWith(profile.model);
      }),
      ...embeddingRows.filter((row) => row.provider !== ai.embedding.provider || !row.model.startsWith(ai.embedding.model)),
    ];
    const unmetered = usage.filter((row) => row.input_tokens <= 0 || (row.pricing_known && toNumber(row.estimated_cost_usd) <= 0));
    record([
      check('chat, knowledge-query and ingestion usage were all recorded', ['chat_response', 'knowledge_query', 'knowledge_ingestion'].every((purpose) => usage.some((row) => row.purpose === purpose))),
      check('every model call ran on the configured provider/model', offRoute.length === 0, offRoute.map((row) => `${row.provider}/${row.model}`).join(', ') || undefined),
      check('every priced call has tokens and an estimated cost', unmetered.length === 0, unmetered.map((row) => `${row.purpose} ${row.model}`).join(', ') || undefined),
    ]);
    report.costUsd = totalCost(usage);
  } finally {
    await db.close();
  }

  print(`\n${report.passed} check(s) passed, ${report.failed} failed. Estimated provider cost of this run: $${report.costUsd.toFixed(6)}.`);
  return report;
}

// ── entry point ───────────────────────────────────────────────────────────────

/** `.env.local` wins over `.env`; variables already set in the environment win over both. */
function loadEnvFiles(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(path.join(ROOT, file));
    } catch {
      // Missing file: nothing to load.
    }
  }
}

async function main(): Promise<number> {
  loadEnvFiles();
  let ai: AiConfig;
  let providers: ProviderFactories;
  let logger: Logger;
  try {
    ai = loadAiConfig();
    const openai = loadOpenAIConfig();
    const configured = [ai.text.provider, ai.embedding.provider, ...(ai.escalation.enabled ? [ai.escalation.provider] : [])];
    if (configured.includes('openai') && !openai.apiKey) {
      console.error('OPENAI_API_KEY is not set. eval:live runs the acceptance conversations against the real configured');
      console.error('providers: add OPENAI_API_KEY to .env.local (see .env.example), then run `npm run eval:live`.');
      return 1;
    }
    providers = createDefaultProviderFactories({ openai, ai });
    // Warnings (escalations, unpriced models, provider failures) are worth seeing; set LOG_LEVEL for more or less.
    logger = createLogger({ level: process.env.LOG_LEVEL ? loadLogLevel() : 'warn' });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  try {
    const report = await runLiveEvaluation({ ai, providers, logger });
    return report.failed > 0 ? 1 : 0;
  } catch (error) {
    console.error(`Live evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalize = (file: string) => {
    const resolved = path.resolve(file);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(fileURLToPath(import.meta.url)) === normalize(entry);
}

if (isEntryPoint()) {
  process.exitCode = await main();
}
