/** Shared between the voice gateway's HTTP API and its client in the Next.js app. */

export const VOICE_SESSION_PATH = '/v1/voice-sessions';

export type GatewayErrorCode =
  | 'unauthorized'
  | 'invalid_request'
  | 'not_found'
  | 'voice_limit'
  | 'spend_limit'
  | 'provider_unavailable'
  | 'internal';
