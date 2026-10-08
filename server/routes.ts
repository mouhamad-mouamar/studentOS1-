import { Router, Response } from 'express';
import { userClient } from './supa.js';
import { AuthedRequest, requireAuth } from './auth.js';
import { aiConfigured, aiProviderInfo } from './config.js';
import { chatJson, chatText, coerceItems, AiProviderError } from './ai.js';
import { buildRagContext } from './retrieval.js';
import { processMaterial } from './ingest.js';
import { detectKind } from './extract.js';
import { recordMastery } from './knowledge.js';
import { buildCourseSummary, whatActuallyMatters, SUMMARY_LEVELS } from './summary.js';
import { SummaryLevel } from './summary.js';
import { generalRateLimit, aiRateLimit } from './ratelimit.js';
import {
  applyWeaknessSignals,
  composeStudyPlan,
  computePriorityScore,
  classifyPriority,
  examDaysAway,
  getRecommendations,
  nextSrsState,
  ReviewResult,
} from './logic.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const router = Router();
router.use(requireAuth);
router.use(generalRateLimit);

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
      message:
        'AI engine is not configured. Point AI_BASE_URL at a local model server (e.g. Ollama at http://127.0.0.1:11434/v1 — free, no API key) or another OpenAI-compatible endpoint.',
    });
    return false;
  }
  return true;
}

// ---------------- AI status ----------------
router.get('/ai/status', (_req: AuthedRequest, res: Response) => {
  const info = aiProviderInfo();
  res.json({
    configured: info.configured,
    engine: info.engine,
    chat_model: info.chatModel || null,
    embed_model: info.embedModel || null,
    base_url_host: info.baseUrlHost,
    key_required: info.keyRequired,
  });
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
  if (typeof storage_path !== 'string' || !storage_path.startsWith(`${req.userId}/${course.id}/`) || storage_path.includes('..')) {
    return bad(res, 'storage_path must live inside the authenticated user/course prefix');
  }
  if (typeof size === 'number' && size > 200 * 1024 * 1024) {
    return bad(res, 'FILE_TOO_LARGE: maximum upload size is 200 MB');
  }
  const ALLOWED_EXT = ['pdf', 'pptx', 'ppt', 'docx', 'doc', 'txt', 'md', 'csv', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'mp3', 'wav', 'm4a', 'ogg', 'aac', 'mp4', 'mkv', 'mov', 'webm'];
  const ext = String(filename).toLowerCase().split('.').pop() || '';
  if (!ALLOWED_EXT.includes(ext)) return bad(res, `UNSUPPORTED_FILE_TYPE: .${ext}`);
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

// Per-source insights: read-only view of data already extracted during ingestion.
// No generation, no writes — always idempotent and safe to re-open.
router.get('/materials/:id/insights', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const { data: mat } = await client.from('materials').select('id, course_id, filename, kind, status, char_count, created_at').eq('id', req.params.id).maybeSingle();
  if (!mat) return bad(res, 'MATERIAL_NOT_FOUND', 404);
  const [conceptsRes, formulasRes] = await Promise.all([
    client
      .from('concepts')
      .select('id, title, summary, priority, importance_score, professor_emphasis, mentioned_in_exams')
      .eq('material_id', mat.id)
      .order('importance_score', { ascending: false })
      .limit(30),
    // formulas link to materials indirectly through concepts
    client.from('formulas').select('id, name, expression, explanation, concepts!inner(material_id)').eq('concepts.material_id', mat.id).limit(30),
  ]);
  const concepts = conceptsRes.data || [];
  res.json({
    material: mat,
    concepts,
    formulas: formulasRes.data || [],
    emphasis: concepts.filter((c: any) => c.professor_emphasis).map((c: any) => c.title),
    exam_mentions: concepts.filter((c: any) => (c.mentioned_in_exams || 0) > 0).map((c: any) => ({ title: c.title, count: c.mentioned_in_exams })),
  });
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
    .select('*, weaknesses(score), concept_mastery(mastery, state, quiz_attempts, quiz_correct)')
    .eq('course_id', course.id)
    .order('importance_score', { ascending: false });
  if (error) return bad(res, error.message, 500);
  res.json({
    concepts: (data || []).map((x: any) => ({
      ...x,
      weakness_score: x.weaknesses?.[0]?.score ?? null,
      mastery: x.concept_mastery?.[0]?.mastery ?? null,
      mastery_state: x.concept_mastery?.[0]?.state ?? 'new',
      quiz_accuracy: x.concept_mastery?.[0]?.quiz_attempts > 0 ? Math.round((x.concept_mastery[0].quiz_correct / x.concept_mastery[0].quiz_attempts) * 100) : null,
      weaknesses: undefined,
      concept_mastery: undefined,
    })),
  });
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
router.post('/courses/:id/concepts/:conceptId/notes', aiRateLimit, async (req: AuthedRequest, res: Response) => {
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
  if (!(await ownedCourse(client, req.params.id))) return bad(res, 'COURSE_NOT_FOUND', 404);
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
  if (!(await ownedCourse(client, req.params.id))) return bad(res, 'COURSE_NOT_FOUND', 404);
  const { data, error } = await client
    .from('tutor_messages')
    .select('*')
    .eq('course_id', req.params.id)
    .order('created_at', { ascending: true })
    .limit(100);
  if (error) return bad(res, error.message, 500);
  res.json({ messages: data });
});

// Validate client-supplied materialIds against the course (never trust client IDs).
// Returns null when no valid scope was supplied → course-wide behavior (backward compatible).
async function scopedMaterialIds(client: SupabaseClient, courseId: string, raw: unknown): Promise<string[] | null> {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const ids = [...new Set(raw.filter((x) => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 20);
  if (ids.length === 0) return null;
  const { data } = await client.from('materials').select('id').eq('course_id', courseId).in('id', ids);
  const owned = new Set((data || []).map((m: any) => m.id));
  const valid = ids.filter((id) => owned.has(id));
  return valid.length > 0 ? valid : null;
}

const TUTOR_MODES: Record<string, string> = {
  free: '',
  simplify: 'The student asked for a simpler explanation: assume a beginner, avoid jargon (or define it), use a concrete everyday analogy.',
  example: 'The student asked for an example: give one fully worked, step-by-step example grounded in the course material when possible.',
  compare: 'The student asked for a comparison: contrast the concepts in a short structured table or point list (definition, when to use, common confusion).',
  test: 'The student asked to be tested: ask 2-3 short active-recall questions about the relevant course material and wait for their answers instead of explaining everything.',
  why_wrong: 'The student believes an answer is wrong or made a mistake: identify the misconception, explain where the reasoning breaks, then show the correct reasoning step by step.',
};

router.post('/courses/:id/tutor', aiRateLimit, async (req: AuthedRequest, res: Response) => {
  if (!aiGuard(res)) return;
  const client = c(req);
  const course = await ownedCourse(client, req.params.id);
  if (!course) return bad(res, 'COURSE_NOT_FOUND', 404);
  const question = String(req.body?.question || '').trim();
  if (!question) return bad(res, 'question required');
  const mode = TUTOR_MODES[req.body?.mode] != null ? req.body.mode : 'free';
  const scopeIds = await scopedMaterialIds(client, course.id, req.body?.materialIds);

  const { context, citations } = await buildRagContext(client, course.id, question, 8, scopeIds ?? undefined);
  const { data: concepts } = await client.from('concepts').select('title, priority').eq('course_id', course.id).order('importance_score', { ascending: false }).limit(12);

  let answer: string;
  try {
    answer = await chatText(
      `You are the StudyOS AI tutor for a specific university course. You know the student's actual course material.
Rules:
1. When the retrieved course material is relevant, base your answer on it and cite inline as [1], [2] matching the numbered snippets.
2. Clearly separate three kinds of information:
   - "From your course material:" — source-backed, cited.
   - "Beyond your material:" — standard academic knowledge or reasonable inference NOT in the snippets.
   - If the material does not cover the topic at all, say so plainly before answering from general knowledge.
3. Never invent or paraphrase professor statements, exam hints, or claims about future exams.
4. Be concise, clear and pedagogical. ${TUTOR_MODES[mode]}${scopeIds ? '\n5. The student restricted this question to specific selected sources. Use ONLY the provided snippets and clearly say when the selected sources do not cover the question.' : ''}`,
      `Course: ${course.name}${course.code ? ` (${course.code})` : ''}\nKey course concepts: ${(concepts || []).map((x: any) => x.title).join(', ')}\n\nCourse material snippets:\n${context || '(no material retrieved — the course material has not covered this)'}\n\nStudent question: ${question}`,
    );
  } catch (err: any) {
    if (err?.message === 'AI_NOT_CONFIGURED') return aiGuard(res);
    if (err instanceof AiProviderError) return bad(res, err.message, 502);
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
  if (!(await ownedCourse(client, req.params.id))) return bad(res, 'COURSE_NOT_FOUND', 404);
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

router.post('/courses/:id/flashcards/generate', aiRateLimit, async (req: AuthedRequest, res: Response) => {
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
      (p) => {
        // Shape-tolerant content guard: bare arrays, alternate keys, and a
        // single flat card object are all recovered downstream by coerceItems;
        // only reject content-less output (empty arrays, missing fields).
        const arr = Array.isArray(p)
          ? p
          : Array.isArray((p as any)?.cards)
            ? (p as any).cards
            : Array.isArray((p as any)?.items)
              ? (p as any).items
              : p && typeof p === 'object' && typeof (p as any).front === 'string'
                ? [p]
                : null;
        return !!arr && arr.some((c: any) => c && typeof c.front === 'string' && c.front.trim() && c.back);
      },
      1200,
      ['front'],
    );
    generated = (coerceItems(result, ['front', 'back']) || []).filter((x) => x.front && x.back).slice(0, count);
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
    await recordMastery(client, req.userId!, card.course_id, card.concept_id, { kind: 'review', result });
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

// Guard for chatJson: the 0.5B local model sometimes returns valid JSON whose
// items omit required fields (e.g. options/answer present but no question
// text). Without a guard, chatJson returns the parse "successfully" on attempt
// 0 and never uses its hardened retry prompt. The guard forces a retry.
const validQuestionsGuard = (p: any) =>
  Array.isArray(p?.questions) && p.questions.some((q: any) => q && typeof q.question === 'string' && q.question.trim() && q.answer);

async function generateQuestions(
  client: SupabaseClient,
  course: any,
  scope: string,
  conceptId: string | null,
  count: number,
  userId: string,
  difficulty = 'mixed',
  materialIds?: string[] | null,
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
  const { context } = await buildRagContext(client, course.id, query, 10, materialIds ?? undefined);
  const { data: conceptRows } = await client.from('concepts').select('id, title').eq('course_id', course.id).limit(100);
  const titleToId = new Map((conceptRows || []).map((x: any) => [x.title.toLowerCase(), x.id]));

  const result = await chatJson<{ questions: GenQuestion[] }>(
    'You generate active-recall quiz questions for a university course, strictly grounded in the provided course material. Respond in JSON: {"questions":[{"question":"the question text","type":"multiple_choice"|"short_answer","options":[...exactly 4 for multiple_choice],"answer":"the exact correct option text or short answer","explanation","concept_title"}]}. EVERY question object MUST begin with a non-empty "question" field. concept_title copied from the provided concept list when matching. Questions must be answerable from the material; no invented facts. Distractors should be plausible and reflect real misconceptions.',
    `Course: ${course.name}\n${conceptTitle ? `Focus concept: ${conceptTitle}` : scope === 'weak' ? 'Focus: the student\'s weakest topics' : ''}\nGenerate ${count} questions of ${difficulty} difficulty.\n\nCourse material snippets:\n${context || '(no material)'}\n\nCourse concepts: ${(conceptRows || []).map((x: any) => x.title).join(' | ')}`,
    validQuestionsGuard,
    1400,
    ['question'],
  );
  const questions = (coerceItems(result, ['question', 'answer']) || []).filter((q) => q.question && q.answer).slice(0, count);
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

router.post('/courses/:id/quizzes/generate', aiRateLimit, async (req: AuthedRequest, res: Response) => {
  if (!aiGuard(res)) return;
  const client = c(req);
  const course = await ownedCourse(client, req.params.id);
  if (!course) return bad(res, 'COURSE_NOT_FOUND', 404);
  const scope = ['course', 'concept', 'weak', 'exam_prep'].includes(req.body?.scope) ? req.body.scope : 'course';
  const count = Math.max(3, Math.min(20, Number(req.body?.count) || 6));
  const difficulty = ['easy', 'medium', 'hard', 'mixed'].includes(req.body?.difficulty) ? req.body.difficulty : 'mixed';
  const scopeIds = await scopedMaterialIds(client, course.id, req.body?.materialIds);
  try {
    const { questions, title } = await generateQuestions(client, course, scope, req.body?.conceptId || null, count, req.userId!, difficulty, scopeIds);
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
  if (!(await ownedCourse(client, req.params.id))) return bad(res, 'COURSE_NOT_FOUND', 404);
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

  // Grading normalization: case-, whitespace- and trailing-punctuation-insensitive
  // so "f=ma", "F = ma" and "F = ma." all grade correctly.
  const norm = (s: string) => String(s).trim().toLowerCase().replace(/\s+/g, '').replace(/[.。]+$/, '');
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
      await recordMastery(client, req.userId!, quiz.course_id, q.concept_id, { kind: 'quiz', correct });
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
router.post('/courses/:id/exams/analyze-past', aiRateLimit, async (req: AuthedRequest, res: Response) => {
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

router.post('/courses/:id/exams/simulate', aiRateLimit, async (req: AuthedRequest, res: Response) => {
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
      'You generate realistic university exam papers grounded in the provided course material. Match the style and topic weighting of any provided past-exam analysis. Prioritize MUST_KNOW concepts and the student\'s weak areas. Respond in JSON: {"questions":[{"question":"the question text","type":"multiple_choice"|"short_answer","options":[...exactly 4 for multiple_choice],"answer":"the exact correct option text or short answer","explanation","concept_title"}]}. EVERY question object MUST begin with a non-empty "question" field. For multiple_choice provide exactly 4 options and "answer" must be the exact correct option text.',
      `Course: ${course.name}\nPast exam analysis (if any): ${JSON.stringify(pastExams?.[0]?.analysis || null).slice(0, 4000)}\nHigh-priority concepts: ${(conceptRows || []).map((x: any) => `${x.title} (${x.priority})`).join(', ')}\nStudent weak areas: ${(weakConcepts || []).map((w: any) => w.concept_id).join(', ') || 'unknown'}\nGenerate ${count} exam-style questions.\n\nCourse material snippets:\n${context.context || '(no material)'}`,
      validQuestionsGuard,
      1400,
      ['question'],
    );
    const questions = (coerceItems(result, ['question', 'answer']) || []).filter((q) => q.question && q.answer).slice(0, count);
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
  if (!(await ownedCourse(client, req.params.id))) return bad(res, 'COURSE_NOT_FOUND', 404);
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
  // Grading normalization: case-, whitespace- and trailing-punctuation-insensitive
  // so "f=ma", "F = ma" and "F = ma." all grade correctly.
  const norm = (s: string) => String(s).trim().toLowerCase().replace(/\s+/g, '').replace(/[.。]+$/, '');
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
      await recordMastery(client, req.userId!, exam.course_id, conceptId, { kind: 'exam', correct });
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
  if (!(await ownedCourse(client, req.params.id))) return bad(res, 'COURSE_NOT_FOUND', 404);
  const { data, error } = await client.from('formulas').select('*, concepts(title)').eq('course_id', req.params.id).order('created_at');
  if (error) return bad(res, error.message, 500);
  res.json({ formulas: data });
});

// ---------------- Dashboard / recommendations ----------------
router.get('/dashboard', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const { data: courses } = await client.from('courses').select('id, name, color, exam_date, code').order('created_at');
  const courseList = courses || [];
  // One aggregate query for all due cards instead of one count per course.
  const dueByCourse = new Map<string, number>();
  if (courseList.length) {
    const { data: dueRows } = await client
      .from('flashcards')
      .select('course_id')
      .in('course_id', courseList.map((co: any) => co.id))
      .lte('due_at', new Date().toISOString());
    for (const row of dueRows || []) {
      dueByCourse.set((row as any).course_id, (dueByCourse.get((row as any).course_id) || 0) + 1);
    }
  }
  const [{ data: weak }, { data: attempts }, recommendations, { data: masteryRows }] = await Promise.all([
    client
      .from('weaknesses')
      .select('score, course_id, concept_id, signals, concepts(title)')
      .order('score', { ascending: false })
      .limit(5),
    client
      .from('quiz_attempts')
      .select('score, total, course_id, created_at, quizzes(title)')
      .order('created_at', { ascending: false })
      .limit(10),
    getRecommendations(client, req.userId!),
    client
      .from('concept_mastery')
      .select('course_id, state')
      .in(courseList.length ? 'course_id' : 'id', courseList.length ? courseList.map((x: any) => x.id) : ['00000000-0000-0000-0000-000000000000']),
  ]);

  // Progress: accuracy trend over the last attempts (oldest → newest).
  const trend = (attempts || [])
    .slice(0, 10)
    .reverse()
    .map((a: any) => ({ date: a.created_at, pct: a.total > 0 ? Math.round((a.score / a.total) * 100) : 0, title: a.quizzes?.title || 'Quiz' }));

  // Knowledge summary: how much of each course is new/learning/review/mastered.
  const knowledgeByCourse = new Map<string, Record<string, number>>();
  for (const m of masteryRows || []) {
    const entry = knowledgeByCourse.get((m as any).course_id) || { new: 0, learning: 0, review: 0, mastered: 0 };
    entry[(m as any).state] = (entry[(m as any).state] || 0) + 1;
    knowledgeByCourse.set((m as any).course_id, entry);
  }

  const seenExams = new Set<string>();
  const upcoming = courseList
    .filter((co: any) => co.exam_date)
    .map((co: any) => ({ id: co.id, name: co.name, exam_date: co.exam_date, days_away: examDaysAway(co.exam_date) }))
    .filter((x: any) => x.days_away == null || x.days_away >= 0)
    .filter((x: any) => {
      const key = `${x.name}|${x.exam_date}`;
      if (seenExams.has(key)) return false;
      seenExams.add(key);
      return true;
    })
    .sort((a: any, b: any) => (a.days_away ?? 9999) - (b.days_away ?? 9999))
    .slice(0, 4);

  // Lifetime stats for the Progress card — counts only, no schema change.
  const courseIds = courseList.map((co: any) => co.id);
  const inCourses = courseIds.length ? courseIds : ['00000000-0000-0000-0000-000000000000'];
  const [{ count: sessionsDone }, { data: repsRows }, { count: materialsCount }] = await Promise.all([
    client.from('study_sessions').select('id', { count: 'exact', head: true }).eq('status', 'done'),
    client.from('flashcards').select('reps').in('course_id', inCourses),
    client.from('materials').select('id', { count: 'exact', head: true }).in('course_id', inCourses),
  ]);
  const cardsReviewed = (repsRows || []).reduce((sum: number, r: any) => sum + (r.reps || 0), 0);
  const topicsReviewed = (masteryRows || []).filter((m: any) => m.state && m.state !== 'new').length;

  res.json({
    courses: courseList.map((co: any) => ({
      ...co,
      due_cards: dueByCourse.get(co.id) || 0,
      exam_days_away: examDaysAway(co.exam_date),
      knowledge: knowledgeByCourse.get(co.id) || { new: 0, learning: 0, review: 0, mastered: 0 },
    })),
    weaknesses: weak || [],
    recent_attempts: attempts || [],
    progress: { trend, total_attempts: (attempts || []).length },
    stats: {
      sessions_done: sessionsDone || 0,
      cards_reviewed: cardsReviewed,
      topics_reviewed: topicsReviewed,
      materials: materialsCount || 0,
      courses: courseList.length,
    },
    upcoming_exams: upcoming,
    recommendations,
    ai_configured: aiConfigured(),
    ai_engine: aiProviderInfo().engine,
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
  // Optional client-supplied summary (questions/cards/topics counts); stored in
  // the existing study_events payload — additive, no schema change.
  const stats =
    req.body?.stats && typeof req.body.stats === 'object' && !Array.isArray(req.body.stats)
      ? Object.fromEntries(
          Object.entries(req.body.stats)
            .filter(([, v]) => typeof v === 'number' && Number.isFinite(v as number))
            .slice(0, 10),
        )
      : {};
  await client
    .from('study_events')
    .insert({ user_id: req.userId!, course_id: session.course_id, type: 'session_done', payload: { session_id: session.id, ...stats } });
  res.json({ ok: true });
});

router.get('/courses/:id/sessions', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  if (!(await ownedCourse(client, req.params.id))) return bad(res, 'COURSE_NOT_FOUND', 404);
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

// ---------------- Course summary / analysis ("what actually matters") ----------------
// Multi-level summary assembled deterministically from the course knowledge
// base. A stored AI deep analysis (if present) enriches overview / commonly
// confused / what-to-remember; the summary itself never fabricates.
router.get('/courses/:id/summary', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const course = await ownedCourse(client, req.params.id);
  if (!course) return bad(res, 'COURSE_NOT_FOUND', 404);
  const level = (SUMMARY_LEVELS as string[]).includes(req.query.level as string) ? (req.query.level as SummaryLevel) : 'study';
  const summary = await buildCourseSummary(client, course, level);
  res.json({ summary });
});

// Deep AI analysis: generates and stores a course-wide understanding layer.
router.post('/courses/:id/analyze', aiRateLimit, async (req: AuthedRequest, res: Response) => {
  if (!aiGuard(res)) return;
  const client = c(req);
  const course = await ownedCourse(client, req.params.id);
  if (!course) return bad(res, 'COURSE_NOT_FOUND', 404);
  const { data: concepts } = await client
    .from('concepts')
    .select('title, summary, priority, professor_emphasis')
    .eq('course_id', course.id)
    .order('importance_score', { ascending: false })
    .limit(40);
  if (!concepts || concepts.length === 0) return bad(res, 'NO_CONCEPTS: upload material first so StudyOS can extract concepts', 400);
  const context = await buildRagContext(client, course.id, course.name + ' ' + concepts.slice(0, 10).map((x: any) => x.title).join(' '), 12);
  try {
    const analysis = await chatJson(
      'You analyze a university course from the student\'s own material. Respond in JSON: {"overview": string (3-5 sentence course overview: what the course is about, what the student should be able to do), "topic_groups": [{"group": string, "concepts": [string]}], "commonly_confused": [{"a": string, "b": string, "note": string}] (pairs of concepts students commonly confuse, ONLY from the provided concepts), "what_to_remember": string (the single most important takeaways paragraph, <=120 words)}. Base everything ONLY on the provided concept list and material snippets. Do not invent concepts or claims.',
      `Course: ${course.name}${course.code ? ` (${course.code})` : ''}\nExam date: ${course.exam_date || 'unknown'}\n\nExtracted concepts (priority in brackets):\n${concepts.map((x: any) => `- ${x.title} [${x.priority}]${x.summary ? `: ${x.summary}` : ''}`).join('\n')}\n\nMaterial snippets:\n${context.context || '(no snippets)'}`,
    );
    const { data, error } = await client
      .from('course_analyses')
      .upsert(
        {
          user_id: req.userId!,
          course_id: course.id,
          overview: String(analysis.overview || '').slice(0, 4000),
          topic_groups: analysis.topic_groups || [],
          commonly_confused: analysis.commonly_confused || [],
          what_to_remember: String(analysis.what_to_remember || '').slice(0, 4000),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'course_id' },
      )
      .select()
      .single();
    if (error) return bad(res, error.message, 500);
    res.json({ analysis: data });
  } catch (err: any) {
    if (err?.message === 'AI_NOT_CONFIGURED') return aiGuard(res);
    return bad(res, err.message, 502);
  }
});

router.get('/courses/:id/analysis', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  if (!(await ownedCourse(client, req.params.id))) return bad(res, 'COURSE_NOT_FOUND', 404);
  const { data } = await client.from('course_analyses').select('*').eq('course_id', req.params.id).maybeSingle();
  res.json({ analysis: data || null });
});

// "What actually matters?" — highest-value concepts for a given time budget,
// each with evidence-based reasons.
router.get('/courses/:id/what-matters', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const course = await ownedCourse(client, req.params.id);
  if (!course) return bad(res, 'COURSE_NOT_FOUND', 404);
  const minutes = Math.max(15, Math.min(180, Number(req.query.minutes) || 60));
  const result = await whatActuallyMatters(client, course, minutes);
  res.json(result);
});

// One-click study guide: deterministic composition of data the app already
// stores (what-matters, concepts, formulas, confusions, weaknesses) plus an
// optional AI-generated self-test section. Generated on demand, not persisted.
router.get('/courses/:id/study-guide', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const course = await ownedCourse(client, req.params.id);
  if (!course) return bad(res, 'COURSE_NOT_FOUND', 404);
  const [matters, conceptsRes, formulasRes, analysisRes, weakRes] = await Promise.all([
    whatActuallyMatters(client, course, 60).catch(() => null),
    client
      .from('concepts')
      .select('id, title, summary, priority, professor_emphasis, mentioned_in_exams')
      .eq('course_id', course.id)
      .order('importance_score', { ascending: false })
      .limit(15),
    client.from('formulas').select('name, expression, explanation').eq('course_id', course.id).limit(20),
    client.from('course_analyses').select('commonly_confused, what_to_remember').eq('course_id', course.id).maybeSingle(),
    client.from('weaknesses').select('score, concepts(title)').eq('course_id', course.id).order('score', { ascending: false }).limit(5),
  ]);
  const concepts = conceptsRes.data || [];

  // Self-test questions via AI — best effort; the guide stays complete without it.
  let selfTest: GenQuestion[] = [];
  if (aiConfigured()) {
    try {
      const { context } = await buildRagContext(client, course.id, course.name + ' key topics review', 8);
      const result = await chatJson<{ questions: GenQuestion[] }>(
        'You generate active-recall self-test questions for a university course study guide, strictly grounded in the provided course material. Respond in JSON: {"questions":[{"question":"...","type":"short_answer","answer":"...","explanation":"..."}]}. Every question MUST have a non-empty "question" and "answer". No invented facts.',
        `Course: ${course.name}\n\nCourse material snippets:\n${context || '(no material)'}\n\nKey concepts: ${concepts.map((x: any) => x.title).join(', ')}`,
        validQuestionsGuard,
        1000,
        ['question'],
      );
      selfTest = (coerceItems(result, ['question', 'answer']) || []).filter((q: any) => q.question && q.answer).slice(0, 5);
    } catch {
      selfTest = []; // AI unavailable / rate-limited → deterministic sections remain
    }
  }

  res.json({
    guide: {
      course: { id: course.id, name: course.name, code: course.code || null },
      what_matters: matters?.items || [],
      due_cards: matters?.due_cards || 0,
      must_know: concepts.filter((c: any) => c.priority === 'MUST_KNOW'),
      should_know: concepts.filter((c: any) => c.priority !== 'MUST_KNOW'),
      definitions: concepts.filter((c: any) => c.summary).map((c: any) => ({ title: c.title, definition: c.summary })),
      formulas: formulasRes.data || [],
      commonly_confused: (analysisRes.data?.commonly_confused as any) || [],
      what_to_remember: analysisRes.data?.what_to_remember || null,
      review_next: (weakRes.data || []).map((w: any) => ({ title: w.concepts?.title || null, score: w.score })).filter((w: any) => w.title),
      self_test: selfTest,
      ai_self_test: selfTest.length > 0,
    },
  });
});

// ---------------- Ask my course ----------------
const KNOWN_INTENTS = ['important', 'study first', 'what should i study', 'formulas', 'weak', 'emphasis', 'past exam', 'ready'];

router.post('/courses/:id/ask', async (req: AuthedRequest, res: Response) => {
  const client = c(req);
  const course = await ownedCourse(client, req.params.id);
  if (!course) return bad(res, 'COURSE_NOT_FOUND', 404);
  const question = String(req.body?.question || '').trim().toLowerCase();
  if (!question) return bad(res, 'question required');

  const wantsFormulas = /formula|equation|صيغ|قوانين/.test(question);
  const wantsWeak = /weak|struggl|difficult|ضعف|أجد صعوبة/.test(question);
  const wantsMinutes = question.match(/(\d+)\s*(min|minute|دقيقة)/);
  const wantsImportant = /important|matters|priority|مهم|أهمية|first|أولا/.test(question) || KNOWN_INTENTS.some((k) => question.includes(k));
  const wantsExam = /exam|امتحان|اختبار/.test(question);

  const deterministic =
    wantsFormulas || wantsWeak || wantsMinutes || (wantsImportant && !wantsExam) || /emphasis|professor|أكد|تشديد/.test(question);

  if (!deterministic) {
    // Open-ended question → RAG tutor (AI). Rate-limit only now.
    await new Promise<void>((resolve) => aiRateLimit(req, res, () => resolve()));
    if (res.headersSent) return;
    if (!aiConfigured()) {
      return res.status(503).json({
        error: 'AI_NOT_CONFIGURED',
        message:
          'Open questions need the AI engine (set AI_BASE_URL to a local model server such as Ollama — free, no API key). Questions about your priorities, formulas, weaknesses or time budgets are answered from your course data even without AI.',
      });
    }
    const scopeIds = await scopedMaterialIds(client, course.id, req.body?.materialIds);
    const { context, citations } = await buildRagContext(client, course.id, req.body.question, 8, scopeIds ?? undefined);
    try {
      const answer = await chatText(
        `You are the StudyOS course assistant. Answer the student\'s question grounded in the provided course material. Cite inline as [1], [2]. Clearly separate "From your course material:" (cited) from "Beyond your material:" (general knowledge). If the material does not cover it, say so plainly before answering from general knowledge. Be concise.${scopeIds ? ' The student restricted this question to specific selected sources — use ONLY the provided snippets and say when they do not cover the question.' : ''}`,
        `Course: ${course.name}\n\nCourse material snippets:\n${context || '(none)'}\n\nQuestion: ${req.body.question}`,
      );
      await client.from('tutor_messages').insert([
        { user_id: req.userId!, course_id: course.id, role: 'user', content: String(req.body.question) },
        { user_id: req.userId!, course_id: course.id, role: 'assistant', content: answer, citations },
      ]);
      return res.json({ answer, citations, grounded: true });
    } catch (err: any) {
      if (err?.message === 'AI_NOT_CONFIGURED') return aiGuard(res);
      return bad(res, err.message, 502);
    }
  }

  // Deterministic, evidence-based answers from the course knowledge base.
  const lines: string[] = [];
  if (wantsFormulas) {
    const { data: formulas } = await client.from('formulas').select('name, expression, explanation, concepts(title)').eq('course_id', course.id).limit(20);
    if (!formulas || formulas.length === 0) {
      lines.push('No formulas have been extracted from your material yet. Upload course material and formulas will appear here.');
    } else {
      lines.push('Formulas and rules extracted from your material:');
      for (const f of formulas) lines.push(`- **${f.name}**: \`${f.expression}\`${f.explanation ? ` — ${f.explanation}` : ''}${f.concepts?.[0]?.title ? ` (${f.concepts[0].title})` : ''}`);
    }
  }
  if (wantsWeak) {
    const { data: weak } = await client.from('weaknesses').select('score, concepts(title)').eq('course_id', course.id).order('score', { ascending: false }).limit(5);
    if (!weak || weak.length === 0) {
      lines.push('No weaknesses recorded yet — take a quiz or review flashcards and StudyOS will track where you struggle.');
    } else {
      lines.push('Your current weak areas (from quiz and review results):');
      for (const w of weak) lines.push(`- **${(w as any).concepts?.title || 'Unknown concept'}** — weakness score ${w.score}/100`);
    }
  }
  if (wantsMinutes || (wantsImportant && !wantsFormulas && !wantsWeak)) {
    const minutes = wantsMinutes ? Math.max(15, Math.min(180, Number(wantsMinutes[1]))) : 60;
    const wm = await whatActuallyMatters(client, course, minutes);
    lines.push(
      wantsMinutes
        ? `With ${minutes} minutes, focus on these ${wm.items.length} concept(s):`
        : `Most important topics right now (${wm.items.length}):`,
    );
    for (const item of wm.items) lines.push(`- **${item.title}** — ${item.reasons.join('; ')}`);
    if (wantsMinutes) lines.push(`Suggested pace: about ${wm.minutes_per_concept} minutes per concept.`);
    if (wm.due_cards > 0) lines.push(`Also: ${wm.due_cards} flashcard review(s) are due.`);
  }
  if (/emphasis|professor|أكد|تشديد/.test(question)) {
    const { data: emp } = await client
      .from('concepts')
      .select('title, emphasis_phrases')
      .eq('course_id', course.id)
      .eq('professor_emphasis', true)
      .limit(10);
    lines.push(
      emp && emp.length > 0
        ? 'Professor emphasis detected in your material for: ' + emp.map((e: any) => `**${e.title}**`).join(', ')
        : 'No professor-emphasis phrases were detected in your material so far.',
    );
  }

  return res.json({ answer: lines.join('\n'), grounded: true, sources: [] });
});

export default router;
