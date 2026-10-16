import { getAppServices } from '@/server/app-services';
import { getClientIp } from '@/server/channels/webchat/client-ip';
import { assertSameOrigin, errorResponse, jsonResponse, readJsonBody } from '@/server/channels/webchat/http';
import { createLogger } from '@/server/observability/logger';
import type { AppServices } from '@/server/services';
import { resetRequestSchema } from '@/shared/widget-protocol';

/** Public: closes the visitor's conversation ("New chat"); the next message starts a new one. */
export async function POST(request: Request): Promise<Response> {
  let services: AppServices | undefined;
  try {
    assertSameOrigin(request);
    services = getAppServices();
    const body = await readJsonBody(request, resetRequestSchema);
    const result = await services.webChat.resetConversation(body, { ip: getClientIp(request.headers) });
    return jsonResponse(result);
  } catch (error) {
    return errorResponse(error, services?.logger ?? createLogger());
  }
}
