import { afterEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ authChecks: 0 }));

// Any authentication or database access would show up here: a disabled lab must answer before reaching them.
vi.mock('@/server/auth/org-access', () => ({
  getOrgAccessForAction: () => {
    hoisted.authChecks += 1;
    return Promise.resolve(null);
  },
}));

import { POST as startRoute } from '@/app/api/voice-lab/sessions/route';
import { GET as viewRoute } from '@/app/api/voice-lab/sessions/[sessionId]/route';
import { POST as endRoute } from '@/app/api/voice-lab/sessions/[sessionId]/end/route';

/** The developer voice lab is not reachable unless VOICE_DEV_ENABLED=true (Phase 2 acceptance criterion 13). */

const SESSION = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'http://localhost:3000';

function post(path: string, body: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, host: 'localhost:3000' },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ sessionId: SESSION }) };

afterEach(() => {
  vi.unstubAllEnvs();
  hoisted.authChecks = 0;
});

describe('voice lab routes', () => {
  it('answer 404 without touching authentication or the gateway when the lab is disabled', async () => {
    vi.stubEnv('VOICE_DEV_ENABLED', 'false');
    const responses = [
      await startRoute(post('/api/voice-lab/sessions', { orgSlug: 'acme', sdp: 'v=0' })),
      await viewRoute(new Request(`${ORIGIN}/api/voice-lab/sessions/${SESSION}?org=acme`, { headers: { host: 'localhost:3000' } }), params),
      await endRoute(post(`/api/voice-lab/sessions/${SESSION}/end`, { orgSlug: 'acme' }), params),
    ];
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
    }
    expect(hoisted.authChecks).toBe(0);
  });

  it('refuses cross-site requests even when enabled', async () => {
    vi.stubEnv('VOICE_DEV_ENABLED', 'true');
    const request = new Request(`${ORIGIN}/api/voice-lab/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example', host: 'localhost:3000' },
      body: JSON.stringify({ orgSlug: 'acme', sdp: 'v=0' }),
    });
    const response = await startRoute(request);
    expect(response.status).toBe(403);
    expect(hoisted.authChecks).toBe(0);
  });

  it('hides organizations the user cannot access when enabled', async () => {
    vi.stubEnv('VOICE_DEV_ENABLED', 'true');
    const response = await startRoute(post('/api/voice-lab/sessions', { orgSlug: 'someone-else', sdp: 'v=0' }));
    expect(response.status).toBe(404);
    expect(hoisted.authChecks).toBe(1);
  });
});
