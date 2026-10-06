// StudyOS API smoke test (run against a locally started server).
// Usage: node scripts/smoke-test.mjs <baseUrl> <tokenFile1> <tokenFile2>
import fs from 'fs';

const base = process.argv[2] || 'http://localhost:8899';
const token = fs.readFileSync(process.argv[3] || process.env.TEMP + '\\demo_token.txt', 'utf8').trim();
const token2 = process.argv[4] ? fs.readFileSync(process.argv[4], 'utf8').trim() : null;
const USER1 = process.argv[5] || fs.readFileSync(process.env.TEMP + '\\demo_uid.txt', 'utf8').trim();

const SUPA = 'https://supabase-api-prod.verdent.ai/p/p9052fdee286a2668429f';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoyMTA2OTAyMDg2LCJpYXQiOjE3OTEyODI4ODYsImlzcyI6InN1cGFiYXNlIiwicHJvamVjdF9yZWYiOiJwOTA1MmZkZWUyODZhMjY2ODQyOWYiLCJyb2xlIjoiYW5vbiJ9.6kre7yWu80xczttItHpDPtzi0WRY8GQNkmS4MH45yPg';

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${cond ? '' : ' :: ' + extra}`);
  if (!cond) failures++;
}

async function api(path, { method = 'GET', body, tok = token } = {}) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

// 1. courses list
let r = await api('/courses');
check('GET /courses 200', r.status === 200 && Array.isArray(r.data.courses), JSON.stringify(r.data).slice(0, 100));

// 2. create course
r = await api('/courses', { method: 'POST', body: { name: 'Mathematics 101', code: 'MATH101', exam_date: '2026-10-20' } });
check('POST /courses 200', r.status === 200 && r.data.course?.id, JSON.stringify(r.data).slice(0, 200));
const courseId = r.data.course.id;

// 3. bad input rejected
r = await api('/courses', { method: 'POST', body: { name: '' } });
check('POST /courses empty name rejected', r.status === 400);

// 4. upload a material through storage (direct, like the browser does)
const fileBody = `Integration by Parts\n\nThis is very important and will be on the exam.\n\nThe integration by parts formula is: integral u dv = uv - integral v du.\n\nRemember this: choose u by the LIATE rule (Logarithmic, Inverse trig, Algebraic, Trigonometric, Exponential).\n\nExample: integral x*e^x dx = x*e^x - e^x + C.\n\nA common mistake is picking u = e^x.`;
const upRes = await fetch(`${SUPA}/storage/v1/object/materials/${USER1}/${courseId}/test-lecture.txt`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, apikey: ANON, 'Content-Type': 'text/plain', 'x-upsert': 'true' },
  body: fileBody,
});
check('storage upload 200', upRes.ok, await upRes.text());

// 5. register material -> triggers ingestion
r = await api(`/courses/${courseId}/materials`, { method: 'POST', body: { filename: 'lecture-4.txt', storage_path: `${USER1}/${courseId}/test-lecture.txt`, mime: 'text/plain', size: fileBody.length } });
check('POST material 200', r.status === 200 && r.data.material?.id, JSON.stringify(r.data).slice(0, 200));
const materialId = r.data.material.id;

// 6. wait for ingestion to finish
let mat;
for (let i = 0; i < 20; i++) {
  await new Promise((res) => setTimeout(res, 1000));
  const list = await api(`/courses/${courseId}/materials`);
  mat = list.data.materials.find((m) => m.id === materialId);
  if (mat && (mat.status === 'ready' || mat.status === 'failed')) break;
}
check('material ingestion ready', mat?.status === 'ready', JSON.stringify(mat).slice(0, 200));

// 7. chunks were created (query via course detail / concepts is indirect; use materials char_count)
check('char_count > 0', (mat?.char_count || 0) > 0, String(mat?.char_count));

// 8. AI endpoints honest when unconfigured
// (429 is also acceptable: another suite may have exhausted the per-minute AI budget)
r = await api(`/courses/${courseId}/tutor`, { method: 'POST', body: { question: 'Explain integration by parts' } });
check('tutor 503 AI_NOT_CONFIGURED (no key) or 429 rate-limited', (r.status === 503 && r.data.error === 'AI_NOT_CONFIGURED') || r.status === 429, JSON.stringify(r.data).slice(0, 120));

// 9. recommendations + dashboard work without AI
r = await api('/recommendations?minutes=25');
check('GET /recommendations 200', r.status === 200 && Array.isArray(r.data.recommendations));
r = await api('/dashboard');
check('GET /dashboard 200', r.status === 200 && Array.isArray(r.data.courses));

// 10. quick study session
r = await api(`/courses/${courseId}/sessions`, { method: 'POST', body: { minutes: 25, mode: 'quick' } });
check('POST /sessions 200', r.status === 200 && r.data.session?.id, JSON.stringify(r.data).slice(0, 200));

// 11. manual flashcard + SRS review
r = await api('/flashcards', { method: 'POST', body: { course_id: courseId, front: 'What is the integration by parts formula?', back: '∫u dv = uv − ∫v du' } });
check('POST /flashcards 200', r.status === 200 && r.data.card?.id, JSON.stringify(r.data).slice(0, 200));
const cardId = r.data.card.id;
r = await api(`/flashcards/${cardId}/review`, { method: 'POST', body: { result: 'good' } });
check('review good schedules future', r.status === 200 && new Date(r.data.card.due_at) > new Date(Date.now() + 20 * 3600_000), JSON.stringify(r.data).slice(0, 200));
r = await api(`/flashcards/${cardId}/review`, { method: 'POST', body: { result: 'again' } });
check('review again makes due soon', r.status === 200 && new Date(r.data.card.due_at) < new Date(Date.now() + 3600_000));

// 12. course summary levels (deterministic, evidence-based)
r = await api(`/courses/${courseId}/summary?level=full`);
check('GET summary full 200', r.status === 200 && r.data.summary?.level === 'full' && Array.isArray(r.data.summary.topics), JSON.stringify(r.data).slice(0, 200));
check('summary has sources tied to real material', r.data.summary.sources.some((s) => s.filename.includes('lecture-4')), JSON.stringify(r.data.summary.sources).slice(0, 200));
check('summary overview is honest about state', /concept/i.test(r.data.summary.overview), r.data.summary.overview.slice(0, 150));
r = await api(`/courses/${courseId}/summary?level=cram`);
check('GET summary cram 200 + filters to high priority', r.status === 200 && r.data.summary.topics.every((c) => c.priority === 'MUST_KNOW'), JSON.stringify(r.data.summary.topics?.map((t) => t.priority)).slice(0, 120));
r = await api(`/courses/${courseId}/summary?level=bogus`);
check('summary invalid level falls back to study', r.status === 200 && r.data.summary.level === 'study');

// 13. what actually matters (this course has no concepts yet — concept extraction
// needs AI — so an honest empty list is the correct result; the with-data case
// is covered in smoke-test-2)
r = await api(`/courses/${courseId}/what-matters?minutes=60`);
check('GET what-matters 200 (empty course → honest empty list)', r.status === 200 && Array.isArray(r.data.items) && r.data.items.length === 0, JSON.stringify(r.data).slice(0, 200));

// 14. ask my course: deterministic answers work WITHOUT AI
r = await api(`/courses/${courseId}/ask`, { method: 'POST', body: { question: 'What are the most important topics?' } });
check('ask important topics answered from data (no AI)', r.status === 200 && r.data.grounded === true && /most important topics/i.test(r.data.answer), JSON.stringify(r.data).slice(0, 250));
r = await api(`/courses/${courseId}/ask`, { method: 'POST', body: { question: 'If I have 30 minutes, what should I study?' } });
check('ask minutes budget answered from data', r.status === 200 && /30 minutes/.test(r.data.answer), JSON.stringify(r.data).slice(0, 250));
r = await api(`/courses/${courseId}/ask`, { method: 'POST', body: { question: 'What formulas do I need to know?' } });
check('ask formulas answered (honest empty state)', r.status === 200 && /formula/i.test(r.data.answer), JSON.stringify(r.data).slice(0, 250));
r = await api(`/courses/${courseId}/ask`, { method: 'POST', body: { question: 'What am I weak at?' } });
check('ask weaknesses answered honestly', r.status === 200 && /weak/i.test(r.data.answer), JSON.stringify(r.data).slice(0, 250));
// open-ended question falls back to AI → honest 503 (or 429 if another suite exhausted budget)
r = await api(`/courses/${courseId}/ask`, { method: 'POST', body: { question: 'Explain the LIATE rule with an example' } });
check('ask open question falls back to AI (503/429 honest)', (r.status === 503 && r.data.error === 'AI_NOT_CONFIGURED') || r.status === 429, JSON.stringify(r.data).slice(0, 150));
// deep AI analysis: honest 503 when no key (or 400 if no concepts... concepts exist here, so 503/429)
r = await api(`/courses/${courseId}/analyze`, { method: 'POST' });
check('analyze 503 AI_NOT_CONFIGURED or 429', (r.status === 503 && r.data.error === 'AI_NOT_CONFIGURED') || r.status === 429, JSON.stringify(r.data).slice(0, 150));

// 15. cross-user isolation: second user cannot read user 1's course
if (token2) {
  r = await api(`/courses/${courseId}`, { tok: token2 });
  check('cross-user course read blocked', r.status === 404, `status=${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
  r = await api(`/courses/${courseId}/summary`, { tok: token2 });
  check('cross-user summary blocked', r.status === 404, `status=${r.status}`);
  r = await api(`/courses/${courseId}/what-matters`, { tok: token2 });
  check('cross-user what-matters blocked', r.status === 404, `status=${r.status}`);
  r = await api(`/courses/${courseId}/ask`, { method: 'POST', body: { question: 'important topics?' }, tok: token2 });
  check('cross-user ask blocked', r.status === 404, `status=${r.status}`);
  r = await api('/courses', { tok: token2 });
  check('other user sees no courses', r.status === 200 && r.data.courses.length === 0, JSON.stringify(r.data).slice(0, 120));
}

// 13. cross-user storage write blocked (different prefix)
const up2 = await fetch(`${SUPA}/storage/v1/object/materials/${USER1}/${courseId}/intruder.txt`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token2 || token}`, apikey: ANON, 'Content-Type': 'text/plain' },
  body: 'intruder',
});
if (token2) check('cross-user storage upload blocked', !up2.ok, `status=${up2.status}`);

console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
