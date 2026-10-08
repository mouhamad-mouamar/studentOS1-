/*
 * AI request-shape regression test.
 *
 * Guards against the "local-model is not a valid model ID" production bug:
 * spins up a mock OpenAI-compatible provider, calls chatText() and chatJson()
 * through the REAL dist-server ai module, and asserts the outbound request
 * body carries exactly the configured AI_CHAT_MODEL — never a fallback.
 *
 * Usage: node scripts/ai-request-shape-test.mjs
 */
const assert = require('node:assert');
const http = require('node:http');

process.env.AI_BASE_URL = 'http://127.0.0.1:8096/v1';
process.env.AI_API_KEY = 'mock-key';
process.env.AI_CHAT_MODEL = 'google/gemma-4-31b-it:free';
delete process.env.AI_EMBED_MODEL;

const seenBodies = [];
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    seenBodies.push(JSON.parse(raw || '{}'));
    const isJsonMode = !!seenBodies[seenBodies.length - 1].response_format;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: isJsonMode
              ? { content: '{"ok":true}' }
              : { content: 'Plain answer.' },
          },
        ],
      })
    );
  });
});

mock.listen(8096, '127.0.0.1', async () => {
  mock.unref();
  try {
    const ai = require(require('path').join(__dirname, '..', 'dist-server', 'ai.js'));
    await ai.chatText('system', 'user', 50);
    await ai.chatJson('system', 'user', null, 50);

    assert.strictEqual(seenBodies.length, 2, 'expected exactly 2 provider requests');
    for (const [i, body] of seenBodies.entries()) {
      assert.strictEqual(body.model, 'google/gemma-4-31b-it:free', `request ${i}: model must be the configured AI_CHAT_MODEL`);
      assert.notStrictEqual(body.model, 'local-model', `request ${i}: fallback "local-model" must never be sent`);
      assert.ok(Array.isArray(body.messages) && body.messages.length >= 2, `request ${i}: messages missing`);
    }
    // Call order: chatText (plain) first, then chatJson (json mode).
    assert.ok(!seenBodies[0].response_format, 'chatText should not send response_format');
    assert.ok(seenBodies[1].response_format, 'chatJson should request json mode');
    console.log('AI REQUEST SHAPE TEST PASSED');
    process.exit(0);
  } catch (e) {
    console.error('AI REQUEST SHAPE TEST FAILED:', e.message);
    process.exit(1);
  }
});
