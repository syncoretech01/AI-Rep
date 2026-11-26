import type { AiConfig, TextModelProfile } from '@/server/config/env';
import type { Channel } from '@/server/domain/types';
import type { ProviderRegistry } from './registry';
import type { EmbeddingProvider, ReasoningEffort, TextModelProvider } from './types';

export type ModelTask = 'chat_response' | 'conversation_summary';

/**
 * Demonstrated model-quality failures of the default model in the current request — the only failures that justify
 * the stronger model. Infrastructure failures (rate limits, timeouts, outages) are NOT here: they are retried on
 * the same model (src/server/ai/retry.ts) and never escalate.
 */
export type QualityFailure =
  /** The model kept producing tool arguments that failed validation (or named tools it was not given). */
  | 'invalid_tool_calls'
  /** The model returned neither text nor a tool call. */
  | 'empty_response';

export interface TextRouteRequest {
  task: ModelTask;
  channel: Channel;
  /** Set by a caller that has demonstrated the request needs stronger reasoning. */
  complexity?: 'routine' | 'complex';
  /** The default model already failed on quality in this request. */
  qualityFailure?: QualityFailure;
}

export interface TextRoute {
  tier: 'default' | 'escalation';
  providerId: string;
  provider: TextModelProvider;
  model: string;
  /** Undefined when the profile is configured as 'default' (send no reasoning setting). */
  reasoningEffort: ReasoningEffort | undefined;
  /** Short machine-readable reason: 'default', 'escalation:quality:<failure>' or 'escalation:complex'. */
  reason: string;
}

export interface EmbeddingRoute {
  providerId: string;
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
}

/**
 * Chooses which configured provider/model serves a task. It selects
 * configuration only — prompts, tools and domain behavior never change with the route.
 *
 * Policy (AI_RUNTIME.md "Model routing"):
 * - Everything runs on the cheap default profile unless escalation is explicitly justified.
 * - Summaries (and any other summary/classification task) always use the default profile.
 * - A chat response uses the escalation profile only when escalation is enabled AND either the default model
 *   demonstrably failed on quality in this request or the caller established that the request is complex.
 * - Provider unavailability, rate limits and timeouts never escalate (they are retried on the same model), and
 *   message length alone never escalates.
 *
 * Future provider failover belongs next to this class: a same-tier alternative route tried by the retry layer
 * after the primary provider's retries are exhausted. It is deliberately not implemented with one provider.
 */
export class ModelRouter {
  private readonly config: AiConfig;
  private readonly registry: ProviderRegistry;

  constructor(config: AiConfig, registry: ProviderRegistry) {
    const unknown: string[] = [];
    if (!registry.hasText(config.text.provider)) {
      unknown.push(`text provider "${config.text.provider}" (AI_TEXT_PROVIDER)`);
    }
    // A disabled escalation profile is never routed to, so its provider need not be registered.
    if (config.escalation.enabled && !registry.hasText(config.escalation.provider)) {
      unknown.push(`escalation provider "${config.escalation.provider}" (AI_ESCALATION_PROVIDER)`);
    }
    if (!registry.hasEmbedding(config.embedding.provider)) {
      unknown.push(`embedding provider "${config.embedding.provider}" (AI_EMBEDDING_PROVIDER)`);
    }
    if (unknown.length > 0) {
      throw new Error(`AI configuration references unregistered providers: ${unknown.join('; ')}`);
    }
    this.config = config;
    this.registry = registry;
  }

  selectText(request: TextRouteRequest): TextRoute {
    if (this.canEscalate(request.task)) {
      if (request.qualityFailure) {
        return this.textRoute('escalation', this.config.escalation, `escalation:quality:${request.qualityFailure}`);
      }
      if (request.complexity === 'complex') return this.textRoute('escalation', this.config.escalation, 'escalation:complex');
    }
    return this.textRoute('default', this.config.text, 'default');
  }

  selectEmbedding(): EmbeddingRoute {
    const { provider, model, dimensions } = this.config.embedding;
    return { providerId: provider, provider: this.registry.getEmbedding(provider), model, dimensions };
  }

  /** True when escalating to the stronger model is allowed for this task. */
  canEscalate(task: ModelTask): boolean {
    return this.config.escalation.enabled && task === 'chat_response';
  }

  private textRoute(tier: TextRoute['tier'], profile: TextModelProfile, reason: string): TextRoute {
    return {
      tier,
      providerId: profile.provider,
      provider: this.registry.getText(profile.provider),
      model: profile.model,
      reasoningEffort: profile.reasoningEffort === 'default' ? undefined : profile.reasoningEffort,
      reason,
    };
  }
}
