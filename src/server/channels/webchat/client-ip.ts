import { isIP } from 'node:net';

/**
 * Client IP for rate limiting (never stored raw: callers hash it).
 *
 * Trust assumption: the app runs behind the hosting platform's proxy (e.g.
 * Vercel), which sets `x-forwarded-for` / `x-real-ip` from the real connection,
 * so their first entry is the client. `next start` fills `x-forwarded-for` from
 * the socket only when it is absent; a self-hosted deployment must therefore sit
 * behind a proxy that overwrites these headers, or clients can choose their IP.
 */

/** Longest textual address we accept (an IPv6 address with an embedded IPv4 part and brackets/port fits easily). */
const MAX_ADDRESS_CHARS = 64;
const PORT = /^\d{1,5}$/;

/** The first valid address from `x-forwarded-for` (first entry), else `x-real-ip`; null when neither is usable. */
export function getClientIp(headers: Headers): string | null {
  const candidates = [headers.get('x-forwarded-for')?.split(',', 1)[0], headers.get('x-real-ip')];
  for (const candidate of candidates) {
    const ip = candidate ? normalizeAddress(candidate) : null;
    if (ip !== null) return ip;
  }
  return null;
}

/**
 * What a per-client rate limit counts: an IPv4 address (IPv4-mapped IPv6 included) on its own, an IPv6 address
 * by its /64 network ("2001:db8:1:2::/64"). A single subscriber routinely gets a whole /64, so counting single
 * IPv6 addresses would let one host rotate through them to dodge the limit. Null when `ip` is not an address.
 */
export function rateLimitSubject(ip: string): string | null {
  const address = normalizeAddress(ip);
  if (address === null || isIP(address) !== 6) return address;
  const network = hextetsOf(address)
    .slice(0, 4)
    .map((group) => group.toString(16));
  return `${network.join(':')}::/64`;
}

/**
 * Basic IPv4/IPv6 shape check (node:net, no regexes over untrusted text). Some proxies append the
 * client port ("1.2.3.4:5678", "[2001:db8::1]:443"): it is dropped, otherwise every connection
 * would count as a different client. IPv4-mapped IPv6 addresses become plain IPv4.
 */
function normalizeAddress(raw: string): string | null {
  let value = raw.trim();
  if (value === '' || value.length > MAX_ADDRESS_CHARS) return null;

  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    const rest = end === -1 ? '' : value.slice(end + 1);
    if (end === -1 || (rest !== '' && !(rest.startsWith(':') && PORT.test(rest.slice(1))))) return null;
    value = value.slice(1, end);
    return isIP(value) === 6 ? canonicalV6(value) : null;
  }

  const colon = value.indexOf(':');
  if (colon !== -1 && colon === value.lastIndexOf(':')) {
    // Exactly one colon: an IPv4 address with a port.
    if (!PORT.test(value.slice(colon + 1))) return null;
    value = value.slice(0, colon);
    return isIP(value) === 4 ? value : null;
  }

  const version = isIP(value);
  if (version === 4) return value;
  return version === 6 ? canonicalV6(value) : null;
}

/** Lowercase; an IPv4-mapped address (::ffff:a.b.c.d, also written in hex) becomes plain IPv4. */
function canonicalV6(value: string): string {
  const groups = hextetsOf(value);
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const [high = 0, low = 0] = groups.slice(6);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
  }
  return value.toLowerCase();
}

/**
 * The eight 16-bit groups of an address `isIP` accepts as IPv6: '::' expanded, a dotted IPv4 tail split
 * into two groups, a zone id ("%eth0") ignored. Linear string operations only.
 */
function hextetsOf(address: string): number[] {
  const [text = ''] = address.split('%', 1);
  const parse = (part: string): number[] =>
    part === ''
      ? []
      : part.split(':').flatMap((group) => {
          if (!group.includes('.')) return [Number.parseInt(group, 16)];
          const [a = 0, b = 0, c = 0, d = 0] = group.split('.').map(Number);
          return [(a << 8) | b, (c << 8) | d];
        });
  const gap = text.indexOf('::');
  if (gap === -1) return parse(text);
  const head = parse(text.slice(0, gap));
  const tail = parse(text.slice(gap + 2));
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}
