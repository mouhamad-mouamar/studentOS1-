import type { SupabaseClient } from '@supabase/supabase-js';
import { courseKnowledgeMap } from './knowledge';

// ---------- Priority / importance engine ----------
// Deterministic signal combination. Designed to evolve: each signal is additive
// and individually documented so future AI scoring can plug in per-signal.

export const PRIORITIES = ['MUST_KNOW', 'SHOULD_KNOW', 'NICE_TO_KNOW', 'LOW_PRIORITY'] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface ConceptRow {
  id: string;
  course_id: string;
  title: string;
  summary: string | null;
  priority: string;
  importance_score: number;
  professor_emphasis: boolean;
  mentioned_in_exams: number;
}

export function classifyPriority(score: number): Priority {
  if (score >= 75) return 'MUST_KNOW';
  if (score >= 55) return 'SHOULD_KNOW';
  if (score >= 35) return 'NICE_TO_KNOW';
  return 'LOW_PRIORITY';
}

export function computePriorityScore(
  concept: { importance_score: number; professor_emphasis: boolean; mentioned_in_exams: number },
  weaknessScore: number | null,
  examDaysAway: number | null,
): number {
  let score = Math.max(0, Math.min(100, concept.importance_score));
  if (concept.professor_emphasis) score += 20;
  score += Math.min(20, concept.mentioned_in_exams * 7);
  if (weaknessScore != null) score += Math.round(weaknessScore * 0.25); // weak topics matter more
  if (examDaysAway != null) {
    if (examDaysAway <= 2) score += 15;
    else if (examDaysAway <= 7) score += 8;
    else if (examDaysAway <= 21) score += 3;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function examDaysAway(examDate: string | null | undefined): number | null {
  if (!examDate) return null;
  const d = new Date(examDate + 'T23:59:59Z').getTime();
  if (Number.isNaN(d)) return null;
  return Math.ceil((d - Date.now()) / 86_400_000);
}

// ---------- Weakness detection ----------

export type WeaknessEvent = 'wrong_quiz' | 'right_quiz' | 'failed_review' | 'passed_review' | 'simulated_exam_wrong';

export function applyWeaknessSignals(
  current: { score: number; signals: any } | null,
  event: WeaknessEvent,
): { score: number; signals: any } {
  const s = current ? { ...current } : { score: 0, signals: {} };
  const sig = {
    wrong_quizzes: s.signals?.wrong_quizzes ?? 0,
    right_quizzes: s.signals?.right_quizzes ?? 0,
    failed_reviews: s.signals?.failed_reviews ?? 0,
    passed_reviews: s.signals?.passed_reviews ?? 0,
  };
  if (event === 'wrong_quiz' || event === 'simulated_exam_wrong') {
    sig.wrong_quizzes++;
    s.score = Math.min(100, s.score + 15);
  } else if (event === 'right_quiz') {
    sig.right_quizzes++;
    s.score = Math.max(0, s.score - 5);
  } else if (event === 'failed_review') {
    sig.failed_reviews++;
    s.score = Math.min(100, s.score + 8);
  } else if (event === 'passed_review') {
    sig.passed_reviews++;
    s.score = Math.max(0, s.score - 3);
  }
  s.signals = sig;
  return s;
}

// ---------- Spaced repetition (SM-2 derived) ----------

export type ReviewResult = 'again' | 'hard' | 'good' | 'easy';

export function nextSrsState(card: { ease: number; interval_days: number; reps: number; lapses: number }, result: ReviewResult) {
  let { ease, interval_days, reps, lapses } = card;
  if (result === 'again') {
    ease = Math.max(1.3, ease - 0.2);
    interval_days = 0; // due again in 10 minutes
    lapses++;
    reps = 0;
  } else {
    reps++;
    if (reps === 1) interval_days = 1;
    else if (reps === 2) interval_days = 6;
    else interval_days = Math.max(1, Math.round(interval_days * ease * (result === 'hard' ? 1.0 : result === 'easy' ? 1.3 : 1.15)));
    if (result === 'hard') ease = Math.max(1.3, ease - 0.05);
    if (result === 'easy') ease = Math.min(3.0, ease + 0.1);
  }
  const dueAt = result === 'again' ? new Date(Date.now() + 10 * 60_000) : new Date(Date.now() + interval_days * 86_400_000);
  return { ease, interval_days, reps, lapses, due_at: dueAt.toISOString(), last_result: result };
}

// ---------- Recommendation engine ----------
// Deterministic: ranks concrete study actions from real user state. Honest and
// explainable; every recommendation carries the reasons it was picked.

export interface Recommendation {
  action: string;
  courseId: string | null;
  courseName: string | null;
  kind: 'flashcards' | 'concept' | 'quiz' | 'exam_sim' | 'material' | 'plan';
  minutes: number;
  reasons: string[];
  detail: string;
  conceptId?: string;
}

const MAX_RECOMMENDATIONS = 4;

export async function getRecommendations(client: SupabaseClient, userId: string, minutes?: number): Promise<Recommendation[]> {
  const { data: courses } = await client.from('courses').select('id, name, exam_date').order('created_at');
  const recs: Recommendation[] = [];
  if (!courses || courses.length === 0) return recs;

  for (const course of courses) {
    const days = examDaysAway(course.exam_date);
    const urgent = days != null && days <= 14;

    const [{ count: due }, { data: weak }, { data: topConcepts }, { count: processing }, knowledge] = await Promise.all([
      client.from('flashcards').select('id', { count: 'exact', head: true }).eq('course_id', course.id).lte('due_at', new Date().toISOString()),
      client.from('weaknesses').select('score, concept_id, concepts(title)').eq('course_id', course.id).order('score', { ascending: false }).limit(3),
      client.from('concepts').select('id, title, priority, importance_score, professor_emphasis, mentioned_in_exams').eq('course_id', course.id).order('importance_score', { ascending: false }).limit(5),
      client.from('materials').select('id', { count: 'exact', head: true }).eq('course_id', course.id).eq('status', 'processing'),
      courseKnowledgeMap(client, course.id),
    ]);
    const dueCount = due ?? 0;

    if (dueCount > 0) {
      recs.push({
        action: `Review ${dueCount} due flashcard${dueCount === 1 ? '' : 's'}`,
        courseId: course.id,
        courseName: course.name,
        kind: 'flashcards',
        minutes: Math.min(20, Math.max(5, dueCount * 1)),
        reasons: ['Spaced repetition cards are due now', 'Skipping reviews lets earlier material fade'],
        detail: `Due reviews keep older material from fading. ${course.name} has ${dueCount} card(s) ready.`,
      });
    }

    const covered = new Set<string>();
    for (const w of weak || []) {
      const title = (w as any).concepts?.title || 'a concept';
      const k = knowledge.get((w as any).concept_id);
      if ((w as any).score >= 25) {
        covered.add((w as any).concept_id);
        const reasons = [`Weakness score ${(w as any).score}/100 from recent mistakes`];
        if (k?.accuracy != null) reasons.push(`Quiz accuracy ${k.accuracy}% across ${k.attempts} question(s)`);
        recs.push({
          action: `Practice weak topic: ${title}`,
          courseId: course.id,
          courseName: course.name,
          kind: 'concept',
          minutes: 15,
          conceptId: (w as any).concept_id,
          reasons,
          detail: `Your recent quiz/review results show repeated difficulty with "${title}". A focused practice round targets this directly.`,
        });
      }
    }

    if (urgent && topConcepts?.length) {
      const must = topConcepts.find((c: any) => c.priority === 'MUST_KNOW' && !covered.has(c.id));
      const pick = must || topConcepts.find((c: any) => !covered.has(c.id));
      if (pick) {
        covered.add(pick.id);
        const k = knowledge.get(pick.id);
        const reasons = [
          `Exam in ${days} day(s)`,
          `Priority: ${pick.priority}`,
          pick.professor_emphasis ? 'Your material flags professor emphasis on this' : 'High frequency in course material',
        ];
        if (pick.mentioned_in_exams > 0) reasons.push(`Frequently tested in the provided past exams (${pick.mentioned_in_exams}×)`);
        if (k?.accuracy != null) reasons.push(`Quiz accuracy ${k.accuracy}%`);
        if (k && k.state === 'new') reasons.push('Not studied yet');
        recs.push({
          action: `Study high-priority topic: ${pick.title}`,
          courseId: course.id,
          courseName: course.name,
          kind: 'concept',
          minutes: 20,
          conceptId: pick.id,
          reasons,
          detail: `With the exam ${days} day(s) away, reviewing "${pick.title}" first gives the highest expected value.`,
        });
      }
      if (days != null && days <= 7) {
        recs.push({
          action: `Run an exam simulation for ${course.name}`,
          courseId: course.id,
          courseName: course.name,
          kind: 'exam_sim',
          minutes: 30,
          reasons: [`Exam in ${days} day(s)`, 'Simulations expose gaps while there is still time to fix them'],
          detail: 'A realistic practice exam calibrates your readiness and surfaces remaining weak spots.',
        });
      }
    } else {
      // Not urgent: surface "unfinished topics" — important concepts never studied.
      const unstudied = (topConcepts || []).find((c: any) => !covered.has(c.id) && knowledge.get(c.id)?.state === 'new');
      if (unstudied) {
        recs.push({
          action: `Learn new topic: ${unstudied.title}`,
          courseId: course.id,
          courseName: course.name,
          kind: 'concept',
          minutes: 20,
          conceptId: unstudied.id,
          reasons: [`Priority: ${unstudied.priority}`, 'In your material but not studied yet'],
          detail: `"${unstudied.title}" is an important concept from your material that you have not started learning.`,
        });
      }
    }

    if ((processing ?? 0) > 0) {
      recs.push({
        action: `Material still processing in ${course.name}`,
        courseId: course.id,
        courseName: course.name,
        kind: 'material',
        minutes: 1,
        reasons: [`${processing} uploaded file(s) are being processed`],
        detail: 'StudyOS is still extracting knowledge from your uploads. Refresh in a moment.',
      });
    }
  }

  // Exam-pressure weighting: courses with closer exams float to the top.
  const courseById = new Map(courses.map((c: any) => [c.id, c]));
  recs.sort((a, b) => {
    const da = examDaysAway(courseById.get(a.courseId!)?.exam_date) ?? 9999;
    const db = examDaysAway(courseById.get(b.courseId!)?.exam_date) ?? 9999;
    const wa = da <= 14 ? 0 : da <= 30 ? 1 : 2;
    const wb = db <= 14 ? 0 : db <= 30 ? 1 : 2;
    if (wa !== wb) return wa - wb;
    if (a.kind === 'flashcards' && b.kind !== 'flashcards') return -1;
    if (b.kind === 'flashcards' && a.kind !== 'flashcards') return 1;
    return 0;
  });

  if (minutes && minutes <= 10) {
    const cards = recs.filter((r) => r.kind === 'flashcards');
    return (cards.length ? cards : recs).slice(0, 3);
  }
  return recs.slice(0, MAX_RECOMMENDATIONS);
}

// ---------- Study session composition ----------
// Adaptive by available time:
//   ~5 min  → flashcard review only
//  ~10 min  → due cards + short targeted recall
//  ~20 min  → weak concept learning + quick practice
//  30+ min  → learning + practice + assessment
export async function composeStudyPlan(
  client: SupabaseClient,
  courseId: string,
  minutes: number,
  mode: 'quick' | 'cram' = 'quick',
): Promise<{ steps: any[] }> {
  const steps: any[] = [];
  let remaining = minutes;

  const { data: dueCards } = await client
    .from('flashcards')
    .select('id, front')
    .eq('course_id', courseId)
    .lte('due_at', new Date().toISOString())
    .order('due_at')
    .limit(30);

  // Short sessions are flashcard-first; the card budget scales down for 5-10 min.
  const cardBudget = minutes <= 5 ? Math.min(remaining, 5) : Math.min(remaining, Math.min(20, Math.round(minutes * 0.4)));
  if (dueCards && dueCards.length > 0 && cardBudget >= 5) {
    const n = Math.min(dueCards.length, Math.floor(cardBudget / 0.75));
    steps.push({
      type: 'flashcards',
      minutes: cardBudget,
      cardIds: dueCards.slice(0, Math.max(5, n)).map((c: any) => c.id),
      detail: `Review ${Math.min(dueCards.length, Math.max(5, n))} due cards`,
    });
    remaining -= cardBudget;
  }

  if (remaining >= 8) {
    const knowledge = await courseKnowledgeMap(client, courseId);
    const { data: concepts } = await client
      .from('concepts')
      .select('id, title, summary, priority, professor_emphasis, mentioned_in_exams, importance_score')
      .eq('course_id', courseId)
      .order('importance_score', { ascending: false })
      .limit(20);

    // Pick the concept with the best mix of importance, weakness/mastery state and exam evidence.
    const { data: weak } = await client
      .from('weaknesses')
      .select('concept_id, score')
      .eq('course_id', courseId)
      .order('score', { ascending: false })
      .limit(10);
    const weakMap = new Map((weak || []).map((w: any) => [w.concept_id, w.score]));

    let best: { concept: any; reason: string; value: number } | null = null;
    for (const con of concepts || []) {
      const k = knowledge.get(con.id);
      const w = weakMap.get(con.id) ?? 0;
      let value = con.importance_score * 0.4 + w * 0.6;
      if (mode === 'cram') {
        value += con.priority === 'MUST_KNOW' ? 40 : con.priority === 'SHOULD_KNOW' ? 15 : 0;
        value += con.mentioned_in_exams * 10 + (con.professor_emphasis ? 10 : 0);
      }
      if (k) {
        value -= k.mastery * 0.5; // already-known material is less valuable right now
        if (k.state === 'new') value += 10;
      } else if (mode !== 'cram') {
        value += 5; // unexplored material is worth opening up
      }
      let reason = `Priority: ${con.priority}`;
      if (w >= 25) reason = 'Flagged weak from recent mistakes';
      else if (con.mentioned_in_exams > 0) reason = `Frequently tested in the provided past exams (${con.mentioned_in_exams}×)`;
      else if (con.professor_emphasis) reason = 'Professor emphasis in your material';
      else if (!k || k.state === 'new') reason = 'Not studied yet';
      if (!best || value > best.value) best = { concept: con, reason, value };
    }

    if (best) {
      const learnMinutes = Math.max(5, Math.min(remaining, mode === 'cram' ? 10 : 15));
      steps.push({
        type: 'concept',
        minutes: learnMinutes,
        conceptId: best.concept.id,
        detail: `Learn/review "${best.concept.title}" — ${best.reason}`,
      });
      remaining -= learnMinutes;
    }
  }

  if (remaining >= 5) {
    steps.push({
      type: 'quiz',
      minutes: Math.min(remaining, 10),
      scope: mode === 'cram' ? 'must_know' : 'weak',
      detail: 'Quick recall quiz on your weakest / most important topics',
    });
  }

  return { steps };
}
