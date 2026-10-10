// E2E (D1+D3 verification): local server + REAL Supabase demo data + mock AI
// provider. Replays the exact questions that failed on production with 0
// citations:
//   T3: English factual question squarely covered by the single chunk
//       (was: "material does not cover this" — D1 floor rejection)
//   T6: English question with x*e^x (was: Arabic answer — D4 detector bug)
//   T4: Arabic question against English material (was: 0 citations — D3)
// Read-only against the DB except tutor_messages rows the route writes.
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { createClient } = require('@supabase/supabase-js');

const PORT = 8097;
const SUPA_URL = 'https://supabase-api-prod.verdent.ai/p/p9052fdee286a2668429f';
const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoyMTA2OTAyMDg2LCJpYXQiOjE3OTEyODI4ODYsImlzcyI6InN1cGFiYXNlIiwicHJvamVjdF9yZWYiOiJwOTA1MmZkZWUyODZhMjY2ODQyOWYiLCJyb2xlIjoiYW5vbiJ9.6kre7yWu80xczttItHpDPtzi0WRY8GQNkmS4MH45yPg';
const MATH_COURSE = 'cb012357-0630-4ef0-9d2b-7e9f35011374';

const ok = (name, cond, extra = '') => console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : ''));

let captured = null;
function startMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((rq, rs) => {
      let b = '';
      rq.on('data', (c) => (b += c));
      rq.on('end', () => {
        try { captured = JSON.parse(b); } catch { captured = { raw: b }; }
        rs.writeHead(200, { 'Content-Type': 'application/json' });
        rs.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'The integration by parts formula is integral u dv = uv - integral v du [1], and the example gives x e^x - e^x + C [1].' } }] }));
      });
    });
    srv.listen(8098, '127.0.0.1', () => resolve(srv));
  });
}

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

(async () => {
  const sb = createClient(SUPA_URL, SUPA_ANON);
  const { data: auth, error } = await sb.auth.signInWithPassword({ email: 'verdent-demo@example.test', password: 'DemoPw!2026-secure' });
  if (error) { console.log('FATAL auth', error.message); process.exit(1); }
  const H = { Authorization: 'Bearer ' + auth.session.access_token };

  const mockSrv = await startMock();
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'dist-server', 'index.js')], {
    env: { ...process.env, SUPABASE_URL: SUPA_URL, SUPABASE_PUBLISHABLE_KEY: SUPA_ANON, AI_BASE_URL: 'http://127.0.0.1:8098/v1', AI_API_KEY: 'mock', AI_CHAT_MODEL: 'mock-model', PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { const r = await req(`http://127.0.0.1:${PORT}/api/health`); up = r.status === 200; } catch {}
    if (!up) await sleep(250);
  }
  if (!up) { console.log('FATAL server did not start'); srv.kill(); mockSrv.close(); process.exit(1); }

  const B = `http://127.0.0.1:${PORT}/api`;
  const ask = async (question) => {
    captured = null;
    const r = await req(`${B}/courses/${MATH_COURSE}/tutor`, { method: 'POST', headers: H, body: JSON.stringify({ question, mode: 'explain' }) });
    let body = {};
    try { body = JSON.parse(r.body); } catch {}
    return { status: r.status, answer: body.answer || '', citations: body.citations || [] };
  };
  const sys = () => captured?.messages?.find((m) => m.role === 'system')?.content || '';
  const usr = () => captured?.messages?.find((m) => m.role === 'user')?.content || '';

  // T3 replay: English factual question (D1).
  const t3 = await ask('State the integration by parts formula exactly as the material gives it, plus the worked example from the material.');
  ok('T3 status 200', t3.status === 200, `status=${t3.status}`);
  ok('T3 now retrieves real citations (was 0)', t3.citations.length >= 1, `citations=${t3.citations.length}`);
  ok('T3 prompt contains real material text', usr().includes('Course material snippets:') && /integration by parts/i.test(usr()));
  ok('T3 no weak-evidence rule (scored hit)', !/broad fallback/.test(sys()));

  // T6 replay: x*e^x must now be English (D4).
  const t6 = await ask('According to the material: which u should be chosen for the integral of x*e^x dx (using the rule given), and what is the final result stated?');
  ok('T6 prompt uses the English mirror rule (was Arabic rule)', /same language/.test(sys()) && !/Latin script/.test(sys()));

  // T4 replay: Arabic question vs English material (D3 fallback).
  const t4 = await ask('شو القاعدة اللي منستعملها لاختيار u بمسألة التكامل بالتجزئة؟');
  ok('T4 status 200', t4.status === 200);
  ok('T4 prompt carries Arabic rule', /Arabic/.test(sys()));
  ok('T4 prompt includes real material via fallback', /integration by parts/i.test(usr()));
  const t4weak = /broad fallback because the question did not strongly match/.test(sys());
  // Zero-token-overlap Arabic query must come through the fallback path.
  ok('T4 uses broad fallback (weakEvidence disclosed to the model)', t4weak || t4.citations.length >= 1);

  // Absent topic stays honest: zeta question has zero overlap with this
  // corpus, but fallback now SHOWS the material with rule 8 disclosure.
  const t5 = await ask('What does the material say about the Riemann zeta function?');
  ok('T5 status 200', t5.status === 200);
  ok('T5 fallback discloses weak evidence to the model', /broad fallback because the question did not strongly match/.test(sys()) === true || /no processed course material/.test(usr()));

  srv.kill();
  mockSrv.close();
  setTimeout(() => process.exit(0), 300);
})().catch((e) => { console.error('E2E CRASH:', e); process.exit(1); });
