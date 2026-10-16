# AI Runtime and Cost Strategy

Pricing snapshot: 2026-10-08. Prices change; keep all model choices configurable and re-check provider pricing before production pricing decisions.

## Principle
Do not choose one premium model for every interaction.

Use:
- a cheap default model for ordinary chat, intent handling, structured outputs, summaries, and tool selection;
- a stronger model only for exceptional/complex requests;
- a dedicated realtime voice model for natural phone/web voice;
- cheap embeddings for RAG.

## Initial production routing

### Text / web chat / backend tool reasoning
Default:
`gpt-6-luna`

Use for:
- normal customer questions
- determining whether to call a tool
- tool argument extraction
- lead qualification
- summaries
- classification
- lightweight RAG responses

Current short-context standard pricing:
- input: about $0.05 / 1M tokens
- cached input: about $0.005 / 1M tokens
- output: about $0.25 / 1M tokens

This makes ordinary text conversations extremely inexpensive. Still enforce context budgets.

### Escalation text model
Default:
`gpt-6-sol`

Only invoke when a routing policy decides the default model is insufficient, for example:
- multi-step ambiguous task
- complex policy reasoning
- failed cheap-model attempt
- high-value workflow requiring stronger reasoning

Do not automatically escalate every long message.

### Realtime voice
Initial provider:
`gpt-live-1`

Current published session cost:
- about $0.05 per active session minute
- backend model/tool calls billed separately

This is the recommended initial premium voice path because it provides realtime duplex voice and interruption handling while allowing backend delegation.

### Lower-cost voice option to benchmark later
Gemini Live currently has lower raw audio rates, but pricing is token/context based and long sessions can reprocess accumulated context. Do not switch based only on headline audio prices.

A future "economy voice" mode may use:
`STT -> cheap text model -> TTS`

This can lower direct AI audio cost, but may increase latency and reduce natural turn-taking/barge-in quality. Implement only after the premium path is stable and measured.

### Embeddings
Initial:
`text-embedding-3-small`

Current published price:
- about $0.02 / 1M input tokens

This is adequate for inexpensive text RAG in V1. Keep an `EmbeddingProvider` interface so it can be swapped.

## Provider boundaries
Create separate interfaces/configuration for:
- `TextModelProvider`
- `RealtimeVoiceProvider`
- `EmbeddingProvider`
- `TranscriptionProvider` if needed
- `TelephonyCarrier`

Do not make domain services depend on OpenAI SDK types.

Provider adapters translate provider-native events into Syncore domain events.

## Environment configuration
Recommended variables:

```env
AI_TEXT_PROVIDER=openai
AI_TEXT_MODEL=gpt-6-luna

AI_ESCALATION_PROVIDER=openai
AI_ESCALATION_MODEL=gpt-6-sol

AI_VOICE_PROVIDER=openai
AI_VOICE_MODEL=gpt-live-1

AI_EMBEDDING_PROVIDER=openai
AI_EMBEDDING_MODEL=text-embedding-3-small

AI_ESCALATION_ENABLED=true
AI_MAX_RETRIEVED_CHUNKS=5
AI_MAX_RETRIEVED_TOKENS=1800
AI_MAX_RECENT_MESSAGES=12
```

## Context budgeting
Every model request should be assembled from bounded components.

Target:
- system/agent behavior: concise and stable
- structured business facts: only relevant facts
- retrieved knowledge: usually 3-5 chunks, hard token cap
- conversation: recent turns plus rolling summary
- tool schema: only tools available in the current channel/context where practical

Avoid:
- full company website in prompt
- full transcript forever
- all tool definitions when only a subset is applicable
- large JSON blobs from tool results
- premium model for summaries/classification

## Conversation memory strategy
Maintain:
- recent messages
- compact rolling summary
- durable structured facts separately

Do not use the LLM transcript as the database.

Examples of durable facts:
- contact name
- phone
- email
- lead status
- callback preference
- appointment/order IDs later

## RAG strategy
Store business facts that need deterministic access as structured data.

Use vector RAG for unstructured content only.

Retrieval:
1. normalize query;
2. retrieve top K candidates;
3. optional cheap rerank later if needed;
4. enforce relevance threshold;
5. send only relevant chunks;
6. if evidence is insufficient, do not invent an answer.

## Usage metering
Persist per request/session:
- provider
- model
- input tokens
- cached input tokens if available
- output tokens
- reasoning tokens if exposed
- voice session seconds
- transcription seconds
- embedding tokens
- tool calls
- estimated provider cost
- organization_id
- agent_id
- conversation_id/call_id

The product dashboard can later aggregate gross margin by organization.

## Rough runtime economics
Text is unlikely to be the main cost.

Example: 10,000 chat conversations averaging 2,000 input tokens and 300 output tokens each on the current `gpt-6-luna` prices:
- 20M input tokens ~= $1.00
- 3M output tokens ~= $0.75
- ~ $1.75 of model text usage before other services

Realtime voice is more material:
- 1,000 minutes on `gpt-live-1` ~= $50 for the Live session
- backend text/tool usage is additional but generally small with Luna
- telephony/SMS/provider infrastructure is separate

Therefore optimize voice minutes and support effort before obsessing over chat-token pennies.

## Quality-first routing rule
Cheap does not mean lowest headline price.

A model that:
- misunderstands callers,
- calls the wrong tool,
- books incorrectly,
- fails to transfer,
- or produces poor latency

can cost more in lost business than it saves in tokens.

Ship with cheap default text + high-quality realtime voice, instrument everything, then benchmark alternate voice providers using real test calls.
