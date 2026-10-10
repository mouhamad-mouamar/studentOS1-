/*
 * Phase 5A P1 regression test — parallel concept+formula extraction.
 *
 * Runs processMaterial() from the REAL dist-server ingest module against a
 * mock OpenAI-compatible provider and a mock Supabase client.
 *
 * Verifies:
 *   1. Concept and formula extraction requests OVERLAP (concurrent, not
 *      sequential) — mock adds 300ms latency per call; total must be < 550ms
 *      and max in-flight requests must be 2.
 *   2. Concept-pass failure keeps the formula pass result (and vice versa).
 *   3. Both failing leaves the material 'ready' with an honest
 *      CONCEPTS_FAILED annotation and no partial persistence.
 *
 * Run with: node scripts/ingest-parallel-test.cjs   (after build:server)
 */
const assert = require('node:assert');
const http = require('node:http');

process.env.AI_BASE_URL = 'http://127.0.0.1:8099/v1';
process.env.AI_API_KEY = 'mock-key';
process.env.AI_CHAT_MODEL = 'google/gemma-4-31b-it:free';
delete process.env.AI_EMBED_MODEL;
delete process.env.AI_CHAT_MODEL_FALLBACKS;

const LATENCY_MS = 300;
let mode = 'both-ok'; // both-ok | concept-fail | formula-fail | both-fail
let active = 0;
let maxActive = 0;
let seenPrompts = [];

const CONCEPTS_BODY = JSON.stringify({
  concepts: [{ title: 'Derivative', summary: 'rate of change', definition: '', importance: 90 }],
});
const FORMULAS_BODY = JSON.stringify({
  formulas: [{ name: 'Power rule', expression: 'd/dx x^n = n*x^(n-1)', explanation: '', concept_title: 'Derivative' }],
});

const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const sys = (body.messages || []).find((m) => m.role === 'system')?.content || '';
    const isConcepts = /academic content analyzer/.test(sys);
    const isFormulas = /extract mathematical and scientific formulas/.test(sys);
    seenPrompts.push({ isConcepts, isFormulas });
    active++;
    maxActive = Math.max(maxActive, active);
    setTimeout(() => {
      active--;
      const fail = (isConcepts && (mode === 'concept-fail' || mode === 'both-fail')) || (isFormulas && (mode === 'formula-fail' || mode === 'both-fail'));
      if (fail) {
        // 400 = non-retryable, so a failing pass costs exactly one request.
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock 400', code: 400 } }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: isConcepts ? CONCEPTS_BODY : FORMULAS_BODY } }] }));
      }
    }, LATENCY_MS);
  });
});

function makeMockSupabase() {
  const state = { materialUpdates: [], conceptUpserts: [], formulaInserts: [], chunkInserts: [] };
  const matRow = {
    id: 'mat-1',
    user_id: 'user-1',
    course_id: 'course-1',
    filename: 'lecture.txt',
    mime: 'text/plain',
    kind: 'text',
    storage_path: 'user-1/course-1/mat-1',
    status: 'processing',
  };
  const okResult = { data: null, error: null };
  function chain(table) {
    const q = {
      select: () => q,
      eq: () => q,
      order: () => q,
      limit: () => q,
      update: (u) => { state.materialUpdates.push({ table, update: u }); return q; },
      delete: () => q,
      insert: (rows) => {
        const arr = Array.isArray(rows) ? rows : [rows];
        if (table === 'formulas') state.formulaInserts.push(...arr);
        if (table === 'chunks') state.chunkInserts.push(...arr);
        return q;
      },
      upsert: (u) => {
        if (table === 'concepts') state.conceptUpserts.push(u);
        return q;
      },
      maybeSingle: () => Promise.resolve({ data: table === 'materials' ? matRow : table === 'concepts' ? { id: 'concept-1' } : null, error: null }),
      then: (resolve, reject) =>
        Promise.resolve({ data: table === 'formulas' ? [] : table === 'materials' ? matRow : null, error: null }).then(resolve, reject),
    };
    return q;
  }
  return {
    state,
    from: (table) => chain(table),
    storage: { from: () => ({ download: async () => {
      const b = Buffer.from('The derivative measures rate of change. Important: chain rule. Exam topic.', 'utf8');
      // Slice the pooled ArrayBuffer: Buffer.from(str).buffer can be larger than
      // the string and would leak unrelated process memory into extraction.
      return { data: { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }, error: null };
    } }) },
  };
}

function lastMaterialUpdate(state) {
  return state.materialUpdates.filter((u) => u.table === 'materials').slice(-1)[0]?.update || null;
}

mock.listen(8099, '127.0.0.1', async () => {
  mock.unref();
  const ingest = require(require('path').join(__dirname, '..', 'dist-server', 'ingest.js'));
  let failed = 0;
  // Immediate evaluation: each check runs right after its case, so closures
  // always see that case's own mock client and request log.
  const check = (name, fn, detail) => {
    let ok = false;
    try { ok = fn(); } catch {}
    if (!ok) failed++;
    console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (ok ? '' : ' — ' + (detail || '')));
  };

  try {
    // ---- Case 1: both passes succeed + concurrency ----
    let client = makeMockSupabase();
    seenPrompts = [];
    maxActive = 0;
    const t0 = Date.now();
    await ingest.processMaterial(client, 'mat-1');
    const elapsed = Date.now() - t0;
    check('case1: concept upserted', () => client.state.conceptUpserts.length === 1 && client.state.conceptUpserts[0].title === 'Derivative', JSON.stringify(client.state.conceptUpserts));
    check('case1: formula inserted', () => client.state.formulaInserts.length === 1 && client.state.formulaInserts[0].name === 'Power rule', JSON.stringify(client.state.formulaInserts));
    check('case1: material ready, no error', () => {
      const u = lastMaterialUpdate(client.state);
      return u && u.status === 'ready' && !u.error;
    }, JSON.stringify(lastMaterialUpdate(client.state)));
    check('case1: requests overlapped (maxActive=2)', () => maxActive === 2, `maxActive=${maxActive}`);
    check('case1: wall-clock < sequential (550ms)', () => elapsed < 550, `elapsed=${elapsed}ms`);
    check('case1: exactly one request per pass', () => seenPrompts.filter((p) => p.isConcepts).length === 1 && seenPrompts.filter((p) => p.isFormulas).length === 1, `seenPrompts=${JSON.stringify(seenPrompts)}`);

    // ---- Case 2: concept pass fails, formula pass survives ----
    client = makeMockSupabase();
    mode = 'concept-fail';
    seenPrompts = [];
    maxActive = 0;
    await ingest.processMaterial(client, 'mat-1');
    check('case2: formula result preserved', () => client.state.formulaInserts.length === 1, JSON.stringify(client.state.formulaInserts));
    check('case2: no concepts persisted', () => client.state.conceptUpserts.length === 0);
    check('case2: honest CONCEPTS_FAILED annotation', () => {
      const u = lastMaterialUpdate(client.state);
      return u && u.status === 'ready' && String(u.error || '').startsWith('CONCEPTS_FAILED:502');
    }, JSON.stringify(lastMaterialUpdate(client.state)));
    check('case2: concurrent even under failure (maxActive=2)', () => maxActive === 2, `maxActive=${maxActive}`);

    // ---- Case 3: formula pass fails, concept pass survives ----
    client = makeMockSupabase();
    mode = 'formula-fail';
    seenPrompts = [];
    maxActive = 0;
    await ingest.processMaterial(client, 'mat-1');
    check('case3: concept result preserved', () => client.state.conceptUpserts.length === 1);
    check('case3: no formulas persisted', () => client.state.formulaInserts.length === 0);
    check('case3: material ready, no error', () => {
      const u = lastMaterialUpdate(client.state);
      return u && u.status === 'ready' && !u.error;
    }, JSON.stringify(lastMaterialUpdate(client.state)));

    // ---- Case 4: both passes fail ----
    client = makeMockSupabase();
    mode = 'both-fail';
    seenPrompts = [];
    maxActive = 0;
    await ingest.processMaterial(client, 'mat-1');
    check('case4: no partial persistence', () => client.state.conceptUpserts.length === 0 && client.state.formulaInserts.length === 0);
    check('case4: material ready with CONCEPTS_FAILED (not deleted/failed)', () => {
      const u = lastMaterialUpdate(client.state);
      return u && u.status === 'ready' && String(u.error || '').startsWith('CONCEPTS_FAILED:502');
    }, JSON.stringify(lastMaterialUpdate(client.state)));

    if (failed) {
      console.error(`INGEST PARALLEL TEST FAILED: ${failed} check(s)`);
      process.exit(1);
    }
    console.log('INGEST PARALLEL TEST PASSED');
    process.exit(0);
  } catch (e) {
    console.error('INGEST PARALLEL TEST FAILED:', e);
    process.exit(1);
  }
});
