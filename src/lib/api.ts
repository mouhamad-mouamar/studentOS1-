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
  if (!res.ok) throw new ApiError(res.status, data.error || 'REQUEST_FAILED', data.message);
  return data as T;
}

// Upload a file into the private `materials` storage bucket under the user's own prefix.
export async function uploadMaterialFile(
  userId: string,
  courseId: string,
  file: File,
): Promise<string> {
  const path = `${userId}/${courseId}/${crypto.randomUUID()}-${file.name}`;
  const { error } = await supabase.storage.from('materials').upload(path, file, {
    cacheControl: '3600',
    upsert: false,
  });
  if (error) throw new ApiError(400, 'UPLOAD_FAILED', error.message);
  return path;
}
