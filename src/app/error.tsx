'use client';

/**
 * Fallback for pages outside the admin shell (sign-in, onboarding, the widget page). Never shows the error
 * itself, which may contain internal details; server logs carry the digest.
 */
export default function RootError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-xl font-semibold text-slate-900">Something went wrong</h1>
      <p className="text-slate-600">Please try again in a moment.</p>
      <button
        type="button"
        onClick={retry}
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
      >
        Try again
      </button>
    </main>
  );
}
