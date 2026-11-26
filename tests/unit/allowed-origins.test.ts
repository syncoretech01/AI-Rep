import { describe, expect, it } from 'vitest';
import { frameAncestorsPolicy, widgetKeyFromPath } from '@/server/channels/webchat/frame-policy';
import {
  MAX_ALLOWED_ORIGINS,
  allowedOriginsInputSchema,
  normalizeAllowedOrigin,
  parseAllowedOrigins,
} from '@/server/domain/agents/schemas';

/**
 * Allowed sites for the web chat widget: a browser-enforced embedding control (CSP frame-ancestors), not
 * authentication. Every value that reaches the header is a normalized bare origin.
 */

describe('normalizeAllowedOrigin', () => {
  it('accepts bare https origins (any case, trailing slash, port) and https wildcard subdomains', () => {
    expect(normalizeAllowedOrigin('https://www.Example.com/')).toBe('https://www.example.com');
    expect(normalizeAllowedOrigin('  https://shop.example.co.uk:8443  ')).toBe('https://shop.example.co.uk:8443');
    expect(normalizeAllowedOrigin('https://*.example.com')).toBe('https://*.example.com');
    expect(normalizeAllowedOrigin('https://xn--bcher-kva.example')).toBe('https://xn--bcher-kva.example');
  });

  it('accepts http only for local development hosts', () => {
    expect(normalizeAllowedOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeAllowedOrigin('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(normalizeAllowedOrigin('http://example.com')).toBeNull();
  });

  it('refuses anything that is not a bare origin or could inject into the CSP header', () => {
    for (const value of [
      '',
      'example.com',
      'https://example.com/path',
      'https://example.com?x=1',
      'https://example.com#top',
      'https://user:pass@example.com',
      'javascript:alert(1)',
      'data:text/html,hi',
      'ftp://example.com',
      'https://*',
      'https://*.com',
      'https://a.*.example.com',
      "https://example.com; script-src 'unsafe-inline'",
      'https://example.com https://evil.example',
      "'self'",
      '*',
      `https://${'a'.repeat(200)}.com`,
    ]) {
      expect(normalizeAllowedOrigin(value), value).toBeNull();
    }
  });
});

describe('allowedOriginsInputSchema', () => {
  it('parses one site per line (commas and spaces also separate), dropping duplicates', () => {
    expect(allowedOriginsInputSchema.parse('https://www.example.com\nhttps://WWW.example.com/, https://*.example.org')).toEqual([
      'https://www.example.com',
      'https://*.example.org',
    ]);
    expect(allowedOriginsInputSchema.parse('   ')).toEqual([]);
  });

  it('names the first invalid entry and caps the list', () => {
    const invalid = allowedOriginsInputSchema.safeParse('https://ok.example\nexample.com/shop');
    expect(invalid.success).toBe(false);
    expect(invalid.error?.issues[0]?.message).toBe('"example.com/shop" is not a website address. Use the form https://www.example.com.');
    const tooMany = Array.from({ length: MAX_ALLOWED_ORIGINS + 1 }, (_, i) => `https://site${i}.example`).join('\n');
    expect(allowedOriginsInputSchema.safeParse(tooMany).error?.issues[0]?.message).toBe(`List at most ${MAX_ALLOWED_ORIGINS} sites.`);
  });
});

describe('parseAllowedOrigins (stored config, read leniently)', () => {
  it('keeps valid origins only and never throws', () => {
    expect(parseAllowedOrigins({ allowedOrigins: ['https://a.example', 'bad', 7, 'https://a.example', 'https://b.example/'] })).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
    for (const config of [null, undefined, 'x', {}, { allowedOrigins: 'https://a.example' }, []]) {
      expect(parseAllowedOrigins(config)).toEqual([]);
    }
  });
});

describe('frameAncestorsPolicy', () => {
  it('allows any site without a list, only the listed sites with one, and nobody for unavailable widgets', () => {
    expect(frameAncestorsPolicy([])).toBe('frame-ancestors *');
    expect(frameAncestorsPolicy(['https://www.example.com', 'https://*.example.org'])).toBe(
      'frame-ancestors https://www.example.com https://*.example.org',
    );
    expect(frameAncestorsPolicy(null)).toBe("frame-ancestors 'none'");
    // Defense in depth: a damaged stored value never reaches the header.
    expect(frameAncestorsPolicy(["https://ok.example; script-src 'unsafe-inline'", 'https://ok.example'])).toBe(
      'frame-ancestors https://ok.example',
    );
    // A configured list with no valid entry restricts embedding to nobody, never to everybody.
    expect(frameAncestorsPolicy(['www.example.com', 'javascript:alert(1)'])).toBe("frame-ancestors 'none'");
    expect(frameAncestorsPolicy([], true)).toBe("frame-ancestors 'none'");
    expect(frameAncestorsPolicy([], false)).toBe('frame-ancestors *');
  });

  it('extracts the widget key of /widget/<key> page paths only', () => {
    const key = `wk_${'A'.repeat(24)}`;
    expect(widgetKeyFromPath(`/widget/${key}`)).toBe(key);
    expect(widgetKeyFromPath(`/widget/${key}/`)).toBe(key);
    for (const path of ['/widget/', '/widget/not-a-key', `/widget/${key}/extra`, `/api/widget/${key}`, '/']) {
      expect(widgetKeyFromPath(path), path).toBeNull();
    }
  });
});
