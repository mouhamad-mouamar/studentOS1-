// Unit tests for pure logic: mastery model, SRS, priority engine, chunking,
// course summary levels and "what actually matters" scoring.
const path = require('path');
const knowledge = require(path.join(__dirname, '..', 'dist-server', 'knowledge.js'));
const logic = require(path.join(__dirname, '..', 'dist-server', 'logic.js'));
const extract = require(path.join(__dirname, '..', 'dist-server', 'extract.js'));
const summary = require(path.join(__dirname, '..', 'dist-server', 'summary.js'));

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

// ---- Course summary levels ----
const mk = (title, priority, imp) => ({ id: title, title, priority, importance_score: imp, summary: null, definition: null, professor_emphasis: false, mentioned_in_exams: 0, material_id: null, mastery: null, mastery_state: 'new', weakness_score: null });
const concepts = [mk('A', 'MUST_KNOW', 90), mk('B', 'SHOULD_KNOW', 60), mk('C', 'NICE_TO_KNOW', 40), mk('D', 'LOW_PRIORITY', 20)];
check('full level keeps everything sorted', summary.conceptsForLevel(concepts, 'full').length === 4 && summary.conceptsForLevel(concepts, 'full')[0].title === 'A');
check('study level drops LOW_PRIORITY', summary.conceptsForLevel(concepts, 'study').map((c) => c.title).join('') === 'ABC');
check('quick level keeps MUST+SHOULD', summary.conceptsForLevel(concepts, 'quick').map((c) => c.title).join('') === 'AB');
check('cram level keeps only MUST_KNOW', summary.conceptsForLevel(concepts, 'cram').map((c) => c.title).join('') === 'A');
check('levels sort by importance', summary.conceptsForLevel([mk('X', 'MUST_KNOW', 10), mk('Y', 'MUST_KNOW', 80)], 'cram')[0].title === 'Y');

// ---- What-actually-matters scoring ----
const base = { concept: { id: 'a', title: 'A', priority: 'MUST_KNOW', importance_score: 80, professor_emphasis: false, mentioned_in_exams: 0 }, weakness: null, mastery: null, masteryState: 'new', examDaysAway: null };
const wm1 = summary.scoreWhatMatters(base);
check('must-know new concept has positive score and priority reason', wm1.score > 0 && wm1.reasons.some((r) => r.includes('MUST_KNOW')) && wm1.reasons.some((r) => r.includes('Not studied yet')), JSON.stringify(wm1));

const wm2 = summary.scoreWhatMatters({ ...base, concept: { ...base.concept, professor_emphasis: true, mentioned_in_exams: 2 }, weakness: 40, examDaysAway: 3 });
check('emphasis + exam mentions + weakness + proximity all add reasons', wm2.score > wm1.score && wm2.reasons.some((r) => r.includes('Professor emphasis')) && wm2.reasons.some((r) => r.includes('past exams')) && wm2.reasons.some((r) => r.includes('Weakness score')) && wm2.reasons.some((r) => r.includes('Exam in 3')), JSON.stringify(wm2));

const wm3 = summary.scoreWhatMatters({ ...base, mastery: 90, masteryState: 'mastered' });
check('mastered concept scores lower than unexplored', wm3.score < wm1.score, JSON.stringify({ s1: wm1.score, s3: wm3.score }));

check('concept count scales with minutes, clamped 3..10', summary.conceptCountForMinutes(20) === 3 && summary.conceptCountForMinutes(60) === 6 && summary.conceptCountForMinutes(300) === 10);

// ---- AI provider resolution (local-first, no paid default) ----
function freshConfig(env) {
  const saved = { ...process.env };
  for (const k of ['AI_BASE_URL', 'AI_API_KEY', 'AI_CHAT_MODEL', 'AI_EMBED_MODEL']) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve(path.join(__dirname, '..', 'dist-server', 'config.js'))];
  const cfg = require(path.join(__dirname, '..', 'dist-server', 'config.js'));
  process.env = saved;
  return cfg;
}
const cNone = freshConfig({});
check('no AI_BASE_URL → engine none, not configured (no paid default)', cNone.aiProviderInfo().engine === 'none' && cNone.aiConfigured() === false, JSON.stringify(cNone.aiProviderInfo()));
const cLocal = freshConfig({ AI_BASE_URL: 'http://127.0.0.1:11434/v1', AI_CHAT_MODEL: 'qwen2.5:3b-instruct' });
const li = cLocal.aiProviderInfo();
check('local base URL → configured WITHOUT any API key', li.engine === 'local' && li.configured === true && li.keyRequired === false, JSON.stringify(li));
const cLan = freshConfig({ AI_BASE_URL: 'http://192.168.1.20:8091/v1' });
check('private LAN host counts as local engine', cLan.aiProviderInfo().engine === 'local');
const cExt = freshConfig({ AI_BASE_URL: 'https://api.openai.com/v1', AI_API_KEY: 'sk-test' });
check('public host → external engine, key required', cExt.aiProviderInfo().engine === 'external' && cExt.aiProviderInfo().keyRequired === true);
const cKeyOnly = freshConfig({ AI_API_KEY: 'sk-something' });
check('API key alone does NOT enable a provider', cKeyOnly.aiConfigured() === false, JSON.stringify(cKeyOnly.aiProviderInfo()));

// ---- repairJson (malformed small-model JSON recovery) ----
const { repairJson } = require(path.join(__dirname, '..', 'dist-server', 'ai.js'));
check('repairJson: strips markdown fences', repairJson('```json\n{"a":1}\n```') === '{"a":1}');
check('repairJson: strips prose before/after JSON', repairJson('Here is the JSON you asked for:\n{"a":1}\nHope that helps!') === '{"a":1}');
check('repairJson: removes trailing commas', JSON.parse(repairJson('{"a":[1,2,3,],}')).a.length === 3);
check('repairJson: normalizes smart quotes as delimiters', JSON.parse(repairJson('{“a”:“x”}')).a === 'x');
check('repairJson: leaves valid JSON untouched', repairJson('{"a":"b"}') === '{"a":"b"}');
check('repairJson: keeps content quotes inside strings', JSON.parse(repairJson('{"a":"say \\"hi\\""}')).a === 'say "hi"');
check('repairJson: handles fenced array with trailing comma', JSON.parse(repairJson('```json\n[{"name":"x","expression":"y"},]\n```')).length === 1);

console.log(failures === 0 ? '\nALL UNIT TESTS PASSED' : `\n${failures} UNIT TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
