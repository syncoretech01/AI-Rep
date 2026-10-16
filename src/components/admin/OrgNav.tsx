'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from './ui';

const SECTIONS = [
  { label: 'Overview', path: '' },
  { label: 'Agents', path: '/agents' },
  { label: 'Knowledge', path: '/knowledge' },
  { label: 'Conversations', path: '/conversations' },
  { label: 'Leads', path: '/leads' },
] as const;

/** Main navigation of an organization; highlights the current section. */
export function OrgNav({ orgSlug, className }: { orgSlug: string; className?: string }) {
  const pathname = usePathname();
  const base = `/o/${orgSlug}`;
  return (
    <nav aria-label="Organization" className={className}>
      <ul className="-mx-1 flex gap-1 overflow-x-auto p-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:p-0">
        {SECTIONS.map(({ label, path }) => {
          const href = `${base}${path}`;
          const active = path === '' ? pathname === base : pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={label} className="shrink-0">
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'block rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600',
                  active ? 'bg-indigo-50 text-indigo-800' : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900',
                )}
              >
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
