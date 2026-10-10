/*
 * Phase 5A P2 regression test — output-token budget guard.
 *
 * Verifies the countLimit() guard exported from the REAL dist-server routes
 * module, plus a static check that every question/card generation route is
 * actually wired to it and that the frontend requests within the limits.
 *
 * Run with: node scripts/count-limit-test.cjs   (after build:server)
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let failed = 0;
const check = (name, fn, detail) => {
  let ok = false;
  try { ok = fn(); } catch {}
  if (!ok) failed++;
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (ok ? '' : ' — ' + (detail || '')));
};

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
  };
}

const routes = require(path.join(__dirname, '..', 'dist-server', 'routes.js'));

// --- Direct guard behavior ---
check('count 6 <= 6 allowed (no response written)', () => {
  const res = fakeRes();
  const ok = routes.countLimit(res, 6, 6, 'questions');
  return ok === true && res.statusCode === null && res.body === null;
});
check('count 7 > 6 rejected with QUESTION_COUNT_LIMIT/400', () => {
  const res = fakeRes();
  const ok = routes.countLimit(res, 7, 6, 'questions');
  return ok === false && res.statusCode === 400 && res.body.error === 'QUESTION_COUNT_LIMIT' && res.body.maxQuestions === 6;
});
check('rejection message is actionable (mentions the limit)', () => {
  const res = fakeRes();
  routes.countLimit(res, 12, 6, 'questions');
  return typeof res.body.message === 'string' && res.body.message.includes('6');
});
check('flashcards: 10 <= 10 allowed, 11 rejected with max 10', () => {
  const res1 = fakeRes();
  const ok1 = routes.countLimit(res1, 10, 10, 'flashcards');
  const res2 = fakeRes();
  const ok2 = routes.countLimit(res2, 11, 10, 'flashcards');
  return ok1 === true && res1.statusCode === null && ok2 === false && res2.body.maxQuestions === 10;
});
check('non-numeric requested count is not rejected here', () => {
  const res = fakeRes();
  return routes.countLimit(res, NaN, 6, 'questions') === true && res.statusCode === null;
});

// --- Wiring: every generator route must enforce the guard ---
const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes.ts'), 'utf8');
const quizIdx = src.indexOf("router.post('/courses/:id/quizzes/generate'");
const examIdx = src.indexOf("router.post('/courses/:id/exams/simulate'");
const flashIdx = src.indexOf("router.post('/courses/:id/flashcards/generate'");
const nextRouter = (from) => src.indexOf("router.post('/courses/:id/", from + 10);
check('quizzes/generate wired to countLimit(MAX_MC_QUESTIONS)', () => {
  const seg = src.slice(quizIdx, Math.min(...[nextRouter(quizIdx)].filter((i) => i > 0)));
  return seg.includes('countLimit(res, count, MAX_MC_QUESTIONS');
});
check('exams/simulate wired to countLimit(MAX_MC_QUESTIONS)', () => {
  const end = examIdx < flashIdx ? flashIdx : src.length;
  const seg = src.slice(examIdx, end);
  return seg.includes('countLimit(res, count, MAX_MC_QUESTIONS');
});
check('flashcards/generate wired to countLimit(MAX_FLASHCARDS)', () => {
  const seg = src.slice(flashIdx, flashIdx + 2500);
  return seg.includes('countLimit(res, count, MAX_FLASHCARDS');
});
check('self-test request count stays fixed at 5 (within budget)', () => {
  const seg = src.slice(src.indexOf('/courses/:id/study-guide'));
  return /selfTest = .*slice\(0, 5\)/.test(seg.replace(/\s+/g, ' ')) || seg.includes('slice(0, 5)');
});

// --- Frontend requests within limits ---
const examsTab = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'course', 'ExamsTab.tsx'), 'utf8');
check('ExamsTab requests count: 6 (not 8)', () => examsTab.includes('exams/simulate`, { method: \'POST\', body: { count: 6') && !examsTab.includes('count: 8'));
const quizTab = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'course', 'QuizzesTab.tsx'), 'utf8');
check('QuizzesTab requests count: 6', () => quizTab.includes('count: 6'));
const flashTab = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'course', 'FlashcardsTab.tsx'), 'utf8');
check('FlashcardsTab requests count: 8 (<= 10)', () => flashTab.includes('count: 8'));

if (failed) {
  console.error(`COUNT LIMIT TEST FAILED: ${failed} check(s)`);
  process.exit(1);
}
console.log('COUNT LIMIT TEST PASSED');
process.exit(0);
