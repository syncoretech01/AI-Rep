/**
 * Runs the voice gateway: the persistent process that creates GPT-Live sessions from browser WebRTC offers and holds
 * their server-side control connections (ARCHITECTURE.md §18). The Next.js app forwards signaling to it.
 *
 *   npm run voice:gateway
 *
 * Needs DATABASE_URL, OPENAI_API_KEY and VOICE_GATEWAY_SECRET (the same secret the app uses to call it); see
 * .env.example for the AI_VOICE_* and VOICE_* settings. SIGINT/SIGTERM end every live session before exiting.
 */
import { startVoiceGateway, type RunningVoiceGateway } from '@/server/voice-gateway';

/** `.env.local` wins over `.env`; variables already set in the environment win over both. */
function loadEnvFiles(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
    } catch {
      // Missing file: nothing to load.
    }
  }
}

async function main(): Promise<void> {
  loadEnvFiles();
  let gateway: RunningVoiceGateway;
  try {
    gateway = await startVoiceGateway();
  } catch (error) {
    console.error(`Voice gateway failed to start: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  const shutdown = (signal: string) => {
    gateway.logger.info('voice.gateway.stopping', { signal, liveSessions: gateway.manager.activeSessions() });
    gateway.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        gateway.logger.error('voice.gateway.stop_failed', { error: error instanceof Error ? error.message : String(error) });
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

await main();
