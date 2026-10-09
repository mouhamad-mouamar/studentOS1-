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
