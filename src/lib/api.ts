import { supabase } from './supabase';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message?: string) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

// Friendly, non-technical fallbacks for AI/provider failures. Server-provided
// messages (already user-safe) always win; these only fill gaps.
function friendlyAiFallback(status: number, code: string): string | null {
  if (status === 429) return 'AI is temporarily rate-limited. Please try again shortly.';
  if (status === 503) return 'AI is currently unavailable. Please try again.';
  if (status === 504) return 'The AI took too long to respond. Please try again.';
  if (status === 502 && code !== 'REQUEST_FAILED') return 'AI could not complete this request. Please try again.';
  return null;
}

async function authHeader(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError(401, 'UNAUTHENTICATED');
  return `Bearer ${token}`;
}

export async function api<T = any>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  headers.Authorization = await authHeader();
  const res = await fetch(`/api${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body != null ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = data.error || 'REQUEST_FAILED';
    throw new ApiError(res.status, code, data.message || friendlyAiFallback(res.status, code) || undefined);
  }
  return data as T;
}

// Must match the backend/storage reality: the storage proxy rejects bodies
// above ~19 MB with an opaque 500, so pre-check client-side with a clear message.
export const MAX_UPLOAD_MB = 18;

// Upload a file into the private `materials` storage bucket under the user's own prefix.
export async function uploadMaterialFile(
  userId: string,
  courseId: string,
  file: File,
): Promise<string> {
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
    throw new ApiError(400, 'FILE_TOO_LARGE', `This file is too large. Maximum upload size is ${MAX_UPLOAD_MB} MB.`);
  }
  const path = `${userId}/${courseId}/${crypto.randomUUID()}-${file.name}`;
  const { error } = await supabase.storage.from('materials').upload(path, file, {
    cacheControl: '3600',
    upsert: false,
  });
  if (error) {
    // Storage failures surface as opaque provider text (e.g. "Server error",
    // "Internal Server Error") — replace with something actionable. The safe
    // HTTP error codes we may have caused ourselves are kept as-is.
    const raw = error.message || '';
    const known =
      raw.includes('exceeded') || raw.toLowerCase().includes('size')
        ? `This file is too large. Maximum upload size is ${MAX_UPLOAD_MB} MB.`
        : 'Upload failed. Please check your connection and try again.';
    throw new ApiError(400, 'UPLOAD_FAILED', known);
  }
  return path;
}

// Server-Sent Events client for the AI Tutor. Event contract (matches the
// server): meta {citations, coverage, coverageNotice} → delta {t} … → done |
// error {status, message, partial}. Pre-stream HTTP failures (401/404/429
// rate limit before any SSE) surface as ApiError like every other call, so
// the caller's existing error handling works unchanged. Only safe,
// server-authored messages are ever surfaced — raw protocol frames are never
// shown as answer text.
export async function streamTutor(
  courseId: string,
  body: { question: string; mode?: string; materialIds?: string[] },
  handlers: {
    onMeta?: (meta: { citations: any[]; coverage?: any; coverageNotice?: string | null }) => void;
    onDelta: (chunk: string) => void;
    onDone: (meta: { citations: any[]; coverage?: any; coverageNotice?: string | null }) => void;
    onError: (err: { status: number; message: string; partial: boolean }) => void;
  },
  signal?: AbortSignal,
): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  headers.Authorization = await authHeader();
  const res = await fetch(`/api/courses/${courseId}/tutor?stream=1`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const code = data.error || 'REQUEST_FAILED';
    throw new ApiError(res.status, code, data.message || friendlyAiFallback(res.status, code) || undefined);
  }
  if (!res.body) {
    handlers.onError({ status: 502, message: 'AI could not complete this request. Please try again.', partial: false });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let errored = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(dataLines.join('\n'));
      } catch {
        continue;
      }
      if (event === 'meta') handlers.onMeta?.(parsed);
      else if (event === 'delta' && typeof parsed.t === 'string') handlers.onDelta(parsed.t);
      else if (event === 'done') {
        handlers.onDone(parsed);
        return;
      } else if (event === 'error') {
        errored = true;
        handlers.onError({
          status: typeof parsed.status === 'number' ? parsed.status : 502,
          message: typeof parsed.message === 'string' ? parsed.message : 'AI could not complete this request. Please try again.',
          partial: parsed.partial === true,
        });
        return;
      }
    }
  }
  if (!errored) {
    // Stream ended without done or error: an incomplete response must never
    // look like a completed answer.
    handlers.onError({ status: 502, message: 'AI response was interrupted. Please try again.', partial: true });
  }
}
