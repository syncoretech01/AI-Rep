/** Structured business facts an agent states deterministically (not retrieved through RAG). */
export interface BusinessProfile {
  organizationId: string;
  agentId: string;
  businessName: string | null;
  description: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  address: string | null;
  serviceArea: string | null;
  updatedAt: Date;
}

/** A weekly opening interval in the agent's timezone. A day without intervals is closed. */
export interface HoursInterval {
  /** 0 = Sunday … 6 = Saturday. */
  dayOfWeek: number;
  /** Local time 'HH:MM'. */
  opensAt: string;
  /** Local time 'HH:MM', after opensAt; '24:00' = end of the day. */
  closesAt: string;
}

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
