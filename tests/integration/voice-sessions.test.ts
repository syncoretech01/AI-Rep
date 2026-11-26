import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runChatTurn, type ChatRuntimeDeps } from '@/server/agent/runtime/chat-turn';
import { phase1Tools } from '@/server/agent/tools/definitions';
import { createToolExecutor } from '@/server/agent/tools/executor';
import { createToolRegistry } from '@/server/agent/tools/registry';
import { EmbeddingService } from '@/server/ai/embedding-service';
import { createProviderRegistry } from '@/server/ai/registry';
import { ModelRouter } from '@/server/ai/router';
import { loadAiConfig, loadVoiceConfig } from '@/server/config/env';
import { MAX_SILENCE_MS, createVoiceSessionManager, type Timers } from '@/server/channels/voice/manager';
import { listMessages } from '@/server/domain/conversations/service';
import { createCostEstimator } from '@/server/domain/usage/cost';
import { UsageLimitError, createUsageGuard } from '@/server/domain/usage/limits';
import { createUsageRecorder } from '@/server/domain/usage/service';
import { VoiceLimitError, getVoiceSession, openVoiceSession } from '@/server/domain/voice/sessions';
import { silentLogger } from '@/server/observability/logger';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { FakeEmbeddingProvider } from '../support/fake-embeddings';
import { FakeVoiceProvider } from '../support/fake-voice-provider';
import { createTenant, type TenantFixture } from '../support/fixtures';
import { FakeReceptionistModel, GREETING_REPLY } from '../support/receptionist-model';

/**
 * The voice engine (Phase 2) against real Postgres, the real tool executor and agent runtime, and a FAKE voice
 * provider: lifecycle, tool routing, idempotency, limits, cleanup and recovery. Not evidence of voice quality,
 * latency or provider behaviour (those need live runs; VOICE_QUALITY.md).
 */

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.close();
});

/** Timers the test fires by hand. */
class ManualTimers implements Timers {
  private next = 1;
  readonly timeouts = new Map<number, { fn: () => void; ms: number }>();
  readonly intervals = new Map<number, { fn: () => void; ms: number }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.timeouts.set(id, { fn, ms });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timeouts.delete(handle as number);
  }
  setInterval(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.intervals.set(id, { fn, ms });
    return id;
  }
  clearInterval(handle: unknown): void {
    this.intervals.delete(handle as number);
  }
  /** Fires (once) every pending timeout scheduled for exactly `ms`. */
  fire(ms: number): number {
    let fired = 0;
    for (const [id, timeout] of [...this.timeouts]) {
      if (timeout.ms !== ms) continue;
      this.timeouts.delete(id);
      timeout.fn();
      fired += 1;
    }
    return fired;
  }
  tickIntervals(): void {
    for (const interval of [...this.intervals.values()]) interval.fn();
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

async function createHarness(env: Record<string, string> = {}) {
  const ai = loadAiConfig({
    AI_TEXT_PROVIDER: 'cheap',
    AI_TEXT_MODEL: 'cheap-model',
    AI_ESCALATION_PROVIDER: 'strong',
    AI_ESCALATION_MODEL: 'strong-model',
    AI_EMBEDDING_PROVIDER: 'fake',
    AI_EMBEDDING_MODEL: 'fake-embed',
    ...env,
  });
  const voice = loadVoiceConfig({ VOICE_GATEWAY_SECRET: 'x'.repeat(40), ...env });
  const cheap = new FakeReceptionistModel('cheap');
  const registry = createProviderRegistry({
    text: { cheap: () => cheap, strong: () => new FakeReceptionistModel('strong') },
    embedding: { fake: () => new FakeEmbeddingProvider('fake') },
  });
  const router = new ModelRouter(ai, registry);
  const costs = createCostEstimator(ai.pricingOverrides);
  const usage = createUsageRecorder({ db: t.db, costs, logger: silentLogger, pricingVersion: 'test' });
  const guard = createUsageGuard({
    db: t.db,
    costs,
    logger: silentLogger,
    defaults: {
      dailySpendUsd: ai.spendLimits.dailyUsd,
      monthlySpendUsd: ai.spendLimits.monthlyUsd,
      maxConversationTurns: ai.budgets.maxConversationTurns,
    },
  });
  const embedder = new EmbeddingService({ router, usage, guard, retry: ai.retry, logger: silentLogger });
  const tools = createToolRegistry(phase1Tools);
  const executor = createToolExecutor({
    db: t.db,
    registry: tools,
    embedder,
    retrieval: { maxChunks: 3, maxTokens: 800, minSimilarity: 0.3 },
    logger: silentLogger,
  });
  const runtime: ChatRuntimeDeps = { db: t.db, router, tools, executor, usage, guard, ai, logger: silentLogger };
  const provider = new FakeVoiceProvider();
  const timers = new ManualTimers();
  let nowMs = 1_000_000;
  const manager = createVoiceSessionManager({
    db: t.db,
    provider,
    voice,
    ai,
    router,
    tools,
    executor,
    usage,
    guard,
    runChatTurn: (input, emit) => runChatTurn(runtime, input, emit),
    logger: silentLogger,
    gatewayInstance: 'gateway-test',
    clock: () => nowMs,
    timers,
    delegationSettleMs: 0,
  });
  const tenant: TenantFixture = await t.service.run((sql) => createTenant(sql));
  return {
    manager,
    provider,
    timers,
    tenant,
    cheap,
    advance: (ms: number) => {
      nowMs += ms;
    },
    start: () =>
      manager.start({ organizationId: tenant.org.id, agentId: tenant.agent.id, startedBy: tenant.owner.id, sdpOffer: 'v=0 offer' }),
    session: (id: string) => t.service.run((sql) => getVoiceSession(sql, tenant.org.id, id)),
    messages: (conversationId: string) => t.service.run((sql) => listMessages(sql, tenant.org.id, conversationId)),
    reservations: () =>
      t.db.query<{ amount: string }>('select amount from app_private.usage_reservations where organization_id = $1', [tenant.org.id]),
    lock: (conversationId: string) =>
      t.db.query<{ token: string | null }>('select turn_lock_token as token from public.conversations where id = $1', [conversationId]),
    usageRows: () =>
      t.db.query<{ kind: string; purpose: string; model: string; active_seconds: string | null; standby_seconds: string | null; estimated_cost_usd: string; metadata: Record<string, unknown> }>(
        `select kind, purpose, model, active_seconds, standby_seconds, estimated_cost_usd, metadata
         from public.usage_records where organization_id = $1 order by created_at, id`,
        [tenant.org.id],
      ),
    setLimits: (limits: { daily?: number; concurrent?: number; seconds?: number }) =>
      t.db.query(
        `insert into app_private.organization_limits (organization_id, daily_ai_spend_usd, max_concurrent_voice_sessions, max_voice_session_seconds)
         values ($1, $2, $3, $4)
         on conflict (organization_id) do update set daily_ai_spend_usd = excluded.daily_ai_spend_usd,
           max_concurrent_voice_sessions = excluded.max_concurrent_voice_sessions, max_voice_session_seconds = excluded.max_voice_session_seconds`,
        [tenant.org.id, limits.daily ?? null, limits.concurrent ?? null, limits.seconds ?? null],
      ),
  };
}

describe('voice session lifecycle (Responses delegation)', () => {
  it('creates a pinned provider session, routes a tool call through the executor, persists the transcript and settles everything on close', async () => {
    const h = await createHarness();
    const started = await h.start();

    // Pinned configuration, built from the shared agent instructions and tool registry.
    const [request] = h.provider.requests;
    expect(request).toMatchObject({ model: 'gpt-live-1.1', voice: 'marin', idleTimeoutSeconds: 20, sdpOffer: 'v=0 offer' });
    // The voice model gets its conversation and delegation policy; the business rules travel with the delegation.
    expect(request?.instructions).toContain('# Delegation policy');
    expect(request?.delegation).toMatchObject({
      mode: 'responses',
      model: 'cheap-model',
      instructions: expect.stringContaining('This is a live voice conversation') as unknown,
    });
    const toolNames = request?.delegation.mode === 'responses' ? request.delegation.tools.map((tool) => tool.name) : [];
    expect(toolNames).toEqual(['searchKnowledge', 'getBusinessInfo', 'getBusinessHours', 'captureLead']);
    expect(started).toMatchObject({ sdpAnswer: expect.stringContaining('answer-for-') as unknown, maxDurationSeconds: 600, delegation: 'responses' });
    expect(h.provider.attached).toEqual([`live_fake_${started.voiceSessionId}`]);

    const session = await h.session(started.voiceSessionId);
    expect(session).toMatchObject({ status: 'active', providerSessionId: `live_fake_${started.voiceSessionId}`, delegation: 'responses', gatewayInstance: 'gateway-test' });
    expect(await h.reservations()).toHaveLength(1);
    expect((await h.lock(started.conversationId))[0]?.token).not.toBeNull();

    const sideband = h.provider.sideband();
    sideband.emit({ type: 'session.started' });
    sideband.emit({ type: 'transcript.delta', role: 'user', text: 'When are you ' });
    sideband.emit({ type: 'transcript.delta', role: 'user', text: 'open?' });
    sideband.emit({ type: 'tool.call', callId: 'call_1', name: 'getBusinessHours', arguments: '{}' });
    await settle();
    expect(sideband.toolResults).toHaveLength(1);
    expect(JSON.parse(sideband.toolResults[0]!.output)).toMatchObject({ ok: true });
    sideband.emit({ type: 'transcript.delta', role: 'assistant', text: 'We are open on weekdays.' });

    expect(await h.manager.end(h.tenant.org.id, started.voiceSessionId)).toBe(true);

    expect(sideband.closeRequests).toBe(1);
    expect(sideband.disconnected).toBe(true);
    expect(h.manager.activeSessions()).toBe(0);
    expect(await h.session(started.voiceSessionId)).toMatchObject({
      status: 'ended',
      endReason: 'ended_by_user',
      activeSeconds: 12,
      standbySeconds: 3,
      usageSource: 'provider',
      // 12 s active at $0.05/min + 3 s standby at $0.02/min.
      estimatedCostUsd: 0.011,
    });
    expect(await h.reservations()).toEqual([]);
    expect((await h.lock(started.conversationId))[0]?.token).toBeNull();
    const messages = await h.messages(started.conversationId);
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'When are you open?'],
      ['tool_call', ''],
      ['tool_result', ''],
      ['assistant', 'We are open on weekdays.'],
    ]);
    const runs = await t.db.query<{ tool_name: string; channel: string; status: string }>(
      'select tool_name, channel, status from public.tool_runs where conversation_id = $1',
      [started.conversationId],
    );
    expect(runs).toEqual([{ tool_name: 'getBusinessHours', channel: 'web_voice', status: 'succeeded' }]);
    expect((await h.usageRows()).filter((row) => row.kind === 'voice_session')).toEqual([
      expect.objectContaining({ purpose: 'voice_session', model: 'gpt-live-1.1', active_seconds: '12.000', standby_seconds: '3.000', estimated_cost_usd: '0.01100000' }),
    ]);
  });

  it('executes a tool call once even when the provider delivers it twice', async () => {
    const h = await createHarness();
    const started = await h.start();
    const sideband = h.provider.sideband();
    sideband.emit({ type: 'tool.call', callId: 'call_dup', name: 'getBusinessInfo', arguments: '{}' });
    sideband.emit({ type: 'tool.call', callId: 'call_dup', name: 'getBusinessInfo', arguments: '{}' });
    await settle();
    expect(sideband.toolResults).toHaveLength(1);
    const runs = await t.db.query('select id from public.tool_runs where conversation_id = $1', [started.conversationId]);
    expect(runs).toHaveLength(1);
    await h.manager.end(h.tenant.org.id, started.voiceSessionId);
  });

  it('never saves contact details on voice before the caller confirmed the read-back', async () => {
    const h = await createHarness();
    const started = await h.start();
    const sideband = h.provider.sideband();
    const details = { name: 'Jane Doe', phone: '+1 555 123 4567', summary: 'Boiler repair' };
    sideband.emit({ type: 'tool.call', callId: 'call_a', name: 'captureLead', arguments: JSON.stringify(details) });
    await settle();
    expect(JSON.parse(sideband.toolResults[0]!.output)).toMatchObject({
      ok: false,
      error: { code: 'missing_information', details: { confirmationRequired: true } },
    });
    expect(await t.db.query('select id from public.leads where conversation_id = $1', [started.conversationId])).toEqual([]);

    sideband.emit({ type: 'tool.call', callId: 'call_b', name: 'captureLead', arguments: JSON.stringify({ ...details, detailsConfirmed: true }) });
    await settle();
    expect(JSON.parse(sideband.toolResults[1]!.output)).toMatchObject({ ok: true, saved: true });
    expect(await t.db.query('select channel from public.leads where conversation_id = $1', [started.conversationId])).toEqual([{ channel: 'web_voice' }]);
    await h.manager.end(h.tenant.org.id, started.voiceSessionId);
  });

  it('detects a barge-in from transcript timing and records it without retracting committed actions', async () => {
    const h = await createHarness();
    const started = await h.start();
    const sideband = h.provider.sideband();
    sideband.emit({ type: 'tool.call', callId: 'call_hours', name: 'getBusinessHours', arguments: '{}' });
    sideband.emit({ type: 'transcript.delta', role: 'assistant', text: 'We open at nine and', startMs: 5_000, endMs: 6_500 });
    // The caller starts talking before the agent's words ended: a barge-in (GPT-Live reports no interruption event).
    sideband.emit({ type: 'transcript.delta', role: 'user', text: 'Sorry, on Saturday?', startMs: 6_100, endMs: 7_000 });
    await settle();
    const messages = await h.messages(started.conversationId);
    expect(messages.find((message) => message.role === 'assistant')).toMatchObject({
      content: 'We open at nine and',
      data: { source: 'voice_transcript', interrupted: true, startMs: 5_000, endMs: 6_500 },
    });
    expect(await t.db.query("select status from public.tool_runs where conversation_id = $1", [started.conversationId])).toEqual([
      { status: 'succeeded' },
    ]);
    await h.manager.end(h.tenant.org.id, started.voiceSessionId);
  });
});

describe('turn timing', () => {
  it("records each utterance's provider timing and the response gap from the caller's last word to the agent's first", async () => {
    const h = await createHarness();
    const started = await h.start();
    const sideband = h.provider.sideband();
    sideband.emit({ type: 'transcript.delta', role: 'user', text: 'Do you ', startMs: 1_000, endMs: 1_400 });
    sideband.emit({ type: 'transcript.delta', role: 'user', text: 'fix boilers?', startMs: 1_400, endMs: 2_000 });
    sideband.emit({ type: 'transcript.delta', role: 'assistant', text: 'Yes, ', startMs: 2_650, endMs: 2_900 });
    sideband.emit({ type: 'transcript.delta', role: 'assistant', text: 'we do.', startMs: 2_900, endMs: 3_400 });
    sideband.emit({ type: 'transcript.delta', role: 'user', text: 'Great.', startMs: 4_500, endMs: 5_000 });
    await settle();
    const messages = await h.messages(started.conversationId);
    expect(messages.map((message) => [message.role, message.content, message.data])).toEqual([
      ['user', 'Do you fix boilers?', { source: 'voice_transcript', startMs: 1_000, endMs: 2_000 }],
      ['assistant', 'Yes, we do.', { source: 'voice_transcript', startMs: 2_650, endMs: 3_400, responseGapMs: 650 }],
    ]);
    await h.manager.end(h.tenant.org.id, started.voiceSessionId);
  });
});

describe('client delegation', () => {
  it('answers delegated turns through the shared agent runtime and hands the reply to the voice model', async () => {
    const h = await createHarness({ AI_VOICE_DELEGATION: 'client' });
    const started = await h.start();
    expect(h.provider.requests[0]?.delegation).toEqual({ mode: 'client' });
    const sideband = h.provider.sideband();

    sideband.emit({ type: 'transcript.delta', role: 'user', text: 'Hello there' });
    sideband.emit({ type: 'delegation.requested', delegationId: 'del_1' });
    sideband.emit({ type: 'delegation.requested', delegationId: 'del_1' });
    await settle();
    await settle();

    expect(sideband.delegatedReplies).toEqual([{ delegationId: 'del_1', text: GREETING_REPLY }]);
    // The runtime persisted the turn (one copy, on the voice channel) and metered its model call.
    const messages = await h.messages(started.conversationId);
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'Hello there'],
      ['assistant', GREETING_REPLY],
    ]);
    expect((await h.usageRows()).filter((row) => row.purpose === 'chat_response')).toHaveLength(1);
    await h.manager.end(h.tenant.org.id, started.voiceSessionId);
  });
});

describe('voice limits', () => {
  it('refuses a session beyond the concurrent-session limit, before calling the provider', async () => {
    const h = await createHarness({ VOICE_MAX_CONCURRENT_SESSIONS: '1' });
    const first = await h.start();
    await expect(h.start()).rejects.toBeInstanceOf(VoiceLimitError);
    expect(h.provider.requests).toHaveLength(1);
    expect(await h.reservations()).toHaveLength(1);
    await h.manager.end(h.tenant.org.id, first.voiceSessionId);
    // The slot is free again.
    const second = await h.start();
    await h.manager.end(h.tenant.org.id, second.voiceSessionId);
  });

  it('rate-limits session starts per organization (each creation is billed), before calling the provider', async () => {
    const h = await createHarness({ VOICE_SESSION_STARTS_PER_MINUTE: '1' });
    const first = await h.start();
    await h.manager.end(h.tenant.org.id, first.voiceSessionId);
    await expect(h.start()).rejects.toMatchObject({ name: 'VoiceLimitError', limit: 'session_starts' });
    expect(h.provider.requests).toHaveLength(1);
    expect(await h.reservations()).toEqual([]);
  });

  it('refuses a session the organization spend limit cannot cover, before creating anything', async () => {
    const h = await createHarness();
    await h.setLimits({ daily: 0.1 }); // a 600 s session reserves 600/60 x $0.05 = $0.50 plus delegated text
    await expect(h.start()).rejects.toBeInstanceOf(UsageLimitError);
    expect(h.provider.requests).toEqual([]);
    expect(await t.db.query('select id from public.voice_sessions where organization_id = $1', [h.tenant.org.id])).toEqual([]);
  });

  it('caps the session length with the organization override and closes it at the limit', async () => {
    const h = await createHarness();
    await h.setLimits({ seconds: 60 });
    const started = await h.start();
    expect(started.maxDurationSeconds).toBe(60);
    expect(h.timers.fire(60_000)).toBe(1);
    await settle();
    expect(await h.session(started.voiceSessionId)).toMatchObject({ status: 'ended', endReason: 'max_duration' });
    expect(h.manager.activeSessions()).toBe(0);
  });

  it('ends a silent (abandoned) session', async () => {
    const h = await createHarness();
    const started = await h.start();
    h.advance(MAX_SILENCE_MS + 1);
    h.timers.tickIntervals();
    await settle();
    expect(await h.session(started.voiceSessionId)).toMatchObject({ status: 'ended', endReason: 'silence' });
  });
});

describe('failures and cleanup', () => {
  it('settles everything when the provider refuses the session', async () => {
    const h = await createHarness();
    h.provider.failCreate = FakeVoiceProvider.outage();
    await expect(h.start()).rejects.toMatchObject({ code: 'unavailable' });
    const sessions = await t.db.query<{ status: string; end_reason: string; conversation_id: string }>(
      'select status, end_reason, conversation_id from public.voice_sessions where organization_id = $1',
      [h.tenant.org.id],
    );
    expect(sessions).toEqual([expect.objectContaining({ status: 'failed', end_reason: 'start_failed' })]);
    expect(await h.reservations()).toEqual([]);
    expect((await h.lock(sessions[0]!.conversation_id))[0]?.token).toBeNull();
    expect(h.manager.activeSessions()).toBe(0);
  });

  it('marks the session failed with estimated usage when the control connection drops', async () => {
    const h = await createHarness();
    const started = await h.start();
    h.advance(42_000);
    h.provider.sideband().drop();
    await settle();
    expect(await h.session(started.voiceSessionId)).toMatchObject({
      status: 'failed',
      endReason: 'sideband_lost',
      activeSeconds: 42,
      usageSource: 'estimated',
    });
    expect(await h.reservations()).toEqual([]);
  });

  it('fails the session on a fatal provider error', async () => {
    const h = await createHarness();
    const started = await h.start();
    h.provider.sideband().emit({ type: 'error', code: 'server_error', message: 'boom', fatal: true });
    await settle();
    expect(await h.session(started.voiceSessionId)).toMatchObject({ status: 'failed', endReason: 'provider_error:server_error' });
  });

  it('settles on its own when the provider never confirms the close', async () => {
    const h = await createHarness();
    const started = await h.start();
    const sideband = h.provider.sideband();
    sideband.closeWith = null;
    h.advance(5_000);
    const ending = h.manager.end(h.tenant.org.id, started.voiceSessionId);
    await settle();
    expect(h.timers.fire(8_000)).toBe(1);
    expect(await ending).toBe(true);
    expect(await h.session(started.voiceSessionId)).toMatchObject({ status: 'ended', usageSource: 'estimated', activeSeconds: 5 });
  });

  it("cannot be ended through another organization's id", async () => {
    const h = await createHarness();
    const other = await t.service.run((sql) => createTenant(sql));
    const started = await h.start();
    expect(await h.manager.end(other.org.id, started.voiceSessionId)).toBe(false);
    expect(h.manager.activeSessions()).toBe(1);
    await h.manager.end(h.tenant.org.id, started.voiceSessionId);
  });

  it('recovers a session whose gateway died: closes it at the provider and settles it exactly once', async () => {
    const h = await createHarness();
    const orphan = await t.service.run((sql) =>
      openVoiceSession(sql, {
        organizationId: h.tenant.org.id,
        agentId: h.tenant.agent.id,
        startedBy: null,
        provider: 'openai',
        model: 'gpt-live-1.1',
        voice: 'marin',
        delegation: 'responses',
        maxDurationSeconds: 600,
        maxConcurrentSessions: 5,
        gatewayInstance: 'dead-gateway',
      }),
    );
    await t.db.query(
      `update public.voice_sessions set status = 'active', provider_session_id = 'live_orphan', connected_at = now() - interval '10 minutes',
         last_event_at = now() - interval '5 minutes' where id = $1`,
      [orphan.id],
    );

    expect(await h.manager.recoverStaleSessions()).toBe(1);
    expect(await h.manager.recoverStaleSessions()).toBe(0);

    expect(h.provider.attached).toContain('live_orphan');
    expect(h.provider.sideband().closeRequests).toBe(1);
    const recovered = await h.session(orphan.id);
    expect(recovered).toMatchObject({ status: 'failed', endReason: 'gateway_lost', usageSource: 'estimated' });
    expect(recovered?.activeSeconds).toBeGreaterThanOrEqual(299);
    const voiceRows = (await h.usageRows()).filter((row) => row.kind === 'voice_session');
    expect(voiceRows).toHaveLength(1);
  });

  it('closes every live session on shutdown', async () => {
    const h = await createHarness();
    const a = await h.start();
    const b = await h.start();
    await h.manager.shutdown();
    expect(h.manager.activeSessions()).toBe(0);
    for (const id of [a.voiceSessionId, b.voiceSessionId]) {
      expect(await h.session(id)).toMatchObject({ status: 'ended', endReason: 'gateway_shutdown' });
    }
  });
});
