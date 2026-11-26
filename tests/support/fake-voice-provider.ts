import type {
  CreatedVoiceSession,
  RealtimeVoiceProvider,
  VoiceEvent,
  VoiceSessionRequest,
  VoiceSideband,
} from '@/server/ai/voice-types';
import { ProviderError } from '@/server/ai/types';

/**
 * Deterministic stand-in for a realtime voice provider (GPT-Live): records session requests, hands out sidebands the
 * test drives with provider events, and records everything the gateway sends back. Not evidence of voice quality.
 */
export class FakeSideband implements VoiceSideband {
  readonly toolResults: Array<{ callId: string; output: string }> = [];
  readonly delegatedReplies: Array<{ delegationId: string; text: string }> = [];
  closeRequests = 0;
  disconnected = false;
  /** When set, closeSession() answers with a `closed` event carrying these seconds. */
  closeWith: { activeSeconds: number; standbySeconds: number } | null = { activeSeconds: 12, standbySeconds: 3 };
  private eventHandler: (event: VoiceEvent) => void = () => undefined;
  private disconnectHandler: (reason: string) => void = () => undefined;

  onEvent(handler: (event: VoiceEvent) => void): void {
    this.eventHandler = handler;
  }

  onDisconnect(handler: (reason: string) => void): void {
    this.disconnectHandler = handler;
  }

  sendToolResult(callId: string, output: string): void {
    this.toolResults.push({ callId, output });
  }

  sendDelegatedReply(delegationId: string, text: string): void {
    this.delegatedReplies.push({ delegationId, text });
  }

  closeSession(): void {
    this.closeRequests += 1;
    if (this.closeWith) {
      const usage = this.closeWith;
      queueMicrotask(() => this.emit({ type: 'closed', reason: 'close_requested', usage }));
    }
  }

  disconnect(): void {
    this.disconnected = true;
  }

  /** Delivers a provider event to the gateway. */
  emit(event: VoiceEvent): void {
    this.eventHandler(event);
  }

  /** Simulates a dropped control connection. */
  drop(reason = 'connection_lost'): void {
    this.disconnectHandler(reason);
  }
}

export class FakeVoiceProvider implements RealtimeVoiceProvider {
  readonly id = 'fake-voice';
  readonly requests: VoiceSessionRequest[] = [];
  readonly sidebands: FakeSideband[] = [];
  readonly attached: string[] = [];
  /** Fails the next createSession call. */
  failCreate: ProviderError | null = null;

  createSession(request: VoiceSessionRequest): Promise<CreatedVoiceSession> {
    this.requests.push(request);
    if (this.failCreate) {
      const error = this.failCreate;
      this.failCreate = null;
      return Promise.reject(error);
    }
    return Promise.resolve({ providerSessionId: `live_fake_${request.correlationId}`, sdpAnswer: `v=0 answer-for-${request.correlationId}` });
  }

  attach(providerSessionId: string): Promise<VoiceSideband> {
    this.attached.push(providerSessionId);
    const sideband = new FakeSideband();
    this.sidebands.push(sideband);
    return Promise.resolve(sideband);
  }

  /** The sideband of the n-th attached session (0-based; default the latest). */
  sideband(index = this.sidebands.length - 1): FakeSideband {
    const sideband = this.sidebands[index];
    if (!sideband) throw new Error(`no sideband #${index}`);
    return sideband;
  }

  static outage(): ProviderError {
    return new ProviderError({ provider: 'fake-voice', code: 'unavailable', retryable: true, status: 503, message: 'fake-voice: down' });
  }
}
