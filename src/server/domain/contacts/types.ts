import type { Channel } from '@/server/domain/types';

/** A person who identified themselves to an agent. Unique per organization by phone and by email. */
export interface Contact {
  id: string;
  organizationId: string;
  name: string | null;
  /** As provided (display form); matching uses the normalized column. */
  phone: string | null;
  email: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'closed';

/** A captured enquiry. At most one lead per conversation (repeat captures update it). */
export interface Lead {
  id: string;
  organizationId: string;
  agentId: string;
  contactId: string;
  conversationId: string | null;
  channel: Channel;
  status: LeadStatus;
  summary: string | null;
  /**
   * What the visitor gave in this lead's conversation, as given. Unverified: it never changes an existing
   * contact, which may hold different details (a returning visitor, or someone using another person's number).
   */
  capturedName: string | null;
  capturedPhone: string | null;
  capturedEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LeadListItem extends Lead {
  contact: Contact;
  agentName: string;
}
