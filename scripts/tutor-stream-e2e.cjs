/*
 * Phase 5B route-level streaming e2e — LOCAL test.
 * Real express server (dist-server/index.js) + REAL Supabase demo data +
 * mock SSE AI provider. Nothing is mocked about the HTTP/SSE path itself.
 *
 * Disclosed writes: tutor_messages rows for the demo user's Math course
 * (same disclosure as d123-e2e.cjs). No courses/materials/quizzes touched.
 *
 * Run with: node scripts/tutor-stream-e2e.cjs   (after build:server)
 */
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { createClient } = require('@supabase/supabase-js');

const PORT = 8096;
const SUPA_URL = 'https://supabase-api-prod.verdent.ai/p/p9052fdee286a2668429f';
const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoyMTA2OTAyMDg2LCJpYXQiOjE3OTEyODI4ODYsImlzcyI6InN1cH';
const MATH_COURSE = 'cb012357-0630-4ef0-9d2b-7e9f35011374';

let failed = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) failed++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let mode = 'stream-ok'; // stream-ok | mid-stream-die
function sseFrame(content) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

function startMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((rq, rs) => {
      let b = '';
      rq.on('data', (c) => (b += c));
      rq.on('end', () => {
        const body = JSON.parse(b || '{}');
        if (body.stream !== true) {
          // Non-streaming JSON path (backward compat).
          rs.writeHead(200, { 'Content-Type': 'application/json' });
          rs.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'JSON path answer [1].' } }] }));
          return;
        }
        if (mode === 'mid-stream-die') {
          rs.writeHead(200, { 'Content-Type': 'text/event-stream' });
          rs.write(sseFrame('Partial '));
          setTimeout(() => rs.destroy(), 40);
          return;
        }
        rs.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunks = ['Integration by parts: ', 'integral u dv = uv - integral v du. ', 'Cited as [1].'];
        let i = 0;
        const tick = () => {
          if (i >= chunks.length) {
            rs.end('data: [DONE]\n\n');
            return;
          }
          rs.write(sseFrame(chunks[i++]));
          setTimeout(tick, 15);
        };
        tick();
      });
    });
    srv.listen(8098, '127.0.0.1', () => resolve(srv));
  });
}

// Streaming HTTP request: resolves when the connection closes.
function reqStream(url, headers, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(url, { method: 'POST', headers }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode, contentType: res.headers['content-type'] || '', raw }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

function reqJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(url, { method: 'POST', headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let j = {};
        try { j = JSON.parse(b); } catch {}
        resolve({ status: res.statusCode, body: j });
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

function parseSse(raw) {
  const events = [];
  for (const frame of raw.split('\n\n')) {
    if (!frame.trim()) continue;
    let event = 'message';
    const dataLines = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) continue;
    try { events.push({ event, data: JSON.parse(dataLines.join('\n')) }); } catch {}
  }
  return events;
}

async function assistantCount(sb) {
  const { count } = await sb
    .from('tutor_messages')
    .select('id', { count: 'exact', head: true })
    .eq('course_id', MATH_COURSE)
    .eq('role', 'assistant');
  return count || 0;
}

(async () => {
  const sb = createClient(SUPA_URL, SUPA_ANON);
  const { data: auth, error } = await sb.auth.signInWithPassword({ email: 'verdent-demo@example.test', password: 'DemoPw!2026-secure' });
  if (error) { console.log('FATAL auth', error.message); process.exit(1); }
  const H = {
    Authorization: 'Bearer ' + auth.session.access_token,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };

  const mockSrv = await startMock();
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'dist-server', 'index.js')], {
    env: {
      ...process.env,
      SUPABASE_URL: SUPA_URL,
      SUPABASE_PUBLISHABLE_KEY: SUPA_ANON,
      AI_BASE_URL: 'http://127.0.0.1:8098/v1',
      AI_API_KEY: 'mock',
      AI_CHAT_MODEL: 'mock-model',
      PORT: String(PORT),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try {
      const r = await new Promise((resolve) => http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => resolve(res.statusCode)).on('error', () => resolve(0)));
      up = r === 200;
    } catch {}
    if (!up) await sleep(250);
  }
  if (!up) { console.log('FATAL server did not start'); srv.kill(); mockSrv.close(); process.exit(1); }

  try {
    const B = `http://127.0.0.1:${PORT}/api`;

    // --- 1. Successful streaming route ---
    let before = await assistantCount(sb);
    const r1 = await reqStream(`${B}/courses/${MATH_COURSE}/tutor?stream=1`, H, JSON.stringify({ question: 'State the integration by parts formula', mode: 'free' }));
    ok('stream route: SSE content-type', r1.status === 200 && r1.contentType.includes('text/event-stream'), `${r1.status} ${r1.contentType}`);
    const ev1 = parseSse(r1.raw);
    const meta = ev1.find((e) => e.event === 'meta');
    const deltas = ev1.filter((e) => e.event === 'delta');
    const done = ev1.find((e) => e.event === 'done');
    ok('stream route: meta precedes deltas', !!meta && deltas.length > 0 && ev1.indexOf(meta) < ev1.indexOf(deltas[0]));
    ok('stream route: meta carries citations array', Array.isArray(meta?.data?.citations), JSON.stringify(meta?.data?.citations || null).slice(0, 120));
    ok('stream route: deltas assemble the answer', deltas.map((d) => d.data.t).join('') === 'Integration by parts: integral u dv = uv - integral v du. Cited as [1].', deltas.map((d) => d.data.t).join(''));
    ok('stream route: done event has citations', !!done && Array.isArray(done.data.citations));
    await sleep(400);
    let after = await assistantCount(sb);
    ok('stream route: exactly one assistant message persisted', after === before + 1, `before=${before} after=${after}`);

    // --- 2. Mid-stream failure: error event, partial:true, NOTHING persisted ---
    before = await assistantCount(sb);
    mode = 'mid-stream-die';
    const r2 = await reqStream(`${B}/courses/${MATH_COURSE}/tutor?stream=1`, H, JSON.stringify({ question: 'partial stream test', mode: 'free' }));
    mode = 'stream-ok';
    const ev2 = parseSse(r2.raw);
    const errEv = ev2.find((e) => e.event === 'error');
    const doneEv2 = ev2.find((e) => e.event === 'done');
    ok('interrupted route: error event, no done', !!errEv && !doneEv2, JSON.stringify(errEv || {}));
    ok('interrupted route: partial=true and safe message', errEv?.data?.partial === true && errEv?.data?.message === 'AI response was interrupted. Please try again.', JSON.stringify(errEv?.data || {}));
    const deltasBeforeError = ev2.filter((e) => e.event === 'delta').map((d) => d.data.t).join('');
    ok('interrupted route: partial deltas were delivered honestly', deltasBeforeError === 'Partial ', JSON.stringify(deltasBeforeError));
    await sleep(400);
    after = await assistantCount(sb);
    ok('interrupted route: nothing persisted (no duplicate on retry)', after === before, `before=${before} after=${after}`);

    // --- 3. Backward compat: non-streaming JSON path unchanged ---
    const r3 = await reqJson(`${B}/courses/${MATH_COURSE}/tutor`, { Authorization: H.Authorization, 'Content-Type': 'application/json' }, JSON.stringify({ question: 'json path check', mode: 'free' }));
    ok('json fallback: works without stream param', r3.status === 200 && typeof r3.body.answer === 'string' && Array.isArray(r3.body.citations), JSON.stringify(r3.body).slice(0, 120));
    ok('json fallback: AI request was non-streaming', (r3.body.answer || '').startsWith('JSON path answer'));

    // --- 4. Unauthorized course access stays protected on the stream path ---
    const r4 = await reqStream(`${B}/courses/00000000-0000-0000-0000-000000000000/tutor?stream=1`, H, JSON.stringify({ question: 'x' }));
    ok('stream route: unauthorized course -> 404, no SSE', r4.status === 404 && !r4.contentType.includes('text/event-stream'), `status=${r4.status}`);

    if (failed) {
      console.error(`TUTOR STREAM E2E FAILED: ${failed} check(s)`);
      srv.kill();
      mockSrv.close();
      process.exit(1);
    }
    console.log('TUTOR STREAM E2E PASSED');
    srv.kill();
    mockSrv.close();
    process.exit(0);
  } catch (e) {
    console.error('TUTOR STREAM E2E FAILED:', e);
    srv.kill();
    mockSrv.close();
    process.exit(1);
  }
})();
