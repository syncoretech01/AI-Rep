import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@/server/observability/logger';

function captureLines(): { lines: () => Record<string, unknown>[] } {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  return {
    lines: () =>
      [...log.mock.calls, ...error.mock.calls].map((call) => JSON.parse(String(call[0])) as Record<string, unknown>),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createLogger', () => {
  it('redacts secrets and contact details but keeps usage counters', () => {
    const capture = captureLines();
    createLogger().info('usage.recorded', {
      sessionToken: 'abc',
      token: 'def',
      apiKey: 'sk-123',
      authorization: 'Bearer x',
      phone: '+15551234567',
      email: 'a@b.test',
      inputTokens: 120,
      outputTokens: 30,
      tokenCount: 7,
      nested: { password: 'p', maxOutputTokens: 800 },
    });

    const [line] = capture.lines();
    expect(line).toMatchObject({
      level: 'info',
      event: 'usage.recorded',
      sessionToken: '[redacted]',
      token: '[redacted]',
      apiKey: '[redacted]',
      authorization: '[redacted]',
      phone: '[redacted]',
      email: '[redacted]',
      inputTokens: 120,
      outputTokens: 30,
      tokenCount: 7,
      nested: { password: '[redacted]', maxOutputTokens: 800 },
    });
  });

  it('respects the minimum level and child bindings', () => {
    const capture = captureLines();
    const logger = createLogger({ level: 'warn', bindings: { service: 'test' } }).child({ requestId: 'r1' });
    logger.info('ignored');
    logger.warn('kept', { detail: 'x' });

    const lines = capture.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'warn', event: 'kept', service: 'test', requestId: 'r1', detail: 'x' });
  });

  it('serializes errors without stack traces and truncates long strings', () => {
    const capture = captureLines();
    createLogger().error('failed', { error: new Error('boom'), text: 'x'.repeat(2000) });

    const [line] = capture.lines();
    expect(line?.error).toEqual({ name: 'Error', message: 'boom' });
    expect(String(line?.text).length).toBeLessThan(600);
  });
});
