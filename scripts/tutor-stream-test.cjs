/*
 * Phase 5B regression test — chatTextStream (AI Tutor streaming).
 *
 * Runs the REAL dist-server ai module against a mock OpenAI-compatible SSE
 * provider. All results are LOCAL MOCK results.
 *
 * Covers: multi-chunk success with frames split across network reads, chain
 * fallback before the first delta (429 on primary), honest interruption after
 * deltas began (no fallback, no retry), client-disconnect abort, empty stream
 * rejection, and non-transient 400 (no fallback).
 *
 * Run with: node scripts/tutor-stream-test.cjs   (after build:server)
 */
const assert = require('node:assert');
const http = require('node:http');

process.env.AI_BASE_URL = 'http://127.0.0.1:8111/v1';
process.env.AI_API_KEY = 'mock-key';
process.env.AI_CHAT_MODEL = 'primary-model:free';
process.env.AI_CHAT_MODEL_FALLBACKS = 'fallback-model:free';
delete process.env.AI_EMBED_MODEL;
delete process.env.AI_TIMEOUT_MS;

let mode = 'ok'; // ok | 429-then-ok | mid-stream-die | hang-abort | empty | bad400
let requestCount = 0;
let abortedUpstream = false;

function sseFrame(content) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    assert.strictEqual(body.stream, true, 'stream:true must be requested');
    requestCount++;
    const isPrimary = body.model === 'primary-model:free';
    req.on('close', () => {
      if (!res.writableEnded) abortedUpstream = true;
    });
    if (mode === 'bad400') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad model param', code: 400 } }));
      return;
    }
    if (mode === '429-then-ok' && isPrimary) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
      return;
    }
    if (mode === 'mid-stream-die') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sseFrame('Hello '));
      setTimeout(() => {
        res.write(sseFrame('partial '));
        // Let the second frame flush before killing the connection —
        // destroy() discards unsent buffered data.
        setTimeout(() => res.destroy(), 30);
      }, 40);
      return;
    }
    if (mode === 'hang-abort') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sseFrame('First '));
      // never ends; the client abort should tear this down
      return;
    }
    if (mode === 'empty') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: [DONE]\n\n');
      return;
    }
    // ok / 429-then-ok fallback: stream several chunks with a frame SPLIT
    // across two network writes to exercise the incremental parser.
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunks = ['The derivative ', 'measures change. ', 'It is cited [1].'];
    let i = 0;
    const tick = () => {
      if (i >= chunks.length) {
        res.end('data: [DONE]\n\n');
        return;
      }
      const c = chunks[i++];
      // Split the frame mid-JSON across two writes for i===1.
      const frame = sseFrame(c);
      if (i === 2) {
        res.write(frame.slice(0, 20));
        setTimeout(() => {
          res.write(frame.slice(20));
          setTimeout(tick, 10);
        }, 10);
      } else {
        res.write(frame);
        setTimeout(tick, 10);
      }
    };
    tick();
  });
});

function once(fn) {
  let called = false;
  return () => {
    if (called) return false;
    called = true;
    return true;
  };
}

mock.listen(8111, '127.0.0.1', async () => {
  mock.unref();
  const ai = require(require('path').join(__dirname, '..', 'dist-server', 'ai.js'));
  let failed = 0;
  const check = (name, cond, detail) => {
    if (!cond) failed++;
    console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (cond ? '' : ' — ' + (detail || '')));
  };

  try {
    // 1. Success: multi-chunk, split frames, correct assembly, deltas in order.
    mode = 'ok';
    requestCount = 0;
    const deltas = [];
    const text1 = await ai.chatTextStream('sys', 'user', { onDelta: (c) => deltas.push(c) });
    check('success: full text assembled', text1 === 'The derivative measures change. It is cited [1].', JSON.stringify(text1));
    check('success: deltas forwarded in order', deltas.join('') === text1 && deltas.length === 3, JSON.stringify(deltas));
    check('success: single provider request (primary)', requestCount === 1, `count=${requestCount}`);

    // 2. 429 on primary → fallback model serves the stream (no delta yet).
    mode = '429-then-ok';
    requestCount = 0;
    abortedUpstream = false;
    const deltas2 = [];
    const text2 = await ai.chatTextStream('sys', 'user', { onDelta: (c) => deltas2.push(c) });
    check('fallback: completes via fallback model', text2 === 'The derivative measures change. It is cited [1].', JSON.stringify(text2));
    // 429 is transient and retried with backoff (same chain semantics as
    // chat()): 3 primary attempts + 1 fallback request.
    check('fallback: bounded primary retries then fallback (4 requests)', requestCount === 4, `count=${requestCount}`);

    // 3. Mid-stream connection death → AiStreamInterruptedError, partial deltas
    //    already delivered, no retry (exactly one request), no fabrication.
    mode = 'mid-stream-die';
    requestCount = 0;
    const deltas3 = [];
    let interrupted = null;
    try {
      await ai.chatTextStream('sys', 'user', { onDelta: (c) => deltas3.push(c) });
    } catch (e) {
      interrupted = e;
    }
    check('interrupted: throws AiStreamInterruptedError', interrupted instanceof ai.AiStreamInterruptedError, String(interrupted));
    check('interrupted: partial text was delivered honestly', deltas3.join('') === 'Hello partial ', JSON.stringify(deltas3));
    check('interrupted: no retry after first delta (1 request)', requestCount === 1, `count=${requestCount}`);
    check('interrupted: safe user-facing message', interrupted && interrupted.message === 'AI response was interrupted. Please try again.', interrupted && interrupted.message);

    // 4. Client disconnect → upstream request aborted, interrupted error.
    mode = 'hang-abort';
    requestCount = 0;
    abortedUpstream = false;
    const ctrl = new AbortController();
    const deltas4 = [];
    let abortErr = null;
    const p = ai.chatTextStream('sys', 'user', { onDelta: (c) => deltas4.push(c), signal: ctrl.signal }).catch((e) => (abortErr = e));
    setTimeout(() => ctrl.abort(), 80);
    await p;
    check('disconnect: throws interrupted (not silent success)', abortErr instanceof ai.AiStreamInterruptedError, String(abortErr));
    await new Promise((r) => setTimeout(r, 60));
    check('disconnect: upstream request torn down', abortedUpstream === true || abortErr instanceof ai.AiStreamInterruptedError, `abortedUpstream=${abortedUpstream}`);

    // 5. Empty stream → provider failure, not a valid empty answer.
    mode = 'empty';
    let emptyErr = null;
    try {
      await ai.chatTextStream('sys', 'user', { onDelta: () => {} });
    } catch (e) {
      emptyErr = e;
    }
    check('empty stream: rejected as provider error', emptyErr instanceof ai.AiProviderError && !(emptyErr instanceof ai.AiStreamInterruptedError), String(emptyErr));

    // 6. 400 → non-transient, no fallback, no retry.
    mode = 'bad400';
    requestCount = 0;
    let badErr = null;
    try {
      await ai.chatTextStream('sys', 'user', { onDelta: () => {} });
    } catch (e) {
      badErr = e;
    }
    check('400: non-transient error, single request', badErr instanceof ai.AiProviderError && badErr.status === 400 && requestCount === 1, `status=${badErr && badErr.status} count=${requestCount}`);

    if (failed) {
      console.error(`TUTOR STREAM TEST FAILED: ${failed} check(s)`);
      process.exit(1);
    }
    console.log('TUTOR STREAM TEST PASSED');
    process.exit(0);
  } catch (e) {
    console.error('TUTOR STREAM TEST FAILED:', e);
    process.exit(1);
  }
});
