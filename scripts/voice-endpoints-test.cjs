/*
 * Voice-call endpoints e2e — LOCAL test.
 * Real express server (dist-server/index.js) + real demo Supabase + mock
 * OpenRouter STT/TTS/chat provider. All results are LOCAL MOCK results; no
 * real provider calls are made (no quota, no paid STT usage).
 *
 * Disclosed writes: NONE — voice endpoints themselves persist nothing; the
 * tutor route (which persists) is NOT invoked by these tests.
 *
 * Run with: node scripts/voice-endpoints-test.cjs   (after build:server)
 */
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { createClient } = require('@supabase/supabase-js');

const PORT = 8094;
const MOCK_PORT = 8093;
const SUPA_URL = 'https://supabase-api-prod.verdent.ai/p/p9052fdee286a2668429f';
const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoyMTA2OTAyMDg2LCJpYXQiOjE3OTEyODI4ODYsImlzcyI6InN1cH';
const MATH_COURSE = 'cb012357-0630-4ef0-9d2b-7e9f35011374';
const FAKE_WAV = Buffer.from('RIFF....WAVEfmt mockdata', 'utf8');

let failed = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) failed++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let sttMode = 'ok'; // ok | 429
// The mock ENFORCES the verified OpenRouter contract so a regression to the
// old (nonexistent) /audio/transcriptions + /audio/speech endpoints or payload
// shapes fails these tests instead of production:
//  - STT: /v1/chat/completions with messages[0].content = [text, input_audio]
//    (input_audio.data base64 + format), stream:false.
//  - TTS: /v1/chat/completions with modalities ['text','audio'], audio.voice,
//    audio.format 'wav', stream:true -> SSE with delta.audio chunks.
function sse(res, payloadB64) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  chunk({ choices: [{ delta: { audio: { data: payloadB64.slice(0, Math.ceil(payloadB64.length / 2)) } } }] });
  chunk({ choices: [{ delta: { audio: { data: payloadB64.slice(Math.ceil(payloadB64.length / 2)) } } }] });
  res.write('data: [DONE]\n\n');
  res.end();
}
function startMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((rq, rs) => {
      let b = '';
      rq.on('data', (c) => (b += c));
      rq.on('end', () => {
        if (!rq.url.includes('/chat/completions')) {
          rs.writeHead(404, { 'Content-Type': 'application/json' });
          rs.end(JSON.stringify({ error: { message: 'unexpected endpoint: ' + rq.url } }));
          return;
        }
        let body = {};
        try { body = JSON.parse(b || '{}'); } catch {}
        if (Array.isArray(body.modalities) && body.modalities.includes('audio')) {
          // TTS request — verify the full documented shape.
          const shapeOk =
            body.stream === true &&
            typeof body.audio?.voice === 'string' &&
            body.audio?.format === 'wav' &&
            typeof body.messages?.[1]?.content === 'string' &&
            body.messages[1].content.trim().length > 0;
          if (!shapeOk) {
            rs.writeHead(400, { 'Content-Type': 'application/json' });
            rs.end(JSON.stringify({ error: { message: 'mock: bad TTS contract' } }));
            return;
          }
          sse(rs, FAKE_WAV.toString('base64'));
          return;
        }
        // STT request — verify the documented input_audio shape.
        if (sttMode === '429') {
          rs.writeHead(429, { 'Content-Type': 'application/json' });
          rs.end(JSON.stringify({ error: { message: 'rate limited' } }));
          return;
        }
        const content = body.messages?.[0]?.content;
        const textPart = Array.isArray(content) ? content.find((p) => p.type === 'text') : null;
        const audioPart = Array.isArray(content) ? content.find((p) => p.type === 'input_audio') : null;
        const hasAudio = audioPart && typeof audioPart.input_audio?.data === 'string' && audioPart.input_audio.data.length > 4 && audioPart.input_audio.format === 'wav';
        if (!Array.isArray(content) || !textPart || !hasAudio || body.stream !== false) {
          rs.writeHead(400, { 'Content-Type': 'application/json' });
          rs.end(JSON.stringify({ error: { message: 'mock: bad STT contract' } }));
          return;
        }
        rs.writeHead(200, { 'Content-Type': 'application/json' });
        rs.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'What is the derivative of x squared?' } }] }));
      });
    });
    srv.listen(MOCK_PORT, '127.0.0.1', () => resolve(srv));
  });
}

function req(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json = {};
        try { json = JSON.parse(raw.toString('utf8')); } catch {}
        resolve({ status: res.statusCode, contentType: res.headers['content-type'] || '', body: json, raw });
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  const sb = createClient(SUPA_URL, SUPA_ANON);
  const { data: auth, error } = await sb.auth.signInWithPassword({ email: 'verdent-demo@example.test', password: 'DemoPw!2026-secure' });
  if (error) { console.log('FATAL auth', error.message); process.exit(1); }
  const TOKEN = auth.session.access_token;
  const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };

  const mockSrv = await startMock();
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'dist-server', 'index.js')], {
    env: {
      ...process.env,
      SUPABASE_URL: SUPA_URL,
      SUPABASE_PUBLISHABLE_KEY: SUPA_ANON,
      AI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
      AI_API_KEY: 'mock',
      AI_CHAT_MODEL: 'mock-model',
      PORT: String(PORT),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  srv.stderr.on('data', (d) => console.log('SRV:', String(d).slice(0, 400)));
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try {
      const s = await new Promise((resolve) => http.get(`http://127.0.0.1:${PORT}/api/health`, (r) => resolve(r.statusCode)).on('error', () => resolve(0)));
      up = s === 200;
    } catch {}
    if (!up) await sleep(250);
  }
  if (!up) { console.log('FATAL server did not start'); srv.kill(); mockSrv.close(); process.exit(1); }
  const B = `http://127.0.0.1:${PORT}/api`;

  try {
    // 1. Config: authenticated, owned course, no secrets in payload
    const cfg = await req(`${B}/courses/${MATH_COURSE}/tutor/voice/config`, { headers: H });
    ok('config: 200 + available + bounds', cfg.status === 200 && cfg.body.available === true && cfg.body.maxTurnSeconds > 0 && cfg.body.maxSessionSeconds >= 300, JSON.stringify(cfg.body).slice(0, 140));
    ok('config: model names present, no key material', typeof cfg.body.sttModel === 'string' && typeof cfg.body.ttsModel === 'string' && !JSON.stringify(cfg.body).match(/sk-|Bearer/i), JSON.stringify(cfg.body.sttModel));

    // 2. Transcribe happy path
    const wav = Buffer.from('RIFF....WAVEfmt mock', 'utf8');
    const tr = await req(`${B}/courses/${MATH_COURSE}/tutor/voice/transcribe`, { method: 'POST', headers: H, body: JSON.stringify({ audio: wav.toString('base64'), format: 'wav' }) });
    ok('transcribe: returns text', tr.status === 200 && tr.body.text === 'What is the derivative of x squared?', JSON.stringify(tr.body).slice(0, 120));

    // 3. Transcribe validation
    const trMissing = await req(`${B}/courses/${MATH_COURSE}/tutor/voice/transcribe`, { method: 'POST', headers: H, body: JSON.stringify({ format: 'wav' }) });
    ok('transcribe: missing audio -> 400 AUDIO_REQUIRED', trMissing.status === 400 && trMissing.body.error === 'AUDIO_REQUIRED', JSON.stringify(trMissing.body));
    const trFmt = await req(`${B}/courses/${MATH_COURSE}/tutor/voice/transcribe`, { method: 'POST', headers: H, body: JSON.stringify({ audio: 'AAAA', format: 'exe' }) });
    ok('transcribe: unsupported format -> 400', trFmt.status === 400, JSON.stringify(trFmt.body));

    // 4. Transcribe provider 429 -> mapped, safe message
    sttMode = '429';
    const tr429 = await req(`${B}/courses/${MATH_COURSE}/tutor/voice/transcribe`, { method: 'POST', headers: H, body: JSON.stringify({ audio: 'AAAA', format: 'wav' }) });
    sttMode = 'ok';
    ok('transcribe: provider 429 -> 429 with safe message', tr429.status === 429 && typeof tr429.body.message === 'string' && !/rate limited$/i.test(tr429.body.message || ''), JSON.stringify(tr429.body));

    // 5. Speak happy path -> audio/wav bytes (assembled from SSE audio chunks)
    const sp = await req(`${B}/courses/${MATH_COURSE}/tutor/voice/speak`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'The derivative of x squared is two x.' }) });
    ok('speak: 200 audio/wav bytes', sp.status === 200 && sp.contentType.includes('audio/wav') && sp.raw.length === FAKE_WAV.length, `${sp.status} ${sp.contentType} len=${sp.raw.length}`);
    ok('speak: reassembled SSE chunks byte-exact', sp.raw.equals(FAKE_WAV));

    // 6. Speak validation
    const spEmpty = await req(`${B}/courses/${MATH_COURSE}/tutor/voice/speak`, { method: 'POST', headers: H, body: JSON.stringify({ text: '   ' }) });
    ok('speak: empty text -> 400 TEXT_REQUIRED', spEmpty.status === 400 && spEmpty.body.error === 'TEXT_REQUIRED', JSON.stringify(spEmpty.body));

    // 7. Auth: no token -> 401 on all three
    const un1 = await req(`${B}/courses/${MATH_COURSE}/tutor/voice/config`);
    const un2 = await req(`${B}/courses/${MATH_COURSE}/tutor/voice/transcribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audio: 'x', format: 'wav' }) });
    const un3 = await req(`${B}/courses/${MATH_COURSE}/tutor/voice/speak`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x' }) });
    ok('unauthenticated: config/transcribe/speak all 401', un1.status === 401 && un2.status === 401 && un3.status === 401, `${un1.status}/${un2.status}/${un3.status}`);

    // 8. Ownership: foreign course -> 404 on all three
    const F = `${B}/courses/00000000-0000-0000-0000-000000000000`;
    const f1 = await req(`${F}/tutor/voice/config`, { headers: H });
    const f2 = await req(`${F}/tutor/voice/transcribe`, { method: 'POST', headers: H, body: JSON.stringify({ audio: 'x', format: 'wav' }) });
    const f3 = await req(`${F}/tutor/voice/speak`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'x' }) });
    ok('foreign course: config/transcribe/speak all 404 (no data leak)', f1.status === 404 && f2.status === 404 && f3.status === 404, `${f1.status}/${f2.status}/${f3.status}`);

    if (failed) {
      console.error(`VOICE ENDPOINTS TEST FAILED: ${failed}`);
      srv.kill(); mockSrv.close(); process.exit(1);
    }
    console.log('VOICE ENDPOINTS TEST PASSED');
    srv.kill(); mockSrv.close(); process.exit(0);
  } catch (e) {
    console.error('VOICE ENDPOINTS TEST FAILED:', e);
    srv.kill(); mockSrv.close(); process.exit(1);
  }
})();
