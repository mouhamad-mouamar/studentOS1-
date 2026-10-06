// Probe: replay the exact flashcard generation prompt the server sends.
const sys =
  'You generate study flashcards strictly grounded in the provided course material. Respond in JSON: {"cards":[{"front","back","concept_title"}]}. front is a question or prompt; back is the correct answer, short and precise. concept_title must be copied from the provided list of course concepts when it matches (leave empty otherwise). Do not invent facts beyond the material.';
const usr = [
  'Course: Calculus 201',
  'Generate 5 cards.',
  '',
  'Course material snippets:',
  '[1] Lecture 7: Integration by Parts',
  '',
  'Integration by parts is one of the most important techniques in this course and WILL be on the exam.',
  '',
  'The integration by parts formula is: integral u dv = uv - integral v du.',
  '',
  'Remember this: choose u using the LIATE rule - Logarithmic, Inverse trigonometric, Algebraic, Trigonometric, Exponential. You need to know this order.',
  '',
  'Example 1: integral x*e^x dx. Take u = x and dv = e^x dx. Then du = dx and v = e^x. So the integral equals x*e^x - integral e^x dx = x*e^x - e^x + C.',
  '',
  'A common mistake is choosing u = e^x, which makes the integral harder, not simpler.',
  '',
  "The formula for integration by parts is derived from the product rule of differentiation: d/dx(uv) = u'v + uv'. Integrating both sides gives the formula.",
  '',
  'Exam hint: expect at least one integration by parts question every year. Practice the LIATE ordering.',
  '',
  'Course concepts: Integration by Parts',
].join('\n');

(async () => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch('http://127.0.0.1:8091/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen2.5-0.5b-instruct',
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: usr },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
        max_tokens: 500,
      }),
    });
    const d = await r.json();
    const content = d.choices?.[0]?.message?.content ?? '(none)';
    console.log(`--- attempt ${attempt} (finish=${d.choices?.[0]?.finish_reason}) ---`);
    console.log(content.slice(0, 900));
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      const m = content.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
    }
    console.log(`=> parsed cards: ${parsed?.cards?.length ?? 'INVALID'}`);
  }
})();
