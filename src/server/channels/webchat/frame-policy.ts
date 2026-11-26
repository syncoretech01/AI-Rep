import { serviceScope } from '@/server/db/scope';
import type { Database } from '@/server/db/types';
import { findPublishedWidget } from '@/server/domain/agents/repository';
import { parseAllowedOrigins } from '@/server/domain/agents/schemas';
import { WIDGET_KEY_PATTERN } from '@/shared/widget-protocol';

/**
 * Which sites may frame the widget page (CSP `frame-ancestors`), per widget key. This is a browser-enforced
 * embedding control, NOT authentication: the public API stays reachable by scripts, which the rate limits and the
 * organization spend limits bound.
 *
 * - Published widget with allowed sites: only those sites.
 * - Published widget without a list: any site (`*`), the default for new widgets.
 * - A configured list in which no entry is valid: nobody (fail closed, never "any site").
 * - Unknown, unpublished or paused widget, or a lookup failure: nobody (`'none'`); the page only says the chat is
 *   unavailable anyway.
 */
export function frameAncestorsPolicy(allowedOrigins: readonly string[] | null, configured = allowedOrigins !== null && allowedOrigins.length > 0): string {
  if (allowedOrigins === null) return "frame-ancestors 'none'";
  // Re-normalized: only bare origins (scheme, host, port) can reach the header.
  const origins = parseAllowedOrigins({ allowedOrigins });
  if (origins.length > 0) return `frame-ancestors ${origins.join(' ')}`;
  return configured ? "frame-ancestors 'none'" : 'frame-ancestors *';
}

/** The widget key of a `/widget/<key>` page path, or null for any other path. */
export function widgetKeyFromPath(pathname: string): string | null {
  const match = /^\/widget\/([^/]+)\/?$/.exec(pathname);
  const key = match?.[1] ?? null;
  return key !== null && WIDGET_KEY_PATTERN.test(key) ? key : null;
}

/** The CSP for the widget page at `pathname` (service-scope lookup by the public key only). */
export async function widgetFramePolicy(db: Database, pathname: string): Promise<string> {
  const key = widgetKeyFromPath(pathname);
  if (key === null) return frameAncestorsPolicy(null);
  const published = await serviceScope(db).run((sql) => findPublishedWidget(sql, key));
  if (!published) return frameAncestorsPolicy(null);
  return frameAncestorsPolicy(published.channel.allowedOrigins, published.channel.allowedOriginsConfigured);
}
