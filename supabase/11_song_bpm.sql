-- ============================================================================
-- Trailer Folk HQ — 11: BPM on songs. Safe to re-run.
-- ============================================================================
alter table band.songs add column if not exists bpm int;
