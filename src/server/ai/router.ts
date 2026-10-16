import type { AiConfig, TextModelProfile } from '@/server/config/env';
import type { Channel } from '@/server/domain/types';
import type { ProviderRegistry } from './registry';
import type { EmbeddingProvider, ReasoningEffort, TextModelProvider } from './types';

export type ModelTask = 'chat_response' | 'conversation_summary';

export interface TextRouteRequest {
  task: ModelTask;
  channel: Channel;
  complexity?: 'routine' | 'complex';
  /** A previous attempt on the default model failed (provider error or repeated invalid tool arguments). */
  priorFailure?: boolean;
}

export interface TextRoute {
  tier: 'default' | 'escalation';
  providerId: string;
  provider: TextModelProvider;
  model: string;
  /** Undefined when the profile is configured as 'default' (send no reasoning setting). */
  reasoningEffort: ReasoningEffort | undefined;
  /** Short machine-readable reason: 'default', 'escalation:prior_failure' or 'escalation:complex'. */
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
 * Policy (AI_RUNTIME.md "Initial production routing"):
 * - Everything runs on the cheap default profile unless escalation is explicitly justified.
 * - Summaries (and any other summary/classification task) always use the default profile.
 * - A chat response uses the escalation profile only when escalation is enabled AND either the
 *   default model already failed on this request or the caller classified the request as complex.
 * - Message length alone never escalates.
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
      if (request.priorFailure) return this.textRoute('escalation', this.config.escalation, 'escalation:prior_failure');
      if (request.complexity === 'complex') return this.textRoute('escalation', this.config.escalation, 'escalation:complex');
    }
    return this.textRoute('default', this.config.text, 'default');
  }

  selectEmbedding(): EmbeddingRoute {
    const { provider, model, dimensions } = this.config.embedding;
    return { providerId: provider, provider: this.registry.getEmbedding(provider), model, dimensions };
  }

  /** True when a retry on a stronger model is allowed for this task. */
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
