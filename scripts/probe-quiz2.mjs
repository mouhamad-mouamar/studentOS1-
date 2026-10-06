// Mimic server-side chatJson for quiz generation: 3 attempts, max_tokens 1400,
// regex-JSON recovery, flat-object salvage — and print each raw attempt.
const sys =
  'You generate active-recall quiz questions for a university course, strictly grounded in the provided course material. Respond in JSON: {"questions":[{"type":"multiple_choice"|"short_answer","question","options":[...for multiple_choice],"answer","explanation","concept_title"}]}. For multiple_choice provide exactly 4 options and "answer" must be the exact correct option text. concept_title copied from the provided concept list when matching. Questions must be answerable from the material; no invented facts. Distractors should be plausible and reflect real misconceptions.';
const usr = [
  'Course: Calculus 201',
  'Focus concept: Integration by Parts',
  'Generate 5 questions of medium difficulty.',
  '',
  'Course material snippets:',
  '[1] Lecture 7: Integration by Parts',
  '',
  'The integration by parts formula is: integral u dv = uv - integral v du.',
  'Remember this: choose u using the LIATE rule - Logarithmic, Inverse trigonometric, Algebraic, Trigonometric, Exponential.',
  'Example 1: integral x*e^x dx equals x*e^x - e^x + C.',
  '',
  'Course concepts: Integration by Parts',
].join('\n');

async function chatOnce(attempt) {
  const r = await fetch('http://127.0.0.1:8091/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen2.5-0.5b-instruct',
      messages: [
        { role: 'system', content: attempt === 0 ? sys : sys + '\n\nYour previous response was not valid JSON. Respond with ONLY valid JSON.' },
        { role: 'user', content: usr },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
      max_tokens: 1400,
    }),
  });
  const d = await r.json();
  return { content: d.choices?.[0]?.message?.content ?? '', finish: d.choices?.[0]?.finish_reason };
}

for (let attempt = 0; attempt < 3; attempt++) {
  const { content, finish } = await chatOnce(attempt);
  console.log(`\n===== attempt ${attempt} finish=${finish} len=${content.length} =====`);
  console.log(content.slice(0, 400).replace(/\n/g, ' '));
  console.log('   ...tail:', content.slice(-200).replace(/\n/g, ' '));
  let parsed;
  try {
    parsed = JSON.parse(content);
    console.log('=> direct parse OK, questions:', parsed.questions?.length);
  } catch {
    const m = content.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    let ok = false;
    if (m) {
      try { parsed = JSON.parse(m[0]); ok = true; console.log('=> span parse OK, questions:', parsed.questions?.length); } catch {}
    }
    if (!ok) {
      const flat = [];
      for (const mm of content.matchAll(/\{[^{}]*\}/g)) {
        try { const o = JSON.parse(mm[0]); if (o && 'question' in o) flat.push(o); } catch {}
      }
      console.log(`=> salvage items with question key: ${flat.length}, with answer: ${flat.filter((o) => 'answer' in o).length}`);
    }
  }
}
