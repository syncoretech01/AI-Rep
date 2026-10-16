import { z } from 'zod';

/**
 * Wire protocol between the embeddable chat widget (browser) and the public
 * web chat API. Isomorphic: imported by route handlers and the widget client.
 * Nothing here may reference server modules or secrets.
 */

export const WIDGET_KEY_PATTERN = /^wk_[A-Za-z0-9]{24,64}$/;
export const MAX_VISITOR_MESSAGE_CHARS = 2000;
export const MAX_SESSION_TOKEN_CHARS = 2048;

export const widgetKeySchema = z.string().regex(WIDGET_KEY_PATTERN, 'invalid widget key');
const sessionTokenSchema = z.string().min(1).max(MAX_SESSION_TOKEN_CHARS);

export const sessionRequestSchema = z.object({
  widgetKey: widgetKeySchema,
  sessionToken: sessionTokenSchema.optional(),
});
export type SessionRequest = z.infer<typeof sessionRequestSchema>;

export const publicMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  createdAt: z.string(),
});
export type PublicMessage = z.infer<typeof publicMessageSchema>;

export const publicAgentSchema = z.object({
  name: z.string(),
  greeting: z.string(),
  /** BCP-47 tag of the agent's reply language (the default; replies may follow the visitor's language). */
  language: z.string(),
});
export type PublicAgent = z.infer<typeof publicAgentSchema>;

export const sessionResponseSchema = z.object({
  sessionToken: z.string(),
  agent: publicAgentSchema,
  conversation: z
    .object({
      id: z.string(),
      messages: z.array(publicMessageSchema),
    })
    .nullable(),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const sendMessageRequestSchema = z.object({
  widgetKey: widgetKeySchema,
  sessionToken: sessionTokenSchema,
  text: z.string().trim().min(1, 'message is empty').max(MAX_VISITOR_MESSAGE_CHARS, 'message is too long'),
});
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

export const resetRequestSchema = z.object({
  widgetKey: widgetKeySchema,
  sessionToken: sessionTokenSchema,
});
export type ResetRequest = z.infer<typeof resetRequestSchema>;

export const resetResponseSchema = z.object({
  ok: z.literal(true),
  sessionToken: z.string(),
});
export type ResetResponse = z.infer<typeof resetResponseSchema>;

export const apiErrorCodeSchema = z.enum([
  'invalid_request',
  'widget_unavailable',
  'invalid_session',
  'rate_limited',
  'conversation_busy',
  'provider_unavailable',
  'internal',
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** Server-sent events emitted while the agent answers one visitor message. */
export const widgetEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('turn.start'), turnId: z.string(), conversationId: z.string() }),
  z.object({ type: z.literal('text.delta'), turnId: z.string(), delta: z.string() }),
  z.object({
    type: z.literal('tool.call'),
    turnId: z.string(),
    callId: z.string(),
    name: z.string(),
    label: z.string(),
  }),
  z.object({
    type: z.literal('tool.result'),
    turnId: z.string(),
    callId: z.string(),
    name: z.string(),
    ok: z.boolean(),
  }),
  // `text` is the authoritative reply: show it in place of the streamed deltas (provisional text from a round that
  // called a write tool is dropped, and a fallback sentence may be appended).
  z.object({
    type: z.literal('turn.done'),
    turnId: z.string(),
    messageId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('turn.error'),
    turnId: z.string().nullable(),
    code: apiErrorCodeSchema,
    message: z.string(),
    recoverable: z.boolean(),
  }),
]);
export type WidgetEvent = z.infer<typeof widgetEventSchema>;

export const SSE_CONTENT_TYPE = 'text/event-stream; charset=utf-8';

export function encodeSseEvent(event: WidgetEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Incremental SSE parser for `fetch` response bodies (EventSource cannot POST).
 * Feed decoded text chunks; valid events are passed to `onEvent`, malformed
 * frames to `onInvalid`.
 */
export function createSseParser(
  onEvent: (event: WidgetEvent) => void,
  onInvalid: (raw: string) => void = () => undefined,
): { push(chunk: string): void; flush(): void } {
  let buffer = '';
  // Like EventSource: a CR ends a line immediately; if the previous chunk ended in CR, a leading LF
  // in the next chunk is the second half of that CRLF pair and is skipped.
  let skipLeadingLineFeed = false;

  const dispatch = (frame: string) => {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) return;
    try {
      const parsed = widgetEventSchema.safeParse(JSON.parse(data));
      if (parsed.success) onEvent(parsed.data);
      else onInvalid(data);
    } catch {
      onInvalid(data);
    }
  };

  return {
    push(chunk: string) {
      if (chunk === '') return;
      const text = skipLeadingLineFeed && chunk.startsWith('\n') ? chunk.slice(1) : chunk;
      skipLeadingLineFeed = chunk.endsWith('\r');
      buffer += text.replace(/\r\n?/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        dispatch(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
    },
    flush() {
      skipLeadingLineFeed = false;
      if (buffer.trim()) dispatch(buffer);
      buffer = '';
    },
  };
}
