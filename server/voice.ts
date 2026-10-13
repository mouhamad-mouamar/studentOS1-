import { authHeaders, AiNotConfiguredError } from './ai.js';
import { aiConfigured, AI_BASE_URL } from './config.js';

// Voice-call models on the EXISTING OpenRouter account/key (no new provider).
// Defaults verified against OpenRouter's public models API (2026-10):
//  - STT: whisper-large-v3 (strong multilingual/Arabic support, per-token pricing)
//  - TTS: fish-audio/s2.1-pro-free:free (the only $0 speech model at audit time)
// Both are overridable with OPTIONAL env vars (no production config change is
// required or made by this code): VOICE_STT_MODEL, VOICE_TTS_MODEL.
// NOTE: STT is metered (fractions of a cent per turn) — voice usage is NOT free.
export const VOICE_STT_MODEL = process.env.VOICE_STT_MODEL || 'openai/whisper-large-v3';
export const VOICE_TTS_MODEL = process.env.VOICE_TTS_MODEL || 'fish-audio/s2.1-pro-free:free';
// OpenRouter's TTS contract: `voice` may be omitted ONLY when the provider
// documents a default voice. Fish Audio documents no voice list, so whether
// voice-less requests are accepted needs the controlled real-provider test.
// If it is not, set VOICE_TTS_VOICE (optional env; NOT set in production) to
// any provider-supported voice identifier — no code change needed.
const VOICE_TTS_VOICE = process.env.VOICE_TTS_VOICE || '';

// Turn/session bounds (defense against runaway provider usage).
export const MAX_TURN_AUDIO_SECONDS = 30;
export const MAX_SESSION_SECONDS = 600; // 10 minutes

export class VoiceProviderError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function voiceProviderFail(status: number, body: string): VoiceProviderError {
  if (status === 429) return new VoiceProviderError(429, 'Voice is temporarily rate-limited. Please try again shortly.');
  if (status === 504 || status === 502) return new VoiceProviderError(502, 'Voice service timed out. Please try again.');
  return new VoiceProviderError(status >= 500 ? 502 : 400, `Voice request failed (${status}).`);
}

// Speech-to-text via OpenRouter's OpenAI-compatible transcriptions endpoint.
// Audio arrives base64-encoded (raw bytes, NOT a data URI) with its format.
export async function transcribeAudio(data: string, format: string): Promise<string> {
  if (!aiConfigured()) throw new AiNotConfiguredError();
  const allowed = new Set(['wav', 'mp3', 'flac', 'm4a', 'ogg', 'webm', 'aac']);
  if (!allowed.has(format)) throw new VoiceProviderError(400, `Unsupported audio format: ${format}`);
  if (!data || data.length > 30 * 1024 * 1024) throw new VoiceProviderError(400, 'Audio recording is missing or too large.');
  const res = await fetch(`${AI_BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: VOICE_STT_MODEL,
      input_audio: { data, format },
      response_format: 'json',
    }),
  });
  if (!res.ok) throw voiceProviderFail(res.status, await res.text().catch(() => ''));
  const json: any = await res.json().catch(() => null);
  const text = typeof json?.text === 'string' ? json.text.trim() : '';
  // An empty transcript is a usable outcome (silence/noise), not an error.
  return text;
}

// Text-to-speech via OpenRouter's OpenAI-compatible speech endpoint.
// Returns raw mp3 bytes. No voice parameter is sent (no invented IDs): if the
// selected model requires an explicit voice the provider returns 400 and the
// caller degrades to transcript-only mode honestly.
export async function synthesizeSpeech(text: string): Promise<ArrayBuffer> {
  if (!aiConfigured()) throw new AiNotConfiguredError();
  const input = text.trim();
  if (!input) throw new VoiceProviderError(400, 'Nothing to speak.');
  if (input.length > 4000) throw new VoiceProviderError(400, 'Answer too long to synthesize.');
  const res = await fetch(`${AI_BASE_URL}/audio/speech`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: VOICE_TTS_MODEL,
      input,
      ...(VOICE_TTS_VOICE ? { voice: VOICE_TTS_VOICE } : {}),
      response_format: 'mp3',
    }),
  });
  if (!res.ok) throw voiceProviderFail(res.status, await res.text().catch(() => ''));
  const buf = await res.arrayBuffer();
  if (buf.byteLength === 0) throw new VoiceProviderError(502, 'Voice service returned no audio.');
  return buf;
}
