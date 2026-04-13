-- Run this in your Supabase SQL Editor to set up the required table and policies.

-- Single table storing both progress and incorrect data per user.
create table if not exists user_state (
  user_id uuid references auth.users(id) on delete cascade primary key,
  progress_data jsonb not null default '{}'::jsonb,
  incorrect_data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Enable Row Level Security
alter table user_state enable row level security;

-- Users can only read/write their own row
create policy "Users can read own state"
  on user_state for select
  using (auth.uid() = user_id);

create policy "Users can insert own state"
  on user_state for insert
  with check (auth.uid() = user_id);

create policy "Users can update own state"
  on user_state for update
  using (auth.uid() = user_id);
