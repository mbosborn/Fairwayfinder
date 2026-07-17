-- ============================================================
-- FairwayFinder — add the projected-cut-line column
-- Run this in Supabase → SQL Editor → New query → Run.
-- ============================================================

alter table pool_state
  add column if not exists cut_line jsonb;
