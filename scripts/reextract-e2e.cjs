// Live E2E for the analysis-repair flow (POST /courses/:id/reextract):
//  1. zero-concept course + mock AI provider -> concepts extracted, honest success
//  2. mock provider 429 -> honest 429, material annotated CONCEPTS_FAILED:429
// All created rows are cleaned up afterwards.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const SUPA_URL = 'https://supabase-api-prod.verdent.ai/p/p9052fdee286a2668429f';
const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoyMTA2OTAyMDg2LCJpYXQiOjE3OTEyODI4ODYsImlzcyI6InN1cGFiYXNlIiwicHJvamVjdF9yZWYiOiJwOTA1MmZkZWUyODZhMjY2ODQyOWYiLCJyb2xlIjoiYW5vbiJ9.6kre7yWu80xczttItHpDPtzi0WRY8GQNkmS4MH45yPg';
const PORT = 8100;
const results = [];
const ok = (name, cond, extra = '') => { results.push(cond); console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : '')); };

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

function startMock(mode) {
  return new Promise((resolve) => {
    const srv = http.createServer((rq, rs) => {
      let b = '';
      rq.on('data', (c) => (b += c));
      rq.on('end', () => {
        if (mode === '429') { rs.writeHead(429, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify({ error: { message: 'rate limited' } })); return; }
        rs.writeHead(200, { 'Content-Type': 'application/json' });
        rs.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: JSON.stringify({
            concepts: [{ title: 'E2E_REPAIR_CONCEPT', summary: 'Temporary E2E verification concept', importance: 80 }],
            formulas: [],
          }) } }],
        }));
      });
    });
    srv.listen(8098, '127.0.0.1', () => resolve(srv));
  });
}

function startServer(env) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'dist-server', 'index.js')], {
    env: { ...process.env, ...env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write('[srv] ' + d));
  child.stderr.on('data', (d) => process.stdout.write('[srv:err] ' + d));
  return child;
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
  const B = `http://127.0.0.1:${PORT}/api`;
  const H = { Authorization: 'Bearer ' + auth.session.access_token };

  // Find a ready material with no concepts for the demo user.
  const { data: courses } = await sb.from('courses').select('id,name').order('created_at');
  let target = null;
  for (const c of courses || []) {
    const { data: mats } = await sb.from('materials').select('id,status').eq('course_id', c.id).eq('status', 'ready');
    if (!mats?.length) continue;
    const { data: cons } = await sb.from('concepts').select('id').eq('course_id', c.id);
    if (!cons?.length) { target = { course: c, matIds: mats.map((m) => m.id) }; break; }
  }
  if (!target) { console.log('FATAL no zero-concept course available'); process.exit(1); }
  console.log('target course:', target.course.id, target.course.name, '| materials:', target.matIds.length);

  // ---- Phase 1: healthy mock provider -> repair succeeds
  let mock = await startMock('ok');
  let srv = startServer({ SUPABASE_URL: SUPA_URL, SUPABASE_PUBLISHABLE_KEY: SUPA_ANON, AI_BASE_URL: 'http://127.0.0.1:8098/v1', AI_API_KEY: 'mock', AI_CHAT_MODEL: 'mock-model' });
  ok('server boots', await waitForServer());

  let r = JSON.parse((await req(`${B}/courses/${target.course.id}/reextract`, { method: 'POST', headers: H })).body || '{}');
  ok('reextract succeeds with working provider', r.extracted_any === true, JSON.stringify(r).slice(0, 120));
  const { data: consAfter } = await sb.from('concepts').select('id').eq('course_id', target.course.id);
  ok('concepts now exist for the course', (consAfter || []).length > 0, String((consAfter || []).length));
  const { data: matAfter } = await sb.from('materials').select('error').in('id', target.matIds);
  ok('material error annotation cleared', (matAfter || []).every((m) => !m.error));
  // duplicate-run safety: second call reports nothing pending
  r = JSON.parse((await req(`${B}/courses/${target.course.id}/reextract`, { method: 'POST', headers: H })).body || '{}');
  ok('second reextract is a no-op', r.processed === 0 && r.extracted_any === false, JSON.stringify(r).slice(0, 80));

  srv.kill();
  mock.close();

  // ---- Phase 2: 429 provider -> honest error + annotation (fresh zero-concept course)
  let target2 = null;
  for (const c of courses || []) {
    if (c.id === target.course.id) continue;
    const { data: mats } = await sb.from('materials').select('id,status').eq('course_id', c.id).eq('status', 'ready');
    if (!mats?.length) continue;
    const { data: cons } = await sb.from('concepts').select('id').eq('course_id', c.id);
    if (!cons?.length) { target2 = { course: c, matIds: mats.map((m) => m.id) }; break; }
  }
  if (target2) {
    mock = await startMock('429');
    srv = startServer({ SUPABASE_URL: SUPA_URL, SUPABASE_PUBLISHABLE_KEY: SUPA_ANON, AI_BASE_URL: 'http://127.0.0.1:8098/v1', AI_API_KEY: 'mock', AI_CHAT_MODEL: 'mock-model' });
    ok('server reboots', await waitForServer());
    const res = await req(`${B}/courses/${target2.course.id}/reextract`, { method: 'POST', headers: H });
    const body = JSON.parse(res.body || '{}');
    ok('rate-limited repair -> honest 429', res.status === 429 && body.error === 'AI_ERROR', `${res.status} ${JSON.stringify(body).slice(0, 90)}`);
    const { data: mats2 } = await sb.from('materials').select('error').in('id', target2.matIds);
    ok('material annotated CONCEPTS_FAILED:429', (mats2 || []).some((m) => (m.error || '').startsWith('CONCEPTS_FAILED:429')), JSON.stringify((mats2 || []).map((m) => m.error)));
    srv.kill();
    mock.close();
    // cleanup annotation for this course (leave its data untouched otherwise)
    await sb.from('materials').update({ error: null }).in('id', target2.matIds);
  } else {
    console.log('SKIP phase 2: no second zero-concept course');
  }

  // ---- Cleanup phase-1 test concept
  await sb.from('concepts').delete().eq('course_id', target.course.id).eq('title', 'E2E_REPAIR_CONCEPT');
  const { data: consFinal } = await sb.from('concepts').select('id').eq('course_id', target.course.id);
  ok('cleanup: E2E concept removed', !(consFinal || []).some(() => true) || (consFinal || []).length === 0, String((consFinal || []).length));

  const failed = results.filter((x) => !x).length;
  console.log(failed === 0 ? 'E2E ALL PASSED' : failed + ' E2E FAILED');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.log('FATAL', e.message); process.exit(1); });
