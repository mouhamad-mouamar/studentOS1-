/*
 * Phase 9 read-only verification — GET /courses/:id/sessions/current.
 * Real local server + real Supabase demo data + mock AI (never called).
 * Creates NO records: only reads (auth, course fetch, session list).
 *
 * Run with: node scripts/sessions-current-test.cjs   (after build:server)
 */
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { createClient } = require('@supabase/supabase-js');

const PORT = 8095;
const SUPA_URL = 'https://supabase-api-prod.verdent.ai/p/p9052fdee286a2668429f';
const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoyMTA2OTAyMDg2LCJpYXQiOjE3OTEyODI4ODYsImlzcyI6InN1cH';
const MATH_COURSE = 'cb012357-0630-4ef0-9d2b-7e9f35011374';

let failed = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) failed++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : ''));
};

function req(url, headers) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let j = {};
        try { j = JSON.parse(b); } catch {}
        resolve({ status: res.statusCode, body: j });
      });
    }).on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const sb = createClient(SUPA_URL, SUPA_ANON);
  const { data: auth, error } = await sb.auth.signInWithPassword({ email: 'verdent-demo@example.test', password: 'DemoPw!2026-secure' });
  if (error) { console.log('FATAL auth', error.message); process.exit(1); }
  const H = { Authorization: 'Bearer ' + auth.session.access_token };

  // Independent DB read to cross-check the endpoint's answer.
  const { data: rows } = await sb.from('study_sessions').select('*').eq('course_id', MATH_COURSE).order('created_at', { ascending: false }).limit(5);
  const expectedPending = (rows || []).find((s) => s.status !== 'done') || null;

  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'dist-server', 'index.js')], {
    env: { ...process.env, SUPABASE_URL: SUPA_URL, SUPABASE_PUBLISHABLE_KEY: SUPA_ANON, AI_BASE_URL: 'http://127.0.0.1:9/v1', AI_CHAT_MODEL: 'unused', PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try {
      const s = await new Promise((resolve) => http.get(`http://127.0.0.1:${PORT}/api/health`, (r) => resolve(r.statusCode)).on('error', () => resolve(0)));
      up = s === 200;
    } catch {}
    if (!up) await sleep(250);
  }
  if (!up) { console.log('FATAL server did not start'); srv.kill(); process.exit(1); }

  try {
    const r = await req(`http://127.0.0.1:${PORT}/api/courses/${MATH_COURSE}/sessions/current`, H);
    ok('sessions/current: 200 with session key', r.status === 200 && 'session' in r.body, `status=${r.status}`);
    ok('sessions/current: matches independent DB read', JSON.stringify(r.body.session) === JSON.stringify(expectedPending), `endpoint=${JSON.stringify(r.body.session)?.slice(0, 80)} db=${expectedPending ? expectedPending.id : 'null'}`);
    if (r.body.session) {
      ok('sessions/current: pending session is not done', r.body.session.status !== 'done');
      ok('sessions/current: plan shape present', !!r.body.session.plan, typeof r.body.session.plan);
    }

    // Ownership: another user's course id must 404, not leak session data.
    const r2 = await req(`http://127.0.0.1:${PORT}/api/courses/00000000-0000-0000-0000-000000000000/sessions/current`, H);
    ok('sessions/current: foreign course -> 404', r2.status === 404, `status=${r2.status}`);

    if (failed) {
      console.error(`SESSIONS CURRENT TEST FAILED: ${failed}`);
      srv.kill();
      process.exit(1);
    }
    console.log('SESSIONS CURRENT TEST PASSED');
    srv.kill();
    process.exit(0);
  } catch (e) {
    console.error('SESSIONS CURRENT TEST FAILED:', e);
    srv.kill();
    process.exit(1);
  }
})();
