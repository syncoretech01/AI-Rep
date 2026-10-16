import { describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  user: { id: '00000000-0000-4000-8000-000000000001', email: 'owner@example.com' },
  db: {
    query: async () => {
      throw new Error('connect ECONNREFUSED');
    },
    transaction: async () => {
      throw new Error('connect ECONNREFUSED');
    },
    close: async () => undefined,
  },
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('@/server/auth/session', () => ({
  getAuthUser: async () => hoisted.user,
  requireUser: async () => hoisted.user,
}));
vi.mock('@/server/app-services', () => ({
  getAppServices: () => ({ db: hoisted.db, logger: { error: () => undefined, warn: () => undefined } }),
}));

import { createAgentAction } from '@/app/o/[orgSlug]/agents/actions';
import { updateAgentSettingsAction } from '@/app/o/[orgSlug]/agents/[agentId]/actions';
import { deleteSourceAction } from '@/app/o/[orgSlug]/knowledge/actions';

const IDLE = { status: 'idle' } as const;
const UNEXPECTED = { status: 'error', message: 'Something went wrong. Please try again.' };

describe('admin actions during a database outage', () => {
  it('answer with the generic error state instead of throwing', async () => {
    const silence = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await createAgentAction('acme', IDLE, new FormData())).toEqual(UNEXPECTED);
    expect(
      await updateAgentSettingsAction('acme', '00000000-0000-4000-8000-0000000000bb', IDLE, new FormData()),
    ).toEqual(UNEXPECTED);
    expect(await deleteSourceAction('acme', '00000000-0000-4000-8000-0000000000cc', IDLE, new FormData())).toEqual(
      UNEXPECTED,
    );
    expect(silence).toHaveBeenCalledTimes(3);
  });
});
