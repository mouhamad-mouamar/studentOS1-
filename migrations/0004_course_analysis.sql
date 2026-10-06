-- 0004: stored deep course analysis (AI-generated, one per course, refreshable).
-- Additive only; no existing tables or data are touched.
create table if not exists public.course_analyses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null unique references public.courses(id) on delete cascade,
  overview text,
  topic_groups jsonb not null default '[]'::jsonb,
  commonly_confused jsonb not null default '[]'::jsonb,
  what_to_remember text,
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.course_analyses enable row level security;

create policy "course_analyses_select_own" on public.course_analyses
  for select using (auth.uid() = user_id);
create policy "course_analyses_insert_own" on public.course_analyses
  for insert with check (auth.uid() = user_id);
create policy "course_analyses_update_own" on public.course_analyses
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "course_analyses_delete_own" on public.course_analyses
  for delete using (auth.uid() = user_id);

create index if not exists idx_course_analyses_course on public.course_analyses (course_id);
