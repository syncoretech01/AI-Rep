# AI Runtime and Cost Strategy

Provider facts and prices verified against official documentation on **2026-11-26**
(<https://developers.openai.com/api/docs/models>, <https://developers.openai.com/api/docs/pricing>). Prices change: model
choices and prices are configuration (`AI_*`, `AI_MODEL_PRICING_JSON`), and every cost estimate is stamped with the
price list it used (`AI_PRICING_VERSION`). Re-check before commercial pricing decisions.

## Principle

Do not use one premium model for every interaction:

- a cheap default text model for ordinary chat, intent handling, tool selection, structured outputs and summaries;
- a stronger model only when a request demonstrably needs it (escalation policy below);
- a native realtime speech-to-speech model for phone and web voice;
- cheap embeddings for retrieval.

## Model routing

### Default text model: `gpt-6-luna`

Every chat turn, tool decision, tool-argument extraction, summary and classification starts here. It supports the
Responses API, streaming, function calling and prompt caching; reasoning effort `none|low|medium|high|xhigh|max`
(default configured: `low`). OpenAI publishes no dated snapshot for it (alias only), so a model change on the
provider side is possible — live evaluations record the model id the provider reports.

### Escalation model: `gpt-6.2-sol`

The current Sol model ("complex work at lower cost" per OpenAI; `gpt-6-sol` and `gpt-6.1-sol` also exist). It
rejects reasoning effort `none` (configured: `medium`) and requires the Responses API for tool calling.

Escalation is a **reasoning** decision, never an infrastructure one (`src/server/ai/router.ts`):

| Trigger | Escalates? |
| --- | --- |
| Routine request, any length | No |
| Caller established the request is complex (`complexity: 'complex'`) | Yes |
| Default model failed on quality: 2 rejected tool calls in a turn (invalid arguments / unknown tool) | Yes, for the remaining rounds |
| Default model returned neither text nor a tool call | Yes, that round is asked once more |
| Rate limit, timeout, 5xx, connection failure | **No** — same-model retry (below) |
| Authentication, configuration, quota, content policy | **No** — fails immediately with an alert |
| Summaries and classification | Never |

Escalation happens at most once per turn and is capped per conversation (`AI_MAX_ESCALATED_CALLS_PER_CONVERSATION`,
default 6) because quality failures can be provoked by a visitor on purpose. GPT-6.2 models drop earlier reasoning
items after a model change, so an escalated round continues from the conversation text, not the cheap model's
reasoning (the adapter already replays provider state only to the same provider and model).

### Failure handling (retries)

`src/server/ai/retry.ts`, applied to chat rounds, summaries and embeddings:

- Retryable failures — 429 rate limit, timeouts, 5xx/overloaded, connection errors, 408/409 — are retried on the
  **same provider and model**: at most `AI_PROVIDER_MAX_RETRIES` (default 2) times, with equal-jitter exponential
  backoff (400 ms base, doubling, 4 s cap).
- The provider's `Retry-After` / `retry-after-ms` is honoured as a minimum wait; a wait longer than 10 s is not
  retried (a visitor will not wait that long).
- No retry starts unless at least 3 s of the 50 s turn deadline remain after the wait.
- Never retried: authentication/permission errors, invalid requests (unknown model, unsupported setting), exhausted
  quota or spend limits (429 with `insufficient_quota` / `*_spend_limit_exceeded` / `credit_balance_exhausted`),
  content-policy blocks, aborts. OpenAI's guidance: "Don't retry quota, billing, or other errors that require you to
  take action" (<https://developers.openai.com/api/docs/guides/rate-limits>).
- A response whose text the visitor already saw is never repeated; tool side effects are never inside a retried
  call (tools run after a model round completes).
- The OpenAI SDK's own retries are disabled (`maxRetries: 0`): it would retry every 429 including quota errors,
  ignores the turn deadline and is invisible to our logs.
- Provider failover (another provider for the same tier) would plug into the retry layer as an ordered list of
  routes. It is deliberately not implemented while one provider is configured.

### Realtime voice: `gpt-live-1.1` (Phase 2 developer lab implemented; not yet live-validated)

Verified: `gpt-live-1.1` (and `gpt-live-1`) are **GPT-Live API** models (`POST /v1/live/sessions`, sideband WebSocket
`/v1/live/sessions/{id}/attach`, WebRTC / WebSocket / SIP transports). They are not available on the Realtime API
(`/v1/realtime`), Responses or Chat Completions (<https://developers.openai.com/api/docs/models/gpt-live-1.1>).

- Billing: **per second — $0.05 per active minute, $0.02 per standby minute**; creating a WebRTC session bills 15 s
  up front (credited later). Backend ("delegation") model tokens and input transcription are billed separately.
- Delegation: either OpenAI runs a backend Responses model whose **function tools still execute in our app**, or our
  own agent answers through commentary appends ("client delegation"). Phase 2 selects **Responses delegation**
  (`AI_VOICE_DELEGATION=responses`), provisionally until live latency/cost measurements confirm it (VOICE_QUALITY.md):
  OpenAI's recommended, managed tool loop with pre-warmed backend connections, the cheap text model as backend
  (`AI_VOICE_DELEGATION_MODEL`, default `AI_TEXT_MODEL`), backend tokens reported per response
  (`response.completed`) and metered as `voice_delegation`. Client delegation remains a switch for the comparison
  only. Either way the existing tool executor is the only place side effects happen.
- Session configuration is pinned at creation (model, instructions, audio) and cannot be changed by the browser: the
  browser data channel may only send `session.close` and input mute/unmute (`client.data_channel` allowlists).
- Standby: after `idle_timeout_s` (`VOICE_IDLE_TIMEOUT_SECONDS`, 20) without speech the session drops to the standby
  rate; speech wakes it (`wake_policy: speech`).
- Documented: full duplex, 28 voices, languages en/pt/es/de/fr/hi/ja/ko, idle timeout 5–60 s, close reasons.
  Not documented for GPT-Live: turn-detection/eagerness knobs, noise-reduction settings, transcription model choice.
- Telephone: GPT-Live supports SIP natively (inbound via `live.transport.incoming` + accept/reject/refer/hang up,
  outbound via `POST /v1/live/sessions` with a SIP transport), with carrier trunks such as Twilio. The Realtime API
  (`gpt-realtime-2.1`) is no longer needed as a telephony fallback; it is not used.
- A sequential STT → text model → TTS pipeline and browser SpeechRecognition/SpeechSynthesis are **not** the primary
  production voice architecture. An "economy voice" mode may be benchmarked in Phase 8 against VOICE_QUALITY.md.

Voice quality targets and their measurement: VOICE_QUALITY.md. Architecture: ARCHITECTURE.md §18.

### Embeddings: `text-embedding-3-small`

1536 dimensions (the `vector(1536)` column); $0.02 per 1M tokens. Changing the model requires
`npm run knowledge:reembed`; another dimension requires a migration.

## Prices (USD per 1M tokens, Standard tier, short context ≤ 272K input tokens)

Interactive chat and voice run on the **Standard** tier. Batch and Flex are **discounted** asynchronous tiers that do
not apply to interactive traffic (an earlier version of this document quoted the Batch/Flex rates for `gpt-6-luna`
as if they were standard; that was wrong).

| Model | Tier | Input | Cached input | Cache write (30 min) | Output |
| --- | --- | ---: | ---: | ---: | ---: |
| gpt-6-luna | **Standard** | 0.10 | 0.01 | 0.125 | 0.50 |
| gpt-6-luna | Batch / Flex (discounted) | 0.05 | 0.005 | 0.0625 | 0.25 |
| gpt-6-luna | Fast (formerly Priority) | 0.20 | 0.02 | 0.25 | 1.00 |
| gpt-6.2-sol | **Standard** | 2.00 | 0.10 | 2.50 | 10.00 |
| gpt-6.2-sol | Batch (discounted; no Flex) | 1.00 | 0.05 | 1.25 | 5.00 |
| gpt-6-sol | **Standard** | 2.00 | 0.20 | 2.50 | 10.00 |
| text-embedding-3-small | **Standard** | 0.02 | — | — | — |

| Voice / telephony (for Phase 2+ planning) | Price | Source date |
| --- | --- | --- |
| gpt-live-1.1 session | $0.05/min active, $0.02/min standby (+ backend tokens) | 2026-11-26 |
| Twilio Elastic SIP origination, US local / toll-free | $0.0034 / $0.013 per min | Twilio, "current as of October 2026" |
| Twilio US local number | $1.15 per month | same |
| Twilio US SMS (long code) | $0.0083 per segment + carrier fees; A2P 10DLC registration required | Twilio, November 2026 |

Above 272K input tokens requests bill at long-context rates (about 2× input, 1.5× output); the context budgets keep
requests far below that. The built-in snapshot lives in `src/server/config/pricing.ts` (`PRICING_SNAPSHOT_DATE`);
`AI_MODEL_PRICING_JSON` overrides or extends it.

Cost optimization to evaluate with live data (not implemented): GPT-6.2 models bill top-level `instructions` at the
uncached rate on every request; OpenAI recommends putting the stable prompt in the first developer message instead.
This matters only for escalated calls (rare) and is a Phase 8 measured optimization.

## Estimated vs provider-confirmed cost

- `usage_records.estimated_cost_usd` is an **estimate** from provider-reported token counts and the configured price
  list; `pricing_version` records which list. It is never shown or treated as billing.
- The Responses API returns no per-request cost. Provider-confirmed costs exist only in OpenAI's Organization Costs
  API (`GET /v1/organization/costs`): daily buckets, grouped by project, API key or line item, admin key required,
  no documented latency. Attributing confirmed cost to a tenant therefore needs either a project/key per tenant or
  proportional allocation by our usage records. Importing confirmed costs into a separate table and reconciling them
  with estimates is a Phase 7 task.

## Runtime cost controls

All limits are configuration; organization overrides live in `app_private.organization_limits` (platform operator
only; tenants cannot change their own limits).

| Control | Setting (default) | Behaviour when reached |
| --- | --- | --- |
| Daily estimated AI spend per organization (UTC day) | `AI_ORG_DAILY_SPEND_LIMIT_USD` (10) | Provider call refused before it is made; visitor told the assistant cannot reply; `usage.limit.enforced` logged |
| Monthly estimated AI spend per organization | `AI_ORG_MONTHLY_SPEND_LIMIT_USD` (150) | Same |
| A limit of 0 | — | Blocks every AI call (kill switch), priced or not |
| Model rounds per turn | `AI_MAX_TOOL_ROUNDS` (4) | Final round must answer in text |
| Tool calls executed per turn | `AI_MAX_TOOL_CALLS_PER_TURN` (6) | Further calls refused and audited as rejected runs; next round must answer |
| Provider-reported tokens per turn | `AI_MAX_TURN_TOKENS` (40,000) | No further round; a safe fallback completes the reply |
| Output tokens per call | `AI_MAX_OUTPUT_TOKENS` (800) | Provider cap |
| Visitor messages per conversation | `AI_MAX_CONVERSATION_TURNS` (100) | New messages refused ("start a new chat"); nothing persisted |
| Premium-model calls per conversation | `AI_MAX_ESCALATED_CALLS_PER_CONVERSATION` (6) | Escalation declined; default model continues |
| Requests per client / widget / organization per minute | `RATE_LIMIT_*` (20 / 120 / 300) | HTTP 429 with Retry-After |
| Simultaneous voice sessions per organization | `VOICE_MAX_CONCURRENT_SESSIONS` (2), lowered by `max_concurrent_voice_sessions` | New session refused before the provider is called (gateway 409) |
| Voice session starts per organization per minute | `VOICE_SESSION_STARTS_PER_MINUTE` (6) | Start refused before the provider is called (each creation is billed) |
| Voice session length | `VOICE_MAX_SESSION_SECONDS` (600), lowered by `max_voice_session_seconds` | Session closed at the limit |
| Voice silence | 120 s without any speech | Session closed (abandoned tab) |
| Voice session spend | Whole maximum length reserved up front, priced as active, plus `VOICE_DELEGATED_TEXT_RESERVE_PER_MINUTE_USD` (0.01) per minute | Session refused when the reservation does not fit the daily/monthly limit |

**Concurrency-safe reservations** (`src/server/domain/usage/limits.ts`): before each provider call (chat round,
summary, embedding batch) the runtime reserves a conservative estimate of the call's cost: input over-estimated at
about 2 characters per token and priced at the dearer of the uncached and cache-write rates, plus the full output cap.
One reservation covers the call's retries; an attempt that fails without usage being reported is not metered, so the
estimate is conservative rather than a strict upper bound. The reservation is granted only if today's and this month's estimated spend plus every in-flight
reservation stay within the limits. Reservations for one organization are serialized by a transaction-scoped
advisory lock (works through the Supavisor transaction pooler), so concurrent requests on any number of instances
cannot overshoot together. Spend comes from `app_private.usage_daily_totals`, maintained by a trigger on every
usage record; after the call its real usage is recorded and the reservation deleted; a crashed worker's
reservation expires after 180 s. A model without a configured price reserves 0 (only a 0 limit blocks it): startup
logs `usage.pricing_missing` (error) for any configured model without a price, and each unpriced call logs
`usage.pricing_unknown` once — configure prices for every model in use. When the limit refuses an escalation, the turn
continues on the default model (`ai.route.escalation_declined`) rather than failing.

**Voice sessions** reserve their worst case for the session's lifetime (TTL: maximum length + 120 s) and release
it when the gateway settles the session with provider-reported seconds (or, after a crash or lost sideband, elapsed
time priced as active). Delegated-model tokens are recorded per backend response while the session runs. A session
that ends before its reservation is settled can therefore never overshoot the limit; a gateway crash leaves the
reservation to expire and the session to be settled by the stale-session sweep.

**Designed for later limits**: the reservation table's `resource` column and the limits table take concurrent calls
and SMS segments in Phases 3–4 without a new mechanism.

## Provider boundaries

Implemented: `TextModelProvider`, `EmbeddingProvider` (contracts in `src/server/ai/types.ts`; OpenAI adapters in
`src/server/ai/openai/`), `RealtimeVoiceProvider` (`src/server/ai/voice-types.ts`; GPT-Live adapter
`src/server/ai/openai/live-provider.ts`), `ProviderError` normalization, `ModelRouter`, retry policy. Added when
their phase needs them (no speculative interfaces): `TelephonyCarrier` (Phase 3), an SMS sender (Phase 4). Domain services never depend on provider SDK types; adapters translate provider-native events into
domain events.

## Environment configuration

See `.env.example` for the full annotated list. AI-related variables:

```env
AI_TEXT_PROVIDER=openai
AI_TEXT_MODEL=gpt-6-luna
AI_TEXT_REASONING_EFFORT=low
AI_ESCALATION_PROVIDER=openai
AI_ESCALATION_MODEL=gpt-6.2-sol
AI_ESCALATION_REASONING_EFFORT=medium
AI_ESCALATION_ENABLED=true
AI_EMBEDDING_PROVIDER=openai
AI_EMBEDDING_MODEL=text-embedding-3-small
AI_EMBEDDING_DIMENSIONS=1536

AI_MAX_RETRIEVED_CHUNKS=5
AI_MAX_RETRIEVED_TOKENS=1800
AI_MAX_RECENT_MESSAGES=12
AI_MIN_RETRIEVAL_SIMILARITY=0.3
AI_MAX_OUTPUT_TOKENS=800
AI_MAX_TOOL_ROUNDS=4
AI_REQUEST_TIMEOUT_MS=30000
AI_PROVIDER_MAX_RETRIES=2

AI_MAX_TOOL_CALLS_PER_TURN=6
AI_MAX_TURN_TOKENS=40000
AI_MAX_CONVERSATION_TURNS=100
AI_MAX_ESCALATED_CALLS_PER_CONVERSATION=6
AI_ORG_DAILY_SPEND_LIMIT_USD=10
AI_ORG_MONTHLY_SPEND_LIMIT_USD=150
# AI_PRICING_VERSION=2026-11-26
# AI_MODEL_PRICING_JSON={"model-id":{"inputPerMTok":0.1,"cachedInputPerMTok":0.01,"cacheWritePerMTok":0.125,"outputPerMTok":0.5}}

# Realtime voice (Phase 2; read by the voice gateway and the voice lab)
AI_VOICE_PROVIDER=openai
AI_VOICE_MODEL=gpt-live-1.1
AI_VOICE_NAME=marin
AI_VOICE_DELEGATION=responses
# AI_VOICE_DELEGATION_MODEL=        (default: AI_TEXT_MODEL)
VOICE_MAX_SESSION_SECONDS=600
VOICE_MAX_CONCURRENT_SESSIONS=2
VOICE_SESSION_STARTS_PER_MINUTE=6
VOICE_IDLE_TIMEOUT_SECONDS=20
VOICE_DELEGATED_TEXT_RESERVE_PER_MINUTE_USD=0.01
VOICE_GATEWAY_URL=http://127.0.0.1:4100
VOICE_GATEWAY_PORT=4100
# VOICE_GATEWAY_SECRET=             (≥ 32 random characters, shared by the app and the gateway)
VOICE_DEV_ENABLED=false
# Voice prices are per minute: AI_MODEL_PRICING_JSON={"gpt-live-1.1":{"activePerMinute":0.05,"standbyPerMinute":0.02}}
```

## Context budgeting

Every model request is assembled from bounded parts (`src/server/agent/context/assembler.ts`):

- stable, concise developer instructions first (cache-friendly), then per-turn facts (business name/description,
  local time);
- the rolling summary as a labelled **user-role** context message, never in the developer instructions — it derives
  from visitor messages, and OpenAI's guidance is to keep untrusted input out of developer messages
  (<https://developers.openai.com/api/docs/guides/agent-builder-safety>);
- every message the summary does not cover yet (bounded window + the current message);
- retrieved knowledge only through `searchKnowledge`: 3–5 chunks, relevance threshold, token cap, framed as facts
  that are never instructions;
- only the tools available to this agent on this channel.

Avoid: whole websites or knowledge bases in the prompt, full transcripts, every tool definition, large tool-result
blobs, premium models for summaries/classification.

## Conversation memory

Recent messages + a compact rolling summary (cheap model, attributed statements: "The visitor said …"; never records
an action as done unless the assistant said so) + durable structured facts in their own tables (contacts, leads,
later callbacks/appointments). The LLM transcript is never the database.

## RAG

Deterministic business facts are structured data (profile, hours). Vector retrieval is for unstructured content:
normalize the query, exact tenant-scoped nearest-neighbour search filtered by organization, agent and embedding
model, relevance threshold, top-K and token cap; insufficient evidence means "I don't have that information", never
an invented answer.

## Usage metering and observability

`usage_records` per provider call: organization, agent, conversation, purpose, provider, model (as reported),
input / cached / cache-write / output / reasoning tokens, tool calls, duration, estimated cost, `pricing_known`,
`pricing_version`, and metadata `{tier, round, route, attempts, firstTokenMs}`. Voice sessions add one
`voice_session` record per session (active and standby seconds, `usageSource` provider|estimated) and
`voice_delegation` text records for backend tokens; telephony minutes join in Phase 3.

Structured log events (JSON, secrets and customer text redacted) use one naming convention, `<area>.<subject>.<event>`,
with shared fields (`organizationId`, `agentId`, `conversationId`, `channel`, `turnId`, `provider`, `model`, `tier`,
`route`):

| Event | Key fields |
| --- | --- |
| `ai.route.selected` / `ai.route.escalated` | tier, route reason, trigger |
| `ai.call.retry` | retry, delayMs, code, status, retryAfterMs |
| `ai.call.completed` | round, attempts, finishReason, durationMs, firstTokenMs, input/cached/output/reasoning tokens, toolCalls, estimatedCostUsd, pricingKnown |
| `ai.call.failed` | code, status, retryable, attempts, streamed (error level for auth/config/quota = alertable) |
| `agent.turn.finished` | outcome, latencyMs, firstTokenMs, modelCalls, retries, toolCalls, tokens, estimatedCostUsd, escalation |
| `agent.tool.*` | toolName, toolRunId, outcome (durations also in `tool_runs.duration_ms`) |
| `usage.limit.enforced` | resource, scope, limit, used/spent |

Voice sessions reuse the same fields with `voiceSessionId` and add `voice.session.started`, `voice.session.ended`
(status, reason, active/standby seconds, usage source, cost, tool calls, interruptions, delegated turns),
`voice.session.{start_failed,max_duration,silence,settle_failed}`, `voice.tool.*`, `voice.delegation.*`,
`voice.provider.error`, `voice.sideband.disconnected`, `voice.recovery.*` and `voice.gateway.*`; telephony adds `telephony.*` in Phase 3 (ARCHITECTURE.md §17).

## Rough runtime economics (Standard prices, 2026-11-26)

Text is unlikely to be the main cost. 10,000 chat conversations × 2,000 input + 300 output tokens on `gpt-6-luna`:
20M input × $0.10 + 3M output × $0.50 ≈ **$3.50** (less with prompt caching).

Voice is material: 1,000 active minutes on `gpt-live-1.1` ≈ **$50** for the sessions, plus backend tokens
(small with Luna), plus Twilio (≈ $3.40 per 1,000 local SIP-origination minutes plus numbers). Optimize voice minutes
and call handling quality before chat-token pennies. These are list-price estimates, not measured costs; Phase 2
measures real cost per minute (VOICE_QUALITY.md).

## Quality-first routing rule

Cheap does not mean lowest headline price. A model that misunderstands callers, calls the wrong tool, books
incorrectly, fails to transfer or adds latency can cost more in lost business than it saves in tokens. Ship cheap
default text + high-quality realtime voice, instrument everything, then benchmark alternatives with real calls and
the VOICE_QUALITY.md methodology.
