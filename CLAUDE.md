# Syncore AI Receptionist — Permanent Engineering Rules

## Product
Syncore AI Receptionist is an industry-neutral, multi-tenant AI front-office platform. Vertical templates (HVAC,
logistics, legal, dental, auto repair, …) come later without forking the core.

The same agent configuration, business data, knowledge, contacts, conversations, domain services, tools and usage
metering power every channel:
- inbound phone receptionist (primary commercial product)
- realtime website voice (target: ChatGPT Live Voice-like quality)
- website text chat (implemented)
- consent-based outbound calls for approved workflows

Priorities: conversational quality, business-action correctness, reliability, low latency, security, operating cost —
over feature count.

## Core principles
1. PostgreSQL/Supabase is the source of truth. Browser state is never the source of truth for business records.
2. Every tenant-owned record is scoped by `organization_id` (composite tenant foreign keys, RLS).
3. Use strict TypeScript and Zod at every boundary.
4. Server-side authorization plus Supabase RLS; the service scope always filters by organization.
5. Never expose provider secrets in the browser.
6. AI models never mutate the database directly.
7. All side effects go through validated server-side tools.
8. A model must never claim an action succeeded until the tool returns success; unknown outcomes are reported as
   unconfirmed and never retried blindly (durable operation records for external side effects).
9. Channels contain no business logic. Chat, voice and phone reuse the same domain services, tool registry and
   executor — voice gets no separate business-logic engine.
10. No single AI provider in the domain layer; providers stay replaceable behind adapters.
11. Prefer the cheapest model that meets quality and latency needs. Escalate to a stronger model only for
    demonstrated complexity or model-quality failure — never because a provider is unavailable.
12. Retry only retryable provider failures, on the same model, bounded, honouring Retry-After and deadlines. Never
    retry partially delivered responses or committed side effects.
13. Never send the whole knowledge base or unlimited history to a model. Untrusted text (visitor input, knowledge,
    tool results, summaries) never goes into developer instructions.
14. Production requires verified database TLS.
15. No speculative abstractions or future features without a current use case. No Redis unless PostgreSQL
    demonstrably cannot meet a requirement.
16. Do not use GoHighLevel, Retell, Vapi or n8n as core dependencies.
17. Twilio is the initial telephony/SMS carrier, behind a service boundary.
18. OpenAI is the initial AI provider; text, voice and embedding providers remain replaceable.
19. Voice uses native realtime speech-to-speech (WebRTC in the browser, SIP for phones), not browser
    SpeechRecognition/SpeechSynthesis or a sequential STT → LLM → TTS pipeline as the primary architecture.
20. Mock tests are never evidence of voice quality or live behaviour; claims need recorded evidence.
21. Run typecheck, lint, tests and production build before calling a phase complete.
22. Do not implement later phases unless explicitly requested.

## Runtime cost rules
- Models are configuration (`AI_*` env), never scattered through the code. Initial: routine text `gpt-6-luna`;
  escalation `gpt-6.2-sol`; realtime voice `gpt-live-1.1` (GPT-Live API, per-minute billing); embeddings
  `text-embedding-3-small`. Verify identifiers, capabilities and prices against official docs before relying on them.
- Every provider call is metered (tokens, later voice seconds) with an estimated, dated cost, and reserved against
  per-organization spend limits first. Estimates are never presented as provider billing.
- Keep stable instructions concise; retrieve the fewest useful chunks; summarize long conversations.

## Phases
0 foundation ✓ · 1 web chat + knowledge/tools ✓ · 1.5 hardening + live validation (code ✓, live runs pending) ·
2 shared realtime voice engine + browser voice POC · 3 inbound phone, callbacks, human transfer · 4 booking, SMS,
conversion workflows · 5 production web voice widget · 6 consent-based outbound calls · 7 commercial readiness ·
8 industry templates + measured cost optimization.

Read `PRODUCT_SPEC.md`, `ARCHITECTURE.md`, `AI_RUNTIME.md`, `IMPLEMENTATION_PLAN.md`, `VOICE_QUALITY.md` and
`LIVE_VALIDATION.md` before implementing product work.
