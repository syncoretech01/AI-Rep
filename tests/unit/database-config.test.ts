import { describe, expect, it } from 'vitest';
import { isUnverifiedRemoteDatabase, loadDatabaseConfig } from '@/server/config/env';
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

  it('requires VERIFIED TLS to a remote database in production', () => {
    const production = { NODE_ENV: 'production', DATABASE_URL: REMOTE };
    expect(() => loadDatabaseConfig(production)).toThrow(/production requires verified TLS/);
    expect(() => loadDatabaseConfig({ ...production, DATABASE_SSL: 'require' })).toThrow(/production requires verified TLS/);
    expect(() => loadDatabaseConfig({ ...production, DATABASE_SSL: 'disable' })).toThrow(/production requires verified TLS/);
    expect(loadDatabaseConfig({ ...production, DATABASE_SSL_CA: PEM }).tls).toEqual({ mode: 'verify', ca: PEM });
    // A database on the same machine (e.g. a local Supabase stack behind `next start`) needs no certificate.
    expect(loadDatabaseConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@localhost/db' }).tls).toEqual({
      mode: 'disable',
    });
  });

  it('refuses host/hostaddr query parameters, which would redirect the connection behind the TLS check', () => {
    for (const url of [
      'postgres://u:p@localhost:5432/postgres?host=db.remote.example.com',
      'postgres://u:p@localhost/postgres?sslmode=disable&hostaddr=203.0.113.9',
    ]) {
      expect(() => loadDatabaseConfig({ NODE_ENV: 'production', DATABASE_URL: url }), url).toThrow(/host or hostaddr/);
    }
    // Defense in depth: the connection options never carry them either.
    const options = pgConnectionOptions({ url: `${REMOTE}?host=evil.example`, poolMax: 1, tls: { mode: 'disable' } });
    expect(options.connectionString).not.toContain('evil.example');
  });

  it('flags unverified remote connections (scripts such as db:migrate refuse them unless explicitly allowed)', () => {
    expect(isUnverifiedRemoteDatabase(loadDatabaseConfig({ DATABASE_URL: REMOTE }))).toBe(true);
    expect(isUnverifiedRemoteDatabase(loadDatabaseConfig({ DATABASE_URL: REMOTE, DATABASE_SSL_CA: PEM }))).toBe(false);
    expect(isUnverifiedRemoteDatabase(loadDatabaseConfig({ DATABASE_URL: 'postgres://u:p@127.0.0.1/db' }))).toBe(false);
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
