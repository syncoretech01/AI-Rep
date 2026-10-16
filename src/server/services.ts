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
import { ModelRouter } from '@/server/ai/router';
import { createWebChatService, type WebChatService } from '@/server/channels/webchat/service';
import type { AiConfig, WidgetConfig } from '@/server/config/env';
import type { Database } from '@/server/db/types';
import { createCostEstimator } from '@/server/domain/usage/cost';
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
}

export function createServices(options: CreateServicesOptions): AppServices {
  const { db, logger, ai, widget, now } = options;
  // Throws on a provider id that is configured but not registered: misconfiguration fails at startup.
  const router = new ModelRouter(ai, createProviderRegistry(options.providers));
  const usage = createUsageRecorder({ db, costs: createCostEstimator(ai.pricingOverrides), logger });
  const embedder = new EmbeddingService({ router, usage, logger });
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

  const runtime: ChatRuntimeDeps = { db, router, tools, executor: toolExecutor, usage, ai, logger, now };
  const runTurn = (input: ChatTurnInput, emit: AgentEventSink) => runChatTurn(runtime, input, emit);

  const webChat = createWebChatService({
    db,
    logger,
    widget,
    now,
    runTurn,
    // Rolling summary after each completed turn; it logs and swallows its own failures.
    afterTurn: async (params) => {
      await updateRollingSummary({ db, router, usage, ai, logger }, params);
    },
  });

  return { db, logger, ai, router, embedder, usage, tools, toolExecutor, runChatTurn: runTurn, webChat };
}
