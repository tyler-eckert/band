-- ============================================================================
-- Trailer Folk HQ — 09: "Encore?" flag on songs. Safe to re-run.
-- ============================================================================
alter table band.songs add column if not exists is_encore boolean not null default false;
