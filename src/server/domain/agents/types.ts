import type { Channel } from '@/server/domain/types';

export const AGENT_STATUSES = ['active', 'paused'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const LEAD_FIELDS = ['name', 'phone', 'email'] as const;
export type LeadField = (typeof LEAD_FIELDS)[number];

export interface LeadCaptureSettings {
  enabled: boolean;
  /** Fields the agent must collect before calling captureLead. A phone or email is always required. */
  requiredFields: LeadField[];
}

export interface Agent {
  id: string;
  organizationId: string;
  name: string;
  status: AgentStatus;
  greeting: string;
  /** BCP-47 language tag the agent replies in. */
  language: string;
  /** IANA timezone used for business hours. */
  timezone: string;
  /** Concise owner-provided behavior instructions. */
  instructions: string;
  leadCapture: LeadCaptureSettings;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentChannel {
  id: string;
  organizationId: string;
  agentId: string;
  channel: Channel;
  enabled: boolean;
  /** Public widget key (web chat). Not a secret. */
  publicKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}
