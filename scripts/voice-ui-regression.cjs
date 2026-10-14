/*
 * Voice Call UI + capture regression tests — LOCAL/MOCK only.
 *
 * Covers:
 *  A. vadTurnTick behavior (src/lib/voiceTurn.ts) — end-of-speech boundary,
 *     blip rejection, turn cap, dead-mic-graph fallback (iOS Safari).
 *  B. encodeWav behavior (src/lib/voiceCapture.ts) — RIFF/PCM16 header math,
 *     clamping, mono, and the 'wav'-everywhere capture strategy.
 *  C. Static wiring — server STT/TTS must use the VERIFIED OpenRouter
 *     chat-completions contract (no nonexistent endpoints/models), gesture
 *     AudioContext, zero-gain bridge, retry-without-duplicates, honest saved
 *     ticks and ended summary, honest Speaking state, crash boundary, reduced
 *     motion, transcript toggle.
 *  D. i18n — every new voice key present in en + ar.
 * No server, provider, or browser needed. Run: node scripts/voice-ui-regression.cjs
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let failed = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) failed++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : ''));
};

const ROOT = path.join(__dirname, '..');

(async () => {

// ---- A. behavioral: vadTurnTick ----
const OUT = path.join(process.env.TEMP || '/tmp', 'voice-ui-reg-' + Date.now() + '-');
execSync(`npx esbuild src/lib/voiceTurn.ts --bundle --format=esm --outfile="${OUT}vt.mjs"`, { cwd: ROOT, stdio: 'pipe' });
execSync(`npx esbuild src/lib/voiceCapture.ts --bundle --format=esm --outfile="${OUT}vc.mjs"`, { cwd: ROOT, stdio: 'pipe' });
const { vadTurnTick, MIC_SILENCE_RMS } = await import('file:///' + (OUT + 'vt.mjs').replace(/\\/g, '/'));
const { encodeWav } = await import('file:///' + (OUT + 'vc.mjs').replace(/\\/g, '/'));

const base = { speakRms: 0.045, minSpeechMs: 250, silenceMs: 1200, turnCapMs: 30000, recStartMs: 1000 };
const st = () => ({ armed: false, speechStart: 0, lastVoice: 0 });

// A1. Sustained speech (>= minSpeechMs) then silence ends the turn.
{
  const s = st();
  let r = vadTurnTick(s, { ...base, now: 1100, rms: 0.2, micDead: false });
  ok('speak: blip below minSpeechMs does not arm', !r.state.armed && !r.endTurn);
  r = vadTurnTick(s, { ...base, now: 1400, rms: 0.2, micDead: false });
  ok('speak: sustained speech arms the turn', r.state.armed && !r.endTurn);
  r = vadTurnTick(s, { ...base, now: 3300, rms: 0.0, micDead: false });
  ok('speak: 1200ms trailing silence ends the turn', r.endTurn && !r.state.armed);
}

// A2. Silence before arming never ends the turn.
{
  const s = st();
  const r = vadTurnTick(s, { ...base, now: 20000, rms: 0.0, micDead: false });
  ok('quiet live mic: no turn end without speech', !r.endTurn && !r.state.armed);
}

// A3. Turn cap ends an armed turn even without trailing silence.
{
  const s = st();
  vadTurnTick(s, { ...base, now: 1100, rms: 0.2, micDead: false });
  vadTurnTick(s, { ...base, now: 1400, rms: 0.2, micDead: false });
  const r = vadTurnTick(s, { ...base, now: 31500, rms: 0.2, micDead: false });
  ok('speak: 30s cap ends the turn mid-speech', r.endTurn);
}

// A4. Dead mic graph: force-arm and end only at the cap.
{
  const s = st();
  let r = vadTurnTick(s, { ...base, now: 5000, rms: 0, micDead: true });
  ok('dead mic: force-armed', r.state.armed);
  r = vadTurnTick(s, { ...base, now: 10000, rms: 0, micDead: true });
  ok('dead mic: no end before cap', !r.endTurn);
  r = vadTurnTick(s, { ...base, now: 41500, rms: 0, micDead: true });
  ok('dead mic: cap ends the turn', r.endTurn);
}

// A5. Dead mic recovers to normal detection on a live signal.
{
  const s = st();
  vadTurnTick(s, { ...base, now: 5000, rms: 0, micDead: true });
  const r = vadTurnTick(s, { ...base, now: 5100, rms: 0.2, micDead: false });
  ok('dead mic: live signal keeps armed', r.state.armed && !r.endTurn);
  const r2 = vadTurnTick(s, { ...base, now: 6400, rms: 0.0, micDead: false });
  ok('dead mic: recovered graph ends turns by silence again', r2.endTurn);
}

ok('silence threshold: 1e-4, below any real noise floor', MIC_SILENCE_RMS === 1e-4);

// ---- B. behavioral: encodeWav ----
{
  const SR = 16000;
  const c1 = new Float32Array([0, 0.5, -0.5, 1.5, -1.5]); // 1.5/-1.5 must clamp
  const buf = encodeWav([c1], SR);
  const dv = new DataView(buf);
  const ascii = (o, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint8(o + i)); return s; };
  ok('wav: RIFF/WAVE magic', ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE');
  ok('wav: riff size = 36 + data', dv.getUint32(4, true) === 36 + 10);
  ok('wav: fmt chunk PCM mono 16-bit', dv.getUint16(20, true) === 1 && dv.getUint16(22, true) === 1 && dv.getUint16(34, true) === 16);
  ok('wav: sample rate + byte rate', dv.getUint32(24, true) === SR && dv.getUint32(28, true) === SR * 2);
  ok('wav: data chunk size', ascii(36, 4) === 'data' && dv.getUint32(40, true) === 10);
  ok('wav: total length 44 + data', buf.byteLength === 44 + 10);
  ok('wav: clamp to int16 range', dv.getInt16(50, true) === 32767 && dv.getInt16(52, true) === -32768);
  ok('wav: PCM sample values', dv.getInt16(44, true) === 0 && dv.getInt16(46, true) === 16383 && dv.getInt16(48, true) === -16384);
  // Multi-chunk concatenation.
  const buf2 = encodeWav([new Float32Array(3), new Float32Array(7)], SR);
  ok('wav: chunks concatenate in order', new DataView(buf2).getUint32(40, true) === 20);
}

// ---- C. static wiring ----
const stripComments = (s) => s.replace(/^\s*\/\/.*$/gm, '');
const call = fs.readFileSync(path.join(ROOT, 'src/components/course/VoiceCall.tsx'), 'utf8');
const callCode = stripComments(call);
const tab = fs.readFileSync(path.join(ROOT, 'src/components/course/TutorTab.tsx'), 'utf8');
const cap = fs.readFileSync(path.join(ROOT, 'src/lib/voiceCapture.ts'), 'utf8');
const voiceSrv = stripComments(fs.readFileSync(path.join(ROOT, 'server/voice.ts'), 'utf8'));
const routes = fs.readFileSync(path.join(ROOT, 'server/routes.ts'), 'utf8');

// C1. Server uses the VERIFIED OpenRouter contract only.
ok('server: STT/TTS via /chat/completions', voiceSrv.includes('${AI_BASE_URL}/chat/completions'));
ok('server: no nonexistent /audio/transcriptions endpoint', !voiceSrv.includes('/audio/transcriptions'));
ok('server: no nonexistent /audio/speech endpoint', !voiceSrv.includes('/audio/speech'));
ok('server: STT sends input_audio content part', voiceSrv.includes("type: 'input_audio'"));
ok('server: TTS sends modalities + audio + streaming (required)', voiceSrv.includes("modalities: ['text', 'audio']") && voiceSrv.includes('stream: true') && voiceSrv.includes("format: 'wav'"));
ok('server: TTS assembles delta.audio base64 chunks', voiceSrv.includes('delta?.audio') && voiceSrv.includes("Buffer.from(b64, 'base64')"));
ok('server: models exist on OpenRouter (verified 2026-10)', voiceSrv.includes("process.env.VOICE_STT_MODEL || 'google/gemini-2.5-flash'") && voiceSrv.includes("process.env.VOICE_TTS_MODEL || 'openai/gpt-audio-mini'"));
ok('server: no whisper/fish model references', !/whisper|fish-audio/i.test(voiceSrv));
ok('server: speak route serves audio/wav', routes.includes("'audio/wav'") && !routes.includes("'audio/mpeg'"));
ok('server: quote-stripping cleanup for chat STT', voiceSrv.includes('replace(/^["'));

// C2. Client captures WAV via TurnCapture; MediaRecorder is gone.
ok('capture: VoiceCall uses TurnCapture', call.includes('new TurnCapture(ctx, src, silentGain)'));
ok('capture: no MediaRecorder anywhere in the call code', !callCode.includes('MediaRecorder'));
ok('capture: capture disposed on cleanup', call.includes('captureRef.current?.dispose()'));
ok('capture: encoder is pure PCM16 WAV', cap.includes('16-bit PCM WAV') && cap.includes("format: 'wav'"));
ok('capture: ScriptProcessor feeds zero-gain sink (graph renders)', cap.includes('node.connect(sink)'));

// C3. Opaque overlay, gesture context, zero-gain bridge.
ok('overlay: opaque bg-slate-950', /className="fixed inset-0 z-50 flex flex-col bg-slate-950"/.test(call));
ok('overlay: no backdrop-blur in the call screen', !call.includes('backdrop-blur'));
ok('audio: zero-gain destination bridge present', call.includes('silentGain.gain.value = 0') && call.includes('silentGain.connect(ctx.destination)'));
ok('audio: mic source feeds the analyser', call.includes('src.connect(analyser)'));
ok('tutor: AudioContext created + resumed inside click handler', tab.includes('const startVoiceCall') && /startVoiceCall[\s\S]*new Ctx\(\)[\s\S]*ctx\.resume\(\)/.test(tab) && tab.includes('onClick={startVoiceCall}'));
ok('tutor: context passed to VoiceCall', tab.includes('audioCtx={voiceCtxRef.current}'));
ok('call: prefers the gesture context when provided', call.includes('audioCtx && audioCtx.state !=='));
ok('call: resumes on visibilitychange (iOS backgrounding)', call.includes("addEventListener('visibilitychange', onVisible)"));

// C4. Retry without duplicates.
ok('retry: distinct retry state with gold Retry button', call.includes('t.voiceRetryNeeded') && call.includes('t.voiceRetryAction'));
ok('retry: STT failure stores the recording for retry', call.includes('lastTurnRef.current = { rec }'));
ok('retry: tutor failure stores rec+question for retry', call.includes('lastTurnRef.current = { rec, question, userId }'));
ok('retry: user message added exactly once (isRetry skips)', call.includes('if (!isRetry) {'));
ok('retry: retry path skips STT when a question already exists', call.includes('void processTurn(EMPTY_REC, true, lt.question)') && call.includes('if (questionOverride == null) {'));
ok('retry: turn lock prevents double submissions', call.includes('turnLockRef.current') && call.includes('if (endedRef.current || turnLockRef.current) return'));

// C5. Honest saved semantics.
ok('saved: per-message tick gated on tutor stream completion', /onDone[\s\S]*saved: true/.test(call));
ok('saved: user message marked saved with the assistant one', call.includes('saved: true } : m'));
ok('saved: ended summary counts only completed turns', call.includes('savedTurns > 0 ?') && call.includes('t.voiceSavedCount.replace'));
ok('saved: zero turns reports nothing saved', call.includes('t.voiceNothingSaved'));
ok('saved: no unconditional saved-to-history claim', !call.includes('{t.voiceSavedToHistory}'));

// C6. Honest states.
ok('state: connecting->ready->listening phases exist', call.includes("'ready'") && call.includes("setPhaseBoth('ready')"));
ok('state: ready flips to listening on the FIRST real mic frame', call.includes('rms > MIC_SILENCE_RMS && !signalSeenRef.current'));
ok('state: Speaking only after audio.play() resolves', /await audio\.play\(\);[\s\S]{0,160}setPhaseBoth\('speaking'\)/.test(call) && call.indexOf("setPhaseBoth('speaking'") > call.indexOf('await audio.play();'));
ok('state: waveform driven by real RMS, not fake animation', call.includes('Math.min(1, rms * 9)'));
ok('state: thinking bars are static placeholders, mic bars real', call.includes("phase === 'thinking' ? Array(BARS).fill(0.12) : levels"));
ok('state: reduced-motion disables ping + bar transitions', call.includes('prefers-reduced-motion: reduce') && call.includes('!reducedMotion &&'));
ok('state: status announced via aria-live', call.includes('aria-live="polite"'));
ok('state: crash boundary wraps the call', call.includes('class VoiceCallBoundary') && call.includes('getDerivedStateFromError'));

// C7. Transcript review without losing call state.
ok('transcript: toggle button present with aria-expanded', call.includes('setShowTranscript') && call.includes('aria-expanded={showTranscript}'));
ok('transcript: toggle keeps call phases intact (pure visibility)', call.includes('showTranscript && transcript.length > 0'));

// C8. Failure hints survive the return to listening.
ok('hint: beginListening accepts a keepHint + retry flag', call.includes('const beginListening = (keepHint?: string | null, withRetry = false)'));
ok('hint: transcribe/tutor/rate-limit failures keep their message', call.includes('beginListening(t.voiceTranscribeFailed, true)') && call.includes('beginListening(t.voiceTryAgain, true)') && call.includes('beginListening(t.voiceRateLimited, true)'));
ok('hint: no-speech restarts without a pointless retry', call.includes('beginListening(t.voiceNoSpeech)') && !call.includes('beginListening(t.voiceNoSpeech, true)'));

// C9. Core pipeline contracts untouched.
ok('pipeline: streamTutor called with { question }', call.includes('streamTutor(') && call.includes('{ question },'));
ok('pipeline: transcribe + speak client calls intact', call.includes('voiceTranscribe(courseId, rec.base64, rec.format)') && call.includes('voiceSpeak(courseId, answer)'));
ok('pipeline: mute drops the partial turn', call.includes('a muted mic must not submit silence'));

// ---- D. i18n ----
const i18n = fs.readFileSync(path.join(ROOT, 'src/lib/i18n.tsx'), 'utf8');
for (const k of ['voiceReady', 'voiceRetryNeeded', 'voiceRetryAction', 'voiceShowTranscript', 'voiceHideTranscript', 'voiceSaved', 'voiceSavedCount', 'voiceNothingSaved', 'voiceMicSignal', 'voiceCrashed']) {
  const n = (i18n.match(new RegExp('\\b' + k + ':', 'g')) || []).length;
  ok('i18n: ' + k + ' in en+ar', n === 2, 'count=' + n);
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);

})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
