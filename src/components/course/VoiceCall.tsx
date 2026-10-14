import { Component, useEffect, useRef, useState } from 'react';
import { ApiError, streamTutor, voiceSpeak, voiceTranscribe, voiceConfig } from '../../lib/api';
import { MIC_SILENCE_RMS, vadTurnTick } from '../../lib/voiceTurn';
import { TurnCapture, type TurnRecording } from '../../lib/voiceCapture';
import { useI18n } from '../../lib/i18n';
import { Button, Icon, ThinkingDots } from '../ui';

// Turn-based voice call over the existing server-side provider key.
// Flow per turn: VAD detects speech → WAV capture stops at silence → STT
// (server) → standard grounded tutor stream (persists both messages exactly
// like a typed question on completion) → TTS (server) → playback, with
// tap-to-interrupt and echo-guarded voice barge-in.
//
// Reliability rules:
//  - Turn failures land in a distinct "retry needed" state with a Retry
//    action; the failed turn is resubmitted WITHOUT re-listening and without
//    duplicating the user's message.
//  - A message is marked Saved only after the tutor stream's done event,
//    which is when the server has actually persisted both sides.
//  - Speaking is shown only while AI audio is genuinely playing.
type Phase = 'connecting' | 'ready' | 'listening' | 'thinking' | 'speaking' | 'ended' | 'error';

const SILENCE_MS = 1200;
const MIN_SPEECH_MS = 250;
const SPEAK_RMS = 0.045;
const INTERRUPT_RMS = 0.1;
const INTERRUPT_MS = 450;
const BARS = 28;
// If a listening period produces ONLY digital-silence frames this long, the
// WebAudio graph is not delivering mic data (iOS Safari bug class) — fall back
// to force-armed turns bounded by the turn cap instead of hanging forever.
const MIC_DEAD_AFTER_MS = 3000;

const TURN_MAX_FALLBACK_MS = 30_000;
const SESSION_MAX_FALLBACK_MS = 600_000;

// Placeholder recording used when a tutor-step retry resends a known
// question (STT is skipped, so no audio is needed).
const EMPTY_REC: TurnRecording = { blob: new Blob(), base64: '', format: 'wav', seconds: 0 };

interface Msg {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  citations?: any[];
  coverageNotice?: string | null;
  saved?: boolean;
}

// Render-crash containment: an uncaught exception inside the call must never
// blank the whole app; it degrades to a recoverable full-screen card instead.
class VoiceCallBoundary extends Component<{ onEnd: () => void; children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) return <VoiceCallCrash onEnd={this.props.onEnd} />;
    return this.props.children;
  }
}

function VoiceCallCrash({ onEnd }: { onEnd: () => void }) {
  const { t } = useI18n();
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-slate-950 px-6 text-center">
      <p className="text-lg font-semibold text-white">{t.voiceErrorState}</p>
      <p className="max-w-xs text-sm text-white/60">{t.voiceCrashed}</p>
      <Button onClick={onEnd}>{t.voiceBackToTutor}</Button>
    </div>
  );
}

function VoiceCallSession({ courseId, onEnd, audioCtx }: { courseId: string; onEnd: () => void; audioCtx?: AudioContext | null }) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>('connecting');
  const phaseRef = useRef<Phase>('connecting');
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  const [transcript, setTranscript] = useState<Msg[]>([]);
  const [showTranscript, setShowTranscript] = useState(true);
  const [errorKind, setErrorKind] = useState<'permission' | 'unsupported' | 'generic'>('generic');
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [transcriptOnly, setTranscriptOnly] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0.08));
  const [hint, setHint] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [savedTurns, setSavedTurns] = useState(0);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const captureRef = useRef<TurnCapture | null>(null);
  const rafRef = useRef<number | null>(null);
  const recStartRef = useRef(0);
  const armedRef = useRef(false);
  const lastVoiceRef = useRef(0);
  const speechStartRef = useRef(0);
  const signalSeenRef = useRef(false);
  const deadHintShownRef = useRef(false);
  const interruptStartRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const startedAtRef = useRef(0);
  const sessionMaxRef = useRef(SESSION_MAX_FALLBACK_MS);
  const turnMaxRef = useRef(TURN_MAX_FALLBACK_MS);
  const endedRef = useRef(false);
  const turnLockRef = useRef(false);
  // Last failed turn for the Retry action — never duplicates messages.
  const lastTurnRef = useRef<{ rec?: TurnRecording; question?: string; userId?: number } | null>(null);
  const nextIdRef = useRef(1);
  const activePhase = () => phaseRef.current;

  const setPhaseBoth = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  // ---- audio graph + VAD loop ----
  const vadLoop = () => {
    rafRef.current = requestAnimationFrame(vadLoop);
    const analyser = analyserRef.current;
    if (!analyser) return;
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);

    // Waveform bars mirror the live mic; they never animate without audio.
    if (!mutedRef.current && (activePhase() === 'ready' || activePhase() === 'listening' || activePhase() === 'connecting')) {
      setLevels((prev) => {
        const next = prev.slice();
        const scale = Math.min(1, rms * 9);
        for (let i = 0; i < BARS; i++) {
          const wobble = 0.65 + 0.35 * Math.abs(Math.sin((Date.now() / 90 + i * 1.7) % Math.PI));
          next[i] = Math.max(0.08, Math.min(1, scale * wobble));
        }
        return next;
      });
      // First real mic frame: connecting/ready -> listening.
      if (rms > MIC_SILENCE_RMS && !signalSeenRef.current) {
        signalSeenRef.current = true;
        if (activePhase() === 'connecting' || activePhase() === 'ready') beginListening();
      }
    }

    if (activePhase() === 'listening' && !mutedRef.current) {
      const now = Date.now();
      const micDead = !signalSeenRef.current && now - recStartRef.current > MIC_DEAD_AFTER_MS && rms <= MIC_SILENCE_RMS;
      if (micDead && !deadHintShownRef.current) {
        deadHintShownRef.current = true;
        setHint(t.voiceMicSignal);
      }
      // Turn boundary: sustained speech followed by silence, or turn cap.
      // With a dead mic graph the turn is force-armed and bounded by the cap.
      const res = vadTurnTick(
        { armed: armedRef.current, speechStart: speechStartRef.current, lastVoice: lastVoiceRef.current },
        {
          now,
          rms,
          speakRms: SPEAK_RMS,
          minSpeechMs: MIN_SPEECH_MS,
          silenceMs: SILENCE_MS,
          turnCapMs: turnMaxRef.current,
          recStartMs: recStartRef.current,
          micDead,
        },
      );
      armedRef.current = res.state.armed;
      speechStartRef.current = res.state.speechStart;
      lastVoiceRef.current = res.state.lastVoice;
      if (res.endTurn) stopTurn();
    }

    // Barge-in while the tutor speaks: sustained loud speech above a higher
    // threshold (echo guard — phone speakers leak into the mic even with AEC).
    if (activePhase() === 'speaking' && !mutedRef.current) {
      const now = Date.now();
      if (rms > INTERRUPT_RMS) {
        if (!interruptStartRef.current) interruptStartRef.current = now;
        else if (now - interruptStartRef.current >= INTERRUPT_MS) {
          interruptStartRef.current = 0;
          interruptPlayback();
        }
      } else interruptStartRef.current = 0;
    }
  };

  const startTurn = () => {
    captureRef.current?.start();
    deadHintShownRef.current = false;
    armedRef.current = false;
    speechStartRef.current = 0;
    recStartRef.current = Date.now();
  };

  const stopTurn = () => {
    const rec = captureRef.current?.stop() ?? null;
    if (rec) void processTurn(rec);
    else if (activePhase() === 'listening') startTurn();
  };

  const interruptPlayback = () => {
    const audio = audioRef.current;
    if (audio) {
      try {
        audio.pause();
        audio.currentTime = 0;
      } catch {}
    }
    if (activePhase() === 'speaking') beginListening();
  };

  const enterListening = () => {
    if (endedRef.current) return;
    startTurn();
    setPhaseBoth('listening');
  };

  // beginListening keeps a passed-in hint visible: per-turn failure messages
  // must survive the transition back to listening, otherwise every failure
  // looks like a silent dead call.
  const beginListening = (keepHint?: string | null, withRetry = false) => {
    if (endedRef.current) return;
    setHint(keepHint ?? null);
    setRetrying(withRetry);
    enterListening();
  };

  const fail = (kind: 'permission' | 'unsupported' | 'generic', detail: string | null) => {
    if (endedRef.current) return;
    cleanupMedia();
    setErrorKind(kind);
    setErrorDetail(detail);
    setPhaseBoth('error');
  };

  // ---- one spoken turn ----
  // questionOverride: set by the Retry path when the transcript already
  // succeeded and only the tutor step must be redone (STT is skipped).
  const processTurn = async (rec: TurnRecording, isRetry = false, questionOverride?: string) => {
    if (endedRef.current || turnLockRef.current) return;
    turnLockRef.current = true;
    setHint(null);
    setRetrying(false);
    setPhaseBoth('thinking');
    let question = (questionOverride ?? '').trim();
    if (questionOverride == null) {
      try {
        const { text } = await voiceTranscribe(courseId, rec.base64, rec.format);
        question = text.trim();
      } catch (e: any) {
        turnLockRef.current = false;
        if (endedRef.current) return;
        lastTurnRef.current = { rec };
        if (e instanceof ApiError && (e.status === 503 || e.code === 'AI_NOT_CONFIGURED')) return fail('generic', t.aiNotConfigured);
        if (e instanceof ApiError && e.status === 429) return beginListening(t.voiceRateLimited, true);
        return beginListening(t.voiceTranscribeFailed, true);
      }
      if (!question) {
        turnLockRef.current = false;
        // Silence/noise — retrying the same audio would fail the same way.
        return beginListening(t.voiceNoSpeech);
      }
    }
    // Add the user turn exactly once (retries of the tutor step skip this).
    let userId = -1;
    if (!isRetry) {
      userId = nextIdRef.current++;
      setTranscript((prev) => [...prev, { id: userId, role: 'user', text: question }]);
    }

    // Grounded answer via the standard tutor pipeline (streams; persists the
    // user + assistant messages exactly like a typed question on completion).
    let answer = '';
    let citations: any[] = [];
    let covNotice: string | null | undefined;
    abortRef.current = new AbortController();
    let failed = false;
    try {
      await streamTutor(
        courseId,
        { question },
        {
          onDelta: (chunk) => {
            answer += chunk;
          },
          onDone: (meta) => {
            citations = meta.citations || [];
            covNotice = meta.coverageNotice || null;
          },
          onError: (err) => {
            failed = true;
            setErrorDetail(err.message);
          },
        },
        abortRef.current.signal,
      );
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        turnLockRef.current = false;
        return; // call ended mid-answer
      }
      failed = true;
      if (!errorDetailRef.current) setErrorDetail(e?.message || t.voiceTryAgain);
    }
    abortRef.current = null;
    turnLockRef.current = false;
    if (endedRef.current) return;
    if (failed || !answer.trim()) {
      lastTurnRef.current = { rec, question, userId };
      return beginListening(t.voiceTryAgain, true);
    }

    // Server has now persisted BOTH messages (on stream completion) — mark
    // the user message and add the assistant message with its Saved tick.
    const savedUserId = isRetry && lastTurnRef.current?.userId != null ? lastTurnRef.current.userId : userId;
    if (savedUserId >= 0) {
      setTranscript((prev) => prev.map((m) => (m.id === savedUserId ? { ...m, saved: true } : m)));
    }
    setTranscript((prev) => [...prev, { id: nextIdRef.current++, role: 'assistant', text: answer, citations, coverageNotice: covNotice, saved: true }]);
    setSavedTurns((n) => n + 1);
    lastTurnRef.current = null;
    setHint(null);

    if (transcriptOnly) {
      setTimeout(() => !endedRef.current && beginListening(), 1500);
      return;
    }
    try {
      const audioBlob = await voiceSpeak(courseId, answer);
      if (endedRef.current) return;
      const url = URL.createObjectURL(audioBlob);
      const audio = audioRef.current!;
      audio.src = url;
      const onEnded = () => {
        audio.removeEventListener('ended', onEnded);
        URL.revokeObjectURL(url);
        if (!endedRef.current) beginListening();
      };
      audio.addEventListener('ended', onEnded);
      await audio.play(); // Speaking is only shown once audio really plays.
      if (endedRef.current) return;
      setPhaseBoth('speaking');
    } catch (e: any) {
      if (endedRef.current) return;
      if (e instanceof ApiError && e.status === 429) setHint(t.voiceRateLimited);
      enableTranscriptOnly();
    }
  };

  // Retry the last failed turn: STT failures resubmit the recording; tutor
  // failures resend only the question (STT skipped). No duplicate user
  // messages either way.
  const retryLastTurn = () => {
    const lt = lastTurnRef.current;
    if (!lt || turnLockRef.current) return;
    setHint(null);
    setRetrying(false);
    if (lt.question != null) void processTurn(EMPTY_REC, true, lt.question);
    else if (lt.rec) void processTurn(lt.rec);
  };

  const errorDetailRef = useRef<string | null>(null);
  useEffect(() => {
    errorDetailRef.current = errorDetail;
  }, [errorDetail]);

  const enableTranscriptOnly = () => {
    setTranscriptOnly(true);
    setHint(t.voiceTranscriptOnly);
    setTimeout(() => !endedRef.current && beginListening(), 1200);
  };

  // ---- call lifecycle ----
  const cleanupMedia = () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    captureRef.current?.dispose();
    captureRef.current = null;
    const audio = audioRef.current;
    if (audio) {
      try {
        audio.pause();
        audio.currentTime = 0;
      } catch {}
    }
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    try {
      ctxRef.current?.close();
    } catch {}
    ctxRef.current = null;
    analyserRef.current = null;
  };

  const endCall = (reason: 'user' | 'limit') => {
    if (endedRef.current) return;
    endedRef.current = true;
    abortRef.current?.abort();
    cleanupMedia();
    setPhaseBoth('ended');
    if (reason === 'limit') setHint(t.voiceTimeLimit);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await voiceConfig(courseId);
        if (cancelled) return;
        if (!cfg.available) return fail('generic', t.aiNotConfigured);
        turnMaxRef.current = Math.min(cfg.maxTurnSeconds * 1000 || TURN_MAX_FALLBACK_MS, TURN_MAX_FALLBACK_MS);
        sessionMaxRef.current = cfg.maxSessionSeconds * 1000 || SESSION_MAX_FALLBACK_MS;
      } catch {
        // config endpoint failing does not necessarily block voice; continue
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (cancelled) {
          stream.getTracks().forEach((tr) => tr.stop());
          return;
        }
        streamRef.current = stream;
        // Prefer the context created inside the opening user gesture
        // (TutorTab) — on iOS Safari a context created outside a gesture can
        // stay suspended forever, silencing the whole VAD graph.
        const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
        const ctx = audioCtx && audioCtx.state !== 'closed' ? audioCtx : new Ctx();
        await ctx.resume().catch(() => {});
        ctxRef.current = ctx;
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        src.connect(analyser);
        // iOS Safari delivers permanent zeros from a mic graph with no output
        // path (webkit bug 180522). Bridge through a zero-gain node so the
        // graph renders everywhere without monitoring the mic out loud.
        const silentGain = ctx.createGain();
        silentGain.gain.value = 0;
        silentGain.connect(ctx.destination);
        src.connect(silentGain);
        // Raw-PCM turn capture: same WAV bytes on every browser (see
        // voiceCapture.ts for why MediaRecorder is not used).
        captureRef.current = new TurnCapture(ctx, src, silentGain);
        analyserRef.current = analyser;
        audioRef.current = new Audio();
        startedAtRef.current = Date.now();
        rafRef.current = requestAnimationFrame(vadLoop);
        setPhaseBoth('ready');
      } catch (e: any) {
        if (cancelled) return;
        if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') fail('permission', null);
        else fail('generic', e?.message || null);
      }
    })();
    // iOS can leave the context suspended after backgrounding; resume it the
    // moment the page is visible again.
    const onVisible = () => {
      const ctx = ctxRef.current;
      if (!document.hidden && ctx && ctx.state !== 'running') void ctx.resume().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);
    // Session duration cap + elapsed clock.
    const tick = setInterval(() => {
      if (startedAtRef.current && !endedRef.current) {
        const ms = Date.now() - startedAtRef.current;
        setElapsed(ms);
        if (ms >= sessionMaxRef.current) endCall('limit');
      }
    }, 500);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(tick);
      if (!endedRef.current) endCall('user');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  const toggleMute = () => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    streamRef.current?.getAudioTracks().forEach((tr) => (tr.enabled = !next));
    if (next && activePhase() === 'listening') {
      // Drop the partial turn; a muted mic must not submit silence.
      captureRef.current?.stop();
      startTurn();
    }
  };

  const mm = String(Math.floor(elapsed / 60000)).padStart(2, '0');
  const ss = String(Math.floor((elapsed % 60000) / 1000)).padStart(2, '0');
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const statusMeta: Record<Phase, { label: string; color: string }> = {
    connecting: { label: t.voiceConnecting, color: 'bg-white/60' },
    ready: { label: t.voiceReady, color: 'bg-amber-300' },
    listening: { label: muted ? t.voiceMuted : t.voiceListening, color: muted ? 'bg-amber-400' : 'bg-emerald-400' },
    thinking: { label: t.voiceThinking, color: 'bg-indigo-300' },
    speaking: { label: t.voiceSpeaking, color: 'bg-indigo-400' },
    ended: { label: t.voiceEnded, color: 'bg-white/40' },
    error: { label: t.voiceErrorState, color: 'bg-red-400' },
  };
  const meta = statusMeta[phase];

  return (
    // Opaque background: backdrop-filter inside a fixed overlay is a known
    // iOS Safari compositing-failure trigger.
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-950" style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 12px)', paddingTop: 'env(safe-area-inset-top)' }}>
      {/* header: status, timer, transcript toggle */}
      <div className="flex items-center justify-between px-5 pt-3 text-white/80">
        <div className="flex items-center gap-2 text-sm font-medium" role="status" aria-live="polite">
          <span className="relative flex h-2.5 w-2.5">
            {(phase === 'listening' || phase === 'speaking' || phase === 'thinking') && !reducedMotion && (
              <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${meta.color} opacity-50`} />
            )}
            <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${meta.color}`} />
          </span>
          <span>{meta.label}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm">{mm}:{ss}</span>
          <button
            onClick={() => setShowTranscript((v) => !v)}
            className="rounded-full border border-white/15 px-3 py-1 text-xs text-white/70 hover:bg-white/10"
            aria-expanded={showTranscript}
          >
            {showTranscript ? t.voiceHideTranscript : t.voiceShowTranscript}
          </button>
        </div>
      </div>

      {/* orb + waveform */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-6">
        <button
          onClick={phase === 'speaking' ? interruptPlayback : undefined}
          aria-label={phase === 'speaking' ? t.voiceInterrupt : undefined}
          className={`flex h-24 w-24 items-center justify-center rounded-full border transition-colors duration-300 ${
            phase === 'speaking'
              ? 'border-indigo-400/50 bg-indigo-500/15 text-indigo-200'
              : phase === 'thinking'
                ? 'border-indigo-400/30 bg-indigo-500/10 text-indigo-300'
                : phase === 'ready' || phase === 'connecting'
                  ? 'border-amber-300/40 bg-amber-400/10 text-amber-200'
                  : 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200'
          } ${phase === 'speaking' ? 'cursor-pointer' : 'cursor-default'}`}
        >
          <Icon name={phase === 'speaking' ? 'volume' : phase === 'thinking' ? 'sparkles' : 'mic'} className="h-9 w-9" />
        </button>

        <div className={`flex h-20 items-end justify-center gap-1 ${muted ? 'opacity-30' : ''}`} aria-hidden>
          {(phase === 'thinking' ? Array(BARS).fill(0.12) : levels).map((v, i) => (
            <div
              key={i}
              className={`w-1.5 rounded-full ${reducedMotion ? '' : 'transition-[height] duration-75'} ${
                phase === 'speaking' || phase === 'thinking' ? 'bg-gradient-to-t from-indigo-500 to-indigo-300' : 'bg-gradient-to-t from-amber-500/80 to-emerald-300'
              }`}
              style={{ height: `${Math.max(6, v * 68)}px` }}
            />
          ))}
        </div>

        <div className="text-center">
          <p className="text-lg font-semibold text-white">{phase === 'listening' && retrying ? t.voiceRetryNeeded : meta.label}</p>
          {phase === 'thinking' && <ThinkingDots className="mt-1 text-indigo-300" />}
          {hint && <p className="mx-auto mt-1 max-w-xs text-sm text-white/60">{hint}</p>}
          {phase === 'listening' && retrying && (
            <button
              onClick={retryLastTurn}
              className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-amber-400 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-300"
            >
              <Icon name="refresh" className="h-4 w-4" />
              {t.voiceRetryAction}
            </button>
          )}
        </div>

        {/* transcript */}
        {showTranscript && transcript.length > 0 && (
          <div className="no-scrollbar mt-1 w-full max-w-md flex-1 space-y-3 overflow-y-auto rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-sm" aria-live="polite">
            {transcript.map((m) => (
              <div key={m.id} className={m.role === 'user' ? 'text-white/90' : 'text-white'}>
                <p className={`mb-0.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide ${m.role === 'user' ? 'text-white/40' : 'text-amber-200/80'}`}>
                  {m.role === 'user' ? t.you : t.voiceTutor}
                  {m.saved && (
                    <span className="inline-flex items-center gap-0.5 font-normal normal-case text-emerald-300/90">
                      <Icon name="target" className="h-3 w-3" />
                      {t.voiceSaved}
                    </span>
                  )}
                </p>
                <p className="whitespace-pre-wrap leading-relaxed">{m.text}</p>
                {(m.citations?.length ?? 0) > 0 && (
                  <p className="mt-1 text-[11px] text-white/40">
                    {m.citations!.map((c: any, j: number) => `[${j + 1}] ${c.filename || c.material || ''}${c.page_number ? ` p.${c.page_number}` : ''}`).join('  ')}
                  </p>
                )}
                {m.coverageNotice && <p className="mt-1 text-[11px] text-amber-300/80">{m.coverageNotice}</p>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* states: error / ended */}
      {phase === 'error' && (
        <div className="mx-5 mb-4 rounded-2xl border border-red-400/30 bg-red-500/10 p-4 text-center text-sm text-red-100">
          <p className="font-medium">{errorKind === 'permission' ? t.voiceMicDenied : errorKind === 'unsupported' ? t.voiceUnsupported : t.voiceErrorState}</p>
          {errorKind === 'permission' && <p className="mt-1 text-red-200/80">{t.voiceMicDeniedHint}</p>}
          {errorKind === 'generic' && errorDetail && <p className="mt-1 text-red-200/80">{errorDetail}</p>}
          <div className="mt-3 flex justify-center gap-2">
            {errorKind !== 'permission' && errorKind !== 'unsupported' && (
              <Button size="sm" onClick={() => window.location.reload()}>{t.retry}</Button>
            )}
            <Button size="sm" variant="secondary" onClick={onEnd}>{t.voiceBackToTutor}</Button>
          </div>
        </div>
      )}
      {phase === 'ended' && (
        <div className="mx-5 mb-4 rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-center text-sm text-white/80">
          <p className="font-medium text-white">{t.voiceEnded}</p>
          {hint && <p className="mt-1 text-white/60">{hint}</p>}
          {savedTurns > 0 ? (
            <p className="mt-1 text-emerald-300/90">{t.voiceSavedCount.replace('{n}', String(savedTurns))}</p>
          ) : (
            <p className="mt-1 text-white/50">{t.voiceNothingSaved}</p>
          )}
          <Button className="mt-3" onClick={onEnd}>{t.voiceBackToTutor}</Button>
        </div>
      )}

      {/* controls — bottom row, one-hand reachable */}
      {(phase === 'ready' || phase === 'listening' || phase === 'thinking' || phase === 'speaking') && (
        <div className="flex items-center justify-center gap-4 px-6 pb-3">
          <button
            onClick={toggleMute}
            aria-label={muted ? t.voiceUnmute : t.voiceMute}
            className={`flex h-14 w-14 items-center justify-center rounded-full border transition-colors ${
              muted ? 'border-amber-400/60 bg-amber-500/20 text-amber-300' : 'border-white/15 bg-white/5 text-white hover:bg-white/10'
            }`}
          >
            <Icon name={muted ? 'mic-off' : 'mic'} className="h-6 w-6" />
          </button>
          {phase === 'speaking' && (
            <button
              onClick={interruptPlayback}
              aria-label={t.voiceInterrupt}
              className="flex h-14 flex-1 max-w-[150px] items-center justify-center gap-2 rounded-full border border-indigo-400/40 bg-indigo-500/20 text-sm font-medium text-indigo-200 hover:bg-indigo-500/30"
            >
              <Icon name="volume" className="h-4 w-4" />
              {t.voiceInterrupt}
            </button>
          )}
          <button
            onClick={() => endCall('user')}
            aria-label={t.voiceEndCall}
            className="flex h-16 w-16 items-center justify-center rounded-full bg-red-500 text-white shadow-lg shadow-red-500/30 hover:bg-red-400"
          >
            <Icon name="phone" className="h-7 w-7 rotate-[135deg]" />
          </button>
        </div>
      )}
    </div>
  );
}

export function VoiceCall(props: { courseId: string; onEnd: () => void; audioCtx?: AudioContext | null }) {
  return (
    <VoiceCallBoundary onEnd={props.onEnd}>
      <VoiceCallSession {...props} />
    </VoiceCallBoundary>
  );
}
