import { Router, Response } from 'express';
import { userClient } from './supa';
import { AuthedRequest, requireAuth } from './auth';
import { aiConfigured } from './config';
import { chatJson, chatText } from './ai';
import { buildRagContext } from './retrieval';
import { processMaterial } from './ingest';
import { detectKind } from './extract';
import {
  applyWeaknessSignals,
  composeStudyPlan,
  computePriorityScore,
  classifyPriority,
  examDaysAway,
  getRecommendations,
  nextSrsState,
  ReviewResult,
} from './logic';
import type { SupabaseClient } from '@supabase/supabase-js';

const router = Router();
router.use(requireAuth);

const c = (req: AuthedRequest): SupabaseClient => userClient(req.accessToken!);
const str = (v: unknown): string => String(v);

async function ownedCourse(client: SupabaseClient, courseId: string | string[]) {
  const id = Array.isArray(courseId) ? courseId[0] : courseId;
  const { data } = await client.from('courses').select('*').eq('id', id).maybeSingle();
  return data; // null unless owned (RLS)
}

function bad(res: Response, msg: string, code = 400) {
  return res.status(code).json({ error: msg });
}

function aiGuard(res: Response) {
  if (!aiConfigured()) {
    res.status(503).json({
      error: 'AI_NOT_CONFIGURED',
      message: 'AI features require an AI provider key to be configured on the server (AI_API_KEY).',
    });
    return false;
  }
  return true;
}

// ---------------- AI status ----------------
router.get('/ai/status', (_req: AuthedRequest, res: Response) => {
  res.json({ configured: aiConfigured() });
});

// ---------------- Courses ----------------
router.get('/courses', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const { data, error } = await client.from('courses').select('*').order('created_at');
  if (error) return bad(res, error.message, 500);
  res.json({ courses: data });
});

router.post('/courses', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const { name, code, description, color, exam_date } = req.body || {};
  if (!name || typeof name !== 'string' || name.trim().length === 0) return bad(res, 'name required');
  const { data, error } = await client
    .from('courses')
    .insert({ user_id: req.userId!, name: name.trim().slice(0, 200), code: code || null, description: description || null, color: color || null, exam_date: exam_date || null })
    .select()
    .single();
  if (error) return bad(res, error.message, 500);
  res.json({ course: data });
});

router.get('/courses/:id', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const course = await ownedCourse(client, req.params.id);
  if (!course) return bad(res, 'COURSE_NOT_FOUND', 404);
  const [mats, concepts, cards, notes, quizzes, exams] = await Promise.all([
    client.from('materials').select('*').eq('course_id', course.id).order('created_at', { ascending: false }),
    client.from('concepts').select('*').eq('course_id', course.id).order('importance_score', { ascending: false }),
    client.from('flashcards').select('id', { count: 'exact', head: true }).eq('course_id', course.id),
    client.from('notes').select('id', { count: 'exact', head: true }).eq('course_id', course.id),
    client.from('quizzes').select('id', { count: 'exact', head: true }).eq('course_id', course.id),
    client.from('exams').select('id', { count: 'exact', head: true }).eq('course_id', course.id),
  ]);
  const { count: dueCount } = await client
    .from('flashcards')
    .select('id', { count: 'exact', head: true })
    .eq('course_id', course.id)
    .lte('due_at', new Date().toISOString());
  res.json({
    course,
    materials: mats.data || [],
    concepts: concepts.data || [],
    counts: { flashcards: cards.count ?? 0, due: dueCount ?? 0, notes: notes.count ?? 0, quizzes: quizzes.count ?? 0, exams: exams.count ?? 0 },
  });
});

router.patch('/courses/:id', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const course = await ownedCourse(client, req.params.id);
  if (!course) return bad(res, 'COURSE_NOT_FOUND', 404);
  const allowed: Record<string, unknown> = {};
  for (const k of ['name', 'code', 'description', 'color', 'exam_date']) {
    if (k in (req.body || {})) allowed[k] = req.body[k];
  }
  const { data, error } = await client.from('courses').update(allowed).eq('id', course.id).select().single();
  if (error) return bad(res, error.message, 500);
  res.json({ course: data });
});

router.delete('/courses/:id', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const course = await ownedCourse(client, req.params.id);
  if (!course) return bad(res, 'COURSE_NOT_FOUND', 404);
  const { error } = await client.from('courses').delete().eq('id', course.id);
  if (error) return bad(res, error.message, 500);
  res.json({ ok: true });
});

// ---------------- Materials ----------------
router.post('/courses/:id/materials', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const course = await ownedCourse(client, req.params.id);
  if (!course) return bad(res, 'COURSE_NOT_FOUND', 404);
  const { filename, storage_path, mime, size, is_past_exam } = req.body || {};
  if (!filename || !storage_path) return bad(res, 'filename and storage_path required');
  if (typeof storage_path !== 'string' || !storage_path.startsWith(`${req.userId}/`)) {
    return bad(res, 'storage_path must live inside the authenticated user prefix');
  }
  const kind = detectKind(filename, mime);
  const { data, error } = await client
    .from('materials')
    .insert({
      user_id: req.userId!,
      course_id: course.id,
      filename: String(filename).slice(0, 300),
      mime: mime || null,
      size_bytes: size ? Number(size) : null,
      kind,
      storage_path,
      is_past_exam: Boolean(is_past_exam),
      status: 'uploaded',
    })
    .select()
    .single();
  if (error) return bad(res, error.message, 500);
  processMaterial(client, data.id).catch((e) => console.error('ingest error', e));
  res.json({ material: data });
});

router.get('/courses/:id/materials', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const course = await ownedCourse(client, req.params.id);
  if (!course) return bad(res, 'COURSE_NOT_FOUND', 404);
  const { data, error } = await client.from('materials').select('*').eq('course_id', course.id).order('created_at', { ascending: false });
  if (error) return bad(res, error.message, 500);
  res.json({ materials: data });
});

router.delete('/materials/:id', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const { data: mat } = await client.from('materials').select('*').eq('id', req.params.id).maybeSingle();
  if (!mat) return bad(res, 'MATERIAL_NOT_FOUND', 404);
  await client.storage.from('materials').remove([mat.storage_path]);
  const { error } = await client.from('materials').delete().eq('id', mat.id);
  if (error) return bad(res, error.message, 500);
  res.json({ ok: true });
});

router.post('/materials/:id/reprocess', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const { data: mat } = await client.from('materials').select('id').eq('id', req.params.id).maybeSingle();
  if (!mat) return bad(res, 'MATERIAL_NOT_FOUND', 404);
  processMaterial(client, mat.id).catch((e) => console.error('ingest error', e));
  res.json({ ok: true });
});

// ---------------- Concepts & priority ----------------
router.get('/courses/:id/concepts', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const course = await ownedCourse(client, req.params.id);
  if (!course) return bad(res, 'COURSE_NOT_FOUND', 404);
  const { data, error } = await client
    .from('concepts')
    .select('*, weaknesses(score)')
    .eq('course_id', course.id)
    .order('importance_score', { ascending: false });
  if (error) return bad(res, error.message, 500);
  res.json({ concepts: (data || []).map((x: any) => ({ ...x, weakness_score: x.weaknesses?.[0]?.score ?? null, weaknesses: undefined })) });
});

// Recompute the priority engine across a course's concepts (signals: emphasis, exam mentions, weakness, exam date).
router.post('/courses/:id/recompute-priority', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const course = await ownedCourse(client, req.params.id);
  if (!course) return bad(res, 'COURSE_NOT_FOUND', 404);
  const days = examDaysAway(course.exam_date);
  const { data: concepts } = await client.from('concepts').select('id, importance_score, professor_emphasis, mentioned_in_exams').eq('course_id', course.id);
  const { data: weak } = await client.from('weaknesses').select('concept_id, score').eq('course_id', course.id);
  const weakMap = new Map((weak || []).map((w: any) => [w.concept_id, w.score]));
  let updated = 0;
  for (const con of concepts || []) {
    const score = computePriorityScore(con as any, weakMap.get((con as any).id) ?? null, days);
    await client.from('concepts').update({ importance_score: score, priority: classifyPriority(score) }).eq('id', (con as any).id);
    updated++;
  }
  res.json({ updated });
});

// ---------------- Study notes ----------------
router.post('/courses/:id/concepts/:conceptId/notes', async (req: AuthedRequest, res: Response) => {
  if (!aiGuard(res)) return;
  const client = c(req);
  const course = await ownedCourse(client, req.params.id);
  if (!course) return bad(res, 'COURSE_NOT_FOUND', 404);
  const { data: concept } = await client.from('concepts').select('*').eq('id', req.params.conceptId).eq('course_id', course.id).maybeSingle();
  if (!concept) return bad(res, 'CONCEPT_NOT_FOUND', 404);
  const { context, citations } = await buildRagContext(client, course.id, concept.title, 8);
  let content: string;
  try {
    content = await chatText(
      'You are StudyOS, a study-notes generator. Write focused, well-structured study notes in Markdown for the given concept, grounded in the provided course material. Include: key ideas, important definitions, formulas if any, a worked example or explanation, relationships to other concepts, common mistakes, and a short exam-relevance note. Cite sources inline as [1], [2] matching the numbered material snippets. Do not invent content that is not supported by the material or standard academic knowledge. Keep it under 600 words.',
      `Concept: ${concept.title}\nCourse: ${course.name}\n\nCourse material snippets:\n${context || '(no material retrieved)'}`,
    );
  } catch (err: any) {
    if (err?.message === 'AI_NOT_CONFIGURED') return aiGuard(res);
    return bad(res, err.message, 502);
  }
  const { data, error } = await client
    .from('notes')
    .insert({ user_id: req.userId!, course_id: course.id, concept_id: concept.id, title: `${concept.title} — study notes`, content })
    .select()
    .single();
  if (error) return bad(res, error.message, 500);
  await client.from('study_events').insert({ user_id: req.userId!, course_id: course.id, concept_id: concept.id, type: 'note_read', payload: { note_id: data.id } });
  res.json({ note: data, citations });
});

router.get('/courses/:id/notes', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const { data, error } = await client.from('notes').select('*').eq('course_id', req.params.id).order('created_at', { ascending: false });
  if (error) return bad(res, error.message, 500);
  res.json({ notes: data });
});

router.get('/notes/:id', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const { data } = await client.from('notes').select('*').eq('id', req.params.id).maybeSingle();
  if (!data) return bad(res, 'NOT_FOUND', 404);
  res.json({ note: data });
});

router.delete('/notes/:id', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const { error } = await client.from('notes').delete().eq('id', req.params.id);
  if (error) return bad(res, error.message, 500);
  res.json({ ok: true });
});

// ---------------- AI Tutor (RAG) ----------------
router.get('/courses/:id/tutor', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const { data, error } = await client
    .from('tutor_messages')
    .select('*')
    .eq('course_id', req.params.id)
    .order('created_at', { ascending: true })
    .limit(100);
  if (error) return bad(res, error.message, 500);
  res.json({ messages: data });
});

router.post('/courses/:id/tutor', async (req: AuthedRequest, res: Response) => {
  if (!aiGuard(res)) return;
  const client = c(req);
  const course = await ownedCourse(client, req.params.id);
  if (!course) return bad(res, 'COURSE_NOT_FOUND', 404);
  const question = String(req.body?.question || '').trim();
  if (!question) return bad(res, 'question required');

  const { context, citations } = await buildRagContext(client, course.id, question, 8);
  const { data: concepts } = await client.from('concepts').select('title, priority').eq('course_id', course.id).order('importance_score', { ascending: false }).limit(12);

  let answer: string;
  try {
    answer = await chatText(
      'You are the StudyOS AI tutor for a specific university course. Answer the student using the provided course material whenever it is relevant, and cite it inline as [1], [2] matching the numbered snippets. If the material does not cover the question, say so plainly and answer with standard academic knowledge, clearly marked. Be concise, clear and pedagogical. Adjust to the student request (simpler explanations, examples, comparisons). Do not invent professor statements.',
      `Course: ${course.name}${course.code ? ` (${course.code})` : ''}\nKey course concepts: ${(concepts || []).map((x: any) => x.title).join(', ')}\n\nCourse material snippets:\n${context || '(no material retrieved — answer from standard knowledge and say the course material has not covered this)'}\n\nStudent question: ${question}`,
    );
  } catch (err: any) {
    if (err?.message === 'AI_NOT_CONFIGURED') return aiGuard(res);
    return bad(res, err.message, 502);
  }

  await client.from('tutor_messages').insert([
    { user_id: req.userId!, course_id: course.id, role: 'user', content: question },
    { user_id: req.userId!, course_id: course.id, role: 'assistant', content: answer, citations },
  ]);
  res.json({ answer, citations });
});

// ---------------- Flashcards ----------------
router.get('/courses/:id/flashcards', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const due = req.query.due === '1';
  let q = client
    .from('flashcards')
    .select('*, concepts(title)')
    .eq('course_id', req.params.id)
    .order('due_at');
  if (due) q = q.lte('due_at', new Date().toISOString());
  const { data, error } = await q.limit(200);
  if (error) return bad(res, error.message, 500);
  res.json({ cards: data });
});

router.post('/flashcards', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const { course_id, front, back, concept_id } = req.body || {};
  if (!course_id || !front || !back) return bad(res, 'course_id, front, back required');
  const course = await ownedCourse(client, course_id);
  if (!course) return bad(res, 'COURSE_NOT_FOUND', 404);
  const { data, error } = await client
    .from('flashcards')
    .insert({ user_id: req.userId!, course_id, front: String(front).slice(0, 1000), back: String(back).slice(0, 2000), concept_id: concept_id || null })
    .select()
    .single();
  if (error) return bad(res, error.message, 500);
  res.json({ card: data });
});

router.patch('/flashcards/:id', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const { front, back } = req.body || {};
  const patch: Record<string, unknown> = {};
  if (front) patch.front = String(front).slice(0, 1000);
  if (back) patch.back = String(back).slice(0, 2000);
  const { data, error } = await client.from('flashcards').update(patch).eq('id', req.params.id).select().single();
  if (error) return bad(res, error.message, 500);
  res.json({ card: data });
});

router.delete('/flashcards/:id', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const { error } = await client.from('flashcards').delete().eq('id', req.params.id);
  if (error) return bad(res, error.message, 500);
  res.json({ ok: true });
});

router.post('/courses/:id/flashcards/generate', async (req: AuthedRequest, res: Response) => {
  if (!aiGuard(res)) return;
  const client = c(req);
  const course = await ownedCourse(client, req.params.id);
  if (!course) return bad(res, 'COURSE_NOT_FOUND', 404);
  const conceptId = req.body?.conceptId || null;
  const count = Math.max(3, Math.min(20, Number(req.body?.count) || 8));

  let conceptTitle: string | null = null;
  let query = course.name;
  if (conceptId) {
    const { data: concept } = await client.from('concepts').select('title, summary').eq('id', conceptId).eq('course_id', course.id).maybeSingle();
    if (!concept) return bad(res, 'CONCEPT_NOT_FOUND', 404);
    conceptTitle = concept.title;
    query = `${concept.title} ${concept.summary || ''}`;
  }
  const { context } = await buildRagContext(client, course.id, query, 10);
  const { data: conceptRows } = await client.from('concepts').select('id, title').eq('course_id', course.id).limit(100);
  const titleToId = new Map((conceptRows || []).map((x: any) => [x.title.toLowerCase(), x.id]));

  let generated: any[];
  try {
    const result = await chatJson<{ cards: { front: string; back: string; concept_title?: string }[] }>(
      'You generate study flashcards strictly grounded in the provided course material. Respond in JSON: {"cards":[{"front","back","concept_title"}]}. front is a question or prompt; back is the correct answer, short and precise. concept_title must be copied from the provided list of course concepts when it matches (leave empty otherwise). Do not invent facts beyond the material.',
      `Course: ${course.name}\n${conceptTitle ? `Focus concept: ${conceptTitle}` : ''}\nGenerate ${count} cards.\n\nCourse material snippets:\n${context || '(no material)'}\n\nCourse concepts: ${(conceptRows || []).map((x: any) => x.title).join(' | ')}`,
    );
    generated = (result.cards || []).filter((x) => x.front && x.back).slice(0, count);
  } catch (err: any) {
    if (err?.message === 'AI_NOT_CONFIGURED') return aiGuard(res);
    return bad(res, err.message, 502);
  }

  const rows = generated.map((g) => ({
    user_id: req.userId!,
    course_id: course.id,
    front: String(g.front).slice(0, 1000),
    back: String(g.back).slice(0, 2000),
    concept_id: g.concept_title ? titleToId.get(String(g.concept_title).toLowerCase()) || (conceptId ? conceptId : null) : conceptId,
  }));
  if (rows.length === 0) return bad(res, 'AI returned no cards', 502);
  const { data, error } = await client.from('flashcards').insert(rows).select();
  if (error) return bad(res, error.message, 500);
  res.json({ cards: data });
});

router.post('/flashcards/:id/review', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const result = req.body?.result as ReviewResult;
  if (!['again', 'hard', 'good', 'easy'].includes(result)) return bad(res, 'invalid result');
  const { data: card } = await client.from('flashcards').select('*').eq('id', req.params.id).maybeSingle();
  if (!card) return bad(res, 'CARD_NOT_FOUND', 404);
  const srs = nextSrsState(card, result);
  const { data, error } = await client.from('flashcards').update(srs).eq('id', card.id).select().single();
  if (error) return bad(res, error.message, 500);
  await client.from('study_events').insert({
    user_id: req.userId!,
    course_id: card.course_id,
    concept_id: card.concept_id,
    type: 'flashcard_review',
    payload: { result, card_id: card.id },
  });
  if (card.concept_id) {
    const { data: weak } = await client.from('weaknesses').select('*').eq('concept_id', card.concept_id).maybeSingle();
    const next = applyWeaknessSignals(weak ? { score: weak.score, signals: weak.signals } : null, result === 'again' ? 'failed_review' : 'passed_review');
    await client.from('weaknesses').upsert(
      { user_id: req.userId!, course_id: card.course_id, concept_id: card.concept_id, score: next.score, signals: next.signals, updated_at: new Date().toISOString() },
      { onConflict: 'course_id,concept_id' },
    );
  }
  res.json({ card: data });
});

// ---------------- Quizzes ----------------
interface GenQuestion {
  type: string;
  question: string;
  options?: string[];
  answer: string;
  explanation?: string;
  concept_title?: string;
}

async function generateQuestions(
  client: SupabaseClient,
  course: any,
  scope: string,
  conceptId: string | null,
  count: number,
  userId: string,
): Promise<{ questions: GenQuestion[]; title: string }> {
  let query = course.name;
  let conceptTitle: string | null = null;
  if (scope === 'concept' && conceptId) {
    const { data: concept } = await client.from('concepts').select('title, summary').eq('id', conceptId).eq('course_id', course.id).maybeSingle();
    if (!concept) throw new Error('CONCEPT_NOT_FOUND');
    conceptTitle = concept.title;
    query = `${concept.title} ${concept.summary || ''}`;
  } else if (scope === 'weak') {
    const { data: weak } = await client.from('weaknesses').select('concept_id, score, concepts(title)').eq('course_id', course.id).order('score', { ascending: false }).limit(3);
    query = (weak || []).map((w: any) => w.concepts?.title).filter(Boolean).join(', ') || course.name;
  }
  const { context } = await buildRagContext(client, course.id, query, 10);
  const { data: conceptRows } = await client.from('concepts').select('id, title').eq('course_id', course.id).limit(100);
  const titleToId = new Map((conceptRows || []).map((x: any) => [x.title.toLowerCase(), x.id]));

  const result = await chatJson<{ questions: GenQuestion[] }>(
    'You generate active-recall quiz questions for a university course, strictly grounded in the provided course material. Respond in JSON: {"questions":[{"type":"multiple_choice"|"short_answer","question","options":[...for multiple_choice],"answer","explanation","concept_title"}]}. For multiple_choice provide exactly 4 options and "answer" must be the exact correct option text. concept_title copied from the provided concept list when matching. Questions must be answerable from the material; no invented facts.',
    `Course: ${course.name}\n${conceptTitle ? `Focus concept: ${conceptTitle}` : scope === 'weak' ? 'Focus: the student\'s weakest topics' : ''}\nGenerate ${count} questions of mixed difficulty.\n\nCourse material snippets:\n${context || '(no material)'}\n\nCourse concepts: ${(conceptRows || []).map((x: any) => x.title).join(' | ')}`,
  );
  const questions = (result.questions || []).filter((q) => q.question && q.answer).slice(0, count);
  return { questions, title: conceptTitle ? `${course.name}: ${conceptTitle}` : `${course.name}: ${scope === 'weak' ? 'Weak topics' : 'Practice'} quiz` };
}

async function persistQuiz(client: SupabaseClient, userId: string, course: any, scope: string, title: string, questions: GenQuestion[]) {
  const { data: quiz, error } = await client
    .from('quizzes')
    .insert({ user_id: userId, course_id: course.id, title, scope })
    .select()
    .single();
  if (error) throw new Error(error.message);
  const rows = questions.map((q, i) => ({
    quiz_id: quiz.id,
    user_id: userId,
    course_id: course.id,
    concept_id: null as string | null,
    type: q.type === 'multiple_choice' ? 'multiple_choice' : 'short_answer',
    question: q.question.slice(0, 2000),
    options: q.options || null,
    answer: String(q.answer).slice(0, 1000),
    explanation: q.explanation || null,
    idx: i,
  }));
  // attach concept ids
  const { data: conceptRows } = await client.from('concepts').select('id, title').eq('course_id', course.id).limit(100);
  const titleToId = new Map((conceptRows || []).map((x: any) => [x.title.toLowerCase(), x.id]));
  for (let i = 0; i < rows.length; i++) {
    const ct = questions[i].concept_title;
    rows[i].concept_id = ct ? titleToId.get(String(ct).toLowerCase()) || null : null;
  }
  const { data: inserted, error: qErr } = await client.from('quiz_questions').insert(rows).select();
  if (qErr) throw new Error(qErr.message);
  return { quiz, questions: inserted };
}

router.post('/courses/:id/quizzes/generate', async (req: AuthedRequest, res: Response) => {
  if (!aiGuard(res)) return;
  const client = c(req);
  const course = await ownedCourse(client, req.params.id);
  if (!course) return bad(res, 'COURSE_NOT_FOUND', 404);
  const scope = ['course', 'concept', 'weak', 'exam_prep'].includes(req.body?.scope) ? req.body.scope : 'course';
  const count = Math.max(3, Math.min(20, Number(req.body?.count) || 6));
  try {
    const { questions, title } = await generateQuestions(client, course, scope, req.body?.conceptId || null, count, req.userId!);
    if (questions.length === 0) return bad(res, 'AI returned no questions', 502);
    const out = await persistQuiz(client, req.userId!, course, scope, title, questions);
    res.json({ quiz: out.quiz, questions: out.questions.map((q: any) => ({ id: q.id, type: q.type, question: q.question, options: q.options, idx: q.idx })) });
  } catch (err: any) {
    if (err?.message === 'AI_NOT_CONFIGURED') return aiGuard(res);
    if (err?.message === 'CONCEPT_NOT_FOUND') return bad(res, 'CONCEPT_NOT_FOUND', 404);
    return bad(res, err.message, 502);
  }
});

router.get('/courses/:id/quizzes', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const { data, error } = await client
    .from('quizzes')
    .select('*, quiz_attempts(score, total, created_at)')
    .eq('course_id', req.params.id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return bad(res, error.message, 500);
  res.json({ quizzes: data });
});

// Questions are returned WITHOUT answers; grading happens server-side.
router.get('/quizzes/:id', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const { data: quiz } = await client.from('quizzes').select('*').eq('id', req.params.id).maybeSingle();
  if (!quiz) return bad(res, 'QUIZ_NOT_FOUND', 404);
  const { data: questions } = await client.from('quiz_questions').select('id, type, question, options, idx').eq('quiz_id', quiz.id).order('idx');
  res.json({ quiz, questions });
});

router.post('/quizzes/:id/submit', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const { data: quiz } = await client.from('quizzes').select('*').eq('id', req.params.id).maybeSingle();
  if (!quiz) return bad(res, 'QUIZ_NOT_FOUND', 404);
  const { data: questions } = await client.from('quiz_questions').select('id, answer, concept_id, type').eq('quiz_id', quiz.id);
  const answers: { questionId: string; given: string }[] = Array.isArray(req.body?.answers) ? req.body.answers : [];

  const norm = (s: string) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
  let score = 0;
  const results: any[] = [];
  const { data: qFull } = await client.from('quiz_questions').select('id, answer, explanation, concept_id, type, options').eq('quiz_id', quiz.id).order('idx');
  for (const q of qFull || []) {
    const given = answers.find((a) => a.questionId === q.id)?.given || '';
    const correct = norm(given) === norm(q.answer);
    if (correct) score++;
    results.push({ question_id: q.id, correct, given, expected: q.answer, explanation: q.explanation });
    if (q.concept_id) {
      const { data: weak } = await client.from('weaknesses').select('*').eq('concept_id', q.concept_id).maybeSingle();
      const next = applyWeaknessSignals(weak ? { score: weak.score, signals: weak.signals } : null, correct ? 'right_quiz' : 'wrong_quiz');
      await client.from('weaknesses').upsert(
        { user_id: req.userId!, course_id: quiz.course_id, concept_id: q.concept_id, score: next.score, signals: next.signals, updated_at: new Date().toISOString() },
        { onConflict: 'course_id,concept_id' },
      );
    }
  }
  const { data: attempt, error } = await client
    .from('quiz_attempts')
    .insert({ user_id: req.userId!, quiz_id: quiz.id, course_id: quiz.course_id, score, total: (qFull || []).length, answers: results })
    .select()
    .single();
  if (error) return bad(res, error.message, 500);
  await client.from('study_events').insert({
    user_id: req.userId!,
    course_id: quiz.course_id,
    type: 'quiz_result',
    payload: { quiz_id: quiz.id, score, total: (qFull || []).length },
  });
  await client.from('quizzes').update({ status: 'completed' }).eq('id', quiz.id);
  res.json({ attempt: { score, total: (qFull || []).length, id: attempt.id }, results });
});

// ---------------- Exams ----------------
router.post('/courses/:id/exams/analyze-past', async (req: AuthedRequest, res: Response) => {
  if (!aiGuard(res)) return;
  const client = c(req);
  const course = await ownedCourse(client, req.params.id);
  if (!course) return bad(res, 'COURSE_NOT_FOUND', 404);
  const { data: pastMats } = await client.from('materials').select('id, filename').eq('course_id', course.id).eq('is_past_exam', true).eq('status', 'ready');
  if (!pastMats || pastMats.length === 0) return bad(res, 'NO_PAST_EXAMS: mark uploaded past exams with "past exam" when uploading', 400);
  const { data: chunks } = await client
    .from('chunks')
    .select('content, material_id')
    .eq('course_id', course.id)
    .in('material_id', pastMats.map((m: any) => m.id))
    .limit(300);
  const text = (chunks || []).map((x: any) => x.content).join('\n\n').slice(0, 40_000);
  try {
    const analysis = await chatJson(
      'You analyze past university exams. Identify recurring topics, frequently tested concepts, question patterns (e.g. "derivation, short answer"), difficulty, and high-value study areas. IMPORTANT: never claim a topic WILL appear on a future exam. Use careful language such as "frequently tested in the provided exams". Respond in JSON: {"frequent_topics":[{"topic","appearances","note"}],"question_patterns":[...],"difficulty":"...","high_value_areas":[...],"notes":"..."}',
      `Course: ${course.name}\n\nContent extracted from ${pastMats.length} past exam file(s):\n${text}`,
    );
    const { data, error } = await client
      .from('exams')
      .insert({ user_id: req.userId!, course_id: course.id, kind: 'past', title: `Past exam analysis — ${course.name}`, analysis })
      .select()
      .single();
    if (error) return bad(res, error.message, 500);
    // Update exam mention counts on concepts
    const { data: conceptRows } = await client.from('concepts').select('id, title, mentioned_in_exams').eq('course_id', course.id);
    for (const t of analysis.frequent_topics || []) {
      const match = (conceptRows || []).find((cc: any) => cc.title.toLowerCase().includes(String(t.topic).toLowerCase()) || String(t.topic).toLowerCase().includes(cc.title.toLowerCase()));
      if (match) await client.from('concepts').update({ mentioned_in_exams: match.mentioned_in_exams + 1 }).eq('id', match.id);
    }
    res.json({ exam: data });
  } catch (err: any) {
    if (err?.message === 'AI_NOT_CONFIGURED') return aiGuard(res);
    return bad(res, err.message, 502);
  }
});

router.post('/courses/:id/exams/simulate', async (req: AuthedRequest, res: Response) => {
  if (!aiGuard(res)) return;
  const client = c(req);
  const course = await ownedCourse(client, req.params.id);
  if (!course) return bad(res, 'COURSE_NOT_FOUND', 404);
  const count = Math.max(3, Math.min(20, Number(req.body?.count) || 8));

  const { data: pastExams } = await client.from('exams').select('analysis').eq('course_id', course.id).eq('kind', 'past').limit(1);
  const { data: conceptRows } = await client
    .from('concepts')
    .select('id, title, priority')
    .eq('course_id', course.id)
    .order('importance_score', { ascending: false })
    .limit(15);
  const weakConcepts = (await client.from('weaknesses').select('concept_id').eq('course_id', course.id).order('score', { ascending: false }).limit(5)).data || [];
  const context = await buildRagContext(client, course.id, course.name + ' exam preparation', 12);

  try {
    const result = await chatJson<{ questions: GenQuestion[] }>(
      'You generate realistic university exam papers grounded in the provided course material. Match the style and topic weighting of any provided past-exam analysis. Prioritize MUST_KNOW concepts and the student\'s weak areas. Respond in JSON: {"questions":[{"type":"multiple_choice"|"short_answer","question","options","answer","explanation","concept_title"}]}. For multiple_choice provide exactly 4 options and "answer" must be the exact correct option text.',
      `Course: ${course.name}\nPast exam analysis (if any): ${JSON.stringify(pastExams?.[0]?.analysis || null).slice(0, 4000)}\nHigh-priority concepts: ${(conceptRows || []).map((x: any) => `${x.title} (${x.priority})`).join(', ')}\nStudent weak areas: ${(weakConcepts || []).map((w: any) => w.concept_id).join(', ') || 'unknown'}\nGenerate ${count} exam-style questions.\n\nCourse material snippets:\n${context.context || '(no material)'}`,
    );
    const questions = (result.questions || []).filter((q) => q.question && q.answer).slice(0, count);
    if (questions.length === 0) return bad(res, 'AI returned no questions', 502);
    const { data, error } = await client
      .from('exams')
      .insert({ user_id: req.userId!, course_id: course.id, kind: 'simulated', title: `Exam simulation — ${course.name}`, questions, status: 'ready' })
      .select()
      .single();
    if (error) return bad(res, error.message, 500);
    res.json({ exam: data });
  } catch (err: any) {
    if (err?.message === 'AI_NOT_CONFIGURED') return aiGuard(res);
    return bad(res, err.message, 502);
  }
});

router.get('/courses/:id/exams', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const { data, error } = await client.from('exams').select('*').eq('course_id', req.params.id).order('created_at', { ascending: false });
  if (error) return bad(res, error.message, 500);
  res.json({ exams: data });
});

router.get('/exams/:id', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const { data } = await client.from('exams').select('*').eq('id', req.params.id).maybeSingle();
  if (!data) return bad(res, 'EXAM_NOT_FOUND', 404);
  if (data.kind === 'simulated' && data.status === 'ready') {
    return res.json({ exam: { ...data, questions: (data.questions || []).map((q: any, i: number) => ({ idx: i, type: q.type, question: q.question, options: q.options })) } });
  }
  res.json({ exam: data });
});

router.post('/exams/:id/submit', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const { data: exam } = await client.from('exams').select('*').eq('id', req.params.id).eq('kind', 'simulated').maybeSingle();
  if (!exam || exam.status !== 'ready') return bad(res, 'EXAM_NOT_FOUND', 404);
  const answers: Record<string, string> = req.body?.answers || {};
  const questions = exam.questions || [];
  const norm = (s: string) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
  let score = 0;
  const results: any[] = [];
  const { data: conceptRows } = await client.from('concepts').select('id, title').eq('course_id', exam.course_id);
  const titleToId = new Map((conceptRows || []).map((x: any) => [x.title.toLowerCase(), x.id]));
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const given = answers[String(i)] || '';
    const correct = norm(given) === norm(q.answer);
    if (correct) score++;
    results.push({ idx: i, correct, given, expected: q.answer, explanation: q.explanation });
    const conceptId = q.concept_title ? titleToId.get(String(q.concept_title).toLowerCase()) : null;
    if (conceptId) {
      const { data: weak } = await client.from('weaknesses').select('*').eq('concept_id', conceptId).maybeSingle();
      const next = applyWeaknessSignals(weak ? { score: weak.score, signals: weak.signals } : null, correct ? 'right_quiz' : 'simulated_exam_wrong');
      await client.from('weaknesses').upsert(
        { user_id: req.userId!, course_id: exam.course_id, concept_id: conceptId, score: next.score, signals: next.signals, updated_at: new Date().toISOString() },
        { onConflict: 'course_id,concept_id' },
      );
    }
  }
  const { error } = await client
    .from('exams')
    .update({ status: 'completed', score, total: questions.length, questions: results })
    .eq('id', exam.id);
  if (error) return bad(res, error.message, 500);
  await client.from('study_events').insert({ user_id: req.userId!, course_id: exam.course_id, type: 'exam_result', payload: { exam_id: exam.id, score, total: questions.length } });
  res.json({ score, total: questions.length, results });
});

// ---------------- Formulas ----------------
router.get('/courses/:id/formulas', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const { data, error } = await client.from('formulas').select('*, concepts(title)').eq('course_id', req.params.id).order('created_at');
  if (error) return bad(res, error.message, 500);
  res.json({ formulas: data });
});

// ---------------- Dashboard / recommendations ----------------
router.get('/dashboard', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const { data: courses } = await client.from('courses').select('id, name, color, exam_date, code').order('created_at');
  const courseList = courses || [];
  const dueByCourse = new Map<string, number>();
  if (courseList.length) {
    const { count: dueTotal } = await client
      .from('flashcards')
      .select('id', { count: 'exact', head: true })
      .in('course_id', courseList.map((x: any) => x.id))
      .lte('due_at', new Date().toISOString());
    for (const co of courseList) {
      const { count } = await client
        .from('flashcards')
        .select('id', { count: 'exact', head: true })
        .eq('course_id', co.id)
        .lte('due_at', new Date().toISOString());
      dueByCourse.set(co.id, count ?? 0);
    }
  }
  const { data: weak } = await client
    .from('weaknesses')
    .select('score, course_id, concept_id, concepts(title)')
    .order('score', { ascending: false })
    .limit(5);
  const { data: attempts } = await client
    .from('quiz_attempts')
    .select('score, total, course_id, created_at, quizzes(title)')
    .order('created_at', { ascending: false })
    .limit(5);
  const recommendations = await getRecommendations(client, req.userId!);
  res.json({
    courses: courseList.map((co: any) => ({ ...co, due_cards: dueByCourse.get(co.id) || 0, exam_days_away: examDaysAway(co.exam_date) })),
    weaknesses: weak || [],
    recent_attempts: attempts || [],
    recommendations,
    ai_configured: aiConfigured(),
  });
});

router.get('/recommendations', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const minutes = req.query.minutes ? Number(req.query.minutes) : undefined;
  const recs = await getRecommendations(client, req.userId!, minutes);
  res.json({ recommendations: recs });
});

// ---------------- Study sessions ----------------
router.post('/courses/:id/sessions', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const course = await ownedCourse(client, req.params.id);
  if (!course) return bad(res, 'COURSE_NOT_FOUND', 404);
  const minutes = Math.max(5, Math.min(180, Number(req.body?.minutes) || 25));
  const mode = req.body?.mode === 'cram' ? 'cram' : 'quick';
  const plan = await composeStudyPlan(client, course.id, minutes, mode);
  const { data, error } = await client
    .from('study_sessions')
    .insert({ user_id: req.userId!, course_id: course.id, kind: mode === 'cram' ? 'cram' : 'quick', duration_minutes: minutes, plan })
    .select()
    .single();
  if (error) return bad(res, error.message, 500);
  res.json({ session: data });
});

router.post('/sessions/:id/complete', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const { data: session } = await client.from('study_sessions').select('*').eq('id', req.params.id).maybeSingle();
  if (!session) return bad(res, 'SESSION_NOT_FOUND', 404);
  const { error } = await client.from('study_sessions').update({ status: 'done' }).eq('id', session.id);
  if (error) return bad(res, error.message, 500);
  await client.from('study_events').insert({ user_id: req.userId!, course_id: session.course_id, type: 'session_done', payload: { session_id: session.id } });
  res.json({ ok: true });
});

router.get('/courses/:id/sessions', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const { data, error } = await client.from('study_sessions').select('*').eq('course_id', req.params.id).order('created_at', { ascending: false }).limit(20);
  if (error) return bad(res, error.message, 500);
  res.json({ sessions: data });
});

// Cram plan = session with mode cram + must-know concept list
router.get('/courses/:id/cram', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const course = await ownedCourse(client, req.params.id);
  if (!course) return bad(res, 'COURSE_NOT_FOUND', 404);
  const { data: must } = await client
    .from('concepts')
    .select('id, title, summary, priority, professor_emphasis, mentioned_in_exams, importance_score')
    .eq('course_id', course.id)
    .in('priority', ['MUST_KNOW', 'SHOULD_KNOW'])
    .order('importance_score', { ascending: false })
    .limit(10);
  const { data: formulas } = await client.from('formulas').select('*').eq('course_id', course.id).limit(15);
  const { data: weak } = await client.from('weaknesses').select('score, concept_id, concepts(title)').eq('course_id', course.id).order('score', { ascending: false }).limit(5);
  res.json({ must_know: must || [], formulas: formulas || [], weaknesses: weak || [] });
});

export default router;
