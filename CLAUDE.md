# Syncore AI Receptionist — Permanent Engineering Rules

## Product
Syncore AI Receptionist is a general, multi-tenant AI communications platform. It starts industry-neutral and will later support vertical templates such as HVAC, logistics, legal, dental, auto repair, and others.

The same agent configuration and business data must power:
- web text chat
- web voice
- inbound phone calls
- later: approved outbound workflows

## Core principles
1. PostgreSQL/Supabase is the source of truth. Browser state is never the source of truth for business records.
2. Every tenant-owned record is scoped by `organization_id`.
3. Use strict TypeScript.
4. Use server-side authorization and Supabase RLS where appropriate.
5. Never expose provider secrets in the browser.
6. AI models never mutate the database directly.
7. All side effects go through validated server-side tools.
8. Tool inputs use Zod validation.
9. A model must never claim an action succeeded until the tool returns success.
10. Channels must not contain business logic. Chat, voice, and phone reuse the same domain services and tool registry.
11. Do not hard-code a single AI provider into the domain layer.
12. Prefer the cheapest model that satisfies quality and latency requirements.
13. Stronger models may be used only through an explicit escalation policy.
14. Never send the entire knowledge base or unlimited conversation history to a model.
15. Do not build speculative abstractions or future features without a current use case.
16. Do not use GoHighLevel, Retell, Vapi, or n8n as core platform dependencies.
17. Twilio is the initial telephony/SMS carrier, but carrier-specific logic must stay behind a service boundary.
18. OpenAI is the initial production AI provider, but text/voice/embedding providers must remain replaceable.
19. Run typecheck, lint, tests, and production build before calling a phase complete.
20. Do not implement later phases unless explicitly requested.

## Runtime cost rules
- Routine text/chat/tool-selection model: low-cost model configured by env, initially `gpt-6-luna`.
- Complex escalation model: configured separately, initially `gpt-6-sol`.
- Realtime voice: provider configured by env, initially `gpt-live-1`.
- Embeddings: initially `text-embedding-3-small`.
- Model names must live in configuration/env, never be scattered through the codebase.
- Track token usage, voice duration, provider cost estimates, and tool execution counts per organization.
- Keep stable system instructions concise.
- Retrieve only the smallest useful number of knowledge chunks.
- Summarize long conversations instead of repeatedly sending full history.

Read `PRODUCT_SPEC.md`, `ARCHITECTURE.md`, `AI_RUNTIME.md`, and `IMPLEMENTATION_PLAN.md` before implementing product work.
