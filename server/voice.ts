import { authHeaders, AiNotConfiguredError } from './ai.js';
import { aiConfigured, AI_BASE_URL } from './config.js';

// Voice-call models on the EXISTING OpenRouter account/key (no new provider).
//
// IMPORTANT (verified against OpenRouter's public docs and /api/v1/models
// catalog on 2026-10): OpenRouter exposes NO dedicated /audio/transcriptions
// or /audio/speech endpoints, and neither openai/whisper-large-v3 nor any
// fish-audio model exists on the platform. Speech I/O goes through
// /chat/completions:
//  - STT: an audio-INPUT model given { type: 'input_audio' } content.
//         Default google/gemini-2.5-flash — the model OpenRouter's own audio
//         docs use for transcription; strong Arabic support; ~$0.30/1M audio
//         tokens (a 5-second turn costs a fraction of a cent).
//  - TTS: an audio-OUTPUT model with modalities ['text','audio'], streaming
//         REQUIRED, audio delivered as base64 chunks in delta.audio.
//         Default openai/gpt-audio-mini — the only speech-output model on the
//         platform at moderate cost ($0.60/$2.40 per 1M tokens; the $0
//         "audio" models are Lyria music generators, not speech).
//
// EXTERNAL BLOCKER (verified with real production probes 2026-10): OpenRouter
// returns 402 "This request requires at least $0.50 in balance for audio" for
// EVERY audio model, including $0 ones — the provider account balance is
// below the $0.50 audio gate. Text chat is unaffected (no gate on text).
// Until the account is topped up, STT/TTS fail with 402 and voice calls
// degrade honestly to transcript-only errors. Fixing this requires adding
// provider credits — an external billing action, not a code change.
export const VOICE_STT_MODEL = process.env.VOICE_STT_MODEL || 'google/gemini-2.5-flash';
export const VOICE_TTS_MODEL = process.env.VOICE_TTS_MODEL || 'openai/gpt-audio-mini';
// OpenAI-family voices are documented on OpenRouter's audio page (alloy, echo,
// fable, onyx, nova, shimmer — availability varies by model).
const VOICE_TTS_VOICE = process.env.VOICE_TTS_VOICE || 'alloy';

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

// Extract the provider's own error message (config-level text like "model
// not allowed" / "insufficient credits") for honest, sanitized reporting.
function providerMsg(body: string): string {
  try {
    const j = JSON.parse(body);
    const m = j?.error?.message ?? j?.message ?? j?.error;
    if (typeof m === 'string' && m.trim()) return m.trim().slice(0, 160);
  } catch {}
  return '';
}

function voiceProviderFail(status: number, body: string): VoiceProviderError {
  if (status === 429) return new VoiceProviderError(429, 'Voice is temporarily rate-limited. Please try again shortly.');
  const extra = providerMsg(body);
  const suffix = extra ? `: ${extra}` : '.';
  // 402 = the provider plan does not cover this model/request (verified by
  // real production probes on 2026-10, including the $0 STT model). Surfacing
  // the provider's own reason so the boundary is diagnosable.
  if (status === 402) return new VoiceProviderError(402, `Speech is not available on the current provider plan${suffix}`);
  if (status === 504 || status === 502) return new VoiceProviderError(502, 'Voice service timed out. Please try again.');
  return new VoiceProviderError(status >= 500 ? 502 : 400, `Voice request failed (${status})${suffix}`);
}

// Formats OpenRouter documents for input_audio content.
const AUDIO_FORMATS = new Set(['wav', 'mp3', 'aiff', 'aac', 'ogg', 'flac', 'm4a', 'pcm16', 'pcm24']);

// Speech-to-text through OpenRouter's chat-completions audio-input contract:
// a user message containing a transcription instruction plus an input_audio
// part. Audio arrives base64-encoded (raw bytes, NOT a data URI) with format.
export async function transcribeAudio(data: string, format: string): Promise<string> {
  if (!aiConfigured()) throw new AiNotConfiguredError();
  if (!AUDIO_FORMATS.has(format)) throw new VoiceProviderError(400, `Unsupported audio format: ${format}`);
  if (!data || data.length > 30 * 1024 * 1024) throw new VoiceProviderError(400, 'Audio recording is missing or too large.');
  const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: VOICE_STT_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'Transcribe the attached audio recording verbatim in its original language. ' +
                'Output ONLY the transcription text — no preamble, no quotes, no commentary. ' +
                'If the recording contains no speech, output an empty string.',
            },
            { type: 'input_audio', input_audio: { data, format } },
          ],
        },
      ],
      stream: false,
    }),
  });
  if (!res.ok) throw voiceProviderFail(res.status, await res.text().catch(() => ''));
  const json: any = await res.json().catch(() => null);
  const raw = json?.choices?.[0]?.message?.content;
  const text = typeof raw === 'string' ? raw.trim() : '';
  // Strip wrapping quotes some chat models add around transcriptions.
  const cleaned = text.replace(/^["'\u201c\u2018]+|["'\u201d\u2019]+$/g, '').trim();
  // An empty transcript is a usable outcome (silence/noise), not an error.
  return cleaned;
}

// Text-to-speech through OpenRouter's chat-completions audio-output contract.
// Audio output REQUIRES streaming: base64 chunks arrive in delta.audio and are
// assembled here; the server returns raw WAV bytes to the client.
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  if (!aiConfigured()) throw new AiNotConfiguredError();
  const input = text.trim();
  if (!input) throw new VoiceProviderError(400, 'Nothing to speak.');
  if (input.length > 4000) throw new VoiceProviderError(400, 'Answer too long to synthesize.');
  const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: VOICE_TTS_MODEL,
      modalities: ['text', 'audio'],
      audio: { voice: VOICE_TTS_VOICE, format: 'wav' },
      stream: true,
      messages: [
        {
          role: 'system',
          content: 'You are a text-to-speech engine. Read the user message verbatim, naturally and clearly. Do not add any words of your own.',
        },
        { role: 'user', content: input },
      ],
    }),
  });
  if (!res.ok) throw voiceProviderFail(res.status, await res.text().catch(() => ''));
  if (!res.body) throw new VoiceProviderError(502, 'Voice service returned no audio stream.');

  // Parse the SSE stream and assemble the base64 audio payload.
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = '';
  let b64 = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === '[DONE]') continue;
      let chunk: any;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (chunk?.error) {
        const msg = typeof chunk.error.message === 'string' ? chunk.error.message : 'stream error';
        throw new VoiceProviderError(502, `Voice service error: ${msg.slice(0, 120)}`);
      }
      const audio = chunk?.choices?.[0]?.delta?.audio;
      if (audio?.data) b64 += audio.data;
    }
  }
  if (!b64) throw new VoiceProviderError(502, 'Voice service returned no audio.');
  const buf = Buffer.from(b64, 'base64');
  if (buf.byteLength === 0) throw new VoiceProviderError(502, 'Voice service returned no audio.');
  return buf;
}
