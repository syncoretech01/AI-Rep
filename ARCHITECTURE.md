# Syncore AI Receptionist — Architecture

## 1. Architectural goal
Build one multi-tenant agent platform with multiple communication channels.

The domain layer owns:
- business configuration
- knowledge retrieval
- contacts/leads
- callbacks
- tools/actions
- conversations
- usage/audit data

Channels only adapt transport/provider events into the domain.

## 2. High-level architecture

```text
                         Syncore Agent Core
                  ┌─────────────────────────────┐
                  │ Agent configuration         │
                  │ Business profile/hours      │
                  │ Context assembler           │
                  │ Knowledge retrieval         │
                  │ Tool registry               │
                  │ Guardrails                  │
                  │ Contacts/leads              │
                  │ Conversation persistence    │
                  └──────────────┬──────────────┘
                                 │
          ┌──────────────────────┼──────────────────────┐
          │                      │                      │
      WEB CHAT               WEB VOICE               PHONE
          │                      │                      │
   TextModelProvider      RealtimeVoiceProvider   TelephonyCarrier
          │                      │                      │
          └──────────────────────┼──────────────────────┘
                                 │
                           Server Tools
                                 │
             ┌───────────────────┼────────────────────┐
             │                   │                    │
        PostgreSQL/RAG       SMS/Telephony       External APIs later
```

## 3. Initial stack
- Next.js 16 App Router
- TypeScript strict
- React
- Tailwind
- Supabase/PostgreSQL
- Supabase Auth
- Supabase Storage
- pgvector
- Zod
- Twilio for phone/SMS
- OpenAI default text/voice/embedding adapters
- Sentry or equivalent structured error monitoring
- Vercel or suitable Node hosting for web app
- a separate long-lived service only if required by realtime/server-side voice transports

Do not force realtime voice workloads into short-lived request handlers when the provider requires persistent connections.

## 4. Provider abstraction
Conceptually reuse the good separation from `syncoretech01/Waseem-Jewellers`:
- provider interface
- provider runtime
- typed provider/domain events
- centralized tool definitions
- controller/state machine for browser UI

Do not reuse jewellery-specific tools or browser state as business truth.

Recommended interfaces:

```ts
interface TextModelProvider {
  generate(request: TextGenerationRequest): Promise<TextGenerationResult>;
  stream?(request: TextGenerationRequest): AsyncIterable<TextStreamEvent>;
}

interface RealtimeVoiceProvider {
  createSession(config: VoiceSessionConfig): Promise<VoiceSession>;
}

interface EmbeddingProvider {
  embed(input: string[]): Promise<number[][]>;
}

interface TelephonyCarrier {
  provisionNumber(...args: unknown[]): Promise<unknown>;
  sendSms(...args: unknown[]): Promise<unknown>;
  transferCall(...args: unknown[]): Promise<unknown>;
}
```

Domain code must not import provider-native response types.

## 5. Channel architecture

### Web chat
Flow:
`widget -> authenticated/public chat API -> AgentService -> context -> cheap text model -> tool calls -> persisted response`

Requirements:
- public widget key maps to enabled agent
- rate limiting
- streaming
- server-controlled tools
- conversation persistence
- no provider secret in client

### Web voice
Flow:
`browser WebRTC -> RealtimeVoiceProvider -> sideband/backend tool execution`

Requirements:
- ephemeral/session credentials created server-side
- interruptible
- transcript/events persisted
- tools executed on server
- never trust browser-provided tenant identity without server lookup

### Phone
Initial preferred flow:
`PSTN -> Twilio -> SIP/realtime voice provider -> backend sideband/tools`

For the initial OpenAI implementation:
- use provider-supported SIP path where practical;
- keep backend connected for tools/session events;
- persist call state independently of any admin browser.

Do not model telephone call state in Zustand.

## 6. Browser UI architecture
The Waseem Concierge pattern can inform:
- `AgentController`
- typed events
- Zustand UI state machine
- provider-neutral browser components

Browser UI states may include:
`IDLE -> OPENING -> READY -> LISTENING/THINKING -> TOOL -> SPEAKING -> RESULT/ERROR`

This state is presentation-only.

## 7. Server call state
Server call states:
- `initiated`
- `ringing`
- `connected`
- `active`
- `transferring`
- `completed`
- `failed`

Persist external call/session IDs and timestamps.

## 8. Tool system
Tools are server-side capabilities, not model privileges.

Each tool definition contains:
- stable name
- description
- Zod input schema
- channel availability
- permission requirements
- idempotency strategy
- handler

Execution pipeline:

```text
model requests tool
-> lookup tool
-> validate arguments
-> resolve organization/agent authorization
-> create tool_run
-> execute domain service
-> persist outcome
-> return minimal structured result
```

Initial tools:
- searchKnowledge
- getBusinessInfo
- getBusinessHours
- captureLead
- updateContact
- createCallbackRequest
- sendSMS
- transferCall

## 9. Multi-tenant data model

### Identity/tenant
- `organizations`
- `organization_members`
- `users` via auth provider

### Agent/config
- `agents`
- `agent_channels`
- `business_profiles`
- `business_hours`
- `phone_numbers`

### Knowledge
- `knowledge_sources`
- `knowledge_documents`
- `knowledge_chunks`

### CRM-lite domain
- `contacts`
- `leads`
- `callback_requests`

### Conversation
- `conversations`
- `messages`
- `calls`
- `call_events`

### Operations
- `tool_runs`
- `integrations`
- `usage_records`
- `audit_logs`

All tenant-owned tables include `organization_id`.
Most agent-owned records also include `agent_id`.

Use UUID primary keys unless a compelling reason exists otherwise.

## 10. Conversation model
`conversations` is channel-neutral.

A conversation has:
- organization
- agent
- channel
- contact if known
- status
- rolling summary
- timestamps

A phone call references a conversation.

Messages may represent:
- customer/user text
- assistant text
- tool call
- tool result
- system/event metadata where necessary

Do not store huge provider-native payloads in the main message table; use a JSON event/audit field or separate raw-event storage where needed.

## 11. Knowledge architecture
Structured business facts live in structured tables.

Unstructured knowledge:
`source -> document -> normalized text -> chunks -> embedding -> pgvector`

Retrieval:
- organization + agent scoping
- relevance threshold
- top K cap
- token cap
- metadata filters

A knowledge answer must be based on retrieved material or explicitly say it does not know.

## 12. Context assembler
Create one server `ContextAssembler` used by text and voice backend delegation.

It assembles:
- concise agent behavior
- relevant structured business facts
- recent conversation turns
- rolling summary
- retrieved chunks
- allowed tools
- channel-specific behavior

Enforce budgets defined in `AI_RUNTIME.md`.

## 13. Model routing
Create `ModelRouter`.

Inputs may include:
- task type
- channel
- complexity
- latency requirement
- prior failure
- organization plan/settings

Default:
- routine text -> cheap model
- complex retry/escalation -> strong model
- realtime speech -> realtime voice model

The router selects configuration, not domain behavior.

## 14. Security
- server-only secrets
- RLS and server authorization
- verify Twilio/provider webhooks
- signed public widget tokens/keys
- rate limits by IP/widget/org
- redact sensitive values from logs
- do not allow arbitrary model-selected URLs
- explicit allowlists for transfer destinations
- encrypted integration credentials
- audit all tools with side effects

## 15. Human transfer
A caller may request a person at any time.

Rules:
- transfer only to an organization-configured allowed destination
- persist transfer attempt
- if transfer fails, offer callback/message
- never invent that a person answered
- channel logic requests `transferCall`; carrier adapter performs it

## 16. Cost observability
Every model and voice adapter must return normalized usage where available.

Persist to `usage_records`:
- provider/model
- units/tokens/seconds
- estimated cost
- organization/agent/conversation/call

Do not mix billing logic into provider adapters; adapters report usage, a cost service calculates estimates.

## 17. What not to over-engineer in V1
Do not build:
- generic workflow engine
- plugin marketplace
- provider marketplace UI
- event sourcing architecture
- Kafka
- microservices by default
- custom CRM
- custom scheduler
- massive analytics warehouse

A modular monolith is preferred initially.

## 18. Waseem-Jewellers reuse guidance
Conceptually reuse:
- `ConciergeProvider` -> provider abstraction
- `ProviderRuntime` -> runtime/tool execution seam
- `ProviderEvent` -> typed event vocabulary
- `toolDefs.ts` -> centralized tools
- `ConciergeController` -> browser controller pattern
- Zustand state machine -> browser UI state only

Do not reuse:
- jewellery catalogue tools
- site-navigation actions
- mock command parser
- `sessionStorage` business persistence
- browser-only tool execution for business actions
- old future-realtime assumptions without checking current provider docs
