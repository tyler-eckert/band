-- ============================================================================
-- Trailer Folk HQ — 08: song flags for "Opener?" and "Closer?"
-- The setlist optimizer uses these to open and close sets. Safe to re-run.
-- ============================================================================
alter table band.songs add column if not exists is_opener boolean not null default false;
alter table band.songs add column if not exists is_closer boolean not null default false;
