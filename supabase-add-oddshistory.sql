-- ============================================================
-- FairwayFinder — add win-odds history for the weekend trend panel
-- Run in Supabase → SQL Editor → New query → Run.
-- Stores a small array of { round, ts, odds:{ownerId:pct} } snapshots,
-- one per round boundary, so the weekend panel can show ▲/▼ deltas.
-- ============================================================

alter table pool_state
  add column if not exists odds_history jsonb;
