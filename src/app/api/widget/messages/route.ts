import { after } from 'next/server';
import { getAppServices } from '@/server/app-services';
import { getClientIp } from '@/server/channels/webchat/client-ip';
import { SSE_HEADERS, assertSameOrigin, errorResponse, readJsonBody } from '@/server/channels/webchat/http';
import { createLogger } from '@/server/observability/logger';
import type { AppServices } from '@/server/services';
import { sendMessageRequestSchema } from '@/shared/widget-protocol';

// One agent turn, streamed: the turn's deadline plus releasing its lock fit inside this budget, which stays
// below the turn lock's TTL. The post-turn rolling summary is best effort (a later turn retries it).
export const maxDuration = 60;

/** Public: sends a visitor message and streams the agent's reply as server-sent events. */
export async function POST(request: Request): Promise<Response> {
  let services: AppServices | undefined;
  try {
    assertSameOrigin(request);
    services = getAppServices();
    const body = await readJsonBody(request, sendMessageRequestSchema);
    const { stream, done } = await services.webChat.openMessageStream(body, { ip: getClientIp(request.headers) });
    // Keeps the function alive until the turn is persisted, even if the visitor disconnects mid-reply.
    after(() => done);
    return new Response(stream, { headers: SSE_HEADERS });
  } catch (error) {
    return errorResponse(error, services?.logger ?? createLogger());
  }
}
