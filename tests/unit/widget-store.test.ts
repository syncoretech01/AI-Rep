import type * as ReactModule from 'react';
import {
  Children,
  createElement,
  isValidElement,
  type EffectCallback,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatComposer } from '@/components/widget/ChatComposer';
import { ChatMessages } from '@/components/widget/ChatMessages';
import { ChatWidget } from '@/components/widget/ChatWidget';
import { isCloseShortcut, isSendShortcut } from '@/components/widget/keyboard';
import type { PublicMessage } from '@/shared/widget-protocol';
import { ChatController } from '@/widget/chat-controller';
import {
  MAX_TURNS,
  TRANSITIONS,
  acceptsInput,
  createChatStore,
  type ChatStore,
  type ChatTurnView,
  type WidgetState,
} from '@/widget/chat-store';

const STATES: WidgetState[] = ['IDLE', 'OPENING', 'READY', 'THINKING', 'TOOL', 'SPEAKING', 'ERROR'];

// The documented state machine, written out independently so an accidental edit of TRANSITIONS fails here.
const LEGAL = new Set([
  'IDLE>OPENING',
  'OPENING>READY',
  'OPENING>ERROR',
  'READY>THINKING',
  'READY>OPENING',
  'THINKING>TOOL',
  'THINKING>SPEAKING',
  'THINKING>READY',
  'THINKING>ERROR',
  'TOOL>TOOL',
  'TOOL>THINKING',
  'TOOL>SPEAKING',
  'TOOL>READY',
  'TOOL>ERROR',
  'SPEAKING>TOOL',
  'SPEAKING>THINKING',
  'SPEAKING>READY',
  'SPEAKING>ERROR',
  'ERROR>READY',
  'ERROR>OPENING',
  'ERROR>THINKING',
]);

const AGENT = { name: 'Front Desk', greeting: 'Hi! How can I help?', language: 'en' };

function storeIn(state: WidgetState) {
  const store = createChatStore();
  store.setState({ state });
  return store;
}

function turn(id: string, overrides: Partial<ChatTurnView> = {}): ChatTurnView {
  return { id, role: 'assistant', text: '', streaming: false, tools: [], failed: false, ...overrides };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('widget state machine', () => {
  it('matches the documented transitions', () => {
    const actual = STATES.flatMap((from) => TRANSITIONS[from].map((to) => `${from}>${to}`));
    expect(new Set(actual)).toEqual(LEGAL);
    expect(actual).toHaveLength(LEGAL.size);
  });

  const cases = STATES.flatMap((from) => STATES.map((to) => ({ from, to, legal: LEGAL.has(`${from}>${to}`) })));

  it.each(cases)('$from -> $to (legal: $legal)', ({ from, to, legal }) => {
    const store = storeIn(from);
    expect(store.getState().transition(to, 'test')).toBe(legal);
    expect(store.getState().state).toBe(legal ? to : from);
    expect(store.getState().reason).toBe(legal ? 'test' : 'init');
  });

  it('warns about illegal transitions only in development', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(createChatStore().getState().transition('READY', 'skip')).toBe(false);
    expect(warn).not.toHaveBeenCalled();

    vi.stubEnv('NODE_ENV', 'development');
    expect(createChatStore().getState().transition('READY', 'skip')).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('IDLE -> READY (skip)'));
  });

  it('accepts visitor input only when READY or after an error', () => {
    expect(STATES.filter(acceptsInput)).toEqual(['READY', 'ERROR']);
  });
});

describe('turn reducers', () => {
  it('starts empty, seeded with the agent', () => {
    const s = createChatStore(AGENT).getState();
    expect(s).toMatchObject({
      state: 'IDLE',
      agent: AGENT,
      conversationId: null,
      turns: [],
      activeTurnId: null,
      error: null,
      failedAction: null,
      lastUserText: null,
    });
    expect(createChatStore().getState().agent).toBeNull();
  });

  it('records which operation failed together with the error', () => {
    const store = createChatStore();
    const error = { code: 'network', message: 'offline', recoverable: true } as const;
    store.getState().setError(error, 'reset');
    expect(store.getState()).toMatchObject({ error, failedAction: 'reset' });
    store.getState().setError(null, 'send');
    expect(store.getState()).toMatchObject({ error: null, failedAction: null });
  });

  it('appends, patches and streams text into a turn', () => {
    const store = createChatStore();
    const s = store.getState();
    s.appendTurn(turn('u1', { role: 'user', text: 'Hello' }));
    s.appendTurn(turn('a1', { streaming: true }));
    s.appendDelta('a1', 'Hi ');
    s.appendDelta('a1', 'there');
    expect(store.getState().turns[1]?.text).toBe('Hi there');

    s.patchTurn('a1', { text: 'Hi there!', streaming: false });
    expect(store.getState().turns).toEqual([
      turn('u1', { role: 'user', text: 'Hello' }),
      turn('a1', { text: 'Hi there!' }),
    ]);
  });

  it('leaves the turns untouched when the target turn does not exist', () => {
    const store = createChatStore();
    store.getState().appendTurn(turn('a1', { text: 'kept' }));
    const before = store.getState().turns;
    store.getState().appendDelta('missing', 'x');
    store.getState().patchTurn('missing', { failed: true });
    expect(store.getState().turns).toEqual(before);
  });

  it('upserts tool activity by callId', () => {
    const store = createChatStore();
    const s = store.getState();
    s.appendTurn(turn('a1', { streaming: true }));
    s.upsertTool('a1', { callId: 'c1', name: 'searchKnowledge', label: 'Searching our information', status: 'running' });
    s.upsertTool('a1', { callId: 'c2', name: 'captureLead', label: 'Saving your details', status: 'running' });
    s.upsertTool('a1', { callId: 'c1', name: 'searchKnowledge', label: 'Searching our information', status: 'done' });
    expect(store.getState().turns[0]?.tools).toEqual([
      { callId: 'c1', name: 'searchKnowledge', label: 'Searching our information', status: 'done' },
      { callId: 'c2', name: 'captureLead', label: 'Saving your details', status: 'running' },
    ]);
  });

  it('removes turns by id', () => {
    const store = createChatStore();
    for (const id of ['a', 'b', 'c']) store.getState().appendTurn(turn(id));
    store.getState().removeTurns(['a', 'c']);
    expect(store.getState().turns.map((t) => t.id)).toEqual(['b']);
  });

  it(`keeps only the newest ${MAX_TURNS} turns in memory`, () => {
    const store = createChatStore();
    for (let i = 0; i < MAX_TURNS + 5; i += 1) store.getState().appendTurn(turn(`t${i}`));
    const ids = store.getState().turns.map((t) => t.id);
    expect(ids).toHaveLength(MAX_TURNS);
    expect(ids[0]).toBe('t5');
    expect(ids[ids.length - 1]).toBe(`t${MAX_TURNS + 4}`);
  });

  it('restores a server conversation as finished turns', () => {
    const store = createChatStore();
    const messages: PublicMessage[] = [
      { id: 'm1', role: 'user', content: 'Do you work weekends?', createdAt: '2026-10-08T10:00:00.000Z' },
      { id: 'm2', role: 'assistant', content: 'Yes:\nSaturday 9-1.', createdAt: '2026-10-08T10:00:02.000Z' },
    ];
    store.getState().setActiveTurn('stale');
    store.getState().loadConversation({ id: 'conv-1', messages });
    expect(store.getState().conversationId).toBe('conv-1');
    expect(store.getState().activeTurnId).toBeNull();
    expect(store.getState().turns).toEqual([
      turn('m1', { role: 'user', text: 'Do you work weekends?' }),
      turn('m2', { text: 'Yes:\nSaturday 9-1.' }),
    ]);

    store.getState().loadConversation(null);
    expect(store.getState().conversationId).toBeNull();
    expect(store.getState().turns).toEqual([]);
  });

  it('caps a restored conversation too', () => {
    const store = createChatStore();
    const messages = Array.from({ length: MAX_TURNS + 1 }, (_, i): PublicMessage => ({
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
      createdAt: '2026-10-08T10:00:00.000Z',
    }));
    store.getState().loadConversation({ id: 'conv-1', messages });
    expect(store.getState().turns).toHaveLength(MAX_TURNS);
    expect(store.getState().turns[0]?.id).toBe('m1');
  });

  it('resetConversation clears the conversation but keeps the agent', () => {
    const store = createChatStore(AGENT);
    const s = store.getState();
    s.setConversationId('conv-1');
    s.appendTurn(turn('a1'));
    s.setActiveTurn('a1');
    s.setError({ code: 'internal', message: 'boom', recoverable: true }, 'send');
    s.setLastUserText('hello');
    s.resetConversation();
    expect(store.getState()).toMatchObject({
      agent: AGENT,
      conversationId: null,
      turns: [],
      activeTurnId: null,
      error: null,
      failedAction: null,
      lastUserText: null,
    });
  });
});

describe('ChatWidget reads the store (server render)', () => {
  const props = { widgetKey: `wk_${'a'.repeat(32)}`, agentName: 'Front Desk', greeting: AGENT.greeting, language: 'en' };

  it('renders the agent, the greeting and the footer without any network call', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const html = renderToString(createElement(ChatWidget, { ...props, embedded: true }));
    expect(html).toContain('Front Desk');
    expect(html).toContain('Hi! How can I help?');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-label="Close chat"');
    expect(html).toContain('Powered by Syncore');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows the close button only inside the embed iframe and escapes agent-provided text', () => {
    const html = renderToString(
      createElement(ChatWidget, { ...props, greeting: '<script>alert(1)</script> Welcome!', embedded: false }),
    );
    expect(html).not.toContain('Close chat');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; Welcome!');
  });

  it("marks the greeting with the agent's language and leaves the chrome in the page language", () => {
    const html = renderToString(
      createElement(ChatWidget, { ...props, greeting: '¡Hola! ¿Cómo le ayudo?', language: 'es', embedded: true }),
    );
    expect(html).toMatch(/<p lang="es"[^>]*>¡Hola! ¿Cómo le ayudo\?<\/p>/);
    // Header, buttons, footer and the conversation log itself keep the page language.
    expect(html.match(/ lang="/g)).toHaveLength(1);
  });

  it("marks the agent's replies with its language, but never what the visitor wrote", () => {
    const store = createChatStore({ name: 'Recepción', greeting: '¡Hola!', language: 'es' });
    store.getState().loadConversation({
      id: 'conv-1',
      messages: [
        { id: 'm1', role: 'user', content: 'Do you speak English?', createdAt: '2026-10-08T10:00:00.000Z' },
        { id: 'm2', role: 'assistant', content: 'Sí, también inglés.', createdAt: '2026-10-08T10:00:02.000Z' },
      ],
    });
    store.getState().appendTurn(turn('u2', { role: 'user', text: 'Great, when are you open?' }));
    store.getState().appendTurn(turn('a2', { text: 'Abrimos a las 9', streaming: true }));
    // Server rendering reads a store's initial state; render the current one instead.
    const rendered: ChatStore = { ...store, getInitialState: store.getState };
    const controller = new ChatController({ widgetKey: props.widgetKey, store: rendered });

    const html = renderToString(createElement(ChatMessages, { store: rendered, controller, agentName: 'Recepción' }));

    expect(html).toMatch(/<p lang="es"[^>]*>Sí, también inglés\.<\/p>/);
    expect(html).toMatch(/<p aria-hidden="true" lang="es"[^>]*>Abrimos a las 9/);
    expect(html).toMatch(/<p class="[^"]*">Do you speak English\?<\/p>/);
    expect(html).toMatch(/<p class="[^"]*">Great, when are you open\?<\/p>/);
    // The greeting, the finished reply and the reply still streaming in.
    expect(html.match(/ lang="/g)).toHaveLength(3);
  });
});

describe('widget keyboard shortcuts', () => {
  /** A keydown as the browser reports it. */
  const keydown = (key: string, init: { shiftKey?: boolean; isComposing?: boolean; keyCode?: number } = {}) => ({
    key,
    shiftKey: false,
    isComposing: false,
    keyCode: key === 'Enter' ? 13 : 27,
    ...init,
  });

  it('sends on Enter, but not on Shift+Enter or the Enter that confirms an IME conversion', () => {
    expect(isSendShortcut(keydown('Enter'))).toBe(true);
    expect(isSendShortcut(keydown('Enter', { shiftKey: true }))).toBe(false);
    expect(isSendShortcut(keydown('a', { keyCode: 65 }))).toBe(false);
    // Chrome and Firefox: the confirming keydown is still part of the composition.
    expect(isSendShortcut(keydown('Enter', { isComposing: true, keyCode: 229 }))).toBe(false);
    // Safari ends the composition before that keydown, so only keyCode 229 gives it away.
    expect(isSendShortcut(keydown('Enter', { keyCode: 229 }))).toBe(false);
  });

  it('closes the embedded panel on Escape, but not on the Escape that cancels an IME conversion', () => {
    expect(isCloseShortcut(keydown('Escape'))).toBe(true);
    expect(isCloseShortcut(keydown('Enter'))).toBe(false);
    expect(isCloseShortcut(keydown('Escape', { isComposing: true, keyCode: 229 }))).toBe(false);
    expect(isCloseShortcut(keydown('Escape', { keyCode: 229 }))).toBe(false);
  });

  // The components must use these shortcuts: the two tests below drive their real handlers.
  const widgetKey = `wk_${'a'.repeat(32)}`;

  /** The props of the first `type` element in a rendered element tree, event handlers included. */
  function hostProps(node: ReactNode, type: string): Record<string, unknown> | undefined {
    if (!isValidElement<{ children?: ReactNode }>(node)) return undefined;
    if (node.type === type) return node.props;
    for (const child of Children.toArray(node.props.children)) {
      const props = hostProps(child, type);
      if (props) return props;
    }
    return undefined;
  }

  it('the composer leaves the Enter that confirms an IME conversion to the input method', () => {
    const store = createChatStore(AGENT);
    const controller = new ChatController({ widgetKey, store });
    // Server-renders the composer's own element tree and keeps the textarea's props.
    const rendered: { textarea?: Record<string, unknown> } = {};
    const probe = () => {
      const tree = ChatComposer({ store, controller, autoFocus: false });
      rendered.textarea = hostProps(tree, 'textarea');
      return tree;
    };
    renderToString(createElement(probe));
    const onKeyDown = rendered.textarea?.onKeyDown;
    if (typeof onKeyDown !== 'function') throw new Error('the composer has no keydown handler');

    /** True when the composer takes the key (to send) instead of leaving it to the textarea and the IME. */
    const takesKey = (key: string, init?: Parameters<typeof keydown>[1]) => {
      const nativeEvent = keydown(key, init);
      const event = { key, shiftKey: nativeEvent.shiftKey, nativeEvent, preventDefault: vi.fn() };
      (onKeyDown as (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void)(
        event as unknown as ReactKeyboardEvent<HTMLTextAreaElement>,
      );
      return event.preventDefault.mock.calls.length > 0;
    };
    expect(takesKey('Enter')).toBe(true);
    expect(takesKey('Enter', { shiftKey: true })).toBe(false);
    expect(takesKey('Enter', { isComposing: true, keyCode: 229 })).toBe(false);
    // Safari: compositionend has already fired, so only keyCode 229 marks this keydown.
    expect(takesKey('Enter', { keyCode: 229 })).toBe(false);
  });

  it('the embedded panel forwards Escape to the loader, but not the Escape that cancels an IME conversion', async () => {
    // Server rendering skips effects: load the widget with useEffect collecting them, then run them like a browser.
    const effects: EffectCallback[] = [];
    vi.resetModules();
    vi.doMock('react', async (importOriginal) => ({
      ...(await importOriginal<typeof ReactModule>()),
      useEffect: (effect: EffectCallback) => {
        effects.push(effect);
      },
    }));
    try {
      const { ChatWidget: Widget } = await import('@/components/widget/ChatWidget');
      const props = { widgetKey, agentName: AGENT.name, greeting: AGENT.greeting, language: AGENT.language };
      renderToString(createElement(Widget, { ...props, embedded: true }));
    } finally {
      vi.doUnmock('react');
      vi.resetModules();
    }

    const listeners: ((event: ReturnType<typeof keydown>) => void)[] = [];
    vi.stubGlobal('document', {
      addEventListener: (type: string, listener: (event: ReturnType<typeof keydown>) => void) => {
        if (type === 'keydown') listeners.push(listener);
      },
      removeEventListener: () => undefined,
    });
    const postMessage = vi.fn();
    vi.stubGlobal('window', { parent: { postMessage } });
    // The session request never answers; the effects' cleanups abort it.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    const cleanups = effects.map((effect) => effect());
    const press = (init?: Parameters<typeof keydown>[1]) => {
      for (const listener of listeners) listener(keydown('Escape', init));
    };

    press({ isComposing: true, keyCode: 229 });
    // Safari: compositionend has already fired, so only keyCode 229 marks this keydown.
    press({ keyCode: 229 });
    expect(postMessage).not.toHaveBeenCalled();
    press();
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'syncore:close' }, '*');
    for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup();
  });
});
