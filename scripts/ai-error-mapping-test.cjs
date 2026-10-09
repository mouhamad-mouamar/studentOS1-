// Regression tests for the two production failures after 2ff7973:
//
// 1. AI errors were flattened to HTTP 502 with the human message in the
//    error-code field, so rate limits/timeouts surfaced as the generic
//    "AI could not complete this request." — aiHttpStatus() now maps
//    honestly (429/503/504 kept, raw provider bodies never leaked).
// 2. pdf.js (inside pdf-parse) threw "DOMMatrix is not defined" for PDFs
//    whose content streams use patterns/images — extraction now installs a
//    2D DOMMatrix shim before the import.
//
// Run with: node scripts/ai-error-mapping-test.cjs   (after build:server)
const path = require('path');
const ai = require(path.join(__dirname, '..', 'dist-server', 'ai.js'));
const extract = require(path.join(__dirname, '..', 'dist-server', 'extract.js'));

let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log('PASS', name);
  else {
    failed++;
    console.log('FAIL', name, detail ? `— ${detail}` : '');
  }
}

// ---------- 1. aiHttpStatus mapping ----------
const { AiProviderError, AiNotConfiguredError, aiHttpStatus } = ai;

let m = aiHttpStatus(new AiNotConfiguredError());
check('not-configured → 503 AI_NOT_CONFIGURED', m.status === 503 && m.message === 'AI_NOT_CONFIGURED', JSON.stringify(m));

m = aiHttpStatus(new AiProviderError(429, 'AI is temporarily rate-limited. Please try again shortly.'));
check('429 stays 429 with friendly message', m.status === 429 && m.message.includes('rate-limited'), JSON.stringify(m));

m = aiHttpStatus(new AiProviderError(504, 'AI provider timed out'));
check('timeout → 504', m.status === 504 && m.message === 'AI provider timed out', JSON.stringify(m));

m = aiHttpStatus(new AiProviderError(503, 'AI provider busy (503)'));
check('503 stays 503, generic message', m.status === 503 && m.message === 'AI is currently unavailable. Please try again.', JSON.stringify(m));

m = aiHttpStatus(new AiProviderError(400, 'AI chat failed (400): {"error":{"message":"secret-internal-body","code":400}}'));
check('400 collapses to 502 without leaking provider body', m.status === 502 && m.message === 'AI could not complete this request. Please try again.' && !m.message.includes('secret-internal-body'), JSON.stringify(m));

m = aiHttpStatus(new AiProviderError(502, 'AI returned invalid structured output'));
check('structured-output failure keeps its own message', m.status === 502 && m.message === 'AI returned invalid structured output', JSON.stringify(m));

m = aiHttpStatus(new Error('fetch failed'));
check('unknown error → generic 502', m.status === 502 && m.message === 'AI could not complete this request. Please try again.', JSON.stringify(m));

// ---------- 2. chat() propagates provider 429 through the fallback chain ----------
// ai.js reads env at import time, so provider-dependent checks run in a fresh
// subprocess with a mock provider.
(async () => {
  const { spawnSync } = require('child_process');

  const sub = spawnSync(process.execPath, [
    '-e',
    `
    process.env.AI_BASE_URL = 'http://127.0.0.1:8097/v1';
    process.env.AI_API_KEY = 'test-key';
    process.env.AI_CHAT_MODEL = 'test-model';
    const path = require('path');
    const ai = require(path.join(process.cwd(), 'dist-server', 'ai.js'));
    const http = require('http');
    let hits = 0;
    const srv = http.createServer((req, res) => {
      hits++;
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
    });
    srv.listen(8097, '127.0.0.1', async () => {
      srv.unref();
      try {
        await ai.chatText('system', 'user');
        console.log('SUBFAIL: no error thrown');
      } catch (e) {
        const ok = e instanceof ai.AiProviderError && e.status === 429;
        console.log('SUB ' + (ok ? 'PASS' : 'FAIL') + ' 429 propagates as AiProviderError(429)');
        const mapped = ai.aiHttpStatus(e);
        const ok2 = mapped.status === 429 && mapped.message.includes('rate-limited');
        console.log('SUB ' + (ok2 ? 'PASS' : 'FAIL') + ' aiHttpStatus(429-err) honest mapping');
      }
      srv.close();
      process.exit(0);
    });
    `,
  ], { cwd: path.join(__dirname, '..'), timeout: 60000 });

  const out = (sub.stdout || '').toString();
  for (const line of out.split('\n').filter((l) => l.startsWith('SUB'))) {
    const ok = line.includes('PASS');
    if (!ok) failed++;
    console.log(line.replace('SUB ', ''));
  }
  if (!out.includes('429 propagates')) { failed++; console.log('FAIL subprocess for 429 propagation did not run —', (sub.stderr || '').toString().slice(0, 300)); }

  // ---------- 3. DOMMatrix shim + image-bearing PDF extraction ----------
  const fs = require('fs');
  const diagPdf = path.join(__dirname, 'diag-image.pdf');
  if (!fs.existsSync(diagPdf)) {
    failed++;
    console.log('FAIL diag-image.pdf missing — run: node scripts/make-diag-pdf.cjs scripts/diag-image.pdf');
  } else {
    try {
      const before = typeof globalThis.DOMMatrix;
      const r = await extract.extractText('pdf', fs.readFileSync(diagPdf));
      const shimOk = before === 'undefined' && typeof globalThis.DOMMatrix !== 'undefined';
      check('DOMMatrix shim installed after pdf extraction', shimOk, `before=${before} after=${typeof globalThis.DOMMatrix}`);
      check('image-bearing PDF extracts text (no DOMMatrix crash)', (r.text || '').includes('Kinematics'), JSON.stringify(r).slice(0, 120));
    } catch (e) {
      failed++;
      console.log('FAIL image-bearing PDF extraction —', e.message);
    }
  }

  console.log(failed === 0 ? 'ALL PASSED' : `${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
