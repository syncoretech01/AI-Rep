'use client';

import { useEffect, useState } from 'react';
import { ChatController } from '@/widget/chat-controller';
import { acceptsInput, createChatStore, useChatStore } from '@/widget/chat-store';
import { ChatComposer } from './ChatComposer';
import { ChatMessages } from './ChatMessages';
import { isCloseShortcut } from './keyboard';

export interface ChatWidgetProps {
  widgetKey: string;
  agentName: string;
  greeting: string;
  /** BCP-47 tag of the agent's reply language. */
  language: string;
  /** True inside the public/embed.js iframe on a customer's website. */
  embedded: boolean;
}

/** Asks public/embed.js to hide the panel. The message carries no data, so any parent origin may receive it. */
function requestClose(): void {
  window.parent.postMessage({ type: 'syncore:close' }, '*');
}

/**
 * The visitor-facing chat panel. One store + controller per mounted widget:
 * the controller does all I/O, components only read the store.
 */
export function ChatWidget({ widgetKey, agentName, greeting, language, embedded }: ChatWidgetProps) {
  // The props seed the agent so the header and greeting render before the session call returns.
  const [{ store, controller }] = useState(() => {
    const chatStore = createChatStore({ name: agentName, greeting, language });
    return { store: chatStore, controller: new ChatController({ widgetKey, store: chatStore }) };
  });

  useEffect(() => {
    void controller.open();
    return () => {
      controller.dispose();
    };
  }, [controller]);

  // Keyboard events inside the iframe never reach the host page, so Escape is forwarded to the loader.
  useEffect(() => {
    if (!embedded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isCloseShortcut(event)) requestClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [embedded]);

  const name = useChatStore(store, (s) => s.agent?.name ?? agentName);
  const state = useChatStore(store, (s) => s.state);
  const error = useChatStore(store, (s) => s.error);
  const failedAction = useChatStore(store, (s) => s.failedAction);
  const unavailable = error?.code === 'widget_unavailable';
  // A failed message offers Retry next to it; a failed open or "New chat" offers it here.
  const bannerRetry = error?.recoverable === true && state === 'ERROR' && failedAction !== 'send';

  return (
    <div
      className={
        embedded
          ? 'flex h-dvh flex-col bg-white text-slate-900'
          : 'mx-auto flex h-dvh max-w-2xl flex-col border-x border-slate-200 bg-white text-slate-900'
      }
    >
      <header className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold">{name}</h1>
          <p className="text-xs text-slate-500">AI assistant</p>
        </div>
        <button
          type="button"
          onClick={() => void controller.reset()}
          disabled={!acceptsInput(state) || unavailable}
          className="rounded-lg px-2.5 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          New chat
        </button>
        {embedded ? (
          <button
            type="button"
            aria-label="Close chat"
            onClick={requestClose}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="size-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        ) : null}
      </header>

      <ChatMessages store={store} controller={controller} agentName={name} />

      {error ? (
        <div
          role="alert"
          className="mx-3 mb-2 flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          <p className="flex-1">{error.message}</p>
          {bannerRetry ? (
            <button
              type="button"
              onClick={() => void controller.retry()}
              className="shrink-0 rounded font-medium text-red-900 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
            >
              Try again
            </button>
          ) : null}
        </div>
      ) : null}

      <ChatComposer store={store} controller={controller} autoFocus={embedded} />
      <p className="pb-2 text-center text-[11px] text-slate-500">Powered by Syncore</p>
    </div>
  );
}

export default ChatWidget;
