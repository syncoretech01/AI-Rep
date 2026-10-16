import { describe, expect, it } from 'vitest';
import { getClientIp, rateLimitSubject } from '@/server/channels/webchat/client-ip';

const ip = (headers: Record<string, string>) => getClientIp(new Headers(headers));

describe('getClientIp', () => {
  it('uses the first x-forwarded-for entry, trimmed', () => {
    expect(ip({ 'x-forwarded-for': '203.0.113.7' })).toBe('203.0.113.7');
    expect(ip({ 'x-forwarded-for': '  203.0.113.7 , 10.0.0.1, 10.0.0.2' })).toBe('203.0.113.7');
    expect(ip({ 'x-forwarded-for': '2001:DB8::1, 10.0.0.1' })).toBe('2001:db8::1');
  });

  it('prefers x-forwarded-for over x-real-ip and falls back to x-real-ip', () => {
    expect(ip({ 'x-forwarded-for': '203.0.113.7', 'x-real-ip': '198.51.100.9' })).toBe('203.0.113.7');
    expect(ip({ 'x-real-ip': ' 198.51.100.9 ' })).toBe('198.51.100.9');
    expect(ip({ 'x-forwarded-for': '', 'x-real-ip': '198.51.100.9' })).toBe('198.51.100.9');
    expect(ip({ 'x-forwarded-for': ', 203.0.113.7', 'x-real-ip': '198.51.100.9' })).toBe('198.51.100.9');
  });

  it('falls back to x-real-ip when the forwarded entry is garbage', () => {
    expect(ip({ 'x-forwarded-for': 'unknown', 'x-real-ip': '198.51.100.9' })).toBe('198.51.100.9');
    expect(ip({ 'x-forwarded-for': 'unknown', 'x-real-ip': 'also-garbage' })).toBeNull();
  });

  it('drops a port appended by the proxy and unwraps IPv4-mapped IPv6', () => {
    expect(ip({ 'x-forwarded-for': '203.0.113.7:51234' })).toBe('203.0.113.7');
    expect(ip({ 'x-forwarded-for': '[2001:db8::1]:443' })).toBe('2001:db8::1');
    expect(ip({ 'x-forwarded-for': '[2001:db8::1]' })).toBe('2001:db8::1');
    expect(ip({ 'x-forwarded-for': '::ffff:203.0.113.7' })).toBe('203.0.113.7');
    expect(ip({ 'x-forwarded-for': '::FFFF:CB00:7107' })).toBe('203.0.113.7');
    expect(ip({ 'x-forwarded-for': '0:0:0:0:0:ffff:203.0.113.7' })).toBe('203.0.113.7');
    expect(ip({ 'x-forwarded-for': '::1' })).toBe('::1');
    // Not IPv4-mapped: kept as IPv6.
    expect(ip({ 'x-forwarded-for': '::ffff:0:cb00:7107' })).toBe('::ffff:0:cb00:7107');
    expect(ip({ 'x-forwarded-for': '64:ff9b::203.0.113.7' })).toBe('64:ff9b::203.0.113.7');
  });

  it('returns null without usable headers', () => {
    expect(ip({})).toBeNull();
    const garbage = [
      'unknown',
      '999.1.1.1',
      '203.0.113',
      '203.0.113.7.8',
      '01.2.3.4',
      '<script>alert(1)</script>',
      '203.0.113.7:port',
      '203.0.113.7:123456',
      '[2001:db8::1',
      '[2001:db8::1]x',
      '[203.0.113.7]',
      'gggg::1',
      ' ',
      '1'.repeat(80),
      `${'1.'.repeat(5000)}1`,
    ];
    for (const value of garbage) {
      expect(ip({ 'x-forwarded-for': value })).toBeNull();
      expect(ip({ 'x-real-ip': value })).toBeNull();
    }
  });
});

describe('rateLimitSubject', () => {
  it('counts an IPv4 client (IPv4-mapped included) by its address', () => {
    expect(rateLimitSubject('203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitSubject('203.0.113.8')).toBe('203.0.113.8');
    expect(rateLimitSubject('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitSubject('::ffff:cb00:7107')).toBe('203.0.113.7');
  });

  it('counts an IPv6 client by its /64 network, however the address is written', () => {
    // One host routinely owns a whole /64: every address in it is the same client.
    const network = '2001:db8:1:2::/64';
    for (const address of [
      '2001:db8:1:2::1',
      '2001:db8:1:2:dead:beef:0:42',
      '2001:0DB8:0001:0002:FFFF:FFFF:FFFF:FFFF',
      '2001:db8:1:2::',
      '2001:db8:1:2::203.0.113.7',
      '[2001:db8:1:2::9]:443',
      ' 2001:db8:1:2::9 ',
      '2001:db8:1:2::1%eth0',
    ]) {
      expect(rateLimitSubject(address), address).toBe(network);
    }
    expect(rateLimitSubject('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64');
    expect(rateLimitSubject('2001:db8:1::2:3:4')).toBe('2001:db8:1:0::/64');
    expect(rateLimitSubject('1::2:3:4:5:6:7')).toBe('1:0:2:3::/64');
    expect(rateLimitSubject('::1')).toBe('0:0:0:0::/64');
    expect(rateLimitSubject('::')).toBe('0:0:0:0::/64');
    expect(rateLimitSubject('64:ff9b::203.0.113.7')).toBe('64:ff9b:0:0::/64');
  });

  it('returns null for anything that is not an address', () => {
    for (const value of ['', 'unknown', 'gggg::1', '2001:db8::1::2', '1:2:3:4:5:6:7:8:9', '999.1.1.1', `${'1:'.repeat(40)}1`]) {
      expect(rateLimitSubject(value), value).toBeNull();
    }
  });
});
