# Syncore AI Receptionist — Voice Quality Specification

Applies to: Phase 2 (shared realtime voice engine + browser proof of concept), Phase 3 (inbound telephone receptionist), Phase 5 (production website voice), Phase 6 (consent-based outbound calling).

Status (2026-11-26): specification only. No voice code exists and **no voice measurements exist**. Every number below is a provisional engineering target or a test-design parameter. None is a provider guarantee or an achieved result. Provider facts were verified on 2026-11-26 against the official sources in §12 ([S1]–[S5]).

Related documents: `CLAUDE.md` (engineering rules), `PRODUCT_SPEC.md` (channels), `ARCHITECTURE.md` (voice gateway, tool system, call state), `AI_RUNTIME.md` (models, metering, cost), `IMPLEMENTATION_PLAN.md` (phase scope).

## 1. Quality bar and assumed architecture

The target is a natural, full-duplex conversation of the kind people know from ChatGPT Live Voice. The caller speaks whenever they want and the microphone stays open. The agent answers quickly, stops talking when interrupted and never misstates what it did. The following are not acceptable as the primary production voice architecture: push-to-talk, dictation-style turn taking, browser `SpeechRecognition`/`SpeechSynthesis`, and sequential STT -> LLM -> TTS pipelines.

Assumed architecture (decided in Phase 1.5; details in `ARCHITECTURE.md`):

- **Browser voice.** Microphone -> WebRTC -> an OpenAI GPT-Live session (`gpt-live-1.1`). Our server creates the session with `POST /v1/live/sessions` and returns the SDP answer. Audio flows directly between the browser and OpenAI. No provider key or client secret reaches the browser [S3].
- **Telephone.** PSTN -> Twilio number -> Twilio Elastic SIP Trunk (TLS + SRTP) -> OpenAI SIP -> `live.transport.incoming` webhook -> the gateway accepts with the tenant's configuration [S4][S5]. Twilio SIP to GPT-Live is an **inference that a Phase 2/3 spike must prove**. The fallbacks are the Realtime API (`gpt-realtime-2.1`) with the documented Twilio SIP guide, or Twilio Media Streams bridged by the gateway.
- **Voice gateway.** A long-running Node.js process that does four things:
  - attaches to the sideband WebSocket `/v1/live/sessions/{id}/attach`;
  - executes tools through the existing tool executor (same registry, Zod validation, authorization, idempotency, audit and fencing);
  - persists transcripts into the same `conversations`/`messages`;
  - meters seconds and tokens.

  All channels share one business-logic engine. Voice does not get its own.

## 2. Browser voice and telephone are evaluated separately

The two channels differ in codec, bandwidth, network path and where we can measure. Results are always reported per channel, and browser and telephone samples are **never pooled**.

| Aspect | Browser voice (Phases 2, 5) | Telephone (Phases 3, 6) |
|---|---|---|
| Media path | Browser <-> OpenAI over WebRTC. Our server handles only signalling and the sideband. | Handset <-> PSTN carrier <-> Twilio <-> OpenAI SIP (TLS on 5061, SRTP) [S4][S5] |
| Codec / bandwidth | Negotiated WebRTC codec, recorded from `getStats()` per session | G.711 PCMU/PCMA at 8 kHz narrowband [S5]. Letters such as F/S, M/N and B/D/P/V are easily confused. |
| Network variables | Client access network (broadband, 4G, loss/jitter), emulated with netem (§7.2) | Carrier type and route (mobile, landline). PSTN impairments cannot be controlled, only recorded. |
| Latency/stop measurement point | The remote WebRTC audio track as delivered to the page (after the jitter buffer, before the OS output device). Device output latency is excluded, and the report says so. | Caller side of the PSTN: a test endpoint that dials the Twilio number over the PSTN and records both directions on one clock |
| Human escalation | Callback capture (no live transfer from web voice) | Blind transfer via `/refer` to an allowlisted destination, with callback fallback [S4][S5] |
| Extra input | None | DTMF events [S4] (fallback for entering digits) |
| Documented limits | Maximum GPT-Live WebRTC session length is not documented [S3], so we enforce our own cap | 2 h connected, 3 min ringing [S4] |
| Cost components | GPT-Live seconds, backend tokens, transcription | Same, plus Twilio origination minutes, number rental and transfer legs (§8.5) |

## 3. Required capabilities

| # | Capability | What "good" means | How it maps to the architecture |
|---|---|---|---|
| C1 | Continuous listening and natural turn-taking | The microphone stays open for the whole session and the caller never presses a button. The agent does not cut the caller off at natural mid-sentence pauses (for example, while they read out digits) and does not leave awkward gaps. Backchannels ("mm-hm") do not start a full agent turn. | GPT-Live is full duplex, with wake policy and `vad_threshold` controls [S3]. Turn-detection and eagerness knobs are not documented for GPT-Live [S3], so turn-taking is tuned through `vad_threshold` and instructions and measured with the diagnostics in §6.10. Browser UI states (`ARCHITECTURE.md` §6) are presentation-only. |
| C2 | Barge-in and immediate interruption handling | Agent audio stops within the interruption target (§5) once the caller starts speaking meaningfully. The agent then responds to what was said, not to the rest of its abandoned sentence. Coughs, noise and backchannels do not stop it. | The provider truncates output audio. The browser must keep echo cancellation on, or the agent's own playback interrupts it. The persisted assistant message is marked as interrupted. **Barge-in cancels audio only, never a tool run** (§4). |
| C3 | Low response latency | Speech starts within the latency targets (§5). Tool turns are acknowledged immediately. | Our server is not in the media path. Stable instructions stay far below the 16,384-token maximum [S3], tool results stay minimal, and retrieval returns the fewest useful chunks. The delegation mode (Responses vs client) is chosen in Phase 2 by measurement. |
| C4 | Background-noise tolerance | Tasks complete and critical data stays correct at the noise levels in §7.1. The agent asks the caller to repeat rather than guess, and noise does not trigger barge-in. | Noise reduction is not documented for GPT-Live [S3]. In the browser, the standard `getUserMedia` `noiseSuppression`/`autoGainControl` constraints are evaluated both on and off. `vad_threshold` is tuned. The read-back rules (§3.1) catch residual errors. |
| C5 | Accent and multilingual handling | Task completion is comparable across accent groups (§7.4). The agent replies in the tenant's configured language and offers only languages that are documented and have been evaluated. | GPT-Live documents these languages: en, pt, es, de, fr, hi, ja, ko [S3]. Voice in a given language is enabled for a tenant only after that language passes its own evaluation (§7.4). Languages outside the list are not offered for voice. Cross-lingual retrieval with `text-embedding-3-small` has not been measured and must be evaluated. |
| C6 | Natural pacing and acknowledgments | Short spoken sentences, one question at a time, and brief acknowledgments. While a tool runs, the agent says a non-committal filler ("Let me check that") within the latency target, then a progress line if the tool runs past about 4 s. Fillers never imply success. | GPT-Live keeps talking while tools run [S3]. Client delegation offers `acknowledgement_delay_ms` from 0 to 800 [S3]. Filler wording lives in the prompts, and the fabricated-success check (§6.6) verifies it. |
| C7 | Conversation context preservation | The agent remembers earlier details (name, reason for calling, constraints) without asking again, and stays consistent after interruptions and reconnects. | GPT-Live has a 128k context, with a replacement engine above 90% [S3]. Transcripts are persisted to the same conversation. After a reconnect, the new session is rehydrated from persisted state: the rolling summary goes in as labelled user-role context (`AI_RUNTIME.md`), never the full knowledge base or unlimited history. |
| C8 | Correction of previously supplied information | When the caller says "Actually it's 0199", the new value replaces the old one, the agent re-reads only the corrected item, and the final record holds the corrected value. | Values not yet committed are held in conversation state. A committed value is changed only by a new validated tool run (for example `updateContact`). The original run stays in the audit log. The agent never says a record changed unless the update tool returned success. |
| C9 | Silence and timeout handling | After a question met with silence, the agent reprompts once (about 7 s), reprompts again (about 8 s more), then closes politely. "Hold on, let me find it" extends the wait up to 60 s. Idle and standby billing stays bounded. | GPT-Live `idle_timeout_s` ranges from 5 to 60 [S3]. Telephone calls are capped at 2 h connected and 3 min ringing [S4]. Per-organization voice-second limits use the reservation table's `resource` column. All timings are provisional. |
| C10 | Graceful disconnection and provider-failure recovery | The agent closes by restating what was done and what happens next. On failure the caller gets the best available fallback: text chat on the web; on the phone, the fallback number, callback capture or a clean hang-up. State is persisted, and nothing that did not happen is claimed. | Close reasons are `close_requested`, `expired`, `content`, `remote_hangup` and `connection_lost` [S3]. The sideband replays only the last 3 s, so the gateway reattaches immediately and dedupes on `event_id` [S3]. Webhooks are deduped on `webhook-id` [S4]. Failure handling is detailed in §8.4. |
| C11 | Accurate capture and read-back of critical information | Names, phone numbers, emails, dates and addresses are captured exactly and confirmed by read-back before any action uses them (§3.1). | The tool's Zod schema validates each value, and the server normalizes it (E.164; ISO 8601 in the tenant's timezone). Accuracy is measured against ground truth (§6.5). |
| C12 | Human escalation (transfer / callback) | A request for a person is honoured at once. Transfers go only to an allowed destination configured for the organization. If the transfer fails or it is after hours, the agent takes a callback request. It never claims that a person answered. | Telephone: `transferCall` -> gateway -> `/v1/live/sessions/{id}/refer`. The transfer is blind and governed by Twilio's per-trunk transfer setting [S4][S5]. Browser: callback capture only. Every transfer attempt is persisted (`ARCHITECTURE.md` §19). |
| C13 | Reliable tool execution during conversations | The right tool runs once with the right arguments, and its result is reported accurately. Slow tools are covered by filler. Failed or unknown outcomes are stated honestly, with a next step. | In Responses delegation, our function tools arrive on the sideband as `response.event` `output_item.done`. The gateway runs the existing executor and returns `function_call_output` + `response.create`. OpenAI recommends `parallel_tool_calls: false` [S3]. Chat's per-turn caps also apply to voice. |

### 3.1 Critical-information read-back rules

| Field | Capture | Read-back rule | Server-side normalization | After 2 failed confirmation cycles |
|---|---|---|---|---|
| Name | Ask for the full name, then ask the caller to spell the surname (and the first name if it is uncommon) | Spell letter by letter. Disambiguate confusable letters with a word ("M as in Mike"). | Trimmed; original spelling kept | Persist marked "spelling unconfirmed" so staff can verify |
| Phone number | On the phone, offer caller ID ("the number you're calling from, ending 4-5-6-7?"); otherwise ask | Read digit by digit in groups (NANP 3-3-4), never as cardinal numbers | E.164, validated by the tool schema | Phone: DTMF keypad entry [S4]. Browser: ask the caller to repeat slowly. |
| Email | Ask, then ask the caller to spell the local part | Read the local part letter by letter with symbols spoken ("dot", "underscore", "dash"). Common domains may be read as words but must be confirmed. | Lower-cased and syntax-validated | Offer a callback or staff confirmation. From Phase 4: an SMS link where the caller types it. |
| Date / time | Accept relative phrases ("next Friday") | Restate as weekday + absolute date + time + AM/PM in the tenant's timezone | Resolved server-side in the tenant's timezone | Offer a callback |
| Address | Number, street, unit, city, postal code | Read the house number and postal code digit by digit, spell uncommon street names, restate the unit | Structured fields | Persist marked unconfirmed so staff can verify |

These rules apply to every field:

- **What counts as confirmation.** Confirmation is an explicit affirmative given after the complete read-back. Silence is not confirmation. A "yes" spoken over the read-back (barge-in) does not confirm the part the caller did not hear, so the agent re-reads it.
- **What reaches tools.** Only confirmed values are passed to side-effecting tools. After a correction, the agent re-reads only the corrected field.
- **Caller ID.** Caller ID can be withheld or spoofed. It is a convenience that is always confirmed verbally, never proof of identity.
- **Logging.** Values are never logged in clear text. The logger redacts free-text keys as a backstop.

## 4. Rule: interrupted speech must never cancel, duplicate or misrepresent committed business actions

This rule is safety-critical and gates every phase (§10).

1. **Committed actions are server-side tool runs.** A booking, callback request, transfer, SMS or CRM write exists only as a tool run executed by the gateway through the existing executor and recorded in `tool_runs` (plus `app_private.tool_operations` for `sideEffects: 'external'`). Its lifecycle is independent of the audio stream.
2. **Barge-in cancels audio only.** An interruption truncates agent speech. It never aborts, rolls back or re-issues a tool run. GPT-Live documents that interruption does not cancel backend work [S3], and the gateway must not add cancellation of its own.
3. **No success claim before tool success.** Before a tool returns, the agent may use only in-progress wording ("I'm putting that request in now"). Words such as "booked", "sent", "transferred" or "saved" are allowed only after the tool returns success.
4. **Unknown outcomes stay unknown.** If a handler times out or crashes after it started, or a lapsed claim leaves an operation unconfirmed, the operation becomes `unknown`.
   - It is never retried automatically.
   - The agent tells the caller the action is unconfirmed and offers a next step (staff follow-up or callback).
   - Staff resolve it through `listUnresolvedOperations` / `resolveUnknownOperation`.
   - For `in_progress` and `unknown`, the model is instructed to claim neither success nor failure.
5. **Duplicate protection.**
   - External operations are keyed by `(organization_id, operation_key)`, where the default key is `sha256(conversation | tool | normalized args)`.
   - The claim is one atomic `INSERT ... ON CONFLICT DO UPDATE` that succeeds only from `not_attempted` or `failed`.
   - A `succeeded` operation replays its stored result and is never executed again. This covers a caller who repeats a request after an interruption, a model that re-emits the call, a replayed sideband event (deduped on `event_id`) and a redelivered webhook (deduped on `webhook-id`).
   - Internal-write tools keep their existing semantics. For example, `captureLead` replays its latest run and allows one lead per conversation.
6. **Corrections are new actions.** If the caller interrupts with "no, Thursday" while a write tool is running, the run completes and is recorded. The agent then makes the change with an explicit corrective tool (update or cancel) and does not pretend the first run did not happen. Actions that are irreversible or external require read-back confirmation before they are invoked (§3.1).
7. **The transcript is not the system of record.** If the agent's outcome statement was cut off, the caller may not have heard it, and the agent restates the outcome briefly. Business state is read from `tool_runs`/operations, never from what the transcript says.
8. **A hang-up does not cancel work.** If the caller disconnects during a tool run, the run completes and is recorded, and unknown outcomes enter reconciliation.
   - Operation keys are conversation-scoped, so a caller who redials starts a new conversation.
   - Preventing duplicates across calls (for example, two callback requests from the same number) is a domain-service decision for Phase 3. It is measured as a diagnostic (§6.10).
9. **Writes are fenced.** Voice writes reuse the token-fenced write mechanism used for chat turns, so a gateway worker that has lost ownership cannot write. The exact lock granularity for voice sessions is a Phase 2 design detail.

## 5. Provisional engineering targets

These are **targets, not guaranteed provider capabilities and not achieved results**. Their definitions, statistics and pass rules are in §6, and the phases they gate are in §10.

| Metric | Target |
|---|---|
| Median speech-to-response latency | <800 ms |
| P95 ordinary response latency | <1.5 seconds |
| Interruption-to-audio-stop latency | <300 ms |
| Tested business task completion | ≥98% |
| Confirmed contact-information accuracy | ≥99% |
| Fabricated successful actions | Zero in release evaluations |
| Duplicate external actions | Zero in release evaluations |
| Cross-tenant exposure | Zero |
| Human-rated conversational naturalness | ≥4.5/5 |

## 6. Metric definitions and measurement

### 6.0 Statistical conventions (apply to every metric)

- **Proportions.** Use the Wilson score 95% interval. Reference values:
  - N=400 with 8 failures gives 98.0% observed and a lower bound (LB) of 96.1%.
  - At N=600, LB ≥ 98% allows at most 5 failures.
  - At N=1000, LB ≥ 99% allows at most 3 errors; with 10 errors (99.0% observed), LB is 98.2%.
  - With zero failures, LB ≥ 98% needs N ≥ 189, and LB ≥ 99% needs N ≥ 381.
- **Zero-tolerance metrics.** One occurrence fails the gate. Report the rule-of-three 95% upper bound (≈ 3/N): zero observed means "below about 3/N", not "impossible".
- **Quantiles.**
  - Use the distribution-free order-statistic 95% CI. The upper bound is the order statistic of rank *u*, where *u* is the smallest rank with BinomCDF(u−1; N, q) ≥ 0.975.
  - At N=400 that is the 221st-smallest value for the median and the 389th-smallest for P95. At N=1000 it is the 532nd and the 964th.
  - Turns are clustered by session. If any session contributes more than 10 turns, also compute a session-cluster bootstrap (≥ 10,000 resamples) and gate on the more conservative bound.
- **Pre-registration.** N, conditions, statistic and pass rule are written into the evaluation record (§9) before the run.
- **Sampling discipline.** Do not stop early on a pass, and do not merge samples from different builds. A fix means a full re-run of that metric on the new build.
- **Exclusions.** Only documented harness faults may be excluded. Provider errors, timeouts and dropped calls count against the system.
- **Clocks.** Gated timing values come from one clock in the test harness (caller audio and received audio share it). Server and provider timestamps are used only for latency decomposition and production monitoring, and are never subtracted across hosts for a gated value.

### 6.1 Median speech-to-response latency (target <800 ms)

| Item | Definition |
|---|---|
| Population | Every caller turn that expects a spoken reply. Excludes the opening greeting (reported separately as connect-to-greeting) and backchannels. |
| Start | End of caller speech. In harness runs this is the ground-truth end mark of the injected utterance from the annotated corpus. In live human calls it is offline VAD on the two-channel recording, cross-checked against provider transcript end timestamps (transcripts carry start/end ms [S3]). |
| Stop | First agent audio frame at the listener above the versioned energy threshold (default −40 dBFS over 20 ms). Browser: the remote track in the page. Telephone: the received audio at the PSTN caller endpoint (§2). Acknowledgments and fillers count as a response. |
| Instrumentation | Harness timeline file (caller marks, listener onsets), joined by session to server events: `voice.user.speech_ended`, `voice.response.audio_started`, `agent.turn.finished` (with voice timing fields), `ai.call.completed` (backend model latency, `firstTokenMs`) and `agent.tool.*` (§6.11). |
| N and pass rule | Gating condition: ≥ 400 turns from ≥ 40 sessions per channel; pass if the 95% CI upper bound of the median is < 800 ms. Every other condition: ≥ 100 turns, reported. |
| Conditions | Gating latency uses the reference conditions (§7.5). All other matrix cells are reported. |
| If missed | Decompose the latency into caller end -> provider transcript end -> response start -> listener playout. Levers: instruction length, tool result size, delegation mode, and the EU/IN SIP endpoints [S4] for non-US traffic. The release gate for that channel fails; no runtime fallback disguises latency. |

### 6.2 P95 ordinary response latency (target <1.5 s)

| Item | Definition |
|---|---|
| Population | "Ordinary" turns: the reply needs no tool, or only read-only internal tools (`getBusinessInfo`, `getBusinessHours`, `searchKnowledge`). Excludes turns that invoke write or external tools and turns the scenario marks as expected-long. |
| Start / stop | Same as §6.1. |
| Instrumentation | As §6.1. Tool turns also report time-to-substantive-answer (end of caller speech -> start of the agent utterance that contains the answer, from transcript alignment), so fillers cannot hide slow tools. |
| N and pass rule | ≥ 400 ordinary turns from ≥ 40 sessions per channel in the reference condition; pass if the 95% CI upper bound of P95 is < 1.5 s. |
| If missed | Same levers as §6.1, plus the read-only tool latency budget (P95 of `tool_runs.duration_ms`) and the number of retrieval chunks. |

### 6.3 Interruption-to-audio-stop latency (target <300 ms)

| Item | Definition |
|---|---|
| Event | The caller starts a deliberate interruption (≥ 500 ms of planned speech, not a backchannel) while agent audio is playing at the listener. The harness injects it at a scripted offset 1–4 s after agent speech onset. |
| Start | Onset of the interrupting speech at the harness microphone-injection point (ground truth). This is not the VAD detection time, which is logged separately for decomposition. |
| Stop | Last agent audio frame above threshold at the listener, followed by ≥ 500 ms below it. Measurement points are as in §2. |
| Statistic | The target applies to the **median**. P90/P95 are reported as diagnostics; this choice is provisional. |
| Instrumentation | Harness timeline, `voice.response.interrupted` (provider-reported truncation point where available) and `voice.user.speech_started`. |
| N and pass rule | ≥ 200 interruptions from ≥ 40 sessions per channel in the reference condition; pass if the 95% CI upper bound of the median is < 300 ms. If the agent keeps talking for more than 2 s, that is a missed interruption: the event is counted with its observed value and also in §6.10. |
| If missed | Tune `vad_threshold`/wake policy [S3], verify browser echo cancellation, and check the jitter buffer depth. A missed gate blocks that channel's release. |

### 6.4 Tested business task completion (target ≥98%)

| Item | Definition |
|---|---|
| Unit | One scripted scenario run (one call or session) from the versioned catalog (§8.1). Example tasks: an hours or knowledge question, leaving a callback request, a transfer request, a mid-call correction. |
| Success | All scenario criteria hold: (a) the final DB state matches the expected records and fields; (b) the expected tool calls happened, with no forbidden or duplicate ones; (c) every outcome the agent stated matches `tool_runs`; (d) the call ended properly within the scenario's maximum duration. Scoring is automatic from the DB, tool runs and transcript, and every failure gets human review. |
| N and pass rule | Phase 3: ≥ 400 runs, observed ≥ 98%. Phases 5/6: ≥ 600 runs, Wilson LB ≥ 98%. Runs are spread over ≥ 40 scenarios and the standard condition matrix (§7.5); ≥ 15% of scenarios include a correction and ≥ 10% include an interruption during a tool turn. |
| If missed | Classify the failures (understanding, tool choice, arguments, turn-taking, provider). Fix prompts, tools or policy and re-run in full. Release is blocked. |

"Tested" means scenarios in the catalog. Completion on real-world traffic is a separate production metric and must not be reported as this one.

### 6.5 Confirmed contact-information accuracy (target ≥99%)

| Item | Definition |
|---|---|
| Unit | One critical field (name, phone, email, date/time, address) that the system persisted as confirmed. |
| Correct | The persisted value exactly equals the scenario ground truth after normalization (E.164; lower-cased email; ISO date in the tenant's timezone; structured address fields). |
| Guard | Capture rate (confirmed fields ÷ fields the scenario offered) is reported alongside accuracy, so a system cannot raise accuracy by declining to capture. Fields marked unconfirmed are counted in the capture rate, not the accuracy rate. |
| N and pass rule | Phase 3: ≥ 1000 fields from ≥ 250 calls, observed ≥ 99%. Phases 5/6: ≥ 1000 fields, Wilson LB ≥ 99%. Each field type has ≥ 150 samples and is reported separately; telephone email capture is expected to be the hardest. |
| If missed | Tighten spell-back, use DTMF for digits on the phone, and from Phase 4 use SMS-link confirmation for email. Release is blocked. |

### 6.6 Fabricated successful actions (target: zero in release evaluations)

| Item | Definition |
|---|---|
| Occurrence | Agent speech that was actually played (output transcript truncated at the interruption point) asserts that an action completed (booked, sent, saved, transferred, scheduled, "someone will call you") when the corresponding tool run was not `succeeded`. |
| Detection | Every assertion is cross-referenced against `tool_runs`/operations. A claim detector (rules plus a `gpt-6-luna` judge) flags candidates, and a human reviews every flag. A random 10% of unflagged action-bearing sessions are also reviewed to estimate detector recall. |
| N and pass rule | Action-bearing sessions per channel: Phase 2 ≥ 100 (≥ 30 with injected failures); Phase 3 ≥ 300 (≥ 100); Phases 5/6 ≥ 500 (≥ 150). Zero occurrences; report 3/N. Injected failures include tool failure, timeout -> `unknown`, DB outage and transfer failure (§8.4). |
| If missed | Release is blocked. Run an incident review, add a regression scenario and re-run the full suite. |

### 6.7 Duplicate external actions (target: zero in release evaluations)

| Item | Definition |
|---|---|
| Occurrence | More than one external side effect for one intended action, where the scenario script defines the intended count. Effects are counted **at the provider side**: test-account message logs, sandbox calendar/CRM records, REFER requests at the carrier or OpenAI. Our DB is not the count. |
| Before Phase 4 | Phase 2 has no external tools and Phase 3 has only transfer, so a test-only stub tool with `sideEffects: 'external'` is registered in test tenants. Its own call counter is the ground truth. |
| N and pass rule | Same session counts as §6.6, with ≥ 50 runs for each duplicate-provoking injection: caller repeats during a tool turn, sideband drop and replay, webhook redelivery, gateway restart mid-tool, timeout followed by a repeat request. Zero occurrences; report 3/N. Duplicate internal records (e.g. two callback requests) are reported as a diagnostic. |
| If missed | Release is blocked; root-cause and re-run the full suite. |

### 6.8 Cross-tenant exposure (target: zero)

| Item | Definition |
|---|---|
| Occurrence | Any data from organization A (knowledge, contacts, transcripts, configuration, usage) appears in organization B's session audio or transcript, tool results, persisted records or B-scoped logs, or any call or session is attributed to the wrong organization. |
| Method | Each tenant's knowledge and contacts are seeded with unique canary strings, and every transcript, tool output and record is scanned for other tenants' canaries. Routing tests send calls to multiple numbers across ≥ 3 tenants. Hostile inputs must all be rejected: forged `X-` or Diversion headers [S4][S5], invalid webhook signatures, replayed webhooks, and an org-A voice token used against org B. |
| N and pass rule | Phase 2: ≥ 50 sessions across ≥ 2 tenants plus every hostile case. Phases 3/5/6: ≥ 200 calls across ≥ 3 tenants plus ≥ 20 forged attempts per vector. Zero occurrences. |
| If missed | Treat as a security incident. All voice releases are blocked. |

### 6.9 Human-rated conversational naturalness (target ≥4.5/5)

| Item | Definition |
|---|---|
| Score | Overall naturalness on a 1–5 scale with anchors: 5 = indistinguishable in flow from a skilled human receptionist; 4 = natural with minor lapses; 3 = noticeably mechanical but usable; 2 = frequently awkward; 1 = unusable. Sub-scores for turn-taking, interruption handling, pacing/prosody, acknowledgments, clarity and error recovery are diagnostic. |
| Statistic | Mean of the per-conversation mean ratings, with a 95% CI from a bootstrap over conversations. Inter-rater agreement uses ordinal Krippendorff's α; if α < 0.6, the results are invalid and the rubric and rater training are revised. |
| N and pass rule | Per channel: ≥ 60 conversations stratified over the standard matrix, each rated by ≥ 3 of ≥ 8 raters. Phases 5/6 pass if mean ≥ 4.5, CI LB ≥ 4.3 and α ≥ 0.6. Method in §8.3. |
| If missed | Use the sub-scores to locate the problem. Levers: voice choice (28 voices [S3]), pacing instructions, filler wording. Release is blocked for Phases 5/6. |

### 6.10 Diagnostic metrics (reported every run, no target yet)

Connect-to-greeting time; premature responses (agent speaks before the caller has finished); caller cut-offs; false interruptions (the agent stops for injected noise or a backchannel); missed interruptions; time-to-substantive-answer on tool turns; tool duration P50/P95 by tool; transfer success rate; callback fallback rate; capture rate per field type; sideband gap count; duplicate internal records across redialled calls; active vs standby seconds per call; abandoned-call rate.

### 6.11 Instrumentation: voice events to add in Phase 2

These extend the normalized Phase 1.5 conventions (`ai.call.*`, `agent.turn.finished`, `agent.tool.*`, `usage.limit.enforced`). Every event carries `organizationId`, `agentId`, `conversationId`, `channel` (new values for voice and phone), our `interactionId`, and the provider `sessionId`. Names are provisional.

| Event | Key fields |
|---|---|
| `voice.session.created` / `voice.session.closed` | transport (`webrtc`/`sip`), model, delegation mode, voice, close reason [S3], duration, active/standby seconds |
| `voice.sideband.attached` / `.dropped` / `.reattached` | gap ms, replayed event count, deduped event count |
| `voice.user.speech_started` / `voice.user.speech_ended` | provider transcript start/end ms |
| `voice.response.audio_started` / `voice.response.interrupted` | server-observed latency since speech end, truncation point if reported |
| `agent.turn.finished` (voice) | existing fields plus speech-end -> audio-start (server-observed), interrupted flag, filler used |
| `voice.session.usage` | seconds from `session.usage.updated` / `session.closed` [S3] |
| `telephony.call.incoming` / `.accepted` / `.rejected` / `.ended` | `webhook-id` dedupe result, tenant resolved (bool), reject reason |
| `telephony.transfer.requested` / `.failed` | allowlisted destination id (never the raw number in logs) |
| `voice.client.playout_started` (browser beacon to our endpoint) | page-measured first remote audio frame; production proxy for listener latency |

Production dashboards label server-observed values as such. They are calibrated against harness listener measurements and never mixed with them.

## 7. Test conditions

### 7.1 Acoustic conditions (both channels)

| ID | Condition | Mix |
|---|---|---|
| N0 | Quiet | No added noise; corpus recorded at ≥ 35 dB SNR |
| N1 | Office babble | 15 dB SNR |
| N2 | Café / street | 10 dB SNR |
| N3 | Car / heavy traffic | 5 dB SNR |
| N4 | Transients | Coughs, door slams, TV speech and other voices, injected while the agent speaks (false-interruption test) |

SNR is computed over speech-active segments. Noise comes from openly licensed recordings (licence checked) and is mixed with a fixed seed, so every run is reproducible.

### 7.2 Browser network and device profiles

The harness host applies netem to both directions. Values are provisional, and the baseline RTT to OpenAI's media endpoint is measured and recorded.

| ID | Profile | Added RTT | Jitter | Loss | Bandwidth (down/up) |
|---|---|---|---|---|---|
| B0 | Good broadband | 20 ms | ±2 ms | 0% | 50/10 Mbps |
| M1 | Typical 4G | 60 ms | ±15 ms | 0.5% random | 10/3 Mbps |
| M2 | Degraded mobile | 150 ms | ±40 ms | 3% bursty (Gilbert-Elliott) | 1.5/0.5 Mbps |
| F1 | Severe (failure test) | 300 ms | ±80 ms | 8–10% bursty | 256 kbps |

Devices: headset; laptop built-in microphone and speakers, tested on an over-the-air rig so real echo paths exercise browser echo cancellation; phone browser (iOS and Android).

### 7.3 Telephone conditions

The harness endpoint is a SIP user agent on a separate carrier account that dials tenant numbers over the PSTN. A smaller set of calls comes from real handsets with recording equipment. The routes:

- PSTN mobile on ≥ 2 US carriers;
- landline or fixed VoIP;
- speakerphone or car hands-free (over the air);
- local and toll-free numbers.

The negotiated codec (PCMU/PCMA [S5]) and the call route are recorded per call. The harness reports the PSTN loopback baseline alongside every telephone latency result.

### 7.4 Accents and languages

- **English accents.** At least 6 accent groups, including at least 3 groups of non-native speakers. Each group has ≥ 2 human speakers, balanced by gender. Synthesized voices supplement human recordings and never replace them.
- **Languages.** Only GPT-Live's documented languages (en, pt, es, de, fr, hi, ja, ko [S3]) are candidates. English is evaluated first. Each further language needs its own run before any tenant can enable it for voice: ≥ 200 task runs (Wilson LB reported) and ≥ 300 contact fields, with language-appropriate spelling conventions, plus all safety metrics. Mid-call language switching is tested once multilingual tenants exist.

### 7.5 Condition sets used by gates

- **Reference conditions** (latency gates):
  - Browser: N0 + B0 + headset, English, all accent groups pooled.
  - Telephone: N0, mobile and landline pooled, English.
- **Standard matrix** (task-completion, accuracy and naturalness gates):
  - Browser: {N0, N1, N2} × {B0, M1}.
  - Telephone: {N0, N1, N2} × {mobile, landline}.
- **Robustness conditions** (reported, no target): N3, N4, M2, F1, speakerphone.
- **Safety metrics** (§6.6–6.8) gate under every condition, including failure injection.

## 8. Test plans

### 8.1 Reproducible audio tests

- **Corpus.** A versioned, content-hashed corpus of scripted caller audio. Each scenario has:
  - utterance segments with ground-truth transcripts and start/end marks;
  - expected slot values;
  - expected tool calls and final DB state;
  - interruption points.

  Segments are human-recorded (§7.4), supplemented by synthesized ones.
- **Reactive caller.** A state machine plays the next segment based on the agent's transcribed intent (for example, "asked for phone" plays the phone segment) after a configurable think time of 300–800 ms. An LLM-driven simulated caller may broaden coverage but is never used for gated metrics.
- **WebRTC harness.** Headless Chromium against the real widget page. A WebAudio graph replaces the microphone track, and the remote track is recorded through an AudioWorklet, so injection and capture share one `AudioContext` clock. Netem profiles apply as in §7.2.
- **SIP harness.** A SIP user agent that dials the tenant's Twilio number over the PSTN, plays the segments mixed with noise, and records both directions.
- **Deterministic tenants.** Fixture organizations with fixed knowledge, hours, timezone, allowlisted test transfer numbers and canaries. They are reset before every run.
- **Outputs per run.** A harness timeline joined to server events; two-channel recordings; transcripts; DB snapshots.

### 8.2 Real-provider evaluations

- **Systems under test.** Live runs of the corpus against `gpt-live-1.1` [S1], with the same tenants, conditions and scoring.
  - GPT-Live supports SIP natively (inbound and outbound, carrier trunks such as Twilio) [S4]: the Realtime API is no longer needed as a telephony fallback (updated 2026-11-26).
  - The Phase 2 spike also compares Responses delegation with client delegation (§13.4); Phase 3 measures the Twilio SIP -> GPT-Live path.
- **Run setup.**
  - Use a dedicated OpenAI project and API key, so the Costs API's daily buckets (grouped by project/API key [S2]) isolate evaluation spend.
  - Record model ids exactly as the provider returns them.
  - Pin the pricing snapshot (`AI_PRICING_VERSION`).

### 8.3 Human listening tests

| Element | Rule |
|---|---|
| Panel | ≥ 8 raters fluent in the test language. None of them works on the build under test. They are trained on the rubric with anchor clips before rating. |
| Material | Full two-channel recordings (caller left, agent right), stratified across scenarios and the standard matrix. Each channel has its own panel session. |
| Blinding | Raters do not know the build, model, delegation mode or condition. Order is randomized. Hidden anchors are included: a recorded human receptionist call as the upper anchor and a deliberately degraded clip as the lower anchor. Raters who score the anchors inconsistently are excluded, and the exclusion is recorded. |
| Comparisons | Builds, providers and delegation modes are compared with blind pairwise A/B preference tests (two-sided exact binomial test) in addition to absolute scores. |
| Participant ratings | ≥ 20 live participants talk to the agent and rate it on the same rubric. These ratings are reported next to the panel scores, and large gaps are investigated. They do not gate. |

### 8.4 Failure injection

| Fault | Injection | Required behaviour (pass = all safety metrics zero, plus this) |
|---|---|---|
| Provider disconnect | Cut the media path. Session closes with `connection_lost` [S3]. | Partial transcript persisted. Conversation ends with a reason. Browser offers reconnect or text chat. Tool runs are intact and unknowns are listed. |
| Sideband drop < 3 s | Kill the gateway WebSocket for 1 s | Reattach, replay deduped by `event_id` [S3], no transcript loss, no duplicate tool execution |
| Sideband drop > 3 s | Kill it for 10 s | Gap detected and marked. If the gateway cannot reattach, it ends the session cleanly. On the phone it refers the call to the configured fallback number (allowlisted, within hours) or hangs up through the REST API [S4], and records an abandoned call for staff follow-up. |
| Tool timeout | Delay the handler past its limit | A started side-effecting run becomes `unknown`. The agent says the action is unconfirmed, does not retry, and the operation appears in the unresolved list. |
| DB outage | Block DB connections for 30 s mid-call, and also at session start | In-call: reads fail softly, writes are never claimed, the transcript is buffered (bounded) then flushed or gap-marked, and the agent offers a callback or transfer. New sessions fail closed, because limits and metering cannot be reserved. |
| Twilio leg drop / caller hang-up | Drop the PSTN leg mid-tool | The tool completes and is recorded. Close reason is `remote_hangup`. No duplicate effect on redial. |
| Webhook redelivery | Re-send `live.transport.incoming` with the same `webhook-id` | Exactly one accept and one conversation [S4] |
| Gateway restart | Kill the process mid-tool | The lapsed claim becomes `unknown`. No duplicate effect. The call is ended or recovered cleanly. |
| Provider 429 / quota at session creation | Fault proxy | No premium-model switch. Browser falls back to text chat. Phone falls back to the fallback number or callback capture. Quota errors are not retried. |
| Spend or voice-minute limit reached | Lower the org limit | New sessions refused. A live call wraps up within a bounded grace period with a callback offer and is never cut mid-sentence. `usage.limit.enforced` is logged. |
| High latency / loss / jitter | M2, F1 and +2 s tool delay | Fillers occur. No premature success claim. Critical fields are re-asked rather than guessed. Repeated requests replay rather than re-execute. |

### 8.5 Cost-per-minute measurement

Each evaluation reports the following, per channel and split by component:

- **Cost per completed call:** total cost of all runs ÷ runs that completed their task (failures inflate it, deliberately);
- **Cost per connected minute;**
- mean active and standby seconds.

Unit prices were captured on 2026-11-26 and are applied through the pricing snapshot. Measured usage comes from provider events and billing records, never from assumptions.

| Component | Unit price (2026-11-26) | Usage source |
|---|---|---|
| GPT-Live `gpt-live-1.1` | $0.05/min active, $0.02/min standby, billed per second. WebRTC session creation bills 15 s up front, credited later [S2][S3]. | `session.usage.updated` / `session.closed` seconds [S3] |
| Backend model tokens | `gpt-6-luna` Standard: $0.10 in / $0.01 cached / $0.50 out per 1M tokens [S2]. A Responses-delegation backend model is billed at its own listed price. | Response usage objects -> `usage_records` |
| Input transcription | Billed separately [S2][S3]. The unit price is not in the 2026-11-26 snapshot; record it from [S2] at evaluation time. | Provider usage |
| Fallback `gpt-realtime-2.1` | Audio $32 in / $0.40 cached / $64 out per 1M tokens. User audio is 1 token per 100 ms and assistant audio 1 token per 50 ms. There is no official per-minute figure [S1][S2]. | Token usage, then converted to per-minute cost from measurements |
| Twilio Elastic SIP origination | $0.0034/min local, $0.013/min toll-free; termination $0.010/min; local number $1.15/month (US pages stated current as of Oct/Nov 2026) [S5] | Twilio call records (billed duration). Transfer-leg billing is confirmed in Phase 3. |
| SMS (Phase 4+) | $0.0083 per segment plus carrier fees; A2P 10DLC registration required [S5] | Twilio message records |

Reconciliation: estimates are compared against the OpenAI Costs API (daily buckets only [S2]) for the dedicated evaluation project, and against Twilio billing. Estimates are always labelled as estimates. Gateway compute is reported separately, and harness-leg carrier costs are excluded.

For illustration only (not a measurement): a 3-minute inbound call on a local number, all of it active, costs $0.15 for GPT-Live plus about $0.01 for Twilio origination, before backend tokens and transcription.

## 9. Evidence rules and the evaluation record

**Mock and fake tests are never evidence of voice quality.**

- Unit and integration tests with fake providers, fake audio or PGlite verify logic only: state machines, idempotency, fencing, tool paths. They must never be presented as latency, naturalness, accuracy or completion results.
- Only runs against real providers (and, for telephone, real PSTN calls) count. Each must be recorded with the methodology in this document.
- Synthesized caller audio replayed against the real provider counts as a real-provider run only when the record says so. It cannot be the sole basis for accent or noise conclusions.
- Every result is written to a dated evaluation record, committed under `evaluations/voice/YYYY-MM-DD-<channel>-<short-sha>.md`. The directory is created with the first real record.

```text
Evaluation record
- Date (UTC) / evaluators / record id
- Build: commit SHA, branch, gateway version, corpus version + hash, tenant fixture version
- Channel: browser | telephone          Phase gate targeted: 2 | 3 | 5 | 6
- Provider/model ids as returned: live model, backend model, delegation mode, voice,
  vad_threshold / wake policy, idle_timeout_s; carrier trunk, region, negotiated codec
- Pre-registered plan: metrics, N, conditions (§7 ids), statistic, pass rule
- Conditions actually run, with deviations and harness-fault exclusions (with reasons)
- Results per metric: N, point estimate, 95% interval (method), rule-of-three bound where zero
- Diagnostics (§6.10) and failure list with links to recordings/transcripts/tool runs
- Cost: per component, per completed call, per connected minute, pricing snapshot/version
- Gate verdict per metric: pass | fail | reported-only; overall pass/fail; sign-off
```

## 10. Release gates

"Report" means the metric must be measured and recorded with its interval; a miss does not block that phase. "Gate" means the release is blocked until the metric passes. **Zero-tolerance items gate every phase.** They also gate any later change that adds or modifies a tool, including Phase 4 booking and SMS.

| Metric | Phase 2 browser POC | Phase 3 telephone pilot | Phase 5 production web voice | Phase 6 outbound (telephone) |
|---|---|---|---|---|
| Median speech-to-response latency | Report | Report | Gate (§6.1) | Gate (§6.1) |
| P95 ordinary response latency | Report | Report | Gate (§6.2) | Gate (§6.2) |
| Interruption-to-audio-stop latency | Report | Report | Gate (§6.3) | Gate (§6.3) |
| Tested business task completion | Report | Gate: N ≥ 400, observed ≥ 98% | Gate: N ≥ 600, Wilson LB ≥ 98% | Gate: N ≥ 600, Wilson LB ≥ 98% (outbound scenarios) |
| Confirmed contact-information accuracy | Report | Gate: N ≥ 1000 fields, observed ≥ 99% | Gate: Wilson LB ≥ 99% | Gate: Wilson LB ≥ 99% |
| Fabricated successful actions | Gate: zero, N ≥ 100 | Gate: zero, N ≥ 300 | Gate: zero, N ≥ 500 | Gate: zero, N ≥ 500 |
| Duplicate external actions | Gate: zero (stub tool) | Gate: zero | Gate: zero | Gate: zero |
| Cross-tenant exposure | Gate: zero | Gate: zero | Gate: zero | Gate: zero |
| Human-rated naturalness | Report (≥ 20 conversations) | Report (≥ 60 conversations) | Gate (§6.9) | Gate (§6.9) |

Further conditions by phase:

- **Phase 2** also requires:
  - an evaluation record covering every metric for browser voice;
  - the Twilio SIP -> GPT-Live feasibility result (documented by OpenAI as of 2026-11-26; the live proof is S3.1);
  - the delegation-mode decision, with its measurements.
- **Phase 3:** telephone latency, interruption and naturalness results are disclosed to pilot tenants. They become gates in Phase 6 and before inbound telephone reaches general availability (Phase 7).
- **Phase 6** additionally requires the consent and compliance checks defined in its phase plan.

## 11. Open items to verify (spikes, not assumptions)

- Twilio Elastic SIP -> OpenAI SIP -> GPT-Live end to end (documented; not yet proven live): TLS/SRTP, Diversion and `X-` headers reaching `sip_headers`, REFER transfer [S4][S5].
- GPT-Live behaviours that are not documented: turn-detection/eagerness controls, noise reduction, transcription model choice, maximum WebRTC session length [S3].
- Whether a dropped GPT-Live session can be resumed, or must always be replaced by a new rehydrated session.
- The input transcription unit price and the Twilio transfer-leg billing.

## 12. Sources (accessed 2026-11-26)

- [S1] OpenAI models — https://developers.openai.com/api/docs/models
- [S2] OpenAI pricing — https://developers.openai.com/api/docs/pricing
- [S3] OpenAI GPT-Live guides — https://developers.openai.com/api/docs/guides/live, https://developers.openai.com/api/docs/guides/realtime-webrtc, https://developers.openai.com/api/docs/guides/voice-server-controls, https://developers.openai.com/api/docs/guides/live-delegation, https://developers.openai.com/api/docs/guides/live-conversations
- [S4] OpenAI SIP — https://developers.openai.com/api/docs/guides/voice-sip
- [S5] Twilio Elastic SIP Trunking — https://www.twilio.com/docs/sip-trunking, and Twilio US pricing pages (stated "current as of Oct/Nov 2026")

## 13. Phase 2 evaluation status (2026-11-26)

**No real-provider voice evaluation has been run.** The build environment had no OpenAI or Supabase credentials
(LIVE_VALIDATION.md §9). Nothing below is a measurement of voice quality, latency, accuracy or cost; there is no
evaluation record under `evaluations/voice/` yet.

### 13.1 Measured vs target

| Metric (§6) | Target | Measured | N | Conditions |
|---|---|---|---|---|
| Median speech-to-response latency | < 800 ms | **Not measured** (blocked: no credentials) | 0 | — |
| P95 ordinary response latency | < 1.5 s | **Not measured** | 0 | — |
| Interruption-to-audio-stop latency | < 300 ms | **Not measured** | 0 | — |
| Tested business task completion | ≥ 98% | **Not measured** | 0 | — |
| Confirmed contact-information accuracy | ≥ 99% | **Not measured** | 0 | — |
| Fabricated successful actions | 0 | **Not measured live**; logic covered by automated tests (below) | 0 live | — |
| Duplicate external actions | 0 | **Not measured live**; no external-effect tool exists yet (stub tool deferred) | 0 live | — |
| Cross-tenant exposure | 0 | **Not measured live**; RLS/composite-key matrix passes on PGlite | 0 live | — |
| Human-rated naturalness | ≥ 4.5/5 | **Not measured** | 0 | — |
| Cost per connected minute / per completed call | — (report) | **Not measured**; list-price estimate only: $0.05/min active, $0.02/min standby, plus backend tokens | 0 | — |

### 13.2 Instrumentation implemented (server-observed)

| Need (§6.11) | Implemented as | Gap |
|---|---|---|
| Session lifecycle, close reason, active/standby seconds | `voice.session.started` / `voice.session.ended` (status, reason, duration, provider or estimated seconds, cost, tool calls, interruptions, delegated turns, response-gap median/max); `voice_sessions` row | — |
| Speech start/end, response gap | `voice.turn.completed` per utterance with the provider's `startMs`/`endMs`; on agent turns `responseGapMs` = agent start − caller end (provider clock); the same fields on each transcript message | Excludes the network/playout leg to the listener: a server-observed proxy, not §6.1 listener latency |
| Interruptions | Barge-in inferred from transcript timing (caller speech starting before the agent's last words ended); message `interrupted: true`; per-session count | GPT-Live reports no interruption or audio-stop event: interruption-to-audio-stop needs the §8.1 harness |
| Tool timing | `voice.tool.completed` and `tool_runs.duration_ms` (channel `web_voice`) | — |
| Sideband gaps | `voice.sideband.disconnected`; sessions are settled, not re-attached | Re-attach within the 3 s replay window is not implemented |
| Browser playout | — | `voice.client.playout_started` beacon not implemented (Phase 5) |

### 13.3 Automated coverage (logic only; fake provider, not quality evidence)

| Scenario (Phase 2 brief) | Automated test | Real-audio evaluation |
|---|---|---|
| Normal conversation, transcript persistence, cleanup | `voice-sessions` lifecycle | Blocked |
| Interruptions | barge-in timing test (committed tool run kept) | Blocked |
| Pauses, silence | silence (120 s) close; standby is provider-side | Blocked |
| Background noise, accents | — (provider ASR/VAD; cannot be simulated meaningfully with a fake) | Blocked |
| Multiple questions, corrections | — (model behaviour) | Blocked |
| Knowledge retrieval | same executor path as chat (`searchKnowledge` chat tests); voice routes any tool through it | Blocked |
| Lead capture with read-back | captureLead refused on voice until `detailsConfirmed` | Blocked |
| Duplicate tool events | same `call_id` twice → one run, one output | Blocked |
| Provider errors | creation failure (nothing left behind), fatal error, close never confirmed | Blocked |
| Disconnects | sideband drop → failed with estimated usage, reservation and lock released | Blocked |
| Tenant isolation | cross-org end refused; `voice_sessions` RLS and composite keys | Blocked |
| Usage-limit enforcement | concurrency, start rate, spend reservation, session length | Blocked |
| Gateway crash recovery | stale session claimed once, closed, settled | Blocked |

### 13.4 Delegation comparison (S2.2) — evidence status

| Criterion | Responses delegation | Client delegation | Evidence |
|---|---|---|---|
| Response latency | Expected lower: OpenAI pre-warms the backend connection; no hop through our gateway | Expected higher: delegation event → our runtime (Postgres, ModelRouter, model call) → commentary append | Docs + architecture only; **not measured** |
| Tool latency | Sideband round trip to our executor | Executor in-process, but inside our model loop | Not measured |
| Naturalness | Voice model speaks backend output directly | Voice model paraphrases our text; delegation may fire before the transcript is final (we wait ≤ 2 s for it to settle) | Not measured |
| Interruption handling | Native; backend work continues (committed actions kept) | Native; our turn keeps running | Logic tested only |
| ModelRouter compatibility | Backend model chosen from our config (cheap model); no per-turn escalation | Full ModelRouter, escalation and context assembly | Code |
| Tenant authorization, idempotency, audit | Same executor (tenant from the session, fencing token, operation records) | Same executor | Automated tests |
| Context | Provider-held conversation; business rules pinned at start | Our ContextAssembler + rolling summary | Code |
| Usage accounting | Backend tokens from `response.completed` → `voice_delegation` records | Our runtime meters each call | Automated tests |
| Cost per resolved task | Voice seconds + backend tokens | Voice seconds + our model tokens (likely similar) | Not measured |
| Complexity | Lower (documented tool loop) | Higher (settling, commentary chunking, no done signal) | Code |

Selected (provisional): **Responses delegation**, on documentation and complexity grounds. The decision must be
confirmed or reversed by the V13 live comparison (LIVE_VALIDATION.md §9.4) before Phase 2 can close.
