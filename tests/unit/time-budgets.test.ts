import { describe, expect, it, vi } from 'vitest';
import { TURN_DEADLINE_MS } from '@/server/agent/runtime/chat-turn';
import { POST_TURN_BUDGET_MS, TURN_LOCK_TTL_SECONDS } from '@/server/channels/webchat/service';

// The route module reads services lazily per request; importing it only needs its exports.
vi.mock('@/server/app-services', () => ({ getAppServices: () => undefined }));

describe('chat turn time budgets', () => {
  it('keeps turn deadline < route maxDuration < turn lock TTL', async () => {
    const { maxDuration } = await import('@/app/api/widget/messages/route');
    // Persisting the reply and releasing the lock must still fit inside the platform limit…
    expect(TURN_DEADLINE_MS + 5_000).toBeLessThanOrEqual(maxDuration * 1000);
    // …and the lock (which has no owner token) must outlive any request that could hold it.
    expect(maxDuration).toBeLessThan(TURN_LOCK_TTL_SECONDS);
    // Post-turn work (rolling summary) is budgeted from the request start and must also end before the platform limit.
    expect(POST_TURN_BUDGET_MS).toBeGreaterThan(TURN_DEADLINE_MS);
    expect(POST_TURN_BUDGET_MS).toBeLessThan(maxDuration * 1000);
  });
});
