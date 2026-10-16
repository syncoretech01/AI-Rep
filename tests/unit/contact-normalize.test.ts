import { describe, expect, it } from 'vitest';
import { normalizeEmail, normalizePhone } from '@/server/domain/contacts/normalize';

describe('normalizePhone', () => {
  it.each([
    ['+1 (555) 123-4567', '+15551234567'],
    ['0300-1234567', '03001234567'],
    ['555 123 4567', '5551234567'],
    ['555.123.4567', '5551234567'],
    ['  +44 20 7946 0958  ', '+442079460958'],
    ['(020)\u{A0}7946-0958', '02079460958'],
    ['1234567', '1234567'],
    ['+123456789012345', '+123456789012345'],
  ])('normalizes %j to %j', (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });

  it.each([
    ['letters', '555-CALL-NOW'],
    ['an extension', '+1 555 123 4567 ext 12'],
    ['too few digits', '123456'],
    ['too many digits', '+1234567890123456'],
    ['a double plus', '++15551234567'],
    ['a plus after the first digit', '1+5551234567'],
    ['other symbols', '555#123#4567'],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('rejects %s', (_case, raw) => {
    expect(normalizePhone(raw)).toBeNull();
  });
});

describe('normalizeEmail', () => {
  it('trims and lower-cases a valid address', () => {
    expect(normalizeEmail('  Jane.Doe+Quotes@Example.COM ')).toBe('jane.doe+quotes@example.com');
  });

  it.each([
    ['no at sign', 'jane.example.com'],
    ['no domain', 'jane@'],
    ['no local part', '@example.com'],
    ['inner whitespace', 'jane doe@example.com'],
    ['no top-level domain', 'jane@example'],
    ['an empty string', ''],
    ['more than 254 characters', `${'a'.repeat(250)}@example.com`],
  ])('rejects %s', (_case, raw) => {
    expect(normalizeEmail(raw)).toBeNull();
  });
});
