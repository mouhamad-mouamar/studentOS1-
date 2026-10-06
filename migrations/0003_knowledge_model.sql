-- StudyOS knowledge model + performance indexes. Fully additive; no existing
-- tables or columns are dropped or altered destructively.

create table if not exists public.concept_mastery (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  concept_id uuid not null references public.concepts(id) on delete cascade,
  mastery integer not null default 0,              -- 0..100 estimated knowledge
  state text not null default 'new',               -- new | learning | review | mastered
  quiz_attempts integer not null default 0,
  quiz_correct integer not null default 0,
  review_attempts integer not null default 0,
  review_correct integer not null default 0,
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (course_id, concept_id)
);

alter table public.concept_mastery enable row level security;
drop policy if exists owner_all on public.concept_mastery;
create policy owner_all on public.concept_mastery for all to authenticated
using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Query-performance indexes
create index if not exists chunks_course_idx2 on public.chunks(course_id, idx);
create index if not exists materials_course_idx on public.materials(course_id, created_at desc);
create index if not exists concepts_course_score_idx on public.concepts(course_id, importance_score desc);
create index if not exists flashcards_course_due_idx on public.flashcards(course_id, due_at);
create index if not exists quiz_questions_quiz_idx on public.quiz_questions(quiz_id, idx);
create index if not exists quiz_attempts_course_idx on public.quiz_attempts(course_id, created_at desc);
create index if not exists weaknesses_course_idx on public.weaknesses(course_id, score desc);
create index if not exists study_events_course_idx on public.study_events(course_id, created_at desc);
create index if not exists exams_course_kind_idx on public.exams(course_id, kind);
create index if not exists notes_course_idx on public.notes(course_id, created_at desc);
create index if not exists mastery_course_state_idx on public.concept_mastery(course_id, state);
