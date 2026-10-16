import { useEffect, useRef, type ReactNode } from 'react';
import type { ChatController } from '@/widget/chat-controller';
import { useChatStore, type ChatStore, type ChatTurnView } from '@/widget/chat-store';

interface ChatMessagesProps {
  store: ChatStore;
  controller: ChatController;
  agentName: string;
}

/** Pixels from the bottom within which the list keeps following new content. */
const FOLLOW_THRESHOLD_PX = 48;

/**
 * The conversation log. Streaming text is hidden from assistive technology and
 * the finished reply is mounted as a new node, so screen readers announce each
 * reply once instead of every delta.
 */
export function ChatMessages({ store, controller, agentName }: ChatMessagesProps) {
  const turns = useChatStore(store, (s) => s.turns);
  const greeting = useChatStore(store, (s) => s.agent?.greeting ?? '');
  // Marks the agent's text only: the chrome keeps the page language, and visitors may write in any language.
  const language = useChatStore(store, (s) => s.agent?.language);
  const state = useChatStore(store, (s) => s.state);
  // Only a failed message is retried from the conversation; other failures offer Retry in the error banner.
  const canRetry = useChatStore(
    store,
    (s) => s.state === 'ERROR' && s.error?.recoverable === true && s.failedAction === 'send',
  );
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Follow new content unless the visitor scrolled up to read earlier messages.
  const followRef = useRef(true);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    // A message the visitor just sent always brings the view back to the bottom.
    if (turns[turns.length - 1]?.role === 'user') followRef.current = true;
    if (followRef.current) scroller.scrollTop = scroller.scrollHeight;
  }, [turns, state]);

  const onScroll = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    followRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < FOLLOW_THRESHOLD_PX;
  };

  const replying = state === 'THINKING' || state === 'TOOL' || state === 'SPEAKING';
  // Between sending and the server starting the reply there is no assistant turn yet.
  const waiting = replying && !turns.some((turn) => turn.streaming);
  const retry = () => void controller.retry();

  return (
    <div ref={scrollerRef} onScroll={onScroll} className="flex-1 overflow-y-auto overscroll-contain px-4 py-4">
      <div
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Conversation"
        className="flex flex-col gap-3"
      >
        {greeting ? (
          <Bubble fromVisitor={false} speaker={agentName}>
            <p lang={language} className="whitespace-pre-wrap wrap-break-word">{greeting}</p>
          </Bubble>
        ) : null}
        {turns.map((turn, index) => (
          <Turn
            key={turn.id}
            turn={turn}
            agentName={agentName}
            language={language}
            onRetry={canRetry && turn.failed && index === turns.length - 1 ? retry : undefined}
          />
        ))}
        {waiting ? (
          <Bubble fromVisitor={false} speaker={agentName}>
            <TypingDots agentName={agentName} />
          </Bubble>
        ) : null}
      </div>
    </div>
  );
}

interface TurnProps {
  turn: ChatTurnView;
  agentName: string;
  /** `lang` for the agent's text: the language it replies in by default. */
  language: string | undefined;
  onRetry: (() => void) | undefined;
}

function Turn({ turn, agentName, language, onRetry }: TurnProps) {
  const fromVisitor = turn.role === 'user';
  const lang = fromVisitor ? undefined : language;
  const runningTools = turn.streaming ? turn.tools.filter((tool) => tool.status === 'running') : [];
  const showBubble = turn.streaming || turn.text.length > 0;

  return (
    <div className={fromVisitor ? 'flex flex-col items-end gap-1' : 'flex flex-col items-start gap-1'}>
      {showBubble ? (
        <Bubble fromVisitor={fromVisitor} speaker={fromVisitor ? 'You' : agentName}>
          {turn.streaming ? (
            <>
              {turn.text ? (
                <p key="streaming" aria-hidden="true" lang={lang} className="whitespace-pre-wrap wrap-break-word">
                  {turn.text}
                  <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 rounded-sm bg-current opacity-60 motion-safe:animate-pulse" />
                </p>
              ) : runningTools.length === 0 ? (
                <TypingDots agentName={agentName} />
              ) : null}
              {runningTools.map((tool) => (
                <p
                  key={tool.callId}
                  className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-xs text-slate-600 ring-1 ring-slate-200"
                >
                  <span
                    aria-hidden="true"
                    className="size-3 rounded-full border-2 border-slate-300 border-t-indigo-600 motion-safe:animate-spin"
                  />
                  {tool.label}…
                </p>
              ))}
            </>
          ) : (
            <p key="final" lang={lang} className="whitespace-pre-wrap wrap-break-word">
              {turn.text}
            </p>
          )}
        </Bubble>
      ) : null}
      {turn.failed ? (
        <p className="flex items-center gap-2 text-xs text-red-700">
          {fromVisitor ? 'Not delivered.' : "This reply didn't finish."}
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="rounded font-medium text-indigo-700 underline underline-offset-2 hover:text-indigo-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
            >
              Retry
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

function Bubble({ fromVisitor, speaker, children }: { fromVisitor: boolean; speaker: string; children: ReactNode }) {
  return (
    <div
      className={
        fromVisitor
          ? 'max-w-[85%] rounded-2xl rounded-br-md bg-indigo-600 px-3.5 py-2 text-sm text-white'
          : 'max-w-[85%] rounded-2xl rounded-bl-md bg-slate-100 px-3.5 py-2 text-sm text-slate-900'
      }
    >
      <span className="sr-only">{speaker}: </span>
      {children}
    </div>
  );
}

function TypingDots({ agentName }: { agentName: string }) {
  return (
    <span className="flex h-5 items-center gap-1">
      <span className="sr-only">{agentName} is typing…</span>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-slate-400 motion-safe:animate-bounce" />
      <span
        aria-hidden="true"
        className="size-1.5 rounded-full bg-slate-400 [animation-delay:150ms] motion-safe:animate-bounce"
      />
      <span
        aria-hidden="true"
        className="size-1.5 rounded-full bg-slate-400 [animation-delay:300ms] motion-safe:animate-bounce"
      />
    </span>
  );
}
