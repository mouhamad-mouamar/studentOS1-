import type { SupabaseClient } from '@supabase/supabase-js';

// Course intelligence layer.
//
// Everything here is DETERMINISTIC and assembled from real stored data
// (concepts, mastery, weaknesses, formulas, past-exam evidence). AI analysis
// (when configured) enriches it with an overview, commonly-confused pairs and
// a "what to remember" section stored in course_analyses — but the summary is
// always available and never fabricated.

export type SummaryLevel = 'full' | 'study' | 'quick' | 'cram';
export const SUMMARY_LEVELS: SummaryLevel[] = ['full', 'study', 'quick', 'cram'];

export interface SummaryConcept {
  id: string;
  title: string;
  summary: string | null;
  definition: string | null;
  priority: string;
  importance_score: number;
  professor_emphasis: boolean;
  mentioned_in_exams: number;
  material_id: string | null;
  mastery: number | null;
  mastery_state: string;
  weakness_score: number | null;
}

// Which concepts belong in each summary level. All levels draw on the same
// concept data — they differ only in how aggressively they compress.
export function conceptsForLevel(concepts: SummaryConcept[], level: SummaryLevel): SummaryConcept[] {
  const sorted = [...concepts].sort((a, b) => b.importance_score - a.importance_score);
  switch (level) {
    case 'cram':
      return sorted.filter((c) => c.priority === 'MUST_KNOW');
    case 'quick':
      return sorted.filter((c) => c.priority === 'MUST_KNOW' || c.priority === 'SHOULD_KNOW');
    case 'study':
      return sorted.filter((c) => c.priority !== 'LOW_PRIORITY');
    case 'full':
    default:
      return sorted;
  }
}

// ---------- "What actually matters?" ----------
// Value = evidence-weighted blend of importance, weakness, exam signals and
// the student's current knowledge. Reasons are built ONLY from real signals.
export interface WhatMattersInput {
  concept: Pick<SummaryConcept, 'id' | 'title' | 'priority' | 'importance_score' | 'professor_emphasis' | 'mentioned_in_exams'>;
  weakness: number | null;
  mastery: number | null;
  masteryState: string;
  examDaysAway: number | null;
}

export interface WhatMattersItem {
  conceptId: string;
  title: string;
  priority: string;
  score: number;
  reasons: string[];
}

export function scoreWhatMatters(input: WhatMattersInput): { score: number; reasons: string[] } {
  const { concept, weakness, mastery, masteryState, examDaysAway } = input;
  let score = concept.importance_score * 0.5;
  const reasons: string[] = [`Priority: ${concept.priority}`];

  if (concept.professor_emphasis) {
    score += 10;
    reasons.push('Professor emphasis in your material');
  }
  if (concept.mentioned_in_exams > 0) {
    score += Math.min(18, concept.mentioned_in_exams * 6);
    reasons.push(`Frequently tested in the provided past exams (${concept.mentioned_in_exams}×)`);
  }
  if (weakness != null && weakness > 0) {
    score += weakness * 0.4;
    reasons.push(`Weakness score ${weakness}/100 from recent mistakes`);
  }
  if (examDaysAway != null) {
    if (examDaysAway <= 2) {
      score += 15;
      reasons.push(`Exam in ${examDaysAway} day(s)`);
    } else if (examDaysAway <= 7) {
      score += 8;
      reasons.push(`Exam in ${examDaysAway} day(s)`);
    } else if (examDaysAway <= 21) {
      score += 3;
      reasons.push(`Exam in ${examDaysAway} day(s)`);
    }
  }
  if (mastery != null) {
    score -= mastery * 0.4;
    if (masteryState === 'mastered') reasons.push(`Already ${mastery}% mastered — quick review is enough`);
    else if (masteryState === 'learning') reasons.push(`Currently learning (${mastery}% mastery)`);
  } else {
    score += 8;
    reasons.push('Not studied yet');
  }

  return { score: Math.max(0, Math.round(score)), reasons };
}

// How many concepts a given time budget can realistically cover.
export function conceptCountForMinutes(minutes: number): number {
  return Math.max(3, Math.min(10, Math.ceil(minutes / 10)));
}

export async function whatActuallyMatters(
  client: SupabaseClient,
  course: { id: string; exam_date: string | null },
  minutes: number,
): Promise<{ items: WhatMattersItem[]; due_cards: number; minutes_per_concept: number }> {
  const days = examDays(course.exam_date);
  const [conceptsRes, weakRes, masteryRes, dueRes] = await Promise.all([
    client
      .from('concepts')
      .select('id, title, priority, importance_score, professor_emphasis, mentioned_in_exams')
      .eq('course_id', course.id)
      .order('importance_score', { ascending: false })
      .limit(50),
    client.from('weaknesses').select('concept_id, score').eq('course_id', course.id),
    client.from('concept_mastery').select('concept_id, mastery, state').eq('course_id', course.id),
    client
      .from('flashcards')
      .select('id', { count: 'exact', head: true })
      .eq('course_id', course.id)
      .lte('due_at', new Date().toISOString()),
  ]);

  const weakMap = new Map((weakRes.data || []).map((w: any) => [w.concept_id, w.score]));
  const masteryMap = new Map((masteryRes.data || []).map((m: any) => [m.concept_id, m]));

  const scored = (conceptsRes.data || []).map((row: any) => {
    const m = masteryMap.get(row.id);
    const { score, reasons } = scoreWhatMatters({
      concept: row,
      weakness: weakMap.get(row.id) ?? null,
      mastery: m ? m.mastery : null,
      masteryState: m ? m.state : 'new',
      examDaysAway: days,
    });
    return { conceptId: row.id, title: row.title, priority: row.priority, score, reasons } as WhatMattersItem;
  });
  scored.sort((a, b) => b.score - a.score);

  const count = conceptCountForMinutes(minutes);
  return {
    items: scored.slice(0, count),
    due_cards: dueRes.count ?? 0,
    minutes_per_concept: Math.max(5, Math.round(minutes / count)),
  };
}

function examDays(examDate: string | null): number | null {
  if (!examDate) return null;
  const d = new Date(examDate + 'T23:59:59Z').getTime();
  if (Number.isNaN(d)) return null;
  return Math.ceil((d - Date.now()) / 86_400_000);
}

// ---------- Course summary ----------
export interface CourseSummary {
  level: SummaryLevel;
  overview: string;
  must_know: SummaryConcept[];
  should_know: SummaryConcept[];
  topics: SummaryConcept[];
  definitions: { title: string; definition: string }[];
  formulas: { name: string; expression: string; explanation: string | null; concept: string | null }[];
  exam_relevant: { title: string; evidence: string[] }[];
  commonly_confused: { a: string; b: string; note: string }[];
  what_to_remember: string;
  sources: { material_id: string; filename: string; concepts: string[] }[];
  meta: {
    concepts_total: number;
    materials_total: number;
    exam_date: string | null;
    exam_days_away: number | null;
    due_cards: number;
    ai_analyzed: boolean;
  };
}

export async function buildCourseSummary(
  client: SupabaseClient,
  course: any,
  level: SummaryLevel,
): Promise<CourseSummary> {
  const [conceptsRes, formulasRes, materialsRes, analysisRes, dueRes] = await Promise.all([
    client
      .from('concepts')
      .select('*, concept_mastery(mastery, state), weaknesses(score)')
      .eq('course_id', course.id)
      .order('importance_score', { ascending: false }),
    client.from('formulas').select('name, expression, explanation, concepts(title)').eq('course_id', course.id).order('created_at'),
    client.from('materials').select('id, filename').eq('course_id', course.id).order('created_at'),
    client.from('course_analyses').select('overview, topic_groups, commonly_confused, what_to_remember').eq('course_id', course.id).maybeSingle(),
    client
      .from('flashcards')
      .select('id', { count: 'exact', head: true })
      .eq('course_id', course.id)
      .lte('due_at', new Date().toISOString()),
  ]);

  const concepts: SummaryConcept[] = (conceptsRes.data || []).map((x: any) => ({
    id: x.id,
    title: x.title,
    summary: x.summary,
    definition: x.definition,
    priority: x.priority,
    importance_score: x.importance_score,
    professor_emphasis: x.professor_emphasis,
    mentioned_in_exams: x.mentioned_in_exams,
    material_id: x.material_id,
    mastery: x.concept_mastery?.[0]?.mastery ?? null,
    mastery_state: x.concept_mastery?.[0]?.state ?? 'new',
    weakness_score: x.weaknesses?.[0]?.score ?? null,
  }));

  const selected = conceptsForLevel(concepts, level);
  const mustKnow = selected.filter((c) => c.priority === 'MUST_KNOW');
  const shouldKnow = selected.filter((c) => c.priority === 'SHOULD_KNOW');

  const definitions = selected
    .filter((c) => c.definition && c.definition.trim())
    .map((c) => ({ title: c.title, definition: c.definition! }));

  const formulas = (formulasRes.data || []).map((f: any) => ({
    name: f.name,
    expression: f.expression,
    explanation: f.explanation,
    concept: f.concepts?.[0]?.title ?? null,
  }));

  const examRelevant = selected
    .filter((c) => c.mentioned_in_exams > 0 || c.professor_emphasis)
    .map((c) => ({
      title: c.title,
      evidence: [
        ...(c.mentioned_in_exams > 0 ? [`Frequently tested in the provided past exams (${c.mentioned_in_exams}×)`] : []),
        ...(c.professor_emphasis ? ['Professor emphasis in your material'] : []),
      ],
    }));

  const materials = materialsRes.data || [];
  const sourceMap = new Map<string, { material_id: string; filename: string; concepts: string[] }>();
  for (const m of materials) sourceMap.set(m.id, { material_id: m.id, filename: m.filename, concepts: [] });
  for (const c of concepts) {
    if (c.material_id && sourceMap.has(c.material_id)) sourceMap.get(c.material_id)!.concepts.push(c.title);
  }

  const analysis = analysisRes.data;
  const days = examDays(course.exam_date);
  const overview =
    analysis?.overview ||
    course.description ||
    (concepts.length > 0
      ? `${course.name} currently has ${concepts.length} extracted concept(s) from ${materials.length} material(s). ` +
        `${mustKnow.length} marked MUST KNOW${days != null ? `; exam in ${days} day(s)` : ''}. ` +
        `Run a deep AI analysis to generate a richer course overview.`
      : `${course.name} has no extracted concepts yet — upload course material and StudyOS will analyze what matters.`);

  const whatToRemember =
    analysis?.what_to_remember ||
    (mustKnow.length > 0
      ? `If you remember nothing else, remember these: ${mustKnow.slice(0, 5).map((c) => c.title).join(', ')}.`
      : '');

  const dueCards = dueRes.count ?? 0;

  return {
    level,
    overview,
    must_know: mustKnow,
    should_know: shouldKnow,
    topics: selected,
    definitions,
    formulas,
    exam_relevant: examRelevant,
    commonly_confused: (analysis?.commonly_confused as any) || [],
    what_to_remember: whatToRemember,
    sources: [...sourceMap.values()],
    meta: {
      concepts_total: concepts.length,
      materials_total: materials.length,
      exam_date: course.exam_date,
      exam_days_away: days,
      due_cards: dueCards,
      ai_analyzed: Boolean(analysis),
    },
  };
}
