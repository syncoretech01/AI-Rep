import Link from 'next/link';
import { EmptyState, linkClass } from '@/components/admin/ui';

/** Unknown agents/conversations, malformed ids and records of other organizations all look the same. */
export default function OrganizationNotFound() {
  return (
    <EmptyState
      title="Not found"
      description="This page does not exist, or it belongs to an organization you do not have access to."
      action={
        <Link href="/" className={linkClass}>
          Go to your dashboard
        </Link>
      }
    />
  );
}
