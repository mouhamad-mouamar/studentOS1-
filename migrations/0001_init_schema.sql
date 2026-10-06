-- StudyOS initial schema: courses, materials, chunks, concepts, study features.
-- All tables are user-scoped with RLS (auth.uid() = user_id).

create extension if not exists pgcrypto;

create table if not exists public.courses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  code text,
  description text,
  color text,
  exam_date date,
  created_at timestamptz not null default now()
);

create table if not exists public.materials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  filename text not null,
  mime text,
  size_bytes bigint,
  kind text, -- pdf | pptx | docx | image | audio | video | text | transcript | exam
  storage_path text not null,
  status text not null default 'uploaded', -- uploaded | processing | ready | failed
  error text,
  char_count integer default 0,
  is_past_exam boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.chunks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  material_id uuid not null references public.materials(id) on delete cascade,
  idx integer not null,
  content text not null,
  embedding double precision[],
  tsv tsvector generated always as (to_tsvector('simple', content)) stored
);
create index if not exists chunks_course_idx on public.chunks(course_id);
create index if not exists chunks_fts_idx on public.chunks using gin(tsv);

create table if not exists public.concepts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  material_id uuid references public.materials(id) on delete set null,
  title text not null,
  summary text,
  definition text,
  priority text not null default 'SHOULD_KNOW', -- MUST_KNOW | SHOULD_KNOW | NICE_TO_KNOW | LOW_PRIORITY
  importance_score integer not null default 50,
  professor_emphasis boolean not null default false,
  emphasis_phrases text[] default '{}',
  mentioned_in_exams integer not null default 0,
  created_at timestamptz not null default now(),
  unique (course_id, title)
);

create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  concept_id uuid references public.concepts(id) on delete set null,
  title text not null,
  content text not null, -- markdown
  created_at timestamptz not null default now()
);

create table if not exists public.flashcards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  concept_id uuid references public.concepts(id) on delete set null,
  front text not null,
  back text not null,
  ease real not null default 2.5,
  interval_days real not null default 0,
  reps integer not null default 0,
  lapses integer not null default 0,
  due_at timestamptz not null default now(),
  last_result text,
  created_at timestamptz not null default now()
);

create table if not exists public.quizzes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  title text not null,
  status text not null default 'ready', -- ready | completed
  scope text, -- course | concept | weak | exam_prep
  created_at timestamptz not null default now()
);

create table if not exists public.quiz_questions (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  concept_id uuid references public.concepts(id) on delete set null,
  type text not null default 'multiple_choice',
  question text not null,
  options jsonb,
  answer text not null,
  explanation text,
  idx integer not null default 0
);

create table if not exists public.quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  score integer not null,
  total integer not null,
  answers jsonb not null default '[]', -- [{question_id, given, correct}]
  created_at timestamptz not null default now()
);

create table if not exists public.tutor_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  role text not null, -- user | assistant
  content text not null,
  citations jsonb default '[]',
  created_at timestamptz not null default now()
);

create table if not exists public.weaknesses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  concept_id uuid not null references public.concepts(id) on delete cascade,
  score integer not null default 0, -- 0..100 weakness
  signals jsonb not null default '{}', -- {wrong_quizzes, failed_reviews, attempts}
  updated_at timestamptz not null default now(),
  unique (course_id, concept_id)
);

create table if not exists public.exams (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  kind text not null, -- past | simulated
  title text not null,
  exam_date date,
  analysis jsonb, -- past-exam analysis {frequent_topics, question_patterns, difficulty, notes}
  questions jsonb, -- simulated exam questions
  score integer,
  total integer,
  status text not null default 'ready', -- ready | completed
  created_at timestamptz not null default now()
);

create table if not exists public.study_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  kind text not null, -- quick | plan | cram
  duration_minutes integer,
  plan jsonb not null default '{}', -- {steps:[{type,concept_id,card_ids,minutes,detail}]}
  status text not null default 'active', -- active | done
  created_at timestamptz not null default now()
);

create table if not exists public.study_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  concept_id uuid,
  type text not null, -- quiz_result | flashcard_review | session_done | exam_result | note_read
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists study_events_user_idx on public.study_events(user_id, created_at desc);

create table if not exists public.formulas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  concept_id uuid references public.concepts(id) on delete set null,
  name text not null,
  expression text not null,
  explanation text,
  created_at timestamptz not null default now()
);

-- RLS on all app tables
alter table public.courses enable row level security;
alter table public.materials enable row level security;
alter table public.chunks enable row level security;
alter table public.concepts enable row level security;
alter table public.notes enable row level security;
alter table public.flashcards enable row level security;
alter table public.quizzes enable row level security;
alter table public.quiz_questions enable row level security;
alter table public.quiz_attempts enable row level security;
alter table public.tutor_messages enable row level security;
alter table public.weaknesses enable row level security;
alter table public.exams enable row level security;
alter table public.study_sessions enable row level security;
alter table public.study_events enable row level security;
alter table public.formulas enable row level security;

-- Revoke direct anon/authed table access: the app server (with the user's JWT) uses RLS-scoped access.
-- Keep policies for authenticated users so supabase client + user JWT works.
drop policy if exists owner_all on public.courses;
create policy owner_all on public.courses for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists owner_all on public.materials;
create policy owner_all on public.materials for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists owner_all on public.chunks;
create policy owner_all on public.chunks for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists owner_all on public.concepts;
create policy owner_all on public.concepts for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists owner_all on public.notes;
create policy owner_all on public.notes for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists owner_all on public.flashcards;
create policy owner_all on public.flashcards for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists owner_all on public.quizzes;
create policy owner_all on public.quizzes for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists owner_all on public.quiz_questions;
create policy owner_all on public.quiz_questions for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists owner_all on public.quiz_attempts;
create policy owner_all on public.quiz_attempts for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists owner_all on public.tutor_messages;
create policy owner_all on public.tutor_messages for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists owner_all on public.weaknesses;
create policy owner_all on public.weaknesses for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists owner_all on public.exams;
create policy owner_all on public.exams for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists owner_all on public.study_sessions;
create policy owner_all on public.study_sessions for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists owner_all on public.study_events;
create policy owner_all on public.study_events for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists owner_all on public.formulas;
create policy owner_all on public.formulas for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Storage: private bucket for course materials
insert into storage.buckets (id, name, public)
values ('materials', 'materials', false)
on conflict (id) do nothing;

drop policy if exists materials_owner_all on storage.objects;
create policy materials_owner_all on storage.objects for all to authenticated
using (bucket_id = 'materials' and owner = auth.uid() and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id = 'materials' and owner = auth.uid() and (storage.foldername(name))[1] = auth.uid()::text);
