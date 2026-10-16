import 'server-only';
import { createDefaultProviderFactories } from '@/server/ai/providers';
import { loadAiConfig, loadLogLevel, loadOpenAIConfig, loadWidgetConfig } from '@/server/config/env';
import { getDatabase } from '@/server/db/client';
import { createLogger } from '@/server/observability/logger';
import { createServices, type AppServices } from './services';

/**
 * Cached per module instance, not on globalThis: after a dev HMR reload the services are rebuilt
 * with the edited code, while the connection pool stays shared through `getDatabase`'s own
 * globalThis cache (so reloads never open another pool).
 */
let services: AppServices | undefined;

/**
 * The process-wide services, built from the environment on first use (so `next build` never
 * needs runtime secrets). Invalid configuration throws a clear error.
 */
export function getAppServices(): AppServices {
  if (!services) {
    // Every section is validated before any connection is opened.
    const logger = createLogger({ level: loadLogLevel() });
    const ai = loadAiConfig();
    const providers = createDefaultProviderFactories({ openai: loadOpenAIConfig(), ai });
    const widget = loadWidgetConfig();
    services = createServices({ db: getDatabase(logger), logger, ai, providers, widget });
  }
  return services;
}
