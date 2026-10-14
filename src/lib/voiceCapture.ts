// Turn audio capture for the voice call: records raw microphone PCM via a
// ScriptProcessorNode and encodes 16-bit WAV on stop.
//
// Why not MediaRecorder: its output codec is browser-dependent (webm/opus on
// desktop Chrome, fragmented mp4 on iOS) and OpenRouter's input_audio contract
// documents only wav/mp3/aiff/aac/ogg/flac/m4a/pcm16/pcm24 — webm is NOT
// officially accepted. Capturing PCM directly produces identical, officially
// supported `wav` bytes on every browser and removes all codec uncertainty.

export interface TurnRecording {
  blob: Blob;
  base64: string;
  format: 'wav';
  seconds: number;
}

// Encode interleaved mono Float32 frames as a 16-bit PCM WAV ArrayBuffer.
// Pure and unit-testable: RIFF header + fmt + data chunks, little-endian.
export function encodeWav(chunks: Float32Array[], sampleRate: number): ArrayBuffer {
  const totalFrames = chunks.reduce((n, c) => n + c.length, 0);
  const dataSize = totalFrames * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      let s = chunk[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return buf;
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as unknown as number[]);
  }
  return btoa(bin);
}

// Records exactly one turn. `stop()` resolves with the WAV recording (or null
// if nothing was captured). The node stays connected for the whole call; only
// `recording` gates whether frames are kept, so turn start/stop has zero graph
// churn (iOS-friendly).
export class TurnCapture {
  private chunks: Float32Array[] = [];
  private frames = 0;
  recording = false;
  startedAt = 0;

  constructor(
    private ctx: AudioContext,
    private source: AudioNode,
    private sink: AudioNode, // zero-gain destination bridge (keeps the graph rendering)
  ) {
    const node = this.ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => {
      if (!this.recording) return;
      const input = e.inputBuffer.getChannelData(0);
      this.chunks.push(new Float32Array(input));
      this.frames += input.length;
    };
    this.node = node;
    source.connect(node);
    node.connect(sink);
  }

  node: ScriptProcessorNode;

  start(): void {
    this.chunks = [];
    this.frames = 0;
    this.startedAt = Date.now();
    this.recording = true;
  }

  stop(): TurnRecording | null {
    this.recording = false;
    if (!this.frames) return null;
    const buf = encodeWav(this.chunks, this.ctx.sampleRate);
    this.chunks = [];
    return {
      blob: new Blob([buf], { type: 'audio/wav' }),
      base64: arrayBufferToBase64(buf),
      format: 'wav',
      seconds: this.frames / this.ctx.sampleRate,
    };
  }

  dispose(): void {
    try {
      this.node.disconnect();
      this.source.disconnect(this.node);
    } catch {}
  }
}
