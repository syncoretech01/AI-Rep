import { useEffect, useId, useRef, useState, type KeyboardEvent, type SubmitEvent } from 'react';
import { MAX_VISITOR_MESSAGE_CHARS } from '@/shared/widget-protocol';
import type { ChatController } from '@/widget/chat-controller';
import { acceptsInput, useChatStore, type ChatStore } from '@/widget/chat-store';
import { isSendShortcut } from './keyboard';

interface ChatComposerProps {
  store: ChatStore;
  controller: ChatController;
  /** Focus the input on mount (the embed iframe is only created when the visitor opens the chat). */
  autoFocus: boolean;
}

/** The character counter appears once the draft is this close to the limit. */
const COUNTER_THRESHOLD = 200;

export function ChatComposer({ store, controller, autoFocus }: ChatComposerProps) {
  const state = useChatStore(store, (s) => s.state);
  const unavailable = useChatStore(store, (s) => s.error?.code === 'widget_unavailable');
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputId = useId();
  const counterId = useId();

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  // While a reply is in flight the draft stays editable (disabling a focused textarea drops keyboard focus),
  // but nothing can be sent until the widget is ready again.
  const canSend = acceptsInput(state) && !unavailable && draft.trim().length > 0;
  const nearLimit = MAX_VISITOR_MESSAGE_CHARS - draft.length <= COUNTER_THRESHOLD;

  const submit = () => {
    if (!canSend) return;
    void controller.send(draft);
    setDraft('');
  };

  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter adds a line break, and Enter that confirms an IME composition does nothing.
    if (!isSendShortcut(event.nativeEvent)) return;
    event.preventDefault();
    submit();
  };

  return (
    <form onSubmit={onSubmit} className="border-t border-slate-200 px-3 pt-3 pb-2">
      <div className="flex items-end gap-2">
        <label htmlFor={inputId} className="sr-only">
          Message
        </label>
        <textarea
          id={inputId}
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          maxLength={MAX_VISITOR_MESSAGE_CHARS}
          disabled={unavailable}
          placeholder={unavailable ? 'Chat unavailable' : 'Type your message…'}
          aria-describedby={nearLimit ? counterId : undefined}
          className="block max-h-36 min-h-11 min-w-0 flex-1 resize-none rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-base text-slate-900 field-sizing-content placeholder:text-slate-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 focus:outline-hidden disabled:cursor-not-allowed disabled:bg-slate-50"
        />
        <button
          type="submit"
          disabled={!canSend}
          className="inline-flex h-11 shrink-0 items-center rounded-xl bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Send
        </button>
      </div>
      {nearLimit ? (
        <p id={counterId} className="mt-1 text-right text-xs text-slate-500">
          {draft.length}/{MAX_VISITOR_MESSAGE_CHARS} characters
        </p>
      ) : null}
    </form>
  );
}
