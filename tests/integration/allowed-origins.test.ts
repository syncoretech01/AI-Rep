import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { widgetFramePolicy } from '@/server/channels/webchat/frame-policy';
import { findPublishedWidget, getWebChatChannel, setAllowedOrigins, setWebChatEnabled } from '@/server/domain/agents/repository';
import { DomainError } from '@/server/domain/types';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { addMember, createAuthUser, createTenant, type TenantFixture } from '../support/fixtures';

/**
 * Allowed sites for the web chat widget: owners and admins manage them under RLS (only the channel's config
 * changes, never its key), and the widget page's frame-ancestors policy follows them.
 */

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.close();
});

async function tenant(): Promise<TenantFixture> {
  return t.service.run((sql) => createTenant(sql));
}

describe('allowed sites', () => {
  it('owners set them under RLS; members cannot; other organizations see "not found"', async () => {
    const a = await tenant();
    const b = await tenant();
    const member = await t.service.run(async (sql) => {
      const user = await createAuthUser(sql);
      await addMember(sql, a.org.id, user.id, 'member');
      return user;
    });

    const saved = await t
      .asUser(a.owner.id)
      .run((sql) => setAllowedOrigins(sql, a.org.id, a.agent.id, ['https://www.example.com', 'https://*.example.org']));
    expect(saved.allowedOrigins).toEqual(['https://www.example.com', 'https://*.example.org']);
    expect(saved.publicKey).toBe(a.widgetKey);

    await expect(
      t.asUser(member.id).run((sql) => setAllowedOrigins(sql, a.org.id, a.agent.id, ['https://evil.example'])),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      t.asUser(b.owner.id).run((sql) => setAllowedOrigins(sql, a.org.id, a.agent.id, ['https://evil.example'])),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      t.asUser(a.owner.id).run((sql) => setAllowedOrigins(sql, a.org.id, a.agent.id, ['https://example.com/path'])),
    ).rejects.toBeInstanceOf(DomainError);

    const channel = await t.service.run((sql) => getWebChatChannel(sql, a.org.id, a.agent.id));
    expect(channel?.allowedOrigins).toEqual(['https://www.example.com', 'https://*.example.org']);
  });

  it('other config keys are preserved and a damaged stored value is never trusted', async () => {
    const a = await tenant();
    await t.db.query(
      `update public.agent_channels set config = '{"theme": "dark", "allowedOrigins": ["https://ok.example", "https://x.example; script-src *"]}'
       where agent_id = $1`,
      [a.agent.id],
    );
    const widget = await t.service.run((sql) => findPublishedWidget(sql, a.widgetKey));
    expect(widget?.channel.allowedOrigins).toEqual(['https://ok.example']);

    await t.asUser(a.owner.id).run((sql) => setAllowedOrigins(sql, a.org.id, a.agent.id, []));
    const config = await t.db.query<{ config: unknown }>('select config from public.agent_channels where agent_id = $1', [a.agent.id]);
    expect(config[0]?.config).toEqual({ theme: 'dark', allowedOrigins: [] });
  });

  it("sets the widget page's frame-ancestors policy from the published widget's sites", async () => {
    const a = await tenant();
    const path = `/widget/${a.widgetKey}`;

    expect(await widgetFramePolicy(t.db, path)).toBe('frame-ancestors *');
    await t.asUser(a.owner.id).run((sql) => setAllowedOrigins(sql, a.org.id, a.agent.id, ['https://www.example.com']));
    expect(await widgetFramePolicy(t.db, path)).toBe('frame-ancestors https://www.example.com');

    // A list written outside the admin UI with no valid entry fails closed.
    await t.db.query(`update public.agent_channels set config = '{"allowedOrigins": ["www.example.com"]}' where agent_id = $1`, [
      a.agent.id,
    ]);
    expect(await widgetFramePolicy(t.db, path)).toBe("frame-ancestors 'none'");

    // Unpublished, unknown or malformed widgets cannot be framed at all.
    await t.asUser(a.owner.id).run((sql) => setWebChatEnabled(sql, a.org.id, a.agent.id, false));
    expect(await widgetFramePolicy(t.db, path)).toBe("frame-ancestors 'none'");
    expect(await widgetFramePolicy(t.db, `/widget/wk_${'Z'.repeat(30)}`)).toBe("frame-ancestors 'none'");
    expect(await widgetFramePolicy(t.db, '/widget/not-a-key')).toBe("frame-ancestors 'none'");
  });
});
