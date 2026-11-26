import 'server-only';
import type { AgentEventSink } from '@/server/agent/runtime/events';
import { runChatTurn, type ChatRuntimeDeps, type ChatTurnInput, type ChatTurnOutcome } from '@/server/agent/runtime/chat-turn';
import { updateRollingSummary } from '@/server/agent/runtime/summary';
import { phase1Tools } from '@/server/agent/tools/definitions';
import { createToolExecutor, type ToolExecutor } from '@/server/agent/tools/executor';
import { createToolRegistry, type ToolRegistry } from '@/server/agent/tools/registry';
import type { Embedder } from '@/server/ai/embedder';
import { EmbeddingService } from '@/server/ai/embedding-service';
import { createProviderRegistry, type ProviderFactories } from '@/server/ai/registry';
import type { RetryOptions } from '@/server/ai/retry';
import { ModelRouter } from '@/server/ai/router';
import { createWebChatService, type WebChatService } from '@/server/channels/webchat/service';
import type { AiConfig, WidgetConfig } from '@/server/config/env';
import type { Database } from '@/server/db/types';
import { createCostEstimator } from '@/server/domain/usage/cost';
import { createUsageGuard, type UsageGuard } from '@/server/domain/usage/limits';
import { createUsageRecorder } from '@/server/domain/usage/service';
import type { UsageRecorder } from '@/server/domain/usage/types';
import type { Logger } from '@/server/observability/logger';

/**
 * Composition root: wires configuration, providers, metering, tools, the
 * channel-neutral agent runtime and the web chat channel. Used by the app
 * (through `getAppServices`), scripts and tests — never by domain code.
 */

export interface AppServices {
  db: Database;
  logger: Logger;
  ai: AiConfig;
  router: ModelRouter;
  embedder: Embedder;
  usage: UsageRecorder;
  /** Organization spend and conversation limits. */
  guard: UsageGuard;
  tools: ToolRegistry;
  toolExecutor: ToolExecutor;
  runChatTurn: (input: ChatTurnInput, emit: AgentEventSink) => Promise<ChatTurnOutcome>;
  webChat: WebChatService;
}

export interface CreateServicesOptions {
  db: Database;
  logger: Logger;
  ai: AiConfig;
  providers: ProviderFactories;
  widget: WidgetConfig;
  now?: () => Date;
  /** Test seam: jitter, waiting and clock of the provider retry policy. */
  retryEnvironment?: Pick<RetryOptions, 'random' | 'sleep' | 'clock'>;
}

export function createServices(options: CreateServicesOptions): AppServices {
  const { db, logger, ai, widget, now, retryEnvironment } = options;
  // Throws on a provider id that is configured but not registered: misconfiguration fails at startup.
  const router = new ModelRouter(ai, createProviderRegistry(options.providers));
  const costs = createCostEstimator(ai.pricingOverrides);
  const usage = createUsageRecorder({ db, costs, logger, pricingVersion: ai.pricingVersion });
  const guard = createUsageGuard({
    db,
    costs,
    logger,
    defaults: {
      dailySpendUsd: ai.spendLimits.dailyUsd,
      monthlySpendUsd: ai.spendLimits.monthlyUsd,
      maxConversationTurns: ai.budgets.maxConversationTurns,
    },
  });
  // An unpriced model is metered at $0, so spend limits cannot bound it: say so loudly at startup.
  const unpriced = [ai.text.model, ...(ai.escalation.enabled ? [ai.escalation.model] : [])].filter(
    (model) => !costs.text(model, { inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, reasoningTokens: 0 }).known,
  );
  if (!costs.embedding(ai.embedding.model, 1).known) unpriced.push(ai.embedding.model);
  if (unpriced.length > 0) {
    logger.error('usage.pricing_missing', { models: unpriced, hint: 'add them to AI_MODEL_PRICING_JSON; spend limits cannot bound unpriced models' });
  }
  const embedder = new EmbeddingService({ router, usage, guard, retry: ai.retry, retryEnvironment, logger });
  const tools = createToolRegistry(phase1Tools);
  const toolExecutor = createToolExecutor({
    db,
    registry: tools,
    embedder,
    retrieval: {
      maxChunks: ai.budgets.maxRetrievedChunks,
      maxTokens: ai.budgets.maxRetrievedTokens,
      minSimilarity: ai.budgets.minRetrievalSimilarity,
    },
    logger,
  });

  const runtime: ChatRuntimeDeps = { db, router, tools, executor: toolExecutor, usage, guard, ai, logger, now, retryEnvironment };
  const runTurn = (input: ChatTurnInput, emit: AgentEventSink) => runChatTurn(runtime, input, emit);

  const webChat = createWebChatService({
    db,
    logger,
    widget,
    now,
    runTurn,
    // Rolling summary after each completed turn; it logs and swallows its own failures.
    afterTurn: async (params) => {
      await updateRollingSummary({ db, router, usage, guard, ai, logger }, params);
    },
  });

  return { db, logger, ai, router, embedder, usage, guard, tools, toolExecutor, runChatTurn: runTurn, webChat };
}
