// Model quality/speed probe: runs representative StudyOS tasks directly
// against a llama-server OpenAI endpoint and reports latency + JSON shape
// quality per task. Usage: node scripts/model-probe.mjs [port] [label]
const port = process.argv[2] || '8091';
const label = process.argv[3] || `port-${port}`;
const base = `http://127.0.0.1:${port}/v1`;
const MODEL = 'probe';

const MATERIAL = `Calculus II — Integration Techniques (Lecture 7)
Integration by parts is a technique derived from the product rule of differentiation. The formula is: ∫u dv = uv − ∫v du. The professor said: "This WILL be on the exam — you need to know how to choose u and v using the LIATE rule." LIATE order: Logarithmic, Inverse trig, Algebraic, Trigonometric, Exponential.
Example: ∫x·e^x dx. Choose u = x (algebraic), dv = e^x dx. Then du = dx, v = e^x. Result: x·e^x − ∫e^x dx = x·e^x − e^x + C.
Common mistake: choosing u = e^x and dv = x dx, which makes the integral harder.
Partial fractions: for rational functions P(x)/Q(x) where Q factors into linear terms, decompose as A/(x−a) + B/(x−b). The professor repeated this three times in the lecture.
Trigonometric substitution: for √(a²−x²) use x = a·sinθ; for √(a²+x²) use x = a·tanθ; for √(x²−a²) use x = a·secθ.`;

const TASKS = [
  {
    name: 'concept-extraction (JSON array, guarded)',
    json: true,
    guard: (p) => Array.isArray(p?.concepts) && p.concepts.every((c) => c.title) && p.concepts.length >= 3,
    max: 900,
    system: 'You are an academic content analyzer. Respond in JSON: {"concepts":[{"title","summary","importance":0-100}]}. Only concepts from the material.',
    user: MATERIAL,
  },
  {
    name: 'importance-classification (MUST/SHOULD KNOW)',
    json: true,
    guard: (p) => Array.isArray(p?.concepts) && p.concepts.some((c) => /must_know|should_know|nice_to_know|low_priority/.test(c.priority || '')),
    max: 700,
    system: 'Classify each concept priority as MUST_KNOW, SHOULD_KNOW, NICE_TO_KNOW or LOW_PRIORITY based ONLY on evidence in the material (professor emphasis, repetition, exam hints). Respond in JSON: {"concepts":[{"title","priority","evidence"}]}.',
    user: MATERIAL,
  },
  {
    name: 'quiz-generation (5 questions, strict shape)',
    json: true,
    guard: (p) => Array.isArray(p?.questions) && p.questions.length >= 3 && p.questions.every((q) => q.question && q.answer),
    max: 1400,
    system: 'You generate quiz questions grounded in the material. Respond in JSON: {"questions":[{"question","type":"multiple_choice","options":["a","b","c","d"],"answer","explanation","concept_title"}]}. EVERY question object MUST begin with a non-empty "question" field. Exactly 4 options.',
    user: `Generate 5 medium-difficulty questions.\n\nMaterial:\n${MATERIAL}`,
  },
  {
    name: 'flashcard-generation (JSON array)',
    json: true,
    guard: (p) => Array.isArray(p?.cards) && p.cards.every((c) => c.front && c.back),
    max: 900,
    system: 'Generate active-recall flashcards from the material. Respond in JSON: {"cards":[{"front","back","concept_title"}]}. Concise cards, no invented facts.',
    user: MATERIAL,
  },
  {
    name: 'formula-extraction',
    json: true,
    guard: (p) => Array.isArray(p?.formulas) && p.formulas.length >= 2 && p.formulas.every((f) => f.name && f.expression),
    max: 800,
    system: 'Extract formulas/rules/equations from the material. Respond in JSON: {"formulas":[{"name","expression","explanation","concept_title"}]}. EVERY formula object MUST include "name" and "expression".',
    user: MATERIAL,
  },
  {
    name: 'tutor-answer (English, grounded)',
    json: false,
    max: 500,
    system: 'You are a course tutor. Answer ONLY from the provided material. If the material does not cover it, say so.',
    user: `Material:\n${MATERIAL}\n\nQuestion: How do I choose u and dv in integration by parts, and what is the common mistake?`,
  },
  {
    name: 'tutor-answer (Arabic)',
    json: false,
    max: 500,
    system: 'You are a course tutor. Answer ONLY from the provided material. Answer in Arabic.',
    user: `Material:\n${MATERIAL}\n\nQuestion: ما هي قاعدة LIATE وكيف أستخدمها في التكامل بالتجزئة؟`,
  },
  {
    name: 'what-matters (60-minute focus list)',
    json: true,
    guard: (p) => Array.isArray(p?.focus) && p.focus.length >= 2 && p.focus.every((f) => f.title),
    max: 700,
    system: 'You identify what matters most for studying given limited time. Respond in JSON: {"focus":[{"title","why","minutes"}]}. Every item must cite evidence from the material or student state provided.',
    user: `Student has 60 minutes. Exam in 3 days. Weak in: Integration by Parts.\n\nMaterial:\n${MATERIAL}`,
  },
];

async function chat(system, user, json, maxTokens) {
  const messages = [{ role: 'system', content: json ? `${system}\nRespond with ONLY the JSON object, no markdown fences, no commentary.` : system },
    { role: 'user', content: user }];
  const t0 = Date.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0.4, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const raw = (data.choices?.[0]?.message?.content || '').trim();
  return { raw, ms: Date.now() - t0, finish: data.choices?.[0]?.finish_reason };
}

function parseJson(raw) {
  let s = raw.replace(/```json|```/g, '').trim();
  const a = s.indexOf('{'), b = s.indexOf('[');
  let start = a === -1 ? b : b === -1 ? a : Math.min(a, b);
  if (start === -1) return null;
  const open = s[start], close = open === '{' ? '}' : ']';
  const end = s.lastIndexOf(close);
  if (end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

(async () => {
  console.log(`\n=== MODEL PROBE: ${label} (port ${port}) ===`);
  let pass = 0, fail = 0;
  for (const t of TASKS) {
    try {
      const { raw, ms, finish } = await chat(t.system, t.user, t.json, t.max);
      let ok = false, note = '';
      if (t.json) {
        const p = parseJson(raw);
        if (!p) note = 'UNPARSEABLE';
        else if (!t.guard(p)) note = 'SHAPE/GUARD FAIL: ' + raw.slice(0, 120).replace(/\n/g, ' ');
        else ok = true;
      } else {
        ok = raw.length > 80;
        if (!ok) note = 'TOO SHORT';
      }
      if (ok) pass++; else fail++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${t.name}  ${(ms / 1000).toFixed(1)}s  finish=${finish}  len=${raw.length}${note ? '  | ' + note : ''}`);
      if (!ok || !t.json) console.log('   >>', raw.slice(0, 400).replace(/\n/g, ' '));
    } catch (e) {
      fail++;
      console.log(`FAIL  ${t.name}  ERROR: ${e.message}`);
    }
  }
  console.log(`=== ${label}: ${pass}/${TASKS.length} tasks passed ===\n`);
})();
