import express from 'express';
import path from 'path';
import fs from 'fs';
import { PORT, assertSupabaseConfig } from './config';
import routes from './routes';
import { generalRateLimit, aiRateLimit } from './ratelimit';

assertSupabaseConfig();

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api', routes);
// Unknown API paths must not fall through to the SPA.
app.use('/api', (_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

// Serve the built frontend from dist/
const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  // `root` option is required here: bare absolute paths are rejected by send on Windows.
  app.get('/{*splat}', (_req, res) => res.sendFile('index.html', { root: distDir }));
}

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'INTERNAL' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`StudyOS server listening on port ${PORT}`);
});
