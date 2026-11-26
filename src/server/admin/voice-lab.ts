import 'server-only';
import { z } from 'zod';
import { getOrgAccessForAction, type OrgAccess } from '@/server/auth/org-access';
import { VoiceGatewayError, endGatewaySession, startGatewaySession } from '@/server/channels/voice/gateway-client';
import { WebChatError } from '@/server/channels/webchat/service';
import { assertSameOrigin, jsonResponse, readJsonBody } from '@/server/channels/webchat/http';
import { loadAiConfig, loadVoiceConfig, type VoiceConfig } from '@/server/config/env';
import { isUuid } from '@/server/db/sql';
import { listAgents } from '@/server/domain/agents/repository';
import { getConversationDetail } from '@/server/domain/conversations/service';
import { createCostEstimator } from '@/server/domain/usage/cost';
import { listConversationUsage } from '@/server/domain/usage/queries';
import { getVoiceSession } from '@/server/domain/voice/sessions';
import { createLogger } from '@/server/observability/logger';

const voiceLabLogger = createLogger({ bindings: { module: 'voice_lab' } });

/**
 * The developer voice lab (Phase 2 proof of concept): authorization, agent selection and the status view behind
 * /api/voice-lab/*. Off unless VOICE_DEV_ENABLED=true; starting and ending sessions needs an owner/admin; the view is
 * read under user scope (RLS). Sessions themselves are created by the voice gateway.
 */

export class VoiceLabError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'VoiceLabError';
    this.status = status;
    this.code = code;
  }
}

const startSchema = z.object({
  orgSlug: z.string().min(1).max(64),
  agentId: z.string().regex(/^[0-9a-f-]{36}$/i).optional(),
  sdp: z.string().min(1).max(32_000),
});
const endSchema = z.object({ orgSlug: z.string().min(1).max(64) });

function voiceConfig(): VoiceConfig {
  const config = loadVoiceConfig();
  // A disabled lab is indistinguishable from a missing page.
  if (!config.devPageEnabled) throw new VoiceLabError(404, 'not_found', 'Not found.');
  return config;
}

async function access(orgSlug: string, admin: boolean): Promise<OrgAccess> {
  const resolved = await getOrgAccessForAction(orgSlug);
  if (!resolved) throw new VoiceLabError(404, 'not_found', 'Not found.');
  if (admin && !resolved.isAdmin) throw new VoiceLabError(403, 'forbidden', 'Only owners and admins can start voice tests.');
  return resolved;
}

function fromGateway(error: unknown): never {
  if (error instanceof VoiceGatewayError) throw new VoiceLabError(error.status, error.code, error.message);
  throw error;
}

export async function startVoiceLabSession(body: unknown): Promise<{
  voiceSessionId: string;
  sdp: string;
  maxDurationSeconds: number;
  delegation: 'responses' | 'client';
}> {
  const config = voiceConfig();
  const parsed = startSchema.safeParse(body);
  if (!parsed.success) throw new VoiceLabError(400, 'invalid_request', 'Invalid voice session request.');
  const org = await access(parsed.data.orgSlug, true);
  const agents = await org.db.run((sql) => listAgents(sql, org.organization.id));
  const agent = parsed.data.agentId
    ? agents.find((candidate) => candidate.id === parsed.data.agentId)
    : agents.find((candidate) => candidate.status === 'active');
  if (agent?.status !== 'active') throw new VoiceLabError(404, 'not_found', 'No active assistant to talk to.');
  const started = await startGatewaySession(config.gateway, {
    organizationId: org.organization.id,
    agentId: agent.id,
    startedBy: org.user.id,
    sdp: parsed.data.sdp,
  }).catch(fromGateway);
  return {
    voiceSessionId: started.voiceSessionId,
    sdp: started.sdp,
    maxDurationSeconds: started.maxDurationSeconds,
    delegation: started.delegation,
  };
}

export async function endVoiceLabSession(voiceSessionId: string, body: unknown): Promise<{ ended: boolean }> {
  const config = voiceConfig();
  const parsed = endSchema.safeParse(body);
  if (!parsed.success || !isUuid(voiceSessionId)) throw new VoiceLabError(400, 'invalid_request', 'Invalid request.');
  const org = await access(parsed.data.orgSlug, true);
  const ended = await endGatewaySession(config.gateway, { organizationId: org.organization.id, voiceSessionId }).catch(fromGateway);
  return { ended };
}

export interface VoiceLabView {
  session: {
    id: string;
    status: string;
    endReason: string | null;
    model: string;
    voice: string | null;
    delegation: string;
    maxDurationSeconds: number;
    createdAt: string;
    connectedAt: string | null;
    endedAt: string | null;
    activeSeconds: number;
    standbySeconds: number;
    usageSource: string | null;
    estimatedCostUsd: number;
  };
  transcript: Array<{ id: string; role: string; content: string; toolName: string | null; data: Record<string, unknown>; at: string }>;
  toolRuns: Array<{ id: string; toolName: string; status: string; errorCode: string | null; durationMs: number | null; at: string }>;
  usage: Array<{ kind: string; purpose: string; model: string; estimatedCostUsd: number; activeSeconds: number | null }>;
  /**
   * Estimated cost so far: the conversation's metered usage, plus, while the session is open, its elapsed time
   * priced as active voice (an upper bound until the session settles with the provider's figures).
   */
  estimatedCostUsd: number;
  liveEstimate: boolean;
}

export async function getVoiceLabView(orgSlug: string, voiceSessionId: string): Promise<VoiceLabView> {
  voiceConfig();
  if (!isUuid(voiceSessionId)) throw new VoiceLabError(404, 'not_found', 'Not found.');
  const org = await access(orgSlug, false);
  const organizationId = org.organization.id;
  const session = await org.db.run((sql) => getVoiceSession(sql, organizationId, voiceSessionId));
  if (!session) throw new VoiceLabError(404, 'not_found', 'Not found.');
  const detail = await getConversationDetail(org.db, organizationId, session.conversationId);
  const usage = await org.db.run((sql) => listConversationUsage(sql, organizationId, session.conversationId));
  const open = session.endedAt === null;
  const elapsedSeconds = open && session.connectedAt ? Math.max(0, (Date.now() - session.connectedAt.getTime()) / 1000) : 0;
  const voiceEstimate = open ? createCostEstimator(loadAiConfig().pricingOverrides).voice(session.model, { activeSeconds: elapsedSeconds, standbySeconds: 0 }).usd : 0;
  return {
    session: {
      id: session.id,
      status: session.status,
      endReason: session.endReason,
      model: session.model,
      voice: session.voice,
      delegation: session.delegation,
      maxDurationSeconds: session.maxDurationSeconds,
      createdAt: session.createdAt.toISOString(),
      connectedAt: session.connectedAt?.toISOString() ?? null,
      endedAt: session.endedAt?.toISOString() ?? null,
      activeSeconds: session.activeSeconds,
      standbySeconds: session.standbySeconds,
      usageSource: session.usageSource,
      estimatedCostUsd: session.estimatedCostUsd,
    },
    transcript: (detail?.messages ?? []).map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      toolName: message.toolName,
      data: message.data,
      at: message.createdAt.toISOString(),
    })),
    toolRuns: (detail?.toolRuns ?? []).map((run) => ({
      id: run.id,
      toolName: run.toolName,
      status: run.status,
      errorCode: run.errorCode,
      durationMs: run.durationMs,
      at: run.startedAt.toISOString(),
    })),
    usage: usage.map((row) => ({
      kind: row.kind,
      purpose: row.purpose,
      model: row.model,
      estimatedCostUsd: row.estimatedCostUsd,
      activeSeconds: row.activeSeconds,
    })),
    estimatedCostUsd: usage.reduce((sum, row) => sum + row.estimatedCostUsd, 0) + voiceEstimate,
    liveEstimate: open,
  };
}

/**
 * Wraps a voice-lab route: same-origin and JSON-only (no cross-site form posts), bounded body, typed errors.
 * Internal failures are logged and answered generically.
 */
export async function voiceLabRoute(
  request: Request,
  run: (body: unknown) => Promise<unknown>,
  options: { readBody: boolean } = { readBody: true },
): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = options.readBody ? await readJsonBody(request, z.unknown(), 48 * 1024) : null;
    return jsonResponse(await run(body));
  } catch (error) {
    if (error instanceof VoiceLabError) {
      return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
    }
    if (error instanceof WebChatError) {
      return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
    }
    voiceLabLogger.error('voice_lab.request_failed', { error });
    return jsonResponse({ error: { code: 'internal', message: 'Something went wrong.' } }, 500);
  }
}
