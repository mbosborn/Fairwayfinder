-- ============================================================
-- FairwayFinder — add the daily refresh counter
-- Run this in Supabase → SQL Editor → New query → Run.
-- (Safe to run even though the table already exists.)
-- ============================================================

alter table pool_state
  add column if not exists refresh_count int default 0,
  add column if not exists refresh_day   text default '';

-- Optional: start today clean
update pool_state
  set refresh_count = 0,
      refresh_day   = to_char((now() at time zone 'America/Chicago')::date, 'YYYY-MM-DD')
  where id = 'main';
