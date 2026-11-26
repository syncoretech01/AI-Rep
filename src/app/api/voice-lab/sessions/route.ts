import { startVoiceLabSession, voiceLabRoute } from '@/server/admin/voice-lab';

/** Developer voice lab: starts a voice session from the browser's WebRTC offer (owners/admins; VOICE_DEV_ENABLED). */
export async function POST(request: Request): Promise<Response> {
  return voiceLabRoute(request, (body) => startVoiceLabSession(body));
}
