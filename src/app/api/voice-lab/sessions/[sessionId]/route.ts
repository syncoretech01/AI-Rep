import { getVoiceLabView, voiceLabRoute } from '@/server/admin/voice-lab';

/** Developer voice lab: live status of a session (transcript, tool runs, usage) for members of its organization. */
export async function GET(request: Request, context: { params: Promise<{ sessionId: string }> }): Promise<Response> {
  const { sessionId } = await context.params;
  const orgSlug = new URL(request.url).searchParams.get('org') ?? '';
  return voiceLabRoute(request, () => getVoiceLabView(orgSlug, sessionId), { readBody: false });
}
