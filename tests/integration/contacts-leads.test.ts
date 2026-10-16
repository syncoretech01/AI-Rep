import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Row, Sql, SqlParam } from '@/server/db/types';
import {
  captureLead,
  getContact,
  getConversationLead,
  listLeads,
  visitorDetails,
  type CaptureLeadInput,
} from '@/server/domain/contacts/service';
import { DomainError } from '@/server/domain/types';
import { createTestDatabase, type TestDatabase } from '../support/db';
import {
  addMember,
  createAgent,
  createAuthUser,
  createConversation,
  createTenant,
  type TenantFixture,
} from '../support/fixtures';

// `expect.any` returns `any`; typed as unknown for the strict lint rules.
const anyString: unknown = expect.any(String);
const anyDate: unknown = expect.any(Date);

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.close();
});

type LeadDetails = Pick<CaptureLeadInput, 'name' | 'phone' | 'email' | 'summary'>;

function newTenant(): Promise<TenantFixture> {
  return t.service.run((sql) => createTenant(sql));
}

function newConversation(tenant: TenantFixture): Promise<string> {
  return t.service.run(async (sql) => (await createConversation(sql, tenant.org.id, tenant.agent.id)).id);
}

function capture(tenant: TenantFixture, conversationId: string | null, details: LeadDetails) {
  return t.service.run((sql) =>
    captureLead(sql, {
      organizationId: tenant.org.id,
      agentId: tenant.agent.id,
      conversationId,
      channel: 'web_chat',
      ...details,
    }),
  );
}

interface ContactRow {
  id: string;
  name: string | null;
  phone: string | null;
  phone_normalized: string | null;
  email: string | null;
  email_normalized: string | null;
}

function contactRows(organizationId: string): Promise<ContactRow[]> {
  return t.db.query<ContactRow>(
    `select id, name, phone, phone_normalized, email, email_normalized
     from public.contacts where organization_id = $1 order by created_at, id`,
    [organizationId],
  );
}

interface LeadRow {
  id: string;
  agent_id: string;
  contact_id: string;
  conversation_id: string | null;
  channel: string;
  status: string;
  summary: string | null;
  captured_name: string | null;
  captured_phone: string | null;
  captured_email: string | null;
}

function leadRows(organizationId: string): Promise<LeadRow[]> {
  return t.db.query<LeadRow>(
    `select id, agent_id, contact_id, conversation_id, channel, status, summary, captured_name, captured_phone, captured_email
     from public.leads where organization_id = $1 order by created_at, id`,
    [organizationId],
  );
}

async function leadOf(conversationId: string): Promise<LeadRow> {
  const rows = await t.db.query<LeadRow>(
    `select id, agent_id, contact_id, conversation_id, channel, status, summary, captured_name, captured_phone, captured_email
     from public.leads where conversation_id = $1`,
    [conversationId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function conversationContactId(conversationId: string): Promise<string | null> {
  const rows = await t.db.query<{ contact_id: string | null }>('select contact_id from public.conversations where id = $1', [
    conversationId,
  ]);
  return rows[0]!.contact_id;
}

/**
 * Stands in for a concurrent transaction (PGlite runs transactions one at a time): `compete` writes its row
 * through the same transaction right before the first statement matching `pattern`.
 */
function racing(sql: Sql, pattern: RegExp, compete: (sql: Sql) => Promise<void>): Sql {
  let fired = false;
  return {
    query: async <T extends object = Row>(text: string, params?: readonly SqlParam[]): Promise<T[]> => {
      if (!fired && pattern.test(text)) {
        fired = true;
        await compete(sql);
      }
      return sql.query<T>(text, params);
    },
  };
}

describe('captureLead', () => {
  it('creates a contact and a lead and links the conversation to the contact', async () => {
    const tenant = await newTenant();
    const conversationId = await newConversation(tenant);

    const result = await capture(tenant, conversationId, {
      name: '  Jane   Doe ',
      phone: '+1 (555) 123-4567',
      summary: '  Wants a quote for a boiler repair. ',
    });

    expect(result).toEqual({
      leadId: anyString,
      contactId: anyString,
      created: true,
      savedFields: ['name', 'phone', 'summary'],
    });
    expect(await contactRows(tenant.org.id)).toEqual([
      {
        id: result.contactId,
        name: 'Jane Doe',
        phone: '+1 (555) 123-4567',
        phone_normalized: '+15551234567',
        email: null,
        email_normalized: null,
      },
    ]);
    expect(await leadRows(tenant.org.id)).toEqual([
      {
        id: result.leadId,
        agent_id: tenant.agent.id,
        contact_id: result.contactId,
        conversation_id: conversationId,
        channel: 'web_chat',
        status: 'new',
        summary: 'Wants a quote for a boiler repair.',
        captured_name: 'Jane Doe',
        captured_phone: '+1 (555) 123-4567',
        captured_email: null,
      },
    ]);
    // The anonymous session is upgraded to the contact.
    expect(await conversationContactId(conversationId)).toBe(result.contactId);
  });

  it('updates the conversation lead on a repeat capture, keeping details the capture leaves out', async () => {
    const tenant = await newTenant();
    const conversationId = await newConversation(tenant);

    const first = await capture(tenant, conversationId, { name: 'Jane', phone: '0300-1234567', summary: 'Boiler quote' });
    const second = await capture(tenant, conversationId, { phone: '0300 123 4567', email: 'Jane@Example.com' });

    // The fields are what the lead now holds, including the name and summary of the first capture.
    expect(second).toEqual({
      leadId: first.leadId,
      contactId: first.contactId,
      created: false,
      savedFields: ['name', 'phone', 'email', 'summary'],
    });
    expect(await leadRows(tenant.org.id)).toEqual([
      expect.objectContaining({
        summary: 'Boiler quote',
        captured_name: 'Jane',
        captured_phone: '0300 123 4567',
        captured_email: 'Jane@Example.com',
      }),
    ]);

    const third = await capture(tenant, conversationId, { name: 'Jane Smith', email: 'jane@example.com', summary: 'Boiler quote, urgent' });
    expect(third).toEqual({
      leadId: first.leadId,
      contactId: first.contactId,
      created: false,
      savedFields: ['name', 'phone', 'email', 'summary'],
    });
    expect(await leadRows(tenant.org.id)).toEqual([
      expect.objectContaining({
        summary: 'Boiler quote, urgent',
        captured_name: 'Jane Smith',
        captured_phone: '0300 123 4567',
        captured_email: 'jane@example.com',
      }),
    ]);
    // The contact keeps what it was created with: visitor input never changes an existing contact.
    expect(await contactRows(tenant.org.id)).toEqual([
      {
        id: first.contactId,
        name: 'Jane',
        phone: '0300-1234567',
        phone_normalized: '03001234567',
        email: null,
        email_normalized: null,
      },
    ]);
  });

  it('keeps a follow-up capture with only an email on the contact the phone number matched', async () => {
    const tenant = await newTenant();
    const conversationId = await newConversation(tenant);

    const first = await capture(tenant, conversationId, { name: 'Bob Ray', phone: '555-301-0001', summary: 'Needs a callback' });
    const second = await capture(tenant, conversationId, { name: 'Bob Ray', email: 'bob@example.com' });

    expect(second).toMatchObject({ leadId: first.leadId, contactId: first.contactId, savedFields: ['name', 'phone', 'email', 'summary'] });
    // No email-only contact: the lead stays with the visitor's contact and keeps the phone number they gave.
    expect((await contactRows(tenant.org.id)).map((contact) => contact.id)).toEqual([first.contactId]);
    expect(await leadOf(conversationId)).toMatchObject({
      contact_id: first.contactId,
      captured_name: 'Bob Ray',
      captured_phone: '555-301-0001',
      captured_email: 'bob@example.com',
    });
    expect(await conversationContactId(conversationId)).toBe(first.contactId);
  });

  it("moves the lead to the visitor's own contact when they correct a number that matched someone else's", async () => {
    const tenant = await newTenant();
    const alice = await capture(tenant, await newConversation(tenant), { name: 'Alice Smith', phone: '555-010-0500' });
    const conversationId = await newConversation(tenant);

    // A mistyped number that happens to be Alice's links the lead to her contact, without changing it...
    const typo = await capture(tenant, conversationId, { name: 'Sam', phone: '555 010 0500', email: 'sam@example.com' });
    expect(typo.contactId).toBe(alice.contactId);
    // ...and the corrected number resolves the contact again: this capture's details come before earlier ones.
    const corrected = await capture(tenant, conversationId, { name: 'Sam', phone: '555 010 0599' });

    expect(corrected).toMatchObject({ leadId: typo.leadId, created: false, savedFields: ['name', 'phone', 'email'] });
    expect(corrected.contactId).not.toBe(alice.contactId);
    expect(await contactRows(tenant.org.id)).toEqual([
      { id: alice.contactId, name: 'Alice Smith', phone: '555-010-0500', phone_normalized: '5550100500', email: null, email_normalized: null },
      // Created from what the visitor gave in this conversation (the email address came with the first capture).
      {
        id: corrected.contactId,
        name: 'Sam',
        phone: '555 010 0599',
        phone_normalized: '5550100599',
        email: 'sam@example.com',
        email_normalized: 'sam@example.com',
      },
    ]);
    expect(await leadOf(conversationId)).toMatchObject({
      contact_id: corrected.contactId,
      captured_name: 'Sam',
      captured_phone: '555 010 0599',
      captured_email: 'sam@example.com',
    });
    expect(await conversationContactId(conversationId)).toBe(corrected.contactId);
  });

  it('links a later conversation with the same phone number to the existing contact without changing it', async () => {
    const tenant = await newTenant();
    const firstConversation = await newConversation(tenant);
    const secondConversation = await newConversation(tenant);

    const first = await capture(tenant, firstConversation, { name: 'Sam', phone: '+44 20 7946 0958' });
    const second = await capture(tenant, secondConversation, { phone: '+44 (20) 7946-0958', email: 'sam@example.com' });

    expect(second).toEqual({ leadId: anyString, contactId: first.contactId, created: true, savedFields: ['phone', 'email'] });
    expect(second.leadId).not.toBe(first.leadId);
    expect(await contactRows(tenant.org.id)).toEqual([
      { id: first.contactId, name: 'Sam', phone: '+44 20 7946 0958', phone_normalized: '+442079460958', email: null, email_normalized: null },
    ]);
    expect(await leadOf(secondConversation)).toMatchObject({
      contact_id: first.contactId,
      captured_name: null,
      captured_phone: '+44 (20) 7946-0958',
      captured_email: 'sam@example.com',
    });
    expect(await conversationContactId(secondConversation)).toBe(first.contactId);
  });

  it("does not let a visitor who gives someone else's phone number rename that contact or attach an email to it", async () => {
    const tenant = await newTenant();
    const aliceConversation = await newConversation(tenant);
    const malloryConversation = await newConversation(tenant);

    const alice = await capture(tenant, aliceConversation, { name: 'Alice Smith', phone: '+1 555 010 0100', summary: 'Wants a quote' });
    const mallory = await capture(tenant, malloryConversation, {
      name: 'Mallory',
      phone: '+1 (555) 010-0100',
      email: 'mallory@attacker.example',
      summary: 'Send my invoice by email',
    });

    // Matched by phone number and linked, but the contact is exactly as Alice left it.
    expect(mallory.contactId).toBe(alice.contactId);
    expect(await contactRows(tenant.org.id)).toEqual([
      { id: alice.contactId, name: 'Alice Smith', phone: '+1 555 010 0100', phone_normalized: '+15550100100', email: null, email_normalized: null },
    ]);
    // Everything Mallory said is stored on Mallory's lead, so the result says nothing about Alice's record.
    expect(mallory.savedFields).toEqual(['name', 'phone', 'email', 'summary']);

    const leads = await listLeads(t.service, tenant.org.id);
    const aliceLead = leads.find((lead) => lead.id === alice.leadId)!;
    const malloryLead = leads.find((lead) => lead.id === mallory.leadId)!;
    // Alice's earlier lead still shows Alice's details...
    expect(aliceLead).toMatchObject({
      summary: 'Wants a quote',
      capturedName: 'Alice Smith',
      capturedPhone: '+1 555 010 0100',
      capturedEmail: null,
      contact: { id: alice.contactId, name: 'Alice Smith', phone: '+1 555 010 0100', email: null },
    });
    expect(visitorDetails(aliceLead, aliceLead.contact)).toEqual({
      details: { name: 'Alice Smith', phone: '+1 555 010 0100', email: null },
      linkedContact: null,
    });
    // ...and Mallory's shows what Mallory gave, with Alice's contact only as the linked record.
    expect(malloryLead).toMatchObject({
      capturedName: 'Mallory',
      capturedPhone: '+1 (555) 010-0100',
      capturedEmail: 'mallory@attacker.example',
    });
    expect(visitorDetails(malloryLead, malloryLead.contact)).toEqual({
      details: { name: 'Mallory', phone: '+1 (555) 010-0100', email: 'mallory@attacker.example' },
      linkedContact: aliceLead.contact,
    });
  });

  it('never attaches an email address owned by another contact, and reports only what the lead holds', async () => {
    const tenant = await newTenant();
    const byPhone = await capture(tenant, await newConversation(tenant), { phone: '555 123 4567' });
    const byEmail = await capture(tenant, await newConversation(tenant), { email: 'owner@example.com' });
    expect(byEmail.contactId).not.toBe(byPhone.contactId);

    const conflicting = await capture(tenant, await newConversation(tenant), {
      name: 'Pat',
      phone: '555.123.4567',
      email: 'OWNER@example.com',
    });

    // The phone number matches first. Neither contact changes, and the fields do not reveal that the email
    // address belongs to another contact.
    expect(conflicting.contactId).toBe(byPhone.contactId);
    expect(conflicting.savedFields).toEqual(['name', 'phone', 'email']);
    expect(await contactRows(tenant.org.id)).toEqual([
      { id: byPhone.contactId, name: null, phone: '555 123 4567', phone_normalized: '5551234567', email: null, email_normalized: null },
      { id: byEmail.contactId, name: null, phone: null, phone_normalized: null, email: 'owner@example.com', email_normalized: 'owner@example.com' },
    ]);
  });

  it('matches by email when no phone number matches', async () => {
    const tenant = await newTenant();
    const first = await capture(tenant, await newConversation(tenant), { email: 'lee@example.com' });
    const conversationId = await newConversation(tenant);
    const second = await capture(tenant, conversationId, { name: 'Lee', email: ' LEE@EXAMPLE.COM ', phone: '0300-7654321' });

    expect(second.contactId).toBe(first.contactId);
    expect(second.savedFields).toEqual(['name', 'phone', 'email']);
    expect(await contactRows(tenant.org.id)).toEqual([
      { id: first.contactId, name: null, phone: null, phone_normalized: null, email: 'lee@example.com', email_normalized: 'lee@example.com' },
    ]);
    expect(await leadOf(conversationId)).toMatchObject({ captured_name: 'Lee', captured_phone: '0300-7654321', captured_email: 'LEE@EXAMPLE.COM' });
  });

  it("keeps a returning visitor's new phone number on their lead, never on the contact", async () => {
    const tenant = await newTenant();
    const first = await capture(tenant, await newConversation(tenant), { name: 'Cara Dee', phone: '555-401-0001', email: 'cara@example.com' });

    // Matched by email: the new phone number is saved (on the lead) and reported as saved.
    const byEmailConversation = await newConversation(tenant);
    const byEmail = await capture(tenant, byEmailConversation, { name: 'Cara Dee', phone: '555-401-0002', email: 'Cara@example.com' });
    expect(byEmail).toMatchObject({ contactId: first.contactId, savedFields: ['name', 'phone', 'email'] });
    expect(await leadOf(byEmailConversation)).toMatchObject({ captured_phone: '555-401-0002', captured_email: 'Cara@example.com' });
    // Matched by phone number: the same goes for a different email address.
    const byPhoneConversation = await newConversation(tenant);
    const byPhone = await capture(tenant, byPhoneConversation, { phone: '5554010001', email: 'other@example.com' });
    expect(byPhone).toMatchObject({ contactId: first.contactId, savedFields: ['phone', 'email'] });
    expect(await leadOf(byPhoneConversation)).toMatchObject({ captured_phone: '5554010001', captured_email: 'other@example.com' });

    expect(await contactRows(tenant.org.id)).toEqual([
      expect.objectContaining({ id: first.contactId, name: 'Cara Dee', phone_normalized: '5554010001', email_normalized: 'cara@example.com' }),
    ]);
  });

  it('reuses the contact a concurrent capture inserted first', async () => {
    const tenant = await newTenant();
    const conversationId = await newConversation(tenant);
    const phone = '+44 20 7946 0958';
    let competingId = '';

    const result = await t.service.run((sql) =>
      captureLead(
        racing(sql, /insert into public\.contacts/, async (inner) => {
          const [row] = await inner.query<{ id: string }>(
            'insert into public.contacts (organization_id, phone, phone_normalized) values ($1, $2, $3) returning id',
            [tenant.org.id, phone, '+442079460958'],
          );
          competingId = row!.id;
        }),
        { organizationId: tenant.org.id, agentId: tenant.agent.id, conversationId, channel: 'web_chat', name: 'Sam', phone },
      ),
    );

    // The insert lost the race without aborting the transaction, and the lookup found the winner.
    expect(competingId).not.toBe('');
    expect(result.contactId).toBe(competingId);
    expect(await contactRows(tenant.org.id)).toEqual([
      { id: competingId, name: null, phone, phone_normalized: '+442079460958', email: null, email_normalized: null },
    ]);
    expect(await leadOf(conversationId)).toMatchObject({ contact_id: competingId, captured_name: 'Sam', captured_phone: phone });
    expect(await conversationContactId(conversationId)).toBe(competingId);
  });

  it('also reuses a contact with the same email address that a concurrent capture inserted first', async () => {
    const tenant = await newTenant();
    const conversationId = await newConversation(tenant);
    let competingId = '';

    // A phone number no contact has: only the email unique index conflicts, so the conflict clause must cover it.
    const result = await t.service.run((sql) =>
      captureLead(
        racing(sql, /insert into public\.contacts/, async (inner) => {
          const [row] = await inner.query<{ id: string }>(
            'insert into public.contacts (organization_id, email, email_normalized) values ($1, $2, $3) returning id',
            [tenant.org.id, 'pat@example.com', 'pat@example.com'],
          );
          competingId = row!.id;
        }),
        {
          organizationId: tenant.org.id,
          agentId: tenant.agent.id,
          conversationId,
          channel: 'web_chat',
          name: 'Pat',
          phone: '555 909 0909',
          email: 'Pat@Example.com',
        },
      ),
    );

    expect(competingId).not.toBe('');
    expect(result.contactId).toBe(competingId);
    // The winner is linked as it is: the phone number is kept on the lead only.
    expect(await contactRows(tenant.org.id)).toEqual([
      { id: competingId, name: null, phone: null, phone_normalized: null, email: 'pat@example.com', email_normalized: 'pat@example.com' },
    ]);
    expect(await leadOf(conversationId)).toMatchObject({
      contact_id: competingId,
      captured_name: 'Pat',
      captured_phone: '555 909 0909',
      captured_email: 'Pat@Example.com',
    });
    expect(await conversationContactId(conversationId)).toBe(competingId);
  });

  it('caps the name and summary at their column limits and drops NUL characters', async () => {
    const tenant = await newTenant();
    await capture(tenant, await newConversation(tenant), {
      name: `Ja\u0000ne ${'N'.repeat(200)}`,
      email: 'long@example.com',
      summary: `\u0000${'s'.repeat(2500)}`,
    });

    expect((await contactRows(tenant.org.id))[0]!.name).toBe(`Jane ${'N'.repeat(155)}`);
    const [lead] = await leadRows(tenant.org.id);
    expect(lead).toMatchObject({ summary: 's'.repeat(2000), captured_name: `Jane ${'N'.repeat(155)}` });
  });

  it('records captures outside a conversation as separate leads', async () => {
    const tenant = await newTenant();
    const first = await capture(tenant, null, { email: 'walk-in@example.com' });
    const second = await capture(tenant, null, { email: 'walk-in@example.com', summary: 'Called again' });

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.contactId).toBe(first.contactId);
    expect(second.savedFields).toEqual(['email', 'summary']);
    expect((await leadRows(tenant.org.id)).map((lead) => lead.conversation_id)).toEqual([null, null]);
  });

  it('keeps contacts separate per organization', async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();

    const a = await capture(tenantA, await newConversation(tenantA), { name: 'Alex', phone: '+1 555 000 1111' });
    const b = await capture(tenantB, await newConversation(tenantB), { name: 'Alex', phone: '+1 555 000 1111' });

    expect(b.contactId).not.toBe(a.contactId);
    expect(b.created).toBe(true);
    expect((await contactRows(tenantA.org.id)).map((contact) => contact.id)).toEqual([a.contactId]);
    expect((await contactRows(tenantB.org.id)).map((contact) => contact.id)).toEqual([b.contactId]);
  });

  it('rejects input without a valid phone number or email address', async () => {
    const tenant = await newTenant();
    const conversationId = await newConversation(tenant);

    for (const details of [{ name: 'Nobody' }, { phone: 'call me maybe', email: 'not-an-email' }, { phone: '123', email: '  ' }]) {
      const attempt = capture(tenant, conversationId, details);
      await expect(attempt).rejects.toBeInstanceOf(DomainError);
      await expect(attempt).rejects.toMatchObject({
        code: 'invalid',
        message: 'A valid phone number or email address is required.',
      });
    }
    expect(await contactRows(tenant.org.id)).toEqual([]);
    expect(await leadRows(tenant.org.id)).toEqual([]);
    expect(await conversationContactId(conversationId)).toBeNull();
  });

  it("refuses to attach a lead to another organization's or agent's conversation", async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    const foreignConversation = await newConversation(tenantB);
    const otherAgent = await t.service.run((sql) => createAgent(sql, tenantA.org.id, { name: 'Night Desk' }));
    const otherAgentConversation = await t.service.run(
      async (sql) => (await createConversation(sql, tenantA.org.id, otherAgent.id)).id,
    );

    for (const conversationId of [foreignConversation, otherAgentConversation, 'not-a-uuid']) {
      await expect(capture(tenantA, conversationId, { phone: '555 123 4567' })).rejects.toMatchObject({ code: 'not_found' });
    }

    // The conversation is checked before anything is written, so a caller that handles
    // the error inside its own transaction is not left with a half-saved contact.
    const contactsAfterHandledError = await t.service.run(async (sql) => {
      await expect(
        captureLead(sql, {
          organizationId: tenantA.org.id,
          agentId: tenantA.agent.id,
          conversationId: foreignConversation,
          channel: 'web_chat',
          phone: '555 123 4567',
        }),
      ).rejects.toBeInstanceOf(DomainError);
      return sql.query('select id from public.contacts where organization_id = $1', [tenantA.org.id]);
    });
    expect(contactsAfterHandledError).toEqual([]);

    expect(await contactRows(tenantA.org.id)).toEqual([]);
    expect(await leadRows(tenantA.org.id)).toEqual([]);
    expect(await leadRows(tenantB.org.id)).toEqual([]);
    expect(await conversationContactId(foreignConversation)).toBeNull();
  });
});

describe('getContact', () => {
  it('only returns contacts of the given organization', async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    const { contactId } = await capture(tenantA, null, { name: 'Kim', email: 'kim@example.com' });

    const own = await t.service.run((sql) => getContact(sql, tenantA.org.id, contactId));
    expect(own).toEqual({
      id: contactId,
      organizationId: tenantA.org.id,
      name: 'Kim',
      phone: null,
      email: 'kim@example.com',
      createdAt: anyDate,
      updatedAt: anyDate,
    });
    expect(await t.service.run((sql) => getContact(sql, tenantB.org.id, contactId))).toBeNull();
    expect(await t.service.run((sql) => getContact(sql, tenantA.org.id, 'not-a-uuid'))).toBeNull();
    // RLS: another organization's owner cannot read it even by id.
    expect(await t.asUser(tenantB.owner.id).run((sql) => getContact(sql, tenantA.org.id, contactId))).toBeNull();
    expect(await t.asUser(tenantA.owner.id).run((sql) => getContact(sql, tenantA.org.id, contactId))).not.toBeNull();
  });
});

describe('getConversationLead', () => {
  it("returns the conversation's lead, only within its organization", async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    const member = await t.service.run((sql) => createAuthUser(sql));
    await t.service.run((sql) => addMember(sql, tenantA.org.id, member.id, 'member'));
    const conversationId = await newConversation(tenantA);
    const { leadId, contactId } = await capture(tenantA, conversationId, { name: 'Kim', phone: '555 222 0000', summary: 'Quote' });

    const expected = {
      id: leadId,
      organizationId: tenantA.org.id,
      agentId: tenantA.agent.id,
      contactId,
      conversationId,
      channel: 'web_chat',
      status: 'new',
      summary: 'Quote',
      capturedName: 'Kim',
      capturedPhone: '555 222 0000',
      capturedEmail: null,
      createdAt: anyDate,
      updatedAt: anyDate,
    };
    expect(await t.service.run((sql) => getConversationLead(sql, tenantA.org.id, conversationId))).toEqual(expected);
    expect(await t.asUser(member.id).run((sql) => getConversationLead(sql, tenantA.org.id, conversationId))).toEqual(expected);
    // Another organization's id, malformed ids, or a conversation without a lead: nothing.
    const withoutLead = await newConversation(tenantA);
    expect(await t.service.run((sql) => getConversationLead(sql, tenantB.org.id, conversationId))).toBeNull();
    expect(await t.service.run((sql) => getConversationLead(sql, tenantA.org.id, 'not-a-uuid'))).toBeNull();
    expect(await t.service.run((sql) => getConversationLead(sql, 'not-a-uuid', conversationId))).toBeNull();
    expect(await t.service.run((sql) => getConversationLead(sql, tenantA.org.id, withoutLead))).toBeNull();
    // RLS: another organization's owner cannot read it even with the right ids.
    expect(await t.asUser(tenantB.owner.id).run((sql) => getConversationLead(sql, tenantA.org.id, conversationId))).toBeNull();
  });
});

describe('visitorDetails', () => {
  const contact = {
    id: 'contact',
    organizationId: 'org',
    name: 'Alice Smith',
    phone: '+1 555 010 0100',
    email: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const lead = {
    id: 'lead',
    organizationId: 'org',
    agentId: 'agent',
    contactId: 'contact',
    conversationId: 'conversation',
    channel: 'web_chat' as const,
    status: 'new' as const,
    summary: null,
    capturedName: 'Alice Smith',
    capturedPhone: '+1 555 010 0100',
    capturedEmail: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };

  it('shows what the visitor gave, and the linked contact only when it holds something else', () => {
    expect(visitorDetails(lead, contact)).toEqual({ details: { name: 'Alice Smith', phone: '+1 555 010 0100', email: null }, linkedContact: null });
    const other = { ...lead, capturedName: 'Mallory', capturedEmail: 'mallory@attacker.example' };
    expect(visitorDetails(other, contact)).toEqual({
      details: { name: 'Mallory', phone: '+1 555 010 0100', email: 'mallory@attacker.example' },
      linkedContact: contact,
    });
    // A detail the visitor did not give is not filled in from the contact.
    expect(visitorDetails({ ...lead, capturedName: null }, contact)).toEqual({
      details: { name: null, phone: '+1 555 010 0100', email: null },
      linkedContact: contact,
    });
  });

  it("falls back to the contact's details without captured ones, and to nothing without either", () => {
    const empty = { ...lead, capturedName: null, capturedPhone: null, capturedEmail: null };
    expect(visitorDetails(empty, contact)).toEqual({ details: contact, linkedContact: null });
    expect(visitorDetails(null, contact)).toEqual({ details: contact, linkedContact: null });
    expect(visitorDetails(null, null)).toBeNull();
    expect(visitorDetails(lead, null)).toEqual({ details: { name: 'Alice Smith', phone: '+1 555 010 0100', email: null }, linkedContact: null });
  });
});

describe('listLeads', () => {
  it('lists the organization leads newest first with their contact and agent', async () => {
    const tenant = await newTenant();
    const older = await capture(tenant, await newConversation(tenant), { name: 'Old', phone: '5550000001' });
    const newer = await capture(tenant, await newConversation(tenant), { name: 'New', email: 'new@example.com', summary: 'Needs a callback' });
    await t.db.query(`update public.leads set created_at = now() - interval '1 hour' where id = $1`, [older.leadId]);

    const leads = await listLeads(t.service, tenant.org.id);
    expect(leads.map((lead) => lead.id)).toEqual([newer.leadId, older.leadId]);
    expect(leads[0]).toEqual({
      id: newer.leadId,
      organizationId: tenant.org.id,
      agentId: tenant.agent.id,
      contactId: newer.contactId,
      conversationId: anyString,
      channel: 'web_chat',
      status: 'new',
      summary: 'Needs a callback',
      capturedName: 'New',
      capturedPhone: null,
      capturedEmail: 'new@example.com',
      createdAt: anyDate,
      updatedAt: anyDate,
      contact: {
        id: newer.contactId,
        organizationId: tenant.org.id,
        name: 'New',
        phone: null,
        email: 'new@example.com',
        createdAt: anyDate,
        updatedAt: anyDate,
      },
      agentName: tenant.agent.name,
    });
    expect((await listLeads(t.service, tenant.org.id, { limit: 1 })).map((lead) => lead.id)).toEqual([newer.leadId]);
  });

  it('shows members only their own organization leads (RLS)', async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    const member = await t.service.run((sql) => createAuthUser(sql));
    const outsider = await t.service.run((sql) => createAuthUser(sql));
    await t.service.run((sql) => addMember(sql, tenantA.org.id, member.id, 'member'));
    const leadA = await capture(tenantA, await newConversation(tenantA), { phone: '+1 555 222 3333' });
    const leadB = await capture(tenantB, await newConversation(tenantB), { phone: '+1 555 222 3333' });

    const asMember = t.asUser(member.id);
    expect((await listLeads(asMember, tenantA.org.id)).map((lead) => lead.id)).toEqual([leadA.leadId]);
    expect(await listLeads(asMember, tenantB.org.id)).toEqual([]);
    expect(await listLeads(t.asUser(tenantA.owner.id), tenantB.org.id)).toEqual([]);
    expect(await listLeads(t.asUser(outsider.id), tenantA.org.id)).toEqual([]);
    expect(await listLeads(t.asUser(outsider.id), tenantB.org.id)).toEqual([]);
    expect((await listLeads(t.service, tenantB.org.id)).map((lead) => lead.id)).toEqual([leadB.leadId]);
    expect(await listLeads(t.service, 'not-a-uuid')).toEqual([]);
  });

  it('gives users no write access to contacts or leads (RLS)', async () => {
    const tenant = await newTenant();
    const conversationId = await newConversation(tenant);
    const { contactId, leadId } = await capture(tenant, conversationId, { name: 'Robin', phone: '5551112222' });
    const owner = t.asUser(tenant.owner.id);

    const denied = { code: '42501' };
    await expect(
      owner.run((sql) =>
        sql.query(`insert into public.contacts (organization_id, phone, phone_normalized) values ($1, '5559998888', '5559998888')`, [
          tenant.org.id,
        ]),
      ),
    ).rejects.toMatchObject(denied);
    await expect(
      owner.run((sql) => sql.query(`update public.contacts set name = 'Hijacked' where id = $1`, [contactId])),
    ).rejects.toMatchObject(denied);
    await expect(
      owner.run((sql) =>
        sql.query(`insert into public.leads (organization_id, agent_id, contact_id, channel) values ($1, $2, $3, 'web_chat')`, [
          tenant.org.id,
          tenant.agent.id,
          contactId,
        ]),
      ),
    ).rejects.toMatchObject(denied);
    await expect(owner.run((sql) => sql.query(`update public.leads set status = 'closed' where id = $1`, [leadId]))).rejects.toMatchObject(
      denied,
    );
    await expect(
      owner.run((sql) => sql.query(`update public.leads set captured_name = 'Hijacked' where id = $1`, [leadId])),
    ).rejects.toMatchObject(denied);
    await expect(
      owner.run((sql) =>
        captureLead(sql, {
          organizationId: tenant.org.id,
          agentId: tenant.agent.id,
          conversationId: null,
          channel: 'web_chat',
          phone: '5553334444',
        }),
      ),
    ).rejects.toMatchObject(denied);

    expect(await contactRows(tenant.org.id)).toEqual([expect.objectContaining({ id: contactId, name: 'Robin' })]);
    expect(await leadRows(tenant.org.id)).toEqual([expect.objectContaining({ id: leadId, status: 'new', captured_name: 'Robin' })]);
  });
});
