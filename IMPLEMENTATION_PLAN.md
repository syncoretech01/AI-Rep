# Syncore AI Receptionist — Implementation Plan

Revised 2026-11-26. Product scope: [PRODUCT_SPEC.md](PRODUCT_SPEC.md). Design: [ARCHITECTURE.md](ARCHITECTURE.md),
[AI_RUNTIME.md](AI_RUNTIME.md). Voice targets and measurement method: [VOICE_QUALITY.md](VOICE_QUALITY.md). Live
validation procedure and results: [LIVE_VALIDATION.md](LIVE_VALIDATION.md). Permanent rules: [CLAUDE.md](CLAUDE.md).

## Status

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Multi-tenant foundation | Implemented |
| 1 | Web chatbot, knowledge and tools | Implemented |
| 1.5 | Hardening and live validation | Implemented in code; live validation pending credentials |
| 2 | Shared realtime voice engine and minimal browser voice proof of concept | Implemented in code; **not complete** — live voice validation, S2.2 measurements and S3.1 pending |
| 3 | Inbound telephone receptionist, callback capture and human transfer | Not started |
| 4 | Appointment booking, SMS and customer-conversion workflows | Not started |
| 5 | Production-quality website live voice widget | Not started |
| 6 | Consent-based outbound calling agent | Not started |
| 7 | Commercial readiness, billing, monitoring and scaling | Not started |
| 8 | Industry-specific templates and measured provider-cost optimization | Not started |

"Implemented" means the code and its automated tests are in the repository. It does not mean validated against live
providers unless this document says so. Automated tests run against PGlite (Postgres compiled to WebAssembly, with
pgvector) and deterministic model fakes; they are not evidence about Supabase or OpenAI behaviour.

## Rules for every phase

1. **Checks.** A phase is complete only when `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` pass
   (`npm run check` runs all four; CI runs them on every push and pull request) and every acceptance criterion has
   recorded evidence.
2. **Order.** Do not start a later phase unless explicitly requested. Within a phase, spikes run first; build work
   starts after the spike decision is recorded.
3. **No speculative abstractions.** Add a boundary only where [CLAUDE.md](CLAUDE.md) requires one (AI provider,
   telephony/SMS carrier, external integration) or a current use case needs it. One implementation per boundary until a
   second one is needed.
4. **Secrets are never committed.** Provider keys live in server-side environment variables only; `.env.example`
   documents names, never values. Keys used only by validation scripts (for example `SUPABASE_SECRET_KEY`) never reach
   the deployed application.
5. **Claims require evidence.** "Works", "meets target" or "validated" is written only with a passing automated test, a
   recorded [LIVE_VALIDATION.md](LIVE_VALIDATION.md) run, or a [VOICE_QUALITY.md](VOICE_QUALITY.md) measurement report.
   Targets stay labelled as targets until measured. Provider facts cite official documentation with an access date.
6. **Zero-tolerance criteria** (next section) are acceptance criteria of every phase.
7. **Configuration, not code.** Model names, prices and limits live in configuration; channels contain no business
   logic; voice and phone reuse the existing agent core and tool executor.

## Zero-tolerance criteria (every phase)

| Id | Criterion | Definition |
| --- | --- | --- |
| Z1 | No fabricated successful actions | No assistant message or spoken transcript states or implies that an action succeeded (lead saved, callback recorded, call transferred, appointment booked, SMS sent, call scheduled) without a succeeded tool run for that action in the same conversation. Stating success or failure for an `unknown` or `in_progress` operation also counts. |
| Z2 | No duplicate external actions | No more than one provider-side effect — and no more than one internal record where exactly one is specified (one lead per conversation, one callback per request) — per operation key or customer request, including under retries, duplicate webhooks, reconnects, concurrent workers and barge-in. |
| Z3 | No cross-tenant exposure | No data, configuration, knowledge, contact, conversation, transcript or usage of one organization is returned to, spoken to, sent to or stored under another organization, and no action executes under the wrong organization. |

Measurement: each phase's automated scenario suite asserts Z1–Z3; every live run reviews all transcripts against
`tool_runs` and operation records. For voice phases, the occurrence rules, provider-side counting of external effects,
failure injection and minimum sample sizes are those of [VOICE_QUALITY.md](VOICE_QUALITY.md) §6.6–6.8, §8.4 and §10.
Duplicate internal records across separate calls (for example a caller who redials) are a diagnostic there, not a Z2
occurrence. One occurrence fails acceptance regardless of other results. Mock and fake tests verify logic only; they
are never evidence of voice quality ([VOICE_QUALITY.md](VOICE_QUALITY.md) §9).

---

## Phase 0 — Multi-tenant foundation (implemented)

Shipped:

- Next.js 16 App Router, React 19, strict TypeScript, Tailwind, Zod; ESLint with typescript-eslint strict type-checked
  rules; Vitest with a PGlite harness that applies the real migrations and RLS policies.
- Zod-validated environment configuration; model names exist only in `src/server/config`.
- Supabase Auth (sign-up, login, PKCE email confirmation), organizations, membership roles (owner, admin, member),
  onboarding.
- Two database scopes: user scope (Postgres role `authenticated` with the user's JWT claims, so RLS applies) and service
  scope (public widget runtime, after the tenant is resolved server-side from the widget key).
- Migrations for organizations, organization_members, agents, business_profiles, business_hours, usage_records,
  audit_logs; composite `(id, organization_id)` foreign keys between tenant tables.
- Provider-neutral `TextModelProvider` / `EmbeddingProvider` contracts, tool registry interfaces, usage and audit
  foundations, demo seed script.

Acceptance (met; automated): the app builds; strict TypeScript passes; an authenticated user belongs to an
organization; tenant isolation tests exist (`tests/integration/tenant-isolation.test.ts`,
`tests/integration/organizations.test.ts`, `tests/integration/db-foundation.test.ts`); no AI call is required.

## Phase 1 — Web chatbot, knowledge and tools (implemented)

Shipped:

- Admin configuration of agents, business profile and hours; overview with setup checklist; conversations (transcript
  and tool audit trail); leads.
- Knowledge ingestion (manual text, TXT/Markdown) → normalize → chunk → embed (`text-embedding-3-small`) → pgvector;
  retrieval scoped by organization and agent with relevance threshold, top-K and token caps; `knowledge:reembed`
  script for embedding-model changes.
- Tools `searchKnowledge`, `getBusinessInfo`, `getBusinessHours`, `captureLead`; executor with channel and capability
  checks, Zod validation and a `tool_runs` audit row for every request, including rejected ones.
- Contacts and leads: one lead per conversation; visitor-supplied details never overwrite an existing contact.
- Channel-neutral conversations and messages, rolling summary, `ContextAssembler` with context budgets.
- OpenAI Responses and embedding adapters behind the provider contracts; `ModelRouter`; streaming.
- Embeddable widget (`public/embed.js` + iframe), signed session tokens, SSE streaming, rate limits per client IP (IPv6
  per /64), per widget and per organization; conversation restored on reload; "New chat".
- Usage metering into `usage_records` (tokens, embeddings, tool calls, estimated cost).

Acceptance scenarios (met with deterministic model fakes; the real-model check is `npm run eval:live`, Phase 1.5):

| # | Scenario | Evidence |
| --- | --- | --- |
| 1 | Question answered by the knowledge base gets a grounded answer | `tests/acceptance/web-chat-slice.test.ts`, `tests/integration/chat-turn.test.ts` |
| 2 | Unknown question: the agent does not invent | same |
| 3 | Name and phone captured as a lead via `captureLead` | same |
| 4 | Refresh/reopen preserves the conversation as designed | `tests/acceptance/web-chat-persistence.test.ts` |
| 5 | One tenant cannot retrieve another tenant's knowledge | `tests/acceptance/web-chat-isolation.test.ts` |
| 6 | Provider and model change through configuration | `tests/acceptance/web-chat-configuration.test.ts` |

## Phase 1.5 — Hardening and live validation (implemented in code; live validation pending credentials)

All eight work items exist in code with automated tests. `npm run validate:live` and `npm run eval:live` have **not**
been run because no credentials were available in the development environment. Phase 1.5 closes only when the exit
criteria at the end of this section are met.

### 1.5.1 Model routing and provider-failure handling

Shipped: cheap default model for routine work; escalation to the stronger model only for demonstrated complexity
(caller flag) or a quality failure of the default model (two invalid/unknown tool calls in a turn, or an empty answer),
capped by `AI_MAX_ESCALATED_CALLS_PER_CONVERSATION` (default 6). Retryable failures (429 rate limit, timeouts, 408, 409,
5xx) get bounded same-model retries (`AI_PROVIDER_MAX_RETRIES`, default 2) with equal-jitter exponential backoff (400 ms
base, 4 s cap), honouring `Retry-After` (give up if it exceeds 10 s) and the 50 s turn deadline (no retry unless at least
3 s remain after the wait). Authentication, configuration, quota and content-policy errors fail immediately (error-level
log for the first three). Outages never switch to the premium model. A response whose text the visitor already saw is
never retried. OpenAI SDK internal retries are disabled. Code: `src/server/ai/retry.ts`, `src/server/ai/router.ts`,
`src/server/agent/runtime/chat-turn.ts`.

| Acceptance criterion | Verification |
| --- | --- |
| Routine turns use the default profile; escalation happens only for the three listed reasons and stops at the per-conversation cap | Automated: `tests/unit/model-router.test.ts`, `tests/integration/chat-turn.test.ts`, `tests/integration/usage-limits.test.ts` |
| Retry policy as specified (classes, count, backoff, `Retry-After`, deadline) | Automated: `tests/unit/retry-policy.test.ts`, `tests/integration/chat-turn.test.ts` |
| Non-retryable errors fail at once; outages never escalate; seen text never retried | Automated: `tests/integration/chat-turn.test.ts`, `tests/acceptance/web-chat-configuration.test.ts` |
| A model id the provider rejects fails at once (1 attempt, no retry, no escalation) against the real API | Live: `npm run eval:live` — pending |

### 1.5.2 Conversation turn concurrency

Shipped: the conversation turn lock has a unique owner token per acquisition (`conversations.turn_lock_token`); acquire
is a single atomic `UPDATE`; release only by token, so a stale owner cannot release; every message write and every
tool-run start is fenced by the token in a single statement, so a worker whose lock lapsed and was taken over cannot
write. Lock state lives in Postgres and is correct across instances.

| Acceptance criterion | Verification |
| --- | --- |
| One owner per conversation turn; only the owner releases; a stale worker writes nothing and starts no tool run | Automated: `tests/integration/conversations.test.ts`, `tests/integration/chat-turn.test.ts`, `tests/integration/tool-operations.test.ts`, `tests/acceptance/web-chat-persistence.test.ts` |
| Exactly one lock owner under concurrency on the real Supabase pool | Live: `npm run validate:live` — pending |

### 1.5.3 Tool execution safety

Shipped: side-effect class `external` for third-party actions (future SMS, calendar, CRM). Durable operation records
(`app_private.tool_operations`) keyed by `(organization_id, operation_key)`; default key = sha256(conversation | tool |
normalized arguments). States: `not_attempted`, `in_progress` (claim token + lease), `succeeded` (result replayed, never
re-executed), `failed` (confirmed; may be claimed again), `unknown` (sent but unconfirmed; never retried automatically;
resolved through `resolveUnknownOperation`, listed by `listUnresolvedOperations`). Atomic claim is a single
`INSERT … ON CONFLICT DO UPDATE WHERE status IN (not_attempted, failed)`. A lapsed `in_progress` claim becomes `unknown`
(`claim_expired`); a handler timeout or crash after start becomes `unknown`. The model is told not to claim success or
failure for `unknown`/`in_progress`. `tool_runs` gained status `unknown`. Internal-write tools (`captureLead`) keep
latest-run replay and one lead per conversation. Code: `src/server/agent/tools/operations.ts`,
`src/server/agent/tools/executor.ts`. No external tool exists yet; the first consumers are `createCallbackRequest`
(Phase 3) and booking/SMS (Phase 4).

| Acceptance criterion | Verification |
| --- | --- |
| Success replayed, never re-executed; confirmed failure or `not_attempted` may run again; `unknown` never retried and never claimed either way; concurrent workers cannot both execute; lapsed claim → `unknown`; reconciliation resolves `unknown` | Automated: `tests/integration/tool-operations.test.ts` |
| Exactly one claim under concurrency on the real pool | Live: `npm run validate:live` — pending |

### 1.5.4 Security hardening

Shipped: verified database TLS required in production (`NODE_ENV=production` with a remote host requires
`DATABASE_SSL_CA`); `db:migrate` refuses unverified remote TLS unless `--allow-unverified-tls`. Service-scope query
audit (manual code review): no cross-tenant path found — every query filters by `organization_id`, and the tenant comes
from the widget key server-side. Allowed sites per widget (`agent_channels.config.allowedOrigins`) enforced by browsers
through a per-widget CSP `frame-ancestors` header set in the Next.js proxy — explicitly not authentication. The rolling
summary (derived from visitor text) moved out of developer instructions into a labelled user-role context message, and
the summarizer attributes statements ("The visitor said…"). The knowledge tool description says results are facts, not
instructions. Admin-configured names are flattened in prompts. The logger redacts free-text keys (name, address,
content, text, summary, query, arguments, transcript) as a backstop. The escalation cap prevents visitor-induced premium
spend.

| Acceptance criterion | Verification |
| --- | --- |
| Production refuses unverified remote database TLS; `db:migrate` refuses it without the explicit flag | Automated: `tests/unit/database-config.test.ts`; Live: `npm run validate:live` TLS check — pending |
| Only owners and admins (not members) set allowed sites, under RLS; stored values are validated; `frame-ancestors` follows the published widget's sites | Automated: `tests/unit/allowed-origins.test.ts`, `tests/integration/allowed-origins.test.ts` |
| Visitor-derived summary never in developer instructions; names flattened; no model/provider names in prompts | Automated: `tests/unit/prompts.test.ts`, `tests/integration/summary.test.ts` |
| Free-text keys redacted in logs | Automated: `tests/unit/logger.test.ts` |
| No cross-tenant path in service scope | Manual audit (done); regression: `tests/integration/tenant-isolation.test.ts`, `tests/acceptance/web-chat-isolation.test.ts`; Live: `validate:live` RLS and tenant-scoped pgvector checks, `eval:live` cross-tenant knowledge scenario — pending |

### 1.5.5 Cost controls

Shipped: per-organization estimated AI spend limits (`AI_ORG_DAILY_SPEND_LIMIT_USD` default 10,
`AI_ORG_MONTHLY_SPEND_LIMIT_USD` default 150; operator-set overrides in `app_private.organization_limits`; 0 blocks).
Before every provider call (chat rounds, summaries, embeddings) a conservative estimated cost (over-estimated input at the dearer of the uncached and cache-write rates
plus the full output cap) is reserved inside a transaction holding a per-organization `pg_advisory_xact_lock` (works
through the Supavisor transaction pooler). Spend source: `app_private.usage_daily_totals`, maintained by a trigger on
`usage_records`. Reservations expire after 180 s if a worker crashes. Per-turn caps: `AI_MAX_TOOL_CALLS_PER_TURN` (6;
extra calls refused and audited as rejected runs), `AI_MAX_TURN_TOKENS` (40,000 provider-reported tokens; no further
round), `AI_MAX_TOOL_ROUNDS` (4). Conversation length: `AI_MAX_CONVERSATION_TURNS` (100 visitor messages; overridable
per organization). The reservation table has a `resource` column for later `voice_seconds`, `concurrent_calls` and
`sms_segments`. Pricing: dated snapshot in `src/server/config/pricing.ts` (Standard tier, 2026-11-26), overridable via
`AI_MODEL_PRICING_JSON`; `AI_PRICING_VERSION` stored on every usage record. Estimates are never presented as provider
billing; importing provider-confirmed costs is Phase 7.

| Acceptance criterion | Verification |
| --- | --- |
| Reservations: daily and monthly limits enforced independently; overrides applied; 0 blocks; expired reservations stop counting; concurrent reservations never overshoot; organizations separate | Automated: `tests/integration/usage-limits.test.ts` |
| Turn refused at the spend limit without a model call; conversation-length limit; turn token budget; per-turn tool-call cap audited; cost and pricing version recorded | Automated: `tests/integration/chat-turn.test.ts`, `tests/unit/usage-cost.test.ts`, `tests/unit/ai-config.test.ts` |
| Reservations never overshoot on the real pool through the transaction pooler; usage accounting correct | Live: `npm run validate:live` — pending |

### 1.5.6 Observability

Shipped: structured JSON log events with normalized names and fields — `ai.route.selected`, `ai.route.escalated`,
`ai.call.retry`, `ai.call.completed` (provider, model, tier, route, round, attempts, durationMs, firstTokenMs, tokens
including cached/reasoning, estimatedCostUsd, pricingKnown), `ai.call.failed` (code, status, retryable, attempts; error
level for auth/config/quota), `agent.turn.finished` (latencyMs, firstTokenMs, modelCalls, retries, toolCalls, tokens,
estimatedCostUsd, escalation, outcome), `usage.limit.enforced` (resource, scope, limit), `agent.tool.*`; plus
`usage_records.metadata` {tier, round, route, attempts, firstTokenMs} and `tool_runs.duration_ms`. Conventions are
designed to extend to voice sessions and calls (session id, interaction id, channel).

| Acceptance criterion | Verification |
| --- | --- |
| Events and fields emitted as listed; metadata and durations persisted | Automated: `tests/integration/chat-turn.test.ts`, `tests/integration/usage.test.ts`, `tests/integration/tool-executor.test.ts`, `tests/unit/logger.test.ts` |

Log shipping, dashboards and alerting are Phase 7.

### 1.5.7 Live validation tooling

Shipped:

- `npm run validate:live` (`scripts/validate-live.ts`): against real Supabase — TLS, Postgres and pgvector versions,
  migrations recorded, transaction-local settings not leaking through the pooler, real Supabase Auth sign-in and
  `getClaims`, RLS isolation, tenant-scoped pgvector retrieval, concurrency on the real pool (one turn-lock owner,
  reservations never overshoot, one operation claim), usage accounting. Creates and deletes throwaway organizations and
  users. Needs `DATABASE_URL` (+ `DATABASE_SSL_CA`), `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
  and `SUPABASE_SECRET_KEY` (script only).
- `npm run eval:live` (`scripts/eval-live.ts`): real OpenAI models and embeddings on a throwaway PGlite database —
  grounded answer, no invention, lead capture via tool, reopen, cross-tenant knowledge isolation, metering on the
  configured models, and a rejected model id failing at once.

| Acceptance criterion | Verification |
| --- | --- |
| The `validate:live` database checks pass and clean up after themselves | Automated against PGlite: `tests/integration/live-validation.test.ts` (proves the script, not Supabase) |
| Both commands and the manual end-to-end check pass against the real services, with results recorded | Live: [LIVE_VALIDATION.md](LIVE_VALIDATION.md) — **not run; credentials pending** |

### 1.5.8 Continuous integration

Shipped: `.github/workflows/ci.yml` — `npm ci`, typecheck, lint, tests and production build on every push and pull
request; Node 24; no secrets.

| Acceptance criterion | Verification |
| --- | --- |
| Workflow runs green on GitHub | Pending: first run on GitHub (Actions tab) after the Phase 1.5 push; the same gate passes locally |

### Phase 1.5 exit criteria

1. `npm run validate:live` passes every check against the target Supabase project, using verified TLS
   (`DATABASE_SSL_CA`) and the connection mode used in production; the run is recorded in
   [LIVE_VALIDATION.md](LIVE_VALIDATION.md) with date and project.
2. `npm run eval:live` passes every scenario against the configured OpenAI models (`gpt-6-luna`, `gpt-6.2-sol`,
   `text-embedding-3-small`); the run is recorded with date, model ids and estimated cost.
3. The manual end-to-end check in [LIVE_VALIDATION.md](LIVE_VALIDATION.md) passes, and every item of its verification
   matrix is PASS or has a written exception with reason and follow-up.
4. CI is green on GitHub.
5. typecheck, lint, tests and build pass.

Phase 2 may start on request once Phase 1.5 code is merged; Phase 2 cannot be accepted before Phase 1.5 exit criteria
are met.

---

## Phase 2 — Shared realtime voice engine and minimal browser voice proof of concept

**Goal.** One realtime voice engine — voice gateway, GPT-Live session management, sideband tool path, transcript
persistence, metering and limits — that Phase 3 (phone) and Phase 5 (website widget) reuse, proven end-to-end by a
minimal, developer-only browser page. Not a tenant-facing feature.

### Implementation status (2026-11-26)

Code, automated tests and documentation are in the repository; **no live GPT-Live session has been run** (no
credentials in the build environment), so Phase 2 is not complete. Status per item:

| Item | Status |
| --- | --- |
| S2.1 sideband proof | Implemented (adapter, gateway, voice lab); live evidence **blocked** (LIVE_VALIDATION.md §9, V1–V2) |
| S2.2 delegation decision | Both modes implemented behind `AI_VOICE_DELEGATION`; Responses delegation selected **provisionally** on documentation and complexity; measurements **blocked** (VOICE_QUALITY.md §13.4) |
| S3.1 carrier path | Documentation re-verified: GPT-Live supports SIP inbound/outbound with carrier trunks such as Twilio; live proof is Phase 3 work |
| Build 1 voice gateway | Done: `npm run voice:gateway`, `/health`, graceful shutdown, stale-session recovery |
| Build 2 server-side session creation | Done for the developer lab (signed-in owner/admin instead of a visitor voice token; the token arrives with the Phase 5 widget) |
| Build 3 sideband attach, dedupe, close reasons | Done; a sideband lost beyond the replay window settles the session (no re-attach) |
| Build 4 tools through the executor | Done (`web_voice` channel, all four tools; captureLead requires read-back confirmation on voice) |
| Build 5 transcript persistence | Done (provider offsets, `interrupted` flag) |
| Build 6 metering | Done: active/standby seconds, backend tokens, per-second voice prices; the reservation is in USD (`ai_spend_usd`) for the whole maximum length rather than a separate `voice_seconds` resource. Input transcription is not separately reported by GPT-Live events and is not metered |
| Build 7 limits | Done: org + env concurrent sessions, maximum length, silence, idle → standby, per-minute start rate. A platform-wide session cap is not implemented |
| Build 8 dev-only page | Done: `/o/<org>/voice-lab`, `VOICE_DEV_ENABLED` (404 otherwise) |
| Build 9 latency instrumentation | Partly: `voice.turn.completed` with provider timing and response gaps, `voice.tool.completed`; no browser playout beacon, no interruption-to-audio-stop (no provider event) |
| Acceptance 1, 5, 10 (live), 11, 12 | **Blocked** (no live runs) |
| Acceptance 2 one engine | Met: same registry/executor; architecture test covers the gateway composition root |
| Acceptance 3 no provider secret in browser | Met for the lab: response carries only SDP + our ids; lab routes need a signed-in admin (visitor token is Phase 5) |
| Acceptance 4 pinned configuration | Automated part met; live disallowed-event check (V10) blocked |
| Acceptance 6, 7, 8, 9, 13 | Automated parts met (fake provider); live parts blocked |

### Spikes (before build)

- **S2.1 Sideband delegation proof.** Server creates a GPT-Live session (`gpt-live-1.1`) with
  `POST /v1/live/sessions` over WebRTC with restricted data-channel events; a browser connects; the gateway attaches to
  `wss://api.openai.com/v1/live/sessions/{id}/attach`; a function tool call arrives on the sideband and its output is
  returned; transcripts and `session.closed` (with usage seconds) are received. Evidence: session ids and logs from a
  live run.
- **S2.2 Delegation decision.** Compare Responses delegation (OpenAI-hosted backend model; our function tools executed
  by our sideband) with client delegation (our agent core answers via commentary/thinking appends, 500 tokens each;
  `acknowledgement_delay_ms` 0–800) on the same scripted scenario set, using the [VOICE_QUALITY.md](VOICE_QUALITY.md)
  methodology and sample size. Measure response latency, tool round-trip latency, task completion, Z1–Z3, cost per
  session minute (live seconds + backend tokens), and whether the existing agent core (ContextAssembler, routing
  policy, tool executor, spend reservations) governs the turn unchanged. Constraint: exactly one business-logic engine
  — the existing agent core and tool executor; voice must not get its own. Record the decision and measurements in
  [ARCHITECTURE.md](ARCHITECTURE.md).
- **S3.1 Carrier path** (defined under Phase 3) also runs in this phase; its result is a Phase 2 exit condition.

### Build

1. **Voice gateway.** Persistent Node.js process in this repository (separate entry point) reusing `src/server`
   domain, agent and tool modules and Postgres; health endpoint; drains sessions on shutdown; deployed on a long-running
   host (not serverless functions).
2. **Server-side session creation.** The browser posts its SDP offer and our short-lived signed voice-session token
   (same model as the widget token) to our endpoint. The server resolves tenant, agent and widget from server-side
   records, reserves voice spend and a concurrency slot, then calls `POST /v1/live/sessions` with the permanent key,
   pinning model (`AI_VOICE_MODEL`), instructions (built by the ContextAssembler, within the 16,384-token limit), voice,
   delegation mode and explicit `session.client.data_channel.allowed_client_events` / `allowed_server_events`. It
   returns only the SDP answer. No provider key or client secret reaches the browser; audio flows browser ↔ OpenAI
   directly and is never proxied through Next.js.
3. **Sideband attach** immediately after creation (the sideband replays only the last 3 s); dedupe by `event_id`;
   handle `session.closed` and every close reason; when the sideband is lost beyond the replay window, close the session
   and mark the conversation with a system marker.
4. **Tool execution through the existing executor** (same registry, Zod validation, operation records, audit, turn-lock
   fencing) with a voice channel identifier; tools declare voice availability.
5. **Transcript persistence.** Final user and assistant transcript turns stored in `conversations`/`messages` (voice
   channel) with start/end offsets; interrupted assistant turns marked as interrupted.
6. **Metering.** Active and standby seconds from `session.usage.updated` / `session.closed`, backend model tokens, input
   transcription, and the 15 s billed up front at WebRTC session creation; per-second pricing entries for
   `gpt-live-1.1` in the pricing snapshot; reservation `resource` extended with `voice_seconds` (and concurrent
   sessions).
7. **Limits.** Per-organization and platform-wide concurrent voice sessions; maximum session duration; idle timeout
   (`idle_timeout_s`, 5–60); rate limits on session creation (each creation is billed).
8. **Dev-only browser POC page.** Microphone → WebRTC → session, behind authentication and a development flag; not
   available in production configuration.
9. **Latency instrumentation.** Per-turn timestamps required by [VOICE_QUALITY.md](VOICE_QUALITY.md) (for example end
   of user speech, first assistant audio, tool start/end), emitted as structured `voice.session.*`, `voice.turn.*` and
   `voice.tool.*` events with session id, interaction id and channel, following the Phase 1.5 conventions.

### Out of scope

Tenant-facing voice widget and UI polish (Phase 5); phone call handling (Phase 3 — only its feasibility spike S3.1 runs
during Phase 2); new production tools (a test-only stub tool with `sideEffects: 'external'` is registered in test
tenants for duplicate-action tests, [VOICE_QUALITY.md](VOICE_QUALITY.md) §6.7); booking and SMS; audio recording storage; Realtime API adapter (only if a Phase 3 fallback
requires it); economy STT → LLM → TTS pipeline; browser `SpeechRecognition`/`SpeechSynthesis`; multi-region deployment.

### Dependencies and risks

- Phase 1.5 live validation (the gateway relies on verified pooler behaviour, locks and reservations).
- OpenAI project access to GPT-Live and a project key for the sideband; a Twilio account with an Elastic SIP trunk and a
  test number for S3.1.
- Session configuration is immutable after start (model, instructions, audio); `session.update` changes only delegation
  settings. Per-turn facts must arrive through tools or appends.
- 3 s sideband replay: gateway restarts or deploys lose events unless sessions are drained; design closes or flags
  rather than silently continuing.
- Interruption does not cancel backend work. Good for committed actions; the agent must not later speak a stale result
  as current.
- Not documented for GPT-Live: turn-detection/eagerness knobs, noise reduction, transcription model choice, maximum
  WebRTC session length — measure and record.
- 15 s billed per WebRTC session creation makes session creation an abuse cost vector.
- If `allowed_client_events`/`allowed_server_events` are omitted at creation, the browser may send any event; setting
  them is mandatory.

### Acceptance criteria

1. S2.1 evidence recorded; S2.2 decision record contains measurements for both delegation modes over the
   [VOICE_QUALITY.md](VOICE_QUALITY.md) scenario set and sample size, and the decision cites them; the S3.1 carrier
   feasibility result or fallback decision is recorded ([VOICE_QUALITY.md](VOICE_QUALITY.md) §10 lists it as a Phase 2
   exit condition).
2. One engine: voice tool calls run through the same executor and registry as chat; `tests/unit/architecture.test.ts`
   is extended to fail if gateway or channel code contains business rules or a second tool registry.
3. No provider secret in the browser: automated tests assert the session-creation response contains only the SDP answer
   and our identifiers, and that the POC bundle references no provider key; requests without a valid voice-session
   token get 401; a token issued for another agent or organization is rejected.
4. Pinned configuration: an automated test asserts the `POST /v1/live/sessions` payload sets the configured model,
   server-built instructions, voice, delegation mode and non-empty `allowed_client_events`/`allowed_server_events`; a
   live check confirms a disallowed client event sent from the browser has no effect.
5. Scripted live sessions pass — grounded answer, unknown question (no invention), lead capture, interruption during a
   tool run — and every tool the model invoked has a `tool_runs` row with the voice channel; the lead is captured
   exactly once.
6. Each final transcript event is persisted exactly once, including with duplicated and replayed events and a
   sideband reconnect (automated); the session appears in the admin conversation view with its transcript.
7. Metering: stored active/standby seconds equal the provider-reported values in `session.closed`; backend tokens are
   recorded; a `voice_seconds` reservation is taken before creation, settled after close and expires after a simulated
   crash (automated).
8. Limits: with a per-organization limit of N concurrent sessions, session N+1 is refused before any OpenAI call; an
   organization at its spend limit cannot create a session; sessions end at the configured maximum duration
   (automated).
9. Interruption safety: barge-in during a tool run neither cancels nor duplicates the run; an `unknown` outcome is
   reported as unconfirmed (automated with simulated events, plus live scenarios).
10. The browser-voice faults of [VOICE_QUALITY.md](VOICE_QUALITY.md) §8.4 (provider disconnect, sideband drop shorter
    and longer than 3 s, tool timeout, database outage, gateway restart, 429/quota at session creation, spend limit
    reached) each produce the required behaviour.
11. An evaluation record ([VOICE_QUALITY.md](VOICE_QUALITY.md) §9) covers every metric for browser voice, and
    instrumentation emits the required timestamps for 100% of turns. Per [VOICE_QUALITY.md](VOICE_QUALITY.md) §10,
    latency, interruption, task completion, contact-information accuracy and naturalness (≥ 20 conversations) are
    measured and reported in Phase 2 — a miss does not block Phase 2; they become gates in Phases 5 and 6.
12. Z1: zero in ≥ 100 action-bearing sessions (≥ 30 with injected failures). Z2: zero, counted on the stub tool's own
    counter, with ≥ 50 runs per duplicate-provoking injection. Z3: zero across ≥ 50 sessions and ≥ 2 tenants plus every
    hostile case ([VOICE_QUALITY.md](VOICE_QUALITY.md) §6.6–6.8).
13. The POC page is not reachable in production configuration (automated).

---

## Phase 3 — Inbound telephone receptionist, callback capture and human transfer

**Goal.** A tenant's phone number is answered by its agent on the Phase 2 engine, with callback capture, human
transfer and keypad input. This is the primary commercial product. Phase 3 releases it as a pilot to selected tenants;
general availability additionally requires the telephone latency, interruption and naturalness gates of
[VOICE_QUALITY.md](VOICE_QUALITY.md) §10 (checked in Phase 7).

### Spike (owned by Phase 3; run during Phase 2)

S3.1 defines the telephone carrier path. It runs during Phase 2 because [VOICE_QUALITY.md](VOICE_QUALITY.md) §10
requires its result, or the fallback decision, to close Phase 2. No Phase 3 build work starts before it is recorded.

**S3.1 Carrier path.** Prove PSTN → Twilio number → Twilio Elastic SIP Trunk (origination URI
`sip:proj_<id>@sip.api.openai.com;transport=tls`, Secure Trunking TLS + SRTP) → OpenAI SIP → `live.transport.incoming`
webhook → `POST /v1/live/sessions/{id}/accept` with the tenant's configuration → sideband attach → conversation on
`gpt-live-1.1`, with DTMF and a `/refer` transfer to a PSTN number.

Status (re-verified 2026-11-26): OpenAI's GPT-Live SIP guide documents inbound calls (`live.transport.incoming`,
accept/reject/refer/hang up) and outbound calls (`POST /v1/live/sessions` with a SIP transport) through carrier trunks
such as Twilio, so this path is **documented but not yet proven live**. The fallbacks below remain only in case the
live proof fails or misses the [VOICE_QUALITY.md](VOICE_QUALITY.md) phone targets:

| Fallback | Description | Cost/complexity |
| --- | --- | --- |
| A | Realtime API (`gpt-realtime-2.1`) through OpenAI's documented Twilio Elastic SIP guide (`realtime.call.incoming`, `/v1/realtime/calls/{id}/accept`, `wss /v1/realtime?call_id=`) | Token-billed audio (USD 32 in / 64 out per 1M audio tokens); needs a second voice adapter and token-based voice metering. Do not use `gpt-realtime`/`gpt-realtime-mini` (shut down 2027-01-20). |
| B | Twilio Media Streams bridged by the voice gateway to GPT-Live | The gateway carries audio: added latency, codec conversion (PCMU/PCMA), scaling load. |

Evidence: Twilio call SIDs, OpenAI session ids, logs and a [VOICE_QUALITY.md](VOICE_QUALITY.md) phone measurement;
decision recorded in [ARCHITECTURE.md](ARCHITECTURE.md).

### Build

1. **Phone numbers.** Per-tenant Twilio number provisioning (search, purchase, assign to agent, release) behind the
   carrier boundary; `phone_numbers` mapped to agents; Elastic SIP trunk with origination URI carrying a secret `X-`
   header; Secure Trunking. US local numbers first.
2. **Webhook verification.** OpenAI webhooks: Standard Webhooks signature (`webhook-id`, `webhook-timestamp`,
   `webhook-signature`) with timestamp tolerance, deduplicated by `webhook-id`, acknowledged with a fast 2xx and
   processed asynchronously. Twilio webhooks: `X-Twilio-Signature` (`validateRequestWithBody` for JSON bodies).
   `sip_headers` are untrusted.
3. **Tenant resolution.** Dialed number (Diversion header) → `phone_numbers` → agent and organization, server-side;
   the secret `X-` header is checked before accepting; unknown number or mismatch → reject.
4. **Call lifecycle.** Accept with the tenant's configuration; sideband attach; `calls` and `call_events` with the
   server call states of [ARCHITECTURE.md](ARCHITECTURE.md) §7; one conversation per call (phone channel); a terminal
   state for every close reason (`close_requested`, `expired`, `content`, `remote_hangup`, `connection_lost`).
5. **`createCallbackRequest`.** `callback_requests` table; the tool uses the durable operation records (exactly once per
   request, replayed on retry); the caller's number is stored as presented (unverified) and read back for confirmation;
   visible in admin.
6. **`transferCall`.** `/v1/live/sessions/{id}/refer` to a `tel:`/`sip:` target from the organization's allowlist only;
   Twilio per-trunk transfer setting enabled; blind transfer (Twilio REFER is blind only); every attempt persisted;
   failure → callback offer; the agent never claims a person answered.
7. **DTMF.** Keypad events delivered to the agent (for example entering a callback number) and logged.
8. **Limits and fallback.** Per-organization concurrent calls (`concurrent_calls` reservation resource), voice-minute
   spend reservation, maximum call duration (at most the provider's 2 h), ringing at most 3 min; tenant-configured
   fallback (forward to a configured number, or a short message) when a limit or provider error prevents answering.
9. **Admin.** Calls (list; detail with transcript, tool runs, outcome, duration, transfer result), Phone numbers,
   Callback requests.
10. **Metering.** GPT-Live seconds, backend tokens, transcription, and a carrier-minutes estimate (Twilio origination
    rate) per call, with pricing version.

### Out of scope

Outbound calls (Phase 6); SMS and booking (Phase 4); warm/attended transfer; audio recording storage; voicemail
product; IVR/menu builder; number porting; toll-free and non-US numbers; conference calls.

### Dependencies and risks

- Phase 2 engine accepted; S3.1 outcome.
- Twilio account and trunk configuration; per-number cost (US local number USD 1.15/month; Elastic SIP origination
  local USD 0.0034/min, per Twilio pricing pages current as of Oct/Nov 2026).
- OpenAI webhooks retry for up to 72 h: deduplication by `webhook-id` is mandatory, and late retries must not create
  calls.
- Caller ID can be spoofed; it is never used as authentication.
- Narrowband codecs (PCMU/PCMA) affect perceived quality; the [VOICE_QUALITY.md](VOICE_QUALITY.md) phone targets apply
  to the phone path as delivered.
- Provider limits: 3 min ringing, 2 h connected.

### Acceptance criteria

1. S3.1 decision record with live evidence; the chosen path and the status of each fallback are documented.
2. Every call in the Phase 3 evaluation runs is answered by the dialed tenant's agent with its configured greeting.
   Unanswered or dropped calls count as task failures; provider errors and dropped calls are never excluded
   ([VOICE_QUALITY.md](VOICE_QUALITY.md) §6.0).
3. Webhooks with invalid, missing or expired signatures are rejected and no call is accepted; a duplicate `webhook-id`
   creates no second session or call (automated).
4. Calls resolve to the tenant that owns the dialed number; a missing/wrong secret header or an unmapped number is
   rejected (automated); a two-tenant live test shows no cross-tenant knowledge or configuration.
5. Scripted live calls pass and appear in admin with transcript, tool runs and outcome: knowledge question; unknown
   question (no invention); lead capture; callback request; successful human transfer; failed human transfer → callback
   captured.
6. Duplicate tool calls, webhook retries and concurrent workers produce exactly one callback request (automated
   concurrency test).
7. A non-allowlisted transfer destination is refused and audited; on transfer failure the caller is offered a callback;
   no transcript claims a person answered (automated and live).
8. Keypad digits reach the agent; a callback number entered on the keypad is stored correctly (live).
9. Concurrent call N+1 above the organization limit, and any new call after the spend limit is reached, receives the
   configured fallback — never silence or a dropped call; a live call that reaches a limit wraps up within a bounded
   grace period with a callback offer; calls end gracefully at the configured maximum duration (automated where
   possible, plus live).
10. Every call reaches a terminal state for each close reason; none remain active after hangup (automated with
    simulated events).
11. Each call has usage records for provider seconds (equal to `session.closed`), backend tokens and a carrier-minutes
    estimate, all with pricing version (automated).
12. The telephone faults of [VOICE_QUALITY.md](VOICE_QUALITY.md) §8.4 (including webhook redelivery, caller hang-up
    mid-tool, sideband drop longer than 3 s, gateway restart, spend limit reached) each produce the required behaviour.
13. Phase 3 gates of [VOICE_QUALITY.md](VOICE_QUALITY.md) §10 pass in an evaluation record: tested task completion
    (N ≥ 400, observed ≥ 98%) and confirmed contact-information accuracy (≥ 1000 fields, observed ≥ 99%) under the
    standard telephone matrix. Latency, interruption and naturalness (≥ 60 conversations) are measured, reported and
    disclosed to pilot tenants.
14. Z1: zero in ≥ 300 action-bearing calls (≥ 100 with injected failures). Z2: zero, counted at the provider side
    (REFER requests and the stub tool). Z3: zero across ≥ 200 calls and ≥ 3 tenants plus ≥ 20 forged attempts per
    vector ([VOICE_QUALITY.md](VOICE_QUALITY.md) §6.6–6.8).

---

## Phase 4 — Appointment booking, SMS and customer-conversion workflows

**Goal.** The agent completes the most common conversion actions — check availability, book, confirm by SMS — on chat,
voice and phone, with consent and exactly-once guarantees.

### Build

1. **Calendar.** Adapter boundary with one initial calendar provider, chosen at phase start from tenant demand; OAuth
   connection; integration credentials encrypted at rest; per-agent booking rules (services, durations, buffers,
   minimum notice).
2. **Tools.** `checkAvailability` (read) and `bookAppointment` (`external`; durable operation records; the provider's
   idempotency key where supported; `unknown` outcomes reconciled by reading the calendar back; read-back confirmation
   before invocation). A corrective change/cancel action limited to an appointment booked in the same conversation, so
   a caller's correction becomes an explicit new action ([VOICE_QUALITY.md](VOICE_QUALITY.md) §4). Appointments record
   and admin Appointments page.
3. **SMS.** Twilio behind the carrier boundary: `sendSMS` (`external`, operation records); inbound SMS webhook
   (`X-Twilio-Signature` verified) for replies and opt-out keywords; every message stored in its conversation; message
   templates per purpose.
4. **Consent.** Consent records (recipient, purpose, time, channel, exact disclosure text, evidence, revocation);
   per-tenant opt-out list; HELP response; quiet hours for non-transactional messages.
5. **A2P 10DLC.** Brand and campaign registration per tenant (process chosen at phase start); US sending blocked until
   approved.
6. **Metering and limits.** SMS segments and carrier-fee estimate; `sms_segments` reservation resource; per-organization
   SMS caps.
7. **Conversion workflows** (fixed flows, not a builder): booking confirmation SMS; callback confirmation SMS; outcome
   tracking per conversation (lead → callback → booking) visible in admin.

### Out of scope

Rescheduling or cancelling appointments made in earlier conversations (needs caller identity verification; expected
follow-up); more than one calendar provider; scheduled reminders;
reminder calls (Phase 6); marketing or bulk SMS; MMS; WhatsApp; payments; CRM sync; workflow builder; non-US SMS.

### Dependencies and risks

- Phase 3 accepted (callback requests, phone channel).
- A2P 10DLC registration is required for US application-to-person SMS; Twilio's pages state conflicting fees; lead time
  is a schedule risk — confirm both at phase start.
- Documented legal review of consent text and opt-out handling before any tenant is enabled.
- Calendar provider OAuth app review; time zones and DST; races for the same slot; providers without idempotency keys
  make `unknown` outcomes more likely and require read-back reconciliation.

### Acceptance criteria

1. `checkAvailability` returns only slots inside business hours and free in the calendar, in the agent's time zone,
   including on DST transition dates (automated with a fake calendar).
2. Duplicate tool calls, retries, reconnects and concurrent sessions produce exactly one calendar event per confirmed
   booking (automated with a fake provider; once live against the real provider).
3. Two concurrent requests for the same slot produce at most one booking; the other customer is offered alternatives
   (automated).
4. A provider timeout after sending yields `unknown`: the agent says the booking is unconfirmed, the operation appears in
   the unresolved list, and reconciliation resolves it (automated).
5. SMS is refused — and the refusal audited — without an approved A2P 10DLC registration (US), without a consent record
   for the purpose, after opt-out, and outside quiet hours for non-transactional messages (automated, one test per
   gate).
6. After an inbound opt-out keyword, no further non-exempt message is sent to that number by that tenant (automated and
   live).
7. Inbound SMS webhooks with an invalid signature are rejected (automated).
8. Every sent SMS has a consent reference, an operation record, a usage record (segments, estimated cost) and appears in
   its conversation (automated).
9. Scripted booking + SMS confirmation scenarios produce the same tool sequence and outcome on chat, the voice engine
   and phone (automated with fakes; live on phone).
10. Admin counts of conversations, leads, callbacks and bookings per period equal the database counts (automated).
11. A correction after booking ("no, Thursday") produces an explicit corrective action; the first booking is neither
    duplicated nor left in place silently, and the agent describes both actions truthfully (automated).
12. Legal review sign-off recorded before any tenant is enabled for SMS.
13. Z1–Z3: zero occurrences. Because booking and SMS add tools, the zero-tolerance gates of
    [VOICE_QUALITY.md](VOICE_QUALITY.md) §10 are re-run on the telephone channel with these tools, with Z2 counted at the
    provider side (calendar sandbox records, Twilio message logs).

---

## Phase 5 — Production-quality website live voice widget

**Goal.** Tenant-enabled voice mode in the existing embeddable widget, on the Phase 2 engine, meeting the
[VOICE_QUALITY.md](VOICE_QUALITY.md) web targets.

### Build

1. Voice mode in the widget (`public/embed.js` iframe with microphone permission): permission flow, presentation-only
   UI state machine (idle, connecting, listening, thinking, tool, speaking, error), live captions, switching between
   text and voice within one conversation.
2. Short-lived signed voice-session tokens issued to widget sessions; allowed sites apply.
3. Session lifecycle: clean close on stop, tab close, navigation and network loss (microphone released, peer connection
   closed, provider session closed, reservation settled).
4. Fallback to text when microphone access is denied, WebRTC fails or a limit is reached.
5. Admin: per-widget voice enablement, voice selection, voice-minute limits.
6. Voice abuse controls: session-creation rate limits per client, visitor, widget and organization; maximum session
   length; concurrency caps; a user gesture is required to start.
7. Accessibility: keyboard operation, screen-reader labels, captions.
8. A defined browser support matrix (desktop and mobile), tested.

### Out of scope

Video or avatars; voice cloning; wake words or always-on listening; native mobile SDKs; languages the provider does not
support.

### Dependencies and risks

- Phase 2 engine accepted.
- Host-site constraints: the iframe needs microphone permission (`allow="microphone"`); host-page policies can block
  it.
- Mobile browser WebRTC and audio-autoplay behaviour; networks that block UDP.
- Anonymous visitors create billed sessions (15 s billed per creation): abuse controls are part of acceptance.

### Acceptance criteria

1. All Phase 5 gates of [VOICE_QUALITY.md](VOICE_QUALITY.md) §10 pass in an evaluation record: median speech-to-response
   latency, P95 ordinary response latency and interruption-to-audio-stop latency under the reference conditions; tested
   task completion (N ≥ 600, Wilson LB ≥ 98%), contact-information accuracy (Wilson LB ≥ 99%) and naturalness (§6.9)
   under the standard browser matrix; Z1 (N ≥ 500), Z2 and Z3 under every condition, including failure injection.
2. No provider key or client secret reaches the browser (automated response and bundle checks).
3. The voice flow works end to end on every browser and device in the support matrix, which includes the
   [VOICE_QUALITY.md](VOICE_QUALITY.md) §7.2 device set (headset, laptop built-in microphone and speakers, iOS and
   Android phone browsers).
4. In every scripted close (stop button, tab close, navigation, network drop) the microphone is released, the provider
   reports `session.closed`, and the usage reservation is settled (verified from session and reservation records).
5. Each failure case (microphone denied, WebRTC failure, limit reached) falls back to text chat (automated UI tests).
6. Session creation above the configured per-client rate is refused before any OpenAI call; maximum session length is
   enforced (automated).
7. Automated accessibility check reports zero serious or critical violations on the voice controls; the voice flow is
   operable by keyboard alone.
8. A conversation that mixes voice and text shows both in order in the transcript (automated).
9. Each voice language offered to tenants has passed its own evaluation ([VOICE_QUALITY.md](VOICE_QUALITY.md) §7.4);
   English first.
10. Z1–Z3: zero occurrences (sample sizes as in criterion 1).

---

## Phase 6 — Consent-based outbound calling agent

**Goal.** The agent places calls only for platform-approved, consent-based workflows, after tenant review.

### Spike and preconditions

- **S6.1 Outbound origination path.** The verified OpenAI SIP documentation covers incoming calls; how an outbound call
  reaches a GPT-Live session is not covered by the verified facts. Candidates: Twilio places the call (Elastic SIP
  termination, USD 0.010/min US) and bridges it to OpenAI SIP; Twilio Media Streams through the gateway; the Realtime
  API path. Prove one with live evidence and record the decision.
- Documented legal review of consent, calling hours, do-not-call handling and disclosure before build completes.

### Build

1. Consent records for call purposes (evidence, revocation), reusing the Phase 4 consent model.
2. Do-not-call: per-tenant list; in-call opt-out adds the number immediately; national registry checks where the legal
   review requires them.
3. Calling-hours enforcement in the recipient's local time; platform default from the legal review; tenants may narrow
   but not widen the window.
4. Approved workflow templates: callback to a customer who requested it; confirmation/reminder for an appointment the
   customer booked; a follow-up the customer requested. Each template defines purpose, script constraints, allowed
   tools and attempt limits, and is approved by the platform operator.
5. Human review: the tenant approves each run; nothing is dialed without an approval record.
6. Disclosure and business identification in the agent's first turn; caller ID is always the tenant's own number.
7. Attempt and frequency caps; outbound-attempt reservation resource; per-organization and platform-wide kill switch.
8. Outcomes per call; admin Outbound workflows page.

### Out of scope

Cold calling; purchased or rented lists; marketing campaigns; predictive or mass dialing; voicemail drops; caller ID
other than the tenant's number; SMS campaigns.

### Dependencies and risks

- Phases 3 and 4 accepted (callback requests and bookings trigger the workflows).
- S6.1 outcome; jurisdiction-specific telemarketing rules; carrier spam labelling of tenant numbers.

### Acceptance criteria

1. 100% of calls placed in test runs reference a valid consent record for the workflow purpose and an approval record;
   attempts lacking either are refused before dialing and audited (automated).
2. After an in-call or SMS opt-out, zero further calls or messages reach that number from that tenant's automated
   workflows (automated and live).
3. Zero calls are placed outside the calling window in automated tests covering at least four US time zones and DST
   transition dates.
4. Numbers on a do-not-call list are never dialed (automated).
5. 100% of live test-call transcripts contain the automated-assistant disclosure and the business name in the agent's
   first turn.
6. Attempt and frequency caps are enforced (automated).
7. The kill switch prevents any further dial attempt after activation (automated).
8. All Phase 6 gates of [VOICE_QUALITY.md](VOICE_QUALITY.md) §10 pass for outbound scenarios on the telephone channel:
   latency and interruption (§6.1–6.3), tested task completion (N ≥ 600, Wilson LB ≥ 98%), contact-information accuracy
   (Wilson LB ≥ 99%), naturalness (§6.9), Z1 (N ≥ 500), Z2 and Z3.
9. Legal review sign-off recorded before any tenant is enabled.
10. Z1–Z3: zero occurrences; Z2 includes a second call to the same recipient for the same workflow step.

---

## Phase 7 — Commercial readiness, billing, monitoring and scaling

**Goal.** The platform can be sold, billed, operated and recovered.

### Build

1. **Subscription billing.** Plans with included usage and limits (payment provider chosen at phase start); plan limits
   drive the organization limits; tenant-visible usage, estimated spend and invoices; tenant-adjustable limits within
   the plan; spend alerts at thresholds.
2. **Provider-confirmed cost reconciliation.** Daily import from the OpenAI Costs API (`GET /v1/organization/costs`;
   daily buckets grouped by project, API key or line item; admin key, server-side only; no per-request costs) and Twilio
   usage records; comparison with the stored estimates; variance report and alert.
3. **Monitoring and alerting.** Error monitoring and log shipping built on the Phase 1.5 event schema; dashboards;
   alerts for provider auth/quota errors, webhook failures, gateway health and call-answer failures.
4. **SLOs.** Defined and measured, for example call-answer success rate, webhook acknowledgement latency, chat
   first-token latency and voice latency per [VOICE_QUALITY.md](VOICE_QUALITY.md).
5. **Scaling.** Gateway horizontal scaling and draining; database pool sizing; ANN vector index when per-tenant volumes
   require it; asynchronous knowledge ingestion; load tests.
6. **Data protection.** Backups and tested restore; data retention settings; tenant export and deletion.
7. **Incident runbooks.** OpenAI outage, Twilio outage, database outage, credential leak and rotation, runaway spend,
   abuse.
8. **Per-visitor abuse controls** beyond rate limits (per-visitor quotas, bot mitigation on the public widget).
9. **Trusted client-IP configuration.** Which proxy headers are trusted per deployment (rate limits depend on it).

### Out of scope

Analytics warehouse; multi-region active-active; reseller/white-label billing.

### Dependencies and risks

- Real usage from Phases 3–5; OpenAI admin key handling; the Costs API reports daily buckets only, so reconciliation is
  per day and project, not per request.

### Acceptance criteria

1. For a test tenant over a test period, invoiced usage units equal metered units exactly; a plan-limit change takes
   effect on the next reservation (automated).
2. The reconciliation job imports Costs API buckets for at least 7 consecutive days in a live environment; variance
   between estimated and provider-confirmed cost is reported per day and line item; an alert fires when variance exceeds
   the configured threshold (automated with fixtures; live import evidence).
3. Tenant spend alerts are delivered at the configured thresholds (automated).
4. Every defined alert fires in a fault-injection test and reaches the on-call channel.
5. SLOs are documented with their measurement queries and dashboards, and measured over at least one full period before
   commercial launch.
6. A load test at twice the planned launch concurrency for chat, voice sessions and calls holds the SLOs and
   [VOICE_QUALITY.md](VOICE_QUALITY.md) targets with zero Z1–Z3 occurrences.
7. A restore drill completes; measured restore time and data loss are recorded against the documented RTO/RPO.
8. A runbook exists for each listed incident and each has been exercised once (tabletop or game day) with notes.
9. A spoofed `X-Forwarded-For` from an untrusted hop does not change the client IP used for rate limiting (automated).
10. Export returns every record of the tenant; deletion removes (or anonymizes, as documented) every record (automated).
11. Before inbound telephone moves from pilot to general availability, the telephone latency, interruption and
    naturalness gates of [VOICE_QUALITY.md](VOICE_QUALITY.md) §10 (§6.1–6.3, §6.9) pass in an evaluation record.
12. Z1–Z3: zero occurrences.

---

## Phase 8 — Industry-specific templates and measured provider-cost optimization

**Goal.** Vertical templates as configuration on the unchanged core, and provider-cost reductions that are proven not
to reduce quality.

### Build

1. **Template format.** Instructions, business fields, tool availability, qualification schema and test scenarios —
   data applied at agent creation; no core changes per industry.
2. **First templates** chosen by tenant demand (candidates: HVAC, plumbing, restoration, logistics, legal, dental, auto
   repair). Industry tools (`getOrderStatus`, `createQuote`, `createSupportTicket`) only with a real integration and
   tenant need.
3. **Measured cost optimization** — each change ships only with a recorded comparison:
   - Voice: `gpt-realtime-2.1-mini` (token-billed: audio USD 10 in / 0.30 cached / 20 out per 1M; user audio 1 token per
     100 ms, assistant audio 1 token per 50 ms; no official per-minute figure) versus GPT-Live (USD 0.05/min active,
     0.02/min standby, plus backend tokens), measured with the [VOICE_QUALITY.md](VOICE_QUALITY.md) methodology on the
     same scenario set, reporting cost per completed call and per connected minute (§8.5) from measured usage.
   - GPT-6.2 cache layout: top-level `instructions` are billed uncached on every request and appended after the input;
     evaluate moving the stable prompt into the first developer message and measure cached-token share and cost.
   - Escalation thresholds, retrieval top-K and thresholds, Batch/Flex pricing for offline jobs (for example offline
     evaluations), alternative embedding providers.

### Out of scope

Forking the core per industry; industry-specific apps; a template marketplace; any optimization without measurements.

### Dependencies and risks

- Real usage and reconciled cost data from Phase 7.
- Quality regressions from cheaper models; `gpt-realtime` and `gpt-realtime-mini` shut down 2027-01-20 (only the 2.1
  family is a candidate).

### Acceptance criteria

1. An agent created from each template passes that template's test scenarios (automated with fakes; `npm run eval:live`
   with real models).
2. An architecture test fails if industry-specific identifiers appear in the domain layer, agent core or channel code.
3. Each shipped cost change has a recorded comparison showing: the [VOICE_QUALITY.md](VOICE_QUALITY.md) §10 gates for
   the affected channel still pass; task completion not lower than the baseline; Z1–Z3 at zero; lower cost than the
   baseline (voice: cost per completed call and per connected minute, §8.5; text: cost per resolved conversation).
   Otherwise the change is reverted.
4. Switching the voice model or provider requires configuration and a pricing entry only.

Metrics for every comparison: task completion, latency, transfer success, hallucination/error rate, cost per resolved
conversation, cost per booked or qualified lead. Do not optimize for per-token price alone.

---

## Sources

Provider facts in this plan were checked on 2026-11-26 against official documentation:
https://developers.openai.com/api/docs/models, https://developers.openai.com/api/docs/pricing,
https://developers.openai.com/api/docs/guides/live (with the `realtime-webrtc`, `voice-server-controls`,
`live-delegation` and `live-conversations` guides), https://developers.openai.com/api/docs/guides/voice-sip,
https://developers.openai.com/api/docs/guides/error-codes, https://www.twilio.com/docs/sip-trunking, and Twilio US
pricing pages (marked current as of Oct/Nov 2026).
