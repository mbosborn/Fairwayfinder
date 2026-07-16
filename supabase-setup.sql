-- ============================================================
-- FairwayFinder — Supabase database setup
-- Paste this whole file into Supabase → SQL Editor → Run.
-- It creates one table that holds your pool's shared state.
-- ============================================================

create table if not exists pool_state (
  id            text primary key default 'main',
  event_name    text,
  event_id      text,
  purse         bigint,
  owners        jsonb default '[]'::jsonb,   -- [{id,name,team,picks:[...]}]
  scores        jsonb default '{}'::jsonb,   -- { normalizedName: {pos,score} }
  refresh_count int default 0,               -- live-score pulls used today
  refresh_day   text default '',             -- the day that count belongs to (YYYY-MM-DD)
  breakfast     jsonb default '{}'::jsonb,    -- { ownerId: lastPlacePct }
  updated_at    timestamptz default now()
);

-- Seed a single row the app reads/writes
insert into pool_state (id) values ('main')
on conflict (id) do nothing;

-- Turn on realtime so viewers' boards update the instant data changes
alter publication supabase_realtime add table pool_state;

-- Row Level Security: allow the app (using the public anon key) to read,
-- but only the server (service key) writes. Reads are open so viewers see the board.
alter table pool_state enable row level security;

create policy "anyone can read the board"
  on pool_state for select
  using (true);

-- No public insert/update/delete policies => writes only happen via the
-- serverless API using the service role key (which bypasses RLS).

-- (added later) breakfast-odds column for existing installs
alter table pool_state
  add column if not exists breakfast jsonb default '{}'::jsonb;
