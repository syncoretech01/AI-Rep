import type { Contact } from '@/server/domain/contacts/types';
import type { Channel } from '@/server/domain/types';

export type ConversationStatus = 'active' | 'closed';
export type MessageRole = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'system';

/** Channel-neutral conversation. The database, not the model transcript, is the record. */
export interface Conversation {
  id: string;
  organizationId: string;
  agentId: string;
  channel: Channel;
  status: ConversationStatus;
  /** Anonymous web visitor id (from the signed widget session). */
  visitorId: string | null;
  /** Set once the visitor is identified. */
  contactId: string | null;
  /** Rolling summary of messages with seq <= summaryThroughSeq. */
  summary: string;
  summaryThroughSeq: number;
  messageCount: number;
  lastMessageAt: Date | null;
  createdAt: Date;
  closedAt: Date | null;
}

export interface Message {
  id: string;
  /** Monotonic ordering key (database identity). */
  seq: number;
  organizationId: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  toolName: string | null;
  toolCallId: string | null;
  toolRunId: string | null;
  /** Compact structured payload (tool arguments / minimal result). Never raw provider payloads. */
  data: Record<string, unknown>;
  createdAt: Date;
}

export interface NewMessage {
  role: MessageRole;
  content?: string;
  /** Required for tool_call / tool_result messages, absent otherwise. */
  toolName?: string | null;
  toolCallId?: string | null;
  toolRunId?: string | null;
  data?: Record<string, unknown>;
}

export interface ConversationListItem {
  id: string;
  agentId: string;
  agentName: string;
  channel: Channel;
  status: ConversationStatus;
  contactName: string | null;
  messageCount: number;
  lastMessageAt: Date | null;
  createdAt: Date;
  /** Latest user/assistant text, truncated. */
  preview: string | null;
}

export interface ToolRunRecord {
  id: string;
  toolName: string;
  status: 'running' | 'succeeded' | 'failed' | 'rejected';
  input: unknown;
  output: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: Date;
  durationMs: number | null;
}

export interface ConversationDetail {
  conversation: Conversation & { agentName: string };
  contact: Contact | null;
  messages: Message[];
  toolRuns: ToolRunRecord[];
}
