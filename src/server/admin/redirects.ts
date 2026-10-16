/**
 * Redirect helpers for the sign-in flow and the admin app. Pure: shared by the proxy, pages, Server
 * Actions and the /auth/confirm route (unit-tested).
 */

const MAX_PATH_CHARS = 2048;
const MAX_HOST_CHARS = 255;
// Throwaway base for the final same-origin check; `.invalid` can never resolve.
const PROBE_ORIGIN = 'http://redirect.invalid';
// One character class plus anchors: linear on any input (the header length is capped first).
const HOST_PATTERN = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;
const LOCAL_HOST_PATTERN = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;

/**
 * A same-site path such as '/o/acme/agents' (normalized), otherwise `fallback`.
 * Rejects absolute URLs ('https://…', 'javascript:…') and protocol-relative ones ('//evil'), plus any
 * backslash, whitespace or control character: browsers read '/\evil' as '//evil' and silently drop
 * tabs and newlines, so those would also leave the site. Dot segments are resolved first: the Next.js
 * router turns a Server Action redirect to '/..//evil' into the href '//evil' and follows it off-site.
 */
export function safeNextPath(value: string | null | undefined, fallback = '/'): string {
  if (typeof value !== 'string' || value === '' || value.length > MAX_PATH_CHARS) return fallback;
  if (!value.startsWith('/') || value.startsWith('//')) return fallback;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f || code === 0x5c) return fallback;
  }
  let url: URL;
  try {
    url = new URL(value, PROBE_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== PROBE_ORIGIN || url.pathname.startsWith('//')) return fallback;
  // The normalized form is what browsers and the router navigate to, so it is what gets returned.
  const path = `${url.pathname}${url.search}${url.hash}`;
  return path.length > MAX_PATH_CHARS ? fallback : path;
}

/** `path`, carrying a non-default `next` destination as `?next=` (e.g. from /login to /signup). */
export function withNextParam(path: string, next: string): string {
  return next === '/' ? path : `${path}?next=${encodeURIComponent(next)}`;
}

/** Pages that need a signed-in user; the proxy sends anonymous visitors to /login first. */
export function requiresSignIn(pathname: string): boolean {
  return (
    pathname === '/onboarding' || pathname.startsWith('/onboarding/') || pathname === '/o' || pathname.startsWith('/o/')
  );
}

/** The sign-in page, returning to `pathname` + `search` afterwards. */
export function loginRedirectPath(pathname: string, search: string): string {
  return withNextParam('/login', safeNextPath(`${pathname}${search}`));
}

/** First value of a Next.js search param (`?next=a&next=b` arrives as an array). */
export function firstSearchParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function firstHeaderValue(header: string | null): string | null {
  const first = header?.split(',')[0]?.trim() ?? '';
  return first === '' ? null : first;
}

/**
 * Public origin of the current request (e.g. 'https://app.example.com'), from the headers the hosting proxy
 * sets (x-forwarded-host / x-forwarded-proto) or the Host header, or null when they are missing or malformed.
 * Used to build links that leave the app (embed snippet, confirmation email); Supabase only redirects to
 * allow-listed URLs, so a forged Host header cannot send confirmation links elsewhere.
 */
export function requestOrigin(headers: { get(name: string): string | null }): string | null {
  const host = firstHeaderValue(headers.get('x-forwarded-host')) ?? firstHeaderValue(headers.get('host'));
  if (host === null || host.length > MAX_HOST_CHARS || !HOST_PATTERN.test(host)) return null;
  const forwardedProto = firstHeaderValue(headers.get('x-forwarded-proto'))?.toLowerCase();
  const proto =
    forwardedProto === 'http' || forwardedProto === 'https'
      ? forwardedProto
      : LOCAL_HOST_PATTERN.test(host)
        ? 'http'
        : 'https';
  return `${proto}://${host.toLowerCase()}`;
}
