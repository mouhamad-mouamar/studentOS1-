import type { IncomingMessage, ServerResponse } from 'node:http';
import app from '../server/app';

// Vercel's Node runtime hands the function IncomingMessage/ServerResponse
// compatible objects, so the existing Express app (server/app.ts — the same
// app used by `npm start` and Verdent hosting) serves the request directly.
// No routes are duplicated here.
const expressHandler = app as unknown as (req: IncomingMessage, res: ServerResponse) => void;

export default function handler(req: IncomingMessage, res: ServerResponse) {
  return expressHandler(req, res);
}
