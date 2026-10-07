import express from 'express';
import path from 'path';
import fs from 'fs';
import { assertSupabaseConfig } from './config.js';
import routes from './routes.js';
import { generalRateLimit, aiRateLimit } from './ratelimit.js';

assertSupabaseConfig();

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api', routes);
// Unknown API paths must not fall through to the SPA.
app.use('/api', (_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

// Serve the built frontend from dist/ (used by the Verdent single-process
// deployment and `npm start`). On Vercel the dist bundle is not part of the
// serverless function, so static serving is skipped and the platform handles
// the frontend.
const distDir = path.join(typeof __dirname !== 'undefined' ? __dirname : process.cwd(), '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  // `root` option is required here: bare absolute paths are rejected by send on Windows.
  app.get('/{*splat}', (_req, res) => res.sendFile('index.html', { root: distDir }));
}

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'INTERNAL' });
});

export default app;
