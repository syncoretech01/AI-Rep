# Syncore AI Receptionist — Architecture

Status: Phases 0, 1 and 1.5 are implemented (web chat, knowledge, tools, hardening). Voice and telephony (§18)
are designed and their feasibility checked against provider documentation (2026-11-26), not implemented.

## 1. Architectural goal

One multi-tenant agent platform, many channels: inbound phone, realtime web voice, web chat, and consent-based
outbound calls. The domain layer owns business configuration, knowledge retrieval, contacts/leads (later callbacks
and appointments), tools/actions, conversations and usage/audit data. Channels only adapt transport and provider
events into the domain; they contain no business logic and no second "voice engine".

## 2. High-level architecture

```text
                                  Syncore agent core (src/server)
                  ┌───────────────────────────────────────────────────────────┐
                  │ agents · business profile/hours · knowledge + retrieval   │
                  │ ContextAssembler · ModelRouter · retry policy             │
                  │ tool registry + executor (validation, fencing, audit,     │
                  │   durable operations) · contacts/leads · conversations    │
                  │ usage metering + spend limits · audit                      │
                  └───────────────┬──────────────────────────┬────────────────┘
                                  │                          │
          Next.js app (serverless OK)                 Voice gateway (Phase 2+, persistent Node)
          ├─ admin UI (Supabase Auth, RLS)            ├─ creates GPT-Live sessions server-side
          ├─ web chat API (SSE) ← widget iframe       ├─ holds sideband WebSockets for live calls
          └─ proxy: sessions, widget frame policy     └─ receives SIP call webhooks (Phase 3)
                                  │                          │
            TextModelProvider / EmbeddingProvider     RealtimeVoiceProvider / TelephonyCarrier (added in 2/3)
                                  │                          │
                                  └──────────┬───────────────┘
                                             │
                     PostgreSQL (Supabase) + pgvector — the single source of truth
```

The web app and the voice gateway are two entry points of one codebase sharing `src/server` and one database.

## 3. Stack

Implemented: Next.js 16 (App Router, `src/proxy.ts`), React 19, TypeScript 6 strict, Tailwind 4, Zod 4, Supabase Auth
(`@supabase/ssr`, `getClaims`), PostgreSQL via `node-postgres` (Supavisor transaction pooler compatible), pgvector,
OpenAI adapters (Responses API + embeddings), Vitest + PGlite (real Postgres + pgvector in-process), GitHub Actions
CI (`.github/workflows/ci.yml`: clean install, typecheck, lint, tests, build).

Planned: a long-lived Node service for realtime voice (Phase 2), Twilio Elastic SIP Trunking and SMS (Phases 3–4),
error monitoring and alerting (Phase 7). Realtime voice never runs inside short-lived request handlers, and raw audio
is never proxied through Next.js.

## 4. Provider abstraction

Implemented contracts (`src/server/ai/types.ts`): `TextModelProvider` (`generate`, `stream`), `EmbeddingProvider`
(`embed`), normalized `ProviderError` (`code`, `retryable`, `status`, `retryAfterMs`), normalized `TokenUsage`.
OpenAI SDK types never leave `src/server/ai/openai/` (enforced by `tests/unit/architecture.test.ts`). Provider
factories are keyed by the ids in `AI_*_PROVIDER`; model names live only in configuration.

Added when their phase needs them, not before: `RealtimeVoiceProvider` (create/accept a session, attach the
sideband, map provider events to domain voice events) in Phase 2, `TelephonyCarrier` (numbers, transfer) in Phase 3,
an SMS sender in Phase 4.

## 5. Channel architecture

### Web chat (implemented)

`widget iframe → POST /api/widget/messages (SSE) → web chat channel service → runChatTurn → cheap model ⇄ tools
→ persisted reply`

- The public widget key resolves the tenant server-side (service scope); the browser holds only an HMAC-signed
  session token bound to the agent; the conversation lives in Postgres.
- Rate limits per client (IPv6 per /64), widget and organization; one turn per conversation at a time (§14).
- Embedding is controlled per widget with allowed sites (CSP `frame-ancestors`, §15); this is not authentication.

### Web voice (Phase 2 developer lab implemented; Phase 5 production)

`browser mic ⇄ WebRTC ⇄ OpenAI GPT-Live session`; our server only forwards the SDP offer to the voice gateway, which
creates the session with pinned configuration and holds its sideband for tools, transcripts, metering and control.
Details in §18.

### Phone (Phase 3)

`PSTN → Twilio (SIP trunk) → OpenAI SIP → GPT-Live session`, with the voice gateway handling the incoming-call
webhook, accepting with the tenant's configuration and attaching the same sideband. Details in §18.
Telephone call state lives on the server (§7), never in browser state.

### Outbound calls (Phase 6)

Only approved, consent-based workflow templates, initiated by the server with consent records, opt-out and calling-hour
rules; same voice path and tools.

## 6. Browser UI architecture

Controller + typed events + a Zustand state machine (`IDLE → OPENING → READY → THINKING → TOOL → SPEAKING → ERROR`;
voice adds `LISTENING`). Presentation state only: business truth is always the server's.

## 7. Server call state (Phase 3)

`initiated → ringing → connected → active → transferring → completed | failed`, persisted with external ids
(Twilio call SID, OpenAI session id) and timestamps, linked to a conversation.

## 8. Tool system

Tools are server-side capabilities, never model privileges. A definition has a stable name, description, Zod input,
channel availability, required agent capabilities, side-effect class, idempotency strategy, optional time limit and
handler.

Execution pipeline (`src/server/agent/tools/executor.ts`):

```text
model requests a tool
→ lookup (Map; unknown names refused)          → availability for this agent + channel
→ JSON parse + Zod validation                   → per-turn tool-call cap
→ tool_runs row 'running' — written only while the caller still owns the conversation turn lock (fencing)
→ side-effect class:
     none      read-only; raced against its time limit
     writes    internal transactional writes; idempotent replay of the latest identical successful run;
               a started write is awaited so its outcome is recorded truthfully
     external  durable operation claim (below), then the handler with the operation identity
→ outcome persisted (+ audit entry for side effects) → minimal JSON result for the model
```

**External operations** (`app_private.tool_operations`, `src/server/agent/tools/operations.ts`), for third-party
actions in later phases (SMS, calendar, CRM). One row per operation identity `(organization_id, operation_key)`;
default key `sha256(conversation | tool | normalized arguments)`, overridable per tool.

| State | Meaning | Next |
| --- | --- | --- |
| (no row) | never attempted | claim → `in_progress` |
| `not_attempted` | claimed, nothing was sent (e.g. not configured) | may be claimed again |
| `in_progress` | one worker holds the claim (token + lease) | a concurrent request gets `in_progress`, nothing runs |
| `succeeded` | confirmed by the provider | repeats replay the stored result, never re-executed |
| `failed` | confirmed failure (provider refused) | may be claimed again |
| `unknown` | sent, outcome unconfirmed (timeout/crash after start, or a lapsed claim) | **never retried automatically**; reconciliation (`resolveUnknownOperation`) sets succeeded/failed |

The claim is one atomic `INSERT … ON CONFLICT DO UPDATE WHERE status IN ('not_attempted','failed')`; every
transition out of `in_progress` is fenced by the claim token. A worker whose lease lapsed may still record the outcome
it learned while nobody has re-claimed the operation (`last_claim_token`); any other late write is refused. Operation
keys are always namespaced by tool, so two tools can never replay each other's results. A confirmed provider success
is reported as success even when the handler's data is unusable (a minimal result is stored). For
`in_progress`/`unknown` the model is told not to claim success or failure and to say the team will confirm.

Implemented tools: `searchKnowledge`, `getBusinessInfo`, `getBusinessHours`, `captureLead`. Planned:
`createCallbackRequest` and `transferCall` (Phase 3), `sendSMS` and booking (Phase 4).

## 9. Multi-tenant data model

Implemented (`supabase/migrations/`):

| Area | Tables |
| --- | --- |
| Tenancy | `organizations`, `organization_members` (users via Supabase Auth) |
| Agent / config | `agents`, `agent_channels` (widget key, `config.allowedOrigins`), `business_profiles`, `business_hours` |
| Knowledge | `knowledge_sources`, `knowledge_documents`, `knowledge_chunks` (`vector(1536)`) |
| CRM-lite | `contacts`, `leads` |
| Conversation | `conversations` (channel-neutral; rolling summary; turn lock + owner token), `messages` |
| Operations | `tool_runs`, `usage_records` (estimates + `pricing_version`), `audit_logs` |
| System (`app_private`, no API access) | `rate_limit_buckets`, `tool_operations`, `organization_limits`, `usage_daily_totals`, `usage_reservations` |

Planned: `phone_numbers`, `calls`, `call_events`, `voice_sessions` (Phase 2/3), `callback_requests` (3),
`appointments`, `consent_records`, `integrations` (4/6).

Every tenant-owned row carries a NOT NULL `organization_id`; references between tenant tables are composite foreign
keys `(x_id, organization_id)`, so cross-tenant links are impossible at the database level. RLS is enabled on every
table; policies and grants name only `authenticated`; system tables in `app_private` grant nothing to API roles.

## 10. Conversation model

`conversations` is channel-neutral: organization, agent, channel, visitor/contact, status, rolling summary +
`summary_through_seq`, turn lock. A call or voice session will reference a conversation. Messages are visitor text,
assistant text, tool call, tool result and system markers; provider payloads are never stored in messages.

## 11. Knowledge architecture

Structured facts in structured tables. Unstructured: `source → document → normalized text → chunks → embedding →
pgvector`. Retrieval: organization + agent scoping, embedding-model filter, relevance threshold, top-K and token caps,
exact tenant-filtered scan (an ANN index can be added when per-tenant volumes need it). An answer is based on
retrieved material or says it does not know.

## 12. Context assembler

One `ContextAssembler` for every channel (text now, voice delegation later): concise stable developer instructions,
relevant structured facts, rolling summary, the messages the summary does not cover, allowed tools, channel style.
Untrusted text (visitor messages, the visitor-derived summary, knowledge, tool results) never goes into the developer
instructions: the summary is a labelled user-role context message, knowledge arrives as tool results framed as facts.
Budgets: AI_RUNTIME.md.

## 13. Model routing

`ModelRouter` selects configuration (provider, model, reasoning effort), never domain behaviour: cheap default for
routine work; the escalation model only for demonstrated complexity or a model-quality failure, capped per
conversation; never for outages (same-model retries instead); summaries always cheap; realtime speech uses the voice
model. Policy, retries and failure classes: AI_RUNTIME.md "Model routing".

## 14. Concurrency and execution safety

- **One turn per conversation.** `tryAcquireTurnLock` is a single atomic `UPDATE` that sets `turn_locked_until` and a
  fresh random `turn_lock_token` only when the lock is free or expired; it returns the token. `releaseTurnLock`
  requires the token, so a worker whose lock expired cannot free the lock of the turn that took over.
- **Fencing.** Every write a turn makes — each message append and each tool-run start — is one statement that
  succeeds only while `turn_lock_token` still matches. A stale worker (lock lapsed and re-acquired elsewhere) gets
  `TurnLockLostError` / a fenced tool run and stops writing; it cannot start a tool run. (The check is made when the run
  starts; an internal write tool then commits in its own transaction moments later — a window far inside the lock
  TTL margin. External operations are additionally protected by their claim.)
- **Time budget chain:** turn deadline 50 s < route `maxDuration` 60 s < lock TTL 120 s.
- **Multiple instances.** All lock, limit and claim state lives in Postgres and is changed by single atomic
  statements or transaction-scoped advisory locks, which work behind the Supavisor transaction pooler. No Redis:
  nothing so far needs it.
- **External side effects** use durable operation records (§8): at most one execution per identity, replay of
  confirmed success, explicit unknown outcomes held for reconciliation.

## 15. Security

- Secrets server-only; providers called only from the server; the widget never sees a provider key.
- Two database scopes: user scope (role `authenticated` + JWT claims via transaction-local `set_config`, so RLS
  applies) and service scope (privileged; every statement filters `organization_id`, tenant derived server-side from
  the widget key, never from request bodies or model output). An audit of all service-scope queries (2026-11-26)
  found no cross-tenant path.
- **Verified database TLS is required in production** (`NODE_ENV=production` + remote host ⇒ `DATABASE_SSL_CA`
  mandatory; `db:migrate` refuses unverified TLS unless `--allow-unverified-tls`; `host`/`hostaddr` query parameters,
  which would redirect the connection behind that check, are refused).
- Public widget: signed session tokens bound to the agent, same-origin + JSON-only API, rate limits, conversation
  lock, organization spend limits and per-turn/per-conversation caps against cost amplification.
- **Allowed sites**: per-widget `frame-ancestors` set by the proxy from `agent_channels.config.allowedOrigins`
  (normalized bare origins only; a configured list with no valid entry and unknown/unpublished widgets get `'none'`). Browser-enforced embedding control,
  explicitly not authentication — scripts can still call the public API, bounded by the limits above.
- Prompt-injection posture: untrusted text never in developer instructions; side effects only through validated
  server-side tools; no success claim before a tool returns success; provisional text next to side-effecting tool
  calls is dropped; tools cannot reach other tenants.
- Logs: JSON with key-based redaction of secrets/contact details and free-text keys; error stacks and Postgres
  details never logged.
- Planned with their phases: webhook signature verification (OpenAI Standard Webhooks, Twilio `X-Twilio-Signature`),
  allowlisted transfer destinations, encrypted integration credentials, trusted client-IP configuration behind
  proxies other than Vercel.

## 16. Cost controls

Adapters report normalized usage; a cost service prices it into `usage_records` with the price-list version; spend
limits reserve a conservative cost estimate before every provider call. Limits, reservations and per-turn caps: AI_RUNTIME.md
"Runtime cost controls". Billing logic never lives in provider adapters.

## 17. Observability

Structured JSON log events named `<area>.<subject>.<event>` with shared identity fields (`organizationId`,
`agentId`, `conversationId`, `channel`, `turnId`) and provider fields (`provider`, `model`, `tier`, `route`). Model
calls report attempts, latency, time to first token, tokens, estimated cost and failure class; turns report totals;
limit enforcement and tool outcomes have their own events (catalogue in AI_RUNTIME.md). Usage records carry the same
dimensions for SQL aggregation. No telemetry infrastructure is required yet: a log drain plus SQL is enough.

For voice (Phase 2+) the same conventions extend with `sessionId` (voice session or call) and `interactionId` (one
user turn), and `voice.*` / `telephony.*` events for timing marks VOICE_QUALITY.md measures (speech end, first audio,
interruption, audio stop, tool start/end, transfer, disconnect reason).

## 18. Realtime voice architecture (browser path implemented in Phase 2; telephone Phase 3)

Verified against the OpenAI GPT-Live documentation (live, voice-webrtc, live-delegation, live-conversations,
voice-server-controls, voice-sip) on 2026-11-26; sources in AI_RUNTIME.md and VOICE_QUALITY.md. Phase 2 implements
the browser path below as a developer proof of concept (`/o/<org>/voice-lab`); it has **not yet been exercised against
the live provider** (LIVE_VALIDATION.md).

**Browser (Phase 2 developer lab; Phase 5 production widget)**

1. The browser captures the microphone (echo cancellation, noise suppression), creates an `RTCPeerConnection` with
   the provider's `oai-events` data channel, gathers ICE and posts the SDP offer to `POST /api/voice-lab/sessions`
   (same-origin, signed-in owner/admin, `VOICE_DEV_ENABLED=true`).
2. The Next.js route resolves organization and agent server-side and forwards the offer to the voice gateway
   (`POST /v1/voice-sessions`, shared `VOICE_GATEWAY_SECRET`). Signaling only: audio never passes through our servers.
3. The gateway checks the agent, the concurrent-session limit and the session-length cap, **reserves the session's
   worst-case spend for its whole maximum length** (all of it priced as active voice, plus a delegated-text
   allowance), opens a `voice_sessions` row and a `web_voice` conversation, takes the conversation's turn lock
   (fencing token for every write), and calls `POST /v1/live/sessions` with the permanent API key. Pinned there and
   immutable: `model` (`AI_VOICE_MODEL`, `gpt-live-1.1`), the voice model's own instructions (persona, conversation,
   delegation and interruption policy), voice, delegation (business rules and our tool schemas travel with the
   delegation, never through the browser), standby (`wake_policy: speech`, `idle_timeout_s`), a hashed
   `safety_identifier`, and the browser's data-channel allowlists: the browser may only send `session.close` and
   `session.input_audio.mute`/`unmute`, and only receives lifecycle, transcript deltas, usage and errors (never
   delegation, tool or backend events). GPT-Live needs no ephemeral client secret: the SDP answer is returned to the
   browser and media flows browser ⇄ OpenAI directly.
4. The gateway attaches to `wss://api.openai.com/v1/live/sessions/{id}/attach` immediately (the sideband replays only
   the last 3 s; events are de-duplicated by `event_id`, reflected audio is ignored).

**Telephone (Phase 3; not implemented).** GPT-Live supports SIP natively, inbound and outbound:

1. Inbound: a carrier SIP trunk (OpenAI's guide names Twilio as an example) points at
   `sip:proj_<id>@sip.api.openai.com;transport=tls`; OpenAI sends `live.transport.incoming` to our webhook (verify the
   Standard Webhooks signature, de-duplicate on `webhook-id`, treat `sip_headers` as untrusted except our secret
   header, resolve the tenant from the dialed number); the gateway accepts with the tenant's configuration
   (`/accept`), or rejects, transfers (`/refer`) or hangs up, and attaches the same sideband.
2. Outbound: `POST /v1/live/sessions` with a SIP transport places the call through the configured trunk (Phase 6
   approved workflows only).
3. Twilio connectivity is either an Elastic SIP Trunk to OpenAI SIP or Twilio's own GPT-Live integrations; the
   carrier choice stays behind the telephony service boundary (CLAUDE.md 17). Earlier notes that only the Realtime
   API had a documented Twilio SIP path are outdated.

**The voice gateway** (`npm run voice:gateway`, `src/server/voice-gateway.ts`) is a persistent Node process — the
second entry point of the same codebase, because sidebands live as long as the session. It reuses `src/server`:
tool calls go through the existing executor (registry, Zod validation, channel availability, idempotency,
operation records, audit, fencing); transcripts are appended to the same conversations/messages; session seconds
and delegated-model tokens are metered into `usage_records`; limits come from the same usage guard. One handler per
event: tool calls are de-duplicated by `call_id` and run one at a time; GPT-Live needs one `response.create` after
the last pending function output. Every 15 s the gateway heartbeats each session; sessions whose gateway stopped
heartbeating for 90 s are claimed atomically by another instance, closed at the provider and settled with estimated
usage (at startup and every 60 s).

**Limits and cleanup.** A session ends at the first of: the caller or developer ends it, the maximum length
(`VOICE_MAX_SESSION_SECONDS`, lowered by the organization override), 120 s without any speech, a fatal provider
error, a lost sideband (settled with estimated usage), or gateway shutdown. Ending asks the provider to close
(final usage arrives in `session.closed`) and settles on its own after 8 s if it never confirms. Settling records
usage (provider seconds when reported, otherwise elapsed time priced as active), ends the row, releases the
reservation and the turn lock, and disconnects the sideband — exactly once.

**Delegation (spike S2.2; provisional decision).** GPT-Live offers Responses delegation (an OpenAI-hosted backend
model answers and calls our function tools over the sideband; our gateway executes them) and client delegation (our
agent runtime produces the content; the voice model speaks it via `session.commentary.append`). Phase 2 selects
**Responses delegation** as the production direction, pending live latency and cost measurements (VOICE_QUALITY.md):
it is OpenAI's recommended path, keeps the documented tool loop and pre-warmed backend connections, uses the cheap
configured text model as backend (`AI_VOICE_DELEGATION_MODEL`, default `AI_TEXT_MODEL`), and still executes every
tool in our executor. Client delegation stays only as a configuration switch (`AI_VOICE_DELEGATION=client`) to
measure the comparison; it is not a second maintained architecture. Either way there is exactly one business-logic
engine.

**Interruption and failure safety.** GPT-Live handles turn detection, barge-in and audio cancellation natively and
reports no interruption event: the gateway infers a barge-in when caller speech starts before the agent's latest
words ended, records the agent's utterance as interrupted, and never undoes a committed tool run. captureLead on
voice refuses to save until the model confirms the caller approved the read-back (`detailsConfirmed`). A tool's
outcome is spoken only after the executor returns it; a dropped sideband or provider session settles the session
without repeating actions (operation records).

**Not used as the primary path:** browser SpeechRecognition/SpeechSynthesis, sequential STT → LLM → TTS, the
Realtime API, raw audio through Next.js, audio processing rebuilt where the provider handles it (VAD, barge-in,
echo/noise handling).

## 19. Human transfer (Phase 3)

A caller may ask for a person at any time. Transfer only to organization-configured allowlisted destinations; persist
every attempt; if it fails, offer a callback or message; never claim a person answered; channel logic requests
`transferCall`, the carrier adapter performs it.

## 20. What not to over-engineer

No generic workflow engine, plugin or provider marketplace, event sourcing, Kafka, Redis (Postgres covers locks,
limits and claims), microservices by default (the voice gateway is a second entry point of the same codebase because
it needs persistent connections), custom CRM or scheduler, or analytics warehouse. A modular monolith is preferred.

## 21. Reference-repository reuse

From `syncoretech01/Waseem-Jewellers` only the concepts were reused: provider abstraction, runtime/tool-execution seam,
typed event vocabulary, centralized tool definitions, browser controller + UI state machine. Not reused: jewellery
tools, navigation actions, browser-side business persistence or tool execution, or its realtime assumptions (current
provider documentation was followed instead).
