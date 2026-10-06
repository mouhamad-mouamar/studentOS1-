// Unit tests for pure logic: mastery model, SRS, priority engine, chunking.
const path = require('path');
const knowledge = require(path.join(__dirname, '..', 'dist-server', 'knowledge.js'));
const logic = require(path.join(__dirname, '..', 'dist-server', 'logic.js'));
const extract = require(path.join(__dirname, '..', 'dist-server', 'extract.js'));

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${cond ? '' : ' :: ' + extra}`);
  if (!cond) failures++;
}

// ---- Knowledge model transitions ----
const K = knowledge.nextMastery;
let row = null;

row = K(row, { kind: 'quiz', correct: false });
check('wrong quiz lowers mastery below 0 clamp', row.mastery === 0 && row.quiz_attempts === 1, JSON.stringify(row));

row = K(row, { kind: 'quiz', correct: true });
check('correct quiz raises mastery', row.mastery === 12 && row.quiz_correct === 1, JSON.stringify(row));
check('state learning after 1 correct', row.state === 'learning', row.state);

for (let i = 0; i < 6; i++) row = K(row, { kind: 'quiz', correct: true });
check('repeated correct answers reach mastered', row.state === 'mastered' && row.mastery >= 80, JSON.stringify(row));

const before = row.mastery;
row = K(row, { kind: 'review', result: 'again' });
check('failed review drops mastery', row.mastery < before && row.review_attempts === 1, JSON.stringify(row));

const r2 = K(null, { kind: 'review', result: 'good' });
check('review good from new → learning positive', r2.mastery === 6 && r2.state === 'learning', JSON.stringify(r2));

const r3 = K({ mastery: 78, state: 'review', quiz_attempts: 3, quiz_correct: 3, review_attempts: 0, review_correct: 0 }, { kind: 'review', result: 'easy' });
check('easy review crosses into mastered', r3.state === 'mastered', JSON.stringify(r3));

// ---- SRS ----
const S = logic.nextSrsState;
const fresh = { ease: 2.5, interval_days: 0, reps: 0, lapses: 0 };
const s1 = S(fresh, 'good');
check('first good → 1 day', s1.interval_days === 1 && s1.reps === 1, JSON.stringify(s1));
const s2 = S(s1, 'good');
check('second good → 6 days', s2.interval_days === 6, JSON.stringify(s2));
const s3 = S(s2, 'good');
check('third good grows by ease', s3.interval_days > 10, JSON.stringify(s3));
const s4 = S(s3, 'again');
check('again resets interval and lapses', s4.interval_days === 0 && s4.lapses === 1 && s4.reps === 0, JSON.stringify(s4));
check('again due within 10 min', new Date(s4.due_at) - Date.now() < 10.5 * 60_000);
const s5 = S(s2, 'easy');
check('easy boosts ease', s5.ease > s2.ease, JSON.stringify(s5));

// ---- Priority engine ----
check('MUST_KNOW at high score', logic.classifyPriority(80) === 'MUST_KNOW');
check('LOW_PRIORITY at low score', logic.classifyPriority(10) === 'LOW_PRIORITY');
const withEmphasis = logic.computePriorityScore({ importance_score: 60, professor_emphasis: true, mentioned_in_exams: 2 }, 40, 3);
const without = logic.computePriorityScore({ importance_score: 60, professor_emphasis: false, mentioned_in_exams: 0 }, null, 30);
check('emphasis + exam mentions + weakness raise score', withEmphasis > without, `${withEmphasis} vs ${without}`);
check('score clamped to 100', logic.computePriorityScore({ importance_score: 100, professor_emphasis: true, mentioned_in_exams: 10 }, 100, 1) === 100);
check('examDaysAway parses date', logic.examDaysAway('2099-01-01') > 0 && logic.examDaysAway(null) === null);

// ---- Extraction ----
const chunks = extract.chunkText('A'.repeat(5000), 1600, 200);
check('chunking splits long text', chunks.length >= 3 && chunks.every((c) => c.length <= 1800), String(chunks.length));
check('chunking single short text', extract.chunkText('short').length === 1);
const em = extract.findEmphasis('Remember this for later. Nothing special here. This will be on the exam!');
check('emphasis finds 2 sentences', em.length === 2, String(em.length));

console.log(failures === 0 ? '\nALL UNIT TESTS PASSED' : `\n${failures} UNIT TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
