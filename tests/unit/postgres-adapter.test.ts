import { beforeEach, describe, expect, it, vi } from 'vitest';

// A fake node-postgres: records statements and release() arguments, and can fail chosen statements.
const fake = vi.hoisted(() => {
  const state = {
    statements: [] as string[],
    released: [] as boolean[],
    failOn: new Set<string>(),
    poolOptions: undefined as unknown,
    idleErrorHandlers: [] as Array<(error: Error) => void>,
  };
  const run = (text: string) => {
    state.statements.push(text);
    if (state.failOn.has(text)) throw new Error(`failed: ${text}`);
  };
  class FakeClient {
    query(text: string): Promise<{ rows: unknown[] }> {
      run(text);
      return Promise.resolve({ rows: [] });
    }
    release(destroy?: boolean): void {
      state.released.push(destroy ?? false);
    }
  }
  class FakePool {
    constructor(options: unknown) {
      state.poolOptions = options;
    }
    on(event: string, handler: (error: Error) => void): this {
      if (event === 'error') state.idleErrorHandlers.push(handler);
      return this;
    }
    connect(): Promise<FakeClient> {
      return Promise.resolve(new FakeClient());
    }
    query(text: string, params: unknown[]): Promise<{ rows: unknown[] }> {
      run(text);
      return Promise.resolve({ rows: [{ params }] });
    }
    end(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { state, FakePool };
});

vi.mock('pg', () => ({ default: { Pool: fake.FakePool } }));

const { createPostgresDatabase } = await import('@/server/db/postgres');

const CONFIG = {
  url: 'postgresql://postgres.ref:secret@db.example.supabase.co:6543/postgres?sslmode=require',
  poolMax: 3,
  tls: { mode: 'require' as const },
};

beforeEach(() => {
  fake.state.statements = [];
  fake.state.released = [];
  fake.state.failOn = new Set();
  fake.state.idleErrorHandlers = [];
});

describe('createPostgresDatabase', () => {
  it('configures the pool from DatabaseConfig with TLS from config, not the URL', () => {
    createPostgresDatabase(CONFIG);
    expect(fake.state.poolOptions).toMatchObject({
      connectionString: 'postgresql://postgres.ref:secret@db.example.supabase.co:6543/postgres',
      ssl: { rejectUnauthorized: false },
      max: 3,
    });
  });

  it('commits a successful transaction and returns the callback result', async () => {
    const db = createPostgresDatabase(CONFIG);
    const result = await db.transaction(async (tx) => {
      await tx.query('select 1');
      return 'done';
    });
    expect(result).toBe('done');
    expect(fake.state.statements).toEqual(['begin', 'select 1', 'commit']);
    expect(fake.state.released).toEqual([false]);
  });

  it('rolls back and rethrows the original error when the callback fails', async () => {
    const db = createPostgresDatabase(CONFIG);
    const boom = new Error('boom');
    await expect(
      db.transaction(async (tx) => {
        await tx.query('select 1');
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(fake.state.statements).toEqual(['begin', 'select 1', 'rollback']);
    expect(fake.state.released).toEqual([false]);
  });

  it('destroys the client (release(true)) when the rollback itself fails', async () => {
    fake.state.failOn.add('rollback');
    const db = createPostgresDatabase(CONFIG);
    const boom = new Error('boom');
    await expect(db.transaction(() => Promise.reject(boom))).rejects.toBe(boom);
    expect(fake.state.released).toEqual([true]);
  });

  it('rolls back when the commit fails', async () => {
    fake.state.failOn.add('commit');
    const db = createPostgresDatabase(CONFIG);
    await expect(db.transaction((tx) => tx.query('select 1'))).rejects.toThrow('failed: commit');
    expect(fake.state.statements).toEqual(['begin', 'select 1', 'commit', 'rollback']);
    expect(fake.state.released).toEqual([false]);
  });

  it('passes parameters through and survives idle-client errors', async () => {
    const warn = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: vi.fn() };
    const db = createPostgresDatabase(CONFIG, logger);
    expect(warn).toHaveBeenCalledWith('db.tls_unverified', expect.any(Object));

    const rows = await db.query<{ params: unknown[] }>('select $1::text', ['x']);
    expect(rows).toEqual([{ params: ['x'] }]);

    for (const handler of fake.state.idleErrorHandlers) handler(new Error('connection terminated'));
    expect(warn).toHaveBeenCalledWith('db.idle_client_error', expect.any(Object));
  });
});
