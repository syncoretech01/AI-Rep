import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { loadLogLevel } from '@/server/config/env';
import { getDatabase } from '@/server/db/client';
import { createLogger, type Logger } from '@/server/observability/logger';
import { frameAncestorsPolicy, widgetFramePolicy } from './frame-policy';

let logger: Logger | undefined;

/**
 * Runs in the proxy for `/widget/<key>`: sets the page's Content-Security-Policy `frame-ancestors` from the widget's
 * allowed sites (frame-policy.ts). A failed lookup fails closed (`'none'`): the page cannot render without the
 * database anyway.
 */
export async function widgetFrameResponse(request: NextRequest): Promise<NextResponse> {
  logger ??= createLogger({ level: loadLogLevel() }).child({ module: 'webchat' });
  let policy: string;
  try {
    policy = await widgetFramePolicy(getDatabase(logger), request.nextUrl.pathname);
  } catch (error) {
    logger.error('webchat.frame_policy_failed', { error });
    policy = frameAncestorsPolicy(null);
  }
  const response = NextResponse.next();
  response.headers.set('Content-Security-Policy', policy);
  return response;
}
