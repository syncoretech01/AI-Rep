import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_AGENT_SETTINGS,
  agentSettingsSchema,
  isValidTimeZone,
  leadCaptureSettingsSchema,
  parseLeadCapture,
} from '@/server/domain/agents/schemas';
import { generateWidgetKey, randomString } from '@/server/domain/agents/widget-key';
import { WIDGET_KEY_PATTERN } from '@/shared/widget-protocol';

const valid = {
  name: 'Front Desk',
  status: 'active',
  greeting: 'Hi there! How can we help?',
  language: 'en-US',
  timezone: 'America/New_York',
  instructions: 'Keep answers short.',
  leadCapture: { enabled: true, requiredFields: ['phone', 'name'] },
};

function issuePaths(value: unknown): string[] {
  const result = agentSettingsSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('isValidTimeZone', () => {
  it.each(['UTC', 'America/New_York', 'Asia/Karachi', 'Europe/London', 'Etc/GMT+5'])('accepts %s', (zone) => {
    expect(isValidTimeZone(zone)).toBe(true);
  });

  it.each(['', 'Mars/Phobos', 'America/Atlantis', '+05:00', '-08:00', 'not a zone'])('rejects %j', (zone) => {
    expect(isValidTimeZone(zone)).toBe(false);
  });
});

describe('agentSettingsSchema', () => {
  it('accepts valid settings, trimming text and normalizing required lead fields', () => {
    const parsed = agentSettingsSchema.parse({
      ...valid,
      name: '  Front Desk  ',
      greeting: '  Hello!  ',
      instructions: '  Be brief.  ',
      leadCapture: { enabled: true, requiredFields: ['phone', 'name', 'phone'] },
    });
    expect(parsed).toEqual({
      ...valid,
      greeting: 'Hello!',
      instructions: 'Be brief.',
      leadCapture: { enabled: true, requiredFields: ['name', 'phone'] },
    });
  });

  it('accepts the documented limits', () => {
    expect(
      agentSettingsSchema.safeParse({
        ...valid,
        name: 'n'.repeat(80),
        greeting: 'g'.repeat(500),
        instructions: 'i'.repeat(4000),
        language: 'zh-Hant-TW',
        leadCapture: { enabled: false, requiredFields: [] },
      }).success,
    ).toBe(true);
  });

  it.each([
    ['blank name', { name: '   ' }, 'name'],
    ['long name', { name: 'n'.repeat(81) }, 'name'],
    ['unknown status', { status: 'deleted' }, 'status'],
    ['blank greeting', { greeting: '' }, 'greeting'],
    ['long greeting', { greeting: 'g'.repeat(501) }, 'greeting'],
    ['language name', { language: 'english' }, 'language'],
    ['underscore language', { language: 'en_US' }, 'language'],
    ['dangling subtag', { language: 'en-' }, 'language'],
    // Too long and malformed: still one issue (the length check stops the field's checks).
    ['long language', { language: 'x'.repeat(40) }, 'language'],
    ['unknown timezone', { timezone: 'Mars/Phobos' }, 'timezone'],
    ['offset timezone', { timezone: '+05:00' }, 'timezone'],
    ['long timezone', { timezone: 'A'.repeat(65) }, 'timezone'],
    ['long instructions', { instructions: 'i'.repeat(4001) }, 'instructions'],
    ['unknown lead field', { leadCapture: { enabled: true, requiredFields: ['address'] } }, 'leadCapture.requiredFields.0'],
    [
      'too many lead fields',
      { leadCapture: { enabled: true, requiredFields: ['name', 'phone', 'email', 'name'] } },
      'leadCapture.requiredFields',
    ],
    ['missing lead capture', { leadCapture: undefined }, 'leadCapture'],
  ])('rejects %s', (_label, override, path) => {
    expect(issuePaths({ ...valid, ...override })).toEqual([path]);
  });

  it('describes problems in words an admin can act on', () => {
    const result = agentSettingsSchema.safeParse({ ...valid, timezone: 'Mars/Phobos' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Choose a valid time zone, e.g. America/New_York.');
  });

  it('has defaults that satisfy the schema', () => {
    expect(agentSettingsSchema.parse({ name: 'Receptionist', ...DEFAULT_AGENT_SETTINGS })).toEqual({
      name: 'Receptionist',
      ...DEFAULT_AGENT_SETTINGS,
    });
  });
});

describe('leadCaptureSettingsSchema', () => {
  it('deduplicates required fields in a stable order', () => {
    expect(leadCaptureSettingsSchema.parse({ enabled: true, requiredFields: ['email', 'name', 'email'] })).toEqual({
      enabled: true,
      requiredFields: ['name', 'email'],
    });
  });

  it('requires an explicit enabled flag', () => {
    expect(leadCaptureSettingsSchema.safeParse({ requiredFields: [] }).success).toBe(false);
  });
});

describe('parseLeadCapture', () => {
  it('reads a stored value', () => {
    expect(parseLeadCapture({ enabled: false, requiredFields: ['email'] })).toEqual({
      enabled: false,
      requiredFields: ['email'],
    });
  });

  it.each([null, undefined, 'yes', 42, []])('falls back to the defaults for %j', (value) => {
    expect(parseLeadCapture(value)).toEqual({ enabled: true, requiredFields: ['name', 'phone'] });
  });

  it('keeps valid parts of a damaged value', () => {
    // A disabled flag must survive a broken field list (falling back to "enabled" would surprise the owner).
    expect(parseLeadCapture({ enabled: false, requiredFields: 'name' })).toEqual({
      enabled: false,
      requiredFields: ['name', 'phone'],
    });
    expect(parseLeadCapture({ enabled: 'no', requiredFields: ['email', 'address', 'email'] })).toEqual({
      enabled: true,
      requiredFields: ['email'],
    });
    expect(parseLeadCapture({ enabled: true, requiredFields: [], extra: 1 })).toEqual({ enabled: true, requiredFields: [] });
  });

  it('returns a fresh value every time', () => {
    const first = parseLeadCapture(null);
    first.requiredFields.push('email');
    expect(parseLeadCapture(null).requiredFields).toEqual(['name', 'phone']);
  });
});

describe('generateWidgetKey', () => {
  it('produces wk_ + 32 alphanumerics accepted by the widget protocol', () => {
    const keys = Array.from({ length: 1000 }, () => generateWidgetKey());
    for (const key of keys) {
      expect(key).toMatch(/^wk_[A-Za-z0-9]{32}$/);
      expect(key).toMatch(WIDGET_KEY_PATTERN);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('uses the whole alphabet evenly', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 2000; i += 1) {
      for (const char of generateWidgetKey().slice(3)) counts.set(char, (counts.get(char) ?? 0) + 1);
    }
    // 64,000 characters over 62 symbols: about 1,032 each (σ ≈ 32).
    expect(counts.size).toBe(62);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(800);
      expect(count).toBeLessThan(1300);
    }
  });

  it('discards bytes that would bias the distribution instead of wrapping them', () => {
    let call = 0;
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
      if (array instanceof Uint8Array) {
        call += 1;
        for (let index = 0; index < array.length; index += 1) {
          // First batch: only bytes >= 248 (62 * 4), which must all be discarded; then 0, 1, 2, …
          array[index] = call === 1 ? 248 + (index % 8) : index;
        }
      }
      return array;
    });
    expect(generateWidgetKey()).toBe('wk_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef');
    expect(call).toBe(2);
  });

  it('builds random strings over any small alphabet', () => {
    expect(randomString('ab', 64)).toMatch(/^[ab]{64}$/);
    expect(randomString('ab', 0)).toBe('');
    expect(() => randomString('a', 4)).toThrow();
  });

  it.each([2.5, -1, Number.NaN])('rejects the length %d instead of returning a string of another length', (length) => {
    expect(() => randomString('ab', length)).toThrow('length must be a non-negative integer');
  });
});
