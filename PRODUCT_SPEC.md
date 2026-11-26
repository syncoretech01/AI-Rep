# Syncore AI Receptionist — Product Specification

Revised 2026-11-26. This document states what the product is and why. Related documents:

| Topic | Document |
| --- | --- |
| Permanent engineering rules | [CLAUDE.md](CLAUDE.md) |
| System design | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Models, routing, cost controls | [AI_RUNTIME.md](AI_RUNTIME.md) |
| Phase order and acceptance criteria | [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) |
| Voice quality targets and measurement method | [VOICE_QUALITY.md](VOICE_QUALITY.md) |
| Checks against live Supabase and OpenAI | [LIVE_VALIDATION.md](LIVE_VALIDATION.md) |

Provider facts below were checked against official documentation on 2026-11-26 (see [Sources](#sources)). Prices and
limits change; nothing here is a quote or a measured result.

## 1. Product

Syncore AI Receptionist is an industry-neutral, multi-tenant AI front-office platform. A business (a tenant) configures
its business once — profile, hours, knowledge, lead capture, the actions it allows — and that one configuration serves
its customers on four channels:

| # | Channel | Role | Status |
| --- | --- | --- | --- |
| 1 | Inbound telephone receptionist | Primary commercial product | Planned — pilot in Phase 3; general availability after the telephone voice-quality gates (Phase 7) |
| 2 | Website live voice | Realtime spoken conversation on the tenant's website; quality target comparable to ChatGPT's live voice mode | Planned — engine and dev-only proof of concept in Phase 2, production widget in Phase 5 |
| 3 | Website text chat | Embeddable chat widget | Implemented — Phase 1, hardened in Phase 1.5 |
| 4 | Outbound calling agent | Calls for approved, consent-based workflows only | Planned — Phase 6 |

The product must be useful to any business before any industry customization. Industry templates (HVAC, logistics,
legal, dental, auto repair and others) come later as configuration on top of the same core, never as forks (Phase 8).

### 1.1 Users

| User | Description |
| --- | --- |
| Tenant member | Owner, admin or member of an organization (roles exist today). Configures agents, reviews conversations, leads and, later, calls and actions. |
| Tenant's customer | Website visitor, caller, or outbound-call recipient. Never needs an account. |
| Platform operator | Syncore. Operates the platform, sets per-tenant limits, approves outbound workflow templates. |

### 1.2 Priorities

When goals conflict, these win over feature count:

1. **Conversational quality** — understands the customer, answers from the business's own information, says plainly
   when it does not know, sounds natural on voice.
2. **Business-action correctness** — an action is reported as done only after it is done, and it is done exactly once.
3. **Reliability** — calls are answered; failures degrade to a safe fallback (a person, a callback, a message), never to
   silence or invention.
4. **Low latency** — especially on voice, where delay breaks turn-taking.
5. **Security** — tenant isolation, server-side secrets, verified webhooks. Security and tenant isolation are
   constraints, not trade-offs: no feature ships that weakens them.
6. **Operating cost** — the cheapest option that satisfies the priorities above ([AI_RUNTIME.md](AI_RUNTIME.md)).

## 2. One business configuration, one engine

All channels share:

- the business configuration (agent settings, business profile, hours, allowed actions and destinations);
- the knowledge base;
- contacts and leads;
- conversations — channel-neutral; a voice session or a phone call is a conversation;
- domain services and validated server-side tools (same validation, idempotency, audit and limits);
- usage metering and spend limits.

Channels adapt transport only; they contain no business logic. Consequences for the tenant: configure once; the same
question gets the same answer on chat, voice and phone; an action added for one channel (for example callback requests)
behaves identically on every channel that offers it; conversations and reports cover all channels.

## 3. What exists today and what is planned

| Capability | Status |
| --- | --- |
| Sign-up/login, organizations, membership roles (owner, admin, member), onboarding | Implemented (Phase 0) |
| Agent configuration: name, status, greeting, language, time zone, instructions, business profile, weekly hours, lead-capture fields | Implemented (Phases 0–1) |
| Knowledge: manual text and TXT/Markdown upload, tenant-scoped semantic retrieval | Implemented (Phase 1) |
| Website text chat: embed snippet, streamed replies, conversation restored on reload, "New chat" | Implemented (Phase 1) |
| Allowed sites per widget (browser-enforced framing restriction; not authentication) | Implemented (Phase 1.5) |
| Actions: `searchKnowledge`, `getBusinessInfo`, `getBusinessHours`, `captureLead` | Implemented (Phase 1) |
| Admin: overview with setup checklist, agents, knowledge, conversations with transcript and tool audit trail, leads | Implemented (Phase 1) |
| Abuse and cost protection: rate limits per client, widget and organization; per-organization estimated AI spend limits; conversation-length limit; per-turn caps; premium-model cap per conversation | Implemented (Phases 1–1.5) |
| Reliability hardening: bounded retries on transient provider failures without switching to the premium model; one writer per conversation turn; exactly-once operation records for future external actions | Implemented in code (Phase 1.5) |
| Validation against live Supabase and live OpenAI models | Tooling exists; **not yet run** (credentials pending) — [LIVE_VALIDATION.md](LIVE_VALIDATION.md) |
| Shared realtime voice engine and dev-only browser voice proof of concept | Phase 2 |
| Inbound phone receptionist: phone numbers, callback requests, human transfer, keypad (DTMF) input, calls in admin | Phase 3 |
| Appointment booking, SMS, customer-conversion workflows | Phase 4 |
| Production website live voice widget | Phase 5 |
| Consent-based outbound calling | Phase 6 |
| Subscription billing, tenant-visible usage and spend, provider-confirmed cost reconciliation, monitoring, SLOs, data retention/export/delete | Phase 7 |
| Industry templates; measured provider-cost optimization | Phase 8 |
| PDF/document knowledge extraction | Not scheduled — added when extraction is reliable and a tenant needs it |

Nothing in this table claims production readiness. No voice, phone, SMS or outbound capability exists today, and the
Phase 1.5 live validation has not been run.

## 4. Tenant user stories

Implemented:

1. Sign up and create an organization (as its owner).
2. Create an agent; set its greeting, language, time zone and instructions.
3. Enter the business profile and weekly opening hours.
4. Add knowledge (text, TXT/Markdown files), for the whole organization or one agent.
5. Choose which contact details lead capture requires.
6. Publish web chat, copy the embed snippet, preview it, and restrict the sites allowed to embed it.
7. Review conversations with their transcript, the actions the agent took and their outcomes; review leads.

Planned:

8. Get a phone number for an agent, set transfer destinations, review calls and callback requests (Phase 3).
9. Connect a calendar so the agent can book; enable SMS once registration and consent are in place (Phase 4).
10. Enable live voice on the website widget and choose a voice (Phase 5).
11. Run a platform-approved outbound workflow for consenting contacts, after reviewing it (Phase 6).
12. See usage and spend, choose a plan, set limits within it, receive spend alerts (Phase 7).
13. Start an agent from an industry template (Phase 8).

## 5. Channels

### 5.1 Inbound telephone receptionist (primary product; Phase 3)

Caller stories:

- Calls the business number at any hour and is greeted by the business's agent.
- Asks questions and gets answers from the business's knowledge, profile and hours; is told plainly when the agent does
  not know.
- Leaves name, number and reason as a lead; hears details (such as a phone number) read back for confirmation.
- Requests a callback and hears it confirmed only after it is recorded.
- Asks for a person at any time and is transferred to a tenant-approved destination; if the transfer fails, is offered a
  callback or message instead.
- Uses the keypad where it helps (for example, entering a callback number).
- Interrupts the agent naturally (barge-in).

Tenant stories:

- Provisions a phone number for an agent.
- Sets the transfer destinations (an allowlist) and when transfer is offered.
- Sees every call: caller number as presented (unverified), duration, transcript, actions taken, outcome (answered,
  transferred, callback requested, lead captured, abandoned).
- Sets the maximum call length and concurrent-call limit within the plan.
- Chooses the fallback used when the agent cannot take a call for a reason the platform controls (limit reached,
  provider error): forward to a configured number, or a short message. Behaviour during a full platform outage is
  covered by the Phase 7 incident runbooks.

Capabilities and constraints:

- Native realtime speech-to-speech conversation with interruption (see section 9).
- Same knowledge, actions and limits as the other channels.
- Transfer is blind: Twilio SIP trunk transfers via SIP REFER are blind only, enabled per trunk.
- Provider limits: an OpenAI SIP call rings for at most 3 minutes and stays connected for at most 2 hours.
- Caller ID is not authentication; it is stored as presented and labelled unverified.

Non-goals for the first phone release: outbound calls (Phase 6), warm/attended transfer, audio recording storage
(transcripts are stored; recordings are not), voicemail product, IVR/menu builder, number porting, toll-free and non-US
numbers, conference calls, payments by phone.

### 5.2 Website live voice (engine Phase 2; production widget Phase 5)

Quality target: a conversation comparable to ChatGPT's live voice mode — full-duplex, low latency, interruptible,
natural voice. Measurable targets and the measurement method are defined in [VOICE_QUALITY.md](VOICE_QUALITY.md); until
a measurement report exists they are targets, not results. Browser speech recognition/synthesis and sequential
speech-to-text → text model → text-to-speech pipelines are not the primary production voice architecture.

Visitor stories:

- Clicks voice in the widget, grants microphone access and talks; interrupts the agent naturally.
- Sees live captions and the transcript; can switch to text within the same conversation.
- Gets the same answers and actions as in text chat.
- Asks for a person and is offered a callback (there is no live transfer from website voice).
- Ends the session and the microphone is released.

Tenant stories:

- Enables voice per widget and chooses a voice from those the provider offers.
- Voice minutes are bounded by plan and spend limits.
- Voice conversations appear in Conversations with their transcript and actions.

Constraints: spoken languages are limited to those the voice provider supports — for GPT-Live currently English,
Portuguese, Spanish, German, French, Hindi, Japanese and Korean. English is evaluated first; each further language is
offered only after its own evaluation ([VOICE_QUALITY.md](VOICE_QUALITY.md)). For other agent languages, voice is not
offered and text chat remains available.

The Phase 2 browser page is a developer proof of concept; it is not offered to tenants.

Non-goals: video or avatars, voice cloning, wake words or always-on listening, native mobile SDKs, offline use.

### 5.3 Website text chat (implemented)

Visitor stories (implemented): opens the widget, asks a question and gets a streamed, grounded reply; gives contact
details and becomes a lead; reloads the page and the conversation is restored; starts a new chat.

Tenant stories (implemented): publishes or unpublishes the widget, copies the embed snippet, previews it, restricts
allowed sites, reviews conversations and leads.

Current behaviour:

- The visitor is anonymous, identified by a signed session token with a sliding expiry; one active conversation per
  visitor per agent; messages sent from two tabs are processed one at a time.
- Visitor-supplied contact details are stored on the lead as given and never overwrite an existing contact; one lead per
  conversation.
- Allowed sites stop other websites from framing the widget in browsers that enforce it; they do not authenticate API
  clients. Rate limits bound abuse.

Known limitations: no PDF knowledge; knowledge ingestion runs inside the request; fallback sentences are English only;
tenants cannot see usage or spend in the admin UI.

Non-goals: file uploads from visitors, login-required chat, live takeover by a human operator (human follow-up happens
through leads and, from Phase 3, callback requests).

### 5.4 Outbound calling agent (Phase 6)

Outbound calls are placed only for approved, consent-based workflows, for example:

- returning a call the customer requested (a callback request);
- confirming or reminding about an appointment the customer booked;
- a follow-up the customer explicitly asked for.

Each workflow template is approved by the platform operator; each run is reviewed and approved by the tenant before
any call is placed.

Recipient stories:

- Receives the call from the business's own number.
- Hears at the start that this is an automated assistant calling on behalf of the business, and why.
- Says "stop calling me" (or equivalent) and is never called again by that business's automated workflows.
- Asks for a person and is transferred or offered a callback.

Tenant stories: chooses an approved workflow, selects contacts with recorded consent for that purpose, reviews and
approves the run, sees the outcome of every call.

Non-goals: cold calling, purchased or rented contact lists, marketing campaigns without consent records,
predictive/mass dialers, voicemail drops, any caller ID other than the tenant's own number.

## 6. Agent configuration

| Setting | Status |
| --- | --- |
| Name, status (active/paused) | Implemented |
| Greeting (spoken on voice and phone) | Implemented |
| Language | Implemented (voice limited to provider-supported languages) |
| Time zone | Implemented |
| Concise behaviour instructions (up to 4,000 characters) | Implemented |
| Business profile: name, description, phone, email, website, address, service area | Implemented |
| Weekly business hours | Implemented |
| Lead capture: enabled, required fields | Implemented |
| Knowledge sources (organization-wide or per agent) | Implemented |
| Web chat publishing, embed snippet, allowed sites | Implemented |
| Voice selection | Phase 2 (engine), Phase 5 (tenant setting) |
| Phone numbers | Phase 3 |
| Transfer destinations (allowlist) and transfer policy | Phase 3 |
| Callback settings | Phase 3 |
| Unavailable fallback (forward number or message) | Phase 3 |
| Calendar connection and booking rules | Phase 4 |
| SMS settings (registration status, consent text, message templates) | Phase 4 |
| Outbound workflows | Phase 6 |

## 7. Actions (tools)

The agent acts only through server-side actions that the tenant's configuration enables on the current channel. Every
action is validated, recorded and auditable. The agent reports an outcome only after the action returns; when an
outcome is unknown (for example a provider timed out after the request was sent), the agent tells the customer it is
unconfirmed and that the business will follow up, and the operation is surfaced for reconciliation.

| Action | Purpose | Effect | Status |
| --- | --- | --- | --- |
| `searchKnowledge` | Answer from the knowledge base | Read | Implemented |
| `getBusinessInfo` | Contact details, address, service area | Read | Implemented |
| `getBusinessHours` | Opening hours in the agent's time zone | Read | Implemented |
| `captureLead` | Save the customer's details as a lead | Internal write; one lead per conversation | Implemented |
| `createCallbackRequest` | Record a callback request | Internal write; exactly once per request | Phase 3 |
| `transferCall` | Transfer a call to a person | Phone only; allowlisted destinations | Phase 3 |
| `checkAvailability`, `bookAppointment` | Book on the tenant's calendar, after reading the details back | External; exactly once | Phase 4 |
| Corrective change/cancel | Correct an appointment booked in the same conversation ("no, Thursday") as an explicit new action | External; exactly once | Phase 4 |
| `sendSMS` | Confirmations and replies by SMS | External; consent and registration required | Phase 4 |
| Industry tools (`getOrderStatus`, `createQuote`, `createSupportTicket`) | Vertical workflows | External | Phase 8, only with a real integration and tenant need |
| `updateContact` | Edit an existing contact | Internal write | Not scheduled; added when a scenario requires it |
| `takePayment` | Payments | — | Not planned |

## 8. Knowledge

- Structured business facts (profile, hours) live in structured settings and are read through tools.
- Unstructured knowledge follows `source → extract → normalize → chunk → embed → store → retrieve`.
- Supported today: manual text, TXT/Markdown. PDF/documents: when extraction is reliable (not scheduled).
- Each turn retrieves only a small number of relevant passages; whole documents are never sent to the model.
- Answers are based on retrieved material, or the agent says it does not have the information.
- Knowledge content is treated as facts, never as instructions to the agent.

## 9. Conversational and voice quality

- Grounded answers; no invented facts, prices, availability or policies.
- Concise, channel-appropriate style; replies in the agent's configured language.
- Details that matter (names, phone numbers, times) are confirmed back to the customer.
- The agent never claims to be human.
- Voice: natural full-duplex turn-taking, interruption at any time, low response latency. Targets (latency, interruption
  handling, transcription accuracy, task completion) and the measurement methodology are in
  [VOICE_QUALITY.md](VOICE_QUALITY.md). Voice phases (2, 3, 5, 6) are accepted against those targets.
- Quality is judged by task completion and correctness, not latency alone.

## 10. Tenant safety and action correctness

| Requirement | Product rule |
| --- | --- |
| Tenant isolation | Every record belongs to exactly one tenant. A customer of one tenant never receives another tenant's data. Zero tolerance. |
| No fabricated outcomes | The agent never says an action succeeded unless the action returned success. Zero tolerance. |
| Exactly-once external actions | SMS, bookings and calls are executed at most once per request, also under retries, duplicate webhooks, reconnects and concurrent workers. Unknown outcomes are never retried automatically; they are surfaced for reconciliation. Zero tolerance for duplicates. |
| Interruptions | Barge-in stops the agent's speech; it never cancels, undoes or repeats an action that was already started. |
| Human access | Phone callers can ask for a person at any time. Transfers go only to tenant-allowlisted destinations. The agent never claims a person answered. |
| Untrusted input | Customer speech and text, knowledge content, caller ID and SIP headers are data, never instructions; they cannot widen the agent's permissions. |
| Secrets and privacy | Provider secrets stay on the server. Logs redact customer free text and contact details. Data retention, export and deletion: Phase 7. |
| Embedding control | Allowed sites restrict which websites may frame the widget; they are not authentication. |

## 11. Consent and compliance (SMS and outbound calling)

Telemarketing, messaging and recording rules vary by jurisdiction. This specification states product requirements, not
legal conclusions. SMS (Phase 4) and outbound calling (Phase 6) are enabled for a tenant only after a documented legal
review of the consent text, opt-out handling, calling hours and disclosure.

Requirements:

1. **Consent records.** Before any SMS or outbound call, a consent record exists for that recipient, that business and
   that purpose: phone number and contact, purpose/workflow, time, channel and the exact disclosure text shown or spoken,
   evidence (conversation or message reference), and revocation status. No record → nothing is sent or dialed; the
   refusal is audited.
2. **Opt-out.** SMS opt-out keywords (such as STOP) and spoken requests ("don't call me again") are honoured immediately
   and recorded per tenant; automated workflows never contact that number again for that tenant.
3. **Quiet hours.** Non-transactional SMS and all outbound calls are sent only inside a calling window in the
   recipient's local time. The platform default window is set during legal review; tenants may narrow it, not widen it.
4. **Do-not-call.** Each tenant has an internal do-not-call list. National do-not-call registry checks are applied
   where the legal review requires them.
5. **Disclosure.** Outbound calls state at the start that the caller is an automated assistant and name the business.
   On any channel, the agent does not claim to be human.
6. **US SMS registration.** Twilio requires A2P 10DLC registration for application-to-person SMS sent from US 10-digit
   long-code numbers (Twilio US pricing pages, current as of Oct/Nov 2026, accessed 2026-11-26). Twilio's pages state conflicting registration
   fees; fees and lead time are confirmed at the start of Phase 4. A tenant cannot send US SMS until its registration is
   approved.
7. **Approved workflows only.** Outbound calls run only from platform-approved workflow templates and only after the
   tenant approves each run.
8. **Recording.** Audio recording is not in the planned scope. If added later, it is announced to the caller and
   follows the legal review.

## 12. Spending safeguards (tenant perspective)

Principle: a tenant's costs cannot run away because of a visitor, a bug or a provider outage.

In place today (text chat):

| Safeguard | Behaviour |
| --- | --- |
| Estimated AI spend limits per organization | Per UTC day and per calendar month; platform defaults USD 10/day and USD 150/month; the operator can set per-tenant values (0 disables AI). Cost is reserved before every model call, so concurrent conversations cannot overshoot. When reached, no model is called and the visitor sees: "I can't reply right now. Please contact the business directly." |
| Conversation length | Default 100 visitor messages per conversation; then the visitor is asked to start a new chat. |
| Premium model use | The stronger model is used only for demonstrated complexity or a quality failure of the default model, at most 6 times per conversation by default. Provider outages never switch to the premium model. |
| Per-turn caps | Limits on tool calls, tokens and model rounds per reply. |
| Rate limits | Per client, per widget and per organization. |
| Cost labelling | Each usage record stores an estimated cost and the price-list version. Estimates are never presented as provider billing. |

Gaps today: tenants cannot see usage or spend, cannot change their limits and receive no alerts (Phase 7).

Planned:

- Limits on voice minutes and concurrent voice sessions (Phase 2), concurrent calls (Phase 3), SMS segments (Phase 4)
  and outbound call attempts (Phase 6), using the same reserve-before-use model.
- Phone: when a limit is reached, the tenant's configured fallback applies (forward or message) — calls are not dropped
  silently.
- Tenant usage and spend dashboard, threshold alerts, plan-based limits the tenant can adjust within the plan, and
  daily reconciliation of estimates against provider-confirmed costs (Phase 7). Estimates remain labelled as estimates.

Why voice needs its own limits (list prices, accessed 2026-11-26): GPT-Live sessions are billed per second — USD 0.05
per active minute and USD 0.02 per standby minute, plus backend model tokens and input transcription; creating a WebRTC
session bills 15 seconds up front (credited later). Twilio US Elastic SIP origination to a local number is USD 0.0034
per minute, a local number USD 1.15 per month, and SMS USD 0.0083 per segment plus carrier fees. Text chat on the
default model costs far less per conversation ([AI_RUNTIME.md](AI_RUNTIME.md)).

## 13. Reliability requirements

- Tenant isolation, enforced in application queries and Supabase RLS.
- Authenticated admin UI.
- Verified webhooks: OpenAI webhooks (Standard Webhooks signatures, deduplicated by webhook id) and Twilio webhooks
  (`X-Twilio-Signature`).
- Idempotent handling of external callbacks and actions.
- Audit trail for every action, including refused ones.
- Duplicate-lead protection (one lead per conversation; implemented).
- Explicit conversation and call states; every call ends in a terminal state.
- Graceful provider failure: bounded retries, then a safe fallback; never fabricated results.
- Human escalation on phone.
- Rate limits and spend limits.
- Server-side secrets; verified database TLS in production.
- Structured logs with customer free text redacted.

## 14. Admin surfaces

Implemented: Overview (setup checklist, recent conversations and leads), Agents (settings, business profile, hours, lead
capture, web chat publishing, allowed sites, embed snippet, preview), Knowledge, Conversations (transcript and tool
audit trail), Leads.

Planned: Calls, Phone numbers and Callback requests (Phase 3); Appointments and SMS (Phase 4); Outbound workflows
(Phase 6); Usage, spend and billing (Phase 7).

Reporting is operational — what happened, what failed, what it cost — not decorative analytics.

## 15. Industry templates (Phase 8)

A template configures instructions, business fields, tool availability, a qualification schema and test scenarios. It
is data applied to the same core; it never forks the platform. Candidate industries: HVAC, plumbing, restoration,
logistics, legal, dental, auto repair. The first templates are chosen by tenant demand.

## 16. Non-goals (current plan)

- CRM integrations, workflow builder, plugin or provider marketplace.
- WhatsApp and social channels; mobile application.
- Multi-agent handoff graphs.
- Cold calling and mass outbound dialing.
- Payments.
- Advanced sentiment analysis or call QA analytics.
- GoHighLevel, Retell, Vapi or n8n as platform dependencies.
- Browser speech recognition/synthesis or sequential STT → LLM → TTS as the primary voice architecture.

## Sources

Accessed 2026-11-26; official documentation only.

- OpenAI pricing: https://developers.openai.com/api/docs/pricing
- OpenAI GPT-Live: https://developers.openai.com/api/docs/guides/live, and the guides `realtime-webrtc`,
  `voice-server-controls`, `live-delegation` and `live-conversations` under https://developers.openai.com/api/docs/guides/
- OpenAI SIP: https://developers.openai.com/api/docs/guides/voice-sip
- Twilio Elastic SIP Trunking: https://www.twilio.com/docs/sip-trunking
- Twilio US voice, phone number and SMS pricing pages (marked current as of Oct/Nov 2026), including the A2P 10DLC
  registration requirement
