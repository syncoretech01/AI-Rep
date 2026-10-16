# Syncore AI Receptionist — Product Specification

## Product goal
Build a general AI receptionist/calling-agent/chat platform that a business can configure once and deploy across phone and web.

The product must be useful before any industry-specific customization.

## V1 user story
A business owner can:
1. create an organization;
2. create an AI agent;
3. enter business information and hours;
4. add knowledge;
5. publish a web chat agent;
6. receive an inbound phone call through the same agent;
7. let the agent answer approved business questions;
8. capture a contact/lead;
9. create a callback request;
10. send an SMS when allowed;
11. transfer a phone call to a human;
12. review conversations, transcripts, tool actions, and outcomes.

## V1 channels
### Web chat
- embeddable widget
- streaming responses
- same knowledge/tools as phone
- conversation persistence
- anonymous visitor session upgraded to contact when details are captured

### Web voice
- browser microphone/speaker
- realtime voice
- interruptible/barge-in
- same tools and business configuration

### Phone
- inbound calls first
- Twilio number/SIP
- realtime voice provider
- human transfer
- callback fallback
- call metadata and transcript persistence

Outbound cold calling is NOT a V1 goal.

## Agent configuration
Each agent supports:
- name
- enabled channels
- greeting
- language
- timezone
- voice
- concise system behavior instructions
- business profile
- business hours
- transfer/fallback numbers
- lead capture fields
- recording setting
- knowledge sources
- escalation behavior

## Initial server tools
- `searchKnowledge`
- `getBusinessInfo`
- `getBusinessHours`
- `captureLead`
- `updateContact`
- `createCallbackRequest`
- `sendSMS`
- `transferCall`

Later tools may include:
- `checkAvailability`
- `bookAppointment`
- `getOrderStatus`
- `createQuote`
- `createSupportTicket`
- `takePayment`

## Knowledge
V1 supports:
- manual text
- TXT/Markdown
- PDF/documents when extraction is reliable

Pipeline:
`source -> extract -> normalize -> chunk -> embed -> store -> retrieve`

Do not send whole documents to the model on every turn.

## Minimum product surfaces
- Overview
- Agents
- Conversations
- Calls
- Contacts / Leads
- Knowledge
- Phone numbers
- Business settings
- Agent settings

Do not build decorative analytics before the core conversation/action flows work.

## Reliability requirements
- tenant isolation
- authenticated admin UI
- signed/verified webhooks
- idempotent external callbacks
- tool audit log
- duplicate-lead protection where practical
- explicit conversation/call states
- graceful external-provider failure
- no fabricated tool results
- human escalation
- rate limits
- server-side secrets
- structured logs

## Non-goals for the first vertical slice
- CRM integrations
- calendar integrations
- billing/subscriptions
- WhatsApp/social channels
- workflow builder
- mobile application
- multi-agent handoff graph
- mass outbound dialer
- industry templates
- advanced sentiment/call QA
