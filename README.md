# Syncore AI Receptionist

A multi-tenant AI receptionist platform. A business configures one agent (business profile, hours, knowledge, lead
capture) and deploys it across channels. This repository currently implements **Phase 0 (foundation)** and
**Phase 1 (web chat vertical slice)** from [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md):

```
organization → agent configuration → knowledge → web chat → searchKnowledge / business tools
             → lead capture → persisted conversation → usage metering
```

Authoritative requirements: [CLAUDE.md](CLAUDE.md), [PRODUCT_SPEC.md](PRODUCT_SPEC.md),
[ARCHITECTURE.md](ARCHITECTURE.md), [AI_RUNTIME.md](AI_RUNTIME.md), [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

## Stack

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript 6 (strict) · Tailwind 4 · Zod 4 · Supabase (Auth + Postgres
+ pgvector) · node-postgres · OpenAI (Responses API + embeddings) behind provider adapters · Vitest 5 + PGlite.

## Architecture in one page

```
src/
  app/                      Next.js routes — thin: authorize, validate, call services, render
    api/widget/*            public web chat API (session, messages [SSE], reset)
    widget/[widgetKey]      the embeddable chat page (loaded in an iframe by public/embed.js)
    o/[orgSlug]/*           authenticated admin UI
  components/               React UI (admin + widget)
  shared/widget-protocol.ts Zod wire protocol shared by the widget and the API
  widget/                   browser-only widget runtime (Zustand UI state machine + controller)
  server/
    config/                 Zod-validated env loaders + price snapshot (the only place model names live)
    db/                     Sql/Database seam, user vs service scopes, node-postgres adapter
    ai/                     provider-neutral contracts, ModelRouter, metered embeddings, OpenAI adapters
    domain/                 organizations, agents, business profile/hours, knowledge, contacts/leads,
                            conversations/messages, usage (cost service), audit
    agent/                  agent core: tool registry + executor, ContextAssembler, chat-turn runtime, summaries
    channels/webchat/       widget sessions (signed tokens), rate limits, SSE streaming — no business logic
    auth/                   Supabase Auth helpers + organization access
supabase/migrations/        SQL migrations (Supabase CLI layout)
tests/                      unit, integration (PGlite), acceptance suites
scripts/                    migrate, seed, reembed-knowledge, eval-live
public/embed.js             widget loader for customer websites
```

Key decisions:

- **PostgreSQL is the source of truth.** Domain code runs parameterized SQL through a minimal `Sql` seam. Every query on
  tenant data filters by `organization_id`, and composite foreign keys `(x_id, organization_id)` make cross-tenant links
  impossible at the database level.
- **Two database scopes.** Admin requests run as Postgres role `authenticated` with the user's JWT claims
  (`set_config('role', …)`, the mechanism PostgREST uses), so **Supabase RLS applies** on top of explicit scoping. The
  public widget runtime has no user; it runs in the privileged service scope after resolving the tenant from the widget
  key server-side.
- **Models never touch the database.** The model can only request tools; the executor looks the tool up, checks channel
  availability and the agent's capabilities, validates arguments with Zod, records a `tool_runs` row, runs the domain
  service, persists the outcome (with an audit entry for side effects), and returns a minimal JSON result. Side-effecting
  tools are idempotent per conversation.
- **Provider-neutral AI layer.** `TextModelProvider` / `EmbeddingProvider` contracts; OpenAI SDK types never leave
  `src/server/ai/openai/`. `ModelRouter` selects configuration (cheap default model; stronger escalation model only after
  a failed attempt or for explicitly complex work; summaries always on the cheap model). Provider and model names come
  from env.
- **Bounded context.** One `ContextAssembler`: concise stable instructions, only the relevant structured facts, the last
  `AI_MAX_RECENT_MESSAGES` messages plus a rolling summary, and only the tools available to this agent on this channel.
  Retrieval enforces org + agent scoping, a relevance threshold, a top-K cap and a token cap.
- **Usage metering.** Adapters report normalized usage; a cost service prices it into `usage_records` (per organization,
  agent and conversation), including embeddings and tool-call counts.

## Getting started

Prerequisites: Node.js 22.12+ (24 LTS recommended) and a Supabase project (or the Supabase CLI locally).

1. Install: `npm install`
2. Configure: copy `.env.example` to `.env.local` and fill in Supabase URL + publishable key, `DATABASE_URL`,
   `OPENAI_API_KEY`, and a random `WIDGET_SESSION_SECRET` (≥ 32 chars). For a verified TLS connection to the database,
   download the Supabase CA (Database settings → SSL configuration) into `DATABASE_SSL_CA`; without it, remote
   connections are encrypted but the certificate is not verified (a warning is logged).
3. Database: `npm run db:migrate` (applies `supabase/migrations/*` and records them in the Supabase CLI's
   `supabase_migrations.schema_migrations` table — `supabase db push` works too).
4. Auth: in Supabase → Authentication → URL configuration, add `<your-app-origin>/auth/confirm` to the redirect URLs.
5. Run: `npm run dev`, open the app, create an account, create your organization, configure the agent, add knowledge and
   publish web chat. The agent page shows the embed snippet and a preview link.
6. Optional demo data: `npm run db:seed -- --owner-email you@example.com` (an existing account) creates a demo tenant.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js |
| `npm run typecheck` | `next typegen && tsc --noEmit` |
| `npm run lint` | ESLint (Next + typescript-eslint strict type-checked) |
| `npm test` | Vitest: unit + integration + acceptance (PGlite, no network, no Docker) |
| `npm run db:migrate` | Apply SQL migrations to `DATABASE_URL` |
| `npm run db:seed` | Create the demo tenant |
| `npm run knowledge:reembed` | Re-embed knowledge after changing `AI_EMBEDDING_MODEL` (`-- --dry-run` to preview) |
| `npm run eval:live` | Run the acceptance conversations against the real configured providers |

## Changing models

Text and escalation models switch with configuration alone (`AI_TEXT_*`, `AI_ESCALATION_*`); usage is metered per
model. The embedding model is different: retrieval only compares a question with chunks embedded by the same model, so
after changing `AI_EMBEDDING_MODEL` existing knowledge stays "ready" but is not searchable until it is re-embedded.
Run `npm run knowledge:reembed` once after deploying the new model (it processes every organization and meters the
embedding cost per organization). The vector column is `vector(1536)`: a model with another dimension needs a migration.

## Testing

Integration and acceptance tests run against **PGlite** — real Postgres compiled to WebAssembly with pgvector — so the
actual migrations, RLS policies, constraints and vector search are exercised in-process. A tiny shim provides the Supabase
platform objects (`anon`/`authenticated` roles, `auth.users`, `auth.uid()`). Model calls use deterministic fakes; run
`npm run eval:live` with an `OPENAI_API_KEY` to check behavior against the real models.

## Security and deployment notes

- **Auth emails.** `/auth/confirm` accepts only PKCE `?code=` links (the code is bound to the browser that signed up),
  so keep Supabase's default "Confirm signup" template (`{{ .ConfirmationURL }}`) and add `<origin>/auth/confirm` to the
  allowed redirect URLs. A custom token-hash template is intentionally not supported (it allows login CSRF).
- **Supabase Data API.** The app talks to Postgres directly and never uses PostgREST. RLS and explicit grants protect the
  tables anyway, but you can remove `public` from the Data API's exposed schemas (Dashboard → API settings) to shrink the
  attack surface.
- **Database TLS.** Set `DATABASE_SSL_CA` to the Supabase CA for a verified connection and enable "Enforce SSL".
- **Widget keys** are generated and rotated only by the server; database roles used by signed-in users cannot choose or
  change a key. Public chat endpoints are rate-limited per client (IPv6 per /64), per widget and per organization.
- **Model calls** run only on the server; provider secrets never reach the browser. Visitor-supplied contact details
  are stored on the lead as given and never overwrite an existing contact.

## Known limitations (Phase 0/1)

- Web chat only: web voice, phone, SMS, callbacks, human transfer, billing and dashboards are later phases.
- Knowledge: manual text and TXT/Markdown uploads (no PDF yet); ingestion runs synchronously in the request (no job
  queue); retrieval is an exact tenant-scoped vector scan (add an ANN index when per-tenant volumes require it).
- Model behavior is verified with deterministic fakes in the test suite; run `npm run eval:live` with a real
  `OPENAI_API_KEY` to check the configured models.
- Fallback sentences (shown when the model produces no usable answer) are English.
- Any website can embed a published widget key (there is no allowed-origins list yet); rate limits bound abuse.

## Embedding the widget

```html
<script src="https://<your-app-origin>/embed.js" data-widget-key="wk_…" async></script>
```

The loader adds a launcher button and lazily opens an iframe served by this app, so API calls are same-origin and no
provider secret ever reaches the browser. The browser keeps only an opaque signed session token; the conversation lives
in Postgres and is restored on refresh/reopen.
