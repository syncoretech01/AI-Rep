import type { ScopedDb } from '@/server/db/scope';
import { maybeOne, one, toDate } from '@/server/db/sql';
import type { Sql } from '@/server/db/types';
import { DomainError, type Channel } from '@/server/domain/types';
import { normalizeEmail, normalizePhone } from './normalize';
import type { Contact, Lead, LeadListItem, LeadStatus } from './types';

export interface CaptureLeadInput {
  organizationId: string;
  agentId: string;
  conversationId: string | null;
  channel: Channel;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  summary?: string | null;
}

export type CapturedField = 'name' | 'phone' | 'email' | 'summary';

export interface CaptureLeadResult {
  leadId: string;
  contactId: string;
  /** False when the call updated the conversation's existing lead. */
  created: boolean;
  /** The details the lead now holds: this capture's, plus what earlier captures in the conversation stored. */
  savedFields: CapturedField[];
}

/** Name, phone number and email address of a person, as shown. */
export interface PersonDetails {
  name: string | null;
  phone: string | null;
  email: string | null;
}

export interface VisitorDetails {
  details: PersonDetails;
  /** The linked contact, when it holds other details than `details`. */
  linkedContact: Contact | null;
}

// Column limits from supabase/migrations (contacts, leads).
const MAX_NAME_CHARS = 160;
const MAX_PHONE_CHARS = 40;
const MAX_SUMMARY_CHARS = 2000;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONTACT_COLUMNS =
  'id, organization_id, name, phone, email, phone_normalized, email_normalized, created_at, updated_at';
const LEAD_COLUMNS = `l.id, l.organization_id, l.agent_id, l.contact_id, l.conversation_id, l.channel, l.status,
  l.summary, l.captured_name, l.captured_phone, l.captured_email, l.created_at, l.updated_at`;

interface ContactRow {
  id: string;
  organization_id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  phone_normalized: string | null;
  email_normalized: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface LeadRow {
  id: string;
  organization_id: string;
  agent_id: string;
  contact_id: string;
  conversation_id: string | null;
  channel: Channel;
  status: LeadStatus;
  summary: string | null;
  captured_name: string | null;
  captured_phone: string | null;
  captured_email: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface LeadListRow extends LeadRow {
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  contact_created_at: Date | string;
  contact_updated_at: Date | string;
  agent_name: string;
}

interface ContactDetails {
  name: string | null;
  phone: { display: string; normalized: string } | null;
  email: { display: string; normalized: string } | null;
}

function mapContact(row: ContactRow): Contact {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapLead(row: LeadRow): Lead {
  return {
    id: row.id,
    organizationId: row.organization_id,
    agentId: row.agent_id,
    contactId: row.contact_id,
    conversationId: row.conversation_id,
    channel: row.channel,
    status: row.status,
    summary: row.summary,
    capturedName: row.captured_name,
    capturedPhone: row.captured_phone,
    capturedEmail: row.captured_email,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

/** Caps text at `maxChars` without splitting a surrogate pair (Postgres counts code points). */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Trims and caps free text; Postgres text cannot hold NUL characters. Empty -> null. */
function cleanText(value: string | null | undefined, maxChars: number): string | null {
  const text = truncate((value ?? '').replaceAll('\u0000', '').trim(), maxChars).trimEnd();
  return text === '' ? null : text;
}

function parseDetails(input: Pick<CaptureLeadInput, 'name' | 'phone' | 'email'>): ContactDetails {
  const phoneRaw = input.phone?.trim().replace(/\s+/g, ' ') ?? '';
  const emailRaw = input.email?.trim() ?? '';
  const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
  const email = emailRaw ? normalizeEmail(emailRaw) : null;
  return {
    name: cleanText(input.name?.replace(/\s+/g, ' '), MAX_NAME_CHARS),
    // Keep the visitor's formatting for display unless it would not fit the column.
    phone: phone ? { display: phoneRaw.length <= MAX_PHONE_CHARS ? phoneRaw : phone, normalized: phone } : null,
    email: email ? { display: emailRaw, normalized: email } : null,
  };
}

/** This capture's details, completed by what the visitor gave earlier in the conversation. */
function withEarlierDetails(details: ContactDetails, earlier: Lead | null): ContactDetails {
  if (earlier === null) return details;
  const previous = parseDetails({ name: earlier.capturedName, phone: earlier.capturedPhone, email: earlier.capturedEmail });
  return {
    name: details.name ?? previous.name,
    phone: details.phone ?? previous.phone,
    email: details.email ?? previous.email,
  };
}

/** The organization's contact with this phone number, else the one with this email address. */
async function findContact(sql: Sql, organizationId: string, details: ContactDetails): Promise<ContactRow | null> {
  const phone = details.phone?.normalized ?? null;
  const email = details.email?.normalized ?? null;
  const rows = await sql.query<ContactRow>(
    `select ${CONTACT_COLUMNS} from public.contacts
     where organization_id = $1 and (phone_normalized = $2 or email_normalized = $3)`,
    [organizationId, phone, email],
  );
  return (
    rows.find((row) => phone !== null && row.phone_normalized === phone) ??
    rows.find((row) => email !== null && row.email_normalized === email) ??
    null
  );
}

async function conversationExists(
  sql: Sql,
  input: Pick<CaptureLeadInput, 'organizationId' | 'agentId'>,
  conversationId: string,
): Promise<boolean> {
  if (!UUID_RE.test(conversationId)) return false;
  const rows = await sql.query(
    'select id from public.conversations where id = $1 and organization_id = $2 and agent_id = $3',
    [conversationId, input.organizationId, input.agentId],
  );
  return rows.length > 0;
}

/**
 * The id of the contact with the visitor's phone number (else email address), or of a new contact created from
 * their details. Visitor details are unverified, so an existing contact is never modified: no renaming, and no
 * phone number or email address added to someone else's record.
 */
async function resolveContact(sql: Sql, organizationId: string, details: ContactDetails): Promise<string> {
  // `on conflict do nothing` (no target) covers both the phone and the email unique
  // index: if a concurrent capture inserted a matching contact first, the insert
  // returns no row (without aborting the transaction) and the next lookup finds it.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const match = await findContact(sql, organizationId, details);
    if (match) return match.id;

    const inserted = await sql.query<{ id: string }>(
      `insert into public.contacts (organization_id, name, phone, phone_normalized, email, email_normalized)
       values ($1, $2, $3, $4, $5, $6)
       on conflict do nothing
       returning id`,
      [
        organizationId,
        details.name,
        details.phone?.display ?? null,
        details.phone?.normalized ?? null,
        details.email?.display ?? null,
        details.email?.normalized ?? null,
      ],
    );
    const row = maybeOne(inserted);
    if (row) return row.id;
  }
  throw new Error('Contact lookup did not converge');
}

/**
 * Saves a lead for a visitor and links the conversation to their contact (anonymous session upgraded to a
 * contact). A conversation has one lead: a repeat capture updates it, and details it leaves out keep their
 * earlier value. The details are stored on the lead as given; the contact is the organization's existing one
 * with that phone number (else email address), left unchanged, or a new one created from them. Runs inside the
 * caller's transaction.
 */
export async function captureLead(sql: Sql, input: CaptureLeadInput): Promise<CaptureLeadResult> {
  const details = parseDetails(input);
  if (details.phone === null && details.email === null) {
    throw new DomainError('invalid', 'A valid phone number or email address is required.');
  }
  const { conversationId } = input;
  // Checked before any write: the conversation must belong to this organization and agent.
  if (conversationId !== null && !(await conversationExists(sql, input, conversationId))) {
    throw new DomainError('not_found', 'Conversation not found.');
  }
  const summary = cleanText(input.summary, MAX_SUMMARY_CHARS);
  // Matched on everything the visitor gave in the conversation: a follow-up with only an email address stays
  // with the contact their phone number matched instead of moving the lead to a new email-only contact.
  const earlier = conversationId === null ? null : await getConversationLead(sql, input.organizationId, conversationId);
  const contactId = await resolveContact(sql, input.organizationId, withEarlierDetails(details, earlier));

  if (conversationId !== null) {
    await sql.query('update public.conversations set contact_id = $3 where id = $1 and organization_id = $2', [
      conversationId,
      input.organizationId,
      contactId,
    ]);
  }

  // One lead per conversation: a repeat capture updates it. A null conversation_id
  // never conflicts, so captures outside a conversation always insert.
  const lead = one(
    await sql.query<Pick<LeadRow, 'id' | 'summary' | 'captured_name' | 'captured_phone' | 'captured_email'> & { created: boolean }>(
      `insert into public.leads
         (organization_id, agent_id, contact_id, conversation_id, channel, summary, captured_name, captured_phone, captured_email)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (conversation_id) where conversation_id is not null do update
         set contact_id = excluded.contact_id,
             summary = coalesce(excluded.summary, leads.summary),
             captured_name = coalesce(excluded.captured_name, leads.captured_name),
             captured_phone = coalesce(excluded.captured_phone, leads.captured_phone),
             captured_email = coalesce(excluded.captured_email, leads.captured_email),
             updated_at = now()
         where leads.organization_id = excluded.organization_id
       returning id, (xmax = 0) as created, summary, captured_name, captured_phone, captured_email`,
      [
        input.organizationId,
        input.agentId,
        contactId,
        conversationId,
        input.channel,
        summary,
        details.name,
        details.phone?.display ?? null,
        details.email?.display ?? null,
      ],
    ),
    'lead',
  );

  // Read back from the lead, which stores every detail given: nothing here depends on other contacts.
  const savedFields: CapturedField[] = [];
  if (lead.captured_name !== null) savedFields.push('name');
  if (lead.captured_phone !== null) savedFields.push('phone');
  if (lead.captured_email !== null) savedFields.push('email');
  if (lead.summary !== null) savedFields.push('summary');

  return { leadId: lead.id, contactId, created: lead.created, savedFields };
}

/** The conversation's lead, or null. Works under user scope (RLS) and service scope alike. */
export async function getConversationLead(sql: Sql, organizationId: string, conversationId: string): Promise<Lead | null> {
  if (!UUID_RE.test(organizationId) || !UUID_RE.test(conversationId)) return null;
  const row = maybeOne(
    await sql.query<LeadRow>(
      `select ${LEAD_COLUMNS} from public.leads l where l.conversation_id = $1 and l.organization_id = $2`,
      [conversationId, organizationId],
    ),
  );
  return row ? mapLead(row) : null;
}

/** Newest first. Works under user scope (RLS) and service scope alike. */
export async function listLeads(
  db: ScopedDb,
  organizationId: string,
  options: { limit?: number } = {},
): Promise<LeadListItem[]> {
  if (!UUID_RE.test(organizationId)) return [];
  const rows = await db.run((sql) =>
    sql.query<LeadListRow>(
      `select ${LEAD_COLUMNS},
              c.name as contact_name, c.phone as contact_phone, c.email as contact_email,
              c.created_at as contact_created_at, c.updated_at as contact_updated_at,
              a.name as agent_name
       from public.leads l
       join public.contacts c on c.id = l.contact_id and c.organization_id = l.organization_id
       join public.agents a on a.id = l.agent_id and a.organization_id = l.organization_id
       where l.organization_id = $1
       order by l.created_at desc, l.id desc
       limit $2`,
      [organizationId, clampLimit(options.limit)],
    ),
  );
  return rows.map((row) => {
    const contact: Contact = {
      id: row.contact_id,
      organizationId: row.organization_id,
      name: row.contact_name,
      phone: row.contact_phone,
      email: row.contact_email,
      createdAt: toDate(row.contact_created_at),
      updatedAt: toDate(row.contact_updated_at),
    };
    return { ...mapLead(row), contact, agentName: row.agent_name };
  });
}

/** Null when the contact does not exist in this organization (ids are not trusted to be well-formed). */
export async function getContact(sql: Sql, organizationId: string, contactId: string): Promise<Contact | null> {
  if (!UUID_RE.test(organizationId) || !UUID_RE.test(contactId)) return null;
  const row = maybeOne(
    await sql.query<ContactRow>(`select ${CONTACT_COLUMNS} from public.contacts where id = $1 and organization_id = $2`, [
      contactId,
      organizationId,
    ]),
  );
  return row ? mapContact(row) : null;
}

/**
 * What the admin UI shows for a visitor: the details they gave in the conversation (stored on its lead) first,
 * and the linked contact only when it holds something else, e.g. a returning visitor's earlier details or the
 * real owner of a phone number someone else gave. Without captured details, the contact's own.
 */
export function visitorDetails(lead: Lead | null, contact: Contact): VisitorDetails;
export function visitorDetails(lead: Lead | null, contact: Contact | null): VisitorDetails | null;
export function visitorDetails(lead: Lead | null, contact: Contact | null): VisitorDetails | null {
  if (lead !== null && (lead.capturedName !== null || lead.capturedPhone !== null || lead.capturedEmail !== null)) {
    const details = { name: lead.capturedName, phone: lead.capturedPhone, email: lead.capturedEmail };
    const sameAsContact =
      contact !== null &&
      contact.name === details.name &&
      contact.phone === details.phone &&
      contact.email === details.email;
    return { details, linkedContact: sameAsContact ? null : contact };
  }
  return contact === null ? null : { details: contact, linkedContact: null };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIST_LIMIT);
}
