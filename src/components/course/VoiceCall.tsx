import { useEffect, useRef, useState } from 'react';
import { ApiError, streamTutor, voiceSpeak, voiceTranscribe, voiceConfig } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { Button, Icon, ThinkingDots } from '../ui';

// Turn-based voice call over the existing server-side provider key.
// Flow per turn: VAD detects speech → records until silence → STT (server) →
// standard grounded tutor stream (persisted like a typed question) → TTS
// (server) → playback, with tap-to-interrupt and echo-guarded voice barge-in.
// If speech synthesis is unavailable the call continues transcript-only —
// never with faked audio.
type Phase = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'ended' | 'error';

const SILENCE_MS = 1200;
const MIN_SPEECH_MS = 250;
const SPEAK_RMS = 0.045;
const INTERRUPT_RMS = 0.1;
const INTERRUPT_MS = 450;
const BARS = 24;

const TURN_MAX_FALLBACK_MS = 30_000;
const SESSION_MAX_FALLBACK_MS = 600_000;

function pickRecorder(): { mime: string; format: string } | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates: [string, string][] = [
    ['audio/webm;codecs=opus', 'webm'],
    ['audio/ogg;codecs=opus', 'ogg'],
    ['audio/mp4', 'm4a'],
  ];
  for (const [mime, format] of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return { mime, format };
    } catch {}
  }
  return null;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('read failed'));
    r.readAsDataURL(blob);
  });
}

export function VoiceCall({ courseId, onEnd }: { courseId: string; onEnd: () => void }) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>('connecting');
  const phaseRef = useRef<Phase>('connecting');
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  const [transcript, setTranscript] = useState<{ role: 'user' | 'assistant'; text: string; citations?: any[]; coverageNotice?: string | null }[]>([]);
  const [errorKind, setErrorKind] = useState<'permission' | 'unsupported' | 'generic'>('generic');
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [transcriptOnly, setTranscriptOnly] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0.08));
  const [hint, setHint] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recFormatRef = useRef<string>('webm');
  const recStartRef = useRef(0);
  const armedRef = useRef(false);
  const lastVoiceRef = useRef(0);
  const speechStartRef = useRef(0);
  const interruptStartRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playAnalyserRef = useRef<AnalyserNode | null>(null);
  const startedAtRef = useRef(0);
  const sessionMaxRef = useRef(SESSION_MAX_FALLBACK_MS);
  const turnMaxRef = useRef(TURN_MAX_FALLBACK_MS);
  const endedRef = useRef(false);
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
    if (!mutedRef.current && (activePhase() === 'listening' || activePhase() === 'connecting')) {
      setLevels((prev) => {
        const next = prev.slice();
        const scale = Math.min(1, rms * 9);
        for (let i = 0; i < BARS; i++) {
          const wobble = 0.65 + 0.35 * Math.abs(Math.sin((Date.now() / 90 + i * 1.7) % Math.PI));
          next[i] = Math.max(0.08, Math.min(1, scale * wobble));
        }
        return next;
      });
    }

    if (activePhase() === 'listening' && !mutedRef.current) {
      const now = Date.now();
      if (rms > SPEAK_RMS) {
        lastVoiceRef.current = now;
        if (!armedRef.current) {
          if (!speechStartRef.current) speechStartRef.current = now;
          if (now - speechStartRef.current >= MIN_SPEECH_MS) armedRef.current = true;
        }
      } else {
        speechStartRef.current = 0;
      }
      // Turn boundary: sustained speech followed by silence, or turn cap.
      if (armedRef.current && (now - lastVoiceRef.current > SILENCE_MS || now - recStartRef.current > turnMaxRef.current)) {
        armedRef.current = false;
        stopRecorderForTurn();
      }
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

  const startRecorder = () => {
    const stream = streamRef.current;
    if (!stream) return;
    const pick = pickRecorder();
    if (!pick) {
      fail('unsupported', null);
      return;
    }
    recFormatRef.current = pick.format;
    try {
      const rec = new MediaRecorder(stream, { mimeType: pick.mime });
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: pick.mime });
        chunksRef.current = [];
        if (endedRef.current) return;
        if (blob.size > 0) processTurn(blob);
        else if (activePhase() !== 'ended' && activePhase() !== 'error') startRecorder();
      };
      recorderRef.current = rec;
      rec.start(250);
      recStartRef.current = Date.now();
    } catch {
      fail('unsupported', null);
    }
  };

  const stopRecorderForTurn = () => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
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

  const beginListening = () => {
    if (endedRef.current) return;
    setHint(null);
    setPhaseBoth('listening');
    startRecorder();
  };

  const fail = (kind: 'permission' | 'unsupported' | 'generic', detail: string | null) => {
    if (endedRef.current) return;
    cleanupMedia();
    setErrorKind(kind);
    setErrorDetail(detail);
    setPhaseBoth('error');
  };

  // ---- one spoken turn ----
  const processTurn = async (blob: Blob) => {
    if (endedRef.current) return;
    setPhaseBoth('thinking');
    let question = '';
    try {
      const b64 = await blobToBase64(blob);
      const { text } = await voiceTranscribe(courseId, b64, recFormatRef.current);
      question = text.trim();
    } catch (e: any) {
      if (endedRef.current) return;
      if (e instanceof ApiError && (e.status === 503 || e.code === 'AI_NOT_CONFIGURED')) return fail('generic', t.aiNotConfigured);
      if (e instanceof ApiError && e.status === 429) {
        setHint(t.voiceRateLimited);
        return beginListening();
      }
      setHint(t.voiceTranscribeFailed);
      return beginListening();
    }
    if (!question) {
      setHint(t.voiceNoSpeech);
      return beginListening();
    }
    setTranscript((prev) => [...prev, { role: 'user', text: question }]);

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
      if (e?.name === 'AbortError') return; // call ended mid-answer
      failed = true;
      if (!errorDetailRef.current) setErrorDetail(e?.message || t.voiceTryAgain);
    }
    abortRef.current = null;
    if (endedRef.current) return;
    if (failed || !answer.trim()) {
      setHint(t.voiceTryAgain);
      return beginListening();
    }
    setTranscript((prev) => [...prev, { role: 'assistant', text: answer, citations, coverageNotice: covNotice }]);

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
      setPhaseBoth('speaking');
      await audio.play().catch(() => {
        audio.removeEventListener('ended', onEnded);
        URL.revokeObjectURL(url);
        enableTranscriptOnly();
      });
    } catch (e: any) {
      if (endedRef.current) return;
      if (e instanceof ApiError && e.status === 429) setHint(t.voiceRateLimited);
      enableTranscriptOnly();
    }
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
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      try {
        rec.onstop = null;
        rec.stop();
      } catch {}
    }
    recorderRef.current = null;
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
    playAnalyserRef.current = null;
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
        const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
        const ctx = new Ctx();
        await ctx.resume().catch(() => {});
        ctxRef.current = ctx;
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        src.connect(analyser);
        analyserRef.current = analyser;
        // Playback tap for the waveform while the tutor speaks.
        const el = new Audio();
        el.autoplay = true;
        try {
          const playSrc = ctx.createMediaElementSource(el);
          const playAnalyser = ctx.createAnalyser();
          playAnalyser.fftSize = 1024;
          playSrc.connect(playAnalyser);
          playSrc.connect(ctx.destination);
          playAnalyserRef.current = playAnalyser;
        } catch {}
        audioRef.current = el;
        startedAtRef.current = Date.now();
        rafRef.current = requestAnimationFrame(vadLoop);
        beginListening();
      } catch (e: any) {
        if (cancelled) return;
        if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') fail('permission', null);
        else fail('generic', e?.message || null);
      }
    })();
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
    if (next && activePhase() === 'listening') stopRecorderForTurn();
  };

  const mm = String(Math.floor(elapsed / 60000)).padStart(2, '0');
  const ss = String(Math.floor((elapsed % 60000) / 1000)).padStart(2, '0');

  const phaseLabel =
    phase === 'connecting' ? t.voiceConnecting
    : phase === 'listening' ? (muted ? t.voiceMuted : t.voiceListening)
    : phase === 'thinking' ? t.voiceThinking
    : phase === 'speaking' ? t.voiceSpeaking
    : phase === 'ended' ? t.voiceEnded
    : t.voiceErrorState;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-950/95 backdrop-blur-sm" style={{ paddingBottom: 'env(safe-area-inset-bottom)', paddingTop: 'env(safe-area-inset-top)' }}>
      {/* header */}
      <div className="flex items-center justify-between px-5 pt-4 text-white/80">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="relative flex h-2.5 w-2.5">
            {(phase === 'listening' || phase === 'speaking' || phase === 'thinking') && (
              <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${muted ? 'bg-amber-400' : 'bg-emerald-400'} opacity-60`} />
            )}
            <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${muted ? 'bg-amber-400' : 'bg-emerald-400'}`} />
          </span>
          {muted ? t.voiceMutedBadge : t.voiceMicActive}
        </div>
        <span className="font-mono text-sm">{mm}:{ss}</span>
      </div>

      {/* orb / waveform */}
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6">
        <div className={`flex h-32 items-end justify-center gap-1 ${muted ? 'opacity-40' : ''}`} aria-hidden>
          {(phase === 'thinking' ? Array(BARS).fill(0.12) : levels).map((v, i) => (
            <div
              key={i}
              className={`w-1.5 rounded-full transition-[height] duration-75 ${phase === 'speaking' ? 'bg-gradient-to-t from-indigo-500 to-fuchsia-400' : 'bg-gradient-to-t from-emerald-500 to-teal-300'}`}
              style={{ height: `${Math.max(8, v * 112)}px` }}
            />
          ))}
        </div>
        <div className="text-center">
          <p className="text-lg font-semibold text-white">{phaseLabel}</p>
          {hint && <p className="mt-1 max-w-xs text-sm text-white/60">{hint}</p>}
          {phase === 'thinking' && <ThinkingDots className="mt-2 text-indigo-300" />}
        </div>

        {/* transcript */}
        {transcript.length > 0 && (
          <div className="no-scrollbar mt-2 w-full max-w-md flex-1 space-y-3 overflow-y-auto rounded-2xl border border-white/10 bg-white/5 p-4 text-sm">
            {transcript.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'text-white/90' : 'text-white'}>
                <p className={`mb-0.5 text-[11px] font-medium uppercase tracking-wide ${m.role === 'user' ? 'text-white/40' : 'text-indigo-300'}`}>
                  {m.role === 'user' ? t.you : t.voiceTutor}
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
        <div className="mx-5 mb-4 rounded-2xl border border-white/15 bg-white/5 p-4 text-center text-sm text-white/80">
          <p className="font-medium text-white">{t.voiceEnded}</p>
          {hint && <p className="mt-1 text-white/60">{hint}</p>}
          <p className="mt-1 text-white/50">{t.voiceSavedToHistory}</p>
          <Button className="mt-3" onClick={onEnd}>{t.voiceBackToTutor}</Button>
        </div>
      )}

      {/* controls */}
      {(phase === 'listening' || phase === 'thinking' || phase === 'speaking') && (
        <div className="flex items-center justify-center gap-4 px-6 pb-8">
          <button
            onClick={toggleMute}
            aria-label={muted ? t.voiceUnmute : t.voiceMute}
            className={`flex h-14 w-14 items-center justify-center rounded-full border transition-colors ${muted ? 'border-amber-400/60 bg-amber-500/20 text-amber-300' : 'border-white/20 bg-white/10 text-white hover:bg-white/20'}`}
          >
            <Icon name={muted ? 'mic-off' : 'mic'} className="h-6 w-6" />
          </button>
          {phase === 'speaking' && (
            <button
              onClick={interruptPlayback}
              aria-label={t.voiceInterrupt}
              className="flex h-14 flex-1 max-w-[150px] items-center justify-center gap-2 rounded-full border border-indigo-400/40 bg-indigo-500/20 text-sm font-medium text-indigo-200 hover:bg-indigo-500/30"
            >
              <Icon name="zap" className="h-4 w-4" />
              {t.voiceInterrupt}
            </button>
          )}
          <button
            onClick={() => endCall('user')}
            aria-label={t.voiceEndCall}
            className="flex h-14 w-14 items-center justify-center rounded-full bg-red-500 text-white shadow-lg shadow-red-500/30 hover:bg-red-400"
          >
            <Icon name="phone" className="h-6 w-6 rotate-[135deg]" />
          </button>
        </div>
      )}
    </div>
  );
}
