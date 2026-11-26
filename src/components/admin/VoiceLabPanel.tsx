'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { inputClass } from './fields';
import { Badge, Card, buttonClass, cx, type BadgeTone } from './ui';

/**
 * Developer voice lab client (Phase 2 proof of concept). The browser only does media: it opens a WebRTC connection
 * whose offer our server forwards to the voice gateway, which creates the GPT-Live session with pinned configuration
 * and answers every tool call server-side. The data channel may only hang up and mute (enforced by the provider);
 * transcripts and usage shown here come from it, tool runs and cost from the server.
 */

type Phase = 'idle' | 'connecting' | 'live' | 'ending' | 'ended' | 'failed';

interface Line {
  role: 'user' | 'assistant';
  text: string;
}

interface ServerView {
  session: { status: string; endReason: string | null; activeSeconds: number; standbySeconds: number; usageSource: string | null };
  toolRuns: Array<{ id: string; toolName: string; status: string; errorCode: string | null; durationMs: number | null }>;
  estimatedCostUsd: number;
  liveEstimate: boolean;
}

interface Live {
  pc: RTCPeerConnection;
  channel: RTCDataChannel;
  stream: MediaStream;
  audio: AudioContext;
  voiceSessionId: string | null;
}

const ICE_GATHERING_TIMEOUT_MS = 2_500;
const POLL_MS = 2_000;
const PHASE_LABELS: Record<Phase, string> = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  live: 'Connected',
  ending: 'Ending…',
  ended: 'Ended',
  failed: 'Failed',
};
const PHASE_TONES: Record<Phase, BadgeTone> = {
  idle: 'neutral',
  connecting: 'info',
  live: 'success',
  ending: 'warning',
  ended: 'neutral',
  failed: 'danger',
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

async function readError(response: Response): Promise<string> {
  try {
    const body = record(await response.json());
    const message = record(body.error).message;
    if (typeof message === 'string') return message;
  } catch {
    // Not JSON.
  }
  return `Request failed (${String(response.status)}).`;
}

/** The offer is sent once with all candidates (non-trickle), so wait for gathering, bounded. */
function iceGathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(done, ICE_GATHERING_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

function level(analyser: AnalyserNode, buffer: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(buffer);
  let sum = 0;
  for (const sample of buffer) {
    const centered = (sample - 128) / 128;
    sum += centered * centered;
  }
  return Math.min(1, Math.sqrt(sum / buffer.length) * 4);
}

function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, '0')}`;
}

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-xs text-slate-600">{label}</span>
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
        <div className="h-full rounded-full bg-indigo-500 transition-[width] duration-75" style={{ width: `${String(Math.round(value * 100))}%` }} />
      </div>
    </div>
  );
}

export function VoiceLabPanel({ orgSlug, agents }: { orgSlug: string; agents: Array<{ id: string; name: string }> }) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [standby, setStandby] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [levels, setLevels] = useState({ mic: 0, agent: 0 });
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [maxSeconds, setMaxSeconds] = useState<number | null>(null);
  const [providerSeconds, setProviderSeconds] = useState<{ active: number; standby: number } | null>(null);
  const [voiceSessionId, setVoiceSessionId] = useState<string | null>(null);
  const [view, setView] = useState<ServerView | null>(null);
  const live = useRef<Live | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);

  const teardown = useCallback(() => {
    const current = live.current;
    live.current = null;
    if (!current) return;
    current.channel.close();
    current.pc.close();
    for (const track of current.stream.getTracks()) track.stop();
    void current.audio.close();
    if (audioElement.current) audioElement.current.srcObject = null;
    setLevels({ mic: 0, agent: 0 });
  }, []);

  const appendDelta = useCallback((role: Line['role'], text: string) => {
    setLines((previous) => {
      const last = previous.at(-1);
      if (last?.role === role) return [...previous.slice(0, -1), { role, text: last.text + text }];
      return [...previous, { role, text }];
    });
  }, []);

  const onProviderEvent = useCallback(
    (raw: unknown) => {
      if (typeof raw !== 'string') return;
      let event: Record<string, unknown>;
      try {
        event = record(JSON.parse(raw));
      } catch {
        return;
      }
      const delta = typeof event.delta === 'string' ? event.delta : '';
      switch (event.type) {
        case 'session.input_transcript.delta':
          appendDelta('user', delta);
          return;
        case 'session.output_transcript.delta':
          appendDelta('assistant', delta);
          return;
        case 'session.paused':
          setStandby(true);
          return;
        case 'session.resumed':
          setStandby(false);
          return;
        case 'session.usage.updated': {
          const usage = record(event.usage);
          const active = typeof usage.active_seconds === 'number' ? usage.active_seconds : typeof usage.seconds === 'number' ? usage.seconds : 0;
          setProviderSeconds({ active, standby: typeof usage.paused_seconds === 'number' ? usage.paused_seconds : 0 });
          return;
        }
        case 'session.closed':
          setPhase((current) => (current === 'failed' ? current : 'ended'));
          teardown();
          return;
        case 'error': {
          const message = record(event.error).message;
          setError(typeof message === 'string' ? message : 'The voice provider reported an error.');
          return;
        }
        default:
          return;
      }
    },
    [appendDelta, teardown],
  );

  const endOnServer = useCallback(
    async (id: string, keepalive = false) => {
      try {
        await fetch(`/api/voice-lab/sessions/${id}/end`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ orgSlug }),
          keepalive,
        });
      } catch {
        // The gateway's silence and duration limits still end the session.
      }
    },
    [orgSlug],
  );

  const start = async () => {
    setError(null);
    setLines([]);
    setView(null);
    setProviderSeconds(null);
    setMuted(false);
    setStandby(false);
    setVoiceSessionId(null);
    setPhase('connecting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      setError('Microphone access was denied or no microphone is available.');
      setPhase('failed');
      return;
    }
    const pc = new RTCPeerConnection();
    const audio = new AudioContext();
    // The provider's event channel must exist before the offer is created.
    const channel = pc.createDataChannel('oai-events');
    live.current = { pc, channel, stream, audio, voiceSessionId: null };
    // This attempt's state, or null once it was ended or torn down (re-read after every await).
    const owned = (): Live | null => (live.current?.pc === pc ? live.current : null);
    channel.addEventListener('message', (message: MessageEvent) => onProviderEvent(message.data));

    const micAnalyser = audio.createAnalyser();
    audio.createMediaStreamSource(stream).connect(micAnalyser);
    let agentAnalyser: AnalyserNode | null = null;
    pc.addEventListener('track', (event) => {
      const [remote] = event.streams;
      if (!remote) return;
      if (audioElement.current) audioElement.current.srcObject = remote;
      agentAnalyser = audio.createAnalyser();
      audio.createMediaStreamSource(remote).connect(agentAnalyser);
    });
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' && live.current?.pc === pc) {
        setError('The audio connection was lost. The server closes the session and settles its usage.');
        setPhase('failed');
        teardown();
      }
    });
    for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);

    const buffer = new Uint8Array(new ArrayBuffer(micAnalyser.fftSize));
    const tick = () => {
      if (live.current?.pc !== pc) return;
      setLevels({ mic: level(micAnalyser, buffer), agent: agentAnalyser ? level(agentAnalyser, buffer) : 0 });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    try {
      await pc.setLocalDescription(await pc.createOffer());
      await iceGathered(pc);
      const response = await fetch('/api/voice-lab/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgSlug, agentId, sdp: pc.localDescription?.sdp ?? '' }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const started = record(await response.json());
      if (typeof started.voiceSessionId !== 'string' || typeof started.sdp !== 'string') throw new Error('Unexpected response.');
      const current = owned();
      if (!current) {
        // Ended while connecting: end the session the server just created.
        void endOnServer(started.voiceSessionId);
        return;
      }
      current.voiceSessionId = started.voiceSessionId;
      setVoiceSessionId(started.voiceSessionId);
      setMaxSeconds(typeof started.maxDurationSeconds === 'number' ? started.maxDurationSeconds : null);
      await pc.setRemoteDescription({ type: 'answer', sdp: started.sdp });
      const connectedAt = Date.now();
      setStartedAt(connectedAt);
      setNow(connectedAt);
      setPhase('live');
    } catch (cause) {
      const current = owned();
      // Ended while connecting (the closed connection makes the pending step throw): nothing to report.
      if (!current) return;
      setError(cause instanceof Error ? cause.message : 'Could not start the voice session.');
      setPhase('failed');
      teardown();
      if (current.voiceSessionId) void endOnServer(current.voiceSessionId);
    }
  };

  const end = async () => {
    const id = live.current?.voiceSessionId ?? null;
    setPhase('ending');
    if (live.current?.channel.readyState === 'open') live.current.channel.send(JSON.stringify({ type: 'session.close' }));
    // The server-side end is authoritative: it closes the provider session and settles usage.
    if (id) await endOnServer(id);
    teardown();
    setPhase('ended');
  };

  const toggleMute = () => {
    const current = live.current;
    if (!current) return;
    const next = !muted;
    // Stop sending audio locally, and tell the provider to stop listening.
    for (const track of current.stream.getAudioTracks()) track.enabled = !next;
    if (current.channel.readyState === 'open') {
      current.channel.send(JSON.stringify({ type: next ? 'session.input_audio.mute' : 'session.input_audio.unmute' }));
    }
    setMuted(next);
  };

  // Session clock.
  useEffect(() => {
    if (phase !== 'live') return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [phase]);

  // Server view: tool runs, recorded usage and cost. Polled while live, fetched once more when it ends.
  useEffect(() => {
    if (!voiceSessionId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`/api/voice-lab/sessions/${voiceSessionId}?org=${encodeURIComponent(orgSlug)}`);
        if (!response.ok || cancelled) return;
        setView((await response.json()) as ServerView);
      } catch {
        // Next poll.
      }
    };
    void load();
    if (phase !== 'live' && phase !== 'ending') {
      // Final usage is written when the gateway settles the session.
      const final = setTimeout(() => void load(), 3_000);
      return () => {
        cancelled = true;
        clearTimeout(final);
      };
    }
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [voiceSessionId, phase, orgSlug]);

  // Leaving the page ends the session.
  useEffect(() => {
    const leave = () => {
      const id = live.current?.voiceSessionId;
      if (id) void endOnServer(id, true);
      teardown();
    };
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, [endOnServer, teardown]);

  // The clock ticks while live and stops at the last tick afterwards.
  const elapsed = startedAt === null ? 0 : (now - startedAt) / 1000;
  const speaking = levels.agent > 0.08 ? 'Agent speaking' : levels.mic > 0.08 && !muted ? 'You are speaking' : standby ? 'Standby' : 'Listening';
  const busy = phase === 'connecting' || phase === 'ending';
  const connected = phase === 'live';

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="p-4 sm:p-6 lg:col-span-1">
        <div className="space-y-4">
          <div>
            <label htmlFor="voice-agent" className="block text-sm font-medium text-slate-800">
              Agent
            </label>
            <select
              id="voice-agent"
              className={cx(inputClass, 'mt-1')}
              value={agentId}
              disabled={connected || busy}
              onChange={(event) => setAgentId(event.target.value)}
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-2" aria-live="polite">
            <Badge tone={PHASE_TONES[phase]}>{PHASE_LABELS[phase]}</Badge>
            {connected ? <Badge tone={standby ? 'neutral' : 'info'}>{speaking}</Badge> : null}
            {muted ? <Badge tone="warning">Muted</Badge> : null}
          </div>

          <div className="space-y-2">
            <Meter label="You" value={muted ? 0 : levels.mic} />
            <Meter label="Agent" value={levels.agent} />
          </div>

          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-slate-600">Duration</dt>
            <dd className="text-right font-medium text-slate-900 tabular-nums">
              {formatClock(elapsed)}
              {maxSeconds ? <span className="text-slate-500"> / {formatClock(maxSeconds)}</span> : null}
            </dd>
            <dt className="text-slate-600">Provider time</dt>
            <dd className="text-right text-slate-900 tabular-nums">
              {providerSeconds ? `${providerSeconds.active.toFixed(0)} s active · ${providerSeconds.standby.toFixed(0)} s standby` : '—'}
            </dd>
            <dt className="text-slate-600">Estimated cost</dt>
            <dd className="text-right text-slate-900 tabular-nums">
              {view ? `$${view.estimatedCostUsd.toFixed(4)}${view.liveEstimate ? ' (upper bound)' : ''}` : '—'}
            </dd>
          </dl>

          <div className="flex flex-wrap gap-2">
            {connected || busy ? (
              <>
                <button type="button" className={buttonClass('secondary')} onClick={toggleMute} disabled={!connected}>
                  {muted ? 'Unmute' : 'Mute'}
                </button>
                <button type="button" className={buttonClass('danger')} onClick={() => void end()} disabled={phase === 'ending'}>
                  End
                </button>
              </>
            ) : (
              <button type="button" className={buttonClass('primary')} onClick={() => void start()} disabled={!agentId}>
                Start voice session
              </button>
            )}
          </div>

          {error ? (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {error}
            </p>
          ) : null}
          {view && (view.session.status === 'ended' || view.session.status === 'failed') ? (
            <p className="text-xs text-slate-600">
              Session {view.session.status}
              {view.session.endReason ? ` (${view.session.endReason})` : ''}; usage {view.session.usageSource === 'provider' ? 'reported by the provider' : 'estimated'}.
            </p>
          ) : null}
          {/* Remote audio from the provider (WebRTC). */}
          <audio ref={audioElement} autoPlay />
        </div>
      </Card>

      <Card className="p-4 sm:p-6 lg:col-span-2">
        <h2 className="text-base font-semibold text-slate-900">Live transcript</h2>
        <ol className="mt-3 max-h-96 space-y-2 overflow-y-auto text-sm" aria-live="polite">
          {lines.length === 0 ? <li className="text-slate-500">Start a session and speak; the transcript appears here.</li> : null}
          {lines.map((line, index) => (
            <li key={index} className={line.role === 'user' ? 'text-slate-900' : 'text-indigo-900'}>
              <span className="font-medium">{line.role === 'user' ? 'You' : 'Agent'}: </span>
              {line.text}
            </li>
          ))}
        </ol>

        <h2 className="mt-6 text-base font-semibold text-slate-900">Tool activity</h2>
        <ul className="mt-3 space-y-1 text-sm">
          {(view?.toolRuns.length ?? 0) === 0 ? <li className="text-slate-500">No tool calls yet.</li> : null}
          {view?.toolRuns.map((run) => (
            <li key={run.id} className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-slate-900">{run.toolName}</span>
              <Badge tone={run.status === 'succeeded' ? 'success' : run.status === 'failed' || run.status === 'rejected' ? 'danger' : 'info'}>{run.status}</Badge>
              {run.errorCode ? <span className="text-slate-600">{run.errorCode}</span> : null}
              {run.durationMs !== null ? <span className="text-slate-500 tabular-nums">{run.durationMs} ms</span> : null}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
