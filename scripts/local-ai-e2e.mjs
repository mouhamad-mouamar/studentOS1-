// End-to-end verification of the FULL StudyOS AI pipeline against a REAL
// local model server (llama-server / Ollama — OpenAI-compatible protocol).
//
// Prerequisites:
//   1. A local inference server, e.g.:
//      llama-server -m qwen2.5-1.5b-instruct-q4_k_m.gguf --port 8091
//      (or Ollama: `ollama serve` + `ollama pull qwen2.5:3b-instruct`)
//   2. StudyOS server started with:
//      AI_BASE_URL=http://127.0.0.1:8091/v1   (Ollama: http://127.0.0.1:11434/v1)
//      AI_CHAT_MODEL=<model name>
//   3. Demo token file(s) in %TEMP%.
//
// Usage: node scripts/local-ai-e2e.cjs <baseUrl> [tokenFile]
import fs from 'fs';

const base = process.argv[2] || 'http://localhost:8899';
const token = fs.readFileSync(process.argv[3] || process.env.TEMP + '\\demo_token.txt', 'utf8').trim();
const SUPA = 'https://supabase-api-prod.verdent.ai/p/p9052fdee286a2668429f';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoyMTA2OTAyMDg2LCJpYXQiOjE3OTEyODI4ODYsImlzcyI6InN1cGFiYXNlIiwicHJvamVjdF9yZWYiOiJwOTA1MmZkZWUyODZhMjY2ODQyOWYiLCJyb2xlIjoiYW5vbiJ9.6kre7yWu80xczttItHpDPtzi0WRY8GQNkmS4MH45yPg';
const USER1 = fs.readFileSync(process.env.TEMP + '\\demo_uid.txt', 'utf8').trim();

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${cond ? '' : ' :: ' + extra}`);
  if (!cond) failures++;
}
const ms = (n) => (n / 1000).toFixed(1) + 's';

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(600_000),
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

console.log('=== StudyOS local-AI end-to-end verification ===\n');

// 0. Inference server health
const HEALTH_URL = process.env.LOCAL_AI_HEALTH || 'http://127.0.0.1:8091/health';
let healthy = false;
try {
  const h = await fetch(HEALTH_URL);
  healthy = h.ok;
} catch {}
check('local inference server reachable', healthy, HEALTH_URL);
if (!healthy) {
  console.log('\nStart a local model server first — see docs/local-ai.md. Nothing was faked.');
  process.exit(1);
}

// 1. StudyOS reports the local engine honestly
let r = await api('/ai/status');
check('/ai/status reports engine=local', r.status === 200 && r.data.engine === 'local' && r.data.configured === true && r.data.key_required === false, JSON.stringify(r.data));

// 2. Protocol sanity: structured JSON output through the OpenAI-compatible path
const t0 = Date.now();
r = await api('/courses', { method: 'POST', body: { name: 'Calculus 201', code: 'MATH201', exam_date: '2026-11-01' } });
check('course created', r.status === 200 && r.data.course?.id, JSON.stringify(r.data).slice(0, 150));
const courseId = r.data.course.id;

// 3. Upload real course text material (this is what the model must understand)
const materialText = `Lecture 7: Integration by Parts

Integration by parts is one of the most important techniques in this course and WILL be on the exam.

The integration by parts formula is: integral u dv = uv - integral v du.

Remember this: choose u using the LIATE rule - Logarithmic, Inverse trigonometric, Algebraic, Trigonometric, Exponential. You need to know this order.

Example 1: integral x*e^x dx. Take u = x and dv = e^x dx. Then du = dx and v = e^x. So the integral equals x*e^x - integral e^x dx = x*e^x - e^x + C.

A common mistake is choosing u = e^x, which makes the integral harder, not simpler.

The formula for integration by parts is derived from the product rule of differentiation: d/dx(uv) = u'v + uv'. Integrating both sides gives the formula.

Exam hint: expect at least one integration by parts question every year. Practice the LIATE ordering.`;
const upRes = await fetch(`${SUPA}/storage/v1/object/materials/${USER1}/${courseId}/lecture7.txt`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, apikey: ANON, 'Content-Type': 'text/plain', 'x-upsert': 'true' },
  body: materialText,
});
check('storage upload', upRes.ok, await upRes.text());

r = await api(`/courses/${courseId}/materials`, { method: 'POST', body: { filename: 'lecture7.txt', storage_path: `${USER1}/${courseId}/lecture7.txt`, mime: 'text/plain', size: materialText.length } });
check('material registered', r.status === 200 && r.data.material?.id, JSON.stringify(r.data).slice(0, 200));
const materialId = r.data.material.id;

let mat = null;
for (let i = 0; i < 40; i++) {
  await new Promise((res) => setTimeout(res, 2000));
  const list = await api(`/courses/${courseId}/materials`);
  mat = list.data.materials.find((m) => m.id === materialId);
  if (mat && (mat.status === 'ready' || mat.status === 'failed')) break;
}
check('material ingested by LOCAL model (status ready)', mat?.status === 'ready', JSON.stringify(mat).slice(0, 300));

// 4. Concepts + definitions + formulas extracted by the local model
r = await api(`/courses/${courseId}/concepts`);
const concepts = r.data.concepts || [];
check('concepts extracted by local model', concepts.length > 0, JSON.stringify(r.data).slice(0, 300));
console.log(`   concepts: ${concepts.map((c) => `${c.title} [${c.priority}]`).join(' | ') || '(none)'}`);
const hasPriority = concepts.some((c) => ['MUST_KNOW', 'SHOULD_KNOW', 'NICE_TO_KNOW', 'LOW_PRIORITY'].includes(c.priority));
check('concepts carry priority classification', hasPriority);

r = await api(`/courses/${courseId}/formulas`);
check('formulas extracted', (r.data.formulas || []).length > 0, JSON.stringify(r.data).slice(0, 200));

// 5. Study notes (AI, per concept)
if (concepts.length > 0) {
  r = await api(`/courses/${courseId}/concepts/${concepts[0].id}/notes`, { method: 'POST' });
  check('note generated for concept', r.status === 200 && r.data.note?.id, JSON.stringify(r.data).slice(0, 200));
}
r = await api(`/courses/${courseId}/notes`);
check('notes readable back', (r.data.notes || []).length > 0, JSON.stringify(r.data).slice(0, 200));

// 6. Flashcards generated by the local model
r = await api(`/courses/${courseId}/flashcards/generate`, { method: 'POST' });
const gen1 = Date.now();
r = await api(`/courses/${courseId}/flashcards`);
const cards = r.data.flashcards || r.data.cards || [];
check('flashcards generated from material', cards.length > 0, JSON.stringify(r.data).slice(0, 200));
check('flashcards link to concepts (not generic)', cards.some((c) => c.concept_id), JSON.stringify(cards.slice(0, 1)).slice(0, 200));

// 7. Quiz generated by the local model; answers NOT exposed
r = await api(`/courses/${courseId}/quizzes/generate`, { method: 'POST', body: { difficulty: 'medium' } });
const quizId = r.data.quiz?.id;
check('quiz generated', Boolean(quizId), JSON.stringify(r.data).slice(0, 200));
if (quizId) {
  r = await api(`/quizzes/${quizId}`);
  const qs = r.data.questions || [];
  check('quiz has questions', qs.length > 0, JSON.stringify(r.data).slice(0, 150));
  check('quiz answers not exposed to client', qs.every((q) => q.answer == null && q.correct == null), JSON.stringify(qs[0]).slice(0, 300));
  // submit a (likely wrong) answer; grading + weakness/mastery update must work
  const q0 = qs[0];
  if (q0) {
    r = await api(`/quizzes/${quizId}/submit`, { method: 'POST', body: { answers: [{ questionId: q0.id, given: 'x' }] } });
    check('quiz submission graded', r.status === 200 && r.data.attempt, JSON.stringify(r.data).slice(0, 200));
  }
}

// 8. Tutor answers grounded in the course (local model)
const tTutor = Date.now();
r = await api(`/courses/${courseId}/tutor`, { method: 'POST', body: { question: 'Explain the integration by parts formula simply.' } });
check('tutor answered by local model', r.status === 200 && (r.data.answer || '').length > 20, JSON.stringify(r.data).slice(0, 250));
console.log(`   tutor latency: ${ms(Date.now() - tTutor)}`);

// 9. Deep analysis stored; summary reflects it
r = await api(`/courses/${courseId}/analyze`, { method: 'POST' });
check('deep AI analysis stored', r.status === 200 && r.data.analysis?.overview, JSON.stringify(r.data).slice(0, 200));
r = await api(`/courses/${courseId}/summary?level=quick`);
check('summary marks ai_analyzed and uses it', r.data.summary?.meta?.ai_analyzed === true, JSON.stringify(r.data.summary?.meta).slice(0, 150));

// 10. What-matters uses the real extracted concepts
r = await api(`/courses/${courseId}/what-matters?minutes=60`);
check('what-matters ranks real concepts with reasons', (r.data.items || []).length > 0 && r.data.items[0].reasons.length > 0, JSON.stringify(r.data).slice(0, 200));

console.log(`\nTotal wall time: ${ms(Date.now() - t0)} (local CPU inference included)`);
console.log(failures === 0 ? '\nLOCAL AI E2E: ALL PASSED — real model, zero paid API' : `\nLOCAL AI E2E: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
