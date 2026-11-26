# Syncore AI Receptionist

An industry-neutral, multi-tenant AI front-office platform. A business configures one agent (business profile, hours,
knowledge, lead capture) and deploys it across channels: inbound phone, realtime web voice, web chat and consent-based
outbound calls. Status (see [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)):

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Multi-tenant foundation | Implemented |
| 1 | Web chatbot, knowledge, tools | Implemented |
| 1.5 | Hardening and live validation | Implemented in code; live validation pending credentials ([LIVE_VALIDATION.md](LIVE_VALIDATION.md)) |
| 2 | Realtime voice engine + developer voice lab | Implemented in code; **not yet tested against the live provider** (not complete) |
| 3–8 | Phone, booking/SMS, voice widget, outbound, commercial readiness, templates | Planned |

```
organization → agent configuration → knowledge → web chat → searchKnowledge / business tools
             → lead capture → persisted conversation → usage metering (with spend limits)
```

Authoritative documents: [CLAUDE.md](CLAUDE.md) (rules), [PRODUCT_SPEC.md](PRODUCT_SPEC.md),
[ARCHITECTURE.md](ARCHITECTURE.md), [AI_RUNTIME.md](AI_RUNTIME.md) (models, routing, prices, cost controls),
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md), [VOICE_QUALITY.md](VOICE_QUALITY.md),
[LIVE_VALIDATION.md](LIVE_VALIDATION.md).

This software has not been validated against live Supabase or OpenAI services yet and is not production-ready.

## Stack

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript 6 (strict) · Tailwind 4 · Zod 4 · Supabase (Auth + Postgres
+ pgvector) · node-postgres · OpenAI (Responses API + embeddings) behind provider adapters · Vitest 5 + PGlite ·
GitHub Actions CI.

## Architecture in one page

```
src/
  app/                      Next.js routes — thin: authorize, validate, call services, render
    api/widget/*            public web chat API (session, messages [SSE], reset)
    widget/[widgetKey]      the embeddable chat page (loaded in an iframe by public/embed.js)
    o/[orgSlug]/*           authenticated admin UI (voice-lab: developer realtime voice test page)
    api/voice-lab/*         voice lab signaling (SDP offer → voice gateway) and session status
  proxy.ts                  admin session refresh; per-widget frame-ancestors policy
  components/               React UI (admin + widget)
  shared/widget-protocol.ts Zod wire protocol shared by the widget and the API
  widget/                   browser-only widget runtime (Zustand UI state machine + controller)
  server/
    config/                 Zod-validated env loaders + dated price list (the only place model names live)
    db/                     Sql/Database seam, user vs service scopes, node-postgres adapter
    ai/                     provider-neutral contracts, ModelRouter, retry policy, metered embeddings, OpenAI adapters
    domain/                 organizations, agents, business profile/hours, knowledge, contacts/leads,
                            conversations/messages (+ turn lock), usage (cost service, spend limits), audit
    agent/                  agent core: tool registry + executor (+ durable operations), ContextAssembler,
                            chat-turn runtime, summaries
    channels/webchat/       widget sessions (signed tokens), rate limits, SSE streaming, frame policy — no business logic
    channels/voice/         voice session manager (GPT-Live sessions, sideband events → executor/runtime/metering),
                            gateway HTTP API + client — no business logic
    voice-gateway.ts        composition root of the persistent voice gateway process
    auth/                   Supabase Auth helpers + organization access
supabase/migrations/        SQL migrations (Supabase CLI layout)
tests/                      unit, integration (PGlite), acceptance suites
scripts/                    migrate, seed, reembed-knowledge, eval-live, validate-live, voice-gateway
public/embed.js             widget loader for customer websites
.github/workflows/ci.yml    install, typecheck, lint, tests, build
```

Key decisions:

- **PostgreSQL is the source of truth.** Domain code runs parameterized SQL through a minimal `Sql` seam. Every query on
  tenant data filters by `organization_id`; composite foreign keys `(x_id, organization_id)` make cross-tenant links
  impossible at the database level.
- **Two database scopes.** Admin requests run as Postgres role `authenticated` with the user's JWT claims, so Supabase
  RLS applies. The public widget runtime runs in the privileged service scope after resolving the tenant from the
  widget key server-side.
- **Models never touch the database.** The model only requests tools; the executor validates, authorizes, records,
  runs and audits them. Tool runs are fenced by the conversation's turn-lock owner token; external side effects (later
  phases) run under durable operation records that never repeat an unknown outcome.
- **Provider-neutral AI layer.** OpenAI SDK types never leave `src/server/ai/openai/`. `ModelRouter`: cheap default
  model; the stronger model only for demonstrated complexity or quality failures; outages are retried on the same
  model with bounded, jittered backoff — never escalated.
- **Bounded context and cost.** Bounded context assembly, per-turn token/tool-call caps, conversation length limit,
  and per-organization daily/monthly estimated spend limits enforced with concurrency-safe reservations before every
  provider call.

## Getting started

Prerequisites: Node.js 22.12+ (24 LTS recommended) and a Supabase project (or the Supabase CLI locally).

1. Install: `npm install`
2. Configure: copy `.env.example` to `.env.local` and fill in the Supabase URL + publishable key, `DATABASE_URL`,
   `DATABASE_SSL_CA` (the Supabase CA: Database settings → SSL configuration), `OPENAI_API_KEY` and a random
   `WIDGET_SESSION_SECRET` (≥ 32 characters). In production (`NODE_ENV=production`) the app refuses to start against a
   remote database without verified TLS.
3. Database: `npm run db:migrate` (applies `supabase/migrations/*` and records them in
   `supabase_migrations.schema_migrations`; refuses unverified TLS to a remote host unless `-- --allow-unverified-tls`).
4. Auth: in Supabase → Authentication → URL configuration, add `<your-app-origin>/auth/confirm` to the redirect URLs.
5. Run: `npm run dev`, create an account and organization, configure the agent, add knowledge and publish web chat.
   The agent page shows the embed snippet, a preview link and the allowed-websites setting.
6. Optional demo data: `npm run db:seed -- --owner-email you@example.com` (an existing account).
7. Validate against your real services before relying on anything: [LIVE_VALIDATION.md](LIVE_VALIDATION.md).

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js |
| `npm run typecheck` | `next typegen && tsc --noEmit` |
| `npm run lint` | ESLint (Next + typescript-eslint strict type-checked) |
| `npm test` | Vitest: unit + integration + acceptance (PGlite, fake providers, no network, no Docker) |
| `npm run db:migrate` | Apply SQL migrations to `DATABASE_URL` |
| `npm run db:seed` | Create the demo tenant |
| `npm run knowledge:reembed` | Re-embed knowledge after changing `AI_EMBEDDING_MODEL` (`-- --dry-run` to preview) |
| `npm run eval:live` | Acceptance conversations + failure behaviour against the real configured AI providers (throwaway DB) |
| `npm run validate:live` | Infrastructure checks against a real Supabase project (TLS, migrations, pooler, Auth, RLS, pgvector, concurrency, usage) |
| `npm run voice:gateway` | The voice gateway (persistent process holding GPT-Live sidebands; needs `VOICE_GATEWAY_SECRET`) |

## Realtime voice (developer lab)

Phase 2 adds a browser voice test page, not a tenant-facing feature: GPT-Live (`gpt-live-1.1`) over WebRTC, with the
voice gateway answering every tool call through the same executor as chat. To try it:

1. Set `VOICE_GATEWAY_SECRET` (≥ 32 random characters) and `VOICE_DEV_ENABLED=true` in `.env.local` (with
   `OPENAI_API_KEY` and the database settings); apply migrations (`npm run db:migrate`).
2. Run `npm run voice:gateway` and `npm run dev` side by side.
3. As an owner/admin, open `/o/<org-slug>/voice-lab`, start a session and speak. The page shows connection status,
   audio levels, the live transcript, tool runs, session time and estimated cost. Sessions are capped
   (`VOICE_MAX_SESSION_SECONDS`, 120 s of silence, concurrent and per-minute start limits, spend reservations).

Calls are billed by OpenAI per second ($0.05/min active, $0.02/min standby at list price). Delegation mode, model,
voice and limits are configuration (`AI_VOICE_*`, `VOICE_*`; see AI_RUNTIME.md). Keep `VOICE_DEV_ENABLED` off in
any deployed environment.

## Changing models

Text and escalation models switch with configuration alone (`AI_TEXT_*`, `AI_ESCALATION_*`); usage is metered per
model. Add prices for any new model to `AI_MODEL_PRICING_JSON` (or the dated list in `src/server/config/pricing.ts`):
an unpriced model is metered at $0 and only a spend limit of 0 blocks it. The embedding model is different: retrieval
only compares a question with chunks embedded by the same model, so after changing `AI_EMBEDDING_MODEL` run
`npm run knowledge:reembed`. The vector column is `vector(1536)`: another dimension needs a migration.

## Cost controls

Per-organization estimated AI spend limits (`AI_ORG_DAILY_SPEND_LIMIT_USD`, `AI_ORG_MONTHLY_SPEND_LIMIT_USD`; operator
overrides in `app_private.organization_limits`), per-turn caps (`AI_MAX_TOOL_ROUNDS`, `AI_MAX_TOOL_CALLS_PER_TURN`,
`AI_MAX_TURN_TOKENS`), a conversation length limit (`AI_MAX_CONVERSATION_TURNS`) and a per-conversation cap on
premium-model calls. Details and defaults: [AI_RUNTIME.md](AI_RUNTIME.md#runtime-cost-controls). Costs are estimates
from a dated price list, not provider billing.

## Testing

Integration and acceptance tests run against **PGlite** — real Postgres compiled to WebAssembly with pgvector — so the
migrations, RLS policies, constraints, triggers and vector search are exercised in-process. A small shim provides the
Supabase platform objects (`anon`/`authenticated` roles, `auth.users`, `auth.uid()`). Model calls use deterministic
fakes; provider failures (429, timeouts, 5xx) are injected to test the retry policy. None of this is evidence about the
live providers or Supabase: run `npm run validate:live` and `npm run eval:live` for that. CI runs the full gate on
every push and pull request.

## Security and deployment notes

- **Database TLS.** Production requires verified TLS (`DATABASE_SSL_CA`); enable "Enforce SSL" in Supabase.
- **Auth emails.** `/auth/confirm` accepts only PKCE `?code=` links; keep Supabase's default "Confirm signup" template
  and add `<origin>/auth/confirm` to the allowed redirect URLs (a token-hash template would allow login CSRF).
- **Supabase Data API.** The app talks to Postgres directly and never uses PostgREST. RLS and explicit grants protect
  the tables anyway; you can remove `public` from the Data API's exposed schemas.
- **Widget keys** are generated and rotated only by the server. Public chat endpoints are rate-limited per client
  (IPv6 per /64), per widget and per organization, and bounded by the organization's spend limits.
- **Allowed websites** (agent page → Web chat): browsers show the widget only on the listed sites (CSP
  `frame-ancestors`). This limits embedding; it does not authenticate visitors.
- **Client IPs.** Per-IP limits use the first `X-Forwarded-For` entry, which is correct on Vercel (the platform sets
  the header). Behind other proxies, make sure the proxy overwrites it.
- **Secrets.** Provider keys are server-only. `SUPABASE_SECRET_KEY` is for `validate:live` only — never deploy it.
- **Model calls** run only on the server. Visitor-supplied contact details are stored on the lead as given and never
  overwrite an existing contact.

## Known limitations (after Phase 2 code)

- Not yet validated against live Supabase (Postgres 17, Supavisor), OpenAI or GPT-Live; tests use PGlite (Postgres 18)
  and fake providers. Run [LIVE_VALIDATION.md](LIVE_VALIDATION.md) first. Voice quality, latency and cost have not been
  measured (VOICE_QUALITY.md).
- Voice exists only as the developer lab; phone, SMS, callbacks, transfer, booking, the production voice widget and
  billing are later phases.
- Knowledge: manual text and TXT/Markdown uploads; synchronous ingestion; exact vector scan.
- Fallback sentences are English.
- Spend limits use estimated costs; provider-confirmed cost reconciliation (OpenAI Costs API) is Phase 7.
- No per-visitor quotas or bot challenge yet: a determined script can exhaust a tenant's per-minute widget budget
  (bounded by rate and spend limits).

## Embedding the widget

```html
<script src="https://<your-app-origin>/embed.js" data-widget-key="wk_…" async></script>
```

The loader adds a launcher button and lazily opens an iframe served by this app, so API calls are same-origin and no
provider secret ever reaches the browser. The browser keeps only an opaque signed session token; the conversation lives
in Postgres and is restored on refresh/reopen.
