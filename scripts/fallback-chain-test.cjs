// Regression tests for the chat fallback chain (AI_CHAT_MODEL_FALLBACKS).
// Each case runs in a fresh subprocess (config is captured at import time)
// against a mock OpenAI-compatible provider that records requests.
//
// Cases:
//   A. primary 429 exhausts retries -> fallback 1 429 -> fallback 2 succeeds
//   B. primary + fallback all 429 -> bounded retries, honest 429, no infinite loop
//   C. primary returns 400 -> non-retryable, no fallback attempted
//   D. no fallbacks configured -> primary only, 3 bounded requests
//   E. duplicate of primary in fallback list is ignored
//
// Run with: node scripts/fallback-chain-test.cjs   (after build:server)
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const MOCK = `
const http = require('http');
const plan = JSON.parse(process.env.MOCK_PLAN); // [{model, status}...] prefix rules
const delay = Number(process.env.MOCK_DELAY_MS || 0);
let seen = [];
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let model = '?';
    try { model = JSON.parse(body).model; } catch {}
    seen.push(model);
    const rule = plan.find((r) => r.model === model);
    const status = rule ? rule.status : 200;
    const respond = () => {
      if (status === 200) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: process.env.MOCK_BODY || 'MOCK_OK' } }] }));
      } else {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock ' + status, code: status } }));
      }
    };
    if (delay > 0) setTimeout(respond, delay);
    else respond();
  });
});
srv.listen(8098, '127.0.0.1', async () => {
  srv.unref();
  const path = require('path');
  const ai = require(path.join(process.cwd(), 'dist-server', 'ai.js'));
  let outcome;
  try {
    const answer = await ai.chatText('system', 'user');
    outcome = { ok: true, answer, seen };
  } catch (e) {
    outcome = { ok: false, status: e.status || null, message: e.message, seen };
  }
  console.log('RESULT ' + JSON.stringify(outcome));
  process.exit(0);
});
`;

// Variant that exercises chatJson (structured output) instead of chatText.
const MOCK_JSON = MOCK.replace("await ai.chatText('system', 'user')", "await ai.chatJson('system', 'user', undefined, 1200, ['question'])");

function runCase(name, env, plan, assertFn) {
  const r = spawnSync(process.execPath, ['-e', MOCK], {
    cwd: ROOT,
    timeout: 60000,
    env: { ...process.env, ...env, MOCK_PLAN: JSON.stringify(plan) },
  });
  const line = (r.stdout || '').toString().split('\n').find((l) => l.startsWith('RESULT '));
  if (!line) {
    console.log('FAIL', name, '— no result. stderr:', (r.stderr || '').toString().slice(0, 250));
    return false;
  }
  const outcome = JSON.parse(line.slice(7));
  const ok = assertFn(outcome);
  console.log(ok ? 'PASS' : 'FAIL', name, '—', JSON.stringify(outcome).slice(0, 180));
  return ok;
}

let failed = 0;

// A. primary m1 (429 x3 retries) -> fallback m2 (429 x3) -> m3 succeeds
if (!runCase(
  'A: falls through two 429 models to a working third',
  { AI_BASE_URL: 'http://127.0.0.1:8098/v1', AI_API_KEY: 'k', AI_CHAT_MODEL: 'm1', AI_CHAT_MODEL_FALLBACKS: 'm2, m3' },
  [{ model: 'm1', status: 429 }, { model: 'm2', status: 429 }],
  (o) => o.ok === true && o.answer === 'MOCK_OK' && o.seen.filter((m) => m === 'm1').length === 3 && o.seen.filter((m) => m === 'm2').length === 3 && o.seen.includes('m3'),
)) failed++;

// B. everything rate-limited: bounded (3 per model), honest 429
if (!runCase(
  'B: all models 429 -> bounded requests, honest 429',
  { AI_BASE_URL: 'http://127.0.0.1:8098/v1', AI_API_KEY: 'k', AI_CHAT_MODEL: 'm1', AI_CHAT_MODEL_FALLBACKS: 'm2' },
  [{ model: 'm1', status: 429 }, { model: 'm2', status: 429 }],
  (o) => o.ok === false && o.status === 429 && o.seen.length === 6,
)) failed++;

// C. non-retryable 400 on primary: no fallback, no retry
if (!runCase(
  'C: primary 400 -> immediate fail, fallback never attempted',
  { AI_BASE_URL: 'http://127.0.0.1:8098/v1', AI_API_KEY: 'k', AI_CHAT_MODEL: 'm1', AI_CHAT_MODEL_FALLBACKS: 'm2' },
  [{ model: 'm1', status: 400 }],
  (o) => o.ok === false && o.status === 400 && o.seen.length === 1 && !o.seen.includes('m2'),
)) failed++;

// D. no fallbacks configured: primary only, bounded
if (!runCase(
  'D: no fallbacks -> primary only, 3 bounded requests',
  { AI_BASE_URL: 'http://127.0.0.1:8098/v1', AI_API_KEY: 'k', AI_CHAT_MODEL: 'm1', AI_CHAT_MODEL_FALLBACKS: '' },
  [{ model: 'm1', status: 429 }],
  (o) => o.ok === false && o.status === 429 && o.seen.length === 3,
)) failed++;

// E. fallback list duplicating the primary is ignored: m1 only tried as
// primary (3x), then m2 succeeds on its first attempt -> 4 requests total
if (!runCase(
  'E: duplicate fallback entries ignored',
  { AI_BASE_URL: 'http://127.0.0.1:8098/v1', AI_API_KEY: 'k', AI_CHAT_MODEL: 'm1', AI_CHAT_MODEL_FALLBACKS: 'm1, m1 ,m2' },
  [{ model: 'm1', status: 429 }],
  (o) => o.ok === true && o.answer === 'MOCK_OK' && o.seen.length === 4 && o.seen.filter((m) => m === 'm1').length === 3 && o.seen.includes('m2'),
)) failed++;

// F. chain deadline: slow (delayed) 429s across a 3-model chain must be cut
// short by the overall wall-clock budget -> honest 504 instead of grinding
// through all 9 attempts. AI_TIMEOUT_MS=3000 -> budget ≈ 21s; the full chain
// of delayed responses + backoffs would need ~35s+.
{
  const r = spawnSync(process.execPath, ['-e', MOCK], {
    cwd: ROOT,
    timeout: 90000,
    env: {
      ...process.env,
      AI_BASE_URL: 'http://127.0.0.1:8098/v1', AI_API_KEY: 'k', AI_CHAT_MODEL: 'm1', AI_CHAT_MODEL_FALLBACKS: 'm2,m3', AI_TIMEOUT_MS: '3000',
      MOCK_PLAN: JSON.stringify([{ model: 'm1', status: 429 }, { model: 'm2', status: 429 }, { model: 'm3', status: 429 }]),
      MOCK_DELAY_MS: '2600',
    },
  });
  const line = (r.stdout || '').toString().split('\n').find((l) => l.startsWith('RESULT '));
  const outcome = line ? JSON.parse(line.slice(7)) : null;
  const ok = outcome && outcome.ok === false && outcome.status === 504 && outcome.seen.length < 9;
  console.log(ok ? 'PASS' : 'FAIL', 'F: chain deadline cuts off slow 429 storm with honest 504', '—', JSON.stringify(outcome).slice(0, 160));
  if (!ok) failed++;
}

// G. provider answers 200 but the content is unparseable garbage: chatJson
// must give up after its bounded 3 attempts with an honest 502 — never loop
// forever and never return fabricated data.
{
  const r = spawnSync(process.execPath, ['-e', MOCK], {
    cwd: ROOT,
    timeout: 60000,
    env: {
      ...process.env,
      AI_BASE_URL: 'http://127.0.0.1:8098/v1', AI_API_KEY: 'k', AI_CHAT_MODEL: 'm1', AI_CHAT_MODEL_FALLBACKS: '',
      MOCK_PLAN: '[]',
      MOCK_BODY: 'Sorry, I cannot help with that request in JSON form.',
    },
  });
  const line = (r.stdout || '').toString().split('\n').find((l) => l.startsWith('RESULT '));
  const outcome = line ? JSON.parse(line.slice(7)) : null;
  // chatText (non-JSON) succeeds with garbage — that's expected; chatJson is
  // what must fail bounded. Probe chatJson directly in the same subprocess is
  // not possible via the shared MOCK, so assert on request count: chatText
  // makes exactly 1 request.
  const ok = outcome && outcome.ok === true && outcome.seen.length === 1;
  console.log(ok ? 'PASS' : 'FAIL', 'G-pre: free-text passes garbage through (by design)', '—', JSON.stringify(outcome).slice(0, 120));
  if (!ok) failed++;

  const r2 = spawnSync(process.execPath, ['-e', MOCK_JSON], {
    cwd: ROOT,
    timeout: 60000,
    env: {
      ...process.env,
      AI_BASE_URL: 'http://127.0.0.1:8098/v1', AI_API_KEY: 'k', AI_CHAT_MODEL: 'm1', AI_CHAT_MODEL_FALLBACKS: '',
      MOCK_PLAN: '[]',
      MOCK_BODY: 'Sorry, I cannot help with that request in JSON form.',
    },
  });
  const line2 = (r2.stdout || '').toString().split('\n').find((l) => l.startsWith('RESULT '));
  const outcome2 = line2 ? JSON.parse(line2.slice(7)) : null;
  const ok2 = outcome2 && outcome2.ok === false && outcome2.status === 502 && outcome2.seen.length === 3;
  console.log(ok2 ? 'PASS' : 'FAIL', 'G: malformed JSON output -> bounded 3 attempts, honest 502', '—', JSON.stringify(outcome2).slice(0, 140));
  if (!ok2) failed++;
}

console.log(failed === 0 ? 'ALL PASSED' : failed + ' FAILED');
process.exit(failed === 0 ? 0 : 1);
