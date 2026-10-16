import { z } from 'zod';
import type { LeadField } from '@/server/domain/agents/types';
import { normalizeEmail, normalizePhone } from '@/server/domain/contacts/normalize';
import { captureLead as saveLead, type CapturedField } from '@/server/domain/contacts/service';
import { DomainError } from '@/server/domain/types';
import { defineTool, type ToolOutcome } from '../types';

/** Models send null or '' for details they do not have: both mean "not provided". */
function optionalText(maxChars: number) {
  return z
    .string()
    .trim()
    .max(maxChars)
    .nullish()
    .transform((value) => value || null);
}

const input = z.object({
  name: optionalText(160).describe("The visitor's name, as they gave it."),
  phone: optionalText(40)
    .refine((value) => value === null || normalizePhone(value) !== null, 'Not a valid phone number.')
    .describe("The visitor's phone number, as they gave it."),
  email: optionalText(254)
    .refine((value) => value === null || normalizeEmail(value) !== null, 'Not a valid email address.')
    .describe("The visitor's email address."),
  summary: optionalText(1000).describe('One or two sentences on what the visitor needs.'),
});

/** A detail the visitor still has to give. A phone number or an email address is always required. */
export type MissingDetail = LeadField | 'phone or email';

const MISSING_LABELS: Record<MissingDetail, string> = {
  name: 'their name',
  phone: 'a phone number',
  email: 'an email address',
  'phone or email': 'a phone number or email address',
};

export interface CaptureLeadData {
  saved: true;
  /** Every detail now on record for this conversation's request, including ones saved by earlier calls. */
  fields: CapturedField[];
  updatedExistingLead: boolean;
}

export const captureLead = defineTool({
  name: 'captureLead',
  description:
    "Save the visitor's contact details and request so the business can follow up. Call it once the visitor has " +
    'given the details you were told to collect (a phone number or email address is always required). Pass only ' +
    'what the visitor actually said. Calling it again in this conversation updates the saved request. On success, ' +
    '`fields` lists the details now on record. Never tell the visitor their details were saved unless this returns ' +
    'ok: true.',
  input,
  channels: ['web_chat'],
  requires: ['lead_capture'],
  sideEffects: 'writes',
  idempotency: 'conversation_arguments',
  label: 'Saving your details',
  async handler(details, ctx): Promise<ToolOutcome<CaptureLeadData>> {
    const missing = missingDetails(details, ctx.agent.leadCapture.requiredFields);
    if (missing.length > 0) {
      return {
        ok: false,
        error: {
          code: 'missing_information',
          message: `Ask the visitor for: ${missing.map((detail) => MISSING_LABELS[detail]).join(' and ')}.`,
          retryable: true,
          details: { missing },
        },
      };
    }

    try {
      const result = await ctx.db.run((sql) =>
        saveLead(sql, {
          organizationId: ctx.organizationId,
          agentId: ctx.agent.id,
          conversationId: ctx.conversationId,
          channel: ctx.channel,
          ...details,
        }),
      );
      // Ids stay server-side: the model only learns what the lead holds (every detail given is stored on it).
      return { ok: true, data: { saved: true, fields: result.savedFields, updatedExistingLead: !result.created } };
    } catch (error) {
      if (error instanceof DomainError && error.code === 'invalid') {
        return { ok: false, error: { code: 'invalid_arguments', message: error.message, retryable: true } };
      }
      throw error;
    }
  },
});

function missingDetails(
  details: Record<LeadField, string | null>,
  requiredFields: readonly LeadField[],
): MissingDetail[] {
  const missing: MissingDetail[] = requiredFields.filter((field) => details[field] === null);
  const hasContactRoute = details.phone !== null || details.email !== null;
  if (!hasContactRoute && !missing.includes('phone') && !missing.includes('email')) missing.push('phone or email');
  return missing;
}
