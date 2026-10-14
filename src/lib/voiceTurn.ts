// Pure turn-boundary VAD decision for the voice call, extracted from
// VoiceCall.tsx so the end-of-speech logic is unit-testable without a DOM.
//
// The production failure class this guards against: on iOS Safari an
// AnalyserNode fed by a MediaStreamAudioSourceNode can deliver permanent
// exact-zero frames (WebKit bug 180522 — graph with no output path, or a
// context that never resumed). With a zero-only signal the turn must never
// just hang: the raw MediaRecorder still captures the stream independently of
// the WebAudio graph, so the turn is force-armed and the existing turn cap
// ends it, trading latency for a working conversation.

export interface TurnVadState {
  armed: boolean;
  speechStart: number; // ms timestamp when sustained speech began (0 = none)
  lastVoice: number; // ms timestamp of the last voiced frame
}

export interface TurnVadInput {
  now: number;
  rms: number;
  speakRms: number; // RMS above which a frame counts as voiced
  minSpeechMs: number; // sustained speech required to arm a turn
  silenceMs: number; // trailing silence that ends an armed turn
  turnCapMs: number; // hard cap for one recorded turn
  recStartMs: number; // when the current recording started
  micDead: boolean; // no analyzable mic data so far this listening period
}

export interface TurnVadResult {
  endTurn: boolean;
  state: TurnVadState;
}

// Frames at or below this RMS are treated as digital silence; a listening
// period with ONLY such frames (past the grace window) is a dead mic graph,
// not a quiet user (live mics have a nonzero noise floor).
export const MIC_SILENCE_RMS = 1e-4;

export function vadTurnTick(state: TurnVadState, input: TurnVadInput): TurnVadResult {
  const { now, rms } = input;
  const voiced = rms > input.speakRms;

  if (input.micDead) {
    // Fallback: force-arm and rely on the turn cap. If real audio ever
    // appears, the caller flips micDead off and normal detection resumes.
    state.armed = true;
    state.speechStart = 0;
    state.lastVoice = now;
    return { endTurn: now - input.recStartMs > input.turnCapMs, state };
  }

  if (voiced) {
    state.lastVoice = now;
    if (!state.armed) {
      if (!state.speechStart) state.speechStart = now;
      if (now - state.speechStart >= input.minSpeechMs) state.armed = true;
    }
  } else {
    state.speechStart = 0;
  }

  let endTurn = false;
  if (state.armed && (now - state.lastVoice > input.silenceMs || now - input.recStartMs > input.turnCapMs)) {
    state.armed = false;
    endTurn = true;
  }
  return { endTurn, state };
}
