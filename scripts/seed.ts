/**
 * Creates a demo tenant ("Demo Home Services") owned by an EXISTING Supabase Auth
 * user: agent settings, business profile and hours, published web chat and two
 * knowledge sources. Idempotent: does nothing if the demo organization exists.
 *
 *   npm run db:seed -- --owner-email you@example.com   (or SEED_OWNER_EMAIL)
 *
 * Knowledge is embedded with the configured provider and is skipped when
 * OPENAI_API_KEY is not set (add it later from the Knowledge page).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Embedder } from '@/server/ai/embedder';
import { getAppServices } from '@/server/app-services';
import { loadOpenAIConfig } from '@/server/config/env';
import { getDatabase } from '@/server/db/client';
import { serviceScope } from '@/server/db/scope';
import { maybeOne } from '@/server/db/sql';
import type { Database } from '@/server/db/types';
import { setWebChatEnabled, updateAgentSettings } from '@/server/domain/agents/repository';
import type { AgentSettings } from '@/server/domain/agents/schemas';
import { replaceBusinessHours, upsertBusinessProfile } from '@/server/domain/business/repository';
import type { BusinessProfileInput } from '@/server/domain/business/schemas';
import type { HoursInterval } from '@/server/domain/business/types';
import { ingestTextSource } from '@/server/domain/knowledge/ingestion';
import type { KnowledgeSource } from '@/server/domain/knowledge/types';
import { createOrganization, type Organization } from '@/server/domain/organizations/service';
import type { Logger } from '@/server/observability/logger';
import type { AppServices } from '@/server/services';

const DEMO_NAME = 'Demo Home Services';
const DEMO_SLUG = 'demo-home-services';
const EXAMPLE_ORIGIN = 'http://localhost:3000';

const AGENT_SETTINGS: AgentSettings = {
  name: 'Riley',
  status: 'active',
  greeting: "Hi! I'm Riley from Demo Home Services. How can I help with your plumbing, heating or cooling today?",
  language: 'en',
  timezone: 'America/New_York',
  instructions:
    'You are the virtual receptionist for Demo Home Services, a residential plumbing, heating and air conditioning ' +
    'company. Be warm and brief. If a visitor needs a technician, a quote or a callback, collect their name and phone ' +
    'number so the team can follow up.',
  leadCapture: { enabled: true, requiredFields: ['name', 'phone'] },
};

const BUSINESS_PROFILE: BusinessProfileInput = {
  businessName: DEMO_NAME,
  description: 'Residential plumbing, heating and air conditioning repair, maintenance and installation.',
  phone: '(555) 010-0199',
  email: 'hello@demo-home-services.example',
  website: 'https://demo-home-services.example',
  address: '120 Main Street, Springfield, IL 62701',
  serviceArea: 'Springfield and surrounding towns within 25 miles',
};

// Monday-Friday 08:00-18:00, Saturday 09:00-13:00 (agent timezone).
const BUSINESS_HOURS: HoursInterval[] = [
  ...[1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, opensAt: '08:00', closesAt: '18:00' })),
  { dayOfWeek: 6, opensAt: '09:00', closesAt: '13:00' },
];

const KNOWLEDGE = [
  {
    title: 'Services and pricing',
    text: `# Services and pricing

Demo Home Services repairs, maintains and installs residential plumbing, heating and air conditioning systems.

## Services
- Plumbing: leak and pipe repair, drain cleaning, water heater repair and replacement, fixture installation.
- Heating: furnace and boiler repair, heat pump service, annual heating tune-ups.
- Cooling: air conditioner repair, refrigerant checks, annual cooling tune-ups, new system installation.

## Pricing
- Standard service call (diagnosis): $89. The fee is waived when you approve the recommended repair.
- Labor: $120 per hour after the first hour.
- Annual tune-up (heating or cooling): $129 per system.
- Estimates for new system installations and water heater replacements are free.
- Seniors and military veterans receive 10% off labor.

Prices apply during business hours and exclude parts. The technician confirms the final price before any work starts.`,
  },
  {
    title: 'Frequently asked questions',
    text: `# Frequently asked questions

## What area do you serve?
We serve Springfield and the surrounding towns within 25 miles, including Riverton, Chatham and Rochester.

## Do you offer emergency service?
Yes. Emergency service is available 24/7 for no heat, no cooling in extreme weather, burst pipes and major leaks.
Emergency visits outside business hours add a $150 after-hours fee.

## How can I pay?
We accept Visa, Mastercard, American Express, Discover, debit cards, checks and cash. Financing is available for
new system installations.

## Do you guarantee your work?
Yes. All repairs include a one-year labor warranty. Parts carry the manufacturer's warranty, and new system
installations include a ten-year parts and labor plan when registered within 60 days.`,
  },
];

/** `.env.local` wins over `.env`; variables already set in the environment win over both. */
function loadEnvFiles(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
    } catch {
      // Missing file: nothing to load.
    }
  }
}

function ownerEmailArgument(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--owner-email') return args[index + 1];
    if (arg.startsWith('--owner-email=')) return arg.slice('--owner-email='.length);
  }
  return process.env.SEED_OWNER_EMAIL;
}

interface WidgetDetails {
  widgetKey: string | null;
  published: boolean;
}

export type SeedOutcome =
  | ({ status: 'exists' } & WidgetDetails)
  | { status: 'missing_owner' }
  | ({ status: 'created'; organization: Organization; knowledge: KnowledgeSource[] | null } & WidgetDetails);

async function findExistingDemo(db: Database): Promise<WidgetDetails | null> {
  const row = maybeOne(
    await db.query<{ public_key: string | null; enabled: boolean | null }>(
      `select c.public_key, c.enabled
       from public.organizations o
       left join public.agent_channels c on c.organization_id = o.id and c.channel = 'web_chat'
       where o.slug = $1
       order by c.created_at
       limit 1`,
      [DEMO_SLUG],
    ),
  );
  return row ? { widgetKey: row.public_key, published: row.enabled === true } : null;
}

/**
 * Creates the demo tenant through the product's own domain services (privileged connection, like
 * onboarding). Knowledge is ingested only when `knowledge` is given (it needs an embedding provider).
 */
export async function seedDemoTenant(
  db: Database,
  options: { ownerEmail: string; knowledge?: { embedder: Embedder; logger: Logger } },
): Promise<SeedOutcome> {
  const existing = await findExistingDemo(db);
  if (existing) return { status: 'exists', ...existing };

  const owner = maybeOne(
    await db.query<{ id: string }>('select id from auth.users where lower(email) = lower($1) limit 1', [
      options.ownerEmail,
    ]),
  );
  if (!owner) return { status: 'missing_owner' };

  const { organization, agent } = await createOrganization(db, { name: DEMO_NAME, ownerUserId: owner.id });
  const channel = await serviceScope(db).run(async (sql) => {
    await updateAgentSettings(sql, organization.id, agent.id, AGENT_SETTINGS);
    await upsertBusinessProfile(sql, organization.id, agent.id, BUSINESS_PROFILE);
    await replaceBusinessHours(sql, organization.id, agent.id, BUSINESS_HOURS);
    return setWebChatEnabled(sql, organization.id, agent.id, true);
  });

  let knowledge: KnowledgeSource[] | null = null;
  if (options.knowledge) {
    knowledge = [];
    // Embedding is network I/O: each source is ingested outside any transaction, one after the other.
    for (const source of KNOWLEDGE) {
      knowledge.push(
        await ingestTextSource(
          serviceScope(db),
          options.knowledge.embedder,
          { organizationId: organization.id, agentId: null, kind: 'text', createdBy: owner.id, ...source },
          { logger: options.knowledge.logger },
        ),
      );
    }
  }
  return { status: 'created', organization, knowledge, widgetKey: channel.publicKey, published: channel.enabled };
}

function printWidget({ widgetKey, published }: WidgetDetails): void {
  if (!widgetKey) {
    console.log('  Web chat:   no widget key yet (publish it from the agent page)');
    return;
  }
  console.log(`  Widget key: ${widgetKey}${published ? '' : ' (web chat is not published)'}`);
  console.log(`  Preview:    /widget/${widgetKey}`);
  console.log(`  Embed:      <script src="${EXAMPLE_ORIGIN}/embed.js" data-widget-key="${widgetKey}" async></script>`);
  console.log(`              (replace ${EXAMPLE_ORIGIN} with your app's origin)`);
}

async function main(args: readonly string[]): Promise<number> {
  loadEnvFiles();
  const email = z.email().safeParse(ownerEmailArgument(args)?.trim());
  if (!email.success) {
    console.error('Pass the email of an existing account: npm run db:seed -- --owner-email you@example.com');
    console.error('(or set SEED_OWNER_EMAIL). Sign up in the app first if you have no account yet.');
    return 2;
  }

  // Validate all configuration before writing anything; knowledge needs the AI services.
  let services: AppServices | null;
  let db: Database;
  try {
    services = loadOpenAIConfig().apiKey ? getAppServices() : null;
    db = services?.db ?? getDatabase();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Configure .env.local (see .env.example).');
    return 1;
  }

  try {
    const outcome = await seedDemoTenant(db, {
      ownerEmail: email.data,
      knowledge: services ? { embedder: services.embedder, logger: services.logger } : undefined,
    });
    if (outcome.status === 'missing_owner') {
      console.error(`No account uses ${email.data}. Sign up in the app first, then run the seed again.`);
      return 1;
    }
    if (outcome.status === 'exists') {
      console.log(`The demo organization already exists (/o/${DEMO_SLUG}); nothing to do.`);
      printWidget(outcome);
      return 0;
    }

    console.log(`Created ${outcome.organization.name} (/o/${outcome.organization.slug}) owned by ${email.data}`);
    console.log(`  Agent:      ${AGENT_SETTINGS.name} (America/New_York, Mon-Fri 08:00-18:00, Sat 09:00-13:00)`);
    if (outcome.knowledge === null) {
      console.log('  Knowledge:  skipped (OPENAI_API_KEY is not set; add knowledge from the Knowledge page later)');
    }
    for (const source of outcome.knowledge ?? []) {
      const detail = source.status === 'ready' ? `${source.chunkCount} chunks` : (source.error ?? 'failed');
      console.log(`  Knowledge:  "${source.title}" ${source.status} (${detail})`);
    }
    printWidget(outcome);
    return 0;
  } catch (error) {
    console.error(`Seeding failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await db.close();
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
  process.exitCode = await main(process.argv.slice(2));
}
