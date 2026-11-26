import 'server-only';
import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import { hostname } from 'node:os';
import { createDefaultProviderFactories, createDefaultVoiceProvider } from '@/server/ai/providers';
import { createGatewayServer } from '@/server/channels/voice/gateway-http';
import { createVoiceSessionManager, type VoiceSessionManager } from '@/server/channels/voice/manager';
import { loadAiConfig, loadLogLevel, loadOpenAIConfig, loadVoiceConfig, loadWidgetConfig } from '@/server/config/env';
import { getDatabase } from '@/server/db/client';
import { createLogger, type Logger } from '@/server/observability/logger';
import { createServices } from './services';

/**
 * Composition root of the voice gateway: the persistent Node process that holds GPT-Live sidebands (ARCHITECTURE.md
 * §18). It reuses the app's services (router, tools, executor, metering, limits, agent runtime) and exposes the
 * signaling API that the Next.js routes call with the shared gateway secret. Started by `npm run voice:gateway`.
 */

/** Sessions whose gateway stopped heartbeating are recovered this often (and once at startup). */
const RECOVERY_INTERVAL_MS = 60_000;

export interface RunningVoiceGateway {
  manager: VoiceSessionManager;
  server: http.Server;
  logger: Logger;
  /** Stops accepting sessions, ends the live ones and closes the database pool. */
  stop(): Promise<void>;
}

export async function startVoiceGateway(): Promise<RunningVoiceGateway> {
  // Every section is validated before any connection is opened.
  const logger = createLogger({ level: loadLogLevel() });
  const ai = loadAiConfig();
  const openai = loadOpenAIConfig();
  const voice = loadVoiceConfig();
  const secret = voice.gateway.secret;
  if (!secret) throw new Error('VOICE_GATEWAY_SECRET is not configured (at least 32 characters, shared with the app)');
  const provider = createDefaultVoiceProvider({ openai, ai, voice });
  const db = getDatabase(logger);
  const services = createServices({
    db,
    logger,
    ai,
    providers: createDefaultProviderFactories({ openai, ai }),
    widget: loadWidgetConfig(),
  });

  const manager = createVoiceSessionManager({
    db,
    provider,
    voice,
    ai,
    router: services.router,
    tools: services.tools,
    executor: services.toolExecutor,
    usage: services.usage,
    guard: services.guard,
    runChatTurn: services.runChatTurn,
    logger,
    gatewayInstance: `${hostname()}:${String(process.pid)}:${randomUUID().slice(0, 8)}`,
  });

  const sweep = () => {
    manager.recoverStaleSessions().catch((error: unknown) => {
      logger.error('voice.recovery.failed', { error: error instanceof Error ? error.message : String(error) });
    });
  };
  sweep();
  const recovery = setInterval(sweep, RECOVERY_INTERVAL_MS);
  recovery.unref();

  const server = createGatewayServer({ manager, secret, logger });
  const host = new URL(voice.gateway.url).hostname;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(voice.gateway.port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  logger.info('voice.gateway.listening', {
    host,
    port: voice.gateway.port,
    model: voice.model,
    delegation: voice.delegation,
  });

  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      clearInterval(recovery);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await manager.shutdown();
      await db.close();
    })();
    return stopping;
  };
  return { manager, server, logger, stop };
}
