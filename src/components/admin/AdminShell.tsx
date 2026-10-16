import Link from 'next/link';
import type { ReactNode } from 'react';
import { OrgNav } from './OrgNav';

export interface ShellOrganization {
  name: string;
  slug: string;
}

const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600';

/**
 * Frame of every page under /o/[orgSlug]: organization switcher, navigation and account. A sidebar on large
 * screens; on phones a compact header with the navigation scrolling horizontally below it.
 */
export function AdminShell({
  organization,
  organizations,
  userEmail,
  roleLabel,
  signOutAction,
  children,
}: {
  organization: ShellOrganization;
  organizations: readonly ShellOrganization[];
  userEmail: string | null;
  roleLabel: string;
  signOutAction: () => Promise<void>;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
      <a
        href="#main"
        className="sr-only rounded-lg bg-white px-3 py-2 text-sm font-medium text-slate-900 shadow focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50"
      >
        Skip to content
      </a>
      <aside className="flex flex-wrap items-start gap-x-4 gap-y-3 border-b border-slate-200 bg-white px-4 py-3 lg:sticky lg:top-0 lg:h-dvh lg:flex-col lg:flex-nowrap lg:items-stretch lg:gap-6 lg:overflow-y-auto lg:border-r lg:border-b-0 lg:px-3 lg:py-6">
        <div className="order-1 min-w-0 flex-1 lg:flex-none lg:px-2">
          <Link href="/" className={`rounded-sm text-xs font-semibold tracking-wide text-indigo-700 uppercase ${focusRing}`}>
            Syncore
          </Link>
          {/* Keyed by organization so the menu closes after switching. */}
          <details key={organization.slug} className="group mt-1">
            <summary
              className={`flex cursor-pointer list-none items-center gap-1 rounded-md font-semibold text-slate-900 [&::-webkit-details-marker]:hidden ${focusRing}`}
            >
              <span className="sr-only">Current organization: </span>
              <span className="truncate">{organization.name}</span>
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="size-4 shrink-0 text-slate-500 transition-transform group-open:rotate-180"
              >
                <path
                  fillRule="evenodd"
                  d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.17l3.71-3.94a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z"
                  clipRule="evenodd"
                />
              </svg>
            </summary>
            <div className="mt-2 rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
              <p className="px-2 pt-1 pb-1.5 text-xs font-medium text-slate-500">Switch organization</p>
              <ul>
                {organizations.map((item) => (
                  <li key={item.slug}>
                    <Link
                      href={`/o/${item.slug}`}
                      aria-current={item.slug === organization.slug ? 'true' : undefined}
                      className={`block truncate rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-100 aria-[current=true]:font-semibold aria-[current=true]:text-indigo-800 ${focusRing}`}
                    >
                      {item.name}
                    </Link>
                  </li>
                ))}
              </ul>
              <Link
                href="/onboarding"
                className={`mt-1 block rounded-md border-t border-slate-100 px-2 py-1.5 text-sm font-medium text-indigo-700 hover:bg-slate-100 ${focusRing}`}
              >
                New organization
              </Link>
            </div>
          </details>
        </div>

        <div className="order-2 flex min-w-0 flex-col items-end gap-1 text-right lg:order-3 lg:mt-auto lg:items-stretch lg:border-t lg:border-slate-200 lg:px-2 lg:pt-4 lg:text-left">
          <p className="max-w-[12rem] truncate text-xs text-slate-600 lg:max-w-none" title={userEmail ?? undefined}>
            {userEmail ?? 'Signed in'}
          </p>
          <p className="hidden text-xs text-slate-500 lg:block">{roleLabel}</p>
          <form action={signOutAction}>
            <button
              type="submit"
              className={`rounded-md text-sm font-medium text-slate-700 underline-offset-2 hover:text-slate-900 hover:underline ${focusRing}`}
            >
              Sign out
            </button>
          </form>
        </div>

        <OrgNav orgSlug={organization.slug} className="order-3 basis-full lg:order-2 lg:basis-auto" />
      </aside>

      <main id="main" tabIndex={-1} className="min-w-0 px-4 py-6 focus:outline-hidden sm:px-6 lg:px-10 lg:py-8">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
    </div>
  );
}
