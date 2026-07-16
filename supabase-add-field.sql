-- FairwayFinder — add the tournament field-list column
-- Run this in Supabase -> SQL Editor -> New query -> Run.
-- Powers the golfer pick dropdowns (auto-filled from the live tournament field).

alter table pool_state
  add column if not exists field jsonb default '[]'::jsonb;
