# Syncore AI Receptionist — Implementation Plan

Work phase-by-phase. Do not start a later phase before acceptance criteria for the current phase pass.

## Phase 0 — Foundation
Goal: create the standalone repository and stable domain seams.

Build:
- Next.js/TypeScript project
- lint/typecheck/test setup
- Supabase client/server helpers
- env validation
- domain folder structure
- provider interfaces
- tool registry interfaces
- database migrations for organizations, members, agents, profiles/hours
- auth and organization membership
- basic seed/demo organization
- usage/audit foundations

Acceptance:
- app builds
- strict TS passes
- authenticated user can belong to organization
- tenant isolation test exists
- no AI call required yet

## Phase 1 — First vertical slice: web chat
Goal:
`organization -> agent config -> knowledge -> chat -> tools -> persisted conversation`

Build:
- business profile/hours
- agents
- knowledge source/text ingestion
- chunking/embeddings/pgvector
- `searchKnowledge`
- `getBusinessInfo`
- `getBusinessHours`
- contacts/leads
- `captureLead`
- conversations/messages
- cheap text provider adapter
- ModelRouter
- public embeddable/basic chat widget
- streaming
- usage metering

Acceptance scenarios:
1. visitor asks an answer present in knowledge and receives grounded answer;
2. visitor asks unknown question and agent does not invent;
3. visitor gives name/phone and agent captures lead via tool;
4. refresh/reopen preserves conversation as designed;
5. one tenant cannot retrieve another tenant's knowledge;
6. provider/model can be changed through configuration.

## Phase 2 — Callback and SMS
Build:
- callback requests
- `createCallbackRequest`
- Twilio adapter
- `sendSMS`
- idempotency
- webhook signature verification where relevant
- tool audit UI

Acceptance:
- duplicate webhook/action does not create duplicate callback
- only configured org/agent can send approved SMS
- all tool outcomes visible in conversation/audit records

## Phase 3 — Inbound phone MVP
Build:
- Twilio number configuration
- telephony carrier adapter
- OpenAI realtime/live voice adapter
- inbound phone routing
- server call/session state
- transcript/event persistence
- backend tool delegation
- `transferCall`
- transfer allowlist
- transfer failure -> callback fallback
- voice usage metering

Acceptance:
1. real phone number answers;
2. caller can ask knowledge question;
3. caller can provide lead details;
4. caller can request callback;
5. caller can request human and be transferred;
6. failed transfer falls back safely;
7. call/transcript/outcome appear in dashboard.

## Phase 4 — Web voice
Build:
- browser realtime voice
- ephemeral session setup
- barge-in/interruption
- same agent/tools as chat/phone
- voice UI state machine

Acceptance:
- same knowledge/tool behavior as phone
- no permanent provider secret in browser
- interruption works
- session cleans up fully

## Phase 5 — Product dashboard
Build only after core flows work:
- Overview
- Agents
- Calls
- Conversations
- Contacts/Leads
- Knowledge
- Phone numbers
- Settings
- usage/cost visibility

Keep analytics operational, not decorative.

## Phase 6 — Hardening
- load/concurrency tests
- retries/timeouts
- provider outage behavior
- prompt injection tests
- tool abuse tests
- PII/log review
- retention settings
- export/delete paths
- call quality test suite
- synthetic conversations
- monitoring/alerts

## Phase 7 — Vertical templates
After general platform is stable:
- HVAC
- plumbing
- restoration
- logistics
- others

Templates configure:
- instructions
- business fields
- tool availability
- qualification schema
- test scenarios

They do not fork the core platform.

## Phase 8 — Optional cost optimization
Only after real usage data exists:
- compare realtime voice providers
- prototype economy STT -> text LLM -> TTS pipeline
- evaluate cheaper embedding provider
- prompt caching
- retrieval/reranking optimization
- model escalation thresholds

Measure:
- task completion
- latency
- transfer success
- hallucination/error rate
- cost per resolved conversation
- cost per booked/qualified lead

Do not optimize solely for lowest per-token cost.
