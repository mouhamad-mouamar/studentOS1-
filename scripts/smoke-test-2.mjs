// StudyOS extended integration tests (cycle 2).
// Verifies: cross-resource cross-user authorization, quiz answer non-exposure,
// file validation, rate limiting, and the full study loop
// (quiz -> weakness/mastery -> recommendations -> session targets weakness).
// Usage: node scripts/smoke-test-2.mjs <baseUrl> <tokenFile1> <tokenFile2> <userId1>
import fs from 'fs';

const base = process.argv[2] || 'http://localhost:8899';
const token = fs.readFileSync(process.argv[3], 'utf8').trim();
const token2 = fs.readFileSync(process.argv[4], 'utf8').trim();
const user1 = process.argv[5];
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

// Direct RLS-scoped Supabase REST call (what the owner is allowed to do themselves).
async function sb(table, rows, { method = 'POST', tok = token, select = 'select=*' } = {}) {
  const isGet = method === 'GET';
  const url = isGet ? `${SUPA}/rest/v1/${table}?${select}` : `${SUPA}/rest/v1/${table}?${select}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${tok}`, apikey: ANON, 'Content-Type': 'application/json', Prefer: method === 'POST' ? 'return=representation' : '' },
    body: isGet || method === 'DELETE' ? undefined : JSON.stringify(rows),
  });
  let data = [];
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

// ---------- setup: course + concept for user 1 ----------
let r = await api('/courses', { method: 'POST', body: { name: 'Physics 201', code: 'PHYS201', exam_date: '2026-10-15' } });
const courseId = r.data.course.id;
check('setup: course created', Boolean(courseId), JSON.stringify(r.data).slice(0, 120));

r = await sb('concepts', { user_id: user1, course_id: courseId, title: 'Newton\'s Second Law', summary: 'F = ma', importance_score: 80, priority: 'MUST_KNOW' });
const conceptId = r.data[0]?.id;
check('setup: concept inserted via RLS client', Boolean(conceptId), JSON.stringify(r.data).slice(0, 150));

// ---------- quiz answer security + grading + knowledge loop ----------
r = await sb('quizzes', { user_id: user1, course_id: courseId, title: 'Physics: practice', scope: 'concept' });
const quizId = r.data[0].id;
await sb('quiz_questions', [
  { quiz_id: quizId, user_id: user1, course_id: courseId, concept_id: conceptId, type: 'short_answer', question: 'State Newton\'s second law.', answer: 'F = ma', idx: 0 },
  { quiz_id: quizId, user_id: user1, course_id: courseId, concept_id: conceptId, type: 'short_answer', question: 'If mass doubles, acceleration (same force)…', answer: 'halves', idx: 1 },
]);

r = await api(`/quizzes/${quizId}`);
check('GET quiz 200', r.status === 200, JSON.stringify(r.data).slice(0, 120));
const leaked = JSON.stringify(r.data).toLowerCase().includes('"answer"');
check('quiz questions do NOT expose answers', !leaked, JSON.stringify(r.data).slice(0, 300));

r = await api(`/quizzes/${quizId}/submit`, { method: 'POST', body: { answers: [{ questionId: r.data.questions[0].id, given: 'f=ma' }, { questionId: r.data.questions[1].id, given: 'doubles' }] } });
check('quiz grading: normalization + 1/2 score', r.status === 200 && r.data.attempt.score === 1 && r.data.attempt.total === 2, JSON.stringify(r.data.attempt));
check('quiz results include expected answers only after submit', r.data.results?.[0]?.expected === 'F = ma');

// mastery + weakness updated for the wrong answer
r = await sb('concept_mastery', null, { method: 'GET', select: 'select=mastery,state,quiz_attempts,quiz_correct&course_id=eq.' + courseId });
const mastery = r.data[0];
check('mastery row created by quiz attempt', Boolean(mastery), JSON.stringify(r.data).slice(0, 150));
// 2 questions answered (1 right, 1 wrong) → 2 attempts, 1 correct; net mastery clamped at 0 (start 0: +12 then -15)
check('mastery reflects per-question recording (2 attempts, 1 correct, clamped 0)', mastery && mastery.quiz_attempts === 2 && mastery.quiz_correct === 1 && mastery.mastery === 0, JSON.stringify(mastery));
r = await sb('weaknesses', null, { method: 'GET', select: 'select=score&course_id=eq.' + courseId });
check('weakness created by wrong answer', r.data[0]?.score >= 15, JSON.stringify(r.data));

// recommendations now mention the weak concept
r = await api('/recommendations');
const weakRec = r.data.recommendations.find((x) => x.action.includes('Newton'));
check('recommendation targets the weak concept with why', Boolean(weakRec) && weakRec.reasons.length > 0, JSON.stringify(r.data.recommendations).slice(0, 300));

// session plan should target that concept (15+ min session)
r = await api(`/courses/${courseId}/sessions`, { method: 'POST', body: { minutes: 20, mode: 'quick' } });
const conceptStep = (r.data.session?.plan?.steps || []).find((s) => s.type === 'concept');
check('20-min session includes concept step', Boolean(conceptStep), JSON.stringify(r.data.session?.plan).slice(0, 200));
check('session targets the weak concept', conceptStep?.conceptId === conceptId, JSON.stringify(conceptStep));

// flashcard review loop -> mastery
r = await api('/flashcards', { method: 'POST', body: { course_id: courseId, front: 'F = ?', back: 'ma', concept_id: conceptId } });
const cardId = r.data.card.id;
r = await api(`/flashcards/${cardId}/review`, { method: 'POST', body: { result: 'good' } });
check('flashcard review ok', r.status === 200, JSON.stringify(r.data).slice(0, 120));
r = await sb('concept_mastery', null, { method: 'GET', select: 'select=mastery,review_attempts&course_id=eq.' + courseId });
check('review raised mastery +6', r.data[0]?.mastery === 6 && r.data[0]?.review_attempts === 1, JSON.stringify(r.data));

// cram endpoint works and prioritizes MUST_KNOW
r = await api(`/courses/${courseId}/cram`);
check('cram returns must-know + weaknesses', r.status === 200 && r.data.must_know?.some((m) => m.id === conceptId) && r.data.weaknesses?.length > 0, JSON.stringify(r.data).slice(0, 200));

// ---------- file validation ----------
r = await api(`/courses/${courseId}/materials`, { method: 'POST', body: { filename: 'evil.exe', storage_path: `${user1}/${courseId}/evil.exe` } });
check('unsupported extension rejected', r.status === 400 && String(r.data.error).includes('UNSUPPORTED_FILE_TYPE'), JSON.stringify(r.data));
r = await api(`/courses/${courseId}/materials`, { method: 'POST', body: { filename: 'x.txt', storage_path: `${user1}/other-course/x.txt` } });
check('wrong course prefix rejected', r.status === 400, JSON.stringify(r.data));
r = await api(`/courses/${courseId}/materials`, { method: 'POST', body: { filename: 'x.txt', storage_path: `${user1}/${courseId}/../escape.txt` } });
check('path traversal rejected', r.status === 400, JSON.stringify(r.data));

// ---------- cross-user authorization on every resource ----------
const paths = [
  [`/courses/${courseId}`, 'course'],
  [`/courses/${courseId}/materials`, 'materials'],
  [`/courses/${courseId}/concepts`, 'concepts'],
  [`/courses/${courseId}/notes`, 'notes'],
  [`/courses/${courseId}/flashcards`, 'flashcards'],
  [`/courses/${courseId}/quizzes`, 'quizzes'],
  [`/courses/${courseId}/exams`, 'exams'],
  [`/courses/${courseId}/sessions`, 'sessions'],
  [`/courses/${courseId}/formulas`, 'formulas'],
  [`/courses/${courseId}/cram`, 'cram'],
  [`/courses/${courseId}/tutor`, 'tutor history'],
  [`/quizzes/${quizId}`, 'quiz questions'],
  [`/flashcards/${cardId}`, 'flashcard (PATCH/DELETE)'],
];
let allBlocked = true;
for (const [p, label] of paths) {
  const res = await api(p, { tok: token2 });
  const blocked = res.status === 404 || res.status === 403;
  if (!blocked) { allBlocked = false; console.log(`  LEAK: ${label} -> ${res.status} ${JSON.stringify(res.data).slice(0, 120)}`); }
}
check('user2 blocked from ALL user1 course resources', allBlocked);

// user2 cannot grade user1's quiz or review user1's card
r = await api(`/quizzes/${quizId}/submit`, { method: 'POST', body: { answers: [] }, tok: token2 });
check('user2 cannot submit user1 quiz', r.status === 404 || r.status === 403, String(r.status));
r = await api(`/flashcards/${cardId}/review`, { method: 'POST', body: { result: 'good' }, tok: token2 });
check('user2 cannot review user1 card', r.status === 404 || r.status === 403, String(r.status));

// user2's dashboard/recommendations contain none of user1's data
r = await api('/dashboard', { tok: token2 });
const leak = JSON.stringify(r.data).includes('Physics 201');
check('user2 dashboard has no user1 data', !leak);

// ---------- rate limiting (AI endpoint: 12/min) ----------
let got429 = false;
for (let i = 0; i < 14; i++) {
  const res = await api(`/courses/${courseId}/tutor`, { method: 'POST', body: { question: 'x' } });
  if (res.status === 429) { got429 = true; break; }
}
check('AI endpoint rate limited (429 after 12/min)', got429);

// ---------- recompute priority reflects weakness ----------
r = await api(`/courses/${courseId}/recompute-priority`, { method: 'POST' });
check('recompute-priority ok', r.status === 200 && r.data.updated >= 1, JSON.stringify(r.data));
r = await api(`/courses/${courseId}/concepts`);
const con = r.data.concepts.find((x) => x.id === conceptId);
check('concept shows mastery + accuracy', con && con.mastery === 6 && con.mastery_state === 'learning' && con.quiz_accuracy === 50, JSON.stringify(con).slice(0, 240));

console.log(failures === 0 ? '\nALL EXTENDED TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
