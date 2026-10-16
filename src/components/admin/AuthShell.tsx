import Link from 'next/link';
import type { ReactNode } from 'react';

/** Centered card layout for sign-in, sign-up, onboarding and auth status pages. */
export function AuthShell({
  title,
  description,
  footer,
  children,
}: {
  title: string;
  description?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <Link
          href="/"
          className="mx-auto block w-fit rounded-sm text-sm font-semibold tracking-wide text-indigo-700 uppercase focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-indigo-600"
        >
          Syncore AI Receptionist
        </Link>
        <div className="mt-6 rounded-xl border border-slate-200 bg-white px-5 py-6 shadow-xs sm:px-8 sm:py-8">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
          {description ? <div className="mt-1.5 text-sm text-slate-600">{description}</div> : null}
          {children ? <div className="mt-6">{children}</div> : null}
        </div>
        {footer ? <div className="mt-6 text-center text-sm text-slate-600">{footer}</div> : null}
      </div>
    </main>
  );
}
