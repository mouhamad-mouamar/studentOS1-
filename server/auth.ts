import { Request, Response, NextFunction } from 'express';
import { anonClient } from './supa.js';

export interface AuthedRequest extends Request {
  userId?: string;
  accessToken?: string;
}

// Small cache to avoid verifying the same token on every request.
const verified = new Map<string, { userId: string; expires: number }>();
const TTL = 60_000;

// Safe diagnostics only: fixed category + numeric status. Never the token,
// URL, key, or provider message details.
function sanitizeAuthError(e: unknown): { name: string; msg: string | null } {
  const name = e instanceof Error ? e.name : 'Unknown';
  let msg = e instanceof Error ? e.message : '';
  // Redact anything credential- or endpoint-shaped before surfacing.
  msg = msg
    .replace(/https?:\/\/[^\s"']+/gi, '[url]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}/g, '[jwt]')
    .slice(0, 120);
  return { name, msg: msg || null };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`auth verification timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'UNAUTHENTICATED', reason: 'missing_token' });

  const cached = verified.get(token);
  if (cached && cached.expires > Date.now()) {
    req.userId = cached.userId;
    req.accessToken = token;
    return next();
  }

  try {
    const { data, error } = await withTimeout(anonClient().auth.getUser(token), 5000);
    if (error || !data?.user) {
      const status = typeof (error as any)?.status === 'number' ? (error as any).status : undefined;
      return res.status(401).json({ error: 'UNAUTHENTICATED', reason: 'invalid_token', auth_status: status });
    }
    verified.set(token, { userId: data.user.id, expires: Date.now() + TTL });
    if (verified.size > 5000) verified.clear();
    req.userId = data.user.id;
    req.accessToken = token;
    next();
  } catch (e) {
    const { name, msg } = sanitizeAuthError(e);
    return res.status(401).json({ error: 'UNAUTHENTICATED', reason: 'auth_unreachable', auth_error: name, auth_msg: msg });
  }
}
