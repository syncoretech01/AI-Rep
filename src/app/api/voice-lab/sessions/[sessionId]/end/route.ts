import { endVoiceLabSession, voiceLabRoute } from '@/server/admin/voice-lab';

/** Developer voice lab: ends a session (owners/admins). */
export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }): Promise<Response> {
  const { sessionId } = await context.params;
  return voiceLabRoute(request, (body) => endVoiceLabSession(sessionId, body));
}
