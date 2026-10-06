import { Request, Response, NextFunction } from 'express';
import { AuthedRequest } from './auth';

// Simple in-memory sliding-window rate limiter, keyed per user + bucket.
// Sufficient for a single-process deployment; swap for Redis if scaled out.
const buckets = new Map<string, number[]>();

export function rateLimit(maxPerMinute: number) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const key = `${req.userId || req.ip}:${maxPerMinute}`;
    const now = Date.now();
    const windowStart = now - 60_000;
    let arr = buckets.get(key);
    if (!arr) {
      arr = [];
      buckets.set(key, arr);
    }
    while (arr.length && arr[0] < windowStart) arr.shift();
    if (arr.length >= maxPerMinute) {
      return res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many requests — slow down and try again in a minute.' });
    }
    arr.push(now);
    if (buckets.size > 10_000) buckets.clear();
    next();
  };
}

// Apply the tight limiter to AI-generation endpoints, loose one elsewhere.
export const aiRateLimit = rateLimit(12);
export const generalRateLimit = rateLimit(180);
