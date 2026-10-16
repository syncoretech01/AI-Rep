import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  MAX_VISITOR_MESSAGE_CHARS,
  WIDGET_KEY_PATTERN,
  createSseParser,
  encodeSseEvent,
  sendMessageRequestSchema,
  type WidgetEvent,
} from '@/shared/widget-protocol';

const EMBED_SOURCE = readFileSync(new URL('../../public/embed.js', import.meta.url), 'utf8');

const EVENTS: WidgetEvent[] = [
  { type: 'turn.start', turnId: 'turn-1', conversationId: 'conv-1' },
  { type: 'tool.call', turnId: 'turn-1', callId: 'call-1', name: 'searchKnowledge', label: 'Searching our information' },
  { type: 'tool.result', turnId: 'turn-1', callId: 'call-1', name: 'searchKnowledge', ok: true },
  { type: 'text.delta', turnId: 'turn-1', delta: 'Café ☕ — "24/7"\nsecond line' },
  { type: 'turn.done', turnId: 'turn-1', messageId: 'msg-1', text: 'We are open 24/7.' },
  { type: 'turn.error', turnId: null, code: 'provider_unavailable', message: 'Try again shortly.', recoverable: true },
];

function collect() {
  const received: WidgetEvent[] = [];
  const invalid: string[] = [];
  const parser = createSseParser(
    (event) => received.push(event),
    (raw) => invalid.push(raw),
  );
  return { parser, received, invalid };
}

describe('encodeSseEvent', () => {
  it('writes one named frame with a single data line per event', () => {
    for (const event of EVENTS) {
      const frame = encodeSseEvent(event);
      expect(frame.startsWith(`event: ${event.type}\ndata: `)).toBe(true);
      expect(frame.endsWith('\n\n')).toBe(true);
      // Newlines inside text are JSON-escaped, so they can never split a frame.
      expect(frame.slice(0, -2).split('\n')).toHaveLength(2);
    }
  });

  it('round-trips every event type through the parser', () => {
    for (const event of EVENTS) {
      const { parser, received, invalid } = collect();
      parser.push(encodeSseEvent(event));
      expect(received).toEqual([event]);
      expect(invalid).toEqual([]);
    }
  });
});

describe('createSseParser', () => {
  const stream = EVENTS.map(encodeSseEvent).join('');

  it('emits several events delivered in one chunk, in order', () => {
    const { parser, received } = collect();
    parser.push(stream);
    expect(received).toEqual(EVENTS);
  });

  it('reassembles events split at every possible boundary', () => {
    for (let cut = 1; cut < stream.length; cut += 1) {
      const { parser, received, invalid } = collect();
      parser.push(stream.slice(0, cut));
      parser.push(stream.slice(cut));
      expect(received).toEqual(EVENTS);
      expect(invalid).toEqual([]);
    }
  });

  it('handles a stream delivered one character at a time', () => {
    const { parser, received } = collect();
    for (const char of stream) parser.push(char);
    expect(received).toEqual(EVENTS);
  });

  it('accepts CRLF line endings, including CRLF pairs split across chunks', () => {
    const crlf = stream.replace(/\n/g, '\r\n');
    for (let cut = 1; cut < crlf.length; cut += 1) {
      const { parser, received, invalid } = collect();
      parser.push(crlf.slice(0, cut));
      parser.push(crlf.slice(cut));
      expect(received).toEqual(EVENTS);
      expect(invalid).toEqual([]);
    }
  });

  it('keeps a multi-line frame intact when a CRLF pair is split across chunks', () => {
    const frame = 'data: {"type":"turn.start",\r\ndata: "turnId":"turn-1","conversationId":"conv-1"}\r\n\r\n';
    for (let cut = 1; cut < frame.length; cut += 1) {
      const { parser, received, invalid } = collect();
      parser.push(frame.slice(0, cut));
      // TextDecoder yields '' for a chunk holding only part of a multi-byte character.
      parser.push('');
      parser.push(frame.slice(cut));
      expect(received).toEqual([EVENTS[0]]);
      expect(invalid).toEqual([]);
    }
  });

  it('accepts bare CR line endings', () => {
    const { parser, received } = collect();
    parser.push(stream.replace(/\n/g, '\r'));
    expect(received).toEqual(EVENTS);
  });

  it('reports malformed JSON and schema-invalid frames to onInvalid and keeps going', () => {
    const { parser, received, invalid } = collect();
    parser.push('data: {not json}\n\n');
    parser.push(encodeSseEvent(EVENTS[0]!));
    parser.push('data: {"type":"unknown.event","turnId":"t"}\n\n');
    parser.push('data: {"type":"text.delta","turnId":"turn-1"}\n\n');
    parser.push(encodeSseEvent(EVENTS[4]!));
    expect(received).toEqual([EVENTS[0], EVENTS[4]]);
    expect(invalid).toEqual([
      '{not json}',
      '{"type":"unknown.event","turnId":"t"}',
      '{"type":"text.delta","turnId":"turn-1"}',
    ]);
  });

  it('ignores comments and frames without data', () => {
    const { parser, received, invalid } = collect();
    parser.push(': keep-alive\n\nevent: ping\n\n');
    parser.push(encodeSseEvent(EVENTS[0]!));
    expect(received).toEqual([EVENTS[0]]);
    expect(invalid).toEqual([]);
  });

  it('joins multi-line data and accepts "data:" without a space', () => {
    const { parser, received } = collect();
    parser.push('event: turn.start\ndata:{"type":"turn.start",\ndata: "turnId":"turn-1","conversationId":"conv-1"}\n\n');
    expect(received).toEqual([EVENTS[0]]);
  });

  it('dispatches a final frame without the blank line only on flush()', () => {
    const { parser, received } = collect();
    parser.push(`data: ${JSON.stringify(EVENTS[4])}`);
    expect(received).toEqual([]);
    parser.flush();
    expect(received).toEqual([EVENTS[4]]);
    parser.flush();
    expect(received).toHaveLength(1);
  });
});

describe('limits the widget relies on', () => {
  it('trims visitor messages and enforces MAX_VISITOR_MESSAGE_CHARS', () => {
    const base = { widgetKey: `wk_${'a'.repeat(32)}`, sessionToken: 'token' };
    expect(sendMessageRequestSchema.parse({ ...base, text: '  hi  ' }).text).toBe('hi');
    expect(sendMessageRequestSchema.safeParse({ ...base, text: 'x'.repeat(MAX_VISITOR_MESSAGE_CHARS) }).success).toBe(true);
    expect(sendMessageRequestSchema.safeParse({ ...base, text: 'x'.repeat(MAX_VISITOR_MESSAGE_CHARS + 1) }).success).toBe(false);
    expect(sendMessageRequestSchema.safeParse({ ...base, text: '   ' }).success).toBe(false);
  });

  it('keeps embed.js a small ES2017 script', () => {
    expect(Buffer.byteLength(EMBED_SOURCE)).toBeLessThan(6 * 1024);
    // Customer sites serve it as is to old browsers: TypeScript must have nothing newer than ES2017 to rewrite.
    const emit = (target: ts.ScriptTarget) =>
      ts.transpileModule(EMBED_SOURCE, { fileName: 'embed.js', compilerOptions: { target, allowJs: true } }).outputText;
    expect(emit(ts.ScriptTarget.ES2017)).toBe(emit(ts.ScriptTarget.ESNext));
  });

  it('keeps the embed.js key check identical to the protocol pattern', () => {
    expect(EMBED_SOURCE).toContain(`/${WIDGET_KEY_PATTERN.source}/.test(key)`);
    expect(WIDGET_KEY_PATTERN.test(`wk_${'A1'.repeat(12)}`)).toBe(true);
    expect(WIDGET_KEY_PATTERN.test(`wk_${'a'.repeat(23)}`)).toBe(false);
    expect(WIDGET_KEY_PATTERN.test(`wk_${'a'.repeat(65)}`)).toBe(false);
    expect(WIDGET_KEY_PATTERN.test(`wk_${'a'.repeat(31)}-`)).toBe(false);
  });
});

// ── public/embed.js, run against a fake host page ────────────────────────────

const APP_ORIGIN = 'https://app.syncore.test';
const EMBED_KEY = `wk_${'Ab3'.repeat(10)}`;

type DomListener = (event: { key?: string; origin?: string; source?: unknown; data?: unknown }) => void;

/** Just enough of a DOM element for the loader: records styles, attributes, children and listeners. */
class FakeElement {
  readonly style: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  readonly listeners: Record<string, DomListener[]> = {};
  /** Compared by identity with `event.source`, like a real iframe's window. */
  readonly contentWindow = {};
  parent: FakeElement | null = null;
  id = '';
  type = '';
  src = '';
  title = '';

  constructor(
    readonly tagName: string,
    private readonly onFocus: (element: FakeElement) => void,
  ) {}

  /** In the page: the fake `<html>` is the document root. */
  get isConnected(): boolean {
    return this.tagName === 'html' || (this.parent?.isConnected ?? false);
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
  appendChild(child: FakeElement) {
    // Like the DOM: appending an attached node moves it.
    child.remove();
    child.parent = this;
    this.children.push(child);
  }
  replaceChild(next: FakeElement, previous: FakeElement) {
    this.children[this.children.indexOf(previous)] = next;
    next.parent = this;
    previous.parent = null;
  }
  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  addEventListener(type: string, listener: DomListener) {
    (this.listeners[type] ??= []).push(listener);
  }
  focus() {
    this.onFocus(this);
  }
  emit(type: string, event: Parameters<DomListener>[0] = {}) {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
}

/**
 * A host page whose `<script src=".../embed.js">` tag carries `scriptAttributes`. With `body: false` the
 * snippet runs from `<head>` before the parser has created `<body>` (see `parseBody`).
 */
function hostPage(scriptAttributes: Record<string, string>, { narrow = false, body: withBody = true } = {}) {
  let activeElement: FakeElement | null = null;
  const element = (tagName: string) =>
    new FakeElement(tagName, (focused) => {
      activeElement = focused;
    });
  const script = element('script');
  script.src = `${APP_ORIGIN}/embed.js?v=1`;
  Object.assign(script.attributes, scriptAttributes);
  const html = element('html');
  let body: FakeElement | null = null;
  const setBody = (next: FakeElement) => {
    if (body) html.replaceChild(next, body);
    else html.appendChild(next);
    body = next;
  };
  if (withBody) setBody(element('body'));
  const documentEvents = element('#document');
  const windowEvents = element('#window');
  const media = { matches: narrow, listeners: [] as (() => void)[] };
  const warnings: unknown[] = [];
  const hostWindow: Record<string, unknown> = {
    matchMedia: () => ({
      get matches() {
        return media.matches;
      },
      addEventListener: (_type: string, listener: () => void) => {
        media.listeners.push(listener);
      },
    }),
    addEventListener: (type: string, listener: DomListener) => {
      windowEvents.addEventListener(type, listener);
    },
  };
  const hostDocument = {
    currentScript: script,
    documentElement: html,
    get body() {
      return body;
    },
    get activeElement() {
      return activeElement;
    },
    createElement: element,
    createElementNS: (_namespace: string, tagName: string) => element(tagName),
    querySelectorAll: () => [script],
    addEventListener: (type: string, listener: DomListener) => {
      documentEvents.addEventListener(type, listener);
    },
  };
  const context = createContext({
    window: hostWindow,
    document: hostDocument,
    URL,
    console: { warn: (...args: unknown[]) => warnings.push(args) },
  });
  return {
    window: hostWindow,
    html,
    warnings,
    get activeElement() {
      return activeElement;
    },
    /** What the loader put on the page: everything under `<html>` except `<body>`. */
    mounted() {
      return html.children.filter((el) => el !== body);
    },
    load() {
      runInContext(EMBED_SOURCE, context);
    },
    keydown(key: string) {
      documentEvents.emit('keydown', { key });
    },
    message(event: Parameters<DomListener>[0]) {
      windowEvents.emit('message', event);
    },
    /** Rotating the phone flips the narrow-viewport media query. */
    setNarrow(next: boolean) {
      media.matches = next;
      for (const listener of media.listeners) listener();
    },
    /** Turbo Drive-style navigation: a new `<body>` replaces the old one, with everything in it. */
    swapBody() {
      setBody(element('body'));
    },
    /** The parser reaches `<body>`, then the document finishes loading. */
    parseBody() {
      setBody(element('body'));
      documentEvents.emit('DOMContentLoaded');
    },
  };
}

describe('public/embed.js', () => {
  function openedPage(options?: { narrow?: boolean }) {
    const page = hostPage({ 'data-widget-key': EMBED_KEY }, options);
    page.load();
    const launcher = page.mounted()[0]!;
    launcher.emit('click');
    const container = page.mounted()[1]!;
    return { page, launcher, container, iframe: container.children[0]! };
  }

  it('mounts only a launcher until opened, then the chat iframe for this widget', () => {
    const page = hostPage({ 'data-widget-key': EMBED_KEY });
    page.load();
    expect(page.mounted().map((el) => el.tagName)).toEqual(['button']);
    const launcher = page.mounted()[0]!;
    expect(launcher.attributes).toMatchObject({ 'aria-label': 'Open chat', 'aria-expanded': 'false' });
    expect(launcher.style).toMatchObject({ display: 'flex', right: '20px', bottom: '20px', width: '56px' });

    launcher.emit('click');
    const container = page.mounted()[1]!;
    const iframe = container.children[0]!;
    expect(iframe).toMatchObject({ tagName: 'iframe', src: `${APP_ORIGIN}/widget/${EMBED_KEY}?embedded=1`, title: 'Chat' });
    expect(iframe.attributes.allow).toBe('clipboard-write');
    expect(container.style).toMatchObject({ display: 'block', width: '380px', height: '600px' });
    expect(launcher.attributes).toMatchObject({ 'aria-label': 'Close chat', 'aria-expanded': 'true' });
    // Desktop: the launcher stays in its corner below the panel and toggles it.
    expect(launcher.style).toMatchObject({ display: 'flex', bottom: '20px', width: '56px', zIndex: '2147483000' });
  });

  it('closes only for its own iframe on the app origin (or Escape) and returns focus to the launcher', () => {
    const { page, launcher, container, iframe } = openedPage();
    expect(page.activeElement).toBe(iframe);
    const close = { type: 'syncore:close' };

    page.message({ origin: 'https://attacker.example', source: iframe.contentWindow, data: close });
    page.message({ origin: APP_ORIGIN, source: {}, data: close });
    page.message({ origin: APP_ORIGIN, source: iframe.contentWindow, data: { type: 'syncore:other' } });
    expect(container.style.display).toBe('block');

    page.message({ origin: APP_ORIGIN, source: iframe.contentWindow, data: close });
    expect(container.style.display).toBe('none');
    expect(page.activeElement).toBe(launcher);

    launcher.emit('click');
    expect(container.style.display).toBe('block');
    page.keydown('Escape');
    expect(container.style.display).toBe('none');
    // The same iframe is reused, so the conversation survives closing and reopening.
    expect(page.mounted()).toHaveLength(2);
  });

  it('keeps its own close button above the full-screen panel on narrow viewports, even if the chat never loads', () => {
    // Nothing loads in the iframe here (offline, outage): no load event and no message ever arrives.
    const { page, launcher, container } = openedPage({ narrow: true });
    expect(container.style).toMatchObject({ top: '0', left: '0', width: '100%', height: '100%', display: 'block' });
    expect(launcher.style).toMatchObject({ display: 'flex', top: '8px', right: '8px', width: '44px', height: '44px' });
    expect(Number(launcher.style.zIndex)).toBeGreaterThan(Number(container.style.zIndex));
    expect(launcher.attributes).toMatchObject({ 'aria-label': 'Close chat', 'aria-expanded': 'true' });

    launcher.emit('click');
    expect(container.style.display).toBe('none');
    expect(launcher.style).toMatchObject({ top: 'auto', bottom: '20px', width: '56px', zIndex: '2147483000' });

    // Turning the phone to a wide viewport while open brings back the desktop panel and launcher.
    launcher.emit('click');
    page.setNarrow(false);
    expect(container.style).toMatchObject({ width: '380px', height: '600px', display: 'block' });
    expect(launcher.style).toMatchObject({ top: 'auto', bottom: '20px', width: '56px', zIndex: '2147483000' });
  });

  it.each<{ name: string; attributes: Record<string, string> }>([
    { name: 'a missing key', attributes: {} },
    { name: 'a malformed key', attributes: { 'data-widget-key': 'wk_tooShort' } },
  ])('warns and mounts nothing for $name', ({ attributes }) => {
    const page = hostPage(attributes);
    page.load();
    expect(page.mounted()).toEqual([]);
    expect(page.warnings).toHaveLength(1);
    expect(page.window.__syncoreWidget).toBeUndefined();
  });

  it('mounts once when the loader is included twice', () => {
    const page = hostPage({ 'data-widget-key': EMBED_KEY });
    page.load();
    page.load();
    expect(page.mounted()).toHaveLength(1);
  });

  it('keeps the launcher and an open chat when the host swaps <body> and runs the snippet again (Turbo Drive)', () => {
    const { page, launcher, container, iframe } = openedPage();
    page.swapBody();
    page.load();

    expect(page.mounted()).toEqual([launcher, container]);
    expect(launcher.isConnected).toBe(true);
    // The same iframe stays open: the conversation is not reloaded.
    expect(container.children).toEqual([iframe]);
    expect(container.style.display).toBe('block');
    launcher.emit('click');
    expect(container.style.display).toBe('none');
  });

  it('re-attaches what the host removed when the snippet runs again, without duplicates', () => {
    const { page, launcher, container } = openedPage();
    launcher.emit('click');
    launcher.remove();
    container.remove();

    page.load();
    page.load();
    expect(page.mounted()).toEqual([launcher, container]);
    expect(container.style.display).toBe('none');
    launcher.emit('click');
    expect(container.style.display).toBe('block');
  });

  it('waits for <body> when it runs in <head>, even when included twice', () => {
    const page = hostPage({ 'data-widget-key': EMBED_KEY }, { body: false });
    page.load();
    page.load();
    expect(page.mounted()).toEqual([]);

    page.parseBody();
    // After <body>, so keyboard users reach the launcher after the page content.
    expect(page.html.children.map((el) => el.tagName)).toEqual(['body', 'button']);
  });
});
