import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ApiErrorCode, PublicAgent, PublicMessage } from '@/shared/widget-protocol';

/**
 * Presentation-only state for one embedded chat widget. The server (Postgres)
 * owns conversations; this store only mirrors what the visitor currently sees.
 * The UI reads it; only the ChatController drives it.
 */

/** `SPEAKING` = assistant text is streaming in. */
export type WidgetState = 'IDLE' | 'OPENING' | 'READY' | 'THINKING' | 'TOOL' | 'SPEAKING' | 'ERROR';

/** Legal transitions. Anything else is a controller bug and is rejected. */
export const TRANSITIONS: Record<WidgetState, readonly WidgetState[]> = {
  IDLE: ['OPENING'],
  OPENING: ['READY', 'ERROR'],
  READY: ['THINKING', 'OPENING'],
  THINKING: ['TOOL', 'SPEAKING', 'READY', 'ERROR'],
  TOOL: ['TOOL', 'THINKING', 'SPEAKING', 'READY', 'ERROR'],
  SPEAKING: ['TOOL', 'THINKING', 'READY', 'ERROR'],
  ERROR: ['READY', 'OPENING', 'THINKING'],
};

/** States in which the visitor may submit a message (READY, or ERROR to try again). */
export function acceptsInput(state: WidgetState): boolean {
  return state === 'READY' || state === 'ERROR';
}

export interface ToolActivity {
  callId: string;
  name: string;
  label: string;
  status: 'running' | 'done' | 'error';
}

export interface ChatTurnView {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  streaming: boolean;
  tools: ToolActivity[];
  failed: boolean;
}

export interface WidgetError {
  code: ApiErrorCode | 'network';
  message: string;
  recoverable: boolean;
}

/** The controller operations that can fail; `retry()` repeats the failed one. */
export type ChatAction = 'open' | 'send' | 'reset';

export type TurnPatch = Partial<Omit<ChatTurnView, 'id'>>;

export interface ChatStoreState {
  state: WidgetState;
  reason: string;
  agent: PublicAgent | null;
  conversationId: string | null;
  turns: ChatTurnView[];
  activeTurnId: string | null;
  error: WidgetError | null;
  /** The operation behind `error`, so the UI offers Retry where it applies (next to a message only for 'send'). */
  failedAction: ChatAction | null;
  lastUserText: string | null;

  /** Returns false (and changes nothing) for an illegal transition. */
  transition(next: WidgetState, reason?: string): boolean;
  setAgent(agent: PublicAgent): void;
  /** Replaces the visible turns with a conversation restored from the server. */
  loadConversation(conversation: { id: string; messages: readonly PublicMessage[] } | null): void;
  setConversationId(id: string): void;
  appendTurn(turn: ChatTurnView): void;
  patchTurn(id: string, patch: TurnPatch): void;
  removeTurns(ids: readonly string[]): void;
  appendDelta(id: string, delta: string): void;
  /** Adds the activity to the turn, or replaces the one with the same callId. */
  upsertTool(turnId: string, activity: ToolActivity): void;
  setActiveTurn(id: string | null): void;
  /** Shows (or, with null, clears) the error together with the operation that failed. */
  setError(error: WidgetError | null, failedAction?: ChatAction | null): void;
  setLastUserText(text: string | null): void;
  /** Clears the visible conversation (after a reset); the agent stays. */
  resetConversation(): void;
}

export type ChatStore = StoreApi<ChatStoreState>;

/** Turns kept in memory; older ones remain on the server. */
export const MAX_TURNS = 100;

function capTurns(turns: ChatTurnView[]): ChatTurnView[] {
  return turns.length > MAX_TURNS ? turns.slice(turns.length - MAX_TURNS) : turns;
}

function toTurnView(message: PublicMessage): ChatTurnView {
  return { id: message.id, role: message.role, text: message.content, streaming: false, tools: [], failed: false };
}

/** `agent` seeds the header and greeting so they render before the session call completes. */
export function createChatStore(agent: PublicAgent | null = null): ChatStore {
  return createStore<ChatStoreState>()((set, get) => {
    const mapTurn = (id: string, fn: (turn: ChatTurnView) => ChatTurnView) => {
      set((s) => ({ turns: s.turns.map((turn) => (turn.id === id ? fn(turn) : turn)) }));
    };

    return {
      state: 'IDLE',
      reason: 'init',
      agent,
      conversationId: null,
      turns: [],
      activeTurnId: null,
      error: null,
      failedAction: null,
      lastUserText: null,

      transition(next, reason = '') {
        const current = get().state;
        if (!TRANSITIONS[current].includes(next)) {
          if (process.env.NODE_ENV === 'development') {
            console.warn(`[syncore-widget] illegal transition ${current} -> ${next} (${reason})`);
          }
          return false;
        }
        set({ state: next, reason });
        return true;
      },
      setAgent: (nextAgent) => set({ agent: nextAgent }),
      loadConversation: (conversation) =>
        set({
          conversationId: conversation?.id ?? null,
          turns: capTurns((conversation?.messages ?? []).map(toTurnView)),
          activeTurnId: null,
        }),
      setConversationId: (id) => set({ conversationId: id }),
      appendTurn: (turn) => set((s) => ({ turns: capTurns([...s.turns, turn]) })),
      patchTurn: (id, patch) => mapTurn(id, (turn) => ({ ...turn, ...patch })),
      removeTurns: (ids) => set((s) => ({ turns: s.turns.filter((turn) => !ids.includes(turn.id)) })),
      appendDelta: (id, delta) => mapTurn(id, (turn) => ({ ...turn, text: turn.text + delta })),
      upsertTool: (turnId, activity) =>
        mapTurn(turnId, (turn) => {
          const exists = turn.tools.some((tool) => tool.callId === activity.callId);
          return {
            ...turn,
            tools: exists
              ? turn.tools.map((tool) => (tool.callId === activity.callId ? activity : tool))
              : [...turn.tools, activity],
          };
        }),
      setActiveTurn: (id) => set({ activeTurnId: id }),
      setError: (error, failedAction = null) => set({ error, failedAction: error ? failedAction : null }),
      setLastUserText: (text) => set({ lastUserText: text }),
      resetConversation: () =>
        set({
          conversationId: null,
          turns: [],
          activeTurnId: null,
          error: null,
          failedAction: null,
          lastUserText: null,
        }),
    };
  });
}

/** React binding: subscribes a component to a slice of one widget's store. */
export function useChatStore<T>(store: ChatStore, selector: (state: ChatStoreState) => T): T {
  return useStore(store, selector);
}
