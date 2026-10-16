'use client';

import { useSyncExternalStore } from 'react';

const subscribeNever = () => () => undefined;
const isFramed = () => window.parent !== window;
const notFramedOnServer = () => false;

/** Asks public/embed.js to hide the panel. The message carries no data, so any parent origin may receive it. */
function requestClose(): void {
  window.parent.postMessage({ type: 'syncore:close' }, '*');
}

/**
 * Shown for an unknown, unpublished or paused widget. Inside the embed iframe it also offers a
 * Close button, which asks public/embed.js to hide the panel.
 */
export default function WidgetUnavailable() {
  // The server renders without the button; the client adds it when framed (no hydration mismatch).
  const framed = useSyncExternalStore(subscribeNever, isFramed, notFramedOnServer);

  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-2 bg-white px-6 text-center text-slate-900">
      <h1 className="text-base font-semibold">This chat is currently unavailable.</h1>
      <p className="text-sm text-slate-600">Please try again later.</p>
      {framed ? (
        <button
          type="button"
          onClick={requestClose}
          className="mt-3 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
        >
          Close
        </button>
      ) : null}
    </main>
  );
}
