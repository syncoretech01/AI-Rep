/**
 * Structured JSON logger with redaction. Never log raw provider payloads,
 * secrets, or visitor contact details.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
// Secret-like keys (`token`, `sessionToken`, `apiKey`…) and contact PII are redacted. Usage counters such as
// `inputTokens` or `tokenCount` are not: only keys that END in "token" count as secrets.
const SENSITIVE_KEY = /(pass(word|wd)?$|secret|api[-_]?key|authorization|cookie|jwt|claims|phone|email|token$)/i;
const MAX_STRING = 500;
const MAX_DEPTH = 4;

function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message.slice(0, MAX_STRING), code: (value as { code?: unknown }).code };
  }
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redact(inner, depth + 1);
  }
  return out;
}

export function createLogger(options: { level?: LogLevel; bindings?: LogFields } = {}): Logger {
  const minimum = LEVELS[options.level ?? 'info'];
  const bindings = options.bindings ?? {};

  const write = (level: LogLevel, event: string, fields: LogFields = {}) => {
    if (LEVELS[level] < minimum) return;
    const line = JSON.stringify({
      level,
      time: new Date().toISOString(),
      event,
      ...(redact({ ...bindings, ...fields }) as LogFields),
    });
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
  };

  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    child: (extra) => createLogger({ level: options.level, bindings: { ...bindings, ...extra } }),
  };
}

/** Logger that discards everything (tests). */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};
