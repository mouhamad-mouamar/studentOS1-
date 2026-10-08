import type { SupabaseClient } from '@supabase/supabase-js';

export function detectKind(filename: string, mime?: string | null): string {
  const ext = filename.toLowerCase().split('.').pop() || '';
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (ext === 'pptx' || ext === 'ppt') return 'pptx';
  if (ext === 'docx' || ext === 'doc') return 'docx';
  if (ext === 'txt' || ext === 'md' || ext === 'csv' || mime?.startsWith('text/')) return 'text';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext) || mime?.startsWith('image/')) return 'image';
  if (['mp3', 'wav', 'm4a', 'ogg', 'aac'].includes(ext) || mime?.startsWith('audio/')) return 'audio';
  if (['mp4', 'mkv', 'mov', 'webm'].includes(ext) || mime?.startsWith('video/')) return 'video';
  return 'other';
}

export function chunkText(text: string, target = 1600, overlap = 200): string[] {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + target, clean.length);
    if (end < clean.length) {
      // Prefer breaking at a paragraph or sentence boundary.
      const slice = clean.slice(start, end);
      const brk = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('. '));
      if (brk > target * 0.5) end = start + brk + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

export async function extractText(kind: string, buf: Buffer): Promise<{ text: string; note?: string }> {
  if (kind === 'pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try {
      const data = await parser.getText();
      // Per-page extraction when the parser provides it → [Page n] markers that
      // ingest.ts parses into chunks.page_number. Falls back to plain text.
      if (Array.isArray(data.pages) && data.pages.length > 0) {
        const parts: string[] = [];
        for (const p of data.pages) {
          const text = (p.text || '').trim();
          if (text) parts.push(`[Page ${p.num}] ${text}`);
        }
        if (parts.length > 0) return { text: parts.join('\n\n') };
      }
      return { text: data.text || '' };
    } finally {
      await parser.destroy().catch(() => {});
    }
  }
  if (kind === 'docx') {
    const mammoth = await import('mammoth');
    const data = await mammoth.extractRawText({ buffer: buf });
    return { text: data.value || '' };
  }
  if (kind === 'pptx') {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buf);
    const slideFiles = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => {
        const na = parseInt(a.match(/slide(\d+)/)![1], 10);
        const nb = parseInt(b.match(/slide(\d+)/)![1], 10);
        return na - nb;
      });
    const parts: string[] = [];
    for (let i = 0; i < slideFiles.length; i++) {
      const xml = await zip.files[slideFiles[i]].async('string');
      const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(' ');
      if (texts.trim()) parts.push(`[Slide ${i + 1}] ${texts.trim()}`);
    }
    return { text: parts.join('\n\n') };
  }
  if (kind === 'text') {
    return { text: buf.toString('utf8') };
  }
  return {
    text: '',
    note:
      kind === 'image'
        ? 'UNSUPPORTED_NO_VISION'
        : kind === 'audio' || kind === 'video'
          ? 'UNSUPPORTED_NO_TRANSCRIPTION'
          : 'UNSUPPORTED_FORMAT',
  };
}

// Deterministic professor-emphasis scan. Works without any AI provider.
const EMPHASIS_PATTERNS = [
  /this (is|will be) (very )?important/i,
  /(will|going to) be on the exam/i,
  /remember (this|that)/i,
  /you (need|have) to know/i,
  /pay (close )?attention/i,
  /don'?t forget/i,
  /common (mistake|error)/i,
  /exam hint/i,
  /take note/i,
  /key (concept|point|idea|term)/i,
  /(very|highly) likely/i,
  /must know/i,
];

export function findEmphasis(text: string): { phrase: string; sentence: string }[] {
  const found: { phrase: string; sentence: string }[] = [];
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  for (const s of sentences) {
    if (s.length < 8 || s.length > 400) continue;
    for (const p of EMPHASIS_PATTERNS) {
      if (p.test(s)) {
        found.push({ phrase: p.source, sentence: s.trim() });
        break;
      }
    }
  }
  return found;
}

export async function downloadMaterial(
  client: SupabaseClient,
  storagePath: string,
): Promise<Buffer> {
  const { data, error } = await client.storage.from('materials').download(storagePath);
  if (error) throw new Error(`Storage download failed: ${error.message}`);
  const arr = await data.arrayBuffer();
  return Buffer.from(arr);
}
