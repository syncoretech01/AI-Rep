import { describe, expect, it } from 'vitest';
import { businessProfileSchema, hoursIntervalSchema, weeklyHoursSchema } from '@/server/domain/business/schemas';

const EMPTY_PROFILE = {
  businessName: null,
  description: null,
  phone: null,
  email: null,
  website: null,
  address: null,
  serviceArea: null,
};

describe('businessProfileSchema', () => {
  it('trims values and stores blank or missing fields as null', () => {
    expect(
      businessProfileSchema.parse({
        businessName: '  Acme Plumbing  ',
        description: '',
        phone: '   ',
        email: ' hello@acme.example ',
        website: ' https://acme.example/contact ',
        address: null,
      }),
    ).toEqual({
      ...EMPTY_PROFILE,
      businessName: 'Acme Plumbing',
      email: 'hello@acme.example',
      website: 'https://acme.example/contact',
    });
    expect(businessProfileSchema.parse({})).toEqual(EMPTY_PROFILE);
  });

  it.each(['not-an-email', 'a@b', 'hello@acme.example extra'])('rejects the email %j', (email) => {
    const result = businessProfileSchema.safeParse({ email });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Enter a valid email address.');
  });

  it.each(['acme.example', 'ftp://acme.example', 'javascript:alert(1)', 'https://localhost', 'http:/acme.example'])(
    'rejects the website %j',
    (website) => {
      expect(businessProfileSchema.safeParse({ website }).success).toBe(false);
    },
  );

  it('accepts http and https websites', () => {
    expect(businessProfileSchema.parse({ website: 'http://acme.example' }).website).toBe('http://acme.example');
    expect(businessProfileSchema.parse({ website: 'https://www.acme.example/a?b=c' }).website).toBe(
      'https://www.acme.example/a?b=c',
    );
  });

  it.each([
    ['businessName', 160],
    ['description', 1000],
    ['phone', 40],
    ['address', 500],
    ['serviceArea', 500],
  ])('limits %s to %i characters', (field, max) => {
    expect(businessProfileSchema.safeParse({ [field]: 'x'.repeat(max) }).success).toBe(true);
    const result = businessProfileSchema.safeParse({ [field]: 'x'.repeat(max + 1) });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual([field]);
  });

  it('limits the email and website lengths', () => {
    expect(businessProfileSchema.safeParse({ email: `${'a'.repeat(250)}@x.io` }).success).toBe(false);
    expect(businessProfileSchema.safeParse({ website: `https://acme.example/${'p'.repeat(300)}` }).success).toBe(false);
  });
});

describe('hoursIntervalSchema', () => {
  it('accepts HH:MM times up to 24:00', () => {
    expect(hoursIntervalSchema.parse({ dayOfWeek: 0, opensAt: '00:00', closesAt: '24:00' })).toEqual({
      dayOfWeek: 0,
      opensAt: '00:00',
      closesAt: '24:00',
    });
    expect(hoursIntervalSchema.safeParse({ dayOfWeek: 6, opensAt: '22:30', closesAt: '23:59' }).success).toBe(true);
  });

  it.each([
    ['day after Saturday', { dayOfWeek: 7 }],
    ['negative day', { dayOfWeek: -1 }],
    ['fractional day', { dayOfWeek: 1.5 }],
    ['day as text', { dayOfWeek: '1' }],
    ['single-digit hour', { opensAt: '9:00' }],
    ['hour 25', { closesAt: '25:00' }],
    ['minute 60', { opensAt: '12:60' }],
    ['seconds', { opensAt: '09:00:00' }],
    ['past midnight', { closesAt: '24:30' }],
    ['opening at 24:00', { opensAt: '24:00', closesAt: '24:00' }],
  ])('rejects %s', (_label, override) => {
    expect(hoursIntervalSchema.safeParse({ dayOfWeek: 1, opensAt: '09:00', closesAt: '17:00', ...override }).success).toBe(
      false,
    );
  });

  it('requires the closing time to be after the opening time', () => {
    for (const closesAt of ['09:00', '08:59']) {
      const result = hoursIntervalSchema.safeParse({ dayOfWeek: 1, opensAt: '09:00', closesAt });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]).toMatchObject({
        path: ['closesAt'],
        message: 'Closing time must be after opening time.',
      });
    }
  });

  it('reports a malformed time once, not also as closing before opening', () => {
    // As text, '9:00' sorts after '17:00'.
    const result = hoursIntervalSchema.safeParse({ dayOfWeek: 1, opensAt: '9:00', closesAt: '17:00' });
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: ['opensAt'], message: 'Use a time between 00:00 and 24:00 (HH:MM).' }),
    ]);
  });
});

describe('weeklyHoursSchema', () => {
  const interval = (dayOfWeek: number, opensAt: string, closesAt: string) => ({ dayOfWeek, opensAt, closesAt });

  it('accepts split days, touching intervals and the same hours on different days', () => {
    const week = [
      interval(1, '09:00', '12:00'),
      interval(1, '12:00', '17:00'),
      interval(2, '09:00', '17:00'),
      interval(5, '22:00', '24:00'),
      interval(6, '00:00', '06:00'),
    ];
    expect(weeklyHoursSchema.parse(week)).toEqual(week);
    expect(weeklyHoursSchema.parse([])).toEqual([]);
  });

  it('rejects overlapping intervals on the same day, pointing at the later one', () => {
    const result = weeklyHoursSchema.safeParse([interval(3, '13:00', '18:00'), interval(3, '09:00', '14:00')]);
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: [0], message: 'Wednesday has overlapping opening hours.' }),
    ]);
  });

  it('finds overlaps with an earlier, non-adjacent interval', () => {
    const result = weeklyHoursSchema.safeParse([
      interval(1, '09:00', '17:00'),
      interval(1, '10:00', '11:00'),
      interval(1, '12:00', '13:00'),
    ]);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([[1], [2]]);
  });

  it('leaves invalid intervals out of the overlap check but still reports real overlaps', () => {
    const result = weeklyHoursSchema.safeParse([
      // Malformed close: compared as text, '9:00' would look later than the 10:00 opening below.
      interval(1, '08:00', '9:00'),
      interval(1, '10:00', '11:00'),
      interval(2, '09:00', '14:00'),
      interval(2, '13:00', '15:00'),
    ]);
    expect(result.error?.issues.map((issue) => [issue.path, issue.message])).toEqual([
      [[0, 'closesAt'], 'Use a time between 00:00 and 24:00 (HH:MM).'],
      [[3], 'Tuesday has overlapping opening hours.'],
    ]);
  });

  it('rejects duplicate intervals', () => {
    expect(weeklyHoursSchema.safeParse([interval(4, '09:00', '17:00'), interval(4, '09:00', '17:00')]).success).toBe(
      false,
    );
  });

  it('rejects more than 28 intervals', () => {
    // Five one-hour slots (00:00, 02:00, … 08:00) on every day: no overlaps, 35 intervals.
    const hour = (value: number) => `${String(value).padStart(2, '0')}:00`;
    const many = [0, 2, 4, 6, 8].flatMap((start) => [0, 1, 2, 3, 4, 5, 6].map((day) => interval(day, hour(start), hour(start + 1))));
    expect(weeklyHoursSchema.safeParse(many.slice(0, 28)).success).toBe(true);
    const result = weeklyHoursSchema.safeParse(many.slice(0, 29));
    expect(result.error?.issues[0]?.message).toBe('Add at most 28 opening intervals.');
  });
});
