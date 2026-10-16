'use client';

import { EmptyState, buttonClass } from '@/components/admin/ui';

/**
 * Admin pages that fail to load (e.g. the database is unreachable) render here, inside the admin shell.
 * The error itself is never shown: it may contain internal details. Server logs carry the digest.
 * `retry` re-fetches the server components and re-renders (`reset` alone would only re-render the failed
 * client tree, which cannot recover from a server-side failure).
 */
export default function OrganizationError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <EmptyState
      title="This page could not be loaded"
      description="Something went wrong on our side. Please try again in a moment."
      action={
        <button type="button" onClick={retry} className={buttonClass('secondary')}>
          Try again
        </button>
      }
    />
  );
}
