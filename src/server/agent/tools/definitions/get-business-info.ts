import { z } from 'zod';
import { getBusinessProfile } from '@/server/domain/business/repository';
import type { BusinessProfile } from '@/server/domain/business/types';
import { defineTool, type ToolOutcome } from '../types';

const FIELDS = ['businessName', 'description', 'phone', 'email', 'website', 'address', 'serviceArea'] as const;

type BusinessInfoField = (typeof FIELDS)[number];

export type BusinessInfoData = Partial<Record<BusinessInfoField, string>> & { note?: string };

export const getBusinessInfo = defineTool({
  name: 'getBusinessInfo',
  description:
    "Get the business's contact details: name, description, phone, email, website, address and service area. " +
    'Use it whenever the visitor asks how to reach the business, where it is or which area it serves. ' +
    'Share only the details it returns.',
  input: z.object({}),
  channels: ['web_chat'],
  requires: ['business_info'],
  sideEffects: 'none',
  idempotency: 'none',
  label: 'Looking up our details',
  async handler(_input, ctx): Promise<ToolOutcome<BusinessInfoData>> {
    const profile = await ctx.db.run((sql) => getBusinessProfile(sql, ctx.organizationId, ctx.agent.id));
    const data = profile ? configuredFields(profile) : {};
    if (Object.keys(data).length === 0) return { ok: true, data: { note: 'No business details are configured.' } };
    return { ok: true, data };
  },
});

/** Only what the owner filled in: an absent field must read as "unknown", never as an empty value to repeat. */
function configuredFields(profile: BusinessProfile): BusinessInfoData {
  const data: BusinessInfoData = {};
  for (const field of FIELDS) {
    const value = profile[field];
    if (value !== null) data[field] = value;
  }
  return data;
}
