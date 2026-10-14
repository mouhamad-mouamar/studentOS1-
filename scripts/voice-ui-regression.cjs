/*
 * Voice Call UI regression tests — LOCAL/MOCK only.
 *
 * Covers the production failure "stuck on Listening…, AI never responds,
 * history never saved":
 *  A. vadTurnTick behavior (src/lib/voiceTurn.ts) — end-of-speech boundary,
 *     blip rejection, turn cap, and the dead-mic-graph fallback (iOS Safari
 *     can deliver permanent zero frames from an analyser-only mic graph).
 *  B. Static wiring — gesture-created AudioContext (TutorTab -> VoiceCall),
 *     zero-gain destination bridge, opaque overlay (no backdrop-filter),
 *     failure hints survive beginListening, honest "saved" claim, crash
 *     boundary, no dead playback tap.
 *  C. i18n — new voice keys present in en + ar.
 * No server, provider, or browser is needed. Run: node scripts/voice-ui-regression.cjs
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
const OUT = path.join(process.env.TEMP || '/tmp', 'voice-turn-test-' + Date.now() + '.mjs');
execSync(`npx esbuild src/lib/voiceTurn.ts --bundle --format=esm --outfile="${OUT}"`, { cwd: ROOT, stdio: 'pipe' });
const { vadTurnTick, MIC_SILENCE_RMS } = await import('file:///' + OUT.replace(/\\/g, '/'));

const base = { speakRms: 0.045, minSpeechMs: 250, silenceMs: 1200, turnCapMs: 30000, recStartMs: 1000 };
const st = () => ({ armed: false, speechStart: 0, lastVoice: 0 });

// A1. Sustained speech (>= minSpeechMs) then silence ends the turn.
{
  const s = st();
  let r = vadTurnTick(s, { ...base, now: 1100, rms: 0.2, micDead: false });
  ok('speak: blip below minSpeechMs does not arm', !r.state.armed && !r.endTurn);
  r = vadTurnTick(s, { ...base, now: 1400, rms: 0.2, micDead: false });
  ok('speak: sustained speech arms the turn', r.state.armed && !r.endTurn);
  r = vadTurnTick(s, { ...base, now: 2000, rms: 0.2, micDead: false });
  ok('speak: voice keeps turn open', !r.endTurn);
  r = vadTurnTick(s, { ...base, now: 3300, rms: 0.0, micDead: false });
  ok('speak: 1200ms trailing silence ends the turn', r.endTurn && !r.state.armed, JSON.stringify(r.state));
}

// A2. Silence before arming never ends the turn (no false stops while quiet).
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

// A5. Dead mic recovers: a real signal flips back to normal detection.
{
  const s = st();
  vadTurnTick(s, { ...base, now: 5000, rms: 0, micDead: true });
  const r = vadTurnTick(s, { ...base, now: 5100, rms: 0.2, micDead: false });
  ok('dead mic: live signal resumes normal detection (armed still set)', r.state.armed && !r.endTurn);
  const r2 = vadTurnTick(s, { ...base, now: 6400, rms: 0.0, micDead: false });
  ok('dead mic: recovered graph ends turns by silence again', r2.endTurn);
}

// A6. MIC_SILENCE_RMS is effectively zero but strict (noise floor passes).
ok('silence threshold: 1e-4, below any real noise floor', MIC_SILENCE_RMS === 1e-4);
ok('silence threshold: noise floor counts as signal', 0.001 > MIC_SILENCE_RMS);

// ---- B. static wiring ----
const call = fs.readFileSync(path.join(ROOT, 'src/components/course/VoiceCall.tsx'), 'utf8');
const tab = fs.readFileSync(path.join(ROOT, 'src/components/course/TutorTab.tsx'), 'utf8');

// B1. Opaque call overlay — no backdrop-filter (iOS compositing / white page).
ok('overlay: opaque bg-slate-950', /className="fixed inset-0 z-50 flex flex-col bg-slate-950"/.test(call));
ok('overlay: no backdrop-blur anywhere in the call screen', !call.includes('backdrop-blur'));

// B2. Mic graph bridges to destination through a zero-gain node.
ok('audio: zero-gain destination bridge present', call.includes('silentGain.gain.value = 0') && call.includes('silentGain.connect(ctx.destination)'));
ok('audio: mic source also feeds the analyser', call.includes('src.connect(analyser)'));

// B3. Gesture-created AudioContext threaded from the tutor tab.
ok('tutor: AudioContext created + resumed inside click handler', tab.includes('const startVoiceCall') && /startVoiceCall[\s\S]*new Ctx\(\)[\s\S]*ctx\.resume\(\)/.test(tab) && tab.includes('onClick={startVoiceCall}'));
ok('tutor: context passed to VoiceCall', tab.includes('audioCtx={voiceCtxRef.current}'));
ok('call: prefers the gesture context when provided', call.includes('audioCtx && audioCtx.state !=='));
ok('call: still resumes on visibilitychange (iOS backgrounding)', call.includes("addEventListener('visibilitychange', onVisible)"));

// B4. Dead-graph fallback wired into the VAD loop.
ok('vad: extracted vadTurnTick used', call.includes('vadTurnTick('));
ok('vad: dead-graph grace + hint wired', call.includes('MIC_DEAD_AFTER_MS') && call.includes('t.voiceMicSignal'));

// B5. Failure hints survive the return to listening.
ok('hint: beginListening accepts a keepHint', call.includes('const beginListening = (keepHint?: string | null)'));
ok('hint: transcribe failure keeps its message', call.includes('beginListening(t.voiceTranscribeFailed)'));
ok('hint: no-speech keeps its message', call.includes('beginListening(t.voiceNoSpeech)'));
ok('hint: tutor failure keeps its message', call.includes('beginListening(t.voiceTryAgain)'));
ok('hint: rate limit keeps its message', call.includes('beginListening(t.voiceRateLimited)'));
ok('hint: no old wipe-then-set pattern (setHint before beginListening)', !/setHint\(t\.voiceTranscribeFailed\);\s*\n\s*return beginListening\(\)/.test(call));

// B6. Honest ended screen: "saved to history" only when a transcript exists.
{
  const ended = call.slice(call.indexOf("phase === 'ended'"), call.indexOf('{/* controls */}'));
  ok('ended: saved claim gated on transcript.length > 0', ended.includes('transcript.length > 0 &&') && ended.includes('t.voiceSavedToHistory'));
}

// B7. Render-crash containment instead of a white page.
ok('boundary: error boundary wraps the call', call.includes('class VoiceCallBoundary') && call.includes('getDerivedStateFromError') && call.includes('<VoiceCallCrash onEnd={this.props.onEnd} />'));
ok('boundary: VoiceCall export wraps the session', /export function VoiceCall\([\s\S]*VoiceCallBoundary[\s\S]*VoiceCallSession/.test(call));

// B8. Dead playback tap removed (playAnalyser was never read; routing TTS
// through WebAudio risks silent playback on iOS).
ok('audio: no createMediaElementSource left', !call.includes('createMediaElementSource'));
ok('audio: plain Audio element for TTS playback', call.includes('audioRef.current = new Audio()'));

// B9. Core pipeline untouched: same contracts to the server.
ok('pipeline: streamTutor still called with { question }', call.includes('streamTutor(') && call.includes('{ question },'));
ok('pipeline: transcribe + speak calls intact', call.includes('voiceTranscribe(courseId') && call.includes('voiceSpeak(courseId'));

// ---- C. i18n ----
const i18n = fs.readFileSync(path.join(ROOT, 'src/lib/i18n.tsx'), 'utf8');
for (const k of ['voiceMicSignal', 'voiceCrashed']) {
  const n = (i18n.match(new RegExp('\\b' + k + ':', 'g')) || []).length;
  ok('i18n: ' + k + ' in en+ar', n === 2, 'count=' + n);
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);

})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
