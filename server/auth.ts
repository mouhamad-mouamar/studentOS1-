import { Request, Response, NextFunction } from 'express';
import { anonClient } from './supa';

export interface AuthedRequest extends Request {
  userId?: string;
  accessToken?: string;
}

// Small cache to avoid verifying the same token on every request.
const verified = new Map<string, { userId: string; expires: number }>();
const TTL = 60_000;

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'UNAUTHENTICATED' });

  const cached = verified.get(token);
  if (cached && cached.expires > Date.now()) {
    req.userId = cached.userId;
    req.accessToken = token;
    return next();
  }

  try {
    const { data, error } = await anonClient().auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'UNAUTHENTICATED' });
    verified.set(token, { userId: data.user.id, expires: Date.now() + TTL });
    if (verified.size > 5000) verified.clear();
    req.userId = data.user.id;
    req.accessToken = token;
    next();
  } catch {
    return res.status(401).json({ error: 'UNAUTHENTICATED' });
  }
}
