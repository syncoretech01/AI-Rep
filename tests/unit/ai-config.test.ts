import { describe, expect, it } from 'vitest';
import { DEFAULT_RETRY_POLICY } from '@/server/ai/retry';
import { loadAiConfig, loadVoiceConfig } from '@/server/config/env';
import { PRICING_SNAPSHOT_DATE } from '@/server/config/pricing';

/** Phase 1.5 AI runtime settings: model defaults, retry policy and cost controls, all from configuration. */

describe('loadAiConfig', () => {
  it('defaults to the cheap model for routine work and the current Sol model for escalation', () => {
    const ai = loadAiConfig({});
    expect(ai.text).toEqual({ provider: 'openai', model: 'gpt-6-luna', reasoningEffort: 'low' });
    expect(ai.escalation).toEqual({ enabled: true, provider: 'openai', model: 'gpt-6.2-sol', reasoningEffort: 'medium' });
    expect(ai.embedding).toEqual({ provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 });
  });

  it('has bounded retries, per-turn and per-conversation caps, spend limits and a dated price list by default', () => {
    const ai = loadAiConfig({});
    expect(ai.retry).toEqual(DEFAULT_RETRY_POLICY);
    expect(ai.budgets).toMatchObject({
      maxToolRounds: 4,
      maxToolCallsPerTurn: 6,
      maxTurnTokens: 40_000,
      maxConversationTurns: 100,
      maxEscalatedCallsPerConversation: 6,
    });
    expect(ai.spendLimits).toEqual({ dailyUsd: 10, monthlyUsd: 150 });
    expect(ai.pricingVersion).toBe(PRICING_SNAPSHOT_DATE);
  });

  it('reads every limit from the environment and validates it', () => {
    const ai = loadAiConfig({
      AI_PROVIDER_MAX_RETRIES: '0',
      AI_MAX_TOOL_CALLS_PER_TURN: '2',
      AI_MAX_TURN_TOKENS: '9000',
      AI_MAX_CONVERSATION_TURNS: '30',
      AI_MAX_ESCALATED_CALLS_PER_CONVERSATION: '0',
      AI_ORG_DAILY_SPEND_LIMIT_USD: '2.5',
      AI_ORG_MONTHLY_SPEND_LIMIT_USD: '40',
      AI_PRICING_VERSION: 'contract-2027-01',
    });
    expect(ai.retry.maxRetries).toBe(0);
    expect(ai.budgets).toMatchObject({
      maxToolCallsPerTurn: 2,
      maxTurnTokens: 9000,
      maxConversationTurns: 30,
      maxEscalatedCallsPerConversation: 0,
    });
    expect(ai.spendLimits).toEqual({ dailyUsd: 2.5, monthlyUsd: 40 });
    expect(ai.pricingVersion).toBe('contract-2027-01');

    for (const env of [
      { AI_PROVIDER_MAX_RETRIES: '9' },
      { AI_MAX_TOOL_CALLS_PER_TURN: '0' },
      { AI_MAX_TURN_TOKENS: '100' },
      { AI_ORG_DAILY_SPEND_LIMIT_USD: '-1' },
      { AI_MAX_CONVERSATION_TURNS: 'many' },
    ]) {
      expect(() => loadAiConfig(env), JSON.stringify(env)).toThrow(/Invalid AI configuration/);
    }
  });
});

describe('loadVoiceConfig', () => {
  it('defaults to GPT-Live with Responses delegation, bounded sessions and the developer page off', () => {
    expect(loadVoiceConfig({})).toEqual({
      provider: 'openai',
      model: 'gpt-live-1.1',
      voice: 'marin',
      delegation: 'responses',
      delegationModel: undefined,
      maxSessionSeconds: 600,
      maxConcurrentSessions: 2,
      sessionStartsPerMinute: 6,
      idleTimeoutSeconds: 20,
      delegatedTextReservePerMinuteUsd: 0.01,
      gateway: { url: 'http://127.0.0.1:4100', port: 4100, secret: undefined },
      devPageEnabled: false,
    });
  });

  it('reads overrides and refuses unsafe values', () => {
    const voice = loadVoiceConfig({
      AI_VOICE_MODEL: 'gpt-live-1',
      AI_VOICE_DELEGATION: 'client',
      AI_VOICE_DELEGATION_MODEL: 'backend-model',
      VOICE_MAX_SESSION_SECONDS: '120',
      VOICE_GATEWAY_SECRET: 's'.repeat(32),
      VOICE_DEV_ENABLED: 'true',
    });
    expect(voice).toMatchObject({ model: 'gpt-live-1', delegation: 'client', delegationModel: 'backend-model', maxSessionSeconds: 120, devPageEnabled: true });
    for (const env of [
      { AI_VOICE_DELEGATION: 'browser' },
      { VOICE_MAX_SESSION_SECONDS: '0' },
      { VOICE_IDLE_TIMEOUT_SECONDS: '120' },
      { VOICE_GATEWAY_SECRET: 'short' },
      { VOICE_SESSION_STARTS_PER_MINUTE: '0' },
    ]) {
      expect(() => loadVoiceConfig(env), JSON.stringify(env)).toThrow(/Invalid voice configuration/);
    }
  });
});
