-- ============================================================
-- FairwayFinder — add purse-lookup tracking columns
-- Run this in Supabase → SQL Editor → New query → Run.
-- (Safe to run even though the table already exists.)
--
-- WHY THIS MATTERS: the app has been trying to write a
-- "purse_event_name" column that was never actually added to this
-- table. Every refresh's database write was silently failing as a
-- result (Postgres rejects an entire update if any one column in it
-- doesn't exist) — meaning nothing was persisting between visits,
-- and the "only re-check the purse once per tournament" and
-- "only hit the live feeds once every ~15s" logic were both
-- effectively disabled the whole time. This migration adds the
-- missing column so those actually start working.
-- ============================================================

alter table pool_state
  add column if not exists purse_event_name    text,
  add column if not exists purse_lookup_failed_at timestamptz,
  add column if not exists purse_lookup_error     text;
