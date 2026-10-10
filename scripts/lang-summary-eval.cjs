// Regression eval: response-language matching + course-summary retrieval.
// Requires `npm run build:server` first (reads dist-server/lang.js,
// dist-server/retrieval.js). Retrieval tests use a mock Supabase client —
// no network, no database access.
const path = require('path');
const fs = require('fs');

let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const lang = require(path.join(process.cwd(), 'dist-server', 'lang.js'));
const routesSrc = fs.readFileSync(path.join(process.cwd(), 'server', 'routes.ts'), 'utf8');
const retrievalSrc = fs.readFileSync(path.join(process.cwd(), 'server', 'retrieval.ts'), 'utf8');

/* ---------- 1. detectResponseLang ---------- */
console.log('\n[1] detectResponseLang');
const cases = [
  ['فيك تعملي شي ملخص؟', 'ar', 'arabic script'],
  ['لخّصلي هالمحاضرة', 'ar', 'arabic script with diacritics'],
  ['لخّصلي the lecture on transformers', 'ar', 'mixed ar/en → arabic dominant'],
  ['ta3melli summary lal course?', 'ar', 'arabizi digits'],
  ['shu ma3na header file?', 'ar', 'arabizi word list'],
  ['Summarize this lecture', 'en', 'english'],
  ['What is a stack in data structures?', 'en', 'english question'],
  ['Peux-tu résumer ce cours ?', 'fr', 'french accents'],
  ['Je voudrais un résumé du chapitre trois', 'fr', 'french hints'],
  // D4 regression: scientific notation / formulas must NOT be Arabizi.
  ['x*e^x', 'en', 'scientific notation (was: false Arabizi via "e")'],
  ['find the integral of x^2 dx', 'en', 'bare digit token (was: false Arabizi via "2")'],
  ['What is the derivative of e^x sin(x)?', 'en', 'english math question'],
  ['Yalla let us start the lecture', 'en', 'single borrowed word is not Arabizi evidence'],
  // D4 regression: genuine Arabizi without digits still detected (2 hits needed).
  ['shu hayda?', 'ar', 'arabizi two word-list hits'],
  ['kif ktir?', 'ar', 'arabizi two word-list hits no digits'],
];
for (const [msg, expect, label] of cases) {
  const m = lang.detectResponseLang(msg);
  check(label, m.code === expect, `got ${m.code}`);
}
const arRule = lang.detectResponseLang('فيك تعملي شي ملخص؟').rule;
check('arabic rule keeps citation markers/technical terms', /\[1\]/.test(arRule) && /technical/i.test(arRule));
const enRule = lang.detectResponseLang('Summarize this lecture').rule;
check('english rule is mirror-language fallback (not arabic-forced)', /same language/i.test(enRule));

/* ---------- 2. isSummaryRequest ---------- */
console.log('\n[2] isSummaryRequest');
const summaryTrue = [
  'فيك تعملي شي ملخص',
  'لخّصلي المادة',
  'اعمل ملخص',
  'لخص chapter 2',
  'summarize this course',
  'Can you summarise the lecture?',
  'give me a recap',
  'lakhasli lal mawad',
  'TLDR please',
];
for (const m of summaryTrue) check(`summary intent: "${m}"`, lang.isSummaryRequest(m) === true);
const summaryFalse = [
  'What is a red-black tree?',
  'explain the proof of theorem 2',
  'Which page talks about hashing?',
  'quiz me on chapter 3',
];
for (const m of summaryFalse) check(`non-summary: "${m}"`, lang.isSummaryRequest(m) === false);

/* ---------- 3. uiLocaleRule ---------- */
console.log('\n[3] uiLocaleRule');
check('ar locale rule', /Arabic/.test(lang.uiLocaleRule('ar')));
check('fr locale rule', /French/.test(lang.uiLocaleRule('fr')));
check('missing/unknown locale → no rule', lang.uiLocaleRule(undefined) === '' && lang.uiLocaleRule('en') === '' && lang.uiLocaleRule(null) === '');

/* ---------- 4. server wiring ---------- */
console.log('\n[4] server wiring (routes.ts / retrieval.ts)');
check('tutor imports detectResponseLang', routesSrc.includes("detectResponseLang"));
check('tutor branches on summary intent', /summaryIntent\s*\?\s*\{[\s\S]{0,120}buildBroadContext[\s\S]{0,200}buildRagContextWithFallback/.test(routesSrc));
check('tutor uses scored retrieval with broad fallback', /await buildRagContextWithFallback\(client, course\.id, question, 8, scopeIds/.test(routesSrc));
check('weak-evidence disclosure rule reaches tutor prompt', /broad fallback because the question did not strongly match/.test(routesSrc));
check('empty-context prompt is honest (no false coverage claim)', /no processed course material is available/.test(routesSrc));
check('tutor prompt includes summary-intent rule 7', /student asked for a summary/.test(routesSrc));
check('tutor prompt includes lang rule', /5\. \$\{lang\.rule\}/.test(routesSrc));
check('/ask uses language detection', /askLang = detectResponseLang/.test(routesSrc));
check('quiz generate prompt carries uiLocaleRule', /no invented facts\..*uiLocaleRule\(lang\)/s.test(routesSrc));
check('exam analysis prompt carries uiLocaleRule', /high_value_areas.*uiLocaleRule\(req\.body\?\.lang\)/s.test(routesSrc));
check('exam simulate prompt carries uiLocaleRule', /exact correct option text\.' \+ uiLocaleRule\(req\.body\?\.lang\)/.test(routesSrc));
check('fast analyze prompt carries uiLocaleRule', /Do not invent concepts or claims\.' \+ uiLocaleRule\(req\.body\?\.lang\)/.test(routesSrc));
check('concept notes prompt carries uiLocaleRule', /under 600 words\.' \+ uiLocaleRule\(req\.body\?\.lang\)/.test(routesSrc));
check('self-test prompt carries uiLocaleRule via query', /No invented facts\.' \+ uiLocaleRule\(req\.query\.lang\)/.test(routesSrc));
check('buildBroadContext is exported', /export async function buildBroadContext/.test(retrievalSrc));
check('fallback helper exported', /export async function buildRagContextWithFallback/.test(retrievalSrc));
check('all four D3 call sites wired (tutor/quiz/exam/self-test)', (routesSrc.match(/buildRagContextWithFallback/g) || []).length >= 4);
check('quiz generation refuses empty context (NO_COURSE_CONTENT)', /NO_COURSE_CONTENT/.test(routesSrc) && /Never generate questions without real course material/.test(routesSrc));
check('exam simulation refuses empty context', /before generating an exam/.test(routesSrc));
check('self-test skips AI without material', /skip the AI call entirely/.test(routesSrc));

/* ---------- 5. buildBroadContext with mock Supabase client ---------- */
console.log('\n[5] buildBroadContext (mock client)');

function makeClient({ chunks, materials, totalCount }) {
  function chunksQuery() {
    const state = { materialFilter: null, limitVal: null, countMode: false };
    const q = {
      select: (_fields, opts) => { state.countMode = !!(opts && opts.count); return q; },
      eq: () => q,
      order: () => q,
      limit: (n) => { state.limitVal = n; return q; },
      in: (_field, ids) => { state.materialFilter = ids; return q; },
      then(resolve, reject) {
        if (state.countMode) {
          return Promise.resolve({ data: null, count: totalCount ?? chunks.length, error: null }).then(resolve, reject);
        }
        let rows = chunks;
        if (state.materialFilter) rows = rows.filter((c) => state.materialFilter.includes(c.material_id));
        if (state.limitVal != null) rows = rows.slice(0, state.limitVal);
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      },
    };
    return q;
  }
  function materialsQuery() {
    const q = {
      select: () => q,
      in: (_field, ids) => { q.ids = ids; return q; },
      then(resolve) {
        const rows = materials.filter((m) => !q.ids || q.ids.includes(m.id));
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
    };
    return q;
  }
  return {
    from(table) {
      if (table === 'chunks') return chunksQuery();
      if (table === 'materials') return materialsQuery();
      throw new Error(`unexpected table ${table}`);
    },
  };
}

const MAT_A = 'mat-aaaa';
const MAT_B = 'mat-bbbb';
const longContent = 'x'.repeat(2000);

const fixtures = {
  multi: {
    chunks: [
      { id: 'c1', material_id: MAT_A, content: 'Topic one: sorting algorithms basics', page_number: 1 },
      { id: 'c2', material_id: MAT_A, content: longContent, page_number: 2 },
      { id: 'c3', material_id: MAT_B, content: 'Topic two: graph traversal', page_number: null },
      { id: 'c4', material_id: MAT_B, content: 'Topic two continued: BFS and DFS', page_number: 5 },
    ],
    materials: [
      { id: MAT_A, filename: 'lecture-4.pdf' },
      { id: MAT_B, filename: 'lecture-5.pdf' },
    ],
  },
  empty: { chunks: [], materials: [] },
};

(async () => {
  const retrieval = require(path.join(process.cwd(), 'dist-server', 'retrieval.js'));

  // Multi-material: round-robin covers both files
  const r1 = await retrieval.buildBroadContext(makeClient(fixtures.multi), 'course-1', 12);
  check('returns context and citations', r1.context.length > 0 && r1.citations.length === 4);
  const srcs = new Set(r1.citations.map((c) => c.source));
  check('citations cover both materials', srcs.has('lecture-4.pdf') && srcs.has('lecture-5.pdf'), JSON.stringify([...srcs]));
  check('citations carry filenames not ids', r1.citations.every((c) => c.source.endsWith('.pdf')));
  check('citations carry page numbers', r1.citations.some((c) => c.page === 1) && r1.citations.some((c) => c.page === 5));
  check('citation snippet truncated at 260 chars', r1.citations.every((c) => c.snippet.length <= 261));
  const roundRobin = r1.citations.map((c) => c.materialId).join(',');
  check('round-robin alternates materials', roundRobin === `${MAT_A},${MAT_B},${MAT_A},${MAT_B}`, roundRobin);
  // Adaptive per-chunk cap (P4): with 4 eligible chunks the allowance is
  // 3000 chars, so the 2000-char chunk is included in FULL — no silent loss.
  check('adaptive per-chunk cap includes small-chunk sets fully', r1.context.includes('x'.repeat(2000)) && r1.coverage.truncatedChars === 0);
  check('coverage metadata accurate (multi)', r1.coverage.chunksFound === 4 && r1.coverage.chunksSelected === 4 && r1.coverage.complete === true && r1.coverage.charsAvailable > 0 && r1.coverage.charsSelected > 0);

  // Ownership scope: materialIds filter honored
  const r2 = await retrieval.buildBroadContext(makeClient(fixtures.multi), 'course-1', 12, [MAT_B]);
  check('materialIds filter restricts to authorized material', r2.citations.length === 2 && r2.citations.every((c) => c.materialId === MAT_B));

  // Empty course
  const r3 = await retrieval.buildBroadContext(makeClient(fixtures.empty), 'course-1', 12);
  check('empty course → empty context, no fabricated citations', r3.context === '' && r3.citations.length === 0);

  // Limit respected
  const r4 = await retrieval.buildBroadContext(makeClient(fixtures.multi), 'course-1', 2);
  check('limit respected', r4.citations.length === 2);

  // Supabase error → honest empty result
  const errClient = makeClient(fixtures.multi);
  const origFrom = errClient.from.bind(errClient);
  errClient.from = (t) => {
    const q = origFrom(t);
    if (t === 'chunks') {
      const origThen = q.then.bind(q);
      q.then = (resolve) => origThen((r) => resolve({ data: null, error: { message: 'boom' } }));
    }
    return q;
  };
  const r5 = await retrieval.buildBroadContext(errClient, 'course-1', 12);
  check('db error → empty result, no throw', r5.context === '' && r5.citations.length === 0);

  /* ---------- 9. P1/P2/P4: coverage metadata, spread, caps ---------- */
  console.log('\n[9] coverage metadata + stratified spread + caps');

  // Single chunk: complete, no truncation, honest description.
  const singleFix = { chunks: [{ id: 's1', material_id: MAT_A, content: 'a'.repeat(900), page_number: 1 }], materials: [{ id: MAT_A, filename: 'one.pdf' }] };
  const cov1 = await retrieval.buildBroadContext(makeClient(singleFix), 'course-1', 24);
  check('single chunk → complete=true, 1/1 selected', cov1.coverage.complete === true && cov1.coverage.chunksFound === 1 && cov1.coverage.chunksSelected === 1);
  check('single chunk gets larger per-chunk allowance (adaptive cap)', cov1.coverage.charsSelected === 900 && cov1.coverage.truncatedChars === 0);

  // Long document: stratified spread includes beginning AND end.
  const longDoc = { chunks: Array.from({ length: 60 }, (_, i) => ({ id: `lc-${i}`, material_id: MAT_A, content: `part ${i} ` + 'b'.repeat(860), page_number: i + 1 })), materials: [{ id: MAT_A, filename: 'long.pdf' }] };
  const cov2 = await retrieval.buildBroadContext(makeClient(longDoc), 'course-1', 24);
  const ids2 = cov2.citations.map((c) => c.chunkId);
  check('long doc: 24 chunks selected (was 12) — budget-bound increase', cov2.coverage.chunksSelected === 24, `got ${cov2.coverage.chunksSelected}`);
  check('long doc: spread includes first and last sections', ids2.includes('lc-0') && ids2.includes('lc-59'), ids2.slice(0, 3).join(',') + '…' + ids2.slice(-2).join(','));
  check('long doc: partial coverage disclosed', cov2.coverage.complete === false && cov2.coverage.cappedByChunks === true && cov2.coverage.chunksFound === 60);
  check('long doc: selection is deterministic', JSON.stringify(ids2) === JSON.stringify((await retrieval.buildBroadContext(makeClient(longDoc), 'course-1', 24)).citations.map((c) => c.chunkId)));

  // Unfair-size materials: small file not crowded out by the large one.
  const unfair = {
    chunks: [
      ...Array.from({ length: 40 }, (_, i) => ({ id: `big-${i}`, material_id: MAT_A, content: `big ${i} ` + 'c'.repeat(860), page_number: i + 1 })),
      ...Array.from({ length: 5 }, (_, i) => ({ id: `small-${i}`, material_id: MAT_B, content: `small ${i}`, page_number: i + 1 })),
    ],
    materials: [{ id: MAT_A, filename: 'big.pdf' }, { id: MAT_B, filename: 'small.pdf' }],
  };
  const cov3 = await retrieval.buildBroadContext(makeClient(unfair), 'course-1', 24);
  const smallPicks = cov3.citations.filter((c) => c.materialId === MAT_B).length;
  check('fair allocation: small file fully represented (5/5)', smallPicks === 5, `small picks=${smallPicks}`);
  check('fair allocation: large file spread, not dominant', cov3.citations.filter((c) => c.materialId === MAT_A).length === 19 && cov3.citations.some((c) => c.chunkId === 'big-39'));

  // Oversized chunks: truncation explicit and measured.
  const oversized = { chunks: [1, 2, 3].map((i) => ({ id: `big${i}`, material_id: MAT_A, content: 'd'.repeat(20_000) })), materials: [{ id: MAT_A, filename: 'huge.pdf' }] };
  const cov4 = await retrieval.buildBroadContext(makeClient(oversized), 'course-1', 24);
  check('oversized: per-chunk cap applied, chars measured', cov4.coverage.truncatedChunks > 0 && cov4.coverage.truncatedChars > 0 && cov4.coverage.charsSelected <= 24_000 + 3 && cov4.coverage.complete === false);

  // Fetch cap (P4): 600 fetched, 650 actually exist → disclosed.
  const fetchCap = {
    chunks: Array.from({ length: 600 }, (_, i) => ({ id: `fc-${i}`, material_id: MAT_A, content: `fc ${i} ` + 'e'.repeat(50) })),
    materials: [{ id: MAT_A, filename: 'many.pdf' }],
    totalCount: 650,
  };
  const cov5 = await retrieval.buildBroadContext(makeClient(fetchCap), 'course-1', 24);
  check('fetch cap disclosed with exact total', cov5.coverage.cappedByFetch === true && cov5.coverage.chunksFound === 650);

  // Scoped coverage counts reflect the materialIds filter.
  const cov6 = await retrieval.buildBroadContext(makeClient(fixtures.multi), 'course-1', 24, [MAT_B]);
  check('scoped coverage counts only eligible chunks', cov6.coverage.chunksFound === 2 && cov6.coverage.chunksSelected === 2 && cov6.coverage.complete === true);

  // coverageNotice localization (P1)
  console.log('\n[10] coverageNotice localization');
  const cn = lang.coverageNotice;
  check('partial EN', /includes 12 of 60 available course sections/.test(cn('en', { complete: false, chunksFound: 60, chunksSelected: 12 })));
  check('partial AR', /12 من أصل 60/.test(cn('ar', { complete: false, chunksFound: 60, chunksSelected: 12 })));
  check('partial FR', /12 sections sur 60/.test(cn('fr', { complete: false, chunksFound: 60, chunksSelected: 12 })));
  check('complete EN does not claim knowledge coverage', /sections were included/.test(cn('en', { complete: true, chunksFound: 4, chunksSelected: 4 })));
  check('complete AR', /جميع المقاطع/.test(cn('ar', { complete: true, chunksFound: 4, chunksSelected: 4 })));
  check('unknown locale → English', /sections/.test(cn('de', { complete: true, chunksFound: 4, chunksSelected: 4 })));
  check('empty course → no notice', cn('en', { complete: false, chunksFound: 0, chunksSelected: 0 }) === '');

  // /analyze fallback wiring (P3) + tutor coverage response (P1)
  const tutorTabSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'course', 'TutorTab.tsx'), 'utf8');
  check('/analyze uses scored retrieval with fallback', /const rag = await buildRagContextWithFallback\(client, course\.id, course\.name \+ ' ' \+ concepts/.test(routesSrc));
  check('/analyze discloses weak fallback to the model', /broad fallback sample/.test(routesSrc));
  check('tutor response carries coverage + localized notice', /coverage: rag\.coverage \?\? null, coverageNotice: covNotice/.test(routesSrc));
  check('tutor prompt discloses partial coverage (rule 9)', /PARTIAL sample of the course/.test(routesSrc));
  check('tutor summary path uses budget-bound limit 24', /buildBroadContext\(client, course\.id, 24, scopeIds/.test(routesSrc));
  check('TutorTab renders coverageNotice', /coverageNotice/.test(tutorTabSrc));

  /* ---------- 6. D1: corpus-size-aware retrieval floor ---------- */
  console.log('\n[6] D1 retrieval floor (mock client, keyword-only scoring)');
  const IBP_CONTENT =
    'Integration by parts is one of the most important techniques in calculus. ' +
    'The integration by parts formula is: integral u dv = uv - integral v du. ' +
    'This formula comes from the product rule for differentiation. ' +
    'Example: integral x e^x dx = x e^x - e^x + C. ' +
    'Choose u using the LIATE rule: Logarithmic, Inverse trigonometric, Algebraic, Trigonometric, Exponential.';
  const single = {
    chunks: [{ id: 'c1', material_id: MAT_A, content: IBP_CONTENT, page_number: 1 }],
    materials: [{ id: MAT_A, filename: 'lecture-4.txt' }],
  };
  // 4 exact term matches (integration, parts, formula, example) — previously
  // scored 0.116 and was rejected by the fixed 0.2 floor.
  const d1a = await retrieval.buildRagContext(makeClient(single), 'course-1', 'State the integration by parts formula exactly as the material gives it, plus the worked example from the material.');
  check('tiny corpus: genuine 4-term match now retrieved', d1a.context.length > 0 && d1a.citations.length === 1, `citations=${d1a.citations.length}`);
  check('scored hit is strong evidence (no weakEvidence flag)', d1a.weakEvidence === false);
  // Zero-match query must stay excluded (no global floor removal).
  const d1b = await retrieval.buildRagContext(makeClient(single), 'course-1', 'What does the material say about the Riemann zeta function?');
  check('tiny corpus: zero-match query still excluded', d1b.context === '' && d1b.citations.length === 0);
  // 2-term tf=1 match on N=1 scores ~0.05 — below the small-corpus floor;
  // such cases are covered by the D3 fallback, not the floor.
  const d1c = await retrieval.buildRagContext(makeClient(single), 'course-1', 'LIATE rule for choosing u');
  check('tiny corpus: feeble 2-term match stays floor-excluded', d1c.context === '');
  // Larger corpus: relevant chunk ranked first, unrelated chunks excluded.
  const distractor = (topic) => ({
    id: `d-${topic}`, material_id: MAT_B,
    content: `Chapter on ${topic}. ${topic} has many important applications in modern science and everyday life. Students should review the chapter carefully before the final test.`,
    page_number: null,
  });
  const multi6 = {
    chunks: [
      { id: 'rel-1', material_id: MAT_A, content: IBP_CONTENT, page_number: 3 },
      distractor('photosynthesis'), distractor('world history'), distractor('cell biology'), distractor('supply and demand'), distractor('sonnets'),
    ],
    materials: [
      { id: MAT_A, filename: 'lecture-4.txt' },
      { id: MAT_B, filename: 'other-course-notes.txt' },
    ],
  };
  const d1d = await retrieval.buildRagContext(makeClient(multi6), 'course-1', 'integration by parts formula');
  check('larger corpus: relevant chunk retrieved, distractors excluded', d1d.citations.length === 1 && d1d.citations[0].chunkId === 'rel-1', `got ${d1d.citations.map((c) => c.chunkId).join(',')}`);
  check('larger corpus: hit is strong evidence', d1d.weakEvidence === false);

  /* ---------- 7. D3: scored retrieval with broad fallback ---------- */
  console.log('\n[7] D3 buildRagContextWithFallback (mock client)');
  // Scored hit → no fallback.
  const f1 = await retrieval.buildRagContextWithFallback(makeClient(multi6), 'course-1', 'integration by parts formula', 8);
  check('scored hit → strong evidence, no fallback', f1.weakEvidence === false && f1.citations.length === 1);
  // Scored miss (zero token overlap) but chunks exist → broad fallback.
  const f2 = await retrieval.buildRagContextWithFallback(makeClient(single), 'course-1', 'ما هو موضوع هذه المادة؟', 8);
  check('cross-language miss → falls back to real course chunks', f2.context.length > 0 && f2.citations.length === 1);
  check('fallback flagged as weak evidence', f2.weakEvidence === true);
  check('fallback citations are real course chunks with source', f2.citations[0].source === 'lecture-4.txt' && f2.citations[0].chunkId === 'c1');
  // No chunks at all → honest empty result.
  const f3 = await retrieval.buildRagContextWithFallback(makeClient(fixtures.empty), 'course-1', 'anything', 8);
  check('no material → empty context, weakEvidence false', f3.context === '' && f3.citations.length === 0 && f3.weakEvidence === false);
  // Fallback respects materialIds ownership scoping.
  const f4 = await retrieval.buildRagContextWithFallback(makeClient(fixtures.multi), 'course-1', 'موضوع غير موجود ابدا هنا', 8, [MAT_B]);
  check('fallback honors materialIds ownership filter', f4.weakEvidence === true && f4.citations.every((c) => c.materialId === MAT_B));

  /* ---------- 8. D2: quiz sanitizer (MC integrity) ---------- */
  console.log('\n[8] D2 sanitizeGeneratedQuestions');
  const ai = require(path.join(process.cwd(), 'dist-server', 'ai.js'));
  const san = ai.sanitizeGeneratedQuestions;
  // MC with empty options (the verified production defect) → dropped.
  const s1 = san([{ type: 'multiple_choice', question: 'Q1?', options: [], answer: 'x' }]);
  check('MC with empty options dropped', s1.length === 0);
  // MC without options but typed MC → dropped; unknown type without options kept as short answer.
  const s2 = san([
    { type: 'multiple choice', question: 'Q2?', answer: 'x' },
    { question: 'Q3?', answer: 'y' },
  ]);
  check('MC-typed question without options dropped, untyped kept as short answer', s2.length === 1 && s2[0].question === 'Q3?');
  // Duplicate options deduped, valid answer kept (single-letter options are
  // placeholders and rejected by design, so use realistic option text).
  const s3 = san([{ type: 'multiple_choice', question: 'Q4?', options: ['Newton', 'Newton', 'Einstein', 'Bohr'], answer: 'newton' }]);
  check('duplicate options deduped, answer case-insensitively matched', s3.length === 1 && s3[0].options.length === 3 && s3[0].answer === 'Newton');
  // Answer not among options → dropped.
  const s4 = san([{ type: 'multiple_choice', question: 'Q5?', options: ['A', 'B', 'C', 'D'], answer: 'E' }]);
  check('answer key not referencing an option → dropped', s4.length === 0);
  // Missing answer key (index-only model output) → dropped.
  const s5 = san([{ type: 'multiple_choice', question: 'Q6?', options: ['A', 'B', 'C', 'D'], answer_index: 2 }]);
  check('missing answer key → dropped', s5.length === 0);
  // Placeholder-only options → dropped.
  const s6 = san([{ type: 'multiple_choice', question: 'Q7?', options: ['a', 'b', 'c', 'd'], answer: 'a' }]);
  check('placeholder-only options → dropped', s6.length === 0);
  // Valid short answer kept.
  const s7 = san([{ type: 'short_answer', question: 'Q8?', answer: 'the formula' }]);
  check('valid short answer kept', s7.length === 1 && s7[0].answer === 'the formula');
  // Malformed shapes never throw.
  check('malformed input returns empty array', san(null).length === 0 && san({}).length === 0 && san([null, 42, 'x']).length === 0);

  console.log(`\n${failed === 0 ? 'LANG/SUMMARY EVAL: ALL PASSED' : `LANG/SUMMARY EVAL: ${failed} FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('EVAL CRASH:', e);
  process.exit(1);
});
