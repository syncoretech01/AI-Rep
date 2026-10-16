import { getAppServices } from '@/server/app-services';
import { getClientIp } from '@/server/channels/webchat/client-ip';
import { assertSameOrigin, errorResponse, jsonResponse, readJsonBody } from '@/server/channels/webchat/http';
import { createLogger } from '@/server/observability/logger';
import type { AppServices } from '@/server/services';
import { sessionRequestSchema } from '@/shared/widget-protocol';

/** Public: starts or restores a visitor session for a published widget (returns a SessionResponse). */
export async function POST(request: Request): Promise<Response> {
  let services: AppServices | undefined;
  try {
    assertSameOrigin(request);
    services = getAppServices();
    const body = await readJsonBody(request, sessionRequestSchema);
    const session = await services.webChat.startSession(body, { ip: getClientIp(request.headers) });
    return jsonResponse(session);
  } catch (error) {
    return errorResponse(error, services?.logger ?? createLogger());
  }
}
