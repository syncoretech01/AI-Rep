import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isForeignKeyViolation,
  isPermissionDenied,
  isUniqueViolation,
  isUuid,
  jsonParam,
  truncateText,
} from '@/server/db/sql';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { addMember, createAgent, createAuthUser, createOrganization } from '../support/fixtures';

const LONE_HIGH = String.fromCharCode(0xd83d);
const LONE_LOW = String.fromCharCode(0xde00);
const EMOJI = '\u{1F600}';
const NUL = String.fromCharCode(0);

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.close();
});

describe('jsonParam', () => {
  it('produces JSON that Postgres jsonb accepts even with NUL and lone surrogates', async () => {
    const value = {
      text: `a${NUL}b`,
      cut: `emoji cut ${LONE_HIGH}`,
      low: `${LONE_LOW} tail`,
      nested: [{ arg: `x${NUL}${LONE_HIGH}y` }],
      emoji: `kept ${EMOJI}`,
      literal: '\\u0000 and \\ud83d stay literal text',
    };
    const rows = await t.db.query<{ value: Record<string, unknown> }>('select $1::jsonb as value', [jsonParam(value)]);
    expect(rows[0]?.value).toEqual({
      text: 'ab',
      cut: 'emoji cut \u{FFFD}',
      low: '\u{FFFD} tail',
      nested: [{ arg: 'x\u{FFFD}y' }],
      emoji: `kept ${EMOJI}`,
      literal: '\\u0000 and \\ud83d stay literal text',
    });
  });

  it('serializes undefined as JSON null', () => {
    expect(jsonParam(undefined)).toBe('null');
  });
});

describe('Postgres error classifiers', () => {
  async function captureError(run: () => Promise<unknown>): Promise<unknown> {
    try {
      await run();
    } catch (error) {
      return error;
    }
    throw new Error('expected the statement to fail');
  }

  it('recognizes unique, foreign-key and permission errors from the driver', async () => {
    const org = await t.service.run((sql) => createOrganization(sql));
    const other = await t.service.run((sql) => createOrganization(sql));
    const agent = await t.service.run((sql) => createAgent(sql, org.id));

    const unique = await captureError(() =>
      t.db.query('insert into public.organizations (name, slug) values ($1, $2)', ['Dup', org.slug]),
    );
    expect(isUniqueViolation(unique)).toBe(true);
    expect(isUniqueViolation(unique, 'organizations_slug_key')).toBe(true);
    expect(isForeignKeyViolation(unique)).toBe(false);

    // A business profile naming org B with org A's agent breaks the composite (agent_id, organization_id) key.
    const crossTenant = await captureError(() =>
      t.db.query('insert into public.business_profiles (organization_id, agent_id) values ($1, $2)', [other.id, agent.id]),
    );
    expect(isForeignKeyViolation(crossTenant)).toBe(true);
    expect(isUniqueViolation(crossTenant)).toBe(false);

    const member = await t.service.run((sql) => createAuthUser(sql));
    await t.service.run((sql) => addMember(sql, org.id, member.id, 'member'));
    const denied = await captureError(() =>
      t.asUser(member.id).run((sql) =>
        sql.query('insert into public.agents (organization_id, name) values ($1, $2)', [org.id, `x-${randomUUID()}`]),
      ),
    );
    expect(isPermissionDenied(denied)).toBe(true);
    expect(isPermissionDenied(new Error('plain'))).toBe(false);
  });
});

describe('isUuid', () => {
  it('accepts UUIDs and rejects everything else', () => {
    expect(isUuid('0b1e5c2a-4f4e-4c3b-9a55-2f2f6f0c9d11')).toBe(true);
    expect(isUuid('0B1E5C2A-4F4E-4C3B-9A55-2F2F6F0C9D11')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('0b1e5c2a-4f4e-4c3b-9a55-2f2f6f0c9d11 ')).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuid(null)).toBe(false);
  });
});

describe('truncateText', () => {
  it('keeps short text, drops NUL and appends the suffix only when cut', () => {
    expect(truncateText(`ab${NUL}c`, 10)).toBe('abc');
    expect(truncateText('abcdef', 4, '…')).toBe('abc…');
    expect(truncateText('abcdef', 4)).toBe('abcd');
  });

  it('never splits a surrogate pair', () => {
    const text = `ab${EMOJI}cd`; // the emoji occupies UTF-16 units 2 and 3
    expect(truncateText(text, 3)).toBe('ab');
    expect(truncateText(text, 4)).toBe(`ab${EMOJI}`);
    expect(truncateText(text, 4, '…')).toBe('ab…');
  });
});
