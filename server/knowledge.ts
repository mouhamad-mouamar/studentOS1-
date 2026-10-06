import type { SupabaseClient } from '@supabase/supabase-js';

// Student knowledge model: per-concept mastery estimation that evolves from
// every assessment event (quizzes, flashcard reviews, simulated exams).
// This complements `weaknesses` (short-term struggle signal) with a durable
// estimate of what the student actually knows.

export type MasteryState = 'new' | 'learning' | 'review' | 'mastered';

export interface MasteryRow {
  mastery: number;
  state: MasteryState;
  quiz_attempts: number;
  quiz_correct: number;
  review_attempts: number;
  review_correct: number;
}

export function classifyMastery(mastery: number, attempts: number): MasteryState {
  if (attempts === 0 && mastery === 0) return 'new';
  if (mastery >= 80) return 'mastered';
  if (mastery >= 50) return 'review';
  return 'learning';
}

export type MasteryEvent =
  | { kind: 'quiz'; correct: boolean }
  | { kind: 'exam'; correct: boolean }
  | { kind: 'review'; result: 'again' | 'hard' | 'good' | 'easy' };

// Deterministic, explainable updates. Deltas are additive and symmetric-ish:
// evidence of knowing raises mastery, evidence of not knowing lowers it, and
// repeated evidence keeps moving it (no hard ceiling beyond 0..100).
export function nextMastery(current: MasteryRow | null, event: MasteryEvent): MasteryRow {
  const row: MasteryRow = current
    ? { ...current }
    : { mastery: 0, state: 'new', quiz_attempts: 0, quiz_correct: 0, review_attempts: 0, review_correct: 0 };

  let delta = 0;
  if (event.kind === 'quiz' || event.kind === 'exam') {
    if (event.kind === 'quiz') {
      row.quiz_attempts++;
      if (event.correct) row.quiz_correct++;
    }
    // Wrong answers on exams/quiz count as quiz evidence for accuracy tracking only via quiz kind.
    delta = event.correct ? 12 : -15;
    if (event.kind === 'exam' && event.correct) delta = 6; // exams are noisier evidence
  } else {
    row.review_attempts++;
    if (event.result !== 'again') row.review_correct++;
    delta = event.result === 'again' ? -10 : event.result === 'easy' ? 8 : event.result === 'good' ? 6 : 3;
  }

  row.mastery = Math.max(0, Math.min(100, row.mastery + delta));
  row.state = classifyMastery(row.mastery, row.quiz_attempts + row.review_attempts);
  return row;
}

export async function recordMastery(
  client: SupabaseClient,
  userId: string,
  courseId: string,
  conceptId: string,
  event: MasteryEvent,
): Promise<void> {
  const { data: existing } = await client
    .from('concept_mastery')
    .select('*')
    .eq('course_id', courseId)
    .eq('concept_id', conceptId)
    .maybeSingle();

  const current: MasteryRow | null = existing
    ? {
        mastery: existing.mastery,
        state: existing.state,
        quiz_attempts: existing.quiz_attempts,
        quiz_correct: existing.quiz_correct,
        review_attempts: existing.review_attempts,
        review_correct: existing.review_correct,
      }
    : null;

  const next = nextMastery(current, event);
  await client.from('concept_mastery').upsert(
    {
      user_id: userId,
      course_id: courseId,
      concept_id: conceptId,
      mastery: next.mastery,
      state: next.state,
      quiz_attempts: next.quiz_attempts,
      quiz_correct: next.quiz_correct,
      review_attempts: next.review_attempts,
      review_correct: next.review_correct,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'course_id,concept_id' },
  );
}

export interface ConceptKnowledge {
  conceptId: string;
  mastery: number;
  state: MasteryState;
  accuracy: number | null; // quiz accuracy 0..100, null if never quizzed
  attempts: number;
}

export async function courseKnowledgeMap(client: SupabaseClient, courseId: string): Promise<Map<string, ConceptKnowledge>> {
  const { data } = await client
    .from('concept_mastery')
    .select('concept_id, mastery, state, quiz_attempts, quiz_correct, review_attempts')
    .eq('course_id', courseId);
  const map = new Map<string, ConceptKnowledge>();
  for (const r of data || []) {
    map.set((r as any).concept_id, {
      conceptId: (r as any).concept_id,
      mastery: (r as any).mastery,
      state: (r as any).state,
      attempts: (r as any).quiz_attempts,
      accuracy: (r as any).quiz_attempts > 0 ? Math.round(((r as any).quiz_correct / (r as any).quiz_attempts) * 100) : null,
    });
  }
  return map;
}
