import { describe, expect, it } from 'vitest';
import { loadDatabaseConfig } from '@/server/config/env';
import { pgConnectionOptions } from '@/server/db/postgres';

const REMOTE = 'postgresql://postgres.ref:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres';
const PEM = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ\n-----END CERTIFICATE-----';

describe('database TLS configuration', () => {
  it('uses TLS for remote hosts by default and plaintext only for local ones', () => {
    expect(loadDatabaseConfig({ DATABASE_URL: REMOTE }).tls).toEqual({ mode: 'require' });
    expect(loadDatabaseConfig({ DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' }).tls).toEqual({
      mode: 'disable',
    });
    expect(loadDatabaseConfig({ DATABASE_URL: 'postgres://u:p@localhost/db' }).tls).toEqual({ mode: 'disable' });
  });

  it('verifies the server certificate when a CA is configured (literal \\n sequences accepted)', () => {
    const escaped = PEM.replaceAll('\n', '\\n');
    expect(loadDatabaseConfig({ DATABASE_URL: REMOTE, DATABASE_SSL_CA: escaped }).tls).toEqual({ mode: 'verify', ca: PEM });
    expect(loadDatabaseConfig({ DATABASE_URL: REMOTE, DATABASE_SSL: 'verify', DATABASE_SSL_CA: PEM }).tls).toEqual({
      mode: 'verify',
      ca: PEM,
    });
  });

  it('honours explicit modes and rejects an unusable configuration', () => {
    expect(loadDatabaseConfig({ DATABASE_URL: REMOTE, DATABASE_SSL: 'disable' }).tls).toEqual({ mode: 'disable' });
    expect(loadDatabaseConfig({ DATABASE_URL: 'postgres://u:p@localhost/db', DATABASE_SSL: 'require' }).tls).toEqual({
      mode: 'require',
    });
    expect(() => loadDatabaseConfig({ DATABASE_URL: REMOTE, DATABASE_SSL: 'verify' })).toThrow(/DATABASE_SSL_CA/);
    expect(() => loadDatabaseConfig({ DATABASE_URL: REMOTE, DATABASE_SSL_CA: 'not a certificate' })).toThrow(/PEM/);
  });
});

describe('pgConnectionOptions', () => {
  it('maps TLS modes to node-postgres options', () => {
    expect(pgConnectionOptions({ url: REMOTE, poolMax: 1, tls: { mode: 'disable' } }).ssl).toBe(false);
    expect(pgConnectionOptions({ url: REMOTE, poolMax: 1, tls: { mode: 'require' } }).ssl).toEqual({ rejectUnauthorized: false });
    expect(pgConnectionOptions({ url: REMOTE, poolMax: 1, tls: { mode: 'verify', ca: PEM } }).ssl).toEqual({
      ca: PEM,
      rejectUnauthorized: true,
    });
  });

  it('strips TLS URL parameters (which would override the options) and keeps everything else', () => {
    const url = `${REMOTE}?sslmode=require&sslrootcert=/tmp/ca.pem&application_name=x&uselibpqcompat=true`;
    const { connectionString } = pgConnectionOptions({ url, poolMax: 1, tls: { mode: 'verify', ca: PEM } });
    const parsed = new URL(connectionString);
    expect([...parsed.searchParams.keys()]).toEqual(['application_name']);
    expect(parsed.username).toBe('postgres.ref');
    expect(parsed.password).toBe('secret');
    expect(parsed.host).toBe('aws-0-us-east-1.pooler.supabase.com:6543');
    expect(parsed.pathname).toBe('/postgres');
  });
});
