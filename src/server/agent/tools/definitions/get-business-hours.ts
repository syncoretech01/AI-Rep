import { z } from 'zod';
import { computeHoursStatus, type HoursStatus } from '@/server/domain/business/hours';
import { listBusinessHours } from '@/server/domain/business/repository';
import { defineTool, type ToolOutcome } from '../types';

export type BusinessHoursData = HoursStatus | { configured: false; note: string };

export const getBusinessHours = defineTool({
  name: 'getBusinessHours',
  description:
    "Get the business's weekly opening hours, whether it is open right now (in the business's time zone) and when " +
    'that next changes. Use it for any question about opening hours or availability today.',
  input: z.object({}),
  channels: ['web_chat'],
  requires: ['business_info'],
  sideEffects: 'none',
  idempotency: 'none',
  label: 'Checking our hours',
  async handler(_input, ctx): Promise<ToolOutcome<BusinessHoursData>> {
    const intervals = await ctx.db.run((sql) => listBusinessHours(sql, ctx.organizationId, ctx.agent.id));
    if (intervals.length === 0) {
      return { ok: true, data: { configured: false, note: 'Business hours are not configured.' } };
    }
    return { ok: true, data: computeHoursStatus(intervals, ctx.agent.timezone, ctx.now) };
  },
});
