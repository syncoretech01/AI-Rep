import type { WidgetEvent } from '@/shared/widget-protocol';
import type { TenantSpec } from '../support/app-harness';

/**
 * Tenants of the Phase 1 acceptance suite, with distinctive knowledge so that any fact can be traced back
 * to the tenant it belongs to. Both main tenants also hold a "Prices" source answering the same question
 * with different numbers: equally relevant evidence, so only tenant scoping decides which one a widget sees.
 */

const MONDAY_TO_FRIDAY = [1, 2, 3, 4, 5];

/** Tenant A: a heating company (America/Chicago). */
export const SPRINGFIELD = {
  name: 'Springfield Comfort Heating',
  agent: {
    name: 'Sky',
    status: 'active',
    greeting: "Hi, I'm Sky from Springfield Comfort Heating. How can I help?",
    language: 'en',
    timezone: 'America/Chicago',
    instructions: 'Keep answers short and friendly. Offer a callback whenever you cannot help.',
    leadCapture: { enabled: true, requiredFields: ['name', 'phone'] },
  },
  profile: {
    businessName: 'Springfield Comfort Heating',
    description: 'Boiler and furnace repair for homes in Springfield.',
    phone: '(217) 555-0142',
    email: 'hello@springfield-heating.example',
    website: 'https://springfield-heating.example',
    address: '742 Evergreen Terrace, Springfield',
    serviceArea: 'Springfield and Capital City',
  },
  hours: [
    ...MONDAY_TO_FRIDAY.map((dayOfWeek) => ({ dayOfWeek, opensAt: '08:00', closesAt: '18:00' })),
    { dayOfWeek: 6, opensAt: '09:00', closesAt: '13:00' },
  ],
  knowledge: [
    { title: 'Emergency service', text: '# Emergency service\nWe offer 24/7 emergency boiler repair across Springfield.' },
    { title: 'Prices', text: '# Pricing\nOur standard call-out fee is $89 per visit.' },
  ],
} satisfies TenantSpec;

export const SPRINGFIELD_FACTS = {
  emergency: 'We offer 24/7 emergency boiler repair across Springfield.',
  fee: 'Our standard call-out fee is $89 per visit.',
};

/** Tenant B: a pinball restorer (America/New_York). */
export const SHELBYVILLE = {
  name: 'Shelbyville Pinball Restoration',
  agent: {
    name: 'Riley',
    status: 'active',
    greeting: "Welcome to Shelbyville Pinball Restoration! I'm Riley.",
    language: 'en',
    timezone: 'America/New_York',
    instructions: 'Be enthusiastic about pinball.',
    leadCapture: { enabled: true, requiredFields: ['phone'] },
  },
  profile: {
    businessName: 'Shelbyville Pinball Restoration',
    description: 'Restoration and repair of classic arcade machines.',
    phone: '(937) 555-0199',
    email: 'shop@shelbyville-pinball.example',
    website: 'https://shelbyville-pinball.example',
    address: '19 Lard Lad Road, Shelbyville',
    serviceArea: 'Shelbyville',
  },
  hours: [3, 4, 5, 6, 0].map((dayOfWeek) => ({ dayOfWeek, opensAt: '10:00', closesAt: '16:00' })),
  knowledge: [
    { title: 'Restoration', text: '# Restoration\nWe restore vintage pinball machines in Shelbyville.' },
    { title: 'Prices', text: '# Pricing\nOur standard call-out fee is $149 per visit.' },
  ],
} satisfies TenantSpec;

export const SHELBYVILLE_FACTS = {
  restoration: 'We restore vintage pinball machines in Shelbyville.',
  fee: 'Our standard call-out fee is $149 per visit.',
};

/** Text that may only ever appear in its own tenant's tool outputs and replies. */
export const SPRINGFIELD_MARKERS = ['24/7 emergency boiler repair', '$89'];
export const SHELBYVILLE_MARKERS = ['vintage pinball', '$149'];

/** A tenant whose agent does not take contact details. */
export const OGDENVILLE = {
  name: 'Ogdenville Locksmiths',
  agent: {
    name: 'Max',
    status: 'active',
    greeting: 'Hello from Ogdenville Locksmiths.',
    language: 'en',
    timezone: 'UTC',
    instructions: '',
    leadCapture: { enabled: false, requiredFields: [] },
  },
  profile: {
    businessName: 'Ogdenville Locksmiths',
    description: null,
    phone: null,
    email: null,
    website: null,
    address: null,
    serviceArea: null,
  },
  hours: [],
  knowledge: [{ title: 'Locks', text: '# Locks\nWe rekey and replace door locks in Ogdenville.' }],
} satisfies TenantSpec;

/** A tenant used to switch the embedding model. */
export const CAPITAL_CITY = {
  name: 'Capital City Gutters',
  agent: {
    name: 'Jo',
    status: 'active',
    greeting: 'Hi from Capital City Gutters!',
    language: 'en',
    timezone: 'UTC',
    instructions: '',
    leadCapture: { enabled: true, requiredFields: ['name', 'phone'] },
  },
  profile: {
    businessName: 'Capital City Gutters',
    description: null,
    phone: null,
    email: null,
    website: null,
    address: null,
    serviceArea: null,
  },
  hours: [],
  knowledge: [{ title: 'Gutters', text: '# Gutters\nWe offer same-day gutter cleaning in Capital City.' }],
} satisfies TenantSpec;

export const CAPITAL_CITY_FACT = 'We offer same-day gutter cleaning in Capital City.';

/** Visitor messages. */
export const QUESTIONS = {
  emergency: 'Do you offer emergency boiler repair?',
  fee: 'What is your standard call-out fee?',
  pinball: 'Do you restore vintage pinball machines in Shelbyville?',
  /** Shares only the word "repair" with tenant A's knowledge: below the relevance threshold. */
  unknown: 'Do you repair spaceships?',
  hours: 'When are you open?',
  phone: 'What is your phone number?',
  gutters: 'Do you offer same-day gutter cleaning?',
};

export const LEAD_MESSAGE = "I'm Jane Doe, my number is (555) 123-4567 — please call me about a quote";

/** Event types of a turn, consecutive text deltas collapsed into one entry. */
export function eventTypes(events: readonly WidgetEvent[]): string[] {
  return events
    .map((event) => event.type)
    .filter((type, index, all) => type !== 'text.delta' || all[index - 1] !== 'text.delta');
}
