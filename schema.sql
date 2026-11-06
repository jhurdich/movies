-- Run in the Supabase SQL editor for your project.
create table if not exists public.movie_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  profile jsonb not null default '{}'::jsonb
);
alter table public.movie_profiles enable row level security;
create policy "Users read own profile" on public.movie_profiles for select to authenticated using (auth.uid() = user_id);
create policy "Users insert own profile" on public.movie_profiles for insert to authenticated with check (auth.uid() = user_id);
create policy "Users update own profile" on public.movie_profiles for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
