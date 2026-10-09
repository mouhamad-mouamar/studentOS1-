// AI accuracy evaluation suite (Phase 4):
//  1. Quiz sanitation: placeholder/duplicate/answer-mismatched MC questions are
//     dropped; valid ones survive with a gradable answer key.
//  2. Citation fidelity: buildRagContext citations must reference real chunk
//     content (snippets truncated from it), correct filenames and page numbers,
//     and the context must carry matching [n] markers.
//  3. Grounding prompt contract: the tutor prompt must keep the "Beyond your
//     material" separation and honest refusal instruction (source tripwire).
// Run: node scripts/ai-accuracy-eval.cjs   (requires build:server first)
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const ai = require(path.join(ROOT, 'dist-server', 'ai.js'));
const retrieval = require(path.join(ROOT, 'dist-server', 'retrieval.js'));

let failed = 0;
const check = (name, cond, extra = '') => {
  if (!cond) failed++;
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : ''));
};

/* ---------- 1. quiz sanitation ---------- */

const good = {
  type: 'multiple_choice',
  question: 'What does DMZ stand for?',
  options: ['Demilitarized zone', 'Dynamic media zone', 'Direct memory zigzag', 'Deutsches medizinisches zentrum'],
  answer: 'Demilitarized zone',
  explanation: 'A DMZ isolates exposed services.',
};
const res1 = ai.sanitizeGeneratedQuestions([good]);
check('valid MC question passes', res1.length === 1 && res1[0].answer === 'Demilitarized zone');
check('answer casing normalized to the option text', (() => {
  const r = ai.sanitizeGeneratedQuestions([{ ...good, answer: 'demilitarized zone' }]);
  return r.length === 1 && r[0].answer === 'Demilitarized zone';
})());
check('placeholder a/b/c/d options dropped', ai.sanitizeGeneratedQuestions([{ ...good, options: ['a', 'b', 'c', 'd'], answer: 'a' }]).length === 0);
check('answer not among options dropped', ai.sanitizeGeneratedQuestions([{ ...good, answer: 'Not an option here' }]).length === 0);
check('duplicate options deduplicated (still gradable)', (() => {
  const r = ai.sanitizeGeneratedQuestions([{ ...good, options: ['Demilitarized zone', 'demilitarized zone ', 'Firewall', 'Router'], answer: 'Demilitarized zone' }]);
  return r.length === 1 && r[0].options.length === 3;
})());
check('short_answer kept', ai.sanitizeGeneratedQuestions([{ type: 'short_answer', question: 'Define DMZ.', answer: 'A demilitarized zone network segment.' }]).length === 1);
check('empty/garbage entries dropped', ai.sanitizeGeneratedQuestions([null, {}, { question: '', answer: 'x' }, { question: 'Q only' }]).every((q) => false) || ai.sanitizeGeneratedQuestions([null, {}, { question: '', answer: 'x' }, { question: 'Q only' }]).length === 0);
check('non-array input yields empty list', ai.sanitizeGeneratedQuestions({ questions: [] }).length === 0);
check('single-letter distractors with one real option kept', (() => {
  const r = ai.sanitizeGeneratedQuestions([{ ...good, options: ['Demilitarized zone', 'b', 'c', 'd'], answer: 'Demilitarized zone' }]);
  return r.length === 1 && r[0].options.length === 4;
})());

/* ---------- 2. citation fidelity (mock Supabase client) ---------- */

const CHUNKS = [
  { id: 'c1', material_id: 'm1', content: 'A DMZ is a network segment that isolates externally facing services from the internal network with a security zone. Hosts inside the DMZ communicate with both external and internal networks, but the firewall restricts which connections may cross each zone boundary. Typical DMZ services include web servers, mail relays and reverse proxies.', page_number: 12 },
  { id: 'c2', material_id: 'm2', content: 'A stateful firewall filters traffic between security zones by tracking connection state and applying rule matching to packets.', page_number: null },
  // filler corpus so IDF behaves like a real course (single-chunk corpora
  // legitimately score below the relevance floor)
  ...Array.from({ length: 8 }, (_, i) => ({
    id: `filler${i}`,
    material_id: 'm2',
    content: `Week ${i}: linear algebra review — matrices, eigenvalues, determinants, vector spaces and orthogonal projections.`,
    page_number: i + 1,
  })),
];
const MATERIALS = [{ id: 'm1', filename: 'networking-week3.pdf' }, { id: 'm2', filename: 'notes.txt' }];
const table = (name) => {
  if (name === 'chunks') {
    return { select: () => ({ eq: () => ({ limit: async () => ({ data: CHUNKS, error: null }) }) }) };
  }
  return { select: () => ({ in: async () => ({ data: MATERIALS, error: null }) }) };
};
const mockClient = { from: table };

(async () => {
  const { context, citations } = await retrieval.buildRagContext(mockClient, 'course-1', 'DMZ firewall network security', 8);
  const byId = Object.fromEntries(citations.map((c) => [c.chunkId, c]));
  check('retrieval surfaces the relevant chunks', Boolean(byId.c1 && byId.c2), `got: ${citations.map((c) => c.chunkId).join(',')}`);
  check('citations reference real chunk ids', citations.every((c) => CHUNKS.some((k) => k.id === c.chunkId)));
  check('source filenames resolved', byId.c1?.source === 'networking-week3.pdf' && byId.c2?.source === 'notes.txt');
  check('page numbers preserved when present (null otherwise)', byId.c1?.page === 12 && byId.c2?.page === null);
  check('snippets are truncated excerpts of the real content', (byId.c1?.snippet || '').startsWith('A DMZ is a network segment') && byId.c1.snippet.endsWith('…') && byId.c2?.snippet === 'A stateful firewall filters traffic between security zones by tracking connection state and applying rule matching to packets.');
  check('context carries [n] markers matching citations', /\[1\] \(source: /.test(context) && context.includes('source: networking-week3.pdf, page 12') && context.includes('source: notes.txt'));

  // Empty / missing material: honest empty context, no fabricated citations.
  const emptyClient = { from: (n) => (n === 'chunks' ? { select: () => ({ eq: () => ({ limit: async () => ({ data: [], error: null }) }) }) } : { select: () => ({ in: async () => ({ data: [], error: null }) }) }) };
  const empty = await retrieval.buildRagContext(emptyClient, 'course-1', 'DMZ', 8);
  check('empty corpus -> empty context and no citations', empty.context === '' && empty.citations.length === 0);

  /* ---------- 3. grounding prompt contract (source tripwire) ---------- */
  const routesSrc = fs.readFileSync(path.join(ROOT, 'server', 'routes.ts'), 'utf8');
  check('tutor prompt keeps "From your course material" / "Beyond your material" separation', routesSrc.includes('Beyond your material:') && routesSrc.includes('From your course material:'));
  check('tutor prompt demands honest not-covered disclosure', routesSrc.includes('If the material does not cover it, say so plainly'));
  check('quiz prompt forbids placeholder options', routesSrc.includes('NEVER use placeholder options'));

  console.log(failed === 0 ? 'AI ACCURACY EVAL: ALL PASSED' : `AI ACCURACY EVAL: ${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.log('FATAL', e.message);
  process.exit(1);
});
