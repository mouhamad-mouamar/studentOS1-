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
check('tutor branches on summary intent', /summaryIntent\s*\?\s*await buildBroadContext/.test(routesSrc));
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

/* ---------- 5. buildBroadContext with mock Supabase client ---------- */
console.log('\n[5] buildBroadContext (mock client)');

function makeClient({ chunks, materials }) {
  function chunksQuery() {
    const state = { materialFilter: null, limitVal: null };
    const q = {
      select: () => q,
      eq: () => q,
      order: () => q,
      limit: (n) => { state.limitVal = n; return q; },
      in: (_field, ids) => { state.materialFilter = ids; return q; },
      then(resolve, reject) {
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
  check('oversized chunk truncated to 1200 chars', !r1.context.includes('x'.repeat(1300)) && r1.context.length < 24_000);

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

  console.log(`\n${failed === 0 ? 'LANG/SUMMARY EVAL: ALL PASSED' : `LANG/SUMMARY EVAL: ${failed} FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('EVAL CRASH:', e);
  process.exit(1);
});
