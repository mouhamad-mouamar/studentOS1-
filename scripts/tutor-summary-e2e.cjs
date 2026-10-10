// E2E: tutor summary intent + language matching against the real local
// server + real (demo) Supabase data, with a mock AI provider that captures
// the exact prompt sent. Read-only against the database except the tutor
// message log rows the /tutor route itself writes (existing behavior).
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PORT = 8096;
const SUPA_URL = 'https://supabase-api-prod.verdent.ai/p/p9052fdee286a2668429f';
const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoyMTA2OTAyMDg2LCJpYXQiOjE3OTEyODI4ODYsImlzcyI6InN1cGFiYXNlIiwicHJvamVjdF9yZWYiOiJwOTA1MmZkZWUyODZhMjY2ODQyOWYiLCJyb2xlIjoiYW5vbiJ9.6kre7yWu80xczttItHpDPtzi0WRY8GQNkmS4MH45yPg';

const ok = (name, cond, extra = '') => console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : ''));

function req(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(url, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mock AI provider: records the tutor system prompt, replies with Arabic text.
let captured = null;
function startMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((rq, rs) => {
      let b = '';
      rq.on('data', (c) => (b += c));
      rq.on('end', () => {
        try { captured = JSON.parse(b); } catch { captured = { raw: b }; }
        rs.writeHead(200, { 'Content-Type': 'application/json' });
        rs.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'هذا ملخص للمادة بناءً على المصادر المرفقة.' } }] }));
      });
    });
    srv.listen(8098, '127.0.0.1', () => resolve(srv));
  });
}

function startServer(env) {
  return spawn(process.execPath, [path.join(__dirname, '..', 'dist-server', 'index.js')], {
    env: { ...process.env, ...env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try { const r = await req(`http://127.0.0.1:${PORT}/api/health`); if (r.status === 200) return true; } catch {}
    await sleep(250);
  }
  return false;
}

async function main() {
  const { createClient } = require('@supabase/supabase-js');
  const sb = createClient(SUPA_URL, SUPA_ANON);
  const { data: auth, error: aerr } = await sb.auth.signInWithPassword({ email: 'verdent-demo@example.test', password: 'DemoPw!2026-secure' });
  if (aerr || !auth.session) { console.log('FATAL auth failed', aerr?.message); process.exit(1); }

  const mockSrv = await startMock();
  const srv = startServer({
    SUPABASE_URL: SUPA_URL,
    SUPABASE_PUBLISHABLE_KEY: SUPA_ANON,
    AI_BASE_URL: 'http://127.0.0.1:8098/v1',
    AI_API_KEY: 'mock',
    AI_CHAT_MODEL: 'mock-model',
  });
  const up = await waitForServer();
  if (!up) { console.log('FATAL server did not start'); srv.kill(); mockSrv.close(); process.exit(1); }

  const B = `http://127.0.0.1:${PORT}/api`;
  const H = { Authorization: 'Bearer ' + auth.session.access_token };

  // Pick a course with a ready material (the reproduction course).
  const { data: courses } = await sb.from('courses').select('id,name').order('created_at');
  let target = null;
  for (const c of courses || []) {
    const { data: mats } = await sb.from('materials').select('id,status').eq('course_id', c.id).eq('status', 'ready');
    if (mats?.length) { target = c; break; }
  }
  ok('found demo course with ready material', !!target, target?.name || '');
  if (!target) { srv.kill(); mockSrv.close(); process.exit(1); }

  // Arabic summary request — the previously-failing case.
  const r = await req(`${B}/courses/${target.id}/tutor`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ question: 'فيك تعملي شي ملخص؟', mode: 'explain' }),
  });
  ok('tutor 200', r.status === 200, `status=${r.status} ${r.body.slice(0, 200)}`);
  let out = {};
  try { out = JSON.parse(r.body); } catch {}
  ok('citations retrieved (broad context, not 0)', (out.citations || []).length > 0, `citations=${(out.citations || []).length}`);
  ok('citations carry source filenames', (out.citations || []).every((c) => c.source && c.source.length > 0));

  const sys = captured?.messages?.find((m) => m.role === 'system')?.content || '';
  ok('summary-intent rule reached the model', /student asked for a summary/.test(sys));
  ok('Arabic language rule reached the model', /natural Arabic/.test(sys));
  const usr = captured?.messages?.find((m) => m.role === 'user')?.content || '';
  ok('prompt contains REAL material text (not the no-material placeholder)', usr.includes('Course material snippets:') && !usr.includes('no material retrieved'));
  ok('prompt includes snippets count > 0', /\[1\] \(source:/.test(usr));

  // English topical question → scored retrieval path still works, English rule.
  captured = null;
  const r2 = await req(`${B}/courses/${target.id}/tutor`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ question: 'What does this course say about its main topic?', mode: 'explain' }),
  });
  ok('topical question 200', r2.status === 200, `status=${r2.status}`);
  const sys2 = captured?.messages?.find((m) => m.role === 'system')?.content || '';
  ok('topical question does NOT get summary rule 7', !/student asked for a summary/.test(sys2));
  ok('topical question gets mirror-language rule', /same language/.test(sys2));

  srv.kill();
  mockSrv.close();
  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => { console.error('E2E CRASH:', e); process.exit(1); });
